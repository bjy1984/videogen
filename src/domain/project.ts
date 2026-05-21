import type { AnalysisResult, GenerationOptions, VideoSegment } from "../types";
import type { AnalysisSource } from "./analysisSource";
import type { GeminiBridgeTask } from "./geminiBridge";
import type { ComposeTimeline } from "../features/compose/composeTypes";
import type { ProviderSettings } from "../features/generation/providers/providerConfig";
import type { FinalVideoRun } from "../features/lineage/lineageTypes";
import type { MaterialBucket } from "../features/remix/remixTypes";
import type { ScriptRevision } from "../features/script/scriptRevision";
import type { DepthWorkbenchState } from "../features/depth-workbench/depthTypes";

export interface ProjectSnapshot {
  schemaVersion: 1;
  id: string;
  name: string;
  updatedAt: string;
  prompt: string;
  videoDuration: number;
  sourceVideoMeta?: {
    name: string;
    size: number;
    type: string;
  };
  analysisResult: AnalysisResult | null;
  analysisSource: AnalysisSource;
  rawGeminiResult: string;
  geminiBridgeUrl: string;
  geminiBridgeTask: GeminiBridgeTask | null;
  reportSection: string;
  options: GenerationOptions;
  providerSettings?: ProviderSettings;
  segments: VideoSegment[];
  scriptRevisions?: ScriptRevision[];
  materialBuckets?: MaterialBucket[];
  depthWorkbench?: DepthWorkbenchState;
  composeTimeline?: ComposeTimeline | null;
  finalVideoRuns?: FinalVideoRun[];
  composeStatus: "idle" | "running" | "done";
}
