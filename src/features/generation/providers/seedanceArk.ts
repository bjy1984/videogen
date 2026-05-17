import type { GenerationJobStatus } from "../generationTypes";

export const DEFAULT_SEEDANCE_BRIDGE_URL = "http://localhost:8788";
export const DEFAULT_SEEDANCE_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_SEEDANCE_MODEL = "doubao-seedance-2-0-260128";

export type SeedanceArkTaskStatus = "queued" | "running" | "succeeded" | "failed" | "expired" | "cancelled";

export interface SeedanceProviderParams {
  bridgeUrl?: string;
  endpoint?: string;
  model?: string;
  apiKeyEnvName?: string;
  defaultDuration?: number;
  resolution?: "720p" | "1080p";
  seed?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  returnLastFrame?: boolean;
}

export interface SeedanceArkContentText {
  type: "text";
  text: string;
}

export interface SeedanceArkContentImage {
  type: "image_url";
  image_url: {
    url: string;
  };
  role?: "first_frame" | "last_frame" | "reference_image";
}

export interface SeedanceArkContentVideo {
  type: "video_url";
  video_url: {
    url: string;
  };
  role?: "source_video" | "reference_video";
}

export type SeedanceArkContentItem = SeedanceArkContentText | SeedanceArkContentImage | SeedanceArkContentVideo;

export interface SeedanceCreateTaskRequest {
  model: string;
  content: SeedanceArkContentItem[];
  ratio: "9:16" | "16:9" | "1:1";
  resolution: "720p" | "1080p";
  duration: number;
  seed?: number;
  generate_audio?: boolean;
  watermark?: boolean;
  return_last_frame?: boolean;
}

export interface SeedanceCreateTaskBridgeRequest {
  endpoint: string;
  apiKeyEnvName: string;
  body: SeedanceCreateTaskRequest;
}

export interface SeedanceTaskResponse {
  id: string;
  model?: string;
  status?: SeedanceArkTaskStatus | string;
  content?: {
    video_url?: string;
    last_frame_url?: string;
  };
  error?: {
    code?: string;
    message?: string;
  } | null;
  created_at?: number;
  updated_at?: number;
  seed?: number;
  resolution?: string;
  ratio?: string;
  duration?: number;
  usage?: Record<string, unknown>;
  raw?: unknown;
}

export interface SeedanceSyncedAsset {
  projectId: string;
  assetId: string;
  fileName: string;
  localPath: string;
  localAssetUrl: string;
  sourceUrl: string;
  savedAt: string;
}

export interface SeedanceSyncAssetResponse {
  task: SeedanceTaskResponse;
  asset: SeedanceSyncedAsset;
}

export function buildSeedanceCreateTaskRequest(input: {
  prompt: string;
  aspectRatio: "9:16" | "16:9" | "1:1";
  duration: number;
  referenceImageUrl?: string;
  sourceVideoUrl?: string;
  params?: SeedanceProviderParams;
}): SeedanceCreateTaskBridgeRequest {
  const params = input.params ?? {};
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Seedance prompt 不能为空。");

  const content: SeedanceArkContentItem[] = [{ type: "text", text: prompt }];
  if (input.referenceImageUrl?.trim()) {
    content.push({
      type: "image_url",
      image_url: { url: input.referenceImageUrl.trim() },
      role: "reference_image"
    });
  }
  if (input.sourceVideoUrl?.trim()) {
    content.push({
      type: "video_url",
      video_url: { url: input.sourceVideoUrl.trim() },
      role: "source_video"
    });
  }

  const seed = parseSeed(params.seed);
  return {
    endpoint: params.endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL,
    apiKeyEnvName: params.apiKeyEnvName || "ARK_API_KEY",
    body: {
      model: params.model || DEFAULT_SEEDANCE_MODEL,
      content,
      ratio: input.aspectRatio,
      resolution: params.resolution || "1080p",
      duration: normalizeDuration(params.defaultDuration ?? input.duration),
      ...(seed === undefined ? {} : { seed }),
      ...(params.generateAudio === undefined ? {} : { generate_audio: params.generateAudio }),
      ...(params.watermark === undefined ? {} : { watermark: params.watermark }),
      ...(params.returnLastFrame === undefined ? {} : { return_last_frame: params.returnLastFrame })
    }
  };
}

export function buildSeedanceCreateUrl(endpoint: string) {
  const cleanEndpoint = stripTrailingSlash(endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL);
  return cleanEndpoint.endsWith("/contents/generations/tasks")
    ? cleanEndpoint
    : `${cleanEndpoint}/contents/generations/tasks`;
}

export function buildSeedanceTaskUrl(endpoint: string, taskId: string) {
  return `${buildSeedanceCreateUrl(endpoint)}/${encodeURIComponent(taskId)}`;
}

export function mapSeedanceTaskStatus(status?: string): GenerationJobStatus {
  if (status === "queued") return "queued";
  if (status === "running") return "generating";
  if (status === "succeeded") return "done";
  if (status === "failed" || status === "expired" || status === "cancelled") return "failed";
  return "generating";
}

export function extractSeedanceTaskError(task: SeedanceTaskResponse) {
  return task.error?.message || task.error?.code || undefined;
}

function normalizeDuration(duration: number) {
  if (!Number.isFinite(duration)) return 5;
  return Math.min(15, Math.max(4, Math.round(duration)));
}

function parseSeed(seed?: string) {
  if (!seed?.trim()) return undefined;
  const parsed = Number(seed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.floor(parsed);
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
