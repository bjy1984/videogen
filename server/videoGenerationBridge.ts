import cors from "cors";
import express from "express";
import multer from "multer";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COMFYUI_ENDPOINT,
  buildComfyUIHistoryUrl,
  buildComfyUIPromptBody,
  buildComfyUIPromptUrl,
  buildComfyUIQueueUrl,
  buildComfyUISystemStatsUrl,
  buildComfyUIViewUrl,
  normalizeComfyUIHistoryResponse,
  normalizeComfyUISubmitResponse,
  selectBestComfyUIOutputFile,
  selectComfyUIOutputFileForNode,
  type ComfyUICreateTaskBridgeRequest,
  type ComfyUISyncAssetResponse,
  type ComfyUITaskResponse
} from "../src/features/generation/providers/comfyuiApi";
import {
  DEFAULT_SEEDANCE_ARK_BASE_URL,
  SEEDANCE_MODEL_PRICING,
  buildSeedanceContentUrl,
  buildSeedanceCreateUrl,
  buildSeedanceTaskUrl,
  type SeedanceCreateTaskBridgeRequest,
  type SeedanceSyncAssetResponse,
  type SeedanceTaskResponse
} from "../src/features/generation/providers/seedanceArk";
import { planVideoSplitRanges } from "../src/features/depth-workbench/splitPlanning";
import {
  loadWorkbenchLibraryState,
  saveWorkbenchLibraryState,
  seedSeedanceModelPricing,
  type WorkbenchLibraryState
} from "./materialLibraryStore";
import { isOssConfigured, uploadAndSignOssAsset } from "./ossAssetStore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const assetRootDir = process.env.VIDEOGEN_ASSET_ROOT || path.join(rootDir, ".videogen-assets");
const uploadTempDir = path.join(assetRootDir, "_uploads");
const port = Number(process.env.VIDEO_GENERATION_BRIDGE_PORT || 8790);
const defaultDepthAnythingOnnxPath = path.join(
  rootDir,
  "models",
  "depth_anything_vits14_fabiosim_v1_opencv_static_upsample.onnx"
);
const app = express();
const upload = multer({ dest: uploadTempDir });

await mkdir(assetRootDir, { recursive: true });
await mkdir(uploadTempDir, { recursive: true });
seedSeedanceModelPricing(SEEDANCE_MODEL_PRICING as unknown as Array<Record<string, unknown>>).catch((error) => {
  console.warn(`Seedance pricing seed skipped: ${error instanceof Error ? error.message : String(error)}`);
});

app.use(cors({ origin: true }));
app.use(express.json({ limit: "64mb" }));
app.use("/assets", express.static(assetRootDir));

app.get("/library/workbench-state", async (req, res) => {
  try {
    const rawProjectId = String(req.query.projectId || "").trim();
    if (!rawProjectId) {
      throw new BridgeError("缺少 projectId。", 400);
    }
    const projectId = safePathPart(rawProjectId);
    const state = await loadWorkbenchLibraryState(projectId);
    res.json({
      state: normalizeWorkbenchAssetUrls(req, state || {
        projectId,
        clips: [],
        images: [],
        updatedAt: null
      })
    });
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Load material library state failed."
    });
  }
});

app.put("/library/workbench-state", async (req, res) => {
  try {
    const rawProjectId = String(req.body?.projectId || "").trim();
    if (!rawProjectId) {
      throw new BridgeError("缺少 projectId。", 400);
    }
    const projectId = safePathPart(rawProjectId);
    const clips = normalizeAssetUrlsInValue(req, Array.isArray(req.body?.clips) ? req.body.clips : []);
    const images = normalizeAssetUrlsInValue(req, Array.isArray(req.body?.images) ? req.body.images : []);
    const state = await saveWorkbenchLibraryState({ projectId, clips, images });
    res.json({ state: normalizeWorkbenchAssetUrls(req, state) });
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Save material library state failed."
    });
  }
});

app.get("/health", async (req, res) => {
  const apiKeyEnvName = String(req.query.apiKeyEnvName || "NEWAPI_API_KEY");
  const comfyEndpoint = String(req.query.comfyEndpoint || DEFAULT_COMFYUI_ENDPOINT);
  const comfyHealth = await checkComfyUIHealth(comfyEndpoint);
  res.json({
    ok: true,
    service: "video-generation-bridge",
    port,
    assetRootDir,
    assetBaseUrl: assetBaseUrl(req),
    seedance: {
      endpoint: resolveSeedanceEndpoint(DEFAULT_SEEDANCE_ARK_BASE_URL),
      apiKeyEnvName,
      hasApiKey: Boolean(process.env[apiKeyEnvName]),
      hasLogin: Boolean(process.env.NEWAPI_USERNAME && process.env.NEWAPI_PASSWORD),
      authReady: Boolean(process.env[apiKeyEnvName] || (process.env.NEWAPI_USERNAME && process.env.NEWAPI_PASSWORD)),
      ossReady: isOssConfigured(),
      authMode: process.env.NEWAPI_USERNAME && process.env.NEWAPI_PASSWORD
        ? "login-token"
        : process.env[apiKeyEnvName]
          ? "api-key"
          : "missing"
    },
    comfyui: {
      endpoint: comfyEndpoint,
      reachable: comfyHealth.reachable,
      nagCfgGuiderAvailable: comfyHealth.nagCfgGuiderAvailable,
      nagCfgGuiderError: comfyHealth.nagCfgGuiderError,
      error: comfyHealth.error
    },
    privacyPython: {
      path: resolvePrivacyPythonPath(),
      ready: privacyPythonReady()
    },
    ffmpeg: {
      ready: ffmpegReady()
    },
    depthVideo: {
      path: resolveDepthVideoPythonPath(),
      ready: depthPythonReady(),
      algorithm: "opencv-dnn-depth-anything",
      modelPath: resolveDepthAnythingModelPath(),
      hasModel: depthAnythingModelReady()
    }
  });
});

app.post("/privacy/face-mosaic", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      throw new BridgeError("请上传需要预处理的原素材视频。", 400);
    }
    const preview = String(req.body.preview ?? "false") === "true";
    const effect = parseFaceMosaicEffect(String(req.body.effect || "mosaic"));
    const strength = parseMaskStrength(req.body.strength, 0.85);
    const commandTemplate = process.env.VIDEOGEN_FACE_MOSAIC_COMMAND?.trim() || defaultFaceMosaicCommand(preview, effect, strength);

    const projectId = safePathPart(String(req.body.projectId || "default_project"));
    const segmentId = safePathPart(String(req.body.segmentId || "segment"));
    const preprocessId = safePathPart(`face_mosaic_${Date.now()}`);
    const extension =
      extensionFromContentType(req.file.mimetype) ||
      extensionFromUrl(req.file.originalname) ||
      "mp4";
    const relativeDir = path.join("privacy", projectId, segmentId, preprocessId);
    const outputDir = path.join(assetRootDir, relativeDir);
    await mkdir(outputDir, { recursive: true });

    const sourcePath = path.join(outputDir, `source.${extension}`);
    const outputPath = path.join(outputDir, `face_mosaic.${extension}`);
    await copyFile(req.file.path, sourcePath);
    const commandResult = await runPreprocessCommand({
      commandTemplate,
      inputPath: sourcePath,
      outputPath,
      timeoutMs: Number(process.env.VIDEOGEN_FACE_MOSAIC_TIMEOUT_MS || (preview ? 180_000 : 600_000)),
      placeholderError: "VIDEOGEN_FACE_MOSAIC_COMMAND 必须包含 {input} 和 {output} 占位符。",
      failurePrefix: "人脸打码预处理命令失败",
      timeoutMessage: "人脸打码预处理超时"
    });
    await stat(outputPath);
    const summary = parseCommandSummary(commandResult.stdout);
    const traceSummary = summary && typeof summary === "object" ? { ...summary, effect, strength } : { effect, strength };

    const now = new Date().toISOString();
    res.json({
      trace: {
        id: preprocessId,
        kind: "face-mosaic",
        provider: "local-bridge",
        status: "done",
        sourceVideoName: req.file.originalname,
        sourceVideoUrl: assetUrl(req, relativeDir, `source.${extension}`),
        outputVideoUrl: assetUrl(req, relativeDir, `face_mosaic.${extension}`),
        localPath: outputPath,
        publicAssetRequired: true,
        summary: traceSummary,
        createdAt: now,
        updatedAt: now
      }
    });
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Face mosaic preprocessing failed."
    });
  }
});

app.post("/privacy/brand-mask", upload.single("video"), async (req, res) => {
  try {
    const blockOnRed = String(req.body.blockOnRed ?? "true") !== "false";
    const trackingEngine = parseTrackingEngine(String(req.body.trackingEngine || "opencv"));
    const commandTemplate = brandMaskCommandForEngine(trackingEngine, blockOnRed);
    const commandEnvName = brandMaskCommandEnvName(trackingEngine);
    const tracks = parseTracks(String(req.body.tracks || "[]"));
    if (!tracks.length) {
      throw new BridgeError("物体追踪打码至少需要一个用户标注遮罩。", 400);
    }

    const sourceLocalPath = String(req.body.sourceLocalPath || "").trim();
    if (!req.file && !sourceLocalPath) {
      throw new BridgeError("请上传需要预处理的原素材视频，或传入上一步预处理的 sourceLocalPath。", 400);
    }

    const projectId = safePathPart(String(req.body.projectId || "default_project"));
    const segmentId = safePathPart(String(req.body.segmentId || "segment"));
    const preprocessPrefix = brandMaskOutputPrefix(trackingEngine);
    const preprocessId = safePathPart(`${preprocessPrefix}_${Date.now()}`);
    const sourceName = req.file?.originalname || String(req.body.sourceVideoName || "source.mp4");
    const extension =
      extensionFromContentType(req.file?.mimetype || null) ||
      extensionFromUrl(sourceName) ||
      extensionFromUrl(sourceLocalPath) ||
      "mp4";
    const relativeDir = path.join("privacy", projectId, segmentId, preprocessId);
    const outputDir = path.join(assetRootDir, relativeDir);
    await mkdir(outputDir, { recursive: true });

    const sourcePath = path.join(outputDir, `source.${extension}`);
    const outputName = `${preprocessPrefix}.${extension}`;
    const outputPath = path.join(outputDir, outputName);
    const specPath = path.join(outputDir, "brand_mask_spec.json");
    if (req.file) {
      await copyFile(req.file.path, sourcePath);
    } else {
      await copyFile(resolveAssetLocalPath(sourceLocalPath), sourcePath);
    }
    await writeFile(specPath, JSON.stringify({ tracks }, null, 2), "utf8");

    const commandResult = await runPreprocessCommand({
      commandTemplate,
      inputPath: sourcePath,
      outputPath,
      specPath,
      timeoutMs: brandMaskTimeoutMs(trackingEngine),
      placeholderError: `${commandEnvName} 必须包含 {input}、{output} 和 {spec} 占位符。`,
      requiredPlaceholders: ["{input}", "{output}", "{spec}"],
      failurePrefix: `${brandMaskEngineLabel(trackingEngine)}物体追踪打码预处理命令失败`,
      timeoutMessage: `${brandMaskEngineLabel(trackingEngine)}物体追踪打码预处理超时`
    });
    await stat(outputPath);
    const parsed = parseCommandSummary(commandResult.stdout);
    const issues = Array.isArray(parsed?.issues) ? parsed.issues : undefined;
    const summary = parsed && typeof parsed === "object" ? { ...parsed } : undefined;
    if (summary && "issues" in summary) delete summary.issues;
    const traceSummary = {
      ...(summary || {}),
      trackingEngine
    };

    const now = new Date().toISOString();
    res.json({
      trace: {
        id: preprocessId,
        kind: "brand-mask",
        provider: "local-bridge",
        status: "done",
        sourceVideoName: sourceName,
        sourceVideoUrl: assetUrl(req, relativeDir, `source.${extension}`),
        outputVideoUrl: assetUrl(req, relativeDir, outputName),
        localPath: outputPath,
        publicAssetRequired: true,
        summary: traceSummary,
        issues,
        createdAt: now,
        updatedAt: now
      }
    });
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Brand mask preprocessing failed."
    });
  }
});

app.post("/assets/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      throw new BridgeError("请上传需要暂存的文件。", 400);
    }
    const projectId = safePathPart(String(req.body.projectId || "default_project"));
    const segmentId = safePathPart(String(req.body.segmentId || "segment"));
    const kind = safePathPart(String(req.body.kind || "asset"));
    const originalName = req.file.originalname || "asset";
    const extension =
      extensionFromContentType(req.file.mimetype) ||
      extensionFromUrl(originalName) ||
      "bin";
    const baseName = safePathPart(path.basename(originalName, path.extname(originalName)) || kind);
    const fileName = `${Date.now()}_${baseName}.${extension}`;
    const relativeDir = path.join("uploads", projectId, segmentId, kind);
    const outputDir = path.join(assetRootDir, relativeDir);
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, fileName);
    await copyFile(req.file.path, outputPath);
    res.json({
      asset: {
        projectId,
        segmentId,
        kind,
        fileName,
        localPath: outputPath,
        localAssetUrl: assetUrl(req, relativeDir, fileName),
        ...(await ossAssetFields(relativeDir, fileName, outputPath, req.file.mimetype)),
        savedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Asset upload failed."
    });
  }
});

app.post("/depth/preprocess", upload.single("video"), async (req, res) => {
  try {
    assertDepthPythonReady();
    const sourceLocalPath = String(req.body.sourceLocalPath || "").trim();
    const sourceVideoUrl = String(req.body.sourceVideoUrl || "").trim();
    if (!req.file && !sourceLocalPath && !sourceVideoUrl) {
      throw new BridgeError("请上传需要生成深度视频的原素材，或传入本地素材路径/素材 URL。", 400);
    }
    const commandTemplate = process.env.VIDEOGEN_DEPTH_VIDEO_COMMAND?.trim() || defaultDepthVideoCommand();
    const projectId = safePathPart(String(req.body.projectId || "default_project"));
    const clipId = safePathPart(String(req.body.clipId || "clip"));
    const preprocessId = safePathPart(`depth_${Date.now()}`);
    const model = String(req.body.model || "depth-anything-dnn");
    const modelPath = String(req.body.modelPath || resolveDepthAnythingModelPath());
    assertDepthAnythingModelReady(modelPath);
    const resolution = String(req.body.resolution || "1080p");
    const colorMode = String(req.body.colorMode || "grayscale");
    const fps = String(req.body.fps || "");
    const invert = String(req.body.invert ?? "false") === "true";
    const inputSize = String(req.body.inputSize || "518");
    const letterbox = String(req.body.letterbox ?? "true") !== "false";
    const edgeFilterStrength = String(req.body.edgeFilterStrength || "0.35");
    const edgeFilterDiameter = String(req.body.edgeFilterDiameter || "7");
    const extension =
      extensionFromContentType(req.file?.mimetype || null) ||
      extensionFromUrl(req.file?.originalname || "") ||
      extensionFromUrl(sourceLocalPath) ||
      extensionFromUrl(sourceVideoUrl) ||
      "mp4";
    const relativeDir = path.join("depth", projectId, clipId, preprocessId);
    const outputDir = path.join(assetRootDir, relativeDir);
    await mkdir(outputDir, { recursive: true });

    const sourcePath = path.join(outputDir, `source.${extension}`);
    const outputPath = path.join(outputDir, "depth.mp4");
    await copyPreprocessSource({
      uploadPath: req.file?.path,
      sourceLocalPath,
      sourceVideoUrl,
      targetPath: sourcePath,
      providerLabel: "深度视频源素材"
    });

    const commandResult = await runPreprocessCommand({
      commandTemplate,
      inputPath: sourcePath,
      outputPath,
      timeoutMs: Number(process.env.VIDEOGEN_DEPTH_VIDEO_TIMEOUT_MS || 600_000),
      placeholderError: "VIDEOGEN_DEPTH_VIDEO_COMMAND 必须包含 {input} 和 {output} 占位符。",
      failurePrefix: "深度视频生成命令失败",
      timeoutMessage: "深度视频生成超时",
      replacements: {
        "{model}": shellQuote(model),
        "{modelPath}": shellQuote(modelPath),
        "{resolution}": shellQuote(resolution),
        "{colorMode}": shellQuote(colorMode),
        "{fps}": shellQuote(fps),
        "{invert}": invert ? "--invert" : "",
        "{inputSize}": shellQuote(inputSize),
        "{letterbox}": letterbox ? "--letterbox" : "--no-letterbox",
        "{edgeFilterStrength}": shellQuote(edgeFilterStrength),
        "{edgeFilterDiameter}": shellQuote(edgeFilterDiameter)
      }
    });
    await stat(outputPath);
    const summary = parseCommandSummary(commandResult.stdout);
    const now = new Date().toISOString();
    res.json({
      trace: {
        id: preprocessId,
        kind: "depth-video",
        provider: "local-bridge",
        status: "done",
        sourceVideoName: req.file?.originalname || String(req.body.sourceVideoName || "source.mp4"),
        sourceVideoUrl: assetUrl(req, relativeDir, `source.${extension}`),
        outputVideoUrl: assetUrl(req, relativeDir, "depth.mp4"),
        localPath: outputPath,
        summary,
        createdAt: now,
        updatedAt: now
      }
    });
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Depth video preprocessing failed."
    });
  }
});

app.post("/video/preprocess/grayscale", upload.single("video"), async (req, res) => {
  try {
    assertDepthPythonReady();
    const sourceLocalPath = String(req.body.sourceLocalPath || "").trim();
    const sourceVideoUrl = String(req.body.sourceVideoUrl || "").trim();
    if (!req.file && !sourceLocalPath && !sourceVideoUrl) {
      throw new BridgeError("请上传需要生成黑白视频的原素材，或传入本地素材路径/素材 URL。", 400);
    }
    const commandTemplate = process.env.VIDEOGEN_GRAYSCALE_VIDEO_COMMAND?.trim() || defaultGrayscaleVideoCommand();
    const projectId = safePathPart(String(req.body.projectId || "default_project"));
    const clipId = safePathPart(String(req.body.clipId || "clip"));
    const preprocessId = safePathPart(`grayscale_${Date.now()}`);
    const resolution = String(req.body.resolution || "1080p");
    const fps = String(req.body.fps || "");
    const extension =
      extensionFromContentType(req.file?.mimetype || null) ||
      extensionFromUrl(req.file?.originalname || "") ||
      extensionFromUrl(sourceLocalPath) ||
      extensionFromUrl(sourceVideoUrl) ||
      "mp4";
    const relativeDir = path.join("grayscale", projectId, clipId, preprocessId);
    const outputDir = path.join(assetRootDir, relativeDir);
    await mkdir(outputDir, { recursive: true });

    const sourcePath = path.join(outputDir, `source.${extension}`);
    const outputPath = path.join(outputDir, "grayscale.mp4");
    await copyPreprocessSource({
      uploadPath: req.file?.path,
      sourceLocalPath,
      sourceVideoUrl,
      targetPath: sourcePath,
      providerLabel: "黑白视频源素材"
    });

    const commandResult = await runPreprocessCommand({
      commandTemplate,
      inputPath: sourcePath,
      outputPath,
      timeoutMs: Number(process.env.VIDEOGEN_GRAYSCALE_VIDEO_TIMEOUT_MS || 300_000),
      placeholderError: "VIDEOGEN_GRAYSCALE_VIDEO_COMMAND 必须包含 {input} 和 {output} 占位符。",
      failurePrefix: "黑白视频生成命令失败",
      timeoutMessage: "黑白视频生成超时",
      replacements: {
        "{resolution}": shellQuote(resolution),
        "{fps}": shellQuote(fps)
      }
    });
    await stat(outputPath);
    const summary = parseCommandSummary(commandResult.stdout);
    const now = new Date().toISOString();
    res.json({
      trace: {
        id: preprocessId,
        kind: "grayscale-video",
        provider: "local-bridge",
        status: "done",
        sourceVideoName: req.file?.originalname || String(req.body.sourceVideoName || "source.mp4"),
        sourceVideoUrl: assetUrl(req, relativeDir, `source.${extension}`),
        outputVideoUrl: assetUrl(req, relativeDir, "grayscale.mp4"),
        localPath: outputPath,
        summary,
        createdAt: now,
        updatedAt: now
      }
    });
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Grayscale video preprocessing failed."
    });
  }
});

app.post("/video/preprocess/split", upload.single("video"), async (req, res) => {
  try {
    const sourceLocalPath = String(req.body.sourceLocalPath || "").trim();
    const sourceVideoUrl = String(req.body.sourceVideoUrl || "").trim();
    if (!req.file && !sourceLocalPath && !sourceVideoUrl) {
      throw new BridgeError("请上传需要切分的原素材，或传入本地素材路径/素材 URL。", 400);
    }
    const startedAt = Date.now();
    const projectId = safePathPart(String(req.body.projectId || "default_project"));
    const clipId = safePathPart(String(req.body.clipId || "clip"));
    const lineageId = safePathPart(String(req.body.lineageId || "lineage"));
    const preprocessId = safePathPart(`split_${Date.now()}`);
    const extension =
      extensionFromContentType(req.file?.mimetype || null) ||
      extensionFromUrl(req.file?.originalname || "") ||
      extensionFromUrl(sourceLocalPath) ||
      extensionFromUrl(sourceVideoUrl) ||
      "mp4";
    const sourceName = req.file?.originalname || String(req.body.sourceVideoName || `source.${extension}`);
    const relativeDir = path.join("split", projectId, clipId, preprocessId);
    const outputDir = path.join(assetRootDir, relativeDir);
    await mkdir(outputDir, { recursive: true });

    const sourcePath = path.join(outputDir, `source.${extension}`);
    await copyPreprocessSource({
      uploadPath: req.file?.path,
      sourceLocalPath,
      sourceVideoUrl,
      targetPath: sourcePath,
      providerLabel: "切分源素材"
    });
    const durationSec = await probeMediaDuration(sourcePath);
    if (!durationSec) {
      throw new BridgeError("无法读取源视频时长，切分失败。", 400);
    }
    const ranges = planVideoSplitRanges(durationSec);
    const segmentResults = [];
    for (const range of ranges) {
      const segmentId = safePathPart(`${clipId}_part_${String(range.index + 1).padStart(2, "0")}`);
      const fileName = `part_${String(range.index + 1).padStart(2, "0")}.mp4`;
      const outputPath = path.join(outputDir, fileName);
      await splitVideoRange({
        inputPath: sourcePath,
        outputPath,
        startSec: range.startSec,
        durationSec: range.durationSec
      });
      segmentResults.push({
        id: segmentId,
        sourceClipId: clipId,
        lineageId,
        index: range.index,
        startSec: range.startSec,
        endSec: range.endSec,
        durationSec: range.durationSec,
        videoUrl: assetUrl(req, relativeDir, fileName),
        localPath: outputPath,
        fileName,
        range
      });
    }

    const now = new Date().toISOString();
    res.json({
      trace: {
        id: preprocessId,
        kind: "video-split",
        provider: "local-bridge",
        status: "done",
        sourceVideoName: sourceName,
        sourceVideoUrl: assetUrl(req, relativeDir, `source.${extension}`),
        localPath: outputDir,
        summary: {
          sourceDurationSec: Number(durationSec.toFixed(3)),
          segmentCount: segmentResults.length,
          targetSec: 9.9,
          maxSec: 10,
          minLastSec: 5,
          elapsedSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000))
        },
        createdAt: now,
        updatedAt: now
      },
      segments: segmentResults
    });
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Video split preprocessing failed."
    });
  }
});

app.post("/seedance/tasks", async (req, res) => {
  const request = req.body as SeedanceCreateTaskBridgeRequest;
  try {
    request.body = await normalizeSeedanceMediaUrls(req, request.body);
    validateSeedanceRemoteMediaUrls(request.body);
    const upstreamUrl = buildSeedanceCreateUrl(resolveSeedanceEndpoint(request.endpoint));
    const auth = await resolveSeedanceAuth(request.apiKeyEnvName, upstreamUrl);
    const task = await requestSeedanceTask(upstreamUrl, auth, {
      method: "POST",
      body: JSON.stringify(request.body)
    });
    res.json(task);
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Seedance task request failed."
    });
  }
});

app.post("/seedance/tasks/:id/sync", async (req, res) => {
  try {
    const endpoint = resolveSeedanceEndpoint(String(req.body.endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL));
    const apiKeyEnvName = String(req.body.apiKeyEnvName || "NEWAPI_API_KEY");
    const projectId = safePathPart(String(req.body.projectId || "default_project"));
    const assetId = safePathPart(String(req.body.assetId || req.params.id));
    const upstreamUrl = buildSeedanceTaskUrl(endpoint, req.params.id);
    const auth = await resolveSeedanceAuth(apiKeyEnvName, upstreamUrl);
    const task = await requestSeedanceTask(upstreamUrl, auth, { method: "GET" });
    const sourceUrl = String(req.body.sourceUrl || task.content?.video_url || "");
    if (task.status && !["succeeded", "completed"].includes(task.status)) {
      throw new BridgeError(`Seedance 任务尚未成功，当前状态：${task.status}`, 409);
    }
    const downloaded = sourceUrl
      ? await downloadAsset(sourceUrl)
      : await downloadAsset(buildSeedanceContentUrl(endpoint, req.params.id), "Seedance", auth);
    const fileName = `${assetId}.${downloaded.extension}`;
    const relativeDir = path.join("seedance", projectId);
    const outputDir = path.join(assetRootDir, relativeDir);
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, fileName);
    await writeFile(outputPath, downloaded.bytes);

    const asset = {
      projectId,
      assetId,
      fileName,
      localPath: outputPath,
      localAssetUrl: assetUrl(req, relativeDir, fileName),
      sourceUrl,
      savedAt: new Date().toISOString()
    };

    res.json({
      task,
      asset
    } satisfies SeedanceSyncAssetResponse);
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Seedance asset sync failed."
    });
  }
});

app.get("/seedance/tasks/:id", async (req, res) => {
  try {
    const endpoint = resolveSeedanceEndpoint(String(req.query.endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL));
    const apiKeyEnvName = String(req.query.apiKeyEnvName || "NEWAPI_API_KEY");
    const upstreamUrl = buildSeedanceTaskUrl(endpoint, req.params.id);
    const auth = await resolveSeedanceAuth(apiKeyEnvName, upstreamUrl);
    const task = await requestSeedanceTask(upstreamUrl, auth, { method: "GET" });
    res.json(task);
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "Seedance task query failed."
    });
  }
});

app.post("/comfyui/tasks", async (req, res) => {
  const request = req.body as ComfyUICreateTaskBridgeRequest;
  try {
    const endpoint = request.endpoint || DEFAULT_COMFYUI_ENDPOINT;
    const workflow = await resolveComfyUIWorkflow(request);
    const sourceVideoInput = request.sourceVideoUrl
      ? await uploadComfyUIInputFromUrl({
          endpoint,
          sourceUrl: request.sourceVideoUrl,
          suggestedName: request.sourceVideoName || "source_video.mp4",
          providerLabel: "ComfyUI source video"
        })
      : undefined;
    const referenceImageInput = request.referenceImageUrl
      ? await uploadComfyUIInputFromUrl({
          endpoint,
          sourceUrl: request.referenceImageUrl,
          suggestedName: request.referenceImageName || "reference_image.png",
          providerLabel: "ComfyUI reference image"
        })
      : undefined;
    const promptBody = buildComfyUIPromptBody({
      workflow,
      prompt: request.prompt,
      promptNodeId: request.promptNodeId,
      seed: request.seed,
      steps: request.steps,
      cfgScale: request.cfgScale,
      ollamaModel: request.ollamaModel,
      duration: request.duration,
      sourceVideoUrl: sourceVideoInput || request.sourceVideoUrl,
      referenceImageUrl: referenceImageInput || request.referenceImageUrl,
      clientId: request.clientId
    });
    const upstreamUrl = buildComfyUIPromptUrl(endpoint);
    const payload = await requestComfyUIJson(upstreamUrl, {
      method: "POST",
      body: JSON.stringify(promptBody)
    });
    const task = normalizeComfyUISubmitResponse(payload);
    if (!task.promptId || task.status === "failed") {
      throw new BridgeError(task.error || "ComfyUI 未返回 prompt_id。", 502);
    }
    res.json(task);
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "ComfyUI task request failed."
    });
  }
});

app.get("/comfyui/tasks/:id", async (req, res) => {
  try {
    const endpoint = String(req.query.endpoint || DEFAULT_COMFYUI_ENDPOINT);
    const task = await getComfyUITask(endpoint, req.params.id);
    res.json(task);
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "ComfyUI task query failed."
    });
  }
});

app.post("/comfyui/tasks/:id/sync", async (req, res) => {
  try {
    const endpoint = String(req.body.endpoint || DEFAULT_COMFYUI_ENDPOINT);
    const outputNodeId = String(req.body.outputNodeId || "");
    const projectId = safePathPart(String(req.body.projectId || "default_project"));
    const assetId = safePathPart(String(req.body.assetId || req.params.id));
    const task = await getComfyUITask(endpoint, req.params.id);
    if (task.status !== "succeeded") {
      throw new BridgeError(`ComfyUI 任务尚未成功，当前状态：${task.status || "unknown"}`, 409);
    }
    const output = outputNodeId
      ? selectComfyUIOutputFileForNode(task.outputFiles, outputNodeId)
      : selectBestComfyUIOutputFile(task.outputFiles);
    if (!output) {
      throw new BridgeError(outputNodeId ? `ComfyUI 任务没有节点 ${outputNodeId} 的可转存输出文件。` : "ComfyUI 任务没有可转存的输出文件。", 409);
    }

    const sourceUrl = output.viewUrl || buildComfyUIViewUrl(endpoint, output);
    const downloaded = await downloadAsset(sourceUrl, "ComfyUI");
    const extension = extensionFromUrl(output.filename) || downloaded.extension || "mp4";
    const fileName = `${assetId}.${extension}`;
    const relativeDir = path.join("comfyui", projectId);
    const outputDir = path.join(assetRootDir, relativeDir);
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, fileName);
    await writeFile(outputPath, downloaded.bytes);
    const targetDuration = positiveNumberOptional(req.body.targetDuration);
    if (targetDuration && isVideoExtension(extension)) {
      await normalizeVideoDuration(outputPath, targetDuration);
    }

    const asset = {
      projectId,
      assetId,
      fileName,
      localPath: outputPath,
      localAssetUrl: assetUrl(req, relativeDir, fileName),
      sourceUrl,
      savedAt: new Date().toISOString()
    };

    res.json({
      task,
      asset
    } satisfies ComfyUISyncAssetResponse);
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : "ComfyUI asset sync failed."
    });
  }
});

app.listen(port, () => {
  console.log(`Video generation bridge listening on http://localhost:${port}`);
});

interface TimedRequestInit extends RequestInit {
  timeoutMs?: number;
}

interface SeedanceAuth {
  authorization?: string;
}

let cachedSeedanceLogin: { endpoint: string; auth: SeedanceAuth; expiresAt: number } | undefined;

async function requestSeedanceTask(url: string, auth: SeedanceAuth, init: TimedRequestInit) {
  const response = await fetchWithTimeout(url, {
    ...init,
    timeoutMs: init.timeoutMs ?? 45_000,
    headers: {
      "Content-Type": "application/json",
      ...seedanceAuthHeaders(auth)
    }
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new BridgeError(
      formatSeedanceUpstreamError(payload, response.status),
      502
    );
  }
  return normalizeSeedanceTaskResponse(payload);
}

async function requestComfyUIJson(url: string, init: TimedRequestInit = {}) {
  const response = await fetchWithTimeout(url, {
    ...init,
    timeoutMs: init.timeoutMs ?? 30_000,
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    }
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new BridgeError(
      extractUpstreamError(payload) || `ComfyUI upstream request failed: ${response.status}`,
      502
    );
  }
  return payload;
}

async function uploadComfyUIInputFromUrl(input: {
  endpoint: string;
  sourceUrl: string;
  suggestedName: string;
  providerLabel: string;
}) {
  const downloaded = await downloadAsset(input.sourceUrl, input.providerLabel);
  const fileName = safeComfyUIInputFileName(input.suggestedName, downloaded.extension);
  const formData = new FormData();
  formData.set("image", new Blob([new Uint8Array(downloaded.bytes)], { type: downloaded.contentType }), fileName);
  formData.set("type", "input");
  formData.set("overwrite", "true");
  const response = await fetchWithTimeout(`${stripTrailingSlash(input.endpoint)}/upload/image`, {
    method: "POST",
    body: formData,
    timeoutMs: 180_000
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new BridgeError(
      extractUpstreamError(payload) || `ComfyUI input upload failed: ${response.status}`,
      502
    );
  }
  if (!payload || typeof payload !== "object") return fileName;
  const result = payload as Record<string, unknown>;
  const name = typeof result.name === "string" && result.name ? result.name : fileName;
  const subfolder = typeof result.subfolder === "string" && result.subfolder ? result.subfolder : "";
  return subfolder ? `${subfolder}/${name}` : name;
}

async function getComfyUITask(endpoint: string, promptId: string): Promise<ComfyUITaskResponse> {
  const historyPayload = await requestComfyUIJson(buildComfyUIHistoryUrl(endpoint, promptId), { method: "GET" });
  const historyTask = normalizeComfyUIHistoryResponse({
    endpoint,
    promptId,
    payload: historyPayload
  });
  if (historyTask.status !== "running") return historyTask;

  const queuePayload = await requestComfyUIJson(buildComfyUIQueueUrl(endpoint), { method: "GET" }).catch(() => null);
  const queueStatus = inferComfyUIQueueStatus(queuePayload, promptId);
  return {
    ...historyTask,
    status: queueStatus || historyTask.status,
    raw: {
      history: historyPayload,
      queue: queuePayload
    }
  };
}

async function resolveComfyUIWorkflow(request: ComfyUICreateTaskBridgeRequest) {
  if (request.workflowJson?.trim()) {
    return parseWorkflowJson(request.workflowJson);
  }

  const templateId = request.workflowTemplateId?.trim();
  if (!templateId) {
    throw new BridgeError("请配置 ComfyUI workflowTemplateId 或粘贴 workflowJson。", 400);
  }

  if (templateId.startsWith("{")) {
    return parseWorkflowJson(templateId);
  }

  const candidates = [
    templateId,
    path.join(rootDir, templateId),
    path.join(rootDir, "comfyui-workflows", templateId),
    path.join(rootDir, "comfyui-workflows", `${templateId}.json`)
  ];
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf8");
      return parseWorkflowJson(content);
    } catch {
      // Try the next candidate.
    }
  }
  throw new BridgeError(`找不到 ComfyUI workflow 模板：${templateId}。请填写 JSON 路径或直接粘贴 API workflow JSON。`, 400);
}

async function checkComfyUIHealth(endpoint: string) {
  try {
    await requestComfyUIJson(buildComfyUISystemStatsUrl(endpoint), { method: "GET" });
    const nagInfo = await requestComfyUIJson(buildComfyUIObjectInfoUrl(endpoint, "NAGCFGGuider"), { method: "GET" }).catch((error) => {
      return {
        error: error instanceof Error ? error.message : "NAGCFGGuider 检查失败。"
      };
    });
    return {
      reachable: true,
      nagCfgGuiderAvailable: isRecord(nagInfo) && isRecord(nagInfo.NAGCFGGuider),
      nagCfgGuiderError: isRecord(nagInfo) && typeof nagInfo.error === "string" ? nagInfo.error : undefined
    };
  } catch (error) {
    return {
      reachable: false,
      nagCfgGuiderAvailable: false,
      error: error instanceof Error ? error.message : "ComfyUI 不可达。"
    };
  }
}

async function downloadAsset(url: string, providerLabel = "Seedance", auth?: SeedanceAuth) {
  const response = await fetchWithTimeout(url, {
    timeoutMs: 120_000,
    headers: auth ? seedanceAuthHeaders(auth) : undefined
  });
  if (!response.ok) {
    throw new BridgeError(`下载 ${providerLabel} 产物失败：${response.status}`, 502);
  }
  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  return {
    bytes: Buffer.from(arrayBuffer),
    contentType,
    extension: extensionFromContentType(contentType) || extensionFromUrl(url) || "mp4"
  };
}

async function copyPreprocessSource(input: {
  uploadPath?: string;
  sourceLocalPath?: string;
  sourceVideoUrl?: string;
  targetPath: string;
  providerLabel: string;
}) {
  if (input.uploadPath) {
    await copyFile(input.uploadPath, input.targetPath);
    return;
  }
  if (input.sourceLocalPath) {
    await copyFile(resolveAssetLocalPath(input.sourceLocalPath), input.targetPath);
    return;
  }
  if (!input.sourceVideoUrl) {
    throw new BridgeError("缺少前处理源素材。", 400);
  }
  const localPath = resolveAssetUrlLocalPath(input.sourceVideoUrl);
  if (localPath) {
    await copyFile(localPath, input.targetPath);
    return;
  }
  const downloaded = await downloadAsset(input.sourceVideoUrl, input.providerLabel);
  await writeFile(input.targetPath, downloaded.bytes);
}

async function normalizeVideoDuration(filePath: string, targetDuration: number) {
  const currentDuration = await probeMediaDuration(filePath);
  if (!currentDuration || Math.abs(currentDuration - targetDuration) < 0.05) return;
  const hasAudio = await probeHasAudioStream(filePath);
  const tempPath = `${filePath}.retime-${Date.now()}.mp4`;
  const setPtsFactor = targetDuration / currentDuration;
  const atempoFactor = currentDuration / targetDuration;
  const args = [
    "-y",
    "-i",
    filePath,
    "-map",
    "0:v:0",
    "-vf",
    `setpts=${formatFfmpegNumber(setPtsFactor)}*PTS`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart"
  ];
  if (hasAudio) {
    args.push("-map", "0:a:0", "-af", buildAtempoFilter(atempoFactor), "-c:a", "aac");
  } else {
    args.push("-an");
  }
  args.push(tempPath);
  try {
    await runProcess(resolveFfmpegCommand(), args, 180_000);
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function probeMediaDuration(filePath: string) {
  try {
    const result = await runProcess(
      resolveFfprobeCommand(),
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath],
      30_000
    );
    return positiveNumberOptional(Number(result.stdout.trim()));
  } catch {
    return await probeMediaDurationWithFfmpeg(filePath);
  }
}

async function probeHasAudioStream(filePath: string) {
  try {
    const result = await runProcess(
      resolveFfprobeCommand(),
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", filePath],
      30_000
    );
    return result.stdout.trim().length > 0;
  } catch {
    const result = await runProcessAllowFailure(resolveFfmpegCommand(), ["-i", filePath], 30_000);
    return /Stream #\d+:\d+.*Audio:/i.test(result.stderr);
  }
}

async function splitVideoRange(input: {
  inputPath: string;
  outputPath: string;
  startSec: number;
  durationSec: number;
}) {
  const args = [
    "-y",
    "-ss",
    formatFfmpegNumber(input.startSec),
    "-t",
    formatFfmpegNumber(input.durationSec),
    "-i",
    input.inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    input.outputPath
  ];
  await runProcess(resolveFfmpegCommand(), args, 600_000);
  await stat(input.outputPath);
}

async function probeMediaDurationWithFfmpeg(filePath: string) {
  const result = await runProcessAllowFailure(resolveFfmpegCommand(), ["-i", filePath], 30_000);
  const match = result.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return positiveNumberOptional(hours * 3600 + minutes * 60 + seconds);
}

function resolveFfmpegCommand() {
  return process.env.VIDEOGEN_FFMPEG_PATH?.trim() || resolveImageioFfmpegCommand() || "ffmpeg";
}

function resolveFfprobeCommand() {
  return process.env.VIDEOGEN_FFPROBE_PATH?.trim() || "ffprobe";
}

function resolveImageioFfmpegCommand() {
  const pythonPath = resolvePrivacyPythonPath();
  const result = spawnSync(
    pythonPath,
    [
      "-c",
      [
        "try:",
        "    import imageio_ffmpeg",
        "    print(imageio_ffmpeg.get_ffmpeg_exe())",
        "except Exception:",
        "    pass"
      ].join("\n")
    ],
    { encoding: "utf8" }
  );
  const command = result.stdout.trim();
  return result.status === 0 && command ? command : undefined;
}

async function runProcess(command: string, args: string[], timeoutMs: number) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new BridgeError(`${command} 执行超时：${Math.round(timeoutMs / 1000)}秒未完成。`, 504));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new BridgeError(`${command} 执行失败：${code}${output.stderr.trim() ? `，${output.stderr.trim()}` : ""}`, 500));
    });
  });
}

async function runProcessAllowFailure(command: string, args: string[], timeoutMs: number) {
  return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new BridgeError(`${command} 执行超时：${Math.round(timeoutMs / 1000)}秒未完成。`, 504));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code
      });
    });
  });
}

function buildAtempoFilter(factor: number) {
  const parts: number[] = [];
  let remaining = factor;
  while (remaining > 2) {
    parts.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    parts.push(0.5);
    remaining /= 0.5;
  }
  parts.push(remaining);
  return parts.map((part) => `atempo=${formatFfmpegNumber(part)}`).join(",");
}

function formatFfmpegNumber(value: number) {
  return Number(value.toFixed(8)).toString();
}

async function fetchWithTimeout(url: string, init: TimedRequestInit = {}) {
  const timeoutMs = init.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, signal, ...fetchInit } = init;
  try {
    return await fetch(url, {
      ...fetchInit,
      signal: signal ?? controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new BridgeError(`上游请求超时：${Math.round(timeoutMs / 1000)}秒未响应。`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runPreprocessCommand(input: {
  commandTemplate: string;
  inputPath: string;
  outputPath: string;
  specPath?: string;
  timeoutMs: number;
  placeholderError: string;
  failurePrefix: string;
  timeoutMessage: string;
  requiredPlaceholders?: string[];
  replacements?: Record<string, string>;
}) {
  const requiredPlaceholders = input.requiredPlaceholders ?? ["{input}", "{output}"];
  if (!requiredPlaceholders.every((placeholder) => input.commandTemplate.includes(placeholder))) {
    throw new BridgeError(input.placeholderError, 500);
  }
  const command = input.commandTemplate
    .replaceAll("{input}", shellQuote(input.inputPath))
    .replaceAll("{output}", shellQuote(input.outputPath))
    .replaceAll("{spec}", shellQuote(input.specPath || ""));
  const commandWithReplacements = Object.entries(input.replacements || {}).reduce(
    (current, [placeholder, value]) => current.replaceAll(placeholder, value),
    command
  );
  return await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(commandWithReplacements, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new BridgeError(`${input.timeoutMessage}：${Math.round(input.timeoutMs / 1000)}秒未完成。`, 504));
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8").trim() });
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new BridgeError(`${input.failurePrefix}：${code}${detail ? `，${detail}` : ""}`, 500));
    });
  });
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const PRIVACY_VENV_SETUP_HINT =
  "请先运行 bash scripts/setup-face-mosaic-venv.sh 创建 .venv-face-mosaic，或设置 VIDEOGEN_FACE_MOSAIC_PYTHON / VIDEOGEN_BRAND_MASK_PYTHON。";

const DEPTH_VIDEO_VENV_SETUP_HINT =
  "请先运行 bash scripts/setup-depth-video-venv.sh 创建 .venv-depth-video，设置 VIDEOGEN_DEPTH_VIDEO_PYTHON，并配置 VIDEOGEN_DEPTH_ANYTHING_ONNX 指向 Depth Anything ONNX 模型。";

const FFMPEG_SETUP_HINT =
  "预处理需要 ffmpeg 以导出浏览器可播放的 H.264 视频。请安装系统 ffmpeg（如 brew install ffmpeg），或在虚拟环境中执行: pip install imageio-ffmpeg";

function defaultPrivacyVenvPythonPath() {
  return process.platform === "win32"
    ? path.join(rootDir, ".venv-face-mosaic", "Scripts", "python.exe")
    : path.join(rootDir, ".venv-face-mosaic", "bin", "python");
}

function defaultDepthVideoVenvPythonPath() {
  return process.platform === "win32"
    ? path.join(rootDir, ".venv-depth-video", "Scripts", "python.exe")
    : path.join(rootDir, ".venv-depth-video", "bin", "python");
}

function resolvePrivacyPythonPath() {
  const fromEnv = process.env.VIDEOGEN_BRAND_MASK_PYTHON?.trim() || process.env.VIDEOGEN_FACE_MOSAIC_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  const venvPython = defaultPrivacyVenvPythonPath();
  if (existsSync(venvPython)) return venvPython;
  return "python3";
}

function resolveDepthVideoPythonPath() {
  const fromEnv = process.env.VIDEOGEN_DEPTH_VIDEO_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  const venvPython = defaultDepthVideoVenvPythonPath();
  if (existsSync(venvPython)) return venvPython;
  return resolvePrivacyPythonPath();
}

function privacyPythonReady() {
  const pythonPath = resolvePrivacyPythonPath();
  if (pythonPath === "python3") {
    return existsSync(defaultPrivacyVenvPythonPath());
  }
  return existsSync(pythonPath);
}

function assertPrivacyPythonReady() {
  if (privacyPythonReady()) return;
  throw new BridgeError(PRIVACY_VENV_SETUP_HINT, 500);
}

function depthPythonReady() {
  const pythonPath = resolveDepthVideoPythonPath();
  if (pythonPath === "python3") {
    return existsSync(defaultDepthVideoVenvPythonPath()) || existsSync(defaultPrivacyVenvPythonPath());
  }
  return existsSync(pythonPath);
}

function assertDepthPythonReady() {
  if (depthPythonReady()) return;
  throw new BridgeError(DEPTH_VIDEO_VENV_SETUP_HINT, 500);
}

function resolveDepthAnythingModelPath() {
  return process.env.VIDEOGEN_DEPTH_ANYTHING_ONNX?.trim() || defaultDepthAnythingOnnxPath;
}

function depthAnythingModelReady() {
  return existsSync(resolveDepthAnythingModelPath());
}

function assertDepthAnythingModelReady(modelPath: string) {
  if (modelPath && existsSync(modelPath)) return;
  throw new BridgeError(
    `请配置 VIDEOGEN_DEPTH_ANYTHING_ONNX，或放置默认模型：${defaultDepthAnythingOnnxPath}。模型必须可被 OpenCV DNN 加载。`,
    500
  );
}

function ffmpegReady() {
  const pythonPath = resolvePrivacyPythonPath();
  const result = spawnSync(
    pythonPath,
    [
      "-c",
      [
        "import shutil",
        "try:",
        "    import imageio_ffmpeg",
        "    bundled = imageio_ffmpeg.get_ffmpeg_exe()",
        "    if bundled:",
        "        raise SystemExit(0)",
        "except Exception:",
        "    pass",
        "raise SystemExit(0 if shutil.which('ffmpeg') else 1)"
      ].join("\n")
    ],
    { encoding: "utf8" }
  );
  return result.status === 0;
}

function assertFfmpegReady() {
  if (ffmpegReady()) return;
  throw new BridgeError(FFMPEG_SETUP_HINT, 500);
}

function stripTrailingSlash(value: string) {
  return value.replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function buildComfyUIObjectInfoUrl(endpoint: string, nodeType: string) {
  return `${stripTrailingSlash(endpoint)}/object_info/${encodeURIComponent(nodeType)}`;
}

function safeComfyUIInputFileName(suggestedName: string, fallbackExtension: string) {
  const extension = extensionFromUrl(suggestedName) || fallbackExtension || "bin";
  const baseName = safePathPart(path.basename(suggestedName, path.extname(suggestedName)) || "videogen_input");
  return `${baseName}.${extension}`;
}

function defaultFaceMosaicCommand(preview = false, effect = "mosaic", strength = 0.85) {
  const pythonPath = resolvePrivacyPythonPath();
  const scriptPath = path.join(rootDir, "scripts", "face_mosaic.py");
  const maskArgs = `--block ${maskBlockSizeForStrength(strength)} --blur ${blurKernelForStrength(strength)} --solid-alpha ${solidAlphaForStrength(strength).toFixed(2)}`;
  if (preview) {
    return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --detector mediapipe-face --confidence 0.68 --mediapipe-landmark-confidence 0.5 --mediapipe-landmark-expand 0.03 --expand 0.08 --hold-frames 4 --smooth 0.35 --mode ${shellQuote(faceMosaicModeArg(effect))} --mask-shape ellipse ${maskArgs} --crf 24 --input {input} --output {output}`;
  }
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --detector mediapipe-face --confidence 0.72 --mediapipe-landmark-confidence 0.5 --mediapipe-landmark-expand 0.04 --expand 0.1 --hold-frames 5 --smooth 0.4 --mode ${shellQuote(faceMosaicModeArg(effect))} --mask-shape ellipse ${maskArgs} --input {input} --output {output}`;
}

function parseFaceMosaicEffect(value: string) {
  if (value === "blur" || value === "solid") return value;
  return "mosaic";
}

function faceMosaicModeArg(effect: string) {
  if (effect === "blur") return "blur";
  if (effect === "solid") return "solid";
  return "mosaic";
}

function parseMaskStrength(value: unknown, fallback = 0.85) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0.2, numeric));
}

function maskBlockSizeForStrength(strength: number) {
  return Math.round(6 + parseMaskStrength(strength) * 30);
}

function blurKernelForStrength(strength: number) {
  const kernel = Math.round(9 + parseMaskStrength(strength) * 58);
  return kernel % 2 === 0 ? kernel + 1 : kernel;
}

function solidAlphaForStrength(strength: number) {
  return parseMaskStrength(strength);
}

function defaultBrandMaskCommand(blockOnRed = true) {
  const pythonPath = resolvePrivacyPythonPath();
  const scriptPath = path.join(rootDir, "scripts", "brand_mask.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --input {input} --output {output} --spec {spec}${blockOnRed ? " --block-on-red" : ""}`;
}

function defaultDepthVideoCommand() {
  const pythonPath = resolveDepthVideoPythonPath();
  const scriptPath = path.join(rootDir, "scripts", "depth_video.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --input {input} --output {output} --model {model} --model-path {modelPath} --resolution {resolution} --fps {fps} --color-mode {colorMode} --input-size {inputSize} {letterbox} --edge-filter-strength {edgeFilterStrength} --edge-filter-diameter {edgeFilterDiameter} {invert}`;
}

function defaultGrayscaleVideoCommand() {
  const pythonPath = resolveDepthVideoPythonPath();
  const scriptPath = path.join(rootDir, "scripts", "grayscale_video.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --input {input} --output {output} --resolution {resolution} --fps {fps}`;
}

function defaultHomographyMaskCommand(blockOnRed = true) {
  const pythonPath = process.env.VIDEOGEN_HOMOGRAPHY_PYTHON ||
    process.env.VIDEOGEN_BRAND_MASK_PYTHON ||
    process.env.VIDEOGEN_FACE_MOSAIC_PYTHON ||
    (process.platform === "win32"
      ? path.join(rootDir, ".venv-face-mosaic", "Scripts", "python.exe")
      : path.join(rootDir, ".venv-face-mosaic", "bin", "python"));
  const scriptPath = path.join(rootDir, "scripts", "homography_mask.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --input {input} --output {output} --spec {spec}${blockOnRed ? " --block-on-red" : ""}`;
}

function defaultVitTrackMaskCommand(blockOnRed = true) {
  const pythonPath = process.env.VIDEOGEN_VITTRACK_PYTHON ||
    process.env.VIDEOGEN_BRAND_MASK_PYTHON ||
    process.env.VIDEOGEN_FACE_MOSAIC_PYTHON ||
    (process.platform === "win32"
      ? path.join(rootDir, ".venv-face-mosaic", "Scripts", "python.exe")
      : path.join(rootDir, ".venv-face-mosaic", "bin", "python"));
  const scriptPath = path.join(rootDir, "scripts", "vittrack_mask.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --input {input} --output {output} --spec {spec}${blockOnRed ? " --block-on-red" : ""}`;
}

function defaultMixFormerMaskCommand(blockOnRed = true) {
  const pythonPath = process.env.VIDEOGEN_MIXFORMER_PYTHON ||
    process.env.VIDEOGEN_BRAND_MASK_PYTHON ||
    process.env.VIDEOGEN_FACE_MOSAIC_PYTHON ||
    (process.platform === "win32"
      ? path.join(rootDir, ".venv-face-mosaic", "Scripts", "python.exe")
      : path.join(rootDir, ".venv-face-mosaic", "bin", "python"));
  const scriptPath = path.join(rootDir, "scripts", "mixformer_mask.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --input {input} --output {output} --spec {spec}${blockOnRed ? " --block-on-red" : ""}`;
}

function defaultDDRNetMaskCommand(blockOnRed = true) {
  const pythonPath = process.env.VIDEOGEN_DDRNET_PYTHON ||
    process.env.VIDEOGEN_BRAND_MASK_PYTHON ||
    process.env.VIDEOGEN_FACE_MOSAIC_PYTHON ||
    (process.platform === "win32"
      ? path.join(rootDir, ".venv-face-mosaic", "Scripts", "python.exe")
      : path.join(rootDir, ".venv-face-mosaic", "bin", "python"));
  const scriptPath = path.join(rootDir, "scripts", "ddrnet_mask.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --input {input} --output {output} --spec {spec}${blockOnRed ? " --block-on-red" : ""}`;
}

function defaultTrackAnythingMaskCommand(blockOnRed = true) {
  const pythonPath = process.env.VIDEOGEN_TRACK_ANYTHING_PYTHON ||
    process.env.VIDEOGEN_BRAND_MASK_PYTHON ||
    process.env.VIDEOGEN_FACE_MOSAIC_PYTHON ||
    (process.platform === "win32"
      ? path.join(rootDir, ".venv-face-mosaic", "Scripts", "python.exe")
      : path.join(rootDir, ".venv-face-mosaic", "bin", "python"));
  const scriptPath = path.join(rootDir, "scripts", "track_anything_mask.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --input {input} --output {output} --spec {spec}${blockOnRed ? " --block-on-red" : ""}`;
}

function defaultMaskTrackingCommand(blockOnRed = true) {
  const pythonPath = process.env.VIDEOGEN_MASK_TRACKING_PYTHON ||
    process.env.VIDEOGEN_BRAND_MASK_PYTHON ||
    process.env.VIDEOGEN_FACE_MOSAIC_PYTHON ||
    (process.platform === "win32"
      ? path.join(rootDir, ".venv-face-mosaic", "Scripts", "python.exe")
      : path.join(rootDir, ".venv-face-mosaic", "bin", "python"));
  const scriptPath = path.join(rootDir, "scripts", "external_tracker_adapter.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --engine mask-tracking --display-name ${shellQuote("Mask Tracking")} --backend-env VIDEOGEN_MASK_TRACKING_BACKEND_COMMAND --input {input} --output {output} --spec {spec}${blockOnRed ? " --block-on-red" : ""}`;
}

function parseTrackingEngine(value: string) {
  if (
    value === "homography" ||
    value === "vittrack" ||
    value === "mixformer" ||
    value === "ddrnet" ||
    value === "track-anything" ||
    value === "mask-tracking"
  ) return value;
  return "opencv";
}

function brandMaskCommandForEngine(trackingEngine: string, blockOnRed = true) {
  if (trackingEngine === "homography") {
    return process.env.VIDEOGEN_HOMOGRAPHY_COMMAND?.trim() || defaultHomographyMaskCommand(blockOnRed);
  }
  if (trackingEngine === "vittrack") {
    return process.env.VIDEOGEN_VITTRACK_COMMAND?.trim() || defaultVitTrackMaskCommand(blockOnRed);
  }
  if (trackingEngine === "mixformer") {
    return process.env.VIDEOGEN_MIXFORMER_COMMAND?.trim() || defaultMixFormerMaskCommand(blockOnRed);
  }
  if (trackingEngine === "ddrnet") {
    return process.env.VIDEOGEN_DDRNET_COMMAND?.trim() || defaultDDRNetMaskCommand(blockOnRed);
  }
  if (trackingEngine === "track-anything") {
    const command = process.env.VIDEOGEN_TRACK_ANYTHING_COMMAND?.trim();
    return command || defaultTrackAnythingMaskCommand(blockOnRed);
  }
  if (trackingEngine === "mask-tracking") {
    return process.env.VIDEOGEN_MASK_TRACKING_COMMAND?.trim() || defaultMaskTrackingCommand(blockOnRed);
  }
  return process.env.VIDEOGEN_BRAND_MASK_COMMAND?.trim() || defaultBrandMaskCommand(blockOnRed);
}

function brandMaskCommandEnvName(trackingEngine: string) {
  if (trackingEngine === "mask-tracking") return "VIDEOGEN_MASK_TRACKING_COMMAND";
  if (trackingEngine === "track-anything") return "VIDEOGEN_TRACK_ANYTHING_COMMAND";
  if (trackingEngine === "mixformer") return "VIDEOGEN_MIXFORMER_COMMAND";
  if (trackingEngine === "ddrnet") return "VIDEOGEN_DDRNET_COMMAND";
  if (trackingEngine === "vittrack") return "VIDEOGEN_VITTRACK_COMMAND";
  if (trackingEngine === "homography") return "VIDEOGEN_HOMOGRAPHY_COMMAND";
  return "VIDEOGEN_BRAND_MASK_COMMAND";
}

function brandMaskTimeoutMs(trackingEngine: string) {
  if (trackingEngine === "mask-tracking") return Number(process.env.VIDEOGEN_MASK_TRACKING_TIMEOUT_MS || 1_200_000);
  if (trackingEngine === "track-anything") return Number(process.env.VIDEOGEN_TRACK_ANYTHING_TIMEOUT_MS || 900_000);
  if (trackingEngine === "mixformer") return Number(process.env.VIDEOGEN_MIXFORMER_TIMEOUT_MS || 900_000);
  if (trackingEngine === "ddrnet") return Number(process.env.VIDEOGEN_DDRNET_TIMEOUT_MS || 900_000);
  if (trackingEngine === "vittrack") return Number(process.env.VIDEOGEN_VITTRACK_TIMEOUT_MS || 600_000);
  if (trackingEngine === "homography") return Number(process.env.VIDEOGEN_HOMOGRAPHY_TIMEOUT_MS || 360_000);
  return Number(process.env.VIDEOGEN_BRAND_MASK_TIMEOUT_MS || 240_000);
}

function brandMaskOutputPrefix(trackingEngine: string) {
  if (trackingEngine === "mask-tracking") return "mask_tracking";
  if (trackingEngine === "track-anything") return "track_anything_mask";
  if (trackingEngine === "mixformer") return "mixformer_mask";
  if (trackingEngine === "ddrnet") return "ddrnet_mask";
  if (trackingEngine === "vittrack") return "vittrack_mask";
  if (trackingEngine === "homography") return "homography_mask";
  return "brand_mask";
}

function brandMaskEngineLabel(trackingEngine: string) {
  if (trackingEngine === "mask-tracking") return "Mask Tracking ";
  if (trackingEngine === "track-anything") return "Track-Anything ";
  if (trackingEngine === "mixformer") return "MixFormerV2-S ";
  if (trackingEngine === "ddrnet") return "DDRNet ";
  if (trackingEngine === "vittrack") return "ViTTrack ";
  if (trackingEngine === "homography") return "Homography ";
  return "";
}

function parseCommandSummary(stdout: string) {
  if (!stdout) return undefined;
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      // Try earlier lines.
    }
  }
  return undefined;
}

function parseTracks(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new BridgeError("物体追踪打码 tracks JSON 解析失败。", 400);
  }
}

function resolveAssetLocalPath(value: string) {
  const resolved = path.resolve(value);
  const assetRoot = path.resolve(assetRootDir);
  if (!resolved.startsWith(`${assetRoot}${path.sep}`)) {
    throw new BridgeError("sourceLocalPath 必须来自当前 Video Generation Bridge 的资产目录。", 400);
  }
  return resolved;
}

function resolveAssetUrlLocalPath(value: string) {
  try {
    const parsed = new URL(value);
    const assetPrefix = "/assets/";
    const assetIndex = parsed.pathname.indexOf(assetPrefix);
    if (assetIndex < 0) return undefined;
    const relativePath = decodeURIComponent(parsed.pathname.slice(assetIndex + assetPrefix.length));
    const resolved = path.resolve(assetRootDir, relativePath);
    const assetRoot = path.resolve(assetRootDir);
    if (!resolved.startsWith(`${assetRoot}${path.sep}`)) {
      throw new BridgeError("sourceVideoUrl 必须来自当前 Video Generation Bridge 的资产目录。", 400);
    }
    return resolved;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    return undefined;
  }
}

async function readPayload(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function normalizeSeedanceTaskResponse(payload: unknown): SeedanceTaskResponse {
  if (isRecord(payload)) {
    const task = selectTaskPayload(payload);
    if (isRecord(task)) {
      return {
        id: String(task.id || task.task_id || ""),
        model: stringifyOptional(task.model),
        status: stringifyOptional(task.status),
        content: {
          video_url: stringifyOptional(task.video_url)
            || stringifyOptional(task.url)
            || (isRecord(task.content) ? stringifyOptional(task.content.video_url) : undefined),
          last_frame_url: isRecord(task.content) ? stringifyOptional(task.content.last_frame_url) : undefined
        },
        error: isRecord(task.error)
          ? {
              code: stringifyOptional(task.error.code),
              message: stringifyOptional(task.error.message)
            }
          : null,
        created_at: numberOptional(task.created_at),
        updated_at: numberOptional(task.updated_at),
        seed: numberOptional(task.seed),
        resolution: stringifyOptional(task.resolution),
        ratio: stringifyOptional(task.ratio),
        duration: numberOptional(task.duration),
        progress: numberOptional(task.progress),
        usage: isRecord(task.usage) ? task.usage : undefined,
        raw: payload
      };
    }
  }
  return {
    id: "",
    raw: payload
  };
}

function selectTaskPayload(payload: Record<string, unknown>) {
  if (payload.id || payload.task_id) return payload;
  if (isRecord(payload.data)) return payload.data;
  if (isRecord(payload.result)) return payload.result;
  return payload;
}

function parseWorkflowJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new BridgeError(
      `ComfyUI workflow JSON 解析失败：${error instanceof Error ? error.message : "invalid JSON"}`,
      400
    );
  }
}

function inferComfyUIQueueStatus(payload: unknown, promptId: string) {
  if (!isRecord(payload)) return undefined;
  if (containsPromptId(payload.queue_running, promptId)) return "running";
  if (containsPromptId(payload.queue_pending, promptId)) return "queued";
  return undefined;
}

function containsPromptId(value: unknown, promptId: string): boolean {
  if (typeof value === "string") return value === promptId;
  if (Array.isArray(value)) return value.some((item) => containsPromptId(item, promptId));
  if (!isRecord(value)) return false;
  if (value.prompt_id === promptId || value.id === promptId) return true;
  return Object.values(value).some((item) => containsPromptId(item, promptId));
}

async function resolveSeedanceAuth(apiKeyEnvName: string, requestUrl: string): Promise<SeedanceAuth> {
  if (process.env.NEWAPI_USERNAME && process.env.NEWAPI_PASSWORD) {
    return loginSeedance(requestUrl);
  }
  const apiKey = readApiKeyOptional(apiKeyEnvName);
  if (apiKey) return { authorization: `Bearer ${apiKey}` };
  return loginSeedance(requestUrl);
}

function readApiKeyOptional(apiKeyEnvName: string) {
  const safeEnvName = apiKeyEnvName || "NEWAPI_API_KEY";
  const apiKey = process.env[safeEnvName];
  return apiKey;
}

async function loginSeedance(requestUrl: string): Promise<SeedanceAuth> {
  const username = process.env.NEWAPI_USERNAME;
  const password = process.env.NEWAPI_PASSWORD;
  if (!username || !password) {
    throw new BridgeError("未配置 NEWAPI_API_KEY，且未配置 NEWAPI_USERNAME/NEWAPI_PASSWORD，无法调用 Seedance。", 400);
  }
  const endpoint = new URL(requestUrl).origin;
  if (cachedSeedanceLogin?.endpoint === endpoint && cachedSeedanceLogin.expiresAt > Date.now()) {
    return cachedSeedanceLogin.auth;
  }
  const response = await fetchWithTimeout(`${endpoint}/api/user/login`, {
    method: "POST",
    timeoutMs: 30_000,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new BridgeError(
      extractUpstreamError(payload) || `NewAPI 登录失败：${response.status}`,
      response.status === 401 || response.status === 403 ? response.status : 502
    );
  }
  const userId = extractLoginUserId(payload);
  const cookie = response.headers.get("set-cookie")?.split(",").map((item) => item.split(";")[0].trim()).filter(Boolean).join("; ");
  if (!userId || !cookie) {
    throw new BridgeError("NewAPI 登录成功但未返回用户 ID 或 session cookie，无法自动获取视频接口令牌。", 400);
  }
  const apiKey = await resolveSeedanceApiToken(endpoint, cookie, userId);
  if (!apiKey) {
    throw new BridgeError("未能自动获取 NewAPI 视频接口令牌。请在令牌管理中创建令牌，并配置 NEWAPI_API_KEY。", 400);
  }
  const auth = { authorization: `Bearer ${apiKey}` };
  cachedSeedanceLogin = {
    endpoint,
    auth,
    expiresAt: Date.now() + 50 * 60_000
  };
  return auth;
}

function seedanceAuthHeaders(auth: SeedanceAuth): Record<string, string> {
  return {
    ...(auth.authorization ? { Authorization: auth.authorization } : {})
  };
}

async function resolveSeedanceApiToken(endpoint: string, cookie: string, userId: string) {
  const token = await findSeedanceApiToken(endpoint, cookie, userId);
  if (token) return token;
  await createSeedanceApiToken(endpoint, cookie, userId);
  return findSeedanceApiToken(endpoint, cookie, userId);
}

async function findSeedanceApiToken(endpoint: string, cookie: string, userId: string) {
  const response = await fetchWithTimeout(`${endpoint}/api/token/?p=0&page_size=100`, {
    method: "GET",
    timeoutMs: 30_000,
    headers: {
      Cookie: cookie,
      "New-Api-User": userId
    }
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new BridgeError(extractUpstreamError(payload) || `读取 NewAPI 令牌失败：${response.status}`, 502);
  }
  const tokens = extractTokenItems(payload)
    .filter((item) => item.status !== 2 && typeof item.key === "string" && item.key)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  return stringifyOptional(tokens[0]?.key);
}

async function createSeedanceApiToken(endpoint: string, cookie: string, userId: string) {
  const response = await fetchWithTimeout(`${endpoint}/api/token/`, {
    method: "POST",
    timeoutMs: 30_000,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "New-Api-User": userId
    },
    body: JSON.stringify({
      name: "videogen-local",
      remain_quota: 500000,
      unlimited_quota: false,
      expired_time: 0
    })
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new BridgeError(extractUpstreamError(payload) || `创建 NewAPI 令牌失败：${response.status}`, 502);
  }
}

function extractTokenItems(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord);
  if (isRecord(payload.data) && Array.isArray(payload.data.items)) return payload.data.items.filter(isRecord);
  if (Array.isArray(payload.items)) return payload.items.filter(isRecord);
  return [];
}

function extractLoginUserId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.id === "number" || typeof payload.id === "string") return String(payload.id);
  if (isRecord(payload.data) && (typeof payload.data.id === "number" || typeof payload.data.id === "string")) {
    return String(payload.data.id);
  }
  for (const key of ["result", "user"]) {
    const nested = payload[key];
    const id = extractLoginUserId(nested);
    if (id) return id;
  }
  return undefined;
}

function resolveSeedanceEndpoint(endpoint: string) {
  return process.env.SEEDANCE_NEWAPI_BASE_URL || process.env.NEWAPI_BASE_URL || endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL;
}

function publicBaseUrl(req: express.Request) {
  return `${req.protocol}://${req.get("host")}`;
}

function assetBaseUrl(req: express.Request) {
  return (process.env.VIDEOGEN_PUBLIC_ASSET_BASE_URL || `${publicBaseUrl(req)}/assets`).replace(/\/+$/, "");
}

function assetUrl(req: express.Request, relativeDir: string, fileName: string) {
  const encodedDir = relativeDir.split(path.sep).map(encodeURIComponent).join("/");
  return `${assetBaseUrl(req)}/${encodedDir}/${encodeURIComponent(fileName)}`;
}

function safePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}

function extensionFromUrl(url: string) {
  const cleanUrl = url.split("?")[0] || "";
  const match = cleanUrl.match(/\.([a-zA-Z0-9]+)$/);
  return match?.[1]?.toLowerCase();
}

function extensionFromContentType(contentType: string | null) {
  if (!contentType) return undefined;
  if (contentType.includes("video/mp4")) return "mp4";
  if (contentType.includes("video/quicktime")) return "mov";
  if (contentType.includes("video/webm")) return "webm";
  if (contentType.includes("image/png")) return "png";
  if (contentType.includes("image/jpeg")) return "jpg";
  if (contentType.includes("image/webp")) return "webp";
  return undefined;
}

function isVideoExtension(extension: string) {
  return ["mp4", "mov", "webm", "mkv", "avi"].includes(extension.toLowerCase());
}

function extractUpstreamError(payload: unknown) {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;
  return undefined;
}

function formatSeedanceUpstreamError(payload: unknown, status: number) {
  const message = extractUpstreamError(payload) || `Seedance upstream request failed: ${status}`;
  if (/api key|ak\/sk|missing or invalid/i.test(message)) {
    return `${message}。本地 NewAPI Bearer 鉴权已通过，但 apicoco 的 Seedance 渠道上游 API Key/AK/SK 缺失或无效，请在 apicoco 后台检查 xsdoubao/seedance 渠道配置。`;
  }
  return message;
}

function validateSeedanceRemoteMediaUrls(body: SeedanceCreateTaskBridgeRequest["body"]) {
  const mediaUrls = [
    ...(body?.metadata?.image_files || []),
    ...(body?.metadata?.audio_files || []),
    ...(body?.metadata?.video_files || [])
  ];
  const localOnlyUrls = mediaUrls.filter(isLocalOnlyUrl);
  if (localOnlyUrls.length) {
    throw new BridgeError(
      "Seedance 远端无法访问本地素材地址。当前素材 URL 指向 localhost/127.0.0.1/内网 IP，请配置 VIDEOGEN_PUBLIC_ASSET_BASE_URL 为公网可访问的 /assets 地址，或使用公网存储素材 URL。",
      400
    );
  }
}

async function normalizeSeedanceMediaUrls(req: express.Request, body: SeedanceCreateTaskBridgeRequest["body"]) {
  return {
    ...body,
    metadata: {
      ...body.metadata,
      ...(body.metadata.image_files ? { image_files: await normalizeSeedanceMediaUrlList(req, body.metadata.image_files) } : {}),
      ...(body.metadata.audio_files ? { audio_files: await normalizeSeedanceMediaUrlList(req, body.metadata.audio_files) } : {}),
      ...(body.metadata.video_files ? { video_files: await normalizeSeedanceMediaUrlList(req, body.metadata.video_files) } : {})
    }
  };
}

async function normalizeSeedanceMediaUrlList(req: express.Request, urls: string[]) {
  return Promise.all(urls.map((url) => normalizeSeedanceMediaUrl(req, url)));
}

async function normalizeSeedanceMediaUrl(req: express.Request, value: string) {
  const localAsset = resolveLocalAssetUrl(value);
  if (localAsset && isOssConfigured()) {
    const signed = await uploadAndSignOssAsset({
      relativeDir: localAsset.relativeDir,
      fileName: localAsset.fileName,
      localPath: localAsset.localPath,
      mime: mimeFromFileName(localAsset.fileName)
    });
    if (signed) return signed.signedUrl;
  }
  return normalizeAssetUrl(req, value);
}

function normalizeWorkbenchAssetUrls(req: express.Request, state: WorkbenchLibraryState) {
  return normalizeAssetUrlsInValue(req, state) as WorkbenchLibraryState;
}

function normalizeAssetUrlsInValue(req: express.Request, value: unknown): unknown {
  if (typeof value === "string") return normalizeAssetUrl(req, value);
  if (Array.isArray(value)) return value.map((item) => normalizeAssetUrlsInValue(req, item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeAssetUrlsInValue(req, item)]));
}

function normalizeAssetUrl(req: express.Request, value: string) {
  try {
    const url = new URL(value);
    if (!isLocalOnlyUrl(value) || !url.pathname.startsWith("/assets/")) return value;
    const publicAssets = new URL(`${assetBaseUrl(req)}/`);
    const relativePath = url.pathname.slice("/assets/".length);
    return `${publicAssets.href}${relativePath}${url.search}`;
  } catch {
    return value;
  }
}

function resolveLocalAssetUrl(value: string) {
  try {
    const url = new URL(value);
    if (!url.pathname.startsWith("/assets/")) return undefined;
    const decodedPath = decodeURIComponent(url.pathname.slice("/assets/".length));
    const localPath = path.resolve(assetRootDir, decodedPath);
    resolveAssetLocalPath(localPath);
    return {
      relativeDir: path.dirname(decodedPath),
      fileName: path.basename(decodedPath),
      localPath
    };
  } catch {
    return undefined;
  }
}

async function ossAssetFields(relativeDir: string, fileName: string, localPath: string, mime?: string) {
  const signed = await uploadAndSignOssAsset({ relativeDir, fileName, localPath, mime });
  return signed
    ? {
        ossObjectKey: signed.objectKey,
        remoteAssetUrl: signed.signedUrl,
        remoteAssetUrlExpiresAt: signed.expiresAt
      }
    : {};
}

function mimeFromFileName(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return undefined;
}

function isLocalOnlyUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname === "0.0.0.0"
      || hostname.startsWith("10.")
      || hostname.startsWith("192.168.")
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
  } catch {
    return false;
  }
}

function stringifyOptional(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberOptional(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumberOptional(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

class BridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
