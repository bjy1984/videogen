export type MaterialTagType =
  | "hook"
  | "purchase_reason"
  | "product_shaping"
  | "conversion"
  | "product"
  | "face"
  | "other_image"
  | "custom";

export type MaterialTagSource = "manual" | "ai" | "import";

export interface MaterialTag {
  id: string;
  type: MaterialTagType;
  label: string;
  source: MaterialTagSource;
  createdAt: string;
}

export interface DepthPreprocessRecord {
  id: string;
  sourceClipId: string;
  lineageId: string;
  status: "queued" | "processing" | "done" | "failed";
  method?: "depth" | "grayscale";
  inputVideoUrl: string;
  outputVideoUrl?: string;
  depthVideoUrl?: string;
  provider: "mock" | "local-bridge" | "local" | "remote_gpu" | "comfyui";
  params: {
    resolution: "720p" | "1080p";
    fps: number;
    depthModel: string;
    inputSize?: number;
    letterbox?: boolean;
    edgeFilterStrength?: number;
    edgeFilterDiameter?: number;
  };
  cost: {
    elapsedSec: number;
    gpuSec?: number;
    estimatedCash?: number;
  };
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export type DepthAiProvider =
  | "seedance_api"
  | "jimeng_web"
  | "comfyui_remote_gpu"
  | "kling_web"
  | "gemini_web";

export interface AiGenerationCost {
  creditsUsed?: number;
  gpuSec?: number;
  queueWaitSec: number;
  generationSec: number;
  captureSec?: number;
  manualSec?: number;
  estimatedCash: number;
}

export interface VideoAiJob {
  id: string;
  sourceClipId: string;
  lineageId: string;
  inputAssetType: "original" | "depth_video" | "grayscale_video" | "ai_output";
  inputVideoUrl: string;
  provider: DepthAiProvider;
  status: "queued" | "uploading" | "generating" | "capturing" | "done" | "failed";
  prompt: string;
  outputVideoUrl?: string;
  outputThumbnailUrl?: string;
  remoteTaskId?: string;
  cost: AiGenerationCost;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface MaterialOutput {
  id: string;
  sourceClipId: string;
  lineageId: string;
  parentOutputId?: string;
  type: "original" | "depth_video" | "grayscale_video" | "ai_video";
  provider: string;
  videoUrl: string;
  jobId?: string;
  createdAt: string;
}

export interface ComposeRecipeStep {
  id: string;
  tagType: MaterialTagType;
  label: string;
  count: number;
  selectionPolicy: "manual" | "least_used" | "lowest_cost";
}

export interface DepthComposePlanItem {
  id: string;
  order: number;
  stepId: string;
  clipId: string;
  lineageId: string;
  title: string;
  tagLabel: string;
  videoUrl?: string;
  cost: number;
}

export interface MaterialClip {
  id: string;
  lineageId: string;
  sourceSegmentId?: string;
  title: string;
  description: string;
  duration: number;
  originalVideoUrl: string;
  sourceFileName?: string;
  sourceLocalPath?: string;
  sourceMimeType?: string;
  sourceSize?: number;
  sourceFile?: File;
  tags: MaterialTag[];
  customTags: string[];
  preprocess?: DepthPreprocessRecord;
  aiJobs: VideoAiJob[];
  outputs: MaterialOutput[];
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ImageLibraryCategory = "product" | "face" | "other";

export interface ImageMaterial {
  id: string;
  lineageId: string;
  title: string;
  description: string;
  imageUrl: string;
  sourceFileName?: string;
  sourceLocalPath?: string;
  sourceMimeType?: string;
  sourceSize?: number;
  category: ImageLibraryCategory;
  tags: MaterialTag[];
  customTags: string[];
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DepthWorkbenchState {
  clips: MaterialClip[];
  images: ImageMaterial[];
  recipe: ComposeRecipeStep[];
  composePlan: DepthComposePlanItem[];
}
