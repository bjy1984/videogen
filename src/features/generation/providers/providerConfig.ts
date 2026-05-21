import {
  DEFAULT_COMFYUI_BRIDGE_URL,
  DEFAULT_COMFYUI_ENDPOINT,
  type ComfyUIProviderParams
} from "./comfyuiApi";
import {
  DEFAULT_SEEDANCE_ARK_BASE_URL,
  DEFAULT_SEEDANCE_BRIDGE_URL,
  DEFAULT_SEEDANCE_MODEL
} from "./seedanceArk";

export interface MockProviderConfig {
  latencyMs: number;
}

export interface ComfyUIProviderConfig extends Required<Omit<ComfyUIProviderParams, "workflowJson">> {
  workflowJson: string;
}

export interface SeedanceProviderConfig {
  bridgeUrl: string;
  endpoint: string;
  model: string;
  apiKeyEnvName: string;
  defaultDuration: number;
  resolution: "720p" | "1080p";
  seed: string;
  generateAudio: boolean;
  watermark: boolean;
  returnLastFrame: boolean;
}

export interface ProviderSettings {
  mock: MockProviderConfig;
  comfyui: ComfyUIProviderConfig;
  seedance: SeedanceProviderConfig;
}

export const defaultProviderSettings: ProviderSettings = {
  mock: {
    latencyMs: 900
  },
  comfyui: {
    bridgeUrl: DEFAULT_COMFYUI_BRIDGE_URL,
    endpoint: DEFAULT_COMFYUI_ENDPOINT,
    workflowTemplateId: "default-video-workflow",
    workflowJson: "",
    promptNodeId: "6",
    outputNodeId: "",
    seed: "-1",
    steps: 24,
    cfgScale: 7,
    ollamaModel: ""
  },
  seedance: {
    bridgeUrl: DEFAULT_SEEDANCE_BRIDGE_URL,
    endpoint: DEFAULT_SEEDANCE_ARK_BASE_URL,
    model: DEFAULT_SEEDANCE_MODEL,
    apiKeyEnvName: "ARK_API_KEY",
    defaultDuration: 5,
    resolution: "1080p",
    seed: "-1",
    generateAudio: false,
    watermark: false,
    returnLastFrame: false
  }
};

export function mergeProviderSettings(settings?: Partial<ProviderSettings>): ProviderSettings {
  const comfyui = { ...defaultProviderSettings.comfyui, ...settings?.comfyui };
  const seedance = { ...defaultProviderSettings.seedance, ...settings?.seedance };
  return {
    mock: { ...defaultProviderSettings.mock, ...settings?.mock },
    comfyui: {
      ...comfyui,
      bridgeUrl: normalizeSavedBridgeUrl(comfyui.bridgeUrl, DEFAULT_COMFYUI_BRIDGE_URL)
    },
    seedance: {
      ...seedance,
      bridgeUrl: normalizeSavedBridgeUrl(seedance.bridgeUrl, DEFAULT_SEEDANCE_BRIDGE_URL)
    }
  };
}

function normalizeSavedBridgeUrl(value: string, fallback: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "http://localhost:8788" || trimmed === "http://127.0.0.1:8788") {
    return fallback;
  }
  return trimmed;
}

export function providerParamsFor(providerId: string, settings: ProviderSettings): Record<string, unknown> {
  if (providerId === "comfyui") return { ...settings.comfyui };
  if (providerId === "seedance") return { ...settings.seedance };
  return { ...settings.mock };
}
