import { createId } from "../../services/id";
import type { MaterialBucket, RemixAsset } from "../remix/remixTypes";
import type { ComposeTimeline, TimelineClip, UsageChange } from "./composeTypes";

export function assembleTimelineFromBuckets(input: {
  buckets: MaterialBucket[];
  bucketSequence?: string[];
  randomSeed?: string;
}) {
  const usableBuckets = input.bucketSequence?.length
    ? input.bucketSequence.map((id) => input.buckets.find((bucket) => bucket.id === id)).filter(isPresent)
    : input.buckets.filter((bucket) => bucket.assets.length > 0);

  if (!usableBuckets.length) {
    throw new Error("素材桶为空。请先生成二创素材。");
  }

  const seed = input.randomSeed || createId("seed");
  const random = createSeededRandom(seed);
  const clips: TimelineClip[] = usableBuckets.map((bucket, index) => {
    if (bucket.disabled) {
      throw new Error(`素材桶「${bucket.label}」已禁用，无法参与组装。`);
    }
    const asset = selectAsset(bucket.assets, random);
    if (!asset) {
      throw new Error(`素材桶「${bucket.label}」没有可用片段，请补充素材或调整最大使用次数。`);
    }
    return clipFromAsset(asset, bucket, index + 1, {
      action: "assembled",
      seed,
      updatedAt: new Date().toISOString()
    });
  });

  return {
    id: createId("timeline"),
    recipeId: createId("recipe"),
    randomSeed: seed,
    createdAt: new Date().toISOString(),
    selectionPolicy: "least-used",
    clips,
    totalDuration: clips.reduce((total, clip) => total + clip.duration, 0)
  } satisfies ComposeTimeline;
}

export function rerollTimelineClipFromBuckets(input: {
  timeline: ComposeTimeline;
  buckets: MaterialBucket[];
  clipId: string;
  randomSeed?: string;
}) {
  const currentClip = input.timeline.clips.find((clip) => clip.id === input.clipId);
  if (!currentClip) {
    throw new Error("未找到要重抽的时间线片段。");
  }
  const bucket = input.buckets.find((item) => item.id === currentClip.bucketId);
  if (!bucket) {
    throw new Error(`素材桶「${currentClip.bucketLabel}」不存在，无法重抽。`);
  }
  if (bucket.disabled) {
    throw new Error(`素材桶「${bucket.label}」已禁用，无法重抽。`);
  }
  const seed = input.randomSeed || createId("reroll_seed");
  const replacement = selectAsset(bucket.assets, createSeededRandom(seed), new Set([currentClip.assetId]));
  if (!replacement) {
    throw new Error(`素材桶「${bucket.label}」没有其他可用片段，请补素材、启用片段或调高最大使用次数。`);
  }
  const clips = input.timeline.clips.map((clip) =>
    clip.id === input.clipId
      ? clipFromAsset(replacement, bucket, clip.order, {
          action: "rerolled",
          seed,
          previousClipId: clip.id,
          previousAssetId: clip.assetId,
          updatedAt: new Date().toISOString()
        })
      : clip
  );
  return {
    ...input.timeline,
    randomSeed: seed,
    clips,
    totalDuration: clips.reduce((total, clip) => total + clip.duration, 0)
  } satisfies ComposeTimeline;
}

export function moveTimelineClip(input: {
  timeline: ComposeTimeline;
  clipId: string;
  direction: -1 | 1;
}) {
  const index = input.timeline.clips.findIndex((clip) => clip.id === input.clipId);
  const target = index + input.direction;
  if (index < 0 || target < 0 || target >= input.timeline.clips.length) {
    return input.timeline;
  }
  const clips = [...input.timeline.clips];
  const [clip] = clips.splice(index, 1);
  clips.splice(target, 0, clip);
  return {
    ...input.timeline,
    clips: clips.map((item, itemIndex) => ({
      ...item,
      order: itemIndex + 1
    }))
  } satisfies ComposeTimeline;
}

export function commitTimelineUsage(buckets: MaterialBucket[], timeline: ComposeTimeline) {
  const clipAssetIds = new Set(timeline.clips.map((clip) => clip.assetId));
  const changes: UsageChange[] = [];
  const nextBuckets = buckets.map((bucket) => ({
    ...bucket,
    assets: bucket.assets.map((asset) => {
      if (!clipAssetIds.has(asset.id)) return asset;
      const before = asset.usage.usedCount;
      const after = before + 1;
      changes.push({
        assetId: asset.id,
        before,
        after,
        maxUses: asset.usage.maxUses
      });
      return {
        ...asset,
        usage: {
          ...asset.usage,
          usedCount: after
        }
      };
    })
  }));
  return { buckets: nextBuckets, changes };
}

export function serializeTimeline(timeline: ComposeTimeline | null) {
  if (!timeline) return null;
  return {
    ...timeline,
    clips: timeline.clips.map(({ sourceFile, ...clip }) => clip)
  };
}

function clipFromAsset(
  asset: RemixAsset,
  bucket: MaterialBucket,
  order: number,
  selectionTrace?: TimelineClip["selectionTrace"]
): TimelineClip {
  return {
    id: createId("clip"),
    order,
    bucketId: bucket.id,
    bucketLabel: bucket.label,
    assetId: asset.id,
    sourceSegmentId: asset.sourceSegmentId,
    role: asset.role,
    title: asset.title,
    scriptText: asset.scriptText,
    subtitleText: asset.subtitleText,
    overlayText: asset.overlayText,
    prompt: asset.prompt,
    duration: asset.duration,
    providerId: String(asset.providerId),
    tags: asset.tags,
    selectionTrace,
    videoUrl: asset.videoUrl,
    sourceFile: asset.sourceFile
  };
}

function selectAsset(assets: RemixAsset[], random: () => number, excludedAssetIds = new Set<string>()) {
  const available = assets.filter(
    (asset) =>
      !excludedAssetIds.has(asset.id) &&
      !asset.disabled &&
      asset.status === "ready" &&
      asset.operationState !== "rejected" &&
      asset.usage.usedCount < asset.usage.maxUses
  );
  if (!available.length) return null;
  const minUsed = Math.min(...available.map((asset) => asset.usage.usedCount));
  const leastUsed = available.filter((asset) => asset.usage.usedCount === minUsed);
  return weightedPick(leastUsed, random);
}

function weightedPick(assets: RemixAsset[], random: () => number) {
  const totalWeight = assets.reduce((total, asset) => total + operationWeight(asset), 0);
  let cursor = random() * totalWeight;
  for (const asset of assets) {
    cursor -= operationWeight(asset);
    if (cursor <= 0) return asset;
  }
  return assets[assets.length - 1];
}

function operationWeight(asset: RemixAsset) {
  if (asset.operationState === "winning") return 3;
  if (asset.operationState === "fatigued") return 0.5;
  return 1;
}

function createSeededRandom(seed: string) {
  let state = hashSeed(seed);
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function hashSeed(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isPresent<T>(value: T | undefined): value is T {
  return Boolean(value);
}
