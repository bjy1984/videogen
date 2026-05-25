import type { GenerationJobStatus } from "../generationTypes";

export const DEFAULT_SEEDANCE_BRIDGE_URL = "http://127.0.0.1:8790";
export const DEFAULT_SEEDANCE_ARK_BASE_URL = "https://apicoco.com";
export const DEFAULT_SEEDANCE_MODEL = "xsdoubao/seedance2.0_fast_direct";

export interface SeedanceModelPricing {
  model: string;
  label: string;
  resolution: "720p" | "1080p";
  cnyPerSecond: number;
  supportsReferenceMedia: boolean;
}

export const SEEDANCE_MODEL_PRICING: SeedanceModelPricing[] = [
  {
    model: "xsdoubao/seedance2.0_fast_direct",
    label: "Seedance 2.0 Fast Direct",
    resolution: "720p",
    cnyPerSecond: 0.75,
    supportsReferenceMedia: false
  },
  {
    model: "xsdoubao/seedance2.0_direct",
    label: "Seedance 2.0 Direct",
    resolution: "720p",
    cnyPerSecond: 1.05,
    supportsReferenceMedia: false
  },
  {
    model: "xsdoubao/seedance2.0_fast_vision",
    label: "Seedance 2.0 Fast Vision",
    resolution: "720p",
    cnyPerSecond: 0.912,
    supportsReferenceMedia: true
  },
  {
    model: "xsdoubao/seedance2.0_vision",
    label: "Seedance 2.0 Vision",
    resolution: "720p",
    cnyPerSecond: 1.368,
    supportsReferenceMedia: true
  },
  {
    model: "xsdoubao/seedance2.0_vision",
    label: "Seedance 2.0 Vision",
    resolution: "1080p",
    cnyPerSecond: 2.28,
    supportsReferenceMedia: true
  }
];

export type SeedanceArkTaskStatus =
  | "queued"
  | "running"
  | "in_progress"
  | "processing"
  | "completed"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

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
  prompt: string;
  metadata: {
    ratio: "9:16" | "16:9" | "1:1";
    duration: number;
    resolution: "720p" | "1080p";
    image_files?: string[];
    video_files?: string[];
    audio_files?: string[];
    seed?: number;
    generate_audio?: boolean;
    watermark?: boolean;
    return_last_frame?: boolean;
  };
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
  progress?: number;
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
  referenceImageUrls?: string[];
  sourceVideoUrl?: string;
  params?: SeedanceProviderParams;
}): SeedanceCreateTaskBridgeRequest {
  const params = input.params ?? {};
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Seedance prompt 不能为空。");

  const imageFiles = uniqueNonEmpty([
    input.referenceImageUrl,
    ...(input.referenceImageUrls || [])
  ]);
  const videoFiles = uniqueNonEmpty([input.sourceVideoUrl]);

  const seed = parseSeed(params.seed);
  return {
    endpoint: params.endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL,
    apiKeyEnvName: params.apiKeyEnvName || "NEWAPI_API_KEY",
    body: {
      model: params.model || DEFAULT_SEEDANCE_MODEL,
      prompt,
      metadata: {
        ratio: input.aspectRatio,
        resolution: params.resolution || "720p",
        duration: normalizeDuration(params.defaultDuration ?? input.duration),
        ...(imageFiles.length ? { image_files: imageFiles } : {}),
        ...(videoFiles.length ? { video_files: videoFiles } : {}),
        ...(seed === undefined ? {} : { seed }),
        ...(params.generateAudio === undefined ? {} : { generate_audio: params.generateAudio }),
        ...(params.watermark === undefined ? {} : { watermark: params.watermark }),
        ...(params.returnLastFrame === undefined ? {} : { return_last_frame: params.returnLastFrame })
      }
    }
  };
}

export function buildSeedanceCreateUrl(endpoint: string) {
  const cleanEndpoint = stripTrailingSlash(endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL);
  return cleanEndpoint.endsWith("/v1/video/generations")
    ? cleanEndpoint
    : `${cleanEndpoint}/v1/video/generations`;
}

export function buildSeedanceTaskUrl(endpoint: string, taskId: string) {
  return `${buildSeedanceCreateUrl(endpoint)}/${encodeURIComponent(taskId)}`;
}

export function buildSeedanceContentUrl(endpoint: string, taskId: string) {
  const cleanEndpoint = stripTrailingSlash(endpoint || DEFAULT_SEEDANCE_ARK_BASE_URL);
  return `${cleanEndpoint}/v1/videos/${encodeURIComponent(taskId)}/content`;
}

export function mapSeedanceTaskStatus(status?: string): GenerationJobStatus {
  if (status === "queued") return "queued";
  if (status === "running" || status === "in_progress" || status === "processing") return "generating";
  if (status === "succeeded" || status === "completed") return "done";
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
  const integer = Math.floor(parsed);
  if (integer < 0 || integer > 4_294_967_295) return undefined;
  return integer;
}

function uniqueNonEmpty(items: Array<string | undefined>) {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
