import { CheckCircle2, FileVideo, Gauge, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { normalizeVideoGenerationBridgeUrl, preprocessFaceMosaicBridge } from "../../services/videoGenerationBridgeClient";
import type { BrandMaskTrack, FaceMosaicEffect, VideoPreprocessTrace, VideoSegment } from "../../types";
import { applyPreprocessTraces, setSegmentBrandMasks, setSegmentFaceMosaic, setSegmentFaceMosaicEffect, setSegmentFaceMosaicStrength } from "../script/privacyEdits";
import { BrandMaskAnnotator } from "./BrandMaskAnnotator";
import { buildBrandMaskReview } from "./brandMaskReview";

export function MaskTestPage({
  bridgeUrl
}: {
  bridgeUrl: string;
}) {
  const [videoFile, setVideoFile] = useState<File>();
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState("");
  const [segment, setSegment] = useState<VideoSegment>(() => createTestSegment());
  const [isAnnotatorOpen, setIsAnnotatorOpen] = useState(false);
  const [facePreviewSegmentId, setFacePreviewSegmentId] = useState("");
  const [facePreviewError, setFacePreviewError] = useState("");
  const [statusText, setStatusText] = useState("选择一个本地视频后，可以直接测试人脸打码和物体追踪打码。");

  useEffect(() => {
    return () => {
      if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    };
  }, [sourcePreviewUrl]);

  const review = useMemo(() => buildBrandMaskReview(segment.privacyEdits?.brandMasks ?? []), [segment.privacyEdits?.brandMasks]);
  const faceTrace = segment.privacyEdits?.faceMosaicPreprocess;
  const brandTrace = segment.privacyEdits?.brandMaskPreprocess;
  const displayBridgeUrl = normalizeVideoGenerationBridgeUrl(bridgeUrl);

  function handleFile(file?: File) {
    if (!file) return;
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    const nextPreviewUrl = URL.createObjectURL(file);
    setVideoFile(file);
    setSourcePreviewUrl(nextPreviewUrl);
    setSegment({
      ...createTestSegment(),
      title: file.name,
      sourceFile: file
    });
    setFacePreviewError("");
    setStatusText("本地视频已加载。已打开打码工作台，可以直接运行人脸预览或新增物体追踪目标。");
    setIsAnnotatorOpen(true);
  }

  function updateDuration(duration: number) {
    if (!Number.isFinite(duration) || duration <= 0) return;
    setSegment((current) => ({
      ...current,
      duration: Math.round(duration * 100) / 100,
      role: `0-${duration.toFixed(2)}秒`
    }));
  }

  function toggleFaceMosaic() {
    setSegment((current) => {
      const enabled = !current.privacyEdits?.faceMosaic;
      setFacePreviewError("");
      setStatusText(enabled ? "已启用人脸打码。点击“运行人脸预览”会处理当前本地视频。" : "已取消人脸打码。");
      return setSegmentFaceMosaic(current, enabled);
    });
  }

  async function previewFaceMosaic() {
    if (!videoFile) {
      setStatusText("请先选择一个本地视频。");
      return;
    }
    if (facePreviewSegmentId) return;
    setFacePreviewSegmentId(segment.id);
    setFacePreviewError("");
    setStatusText("正在运行人脸打码预览。当前使用快速预览路径，生成导出仍走高精度预处理。");
    try {
      const result = await preprocessFaceMosaicBridge({
        bridgeUrl,
        projectId: "mask_test",
        segmentId: segment.id,
        sourceRange: segment.role,
        preview: true,
        effect: segment.privacyEdits?.faceMosaicEffect ?? "mosaic",
        strength: segment.privacyEdits?.faceMosaicStrength ?? 0.85,
        video: videoFile
      });
      setSegment((current) => applyPreprocessTraces(current, [result.trace]));
      const summary = result.trace.summary as (VideoPreprocessTrace["summary"] & { frames?: number; sourceFrameCount?: number }) | undefined;
      setStatusText(`人脸打码预览完成：${summary?.frameCount ?? summary?.frames ?? summary?.sourceFrameCount ?? 0}帧，耗时 ${summary?.elapsedSec ?? "-"} 秒。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setFacePreviewError(message);
      setStatusText(`人脸打码预览失败：${message}`);
    } finally {
      setFacePreviewSegmentId("");
    }
  }

  function updateBrandMasks(brandMasks: BrandMaskTrack[]) {
    setSegment((current) => setSegmentBrandMasks(current, brandMasks));
    const keyframes = brandMasks.reduce((total, track) => total + track.keyframes.length, 0);
    setStatusText(`物体追踪打码已更新：${brandMasks.length}个目标，${keyframes}个关键帧。`);
  }

  return (
    <>
      <section className="workspace mask-test-layout">
        <div className="panel mask-test-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Local Mask Test</p>
              <h2>本地打码与片段编辑测试台</h2>
            </div>
            <button className="secondary-button" onClick={() => setIsAnnotatorOpen(true)} disabled={!sourcePreviewUrl}>
              <ShieldCheck size={16} />
              打开打码工作台
            </button>
          </div>

          <label className="upload-box mask-test-upload">
            <Upload size={30} />
            <strong>选择本地视频测试打码</strong>
            <small>不会写入工程流程；只用于验证人脸逐帧打码、物体追踪打码和预览结果。</small>
            <input type="file" accept="video/*" onChange={(event) => handleFile(event.target.files?.[0])} />
          </label>

          {sourcePreviewUrl ? (
            <div className="mask-test-preview">
              <video src={sourcePreviewUrl} controls playsInline preload="metadata" onLoadedMetadata={(event) => updateDuration(event.currentTarget.duration)} />
            </div>
          ) : (
            <div className="mask-test-empty">
              <FileVideo size={42} />
              <strong>还没有选择视频</strong>
              <span>点击上方区域选择 `/Users/big67/Downloads/0509.mp4` 或其它本地素材。</span>
            </div>
          )}
        </div>

        <aside className="panel mask-test-side">
          <div className="panel-heading compact-heading">
            <div>
              <p className="eyebrow">Test Status</p>
              <h2>测试状态</h2>
            </div>
          </div>
          <div className="mask-test-status">
            <strong>{statusText}</strong>
          </div>
          <div className="mask-test-stats">
            <InfoBlock label="当前文件" value={videoFile ? videoFile.name : "未选择"} />
            <InfoBlock label="文件大小" value={videoFile ? formatBytes(videoFile.size) : "-"} />
            <InfoBlock label="视频时长" value={segment.duration ? `${segment.duration}秒` : "-"} />
            <InfoBlock label="Bridge" value={displayBridgeUrl} />
          </div>
          <div className="mask-test-checklist">
            <CheckItem active={Boolean(faceTrace?.outputVideoUrl)} label="人脸预览结果" value={faceTrace?.outputVideoUrl ? "已生成" : "未生成"} />
            <CheckItem active={Boolean(segment.privacyEdits?.brandMasks?.length)} label="物体追踪目标" value={`${segment.privacyEdits?.brandMasks?.length ?? 0}个`} />
            <CheckItem active={!review.errorCount} label="物体追踪阻塞" value={`${review.errorCount}个红色问题`} />
            <CheckItem active={Boolean(brandTrace?.outputVideoUrl)} label="物体追踪预览" value={brandTrace?.outputVideoUrl ? "已生成" : "在工作台查看"} />
          </div>
          <div className="mask-test-note">
            <Gauge size={16} />
            <span>人脸预览使用快速本地检测，适合验证效果；正式生成链路仍会按预处理链路执行。</span>
          </div>
        </aside>
      </section>

      {isAnnotatorOpen && sourcePreviewUrl && (
        <BrandMaskAnnotator
          segment={segment}
          sourcePreviewUrl={sourcePreviewUrl}
          bridgeUrl={bridgeUrl}
          facePreviewSegmentId={facePreviewSegmentId}
          facePreviewError={facePreviewError}
          onToggleFaceMosaic={toggleFaceMosaic}
          onChangeFaceMosaicEffect={(effect: FaceMosaicEffect) => {
            setSegment((current) => setSegmentFaceMosaicEffect(current, effect));
            setFacePreviewError("");
            setStatusText(`人脸遮挡效果已切换为${faceEffectLabel(effect)}，重新运行人脸预览后生效。`);
          }}
          onChangeFaceMosaicStrength={(strength) => {
            setSegment((current) => setSegmentFaceMosaicStrength(current, strength));
            setFacePreviewError("");
            setStatusText(`人脸打码强度已调整为 ${Math.round(strength * 100)}%，重新运行人脸预览后生效。`);
          }}
          onPreviewFaceMosaic={previewFaceMosaic}
          onChange={updateBrandMasks}
          onPreviewTrace={(trace) => {
            setSegment((current) => applyPreprocessTraces(current, [trace]));
            setStatusText(`物体追踪预览完成：${trace.summary?.trackCount ?? 0}个目标，找回 ${trace.summary?.recoveredFrames ?? 0}帧，跳过追踪异常 ${trace.summary?.skippedTrackingFrames ?? 0}帧，阻塞 ${trace.summary?.blockedFrames ?? 0}帧。`);
          }}
          onClose={() => setIsAnnotatorOpen(false)}
        />
      )}
    </>
  );
}

function faceEffectLabel(effect: FaceMosaicEffect) {
  if (effect === "blur") return "高斯模糊";
  if (effect === "solid") return "色块遮挡";
  return "马赛克";
}

function createTestSegment(): VideoSegment {
  return {
    id: "mask_test_segment",
    title: "本地测试视频",
    role: "完整视频",
    bucketRole: "hook",
    contentStatus: "draft",
    duration: 0,
    scriptText: "",
    generationPrompt: "",
    provider: "mock",
    status: "idle",
    privacyEdits: {
      faceMosaic: false,
      faceMosaicEffect: "mosaic",
      faceMosaicStrength: 0.85,
      brandMasks: []
    }
  };
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="mask-test-info">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CheckItem({ active, label, value }: { active: boolean; label: string; value: string }) {
  return (
    <div className={`mask-test-check ${active ? "active" : ""}`}>
      <CheckCircle2 size={16} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}
