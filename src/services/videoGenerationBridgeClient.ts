import type {
  ComfyUICreateTaskBridgeRequest,
  ComfyUISyncAssetResponse,
  ComfyUITaskResponse
} from "../features/generation/providers/comfyuiApi";
import {
  DEFAULT_COMFYUI_BRIDGE_URL as FALLBACK_COMFYUI_BRIDGE_URL,
  DEFAULT_COMFYUI_ENDPOINT as FALLBACK_COMFYUI_ENDPOINT
} from "../features/generation/providers/comfyuiApi";
import type {
  SeedanceCreateTaskBridgeRequest,
  SeedanceSyncAssetResponse,
  SeedanceTaskResponse
} from "../features/generation/providers/seedanceArk";
import { DEFAULT_SEEDANCE_BRIDGE_URL } from "../features/generation/providers/seedanceArk";
import type { BrandMaskTrack, BrandMaskTrackingEngine, FaceMosaicEffect, VideoPreprocessTrace } from "../types";

export interface VideoGenerationBridgeHealth {
  ok: boolean;
  service: string;
  port: number;
  assetBaseUrl?: string;
  seedance?: {
    endpoint: string;
    apiKeyEnvName: string;
    hasApiKey: boolean;
  };
  comfyui?: {
    endpoint: string;
    reachable: boolean;
    nagCfgGuiderAvailable?: boolean;
    nagCfgGuiderError?: string;
    error?: string;
  };
}

export class VideoGenerationBridgeError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "VideoGenerationBridgeError";
  }
}

export interface UploadedBridgeAsset {
  projectId: string;
  segmentId: string;
  kind: string;
  fileName: string;
  localPath: string;
  localAssetUrl: string;
  savedAt: string;
}

export async function uploadVideoGenerationBridgeAsset(input: {
  bridgeUrl?: string;
  projectId: string;
  segmentId: string;
  kind: string;
  file: File;
}) {
  const formData = new FormData();
  formData.set("projectId", input.projectId);
  formData.set("segmentId", input.segmentId);
  formData.set("kind", input.kind);
  formData.set("file", input.file, input.file.name || `${input.kind}.bin`);
  return requestBridgeForm<{ asset: UploadedBridgeAsset }>(
    input.bridgeUrl,
    "/assets/upload",
    formData,
    180_000
  );
}

export async function createSeedanceBridgeTask(input: {
  bridgeUrl?: string;
  request: SeedanceCreateTaskBridgeRequest;
}) {
  return requestBridge<SeedanceTaskResponse>(input.bridgeUrl, "/seedance/tasks", {
    method: "POST",
    body: JSON.stringify(input.request),
    timeoutMs: 45_000
  });
}

export async function createComfyUIBridgeTask(input: {
  bridgeUrl?: string;
  request: ComfyUICreateTaskBridgeRequest;
}) {
  return requestBridge<ComfyUITaskResponse>(input.bridgeUrl || FALLBACK_COMFYUI_BRIDGE_URL, "/comfyui/tasks", {
    method: "POST",
    body: JSON.stringify(input.request),
    timeoutMs: 240_000
  });
}

export async function checkVideoGenerationBridgeHealth(
  bridgeUrl?: string,
  apiKeyEnvName = "ARK_API_KEY",
  comfyEndpoint = FALLBACK_COMFYUI_ENDPOINT
) {
  const searchParams = new URLSearchParams({ apiKeyEnvName, comfyEndpoint });
  return requestBridge<VideoGenerationBridgeHealth>(bridgeUrl, `/health?${searchParams.toString()}`);
}

export async function preprocessFaceMosaicBridge(input: {
  bridgeUrl?: string;
  projectId: string;
  segmentId: string;
  sourceRange?: string;
  preview?: boolean;
  effect?: FaceMosaicEffect;
  strength?: number;
  video: File;
}) {
  const formData = new FormData();
  formData.set("projectId", input.projectId);
  formData.set("segmentId", input.segmentId);
  if (input.sourceRange) formData.set("sourceRange", input.sourceRange);
  if (input.preview !== undefined) formData.set("preview", input.preview ? "true" : "false");
  if (input.effect) formData.set("effect", input.effect);
  if (input.strength !== undefined) formData.set("strength", String(input.strength));
  formData.set("video", input.video, input.video.name || `${input.segmentId}.mp4`);
  return requestBridgeForm<{ trace: VideoPreprocessTrace }>(
    input.bridgeUrl,
    "/privacy/face-mosaic",
    formData,
    input.preview ? 180_000 : 600_000
  );
}

export async function preprocessBrandMaskBridge(input: {
  bridgeUrl?: string;
  projectId: string;
  segmentId: string;
  sourceRange?: string;
  video?: File;
  sourceLocalPath?: string;
  sourceVideoName?: string;
  blockOnRed?: boolean;
  trackingEngine?: BrandMaskTrackingEngine;
  tracks: BrandMaskTrack[];
}) {
  const formData = new FormData();
  formData.set("projectId", input.projectId);
  formData.set("segmentId", input.segmentId);
  if (input.sourceRange) formData.set("sourceRange", input.sourceRange);
  if (input.sourceLocalPath) formData.set("sourceLocalPath", input.sourceLocalPath);
  if (input.sourceVideoName) formData.set("sourceVideoName", input.sourceVideoName);
  if (input.blockOnRed !== undefined) formData.set("blockOnRed", input.blockOnRed ? "true" : "false");
  if (input.trackingEngine) formData.set("trackingEngine", input.trackingEngine);
  formData.set("tracks", JSON.stringify(input.tracks));
  if (input.video) formData.set("video", input.video, input.video.name || `${input.segmentId}.mp4`);
  const timeoutMs = brandMaskTimeoutMs(input.trackingEngine);
  return requestBridgeForm<{ trace: VideoPreprocessTrace }>(
    input.bridgeUrl,
    "/privacy/brand-mask",
    formData,
    timeoutMs
  );
}

function brandMaskTimeoutMs(engine?: BrandMaskTrackingEngine) {
  if (engine === "mask-tracking") return 1_200_000;
  if (engine === "track-anything" || engine === "mixformer") return 900_000;
  if (engine === "ddrnet") return 900_000;
  if (engine === "vittrack") return 600_000;
  if (engine === "homography") return 360_000;
  return 240_000;
}

export async function getSeedanceBridgeTask(input: {
  bridgeUrl?: string;
  endpoint: string;
  apiKeyEnvName: string;
  taskId: string;
}) {
  const searchParams = new URLSearchParams({
    endpoint: input.endpoint,
    apiKeyEnvName: input.apiKeyEnvName
  });
  return requestBridge<SeedanceTaskResponse>(
    input.bridgeUrl,
    `/seedance/tasks/${encodeURIComponent(input.taskId)}?${searchParams.toString()}`
  );
}

export async function getComfyUIBridgeTask(input: {
  bridgeUrl?: string;
  endpoint: string;
  taskId: string;
}) {
  const searchParams = new URLSearchParams({
    endpoint: input.endpoint
  });
  return requestBridge<ComfyUITaskResponse>(
    input.bridgeUrl || FALLBACK_COMFYUI_BRIDGE_URL,
    `/comfyui/tasks/${encodeURIComponent(input.taskId)}?${searchParams.toString()}`
  );
}

export async function syncSeedanceBridgeAsset(input: {
  bridgeUrl?: string;
  endpoint: string;
  apiKeyEnvName: string;
  taskId: string;
  projectId: string;
  assetId: string;
  sourceUrl?: string;
}) {
  return requestBridge<SeedanceSyncAssetResponse>(
    input.bridgeUrl,
    `/seedance/tasks/${encodeURIComponent(input.taskId)}/sync`,
    {
      method: "POST",
      body: JSON.stringify({
        endpoint: input.endpoint,
        apiKeyEnvName: input.apiKeyEnvName,
        projectId: input.projectId,
        assetId: input.assetId,
        sourceUrl: input.sourceUrl
      }),
      timeoutMs: 120_000
    }
  );
}

export async function syncComfyUIBridgeAsset(input: {
  bridgeUrl?: string;
  endpoint: string;
  taskId: string;
  projectId: string;
  assetId: string;
  outputNodeId?: string;
  targetDuration?: number;
}) {
  return requestBridge<ComfyUISyncAssetResponse>(
    input.bridgeUrl || FALLBACK_COMFYUI_BRIDGE_URL,
    `/comfyui/tasks/${encodeURIComponent(input.taskId)}/sync`,
    {
      method: "POST",
      body: JSON.stringify({
        endpoint: input.endpoint,
        projectId: input.projectId,
        assetId: input.assetId,
        outputNodeId: input.outputNodeId,
        targetDuration: input.targetDuration
      }),
      timeoutMs: 120_000
    }
  );
}

interface BridgeRequestInit extends RequestInit {
  timeoutMs?: number;
}

async function requestBridge<T>(bridgeUrl = DEFAULT_SEEDANCE_BRIDGE_URL, path: string, init: BridgeRequestInit = {}) {
  const timeoutMs = init.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, signal, ...fetchInit } = init;
  try {
    const response = await fetch(`${normalizeVideoGenerationBridgeUrl(bridgeUrl)}${path}`, {
      ...fetchInit,
      signal: signal ?? controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...fetchInit.headers
      }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new VideoGenerationBridgeError(
        payload?.error || payload?.message || `视频生成 Bridge 请求失败：${response.status}`,
        response.status
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new VideoGenerationBridgeError(`视频生成 Bridge 请求超时：${Math.round(timeoutMs / 1000)}秒未响应。`, 408);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function requestBridgeForm<T>(
  bridgeUrl = DEFAULT_SEEDANCE_BRIDGE_URL,
  path: string,
  body: FormData,
  timeoutMs = 120_000
) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeVideoGenerationBridgeUrl(bridgeUrl)}${path}`, {
      method: "POST",
      body,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new VideoGenerationBridgeError(
        payload?.error || payload?.message || `视频生成 Bridge 请求失败：${response.status}`,
        response.status
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new VideoGenerationBridgeError(`视频生成 Bridge 请求超时：${Math.round(timeoutMs / 1000)}秒未响应。`, 408);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function normalizeVideoGenerationBridgeUrl(bridgeUrl = DEFAULT_SEEDANCE_BRIDGE_URL) {
  const trimmed = bridgeUrl.trim();
  if (!trimmed || trimmed === "http://localhost:8788" || trimmed === "http://127.0.0.1:8788") {
    return stripTrailingSlash(DEFAULT_SEEDANCE_BRIDGE_URL);
  }
  return stripTrailingSlash(trimmed);
}
