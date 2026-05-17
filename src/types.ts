export type StepKey = "input" | "report" | "script" | "mask-test" | "generate" | "compose";

export type Provider = "mock" | "comfyui" | "seedance" | "veo" | "kling" | "runway" | "pika";

export type SegmentStatus = "idle" | "queued" | "generating" | "done" | "failed";
export type SegmentBucketRole = "hook" | "pain" | "usp" | "trust" | "cta";
export type SegmentContentStatus = "draft" | "needs-review" | "approved" | "blocked";
export type BrandMaskTargetType = "logo" | "text" | "other";
export type BrandMaskEffect = "mosaic" | "blur" | "solid";
export type BrandMaskTrackMode = "static" | "interpolate" | "planar" | "optical-flow" | "manual";
export type BrandMaskFrameSeverity = "warning" | "error";

export interface BrandMaskRect {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrandMaskKeyframe {
  id: string;
  time: number;
  frameIndex?: number;
  source: "manual" | "auto" | "correction";
  shape: BrandMaskRect;
}

export interface BrandMaskFrameIssue {
  trackId: string;
  frameIndex: number;
  time: number;
  severity: BrandMaskFrameSeverity;
  reason: string;
  confidence?: number;
}

export interface BrandMaskTrack {
  id: string;
  label: string;
  targetType: BrandMaskTargetType;
  effect: BrandMaskEffect;
  trackMode: BrandMaskTrackMode;
  expandRatio: number;
  confidenceThreshold: number;
  keyframes: BrandMaskKeyframe[];
  reviewIssues?: BrandMaskFrameIssue[];
}

export interface VideoPreprocessTrace {
  id: string;
  kind: "face-mosaic" | "brand-mask";
  provider: "mock" | "local-bridge";
  status: "queued" | "running" | "done" | "failed" | "skipped";
  sourceVideoName?: string;
  sourceVideoUrl?: string;
  outputVideoUrl?: string;
  localPath?: string;
  publicAssetRequired?: boolean;
  summary?: {
    frameCount?: number;
    durationSec?: number;
    width?: number;
    height?: number;
    trackCount?: number;
    manualKeyframes?: number;
    correctedKeyframes?: number;
    warningFrames?: number;
    blockedFrames?: number;
    elapsedSec?: number;
  };
  issues?: BrandMaskFrameIssue[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisResult {
  basicInfo: {
    duration: number;
    topicType: string;
    materialType: string;
    targetAudience: string;
    priorityLevel: string;
  };
  narrative: {
    hook: NarrativeSection;
    painPoint: NarrativeSection;
    usp: NarrativeSection;
    trustProof: NarrativeSection;
    cta: NarrativeSection;
    completenessScore: string;
    rhythm: string;
    structureIssue: string;
    priority: string;
  };
  techniques: {
    visualStyle: string;
    pacing: string;
    subtitles: string;
    bgm: string;
    voice: string;
    specialTechniques: string;
    highlights: string[];
    problems: string[];
  };
  dataPrediction: {
    rows: Array<{
      metric: string;
      predicted: string;
      standard: string;
      passed: boolean;
    }>;
    coreProbability: "高" | "中" | "低";
    biggestShortboard: string;
    keyOptimization: string;
  };
  executionPlan: {
    rewriteSegments: ExecutionSegment[];
    replaceSegments: ReplaceSegment[];
    expansionPlans: {
      downCopy: string;
      downVisual: string;
      downBgm: string;
      upStrategy: string;
      upAudience: string;
    };
  };
  videoPrompts: {
    hookPrompt: string;
    painPointPrompt: string;
    uspPrompt: string;
    trustPrompt: string;
    ctaPrompt: string;
  };
  summary: string;
}

export interface NarrativeSection {
  range: string;
  actual: string;
  type: string;
  rating: "有效" | "一般" | "无效";
  reason: string;
  suggestions: string[];
}

export interface ExecutionSegment {
  range: string;
  content: string;
  reason: string;
  direction: string;
}

export interface ReplaceSegment {
  range: string;
  current: string;
  reason: string;
  replacement: string;
}

export interface VideoSegment {
  id: string;
  title: string;
  role: string;
  bucketRole?: SegmentBucketRole;
  contentStatus?: SegmentContentStatus;
  privacyEdits?: {
    faceMosaic?: boolean;
    faceMosaicPreprocess?: VideoPreprocessTrace;
    brandMasks?: BrandMaskTrack[];
    brandMaskPreprocess?: VideoPreprocessTrace;
    preprocesses?: VideoPreprocessTrace[];
  };
  duration: number;
  scriptText: string;
  subtitleText?: string;
  overlayText?: string;
  generationPrompt: string;
  provider: Provider;
  status: SegmentStatus;
  videoUrl?: string;
  sourceFile?: File;
  referenceImageUrl?: string;
  referenceImageFile?: File;
  isGeneratingImage?: boolean;
}

export interface GenerationOptions {
  provider: Provider;
  aspectRatio: "9:16" | "16:9" | "1:1";
  style: string;
  resolution: "720p" | "1080p";
  subtitles: boolean;
}
