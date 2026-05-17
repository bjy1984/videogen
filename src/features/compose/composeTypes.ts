import type { RemixAssetTags } from "../remix/remixTypes";

export interface TimelineClipSelectionTrace {
  action: "assembled" | "rerolled";
  seed: string;
  previousClipId?: string;
  previousAssetId?: string;
  updatedAt: string;
}

export interface TimelineClip {
  id: string;
  order: number;
  bucketId: string;
  bucketLabel: string;
  assetId: string;
  sourceSegmentId: string;
  role: string;
  title: string;
  scriptText: string;
  subtitleText?: string;
  overlayText?: string;
  prompt: string;
  duration: number;
  providerId: string;
  tags: RemixAssetTags;
  selectionTrace?: TimelineClipSelectionTrace;
  videoUrl?: string;
  sourceFile?: File;
}

export interface ComposeTimeline {
  id: string;
  recipeId: string;
  randomSeed: string;
  createdAt: string;
  selectionPolicy: "least-used";
  clips: TimelineClip[];
  totalDuration: number;
}

export interface UsageChange {
  assetId: string;
  before: number;
  after: number;
  maxUses: number;
}
