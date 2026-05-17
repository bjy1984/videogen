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

export async function createSeedanceBridgeTask(input: {
  bridgeUrl?: string;
  request: SeedanceCreateTaskBridgeRequest;
}) {
  return requestBridge<SeedanceTaskResponse>(input.bridgeUrl, "/seedance/tasks", {
    method: "POST",
    body: JSON.stringify(input.request)
  });
}

export async function createComfyUIBridgeTask(input: {
  bridgeUrl?: string;
  request: ComfyUICreateTaskBridgeRequest;
}) {
  return requestBridge<ComfyUITaskResponse>(input.bridgeUrl || FALLBACK_COMFYUI_BRIDGE_URL, "/comfyui/tasks", {
    method: "POST",
    body: JSON.stringify(input.request)
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
      })
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
        outputNodeId: input.outputNodeId
      })
    }
  );
}

async function requestBridge<T>(bridgeUrl = DEFAULT_SEEDANCE_BRIDGE_URL, path: string, init: RequestInit = {}) {
  const response = await fetch(`${stripTrailingSlash(bridgeUrl)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers
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
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
