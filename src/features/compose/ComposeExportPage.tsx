import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Download,
  FileVideo,
  Loader2,
  PackageOpen,
  RefreshCw,
  Scissors,
  Shuffle,
  Upload
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { segmentStatusLabel } from "../../domain/labels";
import type { VideoSegment } from "../../types";
import { buildOperationAnalytics, type OperationAggregate } from "../lineage/operationAnalytics";
import type { FinalVideoRun, OperationFeedback, OperationPlatform } from "../lineage/lineageTypes";
import type { MaterialBucket, OperationDecisionState } from "../remix/remixTypes";
import type { ComposeTimeline, TimelineClip } from "./composeTypes";
import { buildComposeReview, type ComposeReviewIssue, type ComposeReviewReport } from "./composeReview";

export function ComposeExportPage({
  segments,
  materialBuckets,
  timeline,
  finalRuns,
  totalDuration,
  composeStatus,
  onSegment,
  onTimelineClip,
  onRerollTimelineClip,
  onMoveTimelineClip,
  onMove,
  onAssembleTimeline,
  onAssetMaxUses,
  onAssetToggle,
  onAssetOperationState,
  onBack,
  onCompose,
  onExport,
  onRunFeedback,
  onExportRunFeedback,
  onImportRunFeedback,
  onApplyOperationDecisions
}: {
  segments: VideoSegment[];
  materialBuckets: MaterialBucket[];
  timeline: ComposeTimeline | null;
  finalRuns: FinalVideoRun[];
  totalDuration: number;
  composeStatus: "idle" | "running" | "done";
  onSegment: (id: string, patch: Partial<VideoSegment>) => void;
  onTimelineClip: (
    clipId: string,
    patch: Partial<Pick<TimelineClip, "scriptText" | "subtitleText" | "overlayText">>
  ) => void;
  onRerollTimelineClip: (clipId: string) => void;
  onMoveTimelineClip: (clipId: string, direction: -1 | 1) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onAssembleTimeline: () => void;
  onAssetMaxUses: (assetId: string, maxUses: number) => void;
  onAssetToggle: (assetId: string) => void;
  onAssetOperationState: (assetId: string, operationState: OperationDecisionState) => void;
  onBack: () => void;
  onCompose: () => void;
  onExport: () => void;
  onRunFeedback: (runId: string, feedback: Partial<OperationFeedback>) => void;
  onExportRunFeedback: () => void;
  onImportRunFeedback: (file?: File) => void;
  onApplyOperationDecisions: () => void;
}) {
  const timelineDuration = timeline?.totalDuration ?? totalDuration;
  const analytics = buildOperationAnalytics(finalRuns);
  const composeReview = timeline ? buildComposeReview(timeline, materialBuckets) : null;
  const isExportBlocked = composeReview?.readiness === "blocked";
  return (
    <section className="workspace compose-workspace">
      <div className="panel compose-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Page 5</p>
            <h2>素材审核、合成与剪映导入</h2>
          </div>
          <div className="compose-meta">
            <span>{timeline?.clips.length ?? segments.length}段</span>
            <span>{timelineDuration}秒</span>
            <span>{finalRuns.length}次导出</span>
          </div>
        </div>

        <div className="button-row compose-toolbar">
          <button className="secondary-button" onClick={onAssembleTimeline}>
            <Shuffle size={16} />
            随机组装时间线
          </button>
        </div>

        <BucketReadinessNotice buckets={materialBuckets} />
        <BucketUsagePanel
          buckets={materialBuckets}
          onAssetMaxUses={onAssetMaxUses}
          onAssetToggle={onAssetToggle}
          onAssetOperationState={onAssetOperationState}
        />

        {timeline ? (
          <TimelinePreview
            timeline={timeline}
            onTimelineClip={onTimelineClip}
            onRerollTimelineClip={onRerollTimelineClip}
            onMoveTimelineClip={onMoveTimelineClip}
          />
        ) : !segments.length ? (
          <div className="empty-state">
            <FileVideo size={42} />
            <strong>当前工程暂无素材段</strong>
            <span>请先在生成页创建二创素材桶，然后从素材桶随机组装时间线。</span>
          </div>
        ) : (
          <div className="compose-list">
            {segments.map((segment, index) => (
              <article className="compose-item" key={segment.id}>
                <div className="compose-video">
                  {segment.videoUrl ? (
                    <video src={segment.videoUrl} controls />
                  ) : (
                    <div className="video-placeholder">
                      <FileVideo size={28} />
                      <span>无视频</span>
                    </div>
                  )}
                </div>
                <div className="compose-script">
                  <div className="card-title-row">
                    <div>
                      <h3>{index + 1}. {segment.title}</h3>
                      <small>{segment.duration}秒 · {segmentStatusLabel(segment.status)}</small>
                    </div>
                    <div className="icon-actions">
                      <button className="icon-button" title="上移" onClick={() => onMove(segment.id, -1)}>
                        <ArrowUp size={16} />
                      </button>
                      <button className="icon-button" title="下移" onClick={() => onMove(segment.id, 1)}>
                        <ArrowDown size={16} />
                      </button>
                      <button
                        className="icon-button"
                        title="重新生成"
                        onClick={() => onSegment(segment.id, { status: "idle", videoUrl: undefined })}
                      >
                        <RefreshCw size={16} />
                      </button>
                    </div>
                  </div>
                  <label className="compose-main-text">
                    <span>脚本</span>
                    <textarea
                      value={segment.scriptText}
                      onChange={(event) => onSegment(segment.id, { scriptText: event.target.value })}
                    />
                  </label>
                  <div className="compose-text-grid">
                    <label>
                      <span>字幕</span>
                      <textarea
                        value={segment.subtitleText ?? segment.scriptText}
                        onChange={(event) => onSegment(segment.id, { subtitleText: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>贴片</span>
                      <textarea
                        value={segment.overlayText ?? ""}
                        onChange={(event) => onSegment(segment.id, { overlayText: event.target.value })}
                      />
                    </label>
                  </div>
                  <p>{segment.generationPrompt}</p>
                </div>
              </article>
            ))}
          </div>
        )}

        {composeReview && <ComposeReviewPanel review={composeReview} />}

        <OperationRunsPanel
          runs={finalRuns}
          analytics={analytics}
          onRunFeedback={onRunFeedback}
          onExportRunFeedback={onExportRunFeedback}
          onImportRunFeedback={onImportRunFeedback}
          onApplyOperationDecisions={onApplyOperationDecisions}
        />
      </div>

      <footer className="fixed-action-bar">
        <button className="secondary-button" onClick={onBack}>返回生成页</button>
        <button className="primary-button" onClick={onCompose}>
          {composeStatus === "running" ? <Loader2 className="spin" size={18} /> : <Scissors size={18} />}
          {composeStatus === "done" ? "已合成" : "一键合成"}
        </button>
        <button className="primary-button dark" onClick={onExport} disabled={isExportBlocked} title={isExportBlocked ? "导出前审核存在阻塞项" : undefined}>
          <PackageOpen size={18} />
          导入剪映
        </button>
      </footer>
    </section>
  );
}

function ComposeReviewPanel({ review }: { review: ComposeReviewReport }) {
  return (
    <section className={`compose-review-panel ${review.readiness}`}>
      <div className="card-title-row">
        <div>
          <p className="eyebrow">Export Review</p>
          <h2>导出前审核</h2>
        </div>
        <div className="audit-stat-row">
          <span>评分 {review.score}</span>
          <span>{review.clipCount}段</span>
          <span>{review.totalDuration}秒</span>
          <span>{readinessLabel(review.readiness)}</span>
          <span>阻塞 {review.counts.error}</span>
          <span>提醒 {review.counts.warning}</span>
        </div>
      </div>

      {!review.issues.length ? (
        <div className="audit-empty">时间线已满足导出要求。</div>
      ) : (
        <div className="compose-review-list">
          {review.issues.map((issue) => (
            <ComposeReviewIssueItem issue={issue} key={issue.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function ComposeReviewIssueItem({ issue }: { issue: ComposeReviewIssue }) {
  return (
    <div className={`compose-review-issue ${issue.severity}`}>
      <span>{severityLabel(issue.severity)}</span>
      <div>
        <strong>{issue.clipTitle ? `${issue.clipTitle}：${issue.message}` : issue.message}</strong>
        <small>{issue.suggestion}</small>
      </div>
    </div>
  );
}

function OperationRunsPanel({
  runs,
  analytics,
  onRunFeedback,
  onExportRunFeedback,
  onImportRunFeedback,
  onApplyOperationDecisions
}: {
  runs: FinalVideoRun[];
  analytics: ReturnType<typeof buildOperationAnalytics>;
  onRunFeedback: (runId: string, feedback: Partial<OperationFeedback>) => void;
  onExportRunFeedback: () => void;
  onImportRunFeedback: (file?: File) => void;
  onApplyOperationDecisions: () => void;
}) {
  const hasFeedback = runs.some((run) => run.feedback);
  return (
    <section className="operation-panel">
      <div className="card-title-row">
        <div>
          <p className="eyebrow">Operation Runs</p>
          <h2>导出运行记录与反馈</h2>
        </div>
        <div className="button-row">
          <button className="secondary-button compact" onClick={onApplyOperationDecisions} disabled={!hasFeedback}>
            <BarChart3 size={15} />
            应用建议
          </button>
          <button className="secondary-button compact" onClick={onExportRunFeedback} disabled={!runs.length}>
            <Download size={15} />
            导出JSON
          </button>
          <label
            className="secondary-button compact"
            tabIndex={0}
            role="button"
            aria-label="导入运营反馈 JSON"
            onKeyDown={triggerNestedFileInput}
          >
            <Upload size={15} />
            导入JSON
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(event) => {
                onImportRunFeedback(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
        </div>
      </div>

      {!runs.length ? (
        <div className="empty-state compact-empty">
          <BarChart3 size={36} />
          <strong>暂无导出记录</strong>
          <span>导出剪映草稿包后，这里会生成可回填运营数据的成片 run。</span>
        </div>
      ) : (
        <>
          <OperationAnalyticsPanel analytics={analytics} />
          <div className="operation-run-list">
            {runs.map((run) => (
              <article className="mini-card operation-run-card" key={run.id}>
                <div className="card-title-row">
                  <div>
                    <h3>{run.outputName}</h3>
                    <small>
                      {formatDateTime(run.createdAt)} · {run.output.duration}秒 · {run.clips.length}段 · {run.output.fileName}
                    </small>
                  </div>
                  <span className="source-pill">{run.feedback ? "已反馈" : "待反馈"}</span>
                </div>

                {run.review && (
                  <div className={`run-review-strip ${run.review.readiness}`}>
                    <span>审核 {readinessLabel(run.review.readiness)}</span>
                    <span>评分 {run.review.score}</span>
                    <span>阻塞 {run.review.counts.error}</span>
                    <span>提醒 {run.review.counts.warning}</span>
                  </div>
                )}

                <div className="run-trace-list">
                  {run.clips.map((clip) => (
                    <span key={clip.timelineClipId}>
                      {clip.order}. {clip.bucketLabel}/{clip.remixAssetId.slice(0, 12)}
                    </span>
                  ))}
                </div>

                <div className="run-clip-text-list">
                  {run.clips.map((clip) => (
                    <details className="run-clip-trace" key={`${run.id}-${clip.timelineClipId}`}>
                      <summary>
                        <span>{clip.order}. {clip.title}</span>
                        <small>{clip.sourceRange} · {clip.providerId} · {clip.duration}秒 · {selectionTraceLabel(clip.selectionTrace?.action)}</small>
                      </summary>
                      <p>{clip.scriptText}</p>
                      <small>字幕：{clip.subtitleText || clip.scriptText}</small>
                      {clip.overlayText && <small>贴片：{clip.overlayText}</small>}
                    </details>
                  ))}
                </div>

                <RunFeedbackForm run={run} onRunFeedback={onRunFeedback} />
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function triggerNestedFileInput(event: KeyboardEvent<HTMLLabelElement>) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.currentTarget.querySelector("input")?.click();
}

function OperationAnalyticsPanel({ analytics }: { analytics: ReturnType<typeof buildOperationAnalytics> }) {
  const hasFeedback = [analytics.asset, analytics.bucket, analytics.provider, analytics.promptHash].some((items) => items.length);
  if (!hasFeedback) {
    return (
      <div className="mini-card operation-analytics-empty">
        <strong>等待反馈数据</strong>
        <small>录入完播率、点击率、ROI 后，这里会按素材、bucket、provider 和 promptHash 汇总表现。</small>
      </div>
    );
  }

  return (
    <div className="operation-analytics-grid">
      <AggregateTable title="素材表现" items={analytics.asset.slice(0, 6)} />
      <AggregateTable title="Bucket表现" items={analytics.bucket.slice(0, 6)} />
      <AggregateTable title="Provider表现" items={analytics.provider.slice(0, 6)} />
      <AggregateTable title="PromptHash表现" items={analytics.promptHash.slice(0, 6)} />
    </div>
  );
}

function AggregateTable({ title, items }: { title: string; items: OperationAggregate[] }) {
  return (
    <article className="mini-card aggregate-card">
      <div className="card-title-row">
        <h3>{title}</h3>
        <span className="source-pill">{items.length}项</span>
      </div>
      {!items.length ? (
        <p className="muted-text">暂无数据。</p>
      ) : (
        <table className="aggregate-table">
          <thead>
            <tr>
              <th>对象</th>
              <th>样本</th>
              <th>ROI</th>
              <th>完播</th>
              <th>CTR</th>
              <th>GMV</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.dimension}-${item.key}`}>
                <td title={item.key}>{item.label}</td>
                <td>{item.sampleRuns}/{item.clipUses}</td>
                <td>{item.avgRoi.toFixed(2)}</td>
                <td>{formatPercent(item.avgCompletionRate)}</td>
                <td>{formatPercent(item.avgClickThroughRate)}</td>
                <td>{formatMoney(item.totalGmv)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}

function RunFeedbackForm({
  run,
  onRunFeedback
}: {
  run: FinalVideoRun;
  onRunFeedback: (runId: string, feedback: Partial<OperationFeedback>) => void;
}) {
  const feedback = run.feedback;
  return (
    <div className="operation-feedback-grid">
      <label>
        <span>平台</span>
        <select
          value={feedback?.platform ?? "douyin"}
          onChange={(event) => onRunFeedback(run.id, { platform: event.target.value as OperationPlatform })}
        >
          <option value="douyin">抖音</option>
          <option value="xiaohongshu">小红书</option>
          <option value="kuaishou">快手</option>
          <option value="shipinhao">视频号</option>
          <option value="ad-platform">广告投放</option>
          <option value="other">其他</option>
        </select>
      </label>
      <TextField label="计划ID" value={feedback?.campaignId ?? ""} onValue={(value) => onRunFeedback(run.id, { campaignId: value })} />
      <TextField label="素材ID" value={feedback?.externalCreativeId ?? ""} onValue={(value) => onRunFeedback(run.id, { externalCreativeId: value })} />
      <NumberField label="播放量" value={feedback?.views ?? 0} onValue={(value) => onRunFeedback(run.id, { views: value })} />
      <NumberField label="完播率%" value={rateToPercent(feedback?.completionRate)} onValue={(value) => onRunFeedback(run.id, { completionRate: percentToRate(value) })} step={0.1} />
      <NumberField label="点击率%" value={rateToPercent(feedback?.clickThroughRate)} onValue={(value) => onRunFeedback(run.id, { clickThroughRate: percentToRate(value) })} step={0.1} />
      <NumberField label="转化率%" value={rateToPercent(feedback?.conversionRate)} onValue={(value) => onRunFeedback(run.id, { conversionRate: percentToRate(value) })} step={0.1} />
      <NumberField label="消耗" value={feedback?.spend ?? 0} onValue={(value) => onRunFeedback(run.id, { spend: value })} step={0.01} />
      <NumberField label="GMV" value={feedback?.gmv ?? 0} onValue={(value) => onRunFeedback(run.id, { gmv: value })} step={0.01} />
      <NumberField label="ROI" value={feedback?.roi ?? 0} onValue={(value) => onRunFeedback(run.id, { roi: value })} step={0.01} />
      <label className="wide-field">
        <span>备注</span>
        <textarea value={feedback?.notes ?? ""} onChange={(event) => onRunFeedback(run.id, { notes: event.target.value })} />
      </label>
    </div>
  );
}

function TextField({ label, value, onValue }: { label: string; value: string; onValue: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} onChange={(event) => onValue(event.target.value)} />
    </label>
  );
}

function NumberField({
  label,
  value,
  step = 1,
  onValue
}: {
  label: string;
  value: number;
  step?: number;
  onValue: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" min={0} step={step} value={value} onChange={(event) => onValue(Number(event.target.value))} />
    </label>
  );
}

function rateToPercent(value = 0) {
  return Number((value * 100).toFixed(2));
}

function percentToRate(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / 100));
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMoney(value: number) {
  return Number(value || 0).toFixed(0);
}

function formatDateTime(value: string) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function TimelinePreview({
  timeline,
  onTimelineClip,
  onRerollTimelineClip,
  onMoveTimelineClip
}: {
  timeline: ComposeTimeline;
  onTimelineClip: (
    clipId: string,
    patch: Partial<Pick<TimelineClip, "scriptText" | "subtitleText" | "overlayText">>
  ) => void;
  onRerollTimelineClip: (clipId: string) => void;
  onMoveTimelineClip: (clipId: string, direction: -1 | 1) => void;
}) {
  return (
    <div className="compose-list">
      <div className="summary-strip">
        <strong>Timeline</strong>
        <span>seed: {timeline.randomSeed}</span>
        <span>{timeline.selectionPolicy}</span>
      </div>
      {timeline.clips.map((clip) => (
        <article className="compose-item" key={clip.id}>
          <div className="compose-video">
            {clip.videoUrl ? (
              <video src={clip.videoUrl} controls />
            ) : (
              <div className="video-placeholder">
                <FileVideo size={28} />
                <span>占位素材</span>
              </div>
            )}
          </div>
          <div className="compose-script">
            <div className="card-title-row">
              <div>
                <h3>{clip.order}. {clip.title}</h3>
                <small>{clip.bucketLabel} · {clip.duration}秒 · {clip.providerId} · {selectionTraceLabel(clip.selectionTrace?.action)}</small>
              </div>
              <div className="icon-actions">
                <span className="source-pill">{clip.tags.sourceRange}</span>
                <button className="icon-button" title="上移" aria-label={`上移 ${clip.title}`} onClick={() => onMoveTimelineClip(clip.id, -1)}>
                  <ArrowUp size={16} />
                </button>
                <button className="icon-button" title="下移" aria-label={`下移 ${clip.title}`} onClick={() => onMoveTimelineClip(clip.id, 1)}>
                  <ArrowDown size={16} />
                </button>
                <button className="icon-button" title="重抽该段" aria-label={`重抽 ${clip.title}`} onClick={() => onRerollTimelineClip(clip.id)}>
                  <Shuffle size={16} />
                </button>
              </div>
            </div>
            <label className="compose-main-text">
              <span>脚本</span>
              <textarea
                value={clip.scriptText}
                onChange={(event) => onTimelineClip(clip.id, { scriptText: event.target.value })}
              />
            </label>
            <div className="compose-text-grid">
              <label>
                <span>字幕</span>
                <textarea
                  value={clip.subtitleText ?? clip.scriptText}
                  onChange={(event) => onTimelineClip(clip.id, { subtitleText: event.target.value })}
                />
              </label>
              <label>
                <span>贴片</span>
                <textarea
                  value={clip.overlayText ?? ""}
                  onChange={(event) => onTimelineClip(clip.id, { overlayText: event.target.value })}
                />
              </label>
            </div>
            <p>{clip.prompt}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function BucketUsagePanel({
  buckets,
  onAssetMaxUses,
  onAssetToggle,
  onAssetOperationState
}: {
  buckets: MaterialBucket[];
  onAssetMaxUses: (assetId: string, maxUses: number) => void;
  onAssetToggle: (assetId: string) => void;
  onAssetOperationState: (assetId: string, operationState: OperationDecisionState) => void;
}) {
  const assets = buckets.flatMap((bucket) => bucket.assets.map((asset) => ({ bucket, asset })));
  if (!assets.length) return null;

  return (
    <div className="bucket-usage-panel">
      {assets.map(({ bucket, asset }) => (
        <article className={`mini-card bucket-usage-item ${asset.disabled ? "disabled" : ""}`} key={asset.id}>
          <div>
            <strong>{bucket.label} / {asset.title}</strong>
            <small>{asset.tags.sourceRange} · {assetAvailabilityLabel(asset)}</small>
          </div>
          <button className="secondary-button compact" onClick={() => onAssetToggle(asset.id)}>
            {asset.disabled ? "启用" : "禁用"}
          </button>
          <label>
            <span>最大使用</span>
            <input
              type="number"
              min={asset.usage.usedCount}
              value={asset.usage.maxUses}
              onChange={(event) => onAssetMaxUses(asset.id, Number(event.target.value))}
            />
          </label>
          <label>
            <span>运营状态</span>
            <select
              value={asset.operationState ?? "untested"}
              onChange={(event) => onAssetOperationState(asset.id, event.target.value as OperationDecisionState)}
            >
              {operationDecisionOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </article>
      ))}
    </div>
  );
}

function BucketReadinessNotice({ buckets }: { buckets: MaterialBucket[] }) {
  const blocked = buckets.filter((bucket) => bucket.assets.length > 0 && availableAssetCount(bucket) === 0);
  if (!blocked.length) return null;

  return (
    <div className="parse-error">
      以下素材桶暂无可用片段：{blocked.map((bucket) => bucket.label).join("、")}。请补素材、启用片段或调高最大使用次数。
    </div>
  );
}

function availableAssetCount(bucket: MaterialBucket) {
  return bucket.assets.filter((asset) => isAssetAvailable(asset)).length;
}

function isAssetAvailable(asset: MaterialBucket["assets"][number]) {
  return !asset.disabled && asset.status === "ready" && asset.operationState !== "rejected" && asset.usage.usedCount < asset.usage.maxUses;
}

function assetAvailabilityLabel(asset: MaterialBucket["assets"][number]) {
  if (asset.disabled) return "已禁用";
  if (asset.status !== "ready") return "未就绪";
  if (asset.operationState === "rejected") return "已淘汰";
  if (asset.usage.usedCount >= asset.usage.maxUses) return `已耗尽 ${asset.usage.usedCount}/${asset.usage.maxUses}`;
  return `${operationDecisionLabel(asset.operationState)} · 可用 ${asset.usage.usedCount}/${asset.usage.maxUses}`;
}

const operationDecisionOptions: Array<{ value: OperationDecisionState; label: string }> = [
  { value: "untested", label: "未测试" },
  { value: "winning", label: "优胜" },
  { value: "fatigued", label: "疲劳" },
  { value: "rejected", label: "淘汰" }
];

function operationDecisionLabel(value?: OperationDecisionState) {
  return operationDecisionOptions.find((option) => option.value === (value ?? "untested"))?.label ?? "未测试";
}

function readinessLabel(value: ComposeReviewReport["readiness"]) {
  if (value === "blocked") return "存在阻塞";
  if (value === "needs-work") return "可导出需复核";
  return "可导出";
}

function severityLabel(value: ComposeReviewIssue["severity"]) {
  if (value === "error") return "阻塞";
  if (value === "warning") return "提醒";
  return "信息";
}

function selectionTraceLabel(value?: "assembled" | "rerolled") {
  if (value === "rerolled") return "重抽";
  return "初选";
}
