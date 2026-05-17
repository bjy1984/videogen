import cors from "cors";
import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  type ComfyUICreateTaskBridgeRequest,
  type ComfyUISyncAssetResponse,
  type ComfyUITaskResponse
} from "../src/features/generation/providers/comfyuiApi";
import {
  DEFAULT_SEEDANCE_ARK_BASE_URL,
  buildSeedanceCreateUrl,
  buildSeedanceTaskUrl,
  type SeedanceCreateTaskBridgeRequest,
  type SeedanceSyncAssetResponse,
  type SeedanceTaskResponse
} from "../src/features/generation/providers/seedanceArk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const assetRootDir = process.env.VIDEOGEN_ASSET_ROOT || path.join(rootDir, ".videogen-assets");
const uploadTempDir = path.join(assetRootDir, "_uploads");
const port = Number(process.env.VIDEO_GENERATION_BRIDGE_PORT || 8790);
const app = express();
const upload = multer({ dest: uploadTempDir });

await mkdir(assetRootDir, { recursive: true });
await mkdir(uploadTempDir, { recursive: true });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "64mb" }));
app.use("/assets", express.static(assetRootDir));

app.get("/health", async (req, res) => {
  const apiKeyEnvName = String(req.query.apiKeyEnvName || "ARK_API_KEY");
  const comfyEndpoint = String(req.query.comfyEndpoint || DEFAULT_COMFYUI_ENDPOINT);
  const comfyHealth = await checkComfyUIHealth(comfyEndpoint);
  res.json({
    ok: true,
    service: "video-generation-bridge",
    port,
    assetRootDir,
    assetBaseUrl: assetBaseUrl(req),
    seedance: {
      endpoint: DEFAULT_SEEDANCE_ARK_BASE_URL,
      apiKeyEnvName,
      hasApiKey: Boolean(process.env[apiKeyEnvName])
    },
    comfyui: {
      endpoint: comfyEndpoint,
      reachable: comfyHealth.reachable,
      error: comfyHealth.error
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

app.post("/seedance/tasks", async (req, res) => {
  const request = req.body as SeedanceCreateTaskBridgeRequest;
  try {
    const apiKey = readApiKey(request.apiKeyEnvName);
    const upstreamUrl = buildSeedanceCreateUrl(request.endpoint);
    const task = await requestSeedanceTask(upstreamUrl, apiKey, {
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
    const endpoint = String(req.body.endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL);
    const apiKeyEnvName = String(req.body.apiKeyEnvName || "ARK_API_KEY");
    const projectId = safePathPart(String(req.body.projectId || "default_project"));
    const assetId = safePathPart(String(req.body.assetId || req.params.id));
    const apiKey = readApiKey(apiKeyEnvName);
    const upstreamUrl = buildSeedanceTaskUrl(endpoint, req.params.id);
    const task = await requestSeedanceTask(upstreamUrl, apiKey, { method: "GET" });
    const sourceUrl = String(req.body.sourceUrl || task.content?.video_url || "");
    if (task.status && task.status !== "succeeded") {
      throw new BridgeError(`Seedance 任务尚未成功，当前状态：${task.status}`, 409);
    }
    if (!sourceUrl) {
      throw new BridgeError("Seedance 任务没有可转存的 video_url。", 409);
    }

    const downloaded = await downloadAsset(sourceUrl);
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
    const endpoint = String(req.query.endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL);
    const apiKeyEnvName = String(req.query.apiKeyEnvName || "ARK_API_KEY");
    const apiKey = readApiKey(apiKeyEnvName);
    const upstreamUrl = buildSeedanceTaskUrl(endpoint, req.params.id);
    const task = await requestSeedanceTask(upstreamUrl, apiKey, { method: "GET" });
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
    const workflow = await resolveComfyUIWorkflow(request);
    const promptBody = buildComfyUIPromptBody({
      workflow,
      prompt: request.prompt,
      promptNodeId: request.promptNodeId,
      seed: request.seed,
      steps: request.steps,
      cfgScale: request.cfgScale,
      sourceVideoUrl: request.sourceVideoUrl,
      clientId: request.clientId
    });
    const upstreamUrl = buildComfyUIPromptUrl(request.endpoint || DEFAULT_COMFYUI_ENDPOINT);
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
    const output = selectBestComfyUIOutputFile(task.outputFiles, outputNodeId);
    if (!output) {
      throw new BridgeError("ComfyUI 任务没有可转存的输出文件。", 409);
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

async function requestSeedanceTask(url: string, apiKey: string, init: TimedRequestInit) {
  const response = await fetchWithTimeout(url, {
    ...init,
    timeoutMs: init.timeoutMs ?? 45_000,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    }
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new BridgeError(
      extractUpstreamError(payload) || `Seedance upstream request failed: ${response.status}`,
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
    return { reachable: true };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : "ComfyUI 不可达。"
    };
  }
}

async function downloadAsset(url: string, providerLabel = "Seedance") {
  const response = await fetchWithTimeout(url, { timeoutMs: 120_000 });
  if (!response.ok) {
    throw new BridgeError(`下载 ${providerLabel} 产物失败：${response.status}`, 502);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    extension: extensionFromContentType(response.headers.get("content-type")) || extensionFromUrl(url) || "mp4"
  };
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
}) {
  const requiredPlaceholders = input.requiredPlaceholders ?? ["{input}", "{output}"];
  if (!requiredPlaceholders.every((placeholder) => input.commandTemplate.includes(placeholder))) {
    throw new BridgeError(input.placeholderError, 500);
  }
  const command = input.commandTemplate
    .replaceAll("{input}", shellQuote(input.inputPath))
    .replaceAll("{output}", shellQuote(input.outputPath))
    .replaceAll("{spec}", shellQuote(input.specPath || ""));
  return await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
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

function defaultFaceMosaicCommand(preview = false, effect = "mosaic", strength = 0.85) {
  const pythonPath = process.env.VIDEOGEN_FACE_MOSAIC_PYTHON ||
    (process.platform === "win32"
      ? path.join(rootDir, ".venv-face-mosaic", "Scripts", "python.exe")
      : path.join(rootDir, ".venv-face-mosaic", "bin", "python"));
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
  const pythonPath = process.env.VIDEOGEN_BRAND_MASK_PYTHON ||
    process.env.VIDEOGEN_FACE_MOSAIC_PYTHON ||
    (process.platform === "win32"
      ? path.join(rootDir, ".venv-face-mosaic", "Scripts", "python.exe")
      : path.join(rootDir, ".venv-face-mosaic", "bin", "python"));
  const scriptPath = path.join(rootDir, "scripts", "brand_mask.py");
  return `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --input {input} --output {output} --spec {spec}${blockOnRed ? " --block-on-red" : ""}`;
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
        content: isRecord(task.content)
          ? {
              video_url: stringifyOptional(task.content.video_url),
              last_frame_url: stringifyOptional(task.content.last_frame_url)
            }
          : undefined,
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

function readApiKey(apiKeyEnvName: string) {
  const safeEnvName = apiKeyEnvName || "ARK_API_KEY";
  const apiKey = process.env[safeEnvName];
  if (!apiKey) {
    throw new BridgeError(`未配置环境变量 ${safeEnvName}，无法调用 Seedance。`, 400);
  }
  return apiKey;
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
  return undefined;
}

function extractUpstreamError(payload: unknown) {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;
  return undefined;
}

function stringifyOptional(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberOptional(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
