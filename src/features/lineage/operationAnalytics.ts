import type { FinalVideoRun } from "./lineageTypes";

export type OperationAggregateDimension = "asset" | "bucket" | "provider" | "promptHash";

export interface OperationAggregate {
  dimension: OperationAggregateDimension;
  key: string;
  label: string;
  sampleRuns: number;
  clipUses: number;
  totalViews: number;
  totalSpend: number;
  totalGmv: number;
  avgRoi: number;
  avgCompletionRate: number;
  avgClickThroughRate: number;
  avgConversionRate: number;
  runIds: string[];
}

export interface OperationAnalytics {
  asset: OperationAggregate[];
  bucket: OperationAggregate[];
  provider: OperationAggregate[];
  promptHash: OperationAggregate[];
}

export function buildOperationAnalytics(runs: FinalVideoRun[]): OperationAnalytics {
  const feedbackRuns = runs.filter((run) => run.feedback);
  return {
    asset: buildAggregates(feedbackRuns, "asset"),
    bucket: buildAggregates(feedbackRuns, "bucket"),
    provider: buildAggregates(feedbackRuns, "provider"),
    promptHash: buildAggregates(feedbackRuns, "promptHash")
  };
}

function buildAggregates(runs: FinalVideoRun[], dimension: OperationAggregateDimension) {
  const groups = new Map<string, AggregateAccumulator>();

  for (const run of runs) {
    if (!run.feedback) continue;
    const keysInRun = new Set<string>();
    for (const clip of run.clips) {
      const key = keyForDimension(run, clip, dimension);
      if (!key) continue;
      const current = groups.get(key) ?? createAccumulator(dimension, key, labelForDimension(clip, dimension));
      current.clipUses += 1;
      current.runIds.add(run.id);
      keysInRun.add(key);
      groups.set(key, current);
    }

    for (const key of keysInRun) {
      const current = groups.get(key);
      if (!current) continue;
      current.sampleRuns += 1;
      current.totalViews += run.feedback.views;
      current.totalSpend += run.feedback.spend;
      current.totalGmv += run.feedback.gmv;
      current.roiSum += run.feedback.roi;
      current.completionRateSum += run.feedback.completionRate;
      current.clickThroughRateSum += run.feedback.clickThroughRate;
      current.conversionRateSum += run.feedback.conversionRate;
    }
  }

  return Array.from(groups.values())
    .map(toAggregate)
    .sort((a, b) => b.avgRoi - a.avgRoi || b.totalGmv - a.totalGmv || b.sampleRuns - a.sampleRuns);
}

function keyForDimension(
  _run: FinalVideoRun,
  clip: FinalVideoRun["clips"][number],
  dimension: OperationAggregateDimension
) {
  if (dimension === "asset") return clip.remixAssetId;
  if (dimension === "bucket") return clip.bucketId;
  if (dimension === "provider") return clip.providerId;
  if (dimension === "promptHash") return clip.promptHash || "";
  return "";
}

function labelForDimension(clip: FinalVideoRun["clips"][number], dimension: OperationAggregateDimension) {
  if (dimension === "asset") return `${clip.bucketLabel}/${clip.remixAssetId.slice(0, 12)}`;
  if (dimension === "bucket") return clip.bucketLabel;
  if (dimension === "provider") return clip.providerId;
  if (dimension === "promptHash") return clip.promptHash || "unknown";
  return "";
}

function createAccumulator(
  dimension: OperationAggregateDimension,
  key: string,
  label: string
): AggregateAccumulator {
  return {
    dimension,
    key,
    label,
    sampleRuns: 0,
    clipUses: 0,
    totalViews: 0,
    totalSpend: 0,
    totalGmv: 0,
    roiSum: 0,
    completionRateSum: 0,
    clickThroughRateSum: 0,
    conversionRateSum: 0,
    runIds: new Set<string>()
  };
}

function toAggregate(accumulator: AggregateAccumulator): OperationAggregate {
  const denominator = Math.max(1, accumulator.sampleRuns);
  return {
    dimension: accumulator.dimension,
    key: accumulator.key,
    label: accumulator.label,
    sampleRuns: accumulator.sampleRuns,
    clipUses: accumulator.clipUses,
    totalViews: accumulator.totalViews,
    totalSpend: accumulator.totalSpend,
    totalGmv: accumulator.totalGmv,
    avgRoi: round(accumulator.roiSum / denominator, 2),
    avgCompletionRate: round(accumulator.completionRateSum / denominator, 4),
    avgClickThroughRate: round(accumulator.clickThroughRateSum / denominator, 4),
    avgConversionRate: round(accumulator.conversionRateSum / denominator, 4),
    runIds: Array.from(accumulator.runIds)
  };
}

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

interface AggregateAccumulator {
  dimension: OperationAggregateDimension;
  key: string;
  label: string;
  sampleRuns: number;
  clipUses: number;
  totalViews: number;
  totalSpend: number;
  totalGmv: number;
  roiSum: number;
  completionRateSum: number;
  clickThroughRateSum: number;
  conversionRateSum: number;
  runIds: Set<string>;
}
