import type { GenerationJobStatus } from "../generationTypes";

export const DEFAULT_COMFYUI_ENDPOINT = "http://127.0.0.1:8188";
export const DEFAULT_COMFYUI_BRIDGE_URL = "http://127.0.0.1:8790";
export const LTX2_HEAD_SWAP_COMFYUI_PRESET = {
  endpoint: "https://d1cab02add2640fb8905cb4ded4a8b8e88.gz13.chenyu.cn",
  workflowTemplateId: "workflow_ltx2_head_swap_drag_and_drop_v3.0.json",
  promptNodeId: "498",
  outputNodeId: "341",
  ollamaModel: "gemma4:e4b-it-q4_K_M"
};

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
  ollamaModel?: string;
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
  ollamaModel?: string;
  duration: number;
  aspectRatio: string;
  referenceImageUrl?: string;
  referenceImageName?: string;
  sourceVideoUrl?: string;
  sourceVideoName?: string;
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
  sourceVideoUrl?: string;
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
    ollamaModel: params.ollamaModel?.trim(),
    duration: input.duration,
    aspectRatio: input.aspectRatio,
    referenceImageUrl: input.referenceImageUrl,
    sourceVideoUrl: input.sourceVideoUrl,
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
  ollamaModel?: string;
  duration?: number;
  sourceVideoUrl?: string;
  referenceImageUrl?: string;
  clientId: string;
}) {
  return {
    prompt: prepareComfyUIWorkflow({
      workflow: input.workflow,
      prompt: input.prompt,
      promptNodeId: input.promptNodeId,
      seed: input.seed,
      steps: input.steps,
      cfgScale: input.cfgScale,
      ollamaModel: input.ollamaModel,
      duration: input.duration,
      sourceVideoUrl: input.sourceVideoUrl,
      referenceImageUrl: input.referenceImageUrl
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
  ollamaModel?: string;
  duration?: number;
  sourceVideoUrl?: string;
  referenceImageUrl?: string;
}) {
  if (!isRecord(input.workflow)) {
    throw new Error("ComfyUI workflow 必须是 API 格式 JSON 对象。");
  }
  const workflow = structuredClone(toComfyUIApiWorkflow(input.workflow)) as Record<string, unknown>;
  injectPrompt(workflow, input.promptNodeId, input.prompt);
  injectSamplerControls(workflow, input.seed, input.steps, input.cfgScale);
  if (input.ollamaModel?.trim()) injectOllamaModelControls(workflow, input.ollamaModel);
  if (input.duration !== undefined) injectDurationControls(workflow, input.duration);
  if (input.sourceVideoUrl) injectSourceVideoControls(workflow, input.sourceVideoUrl);
  if (input.referenceImageUrl) injectReferenceImageControls(workflow, input.referenceImageUrl);
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

const UI_WORKFLOW_WIDGET_INPUTS: Record<string, string[]> = {
  BasicScheduler: ["scheduler", "steps", "denoise"],
  CFGGuider: ["cfg"],
  CLIPTextEncode: ["text"],
  ComfySwitchNode: ["switch"],
  DualCLIPLoader: ["clip_name1", "clip_name2", "type", "device"],
  ImageConcanate: ["direction", "match_image_size"],
  ImageResizeKJv2: ["width", "height", "upscale_method", "keep_proportion", "pad_color", "crop_position", "divisible_by", "device"],
  KSamplerSelect: ["sampler_name"],
  LatentUpscaleModelLoader: ["model_name"],
  LoadAudio: ["audio"],
  LoadImage: ["image"],
  LoraLoader: ["lora_name", "strength_model", "strength_clip"],
  LoraLoaderModelOnly: ["lora_name", "strength_model"],
  LTXVAddGuideMulti: ["num_guides", "frame_idx_1", "strength_1"],
  ManualSigmas: ["sigmas"],
  OllamaVideoDescriber: [
    "model",
    "custom_model",
    "api_host",
    "timeout",
    "temperature",
    "top_k",
    "top_p",
    "repeat_penalty",
    "seed_number",
    "num_ctx",
    "max_tokens",
    "keep_model_alive",
    "frame_skip",
    "max_frames",
    "system_context",
    "prompt"
  ],
  PrimitiveFloat: ["value"],
  PrimitiveInt: ["value"],
  PrimitiveStringMultiline: ["value"],
  RandomNoise: ["noise_seed"],
  ReservedRegionFrameComposer: [
    "region_position",
    "region_size_px",
    "face_distribution",
    "interval_frames",
    "overflow_mode",
    "stack_direction",
    "face_scale_pct",
    "face_padding_px",
    "face_gap_px",
    "face_align_main",
    "face_align_cross",
    "chroma_r",
    "chroma_g",
    "chroma_b"
  ],
  SaveVideo: ["filename_prefix", "format", "codec"],
  SimpleCalculatorKJ: ["expression"],
  SolidMask: ["value", "width", "height"],
  TextGenerateLTX2Prompt: [
    "prompt",
    "max_length",
    "sampling_mode",
    "temperature",
    "top_k",
    "top_p",
    "min_p",
    "repetition_penalty",
    "seed",
    "presence_penalty",
    "thinking",
    "use_default_template"
  ],
  TrimAudioDuration: ["start_index", "duration"],
  UNETLoader: ["unet_name", "weight_dtype"],
  VAELoaderKJ: ["vae_name", "device", "weight_dtype"]
};

function toComfyUIApiWorkflow(workflow: unknown) {
  if (!isComfyUIFrontendWorkflow(workflow)) return workflow;

  const nodes = workflow.nodes.filter(isRecord);
  const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
  const links = new Map<string, { sourceId: string; sourceSlot: number }>();
  for (const link of workflow.links) {
    if (!Array.isArray(link) || link.length < 4) continue;
    links.set(String(link[0]), {
      sourceId: String(link[1]),
      sourceSlot: typeof link[2] === "number" ? link[2] : 0
    });
  }

  const primitiveConstants = new Map<string, unknown>();
  for (const node of nodes) {
    if (stringifyOptional(node.type) !== "PrimitiveNode") continue;
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    primitiveConstants.set(String(node.id), widgets[0]);
  }

  const setSources = new Map<string, unknown>();
  for (const node of nodes) {
    if (stringifyOptional(node.type) !== "SetNode") continue;
    const key = firstWidgetValue(node);
    const inputs = Array.isArray(node.inputs) ? node.inputs : [];
    const linkedInput = inputs.find((input) => isRecord(input) && input.link !== undefined && input.link !== null);
    if (!key || !isRecord(linkedInput)) continue;
    setSources.set(key, resolveUiLink(linkedInput.link, links, nodeById, primitiveConstants, setSources));
  }

  const apiWorkflow: Record<string, unknown> = {};
  for (const node of nodes) {
    const id = stringifyOptional(node.id) || String(node.id);
    const classType = stringifyOptional(node.type);
    if (!id || !classType || shouldSkipFrontendNode(node, classType)) continue;

    const inputs = buildFrontendNodeWidgetInputs(node, classType);
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
      if (!isRecord(input)) continue;
      const name = stringifyOptional(input.name);
      if (!name) continue;
      if (input.link !== undefined && input.link !== null) {
        const resolved = resolveUiLink(input.link, links, nodeById, primitiveConstants, setSources);
        if (resolved !== undefined) {
          inputs[name] = resolved;
        }
      }
    }

    if (classType === "ComfySwitchNode") normalizeSwitchInputs(inputs);
    if (classType === "PreviewAny" && !("source" in inputs)) continue;

    apiWorkflow[id] = {
      inputs,
      class_type: classType,
      _meta: {
        title: frontendNodeTitle(node)
      }
    };
  }

  return apiWorkflow;
}

function buildFrontendNodeWidgetInputs(node: Record<string, unknown>, classType: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  const widgets = node.widgets_values;
  if (isRecord(widgets)) {
    for (const [key, value] of Object.entries(widgets)) {
      if (key === "videopreview" || key.endsWith("UI")) continue;
      inputs[key] = value;
    }
    return inputs;
  }

  if (!Array.isArray(widgets)) return inputs;
  if (classType === "LTXVAddGuideMulti") return buildLtxvGuideWidgetInputs(widgets);

  const names = UI_WORKFLOW_WIDGET_INPUTS[classType] || [];
  names.forEach((name, index) => {
    if (index < widgets.length && widgets[index] !== undefined && widgets[index] !== null) {
      inputs[name] = widgets[index];
    }
  });
  return inputs;
}

function buildLtxvGuideWidgetInputs(widgets: unknown[]): Record<string, unknown> {
  const guideCount = Math.max(1, Math.floor(Number(widgets[0]) || 1));
  const inputs: Record<string, unknown> = { num_guides: String(guideCount) };
  for (let guideIndex = 1; guideIndex <= guideCount; guideIndex += 1) {
    const widgetIndex = 1 + (guideIndex - 1) * 2;
    const frameIdx = widgets[widgetIndex];
    const strength = widgets[widgetIndex + 1];
    if (frameIdx !== undefined && frameIdx !== null) inputs[`num_guides.frame_idx_${guideIndex}`] = frameIdx;
    if (strength !== undefined && strength !== null) inputs[`num_guides.strength_${guideIndex}`] = strength;
  }
  return inputs;
}

function shouldSkipFrontendNode(node: Record<string, unknown>, classType: string) {
  if (node.mode === 4) return true;
  return ["GetNode", "MarkdownNote", "Note", "PrimitiveNode", "RecordAudio", "SetNode"].includes(classType);
}

function resolveUiLink(
  linkId: unknown,
  links: Map<string, { sourceId: string; sourceSlot: number }>,
  nodeById: Map<string, Record<string, unknown>>,
  primitiveConstants: Map<string, unknown>,
  setSources: Map<string, unknown>
): unknown {
  const link = links.get(String(linkId));
  if (!link) return undefined;

  const sourceNode = nodeById.get(link.sourceId);
  const sourceType = stringifyOptional(sourceNode?.type);
  if (sourceType === "PrimitiveNode") return primitiveConstants.get(link.sourceId);
  if (sourceType === "GetNode") {
    const key = sourceNode ? firstWidgetValue(sourceNode) : "";
    return key ? setSources.get(key) : undefined;
  }
  if (sourceNode?.mode === 4) return resolveDisabledNodeBypass(sourceNode, links, nodeById, primitiveConstants, setSources);
  return [link.sourceId, link.sourceSlot];
}

function resolveDisabledNodeBypass(
  node: Record<string, unknown>,
  links: Map<string, { sourceId: string; sourceSlot: number }>,
  nodeById: Map<string, Record<string, unknown>>,
  primitiveConstants: Map<string, unknown>,
  setSources: Map<string, unknown>
) {
  const classType = stringifyOptional(node.type) || "";
  if (!["LoraLoader", "LoraLoaderModelOnly"].includes(classType)) return undefined;
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const modelInput = inputs.find((input) => isRecord(input) && input.name === "model" && input.link !== undefined && input.link !== null);
  return isRecord(modelInput) ? resolveUiLink(modelInput.link, links, nodeById, primitiveConstants, setSources) : undefined;
}

function normalizeSwitchInputs(inputs: Record<string, unknown>) {
  if (inputs.switch === true && inputs.on_true === undefined && inputs.on_false !== undefined) {
    inputs.on_true = inputs.on_false;
  }
  if (inputs.switch === false && inputs.on_false === undefined && inputs.on_true !== undefined) {
    inputs.on_false = inputs.on_true;
  }
  if (inputs.switch === false && inputs.on_true === undefined && inputs.on_false !== undefined) {
    inputs.on_true = inputs.on_false;
  }
  if (inputs.switch === true && inputs.on_false === undefined && inputs.on_true !== undefined) {
    inputs.on_false = inputs.on_true;
  }
}

function firstWidgetValue(node: Record<string, unknown>) {
  const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  return typeof widgets[0] === "string" ? widgets[0] : "";
}

function frontendNodeTitle(node: Record<string, unknown>) {
  const title = stringifyOptional(node.title);
  if (title) return title;
  if (isRecord(node.properties)) {
    return stringifyOptional(node.properties["Node name for S&R"]) || stringifyOptional(node.type) || "";
  }
  return stringifyOptional(node.type) || "";
}

function isComfyUIFrontendWorkflow(value: unknown): value is { nodes: unknown[]; links: unknown[] } {
  return isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.links);
}

function injectPrompt(workflow: Record<string, unknown>, promptNodeId: string, prompt: string) {
  const node = workflow[promptNodeId];
  if (!isRecord(node)) {
    throw new Error(`ComfyUI workflow 中找不到 Prompt Node：${promptNodeId}`);
  }
  const inputs = ensureInputs(node);
  if ("text" in inputs) inputs.text = prompt;
  else if ("value" in inputs) inputs.value = prompt;
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

function injectOllamaModelControls(workflow: Record<string, unknown>, model: string) {
  const normalizedModel = model.trim();
  if (!normalizedModel) return;
  for (const node of Object.values(workflow)) {
    if (!isRecord(node)) continue;
    const inputs = isRecord(node.inputs) ? node.inputs : undefined;
    if (!inputs) continue;
    const classType = stringifyOptional(node.class_type) || "";
    if (classType !== "OllamaVideoDescriber") continue;
    inputs.custom_model = normalizedModel;
  }
}

function injectDurationControls(workflow: Record<string, unknown>, duration: number) {
  const normalizedDuration = Math.max(0.5, Math.min(60, duration));
  for (const node of Object.values(workflow)) {
    if (!isRecord(node)) continue;
    const inputs = isRecord(node.inputs) ? node.inputs : undefined;
    if (!inputs) continue;
    const title = stringifyOptional(isRecord(node._meta) ? node._meta.title : undefined) || "";
    const classType = stringifyOptional(node.class_type) || "";
    if (/duration/i.test(title) && /Primitive(Float|Int)|easy (float|int)/i.test(classType) && typeof inputs.value === "number") {
      inputs.value = normalizedDuration;
    }
    if ("duration_seconds" in inputs && typeof inputs.duration_seconds === "number") inputs.duration_seconds = normalizedDuration;
    if ("seconds" in inputs && typeof inputs.seconds === "number") inputs.seconds = normalizedDuration;
  }
}

function injectSourceVideoControls(workflow: Record<string, unknown>, sourceVideoUrl: string) {
  const sourceKeys = ["video_url", "source_video", "sourceVideo", "input_video", "inputVideo"];
  for (const node of Object.values(workflow)) {
    if (!isRecord(node)) continue;
    const inputs = isRecord(node.inputs) ? node.inputs : undefined;
    if (!inputs) continue;
    const classType = stringifyOptional(node.class_type) || "";
    if (/load.*video|video.*load|VHS_LoadVideo/i.test(classType) && typeof inputs.video === "string") {
      inputs.video = sourceVideoUrl;
    }
    for (const key of sourceKeys) {
      if (key in inputs) inputs[key] = sourceVideoUrl;
    }
  }
}

function injectReferenceImageControls(workflow: Record<string, unknown>, referenceImageUrl: string) {
  const referenceKeys = ["reference_image", "referenceImage", "face_image", "faceImage", "identity_image", "identityImage"];
  for (const node of Object.values(workflow)) {
    if (!isRecord(node)) continue;
    const inputs = isRecord(node.inputs) ? node.inputs : undefined;
    if (!inputs) continue;
    const classType = stringifyOptional(node.class_type) || "";
    if (/load.*image|LoadImage/i.test(classType) && typeof inputs.image === "string") {
      inputs.image = referenceImageUrl;
    }
    for (const key of referenceKeys) {
      if (key in inputs) inputs[key] = referenceImageUrl;
    }
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
  const messages = history.status && isRecord(history.status) ? history.status.messages : undefined;
  if (Array.isArray(messages)) {
    const errorMessage = messages.find((message) => Array.isArray(message) && String(message[0]).includes("error"));
    if (Array.isArray(errorMessage) && isRecord(errorMessage[1])) {
      const nodeId = stringifyOptional(errorMessage[1].node_id);
      const nodeType = stringifyOptional(errorMessage[1].node_type);
      const exceptionType = stringifyOptional(errorMessage[1].exception_type);
      const exceptionMessage = stringifyOptional(errorMessage[1].exception_message);
      return [
        nodeId || nodeType ? `节点 ${nodeId || "-"} ${nodeType || ""}`.trim() : "",
        exceptionType,
        exceptionMessage
      ].filter(Boolean).join("：");
    }
    if (errorMessage) return JSON.stringify(errorMessage);
  }
  if (isRecord(history.status)) {
    const statusText = stringifyOptional(history.status.status_str);
    if (statusText && /error|failed/i.test(statusText)) return statusText;
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
  return value.replace(/[?#].*$/, "").replace(/\/+$/, "");
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
