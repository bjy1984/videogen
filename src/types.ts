export type StepKey = "input" | "report" | "script" | "generate" | "compose";

export type Provider = "seedance" | "veo" | "kling" | "runway" | "pika";

export type SegmentStatus = "idle" | "queued" | "generating" | "done" | "failed";

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
  duration: number;
  scriptText: string;
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
