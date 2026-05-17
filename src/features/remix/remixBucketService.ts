import { createId } from "../../services/id";
import type { AnalysisResult, GenerationOptions, VideoSegment } from "../../types";
import type { GenerationJob } from "../generation/generationTypes";
import type { OperationAnalytics } from "../lineage/operationAnalytics";
import type { MaterialBucket, OperationDecisionState, RemixAsset, StandardBucketRole } from "./remixTypes";

export const DEFAULT_MAX_USES = 3;

export const DEFAULT_BUCKETS: Array<{ id: StandardBucketRole; role: StandardBucketRole; label: string }> = [
  { id: "hook", role: "hook", label: "钩子" },
  { id: "pain", role: "pain", label: "痛点" },
  { id: "usp", role: "usp", label: "USP" },
  { id: "trust", role: "trust", label: "信任证明" },
  { id: "cta", role: "cta", label: "CTA尾段" }
];

const segmentRoleMap: Record<string, StandardBucketRole> = {
  hook: "hook",
  pain: "pain",
  usp: "usp",
  trust: "trust",
  cta: "cta"
};

export function ensureDefaultBuckets(buckets: MaterialBucket[] = []) {
  const existing = new Map(buckets.map((bucket) => [bucket.id, bucket]));
  const defaults = DEFAULT_BUCKETS.map((bucket) => {
    const current = existing.get(bucket.id);
    return current ?? createBucket(bucket.id, bucket.role, bucket.label, false);
  });
  const custom = buckets.filter((bucket) => !DEFAULT_BUCKETS.some((item) => item.id === bucket.id));
  return [...defaults, ...custom];
}

export function createCustomBucket(label: string) {
  const cleanLabel = label.trim() || "自定义素材";
  const id = createId("bucket_custom");
  return createBucket(id, cleanLabel.toLowerCase().replace(/\s+/g, "-"), cleanLabel, true);
}

export function createMockRemixAssets(input: {
  segments: VideoSegment[];
  analysisResult: AnalysisResult | null;
  options: GenerationOptions;
  sourceVideo?: File;
  sourcePreviewUrl: string;
  maxUses?: number;
  generationJobs?: GenerationJob[];
}) {
  const now = new Date().toISOString();
  const jobsBySegment = new Map(input.generationJobs?.map((job) => [job.input.segmentId, job]) ?? []);
  return input.segments.map((segment) => {
    const role = segment.bucketRole ?? segmentRoleMap[segment.id] ?? "hook";
    const promptHash = hashText(segment.generationPrompt);
    const job = jobsBySegment.get(segment.id);
    const assetStatus = getAssetStatus(job);
    const jobVideoUrl = job?.resultVideoUrl || job?.asset?.videoUrl;
    const asset: RemixAsset = {
      id: createId(`asset_${role}`),
      sourceSegmentId: segment.id,
      bucketId: role,
      role,
      title: `${segment.title} 二创素材`,
      scriptText: segment.scriptText,
      subtitleText: segment.subtitleText ?? segment.scriptText,
      overlayText: segment.overlayText,
      prompt: segment.generationPrompt,
      duration: segment.duration,
      providerId: input.options.provider,
      status: assetStatus,
      operationState: "untested",
      disabled: false,
      tags: {
        narrativeRole: role,
        sourceRange: segment.role,
        topicType: input.analysisResult?.basicInfo.topicType,
        materialType: input.analysisResult?.basicInfo.materialType,
        targetAudience: input.analysisResult?.basicInfo.targetAudience,
        visualStyle: input.analysisResult?.techniques.visualStyle,
        providerId: input.options.provider,
        promptHash,
        custom: {
          priority: [input.analysisResult?.basicInfo.priorityLevel ?? "unknown"],
          ...(job?.remoteJobId ? { remoteJobId: [job.remoteJobId] } : {}),
          ...(job?.remoteStatus ? { remoteStatus: [job.remoteStatus] } : {})
        }
      },
      usage: {
        usedCount: 0,
        maxUses: input.maxUses ?? DEFAULT_MAX_USES
      },
      createdAt: now,
      generationJobId: job?.id ?? createId("job_mock"),
      providerTrace: job
        ? {
            localJobId: job.id,
            remoteJobId: job.remoteJobId,
            model: String(job.input.providerParams?.model || job.input.providerParams?.workflowTemplateId || ""),
            status: job.remoteStatus || job.status,
            error: job.error,
            resultLastFrameUrl: job.resultLastFrameUrl,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt
          }
        : undefined,
      videoUrl: jobVideoUrl || (assetStatus === "ready" ? input.sourcePreviewUrl || segment.videoUrl : undefined),
      sourceFile: segment.sourceFile ?? input.sourceVideo,
      referenceImageUrl: segment.referenceImageUrl,
      weight: role === "cta" ? 1.2 : 1
    };
    return asset;
  });
}

export function updateAssetOperationState(
  buckets: MaterialBucket[],
  assetId: string,
  operationState: OperationDecisionState
) {
  return buckets.map((bucket) => ({
    ...bucket,
    assets: bucket.assets.map((asset) =>
      asset.id === assetId
        ? {
            ...asset,
            operationState
          }
        : asset
    )
  }));
}

export function applyOperationDecisionsToBuckets(buckets: MaterialBucket[], analytics: OperationAnalytics) {
  const statsByAssetId = new Map(analytics.asset.map((item) => [item.key, item]));
  return buckets.map((bucket) => ({
    ...bucket,
    assets: bucket.assets.map((asset) => ({
      ...asset,
      operationState: decideOperationState(statsByAssetId.get(asset.id))
    }))
  }));
}

export function mergeAssetsIntoBuckets(buckets: MaterialBucket[], assets: RemixAsset[]) {
  const next = ensureDefaultBuckets(buckets).map((bucket) => ({ ...bucket, assets: [...bucket.assets] }));
  for (const asset of assets) {
    const bucket = next.find((item) => item.id === asset.bucketId);
    if (!bucket) continue;
    bucket.assets = [asset, ...bucket.assets];
  }
  return next;
}

export function updateAssetMaxUses(buckets: MaterialBucket[], assetId: string, maxUses: number) {
  const safeMaxUses = Math.max(0, Math.floor(maxUses));
  return buckets.map((bucket) => ({
    ...bucket,
    assets: bucket.assets.map((asset) =>
      asset.id === assetId
        ? {
            ...asset,
            usage: {
              ...asset.usage,
              maxUses: safeMaxUses
            }
          }
        : asset
    )
  }));
}

export function toggleAssetDisabled(buckets: MaterialBucket[], assetId: string) {
  return buckets.map((bucket) => ({
    ...bucket,
    assets: bucket.assets.map((asset) =>
      asset.id === assetId
        ? {
            ...asset,
            disabled: !asset.disabled
          }
        : asset
    )
  }));
}

export function renameBucket(buckets: MaterialBucket[], bucketId: string, label: string) {
  const cleanLabel = label.trim();
  if (!cleanLabel) return buckets;
  return buckets.map((bucket) =>
    bucket.id === bucketId && bucket.isCustom
      ? {
          ...bucket,
          label: cleanLabel,
          role: cleanLabel.toLowerCase().replace(/\s+/g, "-")
        }
      : bucket
  );
}

export function deleteCustomBucket(buckets: MaterialBucket[], bucketId: string) {
  return buckets.filter((bucket) => bucket.id !== bucketId || !bucket.isCustom);
}

export function serializeBuckets(buckets: MaterialBucket[]) {
  return buckets.map((bucket) => ({
    ...bucket,
    assets: bucket.assets.map(({ sourceFile, ...asset }) => asset)
  }));
}

function createBucket(id: string, role: string, label: string, isCustom: boolean): MaterialBucket {
  return {
    id,
    role,
    label,
    isCustom,
    disabled: false,
    selectionPolicy: "least-used",
    assets: []
  };
}

function getAssetStatus(job?: GenerationJob): RemixAsset["status"] {
  if (!job) return "ready";
  if (job.status === "done") return "ready";
  if (job.status === "failed") return "failed";
  if (job.status === "queued" || job.status === "generating") return "generating";
  return "idle";
}

function decideOperationState(
  stats?: OperationAnalytics["asset"][number]
): OperationDecisionState {
  if (!stats) return "untested";
  if (stats.sampleRuns >= 2 && (stats.avgRoi < 1 || stats.avgCompletionRate < 0.2)) return "rejected";
  if (stats.sampleRuns >= 3 && stats.avgRoi < 1.5) return "fatigued";
  if (stats.avgRoi >= 2.5 && stats.avgCompletionRate >= 0.45) return "winning";
  return "untested";
}

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}
