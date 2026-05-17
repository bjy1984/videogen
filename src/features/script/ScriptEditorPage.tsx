import { AlertTriangle, ArrowDown, ArrowUp, Check, ClipboardList, Copy, FileText, Layers, Plus, RotateCcw, Save, ScanFace, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { InfoItem } from "../../components/common/InfoItem";
import { segmentStatusLabel } from "../../domain/labels";
import type { AnalysisResult, BrandMaskTrack, FaceMosaicEffect, SegmentBucketRole, SegmentContentStatus, VideoSegment } from "../../types";
import { BrandMaskAnnotator } from "../privacy/BrandMaskAnnotator";
import { buildBrandMaskReview } from "../privacy/brandMaskReview";
import { hasSegmentBrandMasks, hasSegmentFaceMosaic } from "./privacyEdits";
import { buildScriptAudit, type ScriptAuditIssue, type ScriptAuditReport } from "./scriptAudit";
import type { ScriptRewriteSuggestion, ScriptSuggestionApplyTarget, ScriptRevision } from "./scriptRevision";

export function ScriptEditorPage({
  analysisResult,
  segments,
  scriptRevisions,
  scriptSuggestions,
  sourcePreviewUrl,
  facePreviewSegmentId,
  facePreviewError,
  onSegment,
  onMove,
  onDuplicate,
  onDelete,
  onAddSegment,
  onSaveRevision,
  onRestoreRevision,
  onSuggestRewrite,
  onApplySuggestion,
  onToggleFaceMosaic,
  onChangeFaceMosaicEffect,
  onChangeFaceMosaicStrength,
  onToggleAllFaceMosaic,
  onPreviewFaceMosaic,
  onUpdateBrandMasks,
  onCreate,
  onBack,
  onNext
}: {
  analysisResult: AnalysisResult | null;
  segments: VideoSegment[];
  scriptRevisions: ScriptRevision[];
  scriptSuggestions: Record<string, ScriptRewriteSuggestion>;
  sourcePreviewUrl: string;
  facePreviewSegmentId: string;
  facePreviewError: string;
  onSegment: (id: string, patch: Partial<VideoSegment>) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onAddSegment: () => void;
  onSaveRevision: () => void;
  onRestoreRevision: (revisionId: string) => void;
  onSuggestRewrite: (segmentId: string) => void;
  onApplySuggestion: (segmentId: string, target: ScriptSuggestionApplyTarget) => void;
  onToggleFaceMosaic: (segmentId: string) => void;
  onChangeFaceMosaicEffect: (segmentId: string, effect: FaceMosaicEffect) => void;
  onChangeFaceMosaicStrength: (segmentId: string, strength: number) => void;
  onToggleAllFaceMosaic: () => void;
  onPreviewFaceMosaic: (segmentId: string) => void;
  onUpdateBrandMasks: (segmentId: string, brandMasks: BrandMaskTrack[]) => void;
  onCreate: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [brandMaskSegmentId, setBrandMaskSegmentId] = useState("");
  const totalDuration = segments.reduce((total, segment) => total + segment.duration, 0);
  const totalScriptChars = segments.reduce((total, segment) => total + segment.scriptText.length, 0);
  const allFaceMosaic = segments.length > 0 && segments.every(hasSegmentFaceMosaic);
  const audit = buildScriptAudit(segments);
  const brandMaskSegment = segments.find((segment) => segment.id === brandMaskSegmentId);

  return (
    <>
    <section className="workspace two-columns">
      <div className="panel script-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Page 3</p>
            <h2>脚本拆分与编辑</h2>
          </div>
          <button className="secondary-button" onClick={onCreate}>
            <Layers size={16} />
            创建五段脚本
          </button>
        </div>

        <div className="summary-strip script-summary">
          <strong>{segments.length || 0}段</strong>
          <span>{totalDuration}秒</span>
          <span>{totalScriptChars}字脚本</span>
          <button className="secondary-button compact" onClick={onSaveRevision} disabled={!segments.length}>
            <Save size={14} />
            保存版本
          </button>
          <button className="secondary-button compact" onClick={onAddSegment}>
            <Plus size={14} />
            新增段落
          </button>
          <button
            className={`secondary-button compact ${allFaceMosaic ? "privacy-active" : ""}`}
            onClick={onToggleAllFaceMosaic}
            disabled={!segments.length}
          >
            <ScanFace size={14} />
            {allFaceMosaic ? "取消全段人脸" : "全段人脸打码"}
          </button>
        </div>

        {!segments.length ? (
          <div className="empty-state compact-empty">
            <FileText size={38} />
            <strong>当前工程暂无脚本段</strong>
            <span>可以直接创建默认五段脚本，也可以先在报告页提取。</span>
          </div>
        ) : (
          <div className="segment-editor-list relaxed">
            {segments.map((segment, index) => {
              const faceMosaicEnabled = hasSegmentFaceMosaic(segment);
              const brandMaskEnabled = hasSegmentBrandMasks(segment);
              const brandMaskReview = buildBrandMaskReview(segment.privacyEdits?.brandMasks ?? []);
              return (
              <article className="segment-editor" key={segment.id}>
                <div className="card-title-row">
                  <div>
                    <h3>{index + 1}. {segment.title || "未命名段落"}</h3>
                    <small>
                      {bucketRoleLabel(segment.bucketRole)} · {contentStatusLabel(segment.contentStatus)} · {segment.role} · {segment.duration}秒
                      {faceMosaicEnabled ? " · 人脸打码" : ""}
                      {brandMaskEnabled ? ` · 物体打码${brandMaskReview.errorCount ? "待补帧" : ""}` : ""}
                    </small>
                  </div>
                  <div className="icon-actions">
                    <span className={`status ${segment.status}`}>{segmentStatusLabel(segment.status)}</span>
                    <button
                      className={`icon-button privacy ${faceMosaicEnabled || brandMaskEnabled ? "active" : ""} ${brandMaskReview.errorCount ? "needs-attention" : ""}`}
                      title="预处理打码"
                      aria-label={`编辑${segment.title || "该段落"}预处理打码`}
                      aria-pressed={faceMosaicEnabled || brandMaskEnabled}
                      onClick={() => setBrandMaskSegmentId(segment.id)}
                    >
                      <ShieldCheck size={15} />
                    </button>
                    <button className="icon-button" title="上移" disabled={index === 0} onClick={() => onMove(segment.id, -1)}>
                      <ArrowUp size={15} />
                    </button>
                    <button className="icon-button" title="下移" disabled={index === segments.length - 1} onClick={() => onMove(segment.id, 1)}>
                      <ArrowDown size={15} />
                    </button>
                    <button className="icon-button" title="复制段落" onClick={() => onDuplicate(segment.id)}>
                      <Copy size={15} />
                    </button>
                    <button className="icon-button" title="改写建议" onClick={() => onSuggestRewrite(segment.id)}>
                      <Sparkles size={15} />
                    </button>
                    <button className="icon-button danger" title="删除段落" onClick={() => onDelete(segment.id)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                <div className="segment-structure-grid">
                  <label>
                    <span>段落标题</span>
                    <input value={segment.title} onChange={(event) => onSegment(segment.id, { title: event.target.value })} />
                  </label>
                  <label>
                    <span>归属桶</span>
                    <select
                      value={segment.bucketRole ?? inferBucketRole(segment.id)}
                      onChange={(event) => onSegment(segment.id, { bucketRole: event.target.value as SegmentBucketRole })}
                    >
                      {bucketRoleOptions.map((option) => (
                        <option value={option.value} key={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>内容状态</span>
                    <select
                      value={segment.contentStatus ?? "draft"}
                      onChange={(event) => onSegment(segment.id, { contentStatus: event.target.value as SegmentContentStatus })}
                    >
                      {contentStatusOptions.map((option) => (
                        <option value={option.value} key={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>时间范围</span>
                    <input value={segment.role} onChange={(event) => onSegment(segment.id, { role: event.target.value })} />
                  </label>
                  <label>
                    <span>时长</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={segment.duration}
                      onChange={(event) => onSegment(segment.id, { duration: normalizeDuration(event.target.value) })}
                    />
                  </label>
                </div>
                <label>
                  <span>脚本文案</span>
                  <textarea
                    value={segment.scriptText}
                    onChange={(event) => onSegment(segment.id, { scriptText: event.target.value })}
                  />
                </label>
                <div className="segment-text-grid">
                  <label>
                    <span>字幕文案</span>
                    <textarea
                      value={segment.subtitleText ?? segment.scriptText}
                      onChange={(event) => onSegment(segment.id, { subtitleText: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>贴片文案</span>
                    <textarea
                      value={segment.overlayText ?? ""}
                      placeholder="例如：限时福利 / 先测再护理 / 发尾对比"
                      onChange={(event) => onSegment(segment.id, { overlayText: event.target.value })}
                    />
                  </label>
                </div>
                <label>
                  <span>画面/生成提示语</span>
                  <textarea
                    value={segment.generationPrompt}
                    onChange={(event) => onSegment(segment.id, { generationPrompt: event.target.value })}
                  />
                </label>
                {scriptSuggestions[segment.id] && (
                  <RewriteSuggestion
                    suggestion={scriptSuggestions[segment.id]}
                    onApply={(target) => onApplySuggestion(segment.id, target)}
                  />
                )}
              </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel result-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Execution Context</p>
            <h2>分析承接信息</h2>
          </div>
          <button className="secondary-button" onClick={onNext}>进入生成页</button>
        </div>

        <ScriptRevisionPanel revisions={scriptRevisions} onRestore={onRestoreRevision} />
        <ScriptAuditPanel audit={audit} />

        {!analysisResult ? (
          <div className="empty-state">
            <ClipboardList size={42} />
            <strong>暂无分析上下文</strong>
            <span>不会阻止编辑脚本。后续加载工程或生成分析后，这里会展示执行方案和提示语。</span>
          </div>
        ) : (
          <div className="stack">
            <InfoItem label="最大结构问题" value={analysisResult.narrative.structureIssue} wide />
            <InfoItem label="关键优化点" value={analysisResult.dataPrediction.keyOptimization} wide />
            {analysisResult.executionPlan.rewriteSegments.map((item) => (
              <article className="mini-card" key={item.range}>
                <h3>可仿写：{item.range}</h3>
                <p>{item.content}</p>
                <small>{item.direction}</small>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
    {brandMaskSegment && (
      <BrandMaskAnnotator
        segment={brandMaskSegment}
        sourcePreviewUrl={sourcePreviewUrl}
        facePreviewSegmentId={facePreviewSegmentId}
        facePreviewError={facePreviewError}
        onToggleFaceMosaic={() => onToggleFaceMosaic(brandMaskSegment.id)}
        onChangeFaceMosaicEffect={(effect) => onChangeFaceMosaicEffect(brandMaskSegment.id, effect)}
        onChangeFaceMosaicStrength={(strength) => onChangeFaceMosaicStrength(brandMaskSegment.id, strength)}
        onPreviewFaceMosaic={() => onPreviewFaceMosaic(brandMaskSegment.id)}
        onChange={(brandMasks) => onUpdateBrandMasks(brandMaskSegment.id, brandMasks)}
        onClose={() => setBrandMaskSegmentId("")}
      />
    )}
    </>
  );
}

function ScriptAuditPanel({ audit }: { audit: ScriptAuditReport }) {
  return (
    <section className={`script-audit-panel ${audit.readiness}`}>
      <div className="card-title-row">
        <div>
          <h3>内容审核</h3>
          <small>{readinessLabel(audit.readiness)} · {audit.segmentCount}段 · {audit.totalDuration}秒</small>
        </div>
        <span className="source-pill">{audit.score}分</span>
      </div>
      <div className="audit-stat-row">
        <span>阻塞 {audit.counts.error}</span>
        <span>警告 {audit.counts.warning}</span>
        <span>提示 {audit.counts.info}</span>
      </div>
      {!audit.issues.length ? (
        <div className="audit-empty">
          <ShieldCheck size={28} />
          <strong>当前脚本可进入生成</strong>
        </div>
      ) : (
        <div className="audit-issue-list">
          {audit.issues.slice(0, 8).map((issue) => (
            <AuditIssueItem issue={issue} key={issue.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function AuditIssueItem({ issue }: { issue: ScriptAuditIssue }) {
  return (
    <article className={`audit-issue ${issue.severity}`}>
      <AlertTriangle size={15} />
      <div>
        <strong>{issue.segmentTitle ? `${issue.segmentTitle}：${issue.message}` : issue.message}</strong>
        <small>{issue.suggestion}</small>
      </div>
    </article>
  );
}

function RewriteSuggestion({
  suggestion,
  onApply
}: {
  suggestion: ScriptRewriteSuggestion;
  onApply: (target: ScriptSuggestionApplyTarget) => void;
}) {
  return (
    <div className="rewrite-suggestion">
      <div className="card-title-row">
        <div>
          <strong>改写建议</strong>
          <small>{suggestion.reason}</small>
        </div>
        <div className="button-row">
          <button className="secondary-button compact" onClick={() => onApply("script")}>
            <Check size={14} />
            文案
          </button>
          <button className="secondary-button compact" onClick={() => onApply("prompt")}>
            <Check size={14} />
            提示词
          </button>
          <button className="primary-button compact" onClick={() => onApply("both")}>
            <Check size={14} />
            全部
          </button>
        </div>
      </div>
      <div className="suggestion-grid">
        <div>
          <span>文案</span>
          <p>{suggestion.scriptText}</p>
        </div>
        <div>
          <span>提示词</span>
          <p>{suggestion.generationPrompt}</p>
        </div>
      </div>
    </div>
  );
}

function ScriptRevisionPanel({
  revisions,
  onRestore
}: {
  revisions: ScriptRevision[];
  onRestore: (revisionId: string) => void;
}) {
  return (
    <section className="script-revision-panel">
      <div className="card-title-row">
        <div>
          <h3>版本历史</h3>
          <small>最多保留最近20个脚本快照。</small>
        </div>
        <span className="source-pill">{revisions.length}版</span>
      </div>
      {!revisions.length ? (
        <p className="muted-text">暂无版本。点击左侧“保存版本”后可在这里回滚。</p>
      ) : (
        <div className="revision-list">
          {revisions.map((revision) => (
            <article className="revision-item" key={revision.id}>
              <div>
                <strong>{revision.label}</strong>
                <small>{revision.segmentCount}段 · {revision.totalDuration}秒 · {revision.totalScriptChars}字</small>
              </div>
              <button className="secondary-button compact" onClick={() => onRestore(revision.id)}>
                <RotateCcw size={14} />
                恢复
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const bucketRoleOptions: Array<{ value: SegmentBucketRole; label: string }> = [
  { value: "hook", label: "Hook" },
  { value: "pain", label: "Pain" },
  { value: "usp", label: "USP" },
  { value: "trust", label: "Trust" },
  { value: "cta", label: "CTA" }
];

const contentStatusOptions: Array<{ value: SegmentContentStatus; label: string }> = [
  { value: "draft", label: "草稿" },
  { value: "needs-review", label: "待审核" },
  { value: "approved", label: "已通过" },
  { value: "blocked", label: "阻塞" }
];

function inferBucketRole(segmentId: string): SegmentBucketRole {
  if (segmentId === "pain" || segmentId === "usp" || segmentId === "trust" || segmentId === "cta") return segmentId;
  return "hook";
}

function bucketRoleLabel(value?: SegmentBucketRole) {
  return bucketRoleOptions.find((option) => option.value === (value ?? "hook"))?.label ?? "Hook";
}

function contentStatusLabel(value?: SegmentContentStatus) {
  return contentStatusOptions.find((option) => option.value === (value ?? "draft"))?.label ?? "草稿";
}

function readinessLabel(value: ScriptAuditReport["readiness"]) {
  if (value === "blocked") return "存在阻塞";
  if (value === "needs-work") return "需要优化";
  return "可进入生成";
}

function normalizeDuration(value: string) {
  const duration = Number(value);
  return Number.isFinite(duration) ? Math.max(1, Math.floor(duration)) : 1;
}
