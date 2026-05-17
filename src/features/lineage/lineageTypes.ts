import type { TimelineClipSelectionTrace } from "../compose/composeTypes";
import type { RemixAssetTags } from "../remix/remixTypes";

export interface FinalVideoClipTrace {
  timelineClipId: string;
  order: number;
  role: string;
  title: string;
  bucketId: string;
  bucketLabel: string;
  sourceSegmentId: string;
  sourceRange: string;
  remixAssetId: string;
  providerId: string;
  scriptText: string;
  subtitleText: string;
  overlayText: string;
  prompt: string;
  duration: number;
  generationJobId?: string;
  promptHash?: string;
  tags: RemixAssetTags;
  selectionTrace?: TimelineClipSelectionTrace;
  usageBeforeExport: number;
  usageAfterExport: number;
}

export interface FinalVideoReviewSnapshot {
  score: number;
  readiness: "blocked" | "needs-work" | "ready";
  counts: Record<"error" | "warning" | "info", number>;
  issues: Array<{
    id: string;
    severity: "error" | "warning" | "info";
    clipId?: string;
    clipTitle?: string;
    field: string;
    message: string;
    suggestion: string;
  }>;
}

export type OperationPlatform = "douyin" | "xiaohongshu" | "kuaishou" | "shipinhao" | "ad-platform" | "other";

export interface OperationFeedback {
  platform: OperationPlatform;
  campaignId: string;
  externalCreativeId: string;
  views: number;
  completionRate: number;
  clickThroughRate: number;
  conversionRate: number;
  spend: number;
  gmv: number;
  roi: number;
  notes: string;
  updatedAt: string;
}

export interface FinalVideoRun {
  id: string;
  projectId: string;
  outputName: string;
  createdAt: string;
  recipeId: string;
  randomSeed: string;
  clips: FinalVideoClipTrace[];
  output: {
    format: "jianying-draft" | "mp4" | "asset-package";
    fileName: string;
    duration: number;
  };
  review?: FinalVideoReviewSnapshot;
  tags: Record<string, string[]>;
  feedback?: OperationFeedback;
}
