import type { GenerationJob, GenerationJobInput } from "../generationTypes";

export type ProviderCapability =
  | "text-to-video"
  | "image-to-video"
  | "video-to-video"
  | "reference-image"
  | "seed"
  | "negative-prompt"
  | "local-workflow";

export interface VideoGenerationProvider {
  id: string;
  label: string;
  capabilities: ProviderCapability[];
  createJob(input: GenerationJobInput): Promise<GenerationJob>;
  getJob(jobId: string): Promise<GenerationJob | null>;
  cancelJob?(jobId: string): Promise<void>;
}
