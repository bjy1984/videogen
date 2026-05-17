import type { Provider } from "../../types";
import type { VideoPreprocessTrace } from "../../types";
import type { RemixAsset } from "../remix/remixTypes";

export type GenerationJobStatus = "queued" | "generating" | "done" | "failed";

export interface GenerationJobInput {
  segmentId: string;
  bucketId: string;
  providerId: Provider | string;
  prompt: string;
  duration: number;
  aspectRatio: "9:16" | "16:9" | "1:1";
  referenceImageUrl?: string;
  sourceVideoUrl?: string;
  sourceVideoLocalPath?: string;
  sourceVideoName?: string;
  preprocessingTrace?: VideoPreprocessTrace;
  providerParams?: Record<string, unknown>;
}

export interface GenerationJob {
  id: string;
  remoteJobId?: string;
  remoteStatus?: string;
  input: GenerationJobInput;
  status: GenerationJobStatus;
  createdAt: string;
  updatedAt: string;
  resultVideoUrl?: string;
  resultLastFrameUrl?: string;
  providerResponse?: unknown;
  asset?: RemixAsset;
  error?: string;
}
