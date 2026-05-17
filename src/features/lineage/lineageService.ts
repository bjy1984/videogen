import { createId } from "../../services/id";
import type { ComposeReviewReport } from "../compose/composeReview";
import type { ComposeTimeline, UsageChange } from "../compose/composeTypes";
import type { MaterialBucket, RemixAssetTags } from "../remix/remixTypes";
import type { FinalVideoReviewSnapshot, FinalVideoRun, OperationFeedback } from "./lineageTypes";

export function createFinalVideoRun(input: {
  projectId: string;
  outputName: string;
  fileName: string;
  timeline: ComposeTimeline;
  buckets: MaterialBucket[];
  usageChanges: UsageChange[];
  review?: ComposeReviewReport;
}) {
  const assetById = new Map(input.buckets.flatMap((bucket) => bucket.assets.map((asset) => [asset.id, asset])));
  const usageByAssetId = new Map(input.usageChanges.map((change) => [change.assetId, change]));
  const clips = input.timeline.clips.map((clip) => {
    const asset = assetById.get(clip.assetId);
    const usage = usageByAssetId.get(clip.assetId);
    return {
      timelineClipId: clip.id,
      order: clip.order,
      role: clip.role,
      title: clip.title,
      bucketId: clip.bucketId,
      bucketLabel: clip.bucketLabel,
      sourceSegmentId: clip.sourceSegmentId,
      sourceRange: clip.tags.sourceRange,
      remixAssetId: clip.assetId,
      providerId: clip.providerId,
      scriptText: clip.scriptText,
      subtitleText: clip.subtitleText ?? clip.scriptText,
      overlayText: clip.overlayText ?? "",
      prompt: clip.prompt,
      duration: clip.duration,
      generationJobId: asset?.generationJobId,
      promptHash: clip.tags.promptHash,
      tags: clip.tags,
      selectionTrace: clip.selectionTrace,
      usageBeforeExport: usage?.before ?? asset?.usage.usedCount ?? 0,
      usageAfterExport: usage?.after ?? asset?.usage.usedCount ?? 0
    };
  });

  return {
    id: createId("run"),
    projectId: input.projectId,
    outputName: input.outputName,
    createdAt: new Date().toISOString(),
    recipeId: input.timeline.recipeId,
    randomSeed: input.timeline.randomSeed,
    clips,
    output: {
      format: "jianying-draft",
      fileName: input.fileName,
      duration: input.timeline.totalDuration
    },
    review: input.review ? serializeReview(input.review) : undefined,
    tags: aggregateTags(clips.map((clip) => clip.tags))
  } satisfies FinalVideoRun;
}

export function mergeRunFeedback(run: FinalVideoRun, feedback: Partial<OperationFeedback>): FinalVideoRun {
  return {
    ...run,
    feedback: {
      platform: feedback.platform ?? run.feedback?.platform ?? "douyin",
      campaignId: feedback.campaignId ?? run.feedback?.campaignId ?? "",
      externalCreativeId: feedback.externalCreativeId ?? run.feedback?.externalCreativeId ?? "",
      views: normalizeMetric(feedback.views ?? run.feedback?.views),
      completionRate: normalizeRate(feedback.completionRate ?? run.feedback?.completionRate),
      clickThroughRate: normalizeRate(feedback.clickThroughRate ?? run.feedback?.clickThroughRate),
      conversionRate: normalizeRate(feedback.conversionRate ?? run.feedback?.conversionRate),
      spend: normalizeMetric(feedback.spend ?? run.feedback?.spend),
      gmv: normalizeMetric(feedback.gmv ?? run.feedback?.gmv),
      roi: normalizeMetric(feedback.roi ?? run.feedback?.roi),
      notes: feedback.notes ?? run.feedback?.notes ?? "",
      updatedAt: new Date().toISOString()
    }
  };
}

export function mergeFinalRunsById(current: FinalVideoRun[], incoming: FinalVideoRun[]) {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    byId.set(run.id, {
      ...byId.get(run.id),
      ...run,
      feedback: run.feedback ?? byId.get(run.id)?.feedback
    });
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function aggregateTags(tagsList: RemixAssetTags[]) {
  const result: Record<string, string[]> = {};
  for (const tags of tagsList) {
    for (const [key, value] of Object.entries(tags) as Array<[string, unknown]>) {
      if (value === undefined || value === null || key === "custom") continue;
      const values = Array.isArray(value) ? value : [String(value)];
      result[key] = Array.from(new Set([...(result[key] ?? []), ...values]));
    }
  }
  return result;
}

function serializeReview(review: ComposeReviewReport): FinalVideoReviewSnapshot {
  return {
    score: review.score,
    readiness: review.readiness,
    counts: review.counts,
    issues: review.issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      clipId: issue.clipId,
      clipTitle: issue.clipTitle,
      field: issue.field,
      message: issue.message,
      suggestion: issue.suggestion
    }))
  };
}

function normalizeMetric(value?: number) {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function normalizeRate(value?: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Number(value)));
}
