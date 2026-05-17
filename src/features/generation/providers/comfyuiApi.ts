import type { GenerationJobStatus } from "../generationTypes";

export const DEFAULT_COMFYUI_ENDPOINT = "http://127.0.0.1:8188";
export const DEFAULT_COMFYUI_BRIDGE_URL = "http://localhost:8788";

export interface ComfyUIProviderParams {
  bridgeUrl?: string;
  endpoint?: string;
  workflowTemplateId?: string;
  workflowJson?: string;
  promptNodeId?: string;
  outputNodeId?: string;
  seed?: string;
  steps?: number;
  cfgScale?: number;
}

export interface ComfyUICreateTaskBridgeRequest {
  endpoint: string;
  workflowTemplateId: string;
  workflowJson?: string;
  promptNodeId: string;
  outputNodeId: string;
  prompt: string;
  seed: string;
  steps: number;
  cfgScale: number;
  duration: number;
  aspectRatio: string;
  referenceImageUrl?: string;
  clientId: string;
}

export interface ComfyUIOutputFile {
  nodeId: string;
  kind: string;
  filename: string;
  subfolder?: string;
  type?: string;
  viewUrl?: string;
}

export interface ComfyUITaskResponse {
  id: string;
  promptId: string;
  status?: string;
  queuePosition?: number;
  outputFiles?: ComfyUIOutputFile[];
  error?: string;
  raw?: unknown;
}

export interface ComfyUISyncAssetResponse {
  task: ComfyUITaskResponse;
  asset: {
    projectId: string;
    assetId: string;
    fileName: string;
    localPath: string;
    localAssetUrl: string;
    sourceUrl: string;
    savedAt: string;
  };
}

export function buildComfyUICreateTaskRequest(input: {
  prompt: string;
  duration: number;
  aspectRatio: string;
  referenceImageUrl?: string;
  params?: ComfyUIProviderParams;
}) {
  const params = input.params ?? {};
  return {
    endpoint: stripTrailingSlash(params.endpoint || DEFAULT_COMFYUI_ENDPOINT),
    workflowTemplateId: params.workflowTemplateId || "default-video-workflow",
    workflowJson: params.workflowJson,
    promptNodeId: params.promptNodeId || "6",
    outputNodeId: params.outputNodeId || "",
    prompt: input.prompt.trim(),
    seed: params.seed || "-1",
    steps: normalizePositiveNumber(params.steps, 24),
    cfgScale: normalizePositiveNumber(params.cfgScale, 7),
    duration: input.duration,
    aspectRatio: input.aspectRatio,
    referenceImageUrl: input.referenceImageUrl,
    clientId: createClientId()
  } satisfies ComfyUICreateTaskBridgeRequest;
}

export function buildComfyUIPromptUrl(endpoint: string) {
  return `${stripTrailingSlash(endpoint)}/prompt`;
}

export function buildComfyUIHistoryUrl(endpoint: string, promptId: string) {
  return `${stripTrailingSlash(endpoint)}/history/${encodeURIComponent(promptId)}`;
}

export function buildComfyUIQueueUrl(endpoint: string) {
  return `${stripTrailingSlash(endpoint)}/queue`;
}

export function buildComfyUISystemStatsUrl(endpoint: string) {
  return `${stripTrailingSlash(endpoint)}/system_stats`;
}

export function buildComfyUIViewUrl(endpoint: string, file: Pick<ComfyUIOutputFile, "filename" | "subfolder" | "type">) {
  const searchParams = new URLSearchParams({
    filename: file.filename,
    type: file.type || "output"
  });
  if (file.subfolder) searchParams.set("subfolder", file.subfolder);
  return `${stripTrailingSlash(endpoint)}/view?${searchParams.toString()}`;
}

export function buildComfyUIPromptBody(input: {
  workflow: unknown;
  prompt: string;
  promptNodeId: string;
  seed: string;
  steps: number;
  cfgScale: number;
  clientId: string;
}) {
  return {
    prompt: prepareComfyUIWorkflow({
      workflow: input.workflow,
      prompt: input.prompt,
      promptNodeId: input.promptNodeId,
      seed: input.seed,
      steps: input.steps,
      cfgScale: input.cfgScale
    }),
    client_id: input.clientId
  };
}

export function prepareComfyUIWorkflow(input: {
  workflow: unknown;
  prompt: string;
  promptNodeId: string;
  seed: string;
  steps: number;
  cfgScale: number;
}) {
  if (!isRecord(input.workflow)) {
    throw new Error("ComfyUI workflow 必须是 API 格式 JSON 对象。");
  }
  const workflow = structuredClone(input.workflow) as Record<string, unknown>;
  injectPrompt(workflow, input.promptNodeId, input.prompt);
  injectSamplerControls(workflow, input.seed, input.steps, input.cfgScale);
  return workflow;
}

export function normalizeComfyUISubmitResponse(payload: unknown): ComfyUITaskResponse {
  if (!isRecord(payload)) {
    return {
      id: "",
      promptId: "",
      status: "failed",
      error: "ComfyUI submit response 不是有效 JSON。",
      raw: payload
    };
  }
  const promptId = stringifyOptional(payload.prompt_id) || stringifyOptional(payload.id) || "";
  const nodeErrors = payload.node_errors;
  return {
    id: promptId,
    promptId,
    status: nodeErrors && isNonEmptyObject(nodeErrors) ? "failed" : "queued",
    queuePosition: numberOptional(payload.number),
    error: nodeErrors && isNonEmptyObject(nodeErrors) ? JSON.stringify(nodeErrors) : undefined,
    raw: payload
  };
}

export function normalizeComfyUIHistoryResponse(input: {
  endpoint: string;
  promptId: string;
  payload: unknown;
}) {
  const history = extractHistoryEntry(input.payload, input.promptId);
  if (!history) {
    return {
      id: input.promptId,
      promptId: input.promptId,
      status: "running",
      outputFiles: [],
      raw: input.payload
    } satisfies ComfyUITaskResponse;
  }

  const outputFiles = extractComfyUIOutputFiles(history.outputs, input.endpoint);
  const error = extractHistoryError(history);
  return {
    id: input.promptId,
    promptId: input.promptId,
    status: error ? "failed" : isHistoryCompleted(history) || outputFiles.length ? "succeeded" : "running",
    outputFiles,
    error,
    raw: input.payload
  } satisfies ComfyUITaskResponse;
}

export function mapComfyUITaskStatus(status?: string): GenerationJobStatus {
  const normalized = (status || "").toLowerCase();
  if (["succeeded", "success", "done", "completed"].includes(normalized)) return "done";
  if (["failed", "error", "errored"].includes(normalized)) return "failed";
  if (["queued", "pending"].includes(normalized)) return "queued";
  return "generating";
}

export function extractComfyUITaskError(task: ComfyUITaskResponse) {
  return task.error;
}

export function selectBestComfyUIOutputFile(files: ComfyUIOutputFile[] = [], outputNodeId?: string) {
  const scoped = outputNodeId ? files.filter((file) => file.nodeId === outputNodeId) : files;
  const candidates = scoped.length ? scoped : files;
  return (
    candidates.find((file) => isVideoFile(file.filename)) ||
    candidates.find((file) => file.kind === "videos" || file.kind === "gifs") ||
    candidates[0]
  );
}

function injectPrompt(workflow: Record<string, unknown>, promptNodeId: string, prompt: string) {
  const node = workflow[promptNodeId];
  if (!isRecord(node)) {
    throw new Error(`ComfyUI workflow 中找不到 Prompt Node：${promptNodeId}`);
  }
  const inputs = ensureInputs(node);
  if ("text" in inputs) inputs.text = prompt;
  else if ("prompt" in inputs) inputs.prompt = prompt;
  else if ("positive" in inputs) inputs.positive = prompt;
  else inputs.text = prompt;
}

function injectSamplerControls(workflow: Record<string, unknown>, seed: string, steps: number, cfgScale: number) {
  const resolvedSeed = resolveSeed(seed);
  for (const node of Object.values(workflow)) {
    if (!isRecord(node)) continue;
    const inputs = isRecord(node.inputs) ? node.inputs : undefined;
    if (!inputs) continue;
    if ("seed" in inputs) inputs.seed = resolvedSeed;
    if ("noise_seed" in inputs) inputs.noise_seed = resolvedSeed;
    if ("steps" in inputs) inputs.steps = Math.max(1, Math.floor(steps));
    if ("cfg" in inputs) inputs.cfg = cfgScale;
    if ("cfg_scale" in inputs) inputs.cfg_scale = cfgScale;
  }
}

function extractHistoryEntry(payload: unknown, promptId: string) {
  if (!isRecord(payload)) return null;
  const keyed = payload[promptId];
  if (isRecord(keyed)) return keyed;
  if (isRecord(payload.outputs) || isRecord(payload.status)) return payload;
  return null;
}

function extractComfyUIOutputFiles(outputs: unknown, endpoint: string) {
  if (!isRecord(outputs)) return [];
  const files: ComfyUIOutputFile[] = [];
  for (const [nodeId, output] of Object.entries(outputs)) {
    if (!isRecord(output)) continue;
    for (const [kind, value] of Object.entries(output)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!isRecord(item) || typeof item.filename !== "string") continue;
        const file = {
          nodeId,
          kind,
          filename: item.filename,
          subfolder: stringifyOptional(item.subfolder),
          type: stringifyOptional(item.type) || "output"
        };
        files.push({
          ...file,
          viewUrl: buildComfyUIViewUrl(endpoint, file)
        });
      }
    }
  }
  return files.sort((a, b) => filePriority(a) - filePriority(b));
}

function extractHistoryError(history: Record<string, unknown>) {
  if (isRecord(history.status)) {
    const statusText = stringifyOptional(history.status.status_str);
    if (statusText && /error|failed/i.test(statusText)) return statusText;
  }
  const messages = history.status && isRecord(history.status) ? history.status.messages : undefined;
  if (Array.isArray(messages)) {
    const errorMessage = messages.find((message) => Array.isArray(message) && String(message[0]).includes("error"));
    if (errorMessage) return JSON.stringify(errorMessage);
  }
  return undefined;
}

function isHistoryCompleted(history: Record<string, unknown>) {
  if (!isRecord(history.status)) return false;
  if (history.status.completed === true) return true;
  const statusText = stringifyOptional(history.status.status_str);
  return Boolean(statusText && /success|completed/i.test(statusText));
}

function filePriority(file: ComfyUIOutputFile) {
  if (isVideoFile(file.filename)) return 0;
  if (file.kind === "videos") return 1;
  if (file.kind === "gifs") return 2;
  return 3;
}

function isVideoFile(filename: string) {
  return /\.(mp4|webm|mov|m4v|gif)$/i.test(filename);
}

function ensureInputs(node: Record<string, unknown>) {
  if (!isRecord(node.inputs)) node.inputs = {};
  return node.inputs as Record<string, unknown>;
}

function resolveSeed(seed: string) {
  const numeric = Number(seed);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  return Math.floor(Math.random() * 2 ** 32);
}

function normalizePositiveNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function createClientId() {
  return `videogen_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function stringifyOptional(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberOptional(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isNonEmptyObject(value: unknown) {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
