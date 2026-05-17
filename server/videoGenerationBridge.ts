import cors from "cors";
import express from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const port = Number(process.env.VIDEO_GENERATION_BRIDGE_PORT || 8788);
const app = express();

await mkdir(assetRootDir, { recursive: true });

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
    assetBaseUrl: `${publicBaseUrl(req)}/assets`,
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
      localAssetUrl: `${publicBaseUrl(req)}/assets/${relativeDir.split(path.sep).map(encodeURIComponent).join("/")}/${encodeURIComponent(fileName)}`,
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
      localAssetUrl: `${publicBaseUrl(req)}/assets/${relativeDir.split(path.sep).map(encodeURIComponent).join("/")}/${encodeURIComponent(fileName)}`,
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

async function requestSeedanceTask(url: string, apiKey: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
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

async function requestComfyUIJson(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
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
  const response = await fetch(url);
  if (!response.ok) {
    throw new BridgeError(`下载 ${providerLabel} 产物失败：${response.status}`, 502);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    extension: extensionFromContentType(response.headers.get("content-type")) || extensionFromUrl(url) || "mp4"
  };
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
