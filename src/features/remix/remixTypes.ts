import type { Provider } from "../../types";

export type StandardBucketRole = "hook" | "pain" | "usp" | "trust" | "cta";
export type BucketRole = StandardBucketRole | string;
export type BucketSelectionPolicy = "random" | "least-used" | "weighted";
export type RemixAction = "keep" | "regenerate" | "replace" | "uploadRequired";
export type RemixAssetStatus = "idle" | "generating" | "ready" | "failed";
export type OperationDecisionState = "untested" | "winning" | "fatigued" | "rejected";

export interface RemixAssetTags {
  narrativeRole: BucketRole;
  sourceRange: string;
  topicType?: string;
  materialType?: string;
  targetAudience?: string;
  visualStyle?: string;
  providerId?: Provider | string;
  promptHash?: string;
  custom?: Record<string, string[]>;
}

export interface RemixAssetUsage {
  usedCount: number;
  maxUses: number;
}

export interface RemixAssetProviderTrace {
  localJobId?: string;
  remoteJobId?: string;
  model?: string;
  status?: string;
  error?: string;
  resultLastFrameUrl?: string;
  localAssetUrl?: string;
  localAssetPath?: string;
  originalVideoUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RemixAsset {
  id: string;
  sourceSegmentId: string;
  sourceVideoId?: string;
  bucketId: string;
  role: BucketRole;
  title: string;
  scriptText: string;
  subtitleText?: string;
  overlayText?: string;
  prompt: string;
  duration: number;
  providerId: Provider | string;
  status: RemixAssetStatus;
  operationState?: OperationDecisionState;
  disabled?: boolean;
  tags: RemixAssetTags;
  usage: RemixAssetUsage;
  createdAt: string;
  generationJobId?: string;
  providerTrace?: RemixAssetProviderTrace;
  videoUrl?: string;
  sourceFile?: File;
  referenceImageUrl?: string;
  weight?: number;
}

export interface MaterialBucket {
  id: string;
  role: BucketRole;
  label: string;
  isCustom: boolean;
  disabled?: boolean;
  selectionPolicy: BucketSelectionPolicy;
  assets: RemixAsset[];
}

export interface RemixPlanItem {
  id: string;
  segmentId: string;
  bucketId: string;
  role: BucketRole;
  action: RemixAction;
  prompt: string;
  duration: number;
  reason: string;
  tags: RemixAssetTags;
}

export interface RemixPlan {
  id: string;
  createdAt: string;
  defaultMaxUses: number;
  bucketSequence: string[];
  items: RemixPlanItem[];
}
