import { AlertTriangle, BadgeX, Check, PanelTopClose, Plus, ScanText, SquareDashedMousePointer, Trash2 } from "lucide-react";
import type { PointerEvent } from "react";
import { useMemo, useRef, useState } from "react";
import type { BrandMaskEffect, BrandMaskKeyframe, BrandMaskTargetType, BrandMaskTrack, BrandMaskTrackMode, VideoSegment } from "../../types";
import { brandMaskDefaultEffect } from "../script/privacyEdits";
import { buildBrandMaskReview } from "./brandMaskReview";

interface BrandMaskAnnotatorProps {
  segment: VideoSegment;
  sourcePreviewUrl: string;
  onChange: (tracks: BrandMaskTrack[]) => void;
  onClose: () => void;
}

interface DraftRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function BrandMaskAnnotator({
  segment,
  sourcePreviewUrl,
  onChange,
  onClose
}: BrandMaskAnnotatorProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const tracks = segment.privacyEdits?.brandMasks ?? [];
  const [activeTrackId, setActiveTrackId] = useState(tracks[0]?.id ?? "");
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draftRect, setDraftRect] = useState<DraftRect | null>(null);
  const [playbackTime, setPlaybackTime] = useState(0);

  const activeTrack = tracks.find((track) => track.id === activeTrackId) ?? tracks[0];
  const visibleKeyframe = activeTrack ? nearestKeyframe(activeTrack, playbackTime) : undefined;
  const review = useMemo(() => buildBrandMaskReview(tracks), [tracks]);

  function commitTracks(nextTracks: BrandMaskTrack[]) {
    onChange(nextTracks);
    if (!nextTracks.some((track) => track.id === activeTrackId)) {
      setActiveTrackId(nextTracks[0]?.id ?? "");
    }
  }

  function addTrack(targetType: BrandMaskTargetType) {
    const track: BrandMaskTrack = {
      id: createLocalId(`brand_mask_${targetType}`),
      label: targetType === "logo" ? `Logo遮罩 ${tracks.length + 1}` : targetType === "text" ? `文字遮罩 ${tracks.length + 1}` : `遮罩 ${tracks.length + 1}`,
      targetType,
      effect: brandMaskDefaultEffect(targetType),
      trackMode: "planar",
      expandRatio: targetType === "text" ? 0.12 : 0.18,
      confidenceThreshold: 0.62,
      keyframes: []
    };
    commitTracks([...tracks, track]);
    setActiveTrackId(track.id);
  }

  function updateTrack(trackId: string, patch: Partial<BrandMaskTrack>) {
    commitTracks(tracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track)));
  }

  function deleteTrack(trackId: string) {
    commitTracks(tracks.filter((track) => track.id !== trackId));
  }

  function deleteKeyframe(trackId: string, keyframeId: string) {
    commitTracks(
      tracks.map((track) =>
        track.id === trackId
          ? {
              ...track,
              keyframes: track.keyframes.filter((keyframe) => keyframe.id !== keyframeId)
            }
          : track
      )
    );
  }

  function jumpToKeyframe(keyframe: BrandMaskKeyframe) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, keyframe.time);
    video.pause();
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!sourcePreviewUrl) return;
    const point = normalizedPoint(event);
    if (!point) return;
    if (!activeTrack) return;
    setDragStart(point);
    setDraftRect({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart) return;
    const point = normalizedPoint(event);
    if (!point) return;
    setDraftRect(rectFromPoints(dragStart, point));
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart) return;
    const point = normalizedPoint(event);
    const rect = point ? rectFromPoints(dragStart, point) : draftRect;
    setDragStart(null);
    setDraftRect(null);
    const targetTrack = activeTrack ?? tracks[tracks.length - 1];
    if (!targetTrack || !rect || rect.width < 0.01 || rect.height < 0.01) return;
    const video = videoRef.current;
    const keyframe: BrandMaskKeyframe = {
      id: createLocalId("brand_mask_keyframe"),
      time: roundTime(video?.currentTime ?? 0),
      source: targetTrack.keyframes.length ? "correction" : "manual",
      shape: {
        type: "rect",
        ...rect
      }
    };
    commitTracks(
      tracks.map((track) =>
        track.id === targetTrack.id
          ? {
              ...track,
              keyframes: [...track.keyframes, keyframe].sort((left, right) => left.time - right.time)
            }
          : track
      )
    );
  }

  function normalizedPoint(event: PointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    const x = clamp01((event.clientX - rect.left) / rect.width);
    const y = clamp01((event.clientY - rect.top) / rect.height);
    return { x, y };
  }

  return (
    <div className="brand-mask-sheet" role="dialog" aria-modal="true" aria-labelledby="brand-mask-title">
      <div className="brand-mask-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Preprocess Mask</p>
            <h2 id="brand-mask-title">品牌/文字打码</h2>
            <small>{segment.title || "未命名段落"} · 处理原素材视频</small>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭品牌文字打码面板" title="关闭">
            <PanelTopClose size={16} />
          </button>
        </div>

        <div className="brand-mask-layout">
          <div className="brand-mask-workspace">
            <div
              ref={stageRef}
              className="brand-video-stage"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => {
                setDragStart(null);
                setDraftRect(null);
              }}
            >
              {sourcePreviewUrl ? (
                <video
                  ref={videoRef}
                  src={sourcePreviewUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                  onSeeked={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                  onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                />
              ) : (
                <div className="brand-video-missing">
                  <BadgeX size={34} />
                  <strong>需要先上传原素材视频</strong>
                  <span>品牌/文字打码只处理 sourceFile，不处理生成后的二创片段。</span>
                </div>
              )}
              {visibleKeyframe && <MaskRectOverlay rect={visibleKeyframe.shape} label={activeTrack?.label} />}
              {draftRect && <MaskRectOverlay rect={{ type: "rect", ...draftRect }} label="新增关键帧" draft />}
            </div>
            <div className="mask-review-strip">
              <ReviewPill tone="error" label="阻塞" value={review.errorCount} />
              <ReviewPill tone="warning" label="提示" value={review.warningCount} />
              <ReviewPill tone="ok" label="关键帧" value={review.keyframeCount} />
              <span>红色问题必须补帧或调整模式后才能进入导出。</span>
            </div>
          </div>

          <aside className="brand-mask-sidebar">
            <div className="button-row">
              <button className="secondary-button compact" onClick={() => addTrack("logo")}>
                <SquareDashedMousePointer size={14} />
                Logo
              </button>
              <button className="secondary-button compact" onClick={() => addTrack("text")}>
                <ScanText size={14} />
                文字
              </button>
            </div>

            {!tracks.length ? (
              <div className="mask-empty">
                <Plus size={26} />
                <strong>新增遮罩后，在视频画面拖拽矩形</strong>
                <span>拖拽一次会在当前帧生成一个人工关键帧。</span>
              </div>
            ) : (
              <div className="mask-track-list">
                {tracks.map((track) => (
                  <article className={`mask-track-card ${track.id === activeTrack?.id ? "active" : ""}`} key={track.id}>
                    <button className="mask-track-select" onClick={() => setActiveTrackId(track.id)}>
                      <strong>{track.label}</strong>
                      <span>{targetTypeLabel(track.targetType)} · {track.keyframes.length}个关键帧</span>
                    </button>
                    <div className="mask-control-grid">
                      <label>
                        <span>名称</span>
                        <input value={track.label} onChange={(event) => updateTrack(track.id, { label: event.target.value })} />
                      </label>
                      <label>
                        <span>类型</span>
                        <select
                          value={track.targetType}
                          onChange={(event) => {
                            const targetType = event.target.value as BrandMaskTargetType;
                            updateTrack(track.id, {
                              targetType,
                              effect: brandMaskDefaultEffect(targetType)
                            });
                          }}
                        >
                          <option value="logo">Logo</option>
                          <option value="text">品牌文字</option>
                          <option value="other">其他</option>
                        </select>
                      </label>
                      <label>
                        <span>遮挡</span>
                        <select value={track.effect} onChange={(event) => updateTrack(track.id, { effect: event.target.value as BrandMaskEffect })}>
                          <option value="mosaic">强马赛克</option>
                          <option value="solid">纯色遮挡</option>
                          <option value="blur">模糊</option>
                        </select>
                      </label>
                      <label>
                        <span>跟踪</span>
                        <select value={track.trackMode} onChange={(event) => updateTrack(track.id, { trackMode: event.target.value as BrandMaskTrackMode })}>
                          <option value="planar">ORB/SIFT + RANSAC</option>
                          <option value="optical-flow">LK光流</option>
                          <option value="interpolate">关键帧插值</option>
                          <option value="static">静态遮罩</option>
                          <option value="manual">仅手动帧</option>
                        </select>
                      </label>
                    </div>
                    <div className="keyframe-list">
                      {track.keyframes.map((keyframe) => (
                        <div className="keyframe-item" key={keyframe.id}>
                          <button onClick={() => jumpToKeyframe(keyframe)}>{formatTime(keyframe.time)}</button>
                          <span>{keyframe.source === "correction" ? "补打" : "人工"}</span>
                          <button className="icon-button danger" onClick={() => deleteKeyframe(track.id, keyframe.id)} aria-label="删除关键帧" title="删除关键帧">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button className="secondary-button compact danger-soft" onClick={() => deleteTrack(track.id)}>
                      <Trash2 size={14} />
                      删除遮罩
                    </button>
                  </article>
                ))}
              </div>
            )}

            <div className="mask-review-list">
              {review.issues.length ? (
                review.issues.map((issue) => (
                  <article className={`mask-review-issue ${issue.severity}`} key={`${issue.trackId}_${issue.reason}`}>
                    <AlertTriangle size={14} />
                    <span>{issue.reason}</span>
                  </article>
                ))
              ) : (
                <article className="mask-review-issue ok">
                  <Check size={14} />
                  <span>当前遮罩配置可进入预处理。</span>
                </article>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function MaskRectOverlay({
  rect,
  label,
  draft
}: {
  rect: DraftRect & { type: "rect" };
  label?: string;
  draft?: boolean;
}) {
  return (
    <div
      className={`mask-rect-overlay ${draft ? "draft" : ""}`}
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`
      }}
    >
      <span>{label}</span>
    </div>
  );
}

function ReviewPill({ tone, label, value }: { tone: "error" | "warning" | "ok"; label: string; value: number }) {
  return (
    <strong className={`review-pill ${tone}`}>
      {label} {value}
    </strong>
  );
}

function nearestKeyframe(track: BrandMaskTrack, time: number) {
  if (!track.keyframes.length) return undefined;
  return track.keyframes.reduce((best, keyframe) =>
    Math.abs(keyframe.time - time) < Math.abs(best.time - time) ? keyframe : best
  );
}

function rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): DraftRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function createLocalId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function roundTime(value: number) {
  return Math.round(value * 1000) / 1000;
}

function formatTime(value: number) {
  return `${value.toFixed(2)}s`;
}

function targetTypeLabel(value: BrandMaskTargetType) {
  if (value === "logo") return "Logo";
  if (value === "text") return "品牌文字";
  return "其他";
}
