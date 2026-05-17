import type { VideoGenerationProvider } from "./providerTypes";
import { mockVideoProvider } from "./mockProvider";
import { comfyuiVideoProvider } from "./comfyuiProvider";
import { seedanceVideoProvider } from "./seedanceProvider";

const providerRegistry = new Map<string, VideoGenerationProvider>([
  [mockVideoProvider.id, mockVideoProvider],
  [seedanceVideoProvider.id, seedanceVideoProvider],
  [comfyuiVideoProvider.id, comfyuiVideoProvider]
]);

export function getVideoGenerationProvider(providerId: string) {
  return providerRegistry.get(providerId) ?? mockVideoProvider;
}

export function getAvailableVideoGenerationProviders() {
  return Array.from(providerRegistry.values());
}
