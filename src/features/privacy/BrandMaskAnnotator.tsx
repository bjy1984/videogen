import { AlertTriangle, BadgeX, Check, ExternalLink, Loader2, PanelTopClose, Plus, ScanFace, SquareDashedMousePointer, Trash2 } from "lucide-react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BrandMaskEffect, BrandMaskKeyframe, BrandMaskScaleMode, BrandMaskTargetType, BrandMaskTrack, BrandMaskTrackMode, BrandMaskTrackingEngine, FaceMosaicEffect, VideoPreprocessTrace, VideoSegment } from "../../types";
import { preprocessBrandMaskBridge } from "../../services/videoGenerationBridgeClient";
import { brandMaskDefaultEffect, brandMaskDefaultStrength, normalizeMaskStrength } from "../script/privacyEdits";
import { buildBrandMaskReview } from "./brandMaskReview";

interface BrandMaskAnnotatorProps {
  segment: VideoSegment;
  sourcePreviewUrl: string;
  bridgeUrl?: string;
  facePreviewSegmentId: string;
  facePreviewError?: string;
  onToggleFaceMosaic: () => void;
  onChangeFaceMosaicEffect: (effect: FaceMosaicEffect) => void;
  onChangeFaceMosaicStrength: (strength: number) => void;
  onPreviewFaceMosaic: () => void;
  onChange: (tracks: BrandMaskTrack[]) => void;
  onPreviewTrace?: (trace: VideoPreprocessTrace) => void;
  onClose: () => void;
}

interface DraftRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type TrackingPreviewMode = BrandMaskTrackingEngine | "compare";

const COMPARISON_ENGINES: BrandMaskTrackingEngine[] = [
  "opencv",
  "homography",
  "vittrack",
  "mixformer",
  "ddrnet",
  "track-anything",
  "mask-tracking"
];

export function BrandMaskAnnotator({
  segment,
  sourcePreviewUrl,
  bridgeUrl,
  facePreviewSegmentId,
  facePreviewError,
  onToggleFaceMosaic,
  onChangeFaceMosaicEffect,
  onChangeFaceMosaicStrength,
  onPreviewFaceMosaic,
  onChange,
  onPreviewTrace,
  onClose
}: BrandMaskAnnotatorProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const tracks = segment.privacyEdits?.brandMasks ?? [];
  const [activeTrackId, setActiveTrackId] = useState(tracks[0]?.id ?? "");
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draftRect, setDraftRect] = useState<DraftRect | null>(null);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoSize, setVideoSize] = useState({ width: 9, height: 16 });
  const [trackingPreviewUrl, setTrackingPreviewUrl] = useState("");
  const [trackingPreviewState, setTrackingPreviewState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [trackingPreviewError, setTrackingPreviewError] = useState("");
  const [trackingPreviewElapsed, setTrackingPreviewElapsed] = useState(0);
  const [trackingPreviewTrace, setTrackingPreviewTrace] = useState<VideoPreprocessTrace>();
  const [trackingPreviewResults, setTrackingPreviewResults] = useState<VideoPreprocessTrace[]>([]);
  const [trackingPreviewMode, setTrackingPreviewMode] = useState<TrackingPreviewMode>("opencv");
  const [showTrackingPreview, setShowTrackingPreview] = useState(false);
  const [showFacePreview, setShowFacePreview] = useState(false);
  const [facePreviewElapsed, setFacePreviewElapsed] = useState(0);

  const faceMosaicEnabled = Boolean(segment.privacyEdits?.faceMosaic);
  const faceMosaicEffect = segment.privacyEdits?.faceMosaicEffect ?? "mosaic";
  const faceMosaicStrength = normalizeMaskStrength(segment.privacyEdits?.faceMosaicStrength);
  const faceTrace = segment.privacyEdits?.faceMosaicPreprocess;
  const facePreviewUrl = faceTrace?.outputVideoUrl ?? "";
  const isFacePreviewRunning = facePreviewSegmentId === segment.id;
  const activeTrack = tracks.find((track) => track.id === activeTrackId) ?? tracks[0];
  const visibleMask = activeTrack ? previewMaskForTrack(activeTrack, playbackTime) : undefined;
  const review = useMemo(() => buildBrandMaskReview(tracks), [tracks]);
  const videoAspect = `${videoSize.width} / ${videoSize.height}`;
  const displayVideoUrl = showTrackingPreview && trackingPreviewUrl
    ? trackingPreviewUrl
    : showFacePreview && facePreviewUrl
      ? facePreviewUrl
      : sourcePreviewUrl;
  const isPreviewMode = Boolean((showTrackingPreview && trackingPreviewUrl) || (showFacePreview && facePreviewUrl));
  const facePreviewProgress = Math.min(92, 12 + facePreviewElapsed * 4);
  const trackingPreviewProgress = Math.min(92, 10 + trackingPreviewElapsed * 5);

  useEffect(() => {
    if (isFacePreviewRunning) {
      setShowFacePreview(false);
      setShowTrackingPreview(false);
    }
  }, [isFacePreviewRunning]);

  useEffect(() => {
    if (!isFacePreviewRunning) {
      setFacePreviewElapsed(0);
      return;
    }
    const startedAt = Date.now();
    setFacePreviewElapsed(0);
    const intervalId = window.setInterval(() => {
      setFacePreviewElapsed(Math.max(1, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [isFacePreviewRunning]);

  useEffect(() => {
    if (trackingPreviewState !== "running") {
      setTrackingPreviewElapsed(0);
      return;
    }
    const startedAt = Date.now();
    setTrackingPreviewElapsed(0);
    const intervalId = window.setInterval(() => {
      setTrackingPreviewElapsed(Math.max(1, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [trackingPreviewState]);

  useEffect(() => {
    if (!faceMosaicEnabled || !facePreviewUrl) {
      setShowFacePreview(false);
      return;
    }
    setShowFacePreview(true);
    setShowTrackingPreview(false);
  }, [faceMosaicEnabled, facePreviewUrl]);

  function commitTracks(nextTracks: BrandMaskTrack[]) {
    setTrackingPreviewUrl("");
    setTrackingPreviewState("idle");
    setTrackingPreviewError("");
    setTrackingPreviewTrace(undefined);
    setTrackingPreviewResults([]);
    setShowTrackingPreview(false);
    setShowFacePreview(false);
    onChange(nextTracks);
    if (!nextTracks.some((track) => track.id === activeTrackId)) {
      setActiveTrackId(nextTracks[0]?.id ?? "");
    }
  }

  function addTrack(targetType: BrandMaskTargetType) {
    const track: BrandMaskTrack = {
      id: createLocalId(`brand_mask_${targetType}`),
      label: `追踪目标 ${tracks.length + 1}`,
      targetType,
      effect: brandMaskDefaultEffect(targetType),
      strength: brandMaskDefaultStrength(),
      trackMode: "planar",
      scaleMode: "locked",
      expandRatio: 0.06,
      confidenceThreshold: 0.45,
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

  function activateTrackingPreviewTrace(trace: VideoPreprocessTrace) {
    const issues = trace.issues ?? [];
    onChange(tracks.map((track) => ({
      ...track,
      reviewIssues: issues.filter((issue) => issue.trackId === track.id)
    })));
    onPreviewTrace?.(trace);
    setTrackingPreviewUrl(trace.outputVideoUrl || "");
    setTrackingPreviewTrace(trace);
    setShowFacePreview(false);
    setShowTrackingPreview(Boolean(trace.outputVideoUrl));
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
    setPlaybackTime(video.currentTime);
    setIsPlaying(false);
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch((error) => {
        setIsPlaying(false);
        setTrackingPreviewError(videoPlaybackErrorMessage(error, isPreviewMode));
      });
    } else {
      video.pause();
    }
  }

  function seekTo(value: string) {
    const video = videoRef.current;
    if (!video) return;
    const nextTime = Number(value);
    if (!Number.isFinite(nextTime)) return;
    video.currentTime = nextTime;
    setPlaybackTime(nextTime);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!sourcePreviewUrl || isPreviewMode) return;
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

  async function runTrackingPreview() {
    if (!sourcePreviewUrl || !tracks.length || review.errorCount || trackingPreviewState === "running") return;
    const engines: BrandMaskTrackingEngine[] = trackingPreviewMode === "compare" ? COMPARISON_ENGINES : [trackingPreviewMode];
    setTrackingPreviewState("running");
    setTrackingPreviewError("");
    setTrackingPreviewTrace(undefined);
    setTrackingPreviewResults([]);
    setShowTrackingPreview(false);
    try {
      const response = await fetch(sourcePreviewUrl);
      if (!response.ok) throw new Error("无法读取当前原素材预览视频。");
      const blob = await response.blob();

      const nextResults: VideoPreprocessTrace[] = [];
      const errors: string[] = [];
      for (const engine of engines) {
        try {
          const video = new File([blob], `${segment.id || "source"}_${engine}_mask_source.mp4`, {
            type: blob.type || "video/mp4"
          });
          const result = await preprocessBrandMaskBridge({
            bridgeUrl,
            projectId: "brand_mask_preview",
            segmentId: segment.id,
            sourceRange: segment.role,
            video,
            blockOnRed: false,
            trackingEngine: engine,
            tracks
          });
          if (!result.trace.outputVideoUrl) throw new Error("预处理完成，但未返回输出视频地址。");
          nextResults.push(result.trace);
        } catch (error) {
          const message = error instanceof Error ? error.message : "物体追踪预览失败。";
          errors.push(`${trackingEngineLabel(engine)}：${message}`);
          if (engines.length === 1) throw error;
        }
      }

      if (!nextResults.length) {
        throw new Error(errors.length ? errors.join("；") : "物体追踪预览失败。");
      }

      const selectedTrace = selectPreferredPreviewTrace(nextResults, trackingPreviewMode);
      setTrackingPreviewResults(nextResults);
      activateTrackingPreviewTrace(selectedTrace);
      setTrackingPreviewState("done");
      if (errors.length) {
        setTrackingPreviewError(`部分对比失败：${errors.join("；")}`);
      }
    } catch (error) {
      setTrackingPreviewState("failed");
      setTrackingPreviewError(error instanceof Error ? error.message : "物体追踪预览失败。");
    }
  }

  return (
    <div className="brand-mask-sheet" role="dialog" aria-modal="true" aria-labelledby="brand-mask-title">
      <div className="brand-mask-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">预处理遮罩</p>
            <h2 id="brand-mask-title">预处理打码</h2>
            <small>{segment.title || "未命名段落"} · 人脸逐帧 + 物体追踪 sourceFile</small>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭预处理打码面板" title="关闭">
            <PanelTopClose size={16} />
          </button>
        </div>

        <div className="brand-mask-layout">
          <div className="brand-mask-workspace">
            <div
              ref={stageRef}
              className={`brand-video-stage ${isPreviewMode ? "preview-mode" : ""}`}
              style={{ "--video-aspect": videoAspect } as CSSProperties}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => {
                setDragStart(null);
                setDraftRect(null);
              }}
            >
              {displayVideoUrl ? (
                <video
                  ref={videoRef}
                  src={displayVideoUrl}
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    setPlaybackTime(event.currentTarget.currentTime);
                    setDuration(event.currentTarget.duration || 0);
                    setVideoSize({
                      width: event.currentTarget.videoWidth || 9,
                      height: event.currentTarget.videoHeight || 16
                    });
                  }}
                  onSeeked={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                  onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                  onError={() => {
                    setIsPlaying(false);
                    setTrackingPreviewError(videoLoadErrorMessage(videoRef.current?.error ?? null, isPreviewMode));
                  }}
                />
              ) : (
                <div className="brand-video-missing">
                  <BadgeX size={34} />
                  <strong>需要先上传原素材视频</strong>
                  <span>预处理打码只处理 sourceFile，不处理生成后的二创片段。</span>
                </div>
              )}
              {!isPreviewMode && visibleMask && <MaskRectOverlay rect={visibleMask.shape} label={visibleMask.label} />}
              {!isPreviewMode && draftRect && <MaskRectOverlay rect={{ type: "rect", ...draftRect }} label="新增关键帧" draft />}
            </div>
            <div className="brand-video-controls">
              <button className="secondary-button compact" onClick={togglePlayback} disabled={!displayVideoUrl}>
                {isPlaying ? "暂停" : "播放"}
              </button>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.04}
                value={Math.min(playbackTime, duration || playbackTime)}
                onChange={(event) => seekTo(event.target.value)}
                aria-label="视频时间轴"
                disabled={!duration}
              />
              <span>{formatTime(playbackTime)} / {formatTime(duration)}</span>
            </div>
            <div className="mask-review-strip">
              <ReviewPill tone="error" label="阻塞" value={review.errorCount} />
              <ReviewPill tone="warning" label="提示" value={review.warningCount} />
              <ReviewPill tone="ok" label="关键帧" value={review.keyframeCount} />
              <span>人脸预览逐帧处理；物体遮罩预览会执行 CV 跟踪。</span>
            </div>
          </div>

          <aside className="brand-mask-sidebar">
            <div className="privacy-tool-card">
              <div className="privacy-tool-title">
                <ScanFace size={15} />
                <div>
                  <strong>人脸打码</strong>
                  <span>{faceMosaicEnabled ? "已加入生成前预处理链路" : "未启用"}</span>
                </div>
              </div>
              <div className="privacy-tool-actions">
                <button className="secondary-button compact" onClick={onToggleFaceMosaic}>
                  {faceMosaicEnabled ? "取消人脸" : "启用人脸"}
                </button>
                <button
                  className="secondary-button compact"
                  onClick={onPreviewFaceMosaic}
                  disabled={!faceMosaicEnabled || !sourcePreviewUrl || isFacePreviewRunning}
                >
                  {isFacePreviewRunning ? (
                    <>
                      <Loader2 className="spin" size={14} />
                      处理中
                    </>
                  ) : "运行人脸预览"}
                </button>
              </div>
              <label className="mask-engine-select">
                <span>人脸遮挡</span>
                <select
                  value={faceMosaicEffect}
                  onChange={(event) => onChangeFaceMosaicEffect(event.target.value as FaceMosaicEffect)}
                  disabled={isFacePreviewRunning}
                >
                  <option value="mosaic">马赛克</option>
                  <option value="blur">高斯模糊</option>
                  <option value="solid">色块遮挡</option>
                </select>
              </label>
              <label className="mask-strength-control">
                <span>人脸强度 {formatPercent(faceMosaicStrength)}</span>
                <input
                  type="range"
                  min={0.2}
                  max={1}
                  step={0.05}
                  value={faceMosaicStrength}
                  onChange={(event) => onChangeFaceMosaicStrength(normalizeMaskStrength(event.target.value))}
                  disabled={isFacePreviewRunning}
                  aria-label="调整人脸打码强度"
                />
              </label>
              {isFacePreviewRunning && (
                <div className="privacy-tool-progress" role="status" aria-live="polite">
                  <div className="privacy-tool-progress-head">
                    <Loader2 className="spin" size={15} />
                    <div>
                      <strong>正在逐帧处理人脸</strong>
                      <span>已耗时 {facePreviewElapsed} 秒，正在检测人脸、写入遮罩并合成预览视频。</span>
                    </div>
                  </div>
                  <div className="privacy-progress-bar" aria-label="人脸预览处理进度">
                    <span style={{ width: `${facePreviewProgress}%` }} />
                  </div>
                </div>
              )}
              {facePreviewError && !isFacePreviewRunning && (
                <div className="privacy-tool-error" role="alert">
                  <AlertTriangle size={14} />
                  <span>{facePreviewError}</span>
                </div>
              )}
              {faceTrace && (
                <div className={`privacy-tool-summary ${faceTrace.status}`}>
                  <strong>{preprocessStatusLabel(faceTrace.status)}</strong>
                  <span>{preprocessSummaryText(faceTrace.summary)}</span>
                </div>
              )}
              {faceTrace?.outputVideoUrl && (
                <div className="privacy-tool-actions stacked-actions">
                  <button
                    className="secondary-button compact full-width"
                    onClick={() => {
                      setShowFacePreview((value) => !value);
                      setShowTrackingPreview(false);
                    }}
                  >
                    {showFacePreview ? "返回原视频" : "覆盖预览人脸结果"}
                  </button>
                  <button
                    className="secondary-button compact full-width"
                    onClick={() => window.open(faceTrace.outputVideoUrl, "_blank", "noopener,noreferrer")}
                  >
                    <ExternalLink size={14} />
                    新窗口查看
                  </button>
                </div>
              )}
            </div>

            <div className="privacy-tool-card">
              <div className="privacy-tool-title">
                <SquareDashedMousePointer size={15} />
                <div>
                  <strong>物体追踪打码</strong>
                  <span>框选视频画面里任意需要遮挡的目标。</span>
                </div>
              </div>
              <button className="secondary-button compact full-width" onClick={() => addTrack("other")}>
                <Plus size={14} />
                新增追踪目标
              </button>
            </div>

            <div className="mask-preview-actions">
              <label className="mask-engine-select">
                <span>预览引擎</span>
                <select
                  value={trackingPreviewMode}
                  onChange={(event) => setTrackingPreviewMode(event.target.value as TrackingPreviewMode)}
                  disabled={trackingPreviewState === "running"}
                >
                  <option value="opencv">OpenCV 本地</option>
                  <option value="homography">Homography 平面目标</option>
                  <option value="vittrack">OpenCV ViTTrack</option>
                  <option value="mixformer">MixFormerV2-S</option>
                  <option value="ddrnet">DDRNet语义分割</option>
                  <option value="track-anything">Track-Anything</option>
                  <option value="mask-tracking">Mask Tracking</option>
                  <option value="compare">多引擎对比</option>
                </select>
              </label>
              <button
                className="secondary-button compact"
                onClick={runTrackingPreview}
                disabled={!tracks.length || Boolean(review.errorCount) || !sourcePreviewUrl || trackingPreviewState === "running"}
              >
                {trackingPreviewState === "running" ? (
                  <>
                    <Loader2 className="spin" size={14} />
                    处理中
                  </>
                ) : `运行${trackingEngineLabel(trackingPreviewMode)}预览`}
              </button>
              {trackingPreviewUrl && (
                <button
                  className="secondary-button compact"
                  onClick={() => {
                    setShowTrackingPreview((value) => {
                      const next = !value;
                      if (next) setShowFacePreview(false);
                      return next;
                    });
                  }}
                >
                  {showTrackingPreview ? "返回标注" : "查看结果"}
                </button>
              )}
            </div>
            {trackingPreviewState === "running" && (
              <div className="privacy-tool-progress" role="status" aria-live="polite">
                <div className="privacy-tool-progress-head">
                  <Loader2 className="spin" size={15} />
                  <div>
                    <strong>正在执行{trackingEngineLabel(trackingPreviewMode)}预览</strong>
                    <span>已耗时 {trackingPreviewElapsed} 秒，正在跟踪关键帧、生成遮罩并导出预览视频。</span>
                  </div>
                </div>
                <div className="privacy-progress-bar" aria-label="物体追踪预览进度">
                  <span style={{ width: `${trackingPreviewProgress}%` }} />
                </div>
              </div>
            )}
            {trackingPreviewResults.length > 1 && (
              <div className="mask-result-tabs" aria-label="选择物体追踪预览结果">
                {trackingPreviewResults.map((trace) => (
                  <button
                    className={trace.id === trackingPreviewTrace?.id ? "active" : ""}
                    onClick={() => activateTrackingPreviewTrace(trace)}
                    key={trace.id}
                  >
                    {trackingEngineLabel(trace.summary?.trackingEngine)}
                  </button>
                ))}
              </div>
            )}
            {trackingPreviewTrace && trackingPreviewState === "done" && (
              <div className="privacy-tool-summary done">
                <strong>{trackingEngineLabel(trackingPreviewTrace.summary?.trackingEngine)}预览已完成</strong>
                <span>{preprocessSummaryText(trackingPreviewTrace.summary)}</span>
              </div>
            )}
            {trackingPreviewError && <div className="mask-preview-error" role="alert">{trackingPreviewError}</div>}

            {!tracks.length ? (
              <div className="mask-empty">
                <Plus size={26} />
                <strong>新增追踪目标后，在视频画面拖拽矩形</strong>
                <span>拖拽一次会在当前帧生成一个人工关键帧。</span>
              </div>
            ) : (
              <div className="mask-track-list">
                {tracks.map((track) => (
                  <article className={`mask-track-card ${track.id === activeTrack?.id ? "active" : ""}`} key={track.id}>
                    <button className="mask-track-select" onClick={() => setActiveTrackId(track.id)}>
                      <strong>{track.label}</strong>
                      <span>物体追踪 · {track.keyframes.length}个关键帧</span>
                    </button>
                    <div className="mask-control-grid">
                      <label>
                        <span>名称</span>
                        <input value={track.label} onChange={(event) => updateTrack(track.id, { label: event.target.value })} />
                      </label>
                      <label>
                        <span>遮挡</span>
                        <select value={track.effect} onChange={(event) => updateTrack(track.id, { effect: event.target.value as BrandMaskEffect })}>
                          <option value="mosaic">强马赛克</option>
                          <option value="solid">纯色遮挡</option>
                          <option value="blur">模糊</option>
                        </select>
                      </label>
                      <label className="mask-control-wide">
                        <span>强度 {formatPercent(normalizeMaskStrength(track.strength))}</span>
                        <input
                          type="range"
                          min={0.2}
                          max={1}
                          step={0.05}
                          value={normalizeMaskStrength(track.strength)}
                          onChange={(event) => updateTrack(track.id, { strength: normalizeMaskStrength(event.target.value) })}
                          aria-label={`${track.label} 打码强度`}
                        />
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
                      <label>
                        <span>尺寸</span>
                        <select value={track.scaleMode ?? "locked"} onChange={(event) => updateTrack(track.id, { scaleMode: event.target.value as BrandMaskScaleMode })}>
                          <option value="locked">锁定尺寸</option>
                          <option value="slow-zoom">慢速变焦</option>
                          <option value="free">自由缩放</option>
                        </select>
                      </label>
                      <label>
                        <span>阈值</span>
                        <input
                          type="number"
                          min={0.2}
                          max={0.9}
                          step={0.05}
                          value={track.confidenceThreshold}
                          onChange={(event) => updateTrack(track.id, { confidenceThreshold: normalizeConfidenceThreshold(event.target.value) })}
                        />
                      </label>
                      <label className="mask-control-wide">
                        <span>边距 {formatPercent(clampExpandRatio(track.expandRatio))}</span>
                        <input
                          type="range"
                          min={0}
                          max={0.12}
                          step={0.01}
                          value={clampExpandRatio(track.expandRatio)}
                          onChange={(event) => updateTrack(track.id, { expandRatio: normalizeExpandRatio(event.target.value) })}
                        />
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

            <div className="mask-usage-note">
              <strong>使用顺序</strong>
              <span>1. 新增追踪目标  2. 在首帧框住要遮挡的物体  3. 拖到漂移处补关键帧  4. 运行预览确认。默认小边距，整块同强度打码。</span>
            </div>

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
                  <span>当前物体追踪遮罩可进入预处理。</span>
                </article>
              )}
            </div>
          </aside>
        </div>
        <MaskTimeline
          tracks={tracks}
          duration={duration}
          playbackTime={playbackTime}
          activeTrackId={activeTrack?.id ?? ""}
          issues={review.issues}
          onTrack={(trackId) => setActiveTrackId(trackId)}
          onKeyframe={jumpToKeyframe}
          onSeek={(time) => seekTo(String(time))}
        />
      </div>
    </div>
  );
}

function MaskTimeline({
  tracks,
  duration,
  playbackTime,
  activeTrackId,
  issues,
  onTrack,
  onKeyframe,
  onSeek
}: {
  tracks: BrandMaskTrack[];
  duration: number;
  playbackTime: number;
  activeTrackId: string;
  issues: ReturnType<typeof buildBrandMaskReview>["issues"];
  onTrack: (trackId: string) => void;
  onKeyframe: (keyframe: BrandMaskKeyframe) => void;
  onSeek: (time: number) => void;
}) {
  const timelineDuration = Math.max(
    1,
    duration || 0,
    ...tracks.flatMap((track) => track.keyframes.map((keyframe) => keyframe.time))
  );
  const playheadLeft = `${Math.min(100, Math.max(0, (playbackTime / timelineDuration) * 100))}%`;
  return (
    <section className="mask-timeline" aria-label="物体追踪打码时间轴">
      <div className="mask-timeline-header">
        <strong>时间轴</strong>
        <span>点击关键帧定位，拖动上方时间条后在画面补框。</span>
      </div>
      <div className="mask-timeline-body">
        <button className="timeline-ruler" onClick={(event) => onSeek(timeFromPointer(event, timelineDuration))} aria-label="跳转时间轴位置">
          <span className="timeline-playhead" style={{ left: playheadLeft }} />
        </button>
        {!tracks.length ? (
          <div className="timeline-empty-row">新增追踪目标后，这里会显示关键帧轨道。</div>
        ) : (
          tracks.map((track) => (
            <div className={`timeline-track-row ${track.id === activeTrackId ? "active" : ""}`} key={track.id}>
              <button className="timeline-track-label" onClick={() => onTrack(track.id)}>
                <strong>{track.label}</strong>
                <span>物体追踪</span>
              </button>
              <div className="timeline-track-lane">
                {track.keyframes.map((keyframe) => (
                  <button
                    className={`timeline-keyframe ${keyframe.source}`}
                    style={{ left: `${Math.min(100, Math.max(0, (keyframe.time / timelineDuration) * 100))}%` }}
                    onClick={() => {
                      onTrack(track.id);
                      onKeyframe(keyframe);
                    }}
                    aria-label={`${track.label} ${formatTime(keyframe.time)}关键帧`}
                    title={`${track.label} · ${formatTime(keyframe.time)}`}
                    key={keyframe.id}
                  />
                ))}
                {issues
                  .filter((issue) => issue.trackId === track.id)
                  .map((issue) => (
                    <span
                      className={`timeline-issue-marker ${issue.severity}`}
                      style={{ left: `${Math.min(100, Math.max(0, (issue.time / timelineDuration) * 100))}%` }}
                      title={issue.reason}
                      key={`${issue.trackId}_${issue.severity}_${issue.time}_${issue.reason}`}
                    />
                  ))}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function previewMaskForTrack(track: BrandMaskTrack, time: number) {
  if (!track.keyframes.length) return undefined;
  const keyframes = [...track.keyframes].sort((left, right) => left.time - right.time);
  const exact = keyframes.find((keyframe) => Math.abs(keyframe.time - time) < 0.04);
  if (exact) {
    return {
      shape: exact.shape,
      label: track.label
    };
  }

  const canInterpolate = track.trackMode === "interpolate" || track.trackMode === "planar" || track.trackMode === "optical-flow";
  if (canInterpolate) {
    const left = [...keyframes].reverse().find((keyframe) => keyframe.time < time);
    const right = keyframes.find((keyframe) => keyframe.time > time);
    if (left && right) {
      const span = Math.max(0.001, right.time - left.time);
      const progress = clamp01((time - left.time) / span);
      return {
        shape: {
          type: "rect" as const,
          x: interpolateNumber(left.shape.x, right.shape.x, progress),
          y: interpolateNumber(left.shape.y, right.shape.y, progress),
          width: interpolateNumber(left.shape.width, right.shape.width, progress),
          height: interpolateNumber(left.shape.height, right.shape.height, progress)
        },
        label: `${track.label} · 路径预览`
      };
    }
  }

  const nearest = nearestKeyframe(track, time);
  if (!nearest) return undefined;
  return {
    shape: nearest.shape,
    label: keyframes.length < 2 && canInterpolate ? `${track.label} · 单关键帧` : track.label
  };
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

function timeFromPointer(event: MouseEvent<HTMLButtonElement>, duration: number) {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0;
  return Math.min(duration, Math.max(0, ratio * duration));
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

function interpolateNumber(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
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

function normalizeConfidenceThreshold(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.45;
  return Math.min(0.9, Math.max(0.2, Math.round(parsed * 100) / 100));
}

function normalizeExpandRatio(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.06;
  return clampExpandRatio(Math.round(parsed * 100) / 100);
}

function clampExpandRatio(value: number) {
  if (!Number.isFinite(value)) return 0.06;
  return Math.min(0.12, Math.max(0, value));
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function selectPreferredPreviewTrace(results: VideoPreprocessTrace[], mode: TrackingPreviewMode) {
  if (mode !== "compare") {
    return results.find((trace) => trace.summary?.trackingEngine === mode) ?? results[0];
  }
  return results.find((trace) => trace.summary?.trackingEngine === "mask-tracking") ??
    results.find((trace) => trace.summary?.trackingEngine === "ddrnet") ??
    results.find((trace) => trace.summary?.trackingEngine === "homography") ??
    results.find((trace) => trace.summary?.trackingEngine === "track-anything") ??
    results.find((trace) => trace.summary?.trackingEngine === "mixformer") ??
    results.find((trace) => trace.summary?.trackingEngine === "vittrack") ??
    results[0];
}

function trackingEngineLabel(engine?: BrandMaskTrackingEngine | TrackingPreviewMode) {
  if (engine === "mask-tracking") return "Mask Tracking";
  if (engine === "track-anything") return "Track-Anything";
  if (engine === "mixformer") return "MixFormerV2-S";
  if (engine === "ddrnet") return "DDRNet语义分割";
  if (engine === "vittrack") return "ViTTrack";
  if (engine === "homography") return "Homography";
  if (engine === "compare") return "多引擎对比";
  return "OpenCV本地";
}

function preprocessStatusLabel(status: string) {
  if (status === "done") return "已完成";
  if (status === "running") return "处理中";
  if (status === "failed") return "失败";
  if (status === "skipped") return "已跳过";
  return "待处理";
}

function preprocessSummaryText(summary?: VideoPreprocessTrace["summary"]) {
  if (!summary) return "暂无处理统计";
  const extendedSummary = summary as VideoPreprocessTrace["summary"] & { frames?: number; sourceFrameCount?: number };
  const frameCount = summary.frameCount ?? extendedSummary.frames ?? extendedSummary.sourceFrameCount;
  const parts = [
    summary.trackingEngine ? trackingEngineLabel(summary.trackingEngine) : "",
    frameCount !== undefined ? `${frameCount}帧` : "",
    summary.durationSec !== undefined ? `${summary.durationSec.toFixed(2)}秒素材` : "",
    summary.recoveredFrames !== undefined ? `找回${summary.recoveredFrames}帧` : "",
    summary.skippedLowConfidenceFrames !== undefined ? `跳过低置信${summary.skippedLowConfidenceFrames}帧` : "",
    summary.skippedScaleFrames !== undefined ? `跳过尺度异常${summary.skippedScaleFrames}帧` : "",
    summary.skippedTrackingFrames !== undefined ? `跳过追踪异常${summary.skippedTrackingFrames}帧` : "",
    summary.elapsedSec !== undefined ? `耗时${summary.elapsedSec.toFixed(2)}秒` : ""
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "暂无处理统计";
}

function formatTime(value: number) {
  return `${value.toFixed(2)}s`;
}

function videoPlaybackErrorMessage(error: unknown, isPreviewMode: boolean) {
  const target = isPreviewMode ? "预处理结果视频" : "原素材视频";
  const detail = error instanceof Error && error.message ? `：${error.message}` : "。";
  return `${target}无法播放${detail}`;
}

function videoLoadErrorMessage(error: MediaError | null, isPreviewMode: boolean) {
  const target = isPreviewMode ? "预处理结果视频" : "原素材视频";
  if (!error) {
    return `${target}加载失败，请检查视频文件或重新运行预览。`;
  }
  const reasonByCode: Record<number, string> = {
    [MediaError.MEDIA_ERR_ABORTED]: "加载被中断",
    [MediaError.MEDIA_ERR_NETWORK]: "网络或本地服务不可达",
    [MediaError.MEDIA_ERR_DECODE]: "视频解码失败",
    [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: "视频地址不存在或格式不受浏览器支持"
  };
  const reason = reasonByCode[error.code] || "未知媒体错误";
  return `${target}加载失败：${reason}。请检查 Bridge URL、输出文件是否存在，或重新运行预览。`;
}
