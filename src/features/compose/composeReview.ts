import type { MaterialBucket, RemixAsset } from "../remix/remixTypes";
import type { ComposeTimeline, TimelineClip } from "./composeTypes";

export type ComposeReviewSeverity = "error" | "warning" | "info";
export type ComposeReadiness = "blocked" | "needs-work" | "ready";

export interface ComposeReviewIssue {
  id: string;
  severity: ComposeReviewSeverity;
  clipId?: string;
  clipTitle?: string;
  field: "timeline" | "asset" | "text" | "source" | "media" | "usage";
  message: string;
  suggestion: string;
}

export interface ComposeReviewReport {
  score: number;
  readiness: ComposeReadiness;
  issues: ComposeReviewIssue[];
  counts: Record<ComposeReviewSeverity, number>;
  clipCount: number;
  totalDuration: number;
}

export function buildComposeReview(timeline: ComposeTimeline | null, buckets: MaterialBucket[]): ComposeReviewReport {
  const issues: ComposeReviewIssue[] = [];
  const assetIndex = new Map(buckets.flatMap((bucket) => bucket.assets.map((asset) => [asset.id, asset] as const)));

  if (!timeline) {
    issues.push({
      id: "timeline.missing",
      severity: "error",
      field: "timeline",
      message: "尚未组装合成时间线。",
      suggestion: "先从素材桶随机组装时间线，再做导出前审核。"
    });
  } else if (!timeline.clips.length) {
    issues.push({
      id: "timeline.empty",
      severity: "error",
      field: "timeline",
      message: "时间线没有片段。",
      suggestion: "补充素材桶片段后重新组装。"
    });
  }

  const seenAssets = new Set<string>();
  for (const clip of timeline?.clips ?? []) {
    auditClip(clip, assetIndex.get(clip.assetId), seenAssets, issues);
  }

  const counts = countIssues(issues);
  return {
    score: Math.max(0, 100 - counts.error * 22 - counts.warning * 7 - counts.info * 2),
    readiness: counts.error ? "blocked" : counts.warning ? "needs-work" : "ready",
    issues,
    counts,
    clipCount: timeline?.clips.length ?? 0,
    totalDuration: timeline?.totalDuration ?? 0
  };
}

function auditClip(
  clip: TimelineClip,
  asset: RemixAsset | undefined,
  seenAssets: Set<string>,
  issues: ComposeReviewIssue[]
) {
  const prefix = `clip.${clip.id}`;
  if (!Number.isFinite(clip.duration) || clip.duration < 1) {
    issues.push(createIssue(prefix, "duration", "error", clip, "片段时长无效。", "把片段时长调整到至少 1 秒。", "timeline"));
  }
  if (!clip.scriptText.trim()) {
    issues.push(createIssue(prefix, "script-empty", "error", clip, "脚本文案为空。", "补充脚本文案，避免导出后丢失口播溯源。", "text"));
  }
  if (!(clip.subtitleText || clip.scriptText).trim()) {
    issues.push(createIssue(prefix, "subtitle-empty", "warning", clip, "字幕文案为空。", "补充字幕或确认该段不需要字幕。", "text"));
  }
  if ((clip.overlayText || "").trim().length > 18) {
    issues.push(createIssue(prefix, "overlay-long", "info", clip, "贴片文案偏长。", "贴片建议控制在 4-12 个字。", "text"));
  }
  if (!clip.videoUrl && !clip.sourceFile) {
    issues.push(createIssue(prefix, "media-missing", "warning", clip, "没有真实视频文件或可拉取素材 URL。", "本地 mock 可导出占位文件；正式投放前需要补齐真实素材。", "media"));
  }
  if (!clip.assetId || !clip.sourceSegmentId || !clip.bucketId) {
    issues.push(createIssue(prefix, "source-id-missing", "error", clip, "片段溯源 ID 不完整。", "重新从素材桶组装时间线，确保 assetId、sourceSegmentId 和 bucketId 完整。", "source"));
  }
  if (!clip.tags.sourceRange?.trim()) {
    issues.push(createIssue(prefix, "source-range-missing", "warning", clip, "来源时间范围为空。", "补充来源片段时间范围，方便运营复盘。", "source"));
  }
  if (!clip.tags.narrativeRole?.trim()) {
    issues.push(createIssue(prefix, "source-role-missing", "warning", clip, "来源叙事角色为空。", "补充 hook/pain/usp/trust/cta 或自定义 bucket 标签。", "source"));
  }
  if (!asset) {
    issues.push(createIssue(prefix, "asset-missing", "error", clip, "时间线引用的素材不在当前素材桶中。", "重新组装时间线，或恢复对应素材。", "asset"));
  } else {
    auditAssetForClip(clip, asset, prefix, issues);
  }
  if (seenAssets.has(clip.assetId)) {
    issues.push(createIssue(prefix, "asset-duplicated", "warning", clip, "同一个素材在当前时间线中被重复使用。", "如需严格去重，请重新组装或替换其中一个片段。", "usage"));
  }
  seenAssets.add(clip.assetId);
}

function auditAssetForClip(clip: TimelineClip, asset: RemixAsset, prefix: string, issues: ComposeReviewIssue[]) {
  if (asset.disabled) {
    issues.push(createIssue(prefix, "asset-disabled", "error", clip, "该片段对应素材已被禁用。", "启用素材或重新组装时间线。", "asset"));
  }
  if (asset.operationState === "rejected") {
    issues.push(createIssue(prefix, "asset-rejected", "error", clip, "该片段对应素材已被运营淘汰。", "替换为未淘汰素材后再导出。", "asset"));
  }
  if (asset.status !== "ready") {
    issues.push(createIssue(prefix, "asset-not-ready", "error", clip, "该片段对应素材未就绪。", "等待生成完成，或替换为 ready 素材。", "asset"));
  }
  if (asset.usage.usedCount >= asset.usage.maxUses) {
    issues.push(createIssue(
      prefix,
      "asset-depleted",
      "error",
      clip,
      `该片段使用次数已耗尽：${asset.usage.usedCount}/${asset.usage.maxUses}。`,
      "调高最大使用次数，或重新组装使用其他素材。",
      "usage"
    ));
  }
}

function createIssue(
  prefix: string,
  key: string,
  severity: ComposeReviewSeverity,
  clip: TimelineClip,
  message: string,
  suggestion: string,
  field: ComposeReviewIssue["field"]
): ComposeReviewIssue {
  return {
    id: `${prefix}.${key}`,
    severity,
    clipId: clip.id,
    clipTitle: clip.title,
    field,
    message,
    suggestion
  };
}

function countIssues(issues: ComposeReviewIssue[]) {
  return issues.reduce<Record<ComposeReviewSeverity, number>>(
    (counts, issue) => {
      counts[issue.severity] += 1;
      return counts;
    },
    { error: 0, warning: 0, info: 0 }
  );
}
