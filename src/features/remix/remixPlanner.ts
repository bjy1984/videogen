import { createId } from "../../services/id";
import type { AnalysisResult, GenerationOptions, VideoSegment } from "../../types";
import { faceMosaicCustomTags } from "../script/privacyEdits";
import { DEFAULT_BUCKETS, DEFAULT_MAX_USES } from "./remixBucketService";
import type { RemixAction, RemixPlan, StandardBucketRole } from "./remixTypes";

const actionByRole: Record<StandardBucketRole, RemixAction> = {
  hook: "regenerate",
  pain: "replace",
  usp: "regenerate",
  trust: "replace",
  cta: "regenerate"
};

const reasonByRole: Record<StandardBucketRole, string> = {
  hook: "强化首帧冲击和停留理由。",
  pain: "替换为更具体的痛点场景，提升共鸣。",
  usp: "重绘卖点表达，降低理解成本。",
  trust: "补足证明素材，提升转化信任。",
  cta: "尾段重点二创，强化购物车指引、紧迫感和复述卖点。"
};

export function createRemixPlan(input: {
  analysisResult: AnalysisResult | null;
  segments: VideoSegment[];
  options: GenerationOptions;
  defaultMaxUses?: number;
}): RemixPlan {
  const now = new Date().toISOString();
  return {
    id: createId("remix_plan"),
    createdAt: now,
    defaultMaxUses: input.defaultMaxUses ?? DEFAULT_MAX_USES,
    bucketSequence: DEFAULT_BUCKETS.map((bucket) => bucket.id),
    items: input.segments.map((segment) => {
      const role = resolveRole(segment);
      return {
        id: createId(`remix_item_${role}`),
        segmentId: segment.id,
        bucketId: role,
        role,
        action: actionByRole[role],
        prompt: segment.generationPrompt,
        duration: segment.duration,
        reason: reasonByRole[role],
        tags: {
          narrativeRole: role,
          sourceRange: segment.role,
          topicType: input.analysisResult?.basicInfo.topicType,
          materialType: input.analysisResult?.basicInfo.materialType,
          targetAudience: input.analysisResult?.basicInfo.targetAudience,
          visualStyle: input.analysisResult?.techniques.visualStyle,
          providerId: input.options.provider,
          custom: faceMosaicCustomTags(segment)
        }
      };
    })
  };
}

function resolveRole(segment: VideoSegment): StandardBucketRole {
  if (segment.bucketRole) return segment.bucketRole;
  const segmentId = segment.id;
  if (segmentId === "pain" || segmentId === "usp" || segmentId === "trust" || segmentId === "cta") return segmentId;
  return "hook";
}
