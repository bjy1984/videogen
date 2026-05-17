import { useEffect, useMemo, useState } from "react";
import {
  initialGenerationOptions,
  workflowPages
} from "./app/workflow";
import { ProjectBar } from "./components/common/ProjectBar";
import type { AnalysisSource } from "./domain/analysisSource";
import type { GeminiBridgeTask } from "./domain/geminiBridge";
import type { ProjectSnapshot } from "./domain/project";
import { AnalyzeInputPage } from "./features/analysis/AnalyzeInputPage";
import { AnalysisReportPage } from "./features/analysis/AnalysisReportPage";
import { defaultAnalysisPrompt } from "./features/analysis/defaultPrompt";
import { buildGeminiManualPrompt, parseGeminiAnalysisResult } from "./features/analysis/geminiManual";
import type { GeminiBridgeHealth } from "./features/analysis/geminiLabels";
import { createMockAnalysis } from "./features/analysis/mockAnalysis";
import { ComposeExportPage } from "./features/compose/ComposeExportPage";
import {
  assembleTimelineFromBuckets,
  commitTimelineUsage,
  moveTimelineClip,
  rerollTimelineClipFromBuckets,
  serializeTimeline
} from "./features/compose/composeAssembler";
import { buildComposeReview } from "./features/compose/composeReview";
import type { ComposeTimeline, TimelineClip } from "./features/compose/composeTypes";
import { exportJianyingDraftPackage } from "./features/export/jianyingDraft";
import {
  generateRemixBuckets as createRemixBuckets,
  refreshComfyUIMaterialBuckets,
  refreshSeedanceMaterialBuckets,
  regenerateRemixAsset
} from "./features/generation/generationService";
import {
  defaultProviderSettings,
  mergeProviderSettings,
  type ProviderSettings
} from "./features/generation/providers/providerConfig";
import { VideoGeneratePage } from "./features/generation/VideoGeneratePage";
import { buildOperationAnalytics } from "./features/lineage/operationAnalytics";
import type { FinalVideoRun, OperationFeedback } from "./features/lineage/lineageTypes";
import { createFinalVideoRun, mergeFinalRunsById, mergeRunFeedback } from "./features/lineage/lineageService";
import {
  applyOperationDecisionsToBuckets,
  createCustomBucket,
  deleteCustomBucket,
  ensureDefaultBuckets,
  renameBucket,
  serializeBuckets,
  toggleAssetDisabled,
  updateAssetOperationState,
  updateAssetMaxUses
} from "./features/remix/remixBucketService";
import type { MaterialBucket, OperationDecisionState } from "./features/remix/remixTypes";
import { ScriptEditorPage } from "./features/script/ScriptEditorPage";
import {
  applyPreprocessTraces,
  hasSegmentFaceMosaic,
  setSegmentBrandMasks,
  setSegmentFaceMosaic
} from "./features/script/privacyEdits";
import { createSegmentsFromAnalysis } from "./features/script/segmentFactory";
import { serializeSegments, stripTransientSegmentFields } from "./features/script/segmentSerialization";
import {
  buildScriptRewriteSuggestion,
  createScriptRevision,
  restoreSegmentsFromRevision,
  type ScriptRewriteSuggestion,
  type ScriptSuggestionApplyTarget,
  type ScriptRevision
} from "./features/script/scriptRevision";
import { downloadBlob, sanitizeFileName } from "./services/fileDownload";
import {
  GeminiBridgeTaskError,
  captureGeminiBridgeResult as captureBridgeResult,
  checkGeminiBridgeHealth,
  createGeminiBridgeTask as createBridgeTask,
  prepareGeminiBridgeTask as prepareBridgeTask
} from "./services/geminiBridgeClient";
import { createId } from "./services/id";
import {
  checkVideoGenerationBridgeHealth,
  type VideoGenerationBridgeHealth
} from "./services/videoGenerationBridgeClient";
import {
  loadProjectSnapshot,
  readSavedPrompt as readPromptFromStorage,
  saveProjectSnapshot,
  savePrompt as savePromptToStorage
} from "./services/projectStorage";
import type { AnalysisResult, BrandMaskTrack, GenerationOptions, Provider, StepKey, VideoSegment } from "./types";

export default function App() {
  const [page, setPage] = useState<StepKey>("input");
  const [projectId, setProjectId] = useState(() => createId("project"));
  const [projectName, setProjectName] = useState("未命名爆款视频工程");
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [prompt, setPrompt] = useState(() => readSavedPrompt());
  const [sourceVideo, setSourceVideo] = useState<File>();
  const [sourceVideoMeta, setSourceVideoMeta] = useState<ProjectSnapshot["sourceVideoMeta"]>();
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisSource, setAnalysisSource] = useState<AnalysisSource>("none");
  const [rawGeminiResult, setRawGeminiResult] = useState("");
  const [geminiParseError, setGeminiParseError] = useState("");
  const [isGeminiPromptCopied, setIsGeminiPromptCopied] = useState(false);
  const [geminiBridgeUrl, setGeminiBridgeUrl] = useState("http://localhost:8787");
  const [geminiBridgeTask, setGeminiBridgeTask] = useState<GeminiBridgeTask | null>(null);
  const [geminiBridgeHealth, setGeminiBridgeHealth] = useState<GeminiBridgeHealth>("unknown");
  const [isGeminiBridgeBusy, setIsGeminiBridgeBusy] = useState(false);
  const [reportSection, setReportSection] = useState("basic");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [options, setOptions] = useState<GenerationOptions>(initialGenerationOptions);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(() => mergeProviderSettings());
  const [videoBridgeHealth, setVideoBridgeHealth] = useState<VideoGenerationBridgeHealth | null>(null);
  const [isVideoBridgeBusy, setIsVideoBridgeBusy] = useState(false);
  const [isGenerationPolling, setIsGenerationPolling] = useState(false);
  const [segments, setSegments] = useState<VideoSegment[]>([]);
  const [scriptRevisions, setScriptRevisions] = useState<ScriptRevision[]>([]);
  const [scriptSuggestions, setScriptSuggestions] = useState<Record<string, ScriptRewriteSuggestion>>({});
  const [materialBuckets, setMaterialBuckets] = useState<MaterialBucket[]>(() => ensureDefaultBuckets());
  const [composeTimeline, setComposeTimeline] = useState<ComposeTimeline | null>(null);
  const [finalVideoRuns, setFinalVideoRuns] = useState<FinalVideoRun[]>([]);
  const [composeStatus, setComposeStatus] = useState<"idle" | "running" | "done">("idle");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    return () => {
      if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    };
  }, [sourcePreviewUrl]);

  const doneCount = segments.filter((item) => item.status === "done").length;
  const totalDuration = useMemo(
    () => segments.reduce((total, segment) => total + segment.duration, 0),
    [segments]
  );
  const geminiManualPrompt = useMemo(
    () => buildGeminiManualPrompt({ basePrompt: prompt, sourceVideoMeta, videoDuration }),
    [prompt, sourceVideoMeta, videoDuration]
  );

  function buildSnapshot(name = projectName): ProjectSnapshot {
    return {
      schemaVersion: 1,
      id: projectId,
      name,
      updatedAt: new Date().toISOString(),
      prompt,
      videoDuration,
      sourceVideoMeta,
      analysisResult,
      analysisSource,
      rawGeminiResult,
      geminiBridgeUrl,
      geminiBridgeTask,
      reportSection,
      options,
      providerSettings,
      segments: serializeSegments(segments),
      scriptRevisions,
      materialBuckets: serializeBuckets(materialBuckets),
      composeTimeline: serializeTimeline(composeTimeline),
      finalVideoRuns,
      composeStatus
    };
  }

  function applySnapshot(snapshot: ProjectSnapshot) {
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    setProjectId(snapshot.id || createId("project"));
    setProjectName(snapshot.name || "未命名爆款视频工程");
    setLastSavedAt(snapshot.updatedAt || "");
    setPrompt(snapshot.prompt || defaultAnalysisPrompt);
    setSourceVideo(undefined);
    setSourcePreviewUrl("");
    setSourceVideoMeta(snapshot.sourceVideoMeta);
    setVideoDuration(snapshot.videoDuration || 0);
    setAnalysisResult(snapshot.analysisResult);
    setAnalysisSource(snapshot.analysisSource || (snapshot.analysisResult ? "mock" : "none"));
    setRawGeminiResult(snapshot.rawGeminiResult || "");
    setGeminiParseError("");
    setIsGeminiPromptCopied(false);
    setGeminiBridgeUrl(snapshot.geminiBridgeUrl || "http://localhost:8787");
    setGeminiBridgeTask(snapshot.geminiBridgeTask || null);
    setGeminiBridgeHealth("unknown");
    setIsGeminiBridgeBusy(false);
    setReportSection(snapshot.reportSection || "basic");
    setOptions(snapshot.options || initialGenerationOptions);
    setProviderSettings(mergeProviderSettings(snapshot.providerSettings));
    setVideoBridgeHealth(null);
    setIsVideoBridgeBusy(false);
    setIsGenerationPolling(false);
    setSegments((snapshot.segments || []).map(stripTransientSegmentFields));
    setScriptRevisions(snapshot.scriptRevisions || []);
    setScriptSuggestions({});
    setMaterialBuckets(ensureDefaultBuckets(snapshot.materialBuckets || []));
    setComposeTimeline(snapshot.composeTimeline || null);
    setFinalVideoRuns(snapshot.finalVideoRuns || []);
    setComposeStatus(snapshot.composeStatus === "done" ? "done" : "idle");
    setNotice("工程已加载。视频文件本体不会写入工程 JSON，如需预览或导出真实素材，请重新上传源视频或接入后端素材库。");
  }

  function saveProject() {
    try {
      const snapshot = buildSnapshot();
      saveProjectSnapshot(snapshot);
      setLastSavedAt(snapshot.updatedAt);
      setNotice("工程已保存到浏览器本地。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "工程保存失败。");
    }
  }

  function savePrompt() {
    try {
      savePromptToStorage(prompt);
      setNotice("Prompt 已保存。新建工程和下次打开会默认使用当前 Prompt。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Prompt 保存失败。");
    }
  }

  function loadSavedProject() {
    const snapshot = loadProjectSnapshot<ProjectSnapshot>();
    if (!snapshot) {
      setNotice("本地还没有已保存工程。");
      return;
    }
    applySnapshot(snapshot);
  }

  function exportProjectJson() {
    const snapshot = buildSnapshot();
    downloadBlob(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      `${sanitizeFileName(snapshot.name)}.videogen.json`
    );
    setLastSavedAt(snapshot.updatedAt);
    setNotice("工程 JSON 已导出。");
  }

  async function importProjectJson(file?: File) {
    if (!file) return;
    const snapshot = JSON.parse(await file.text()) as ProjectSnapshot;
    applySnapshot(snapshot);
  }

  function newProject() {
    if (!window.confirm("确认新建空工程？当前未导出的编辑内容会被清空。")) return;
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    setProjectId(createId("project"));
    setProjectName("未命名爆款视频工程");
    setLastSavedAt("");
    setPrompt(readSavedPrompt());
    setSourceVideo(undefined);
    setSourceVideoMeta(undefined);
    setSourcePreviewUrl("");
    setVideoDuration(0);
    setAnalysisResult(null);
    setAnalysisSource("none");
    setRawGeminiResult("");
    setGeminiParseError("");
    setIsGeminiPromptCopied(false);
    setGeminiBridgeUrl("http://localhost:8787");
    setGeminiBridgeTask(null);
    setGeminiBridgeHealth("unknown");
    setIsGeminiBridgeBusy(false);
    setReportSection("basic");
    setOptions(initialGenerationOptions);
    setProviderSettings(defaultProviderSettings);
    setVideoBridgeHealth(null);
    setIsVideoBridgeBusy(false);
    setIsGenerationPolling(false);
    setSegments([]);
    setScriptRevisions([]);
    setScriptSuggestions({});
    setMaterialBuckets(ensureDefaultBuckets());
    setComposeTimeline(null);
    setFinalVideoRuns([]);
    setComposeStatus("idle");
    setNotice("已创建空工程。");
    setPage("input");
  }

  function handleVideoFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      setNotice("请上传视频文件。");
      return;
    }
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    setSourceVideo(file);
    setSourceVideoMeta({ name: file.name, size: file.size, type: file.type });
    setSourcePreviewUrl(URL.createObjectURL(file));
    setVideoDuration(0);
    setNotice("视频已挂载到当前工程。已生成的数据不会被自动清空。");
  }

  function runAnalyze() {
    setIsAnalyzing(true);
    setNotice(sourceVideo ? "" : "未上传视频，将使用默认时长运行 API 分析。");
    window.setTimeout(() => {
      const result = createMockAnalysis(videoDuration);
      setAnalysisResult(result);
      setAnalysisSource("mock");
      setSegments(createSegmentsFromAnalysis(result, options, sourceVideo));
      setScriptSuggestions({});
      setReportSection("basic");
      setIsAnalyzing(false);
      setPage("report");
    }, 900);
  }

  function extractScriptsFromReport(targetPage: StepKey = "script") {
    const result = analysisResult ?? createMockAnalysis(videoDuration);
    if (!analysisResult) setAnalysisResult(result);
    setSegments(createSegmentsFromAnalysis(result, options, sourceVideo));
    setScriptSuggestions({});
    setNotice(analysisResult ? "已从分析报告提取五段脚本。" : "当前没有分析报告，已创建一组默认五段脚本。");
    setPage(targetPage);
  }

  function updateOptions(patch: Partial<GenerationOptions>) {
    setOptions((current) => {
      const next = { ...current, ...patch };
      if (patch.provider) {
        setSegments((items) => items.map((item) => ({ ...item, provider: patch.provider as Provider })));
      }
      return next;
    });
  }

  function updateSegment(id: string, patch: Partial<VideoSegment>) {
    setSegments((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    setScriptSuggestions((items) => {
      if (!items[id]) return items;
      const next = { ...items };
      delete next[id];
      return next;
    });
    setComposeTimeline(null);
  }

  function saveScriptRevision() {
    if (!segments.length) {
      setNotice("当前没有可保存的脚本段。");
      return;
    }
    const revision = createScriptRevision(segments);
    setScriptRevisions((items) => [revision, ...items].slice(0, 20));
    setNotice(`已保存脚本版本：${revision.label}`);
  }

  function restoreScriptRevision(revisionId: string) {
    const revision = scriptRevisions.find((item) => item.id === revisionId);
    if (!revision) {
      setNotice("未找到要恢复的脚本版本。");
      return;
    }
    if (!window.confirm(`确认恢复脚本版本「${revision.label}」？当前脚本编辑会被覆盖。`)) return;
    setSegments(restoreSegmentsFromRevision(revision));
    setScriptSuggestions({});
    setComposeTimeline(null);
    setNotice(`已恢复脚本版本：${revision.label}`);
  }

  function suggestScriptRewrite(segmentId: string) {
    const segment = segments.find((item) => item.id === segmentId);
    if (!segment) return;
    const suggestion = buildScriptRewriteSuggestion(segment);
    setScriptSuggestions((items) => ({
      ...items,
      [segmentId]: suggestion
    }));
  }

  function applyScriptSuggestion(segmentId: string, target: ScriptSuggestionApplyTarget) {
    const suggestion = scriptSuggestions[segmentId];
    if (!suggestion) return;
    const patch: Partial<VideoSegment> = {};
    if (target === "script" || target === "both") patch.scriptText = suggestion.scriptText;
    if (target === "prompt" || target === "both") patch.generationPrompt = suggestion.generationPrompt;
    setSegments((items) => items.map((item) => (item.id === segmentId ? { ...item, ...patch } : item)));
    setScriptSuggestions((items) => {
      const next = { ...items };
      delete next[segmentId];
      return next;
    });
    setComposeTimeline(null);
    setNotice("已应用改写建议。");
  }

  function addScriptSegment() {
    setSegments((items) => {
      const nextIndex = items.length + 1;
      return [
        ...items,
        {
          id: createId("segment"),
          title: `第${nextIndex}段：新增段落`,
          role: "自定义时间段",
          bucketRole: "hook",
          contentStatus: "draft",
          duration: 5,
          scriptText: "",
          subtitleText: "",
          overlayText: "",
          generationPrompt: "",
          provider: options.provider,
          status: "idle",
          sourceFile: sourceVideo
        }
      ];
    });
    setScriptSuggestions({});
    setComposeTimeline(null);
  }

  function duplicateScriptSegment(id: string) {
    setSegments((items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return items;
      const source = items[index];
      const copy: VideoSegment = {
        ...source,
        id: createId("segment_copy"),
        title: `${source.title} 副本`,
        contentStatus: "draft",
        status: "idle",
        videoUrl: undefined,
        sourceFile: source.sourceFile ?? sourceVideo
      };
      const next = [...items];
      next.splice(index + 1, 0, copy);
      return next;
    });
    setScriptSuggestions({});
    setComposeTimeline(null);
  }

  function toggleSegmentFaceMosaic(id: string) {
    const target = segments.find((item) => item.id === id);
    if (!target) {
      setNotice("未找到要设置人脸打码的脚本段。");
      return;
    }
    const enabled = !hasSegmentFaceMosaic(target);
    setSegments((items) =>
      items.map((item) => (item.id === id ? setSegmentFaceMosaic(item, enabled) : item))
    );
    setScriptSuggestions((items) => {
      const next = { ...items };
      delete next[id];
      return next;
    });
    setComposeTimeline(null);
    setNotice(enabled ? `已为「${target.title || "该段落"}」开启人脸打码。` : `已取消「${target.title || "该段落"}」的人脸打码。`);
  }

  function toggleAllSegmentFaceMosaic() {
    if (!segments.length) {
      setNotice("当前没有可设置的人脸打码段落。");
      return;
    }
    const shouldEnable = !segments.every(hasSegmentFaceMosaic);
    setSegments((items) => items.map((item) => setSegmentFaceMosaic(item, shouldEnable)));
    setScriptSuggestions({});
    setComposeTimeline(null);
    setNotice(shouldEnable ? "已为全部脚本段开启人脸打码。" : "已取消全部脚本段的人脸打码。");
  }

  function updateSegmentBrandMasks(segmentId: string, brandMasks: BrandMaskTrack[]) {
    const target = segments.find((item) => item.id === segmentId);
    if (!target) {
      setNotice("未找到要设置品牌打码的脚本段。");
      return;
    }
    setSegments((items) =>
      items.map((item) => (item.id === segmentId ? setSegmentBrandMasks(item, brandMasks) : item))
    );
    setScriptSuggestions((items) => {
      const next = { ...items };
      delete next[segmentId];
      return next;
    });
    setComposeTimeline(null);
    const keyframeCount = brandMasks.reduce((total, track) => total + track.keyframes.length, 0);
    setNotice(`已更新「${target.title || "该段落"}」品牌/文字打码：${brandMasks.length}个遮罩，${keyframeCount}个关键帧。`);
  }

  function deleteScriptSegment(id: string) {
    const segment = segments.find((item) => item.id === id);
    if (!window.confirm(`确认删除「${segment?.title ?? "该段落"}」？关联素材也会从素材桶移除。`)) return;
    setSegments((items) => items.filter((item) => item.id !== id));
    setScriptSuggestions((items) => {
      const next = { ...items };
      delete next[id];
      return next;
    });
    setMaterialBuckets((items) => items.map((bucket) => ({
      ...bucket,
      assets: bucket.assets.filter((asset) => asset.sourceSegmentId !== id)
    })));
    setComposeTimeline(null);
  }

  function startGeneration() {
    if (!segments.length) {
      extractScriptsFromReport("generate");
      return;
    }
    setNotice("");
    setSegments((items) => items.map((item) => ({ ...item, status: "queued", provider: options.provider })));

    segments.forEach((segment, index) => {
      window.setTimeout(() => {
        updateSegment(segment.id, { status: "generating" });
      }, 300 + index * 450);
      window.setTimeout(() => {
        updateSegment(segment.id, {
          status: "done",
          videoUrl: sourcePreviewUrl || segment.videoUrl,
          sourceFile: sourceVideo,
          provider: options.provider
        });
      }, 900 + index * 600);
    });
  }

  function moveSegment(id: string, direction: -1 | 1) {
    setSegments((items) => {
      const index = items.findIndex((item) => item.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= items.length) return items;
      const next = [...items];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    setComposeTimeline(null);
  }

  async function generateRemixBuckets() {
    if (!(await ensureVideoProviderReady())) return;

    const activeSegments = segments.length
      ? segments
      : createSegmentsFromAnalysis(analysisResult ?? createMockAnalysis(videoDuration), options, sourceVideo);
    if (!segments.length) {
      setSegments(activeSegments);
    }

    const result = await createRemixBuckets({
      buckets: materialBuckets,
      segments: activeSegments,
      analysisResult,
      options,
      providerSettings,
      projectId,
      sourceVideo,
      sourcePreviewUrl
    });
    setMaterialBuckets(result.buckets);
    const jobBySegment = new Map(result.generationJobs.map((job) => [job.input.segmentId, job]));
    const preprocessesBySegment = new Map(
      result.generationJobs
        .filter((job) => job.input.preprocessingTraces?.length || job.input.preprocessingTrace)
        .map((job) => [job.input.segmentId, job.input.preprocessingTraces?.length ? job.input.preprocessingTraces : [job.input.preprocessingTrace!]])
    );
    setSegments((items) =>
      (items.length ? items : activeSegments).map((segment) => {
        const job = jobBySegment.get(segment.id);
        const preprocesses = preprocessesBySegment.get(segment.id) ?? [];
        if (!job) return segment;
        const nextSegment = {
              ...segment,
              status: job.status,
              provider: options.provider,
              videoUrl: job.resultVideoUrl || segment.videoUrl
            };
        return preprocesses.length ? applyPreprocessTraces(nextSegment, preprocesses) : nextSegment;
      })
    );
    setComposeTimeline(null);
    const failedCount = result.assets.filter((asset) => asset.status === "failed").length;
    const runningCount = result.assets.filter((asset) => asset.status === "generating").length;
    setNotice(
      `已写入 ${result.assets.length} 个二创素材到素材桶。${runningCount ? `生成中 ${runningCount} 个。` : ""}${failedCount ? `失败 ${failedCount} 个，请检查 Provider Bridge、ComfyUI workflow 或 API Key。` : ""}`
    );
  }

  async function refreshRemixGenerationResults() {
    if (!(await ensureVideoProviderReady())) return;
    const refreshFn = options.provider === "comfyui" ? refreshComfyUIMaterialBuckets : refreshSeedanceMaterialBuckets;
    const providerName = options.provider === "comfyui" ? "ComfyUI" : "Seedance";
    setIsGenerationPolling(true);
    let latestResult: Awaited<ReturnType<typeof refreshSeedanceMaterialBuckets>> | null = null;
    try {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        latestResult = await refreshFn({
          buckets: latestResult?.buckets ?? materialBuckets,
          providerSettings,
          projectId,
          syncAssets: true
        });
        applyGenerationRefreshResult(latestResult, providerName);
        if (!latestResult.runningCount) break;
        await delay(3000);
      }
    } finally {
      setIsGenerationPolling(false);
    }
  }

  async function regenerateMaterialAsset(assetId: string) {
    if (!(await ensureVideoProviderReady())) return;
    try {
      const result = await regenerateRemixAsset({
        assetId,
        buckets: materialBuckets,
        segments,
        analysisResult,
        options,
        providerSettings,
        projectId,
        sourceVideo,
        sourcePreviewUrl
      });
      setMaterialBuckets(result.buckets);
      setSegments((items) =>
        items.map((segment) =>
          {
            if (segment.id !== result.asset.sourceSegmentId) return segment;
            const nextStatus: VideoSegment["status"] =
              result.asset.status === "ready" ? "done" : result.asset.status === "failed" ? "failed" : "generating";
            const nextSegment = {
                ...segment,
                provider: options.provider,
                status: nextStatus,
                videoUrl: result.asset.videoUrl || segment.videoUrl
              };
            if (result.asset.providerTrace?.preprocesses?.length) {
              return applyPreprocessTraces(nextSegment, result.asset.providerTrace.preprocesses);
            }
            if (result.asset.providerTrace?.preprocess) {
              return applyPreprocessTraces(nextSegment, [result.asset.providerTrace.preprocess]);
            }
            return nextSegment;
          }
        )
      );
      setComposeTimeline(null);
      setNotice(`已重新生成「${result.sourceAsset.title}」，新素材已写回同一素材桶，旧素材已自动禁用。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重新生成素材失败。");
    }
  }

  function applyGenerationRefreshResult(
    result: Awaited<ReturnType<typeof refreshSeedanceMaterialBuckets>>,
    providerName: string
  ) {
    setMaterialBuckets(result.buckets);
    setSegments((items) =>
      items.map((segment) => {
        const asset = result.buckets.flatMap((bucket) => bucket.assets).find((item) => item.sourceSegmentId === segment.id);
        if (!asset) return segment;
        return {
          ...segment,
          status: asset.status === "ready" ? "done" : asset.status === "failed" ? "failed" : "generating",
          videoUrl: asset.videoUrl || segment.videoUrl
        };
      })
    );
    setComposeTimeline(null);
    setNotice(
      result.refreshedCount
        ? `已刷新 ${result.refreshedCount} 个 ${providerName} 任务：完成 ${result.readyCount}，生成中 ${result.runningCount}，失败 ${result.failedCount}。`
        : `当前没有可刷新的 ${providerName} 任务。`
    );
  }

  async function checkVideoBridge() {
    setIsVideoBridgeBusy(true);
    try {
      const bridgeUrl = options.provider === "comfyui"
        ? providerSettings.comfyui.bridgeUrl
        : providerSettings.seedance.bridgeUrl;
      const health = await checkVideoGenerationBridgeHealth(
        bridgeUrl,
        providerSettings.seedance.apiKeyEnvName,
        providerSettings.comfyui.endpoint
      );
      setVideoBridgeHealth(health);
      if (options.provider === "comfyui") {
        setNotice(
          health.comfyui?.reachable
            ? "Video Bridge 在线，ComfyUI endpoint 可达。"
            : `Video Bridge 在线，但 ComfyUI 不可达：${health.comfyui?.error || providerSettings.comfyui.endpoint}`
        );
      } else {
        setNotice(
          health.seedance?.hasApiKey
            ? "Video Bridge 在线，Seedance API Key 已配置。"
            : `Video Bridge 在线，但未配置 ${providerSettings.seedance.apiKeyEnvName}。`
        );
      }
      return health;
    } catch (error) {
      setVideoBridgeHealth(null);
      setNotice(error instanceof Error ? error.message : "Video Bridge 离线。");
      return null;
    } finally {
      setIsVideoBridgeBusy(false);
    }
  }

  async function ensureVideoProviderReady() {
    if (options.provider !== "seedance" && options.provider !== "comfyui") return true;
    const health = await checkVideoBridge();
    if (!health) return false;
    if (options.provider === "seedance" && !health.seedance?.hasApiKey) {
      setNotice(`请先在 video bridge 进程配置 ${providerSettings.seedance.apiKeyEnvName}，再调用 Seedance。`);
      return false;
    }
    if (options.provider === "comfyui" && !health.comfyui?.reachable) {
      setNotice(`请先启动 ComfyUI 并确认 endpoint 可访问：${providerSettings.comfyui.endpoint}`);
      return false;
    }
    if (
      options.provider === "comfyui" &&
      !providerSettings.comfyui.workflowJson.trim() &&
      !providerSettings.comfyui.workflowTemplateId.trim()
    ) {
      setNotice("请先粘贴 ComfyUI Save API Format workflow JSON，或在 Workflow 字段填写本地 JSON 文件路径。");
      return false;
    }
    return true;
  }

  function updateRemixAssetMaxUses(assetId: string, maxUses: number) {
    setMaterialBuckets((items) => updateAssetMaxUses(items, assetId, maxUses));
  }

  function updateRemixAssetOperationState(assetId: string, operationState: OperationDecisionState) {
    setMaterialBuckets((items) => updateAssetOperationState(items, assetId, operationState));
    setComposeTimeline(null);
  }

  function applyOperationDecisionSuggestions() {
    const analytics = buildOperationAnalytics(finalVideoRuns);
    setMaterialBuckets((items) => applyOperationDecisionsToBuckets(items, analytics));
    setComposeTimeline(null);
    setNotice("已根据运营反馈聚合应用素材决策建议。rejected 素材不会参与后续随机抽取。");
  }

  function toggleRemixAsset(assetId: string) {
    setMaterialBuckets((items) => toggleAssetDisabled(items, assetId));
    setComposeTimeline(null);
  }

  function renameMaterialBucket(bucketId: string) {
    const label = window.prompt("新的素材桶名称");
    if (!label?.trim()) return;
    setMaterialBuckets((items) => renameBucket(items, bucketId, label));
    setComposeTimeline(null);
  }

  function deleteMaterialBucket(bucketId: string) {
    const bucket = materialBuckets.find((item) => item.id === bucketId);
    if (!window.confirm(`确认删除素材桶「${bucket?.label ?? bucketId}」？桶内素材也会被移除。`)) return;
    setMaterialBuckets((items) => deleteCustomBucket(items, bucketId));
    setComposeTimeline(null);
  }

  function addCustomMaterialBucket() {
    const label = window.prompt("自定义素材桶名称，例如 product-shot / price-anchor / testimonial");
    if (!label?.trim()) return;
    setMaterialBuckets((items) => [...items, createCustomBucket(label)]);
    setNotice(`已新增自定义素材桶：${label.trim()}。`);
  }

  function assembleTimeline() {
    try {
      const timeline = assembleTimelineFromBuckets({ buckets: materialBuckets });
      setComposeTimeline(timeline);
      setComposeStatus("idle");
      setNotice("已从素材桶按 least-used 策略随机组装时间线。预览不消耗使用次数。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "随机组装失败。");
    }
  }

  function updateTimelineClip(
    clipId: string,
    patch: Partial<Pick<TimelineClip, "scriptText" | "subtitleText" | "overlayText">>
  ) {
    setComposeTimeline((current) => {
      if (!current) return current;
      return {
        ...current,
        clips: current.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip))
      };
    });
    setComposeStatus("idle");
  }

  function rerollTimelineClip(clipId: string) {
    if (!composeTimeline) {
      setNotice("请先组装时间线，再重抽单个片段。");
      return;
    }
    try {
      const timeline = rerollTimelineClipFromBuckets({
        timeline: composeTimeline,
        buckets: materialBuckets,
        clipId
      });
      setComposeTimeline(timeline);
      setComposeStatus("idle");
      setNotice("已重抽该片段。预览替换不消耗使用次数，导出锁定时才落账。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重抽片段失败。");
    }
  }

  function moveTimelineClipInTimeline(clipId: string, direction: -1 | 1) {
    setComposeTimeline((current) => {
      if (!current) return current;
      return moveTimelineClip({
        timeline: current,
        clipId,
        direction
      });
    });
    setComposeStatus("idle");
  }

  function runCompose() {
    if (!composeTimeline && materialBuckets.some((bucket) => bucket.assets.length > 0)) {
      assembleTimeline();
      return;
    }
    if (!composeTimeline && !segments.length) {
      setNotice("当前工程还没有可合成素材。可以先创建脚本并生成二创素材桶。");
      return;
    }
    setComposeStatus("running");
    setNotice("");
    window.setTimeout(() => {
      setComposeStatus("done");
      setNotice("合成任务已进入完成态。当前前端原型不执行 ffmpeg，后续接入后端合成服务。");
    }, 900);
  }

  async function exportDraft() {
    if (!composeTimeline && materialBuckets.some((bucket) => bucket.assets.length > 0)) {
      setNotice("请先从素材桶随机组装时间线，再导出剪映草稿包。");
      return;
    }
    if (!composeTimeline && !segments.length) {
      setNotice("当前工程没有素材段，无法生成剪映工程包。");
      return;
    }
    if (composeTimeline) {
      const review = buildComposeReview(composeTimeline, materialBuckets);
      if (review.readiness === "blocked") {
        setNotice(`导出前审核未通过：存在 ${review.counts.error} 个阻塞项，请处理后再导出。`);
        return;
      }
      const hasMissingMedia = review.issues.some((issue) => issue.id.endsWith("media-missing"));
      if (hasMissingMedia && options.provider !== "mock") {
        setNotice("真实 Provider 模式不允许导出占位素材。请先轮询/同步生成结果，确保每段都有真实视频文件或可拉取素材 URL。");
        return;
      }
      const outputName = sanitizeFileName(projectName || `videogen_${new Date().toISOString().slice(0, 10)}`);
      const outputFileName = `${outputName}.zip`;
      const { buckets: committedBuckets, changes } = commitTimelineUsage(materialBuckets, composeTimeline);
      const lineage = createFinalVideoRun({
        projectId,
        outputName,
        fileName: outputFileName,
        timeline: composeTimeline,
        buckets: committedBuckets,
        usageChanges: changes,
        review
      });
      await exportJianyingDraftPackage({
        projectName: outputName,
        timeline: composeTimeline,
        materialBuckets: committedBuckets,
        lineage,
        options,
        sourceVideo
      });
      setMaterialBuckets(committedBuckets);
      setFinalVideoRuns((runs) => [lineage, ...runs]);
      setComposeStatus("done");
      setNotice("已导出剪映草稿包，并写入 lineage.json、timeline.json、assets.json。使用次数已落账。");
      return;
    }
    await exportJianyingDraftPackage({
      projectName: sanitizeFileName(projectName || `videogen_${new Date().toISOString().slice(0, 10)}`),
      segments,
      options,
      sourceVideo
    });
    setNotice("已生成剪映草稿素材包。实际导入效果需要按本机剪映版本做模板校准。");
  }

  function updateRunFeedback(runId: string, feedback: Partial<OperationFeedback>) {
    setFinalVideoRuns((runs) => runs.map((run) => (run.id === runId ? mergeRunFeedback(run, feedback) : run)));
    setNotice("运营反馈已更新。");
  }

  function exportRunFeedbackJson() {
    const payload = {
      projectId,
      projectName,
      exportedAt: new Date().toISOString(),
      runs: finalVideoRuns
    };
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
      `${sanitizeFileName(projectName)}.operation-runs.json`
    );
    setNotice("运营反馈 JSON 已导出。");
  }

  async function importRunFeedbackJson(file?: File) {
    if (!file) return;
    const payload = JSON.parse(await file.text()) as { runs?: FinalVideoRun[] } | FinalVideoRun[];
    const runs = Array.isArray(payload) ? payload : payload.runs;
    if (!Array.isArray(runs)) {
      setNotice("运营反馈 JSON 格式不正确。");
      return;
    }
    setFinalVideoRuns((current) => mergeFinalRunsById(current, runs));
    setNotice(`已导入 ${runs.length} 条运营运行记录。`);
  }

  async function copyGeminiPrompt() {
    await navigator.clipboard.writeText(geminiManualPrompt);
    setIsGeminiPromptCopied(true);
    window.setTimeout(() => setIsGeminiPromptCopied(false), 1800);
    setNotice("Gemini 分析 Prompt 已复制。请在 Gemini 页面上传同一个视频后粘贴提交。");
  }

  function openGemini() {
    window.open("https://gemini.google.com/", "_blank", "noopener,noreferrer");
    setNotice("已打开 Gemini。请使用已登录账号，上传当前工程视频，粘贴 Prompt 并提交。");
  }

  function loadGeminiResult() {
    try {
      const result = parseGeminiAnalysisResult(rawGeminiResult);
      setAnalysisResult(result);
      setAnalysisSource(
        geminiBridgeTask?.resultText && geminiBridgeTask.resultText === rawGeminiResult
          ? "gemini-web-automation"
          : "gemini-web-manual"
      );
      setGeminiParseError("");
      setReportSection("basic");
      setSegments(createSegmentsFromAnalysis(result, options, sourceVideo));
      setNotice("Gemini 返回结果已解析并写入当前工程。");
      setPage("report");
    } catch (error) {
      const message = error instanceof Error ? error.message : "解析失败。";
      setGeminiParseError(message);
      setNotice(message);
    }
  }

  async function checkGeminiBridge() {
    setIsGeminiBridgeBusy(true);
    try {
      await checkGeminiBridgeHealth(geminiBridgeUrl);
      setGeminiBridgeHealth("online");
      setNotice("Gemini Bridge 在线。");
    } catch (error) {
      setGeminiBridgeHealth("offline");
      setNotice(error instanceof Error ? error.message : "Gemini Bridge 未连接。");
    } finally {
      setIsGeminiBridgeBusy(false);
    }
  }

  async function createGeminiBridgeTask() {
    setIsGeminiBridgeBusy(true);
    try {
      const task = await createBridgeTask(geminiBridgeUrl, {
        projectId,
        projectName,
        prompt: geminiManualPrompt,
        video: sourceVideo
      });
      setGeminiBridgeTask(task);
      setGeminiBridgeHealth("online");
      setNotice("Gemini Bridge 任务已创建。下一步可准备 Gemini 页面。");
    } catch (error) {
      setGeminiBridgeHealth("offline");
      setNotice(error instanceof Error ? error.message : "创建 Bridge 任务失败。");
    } finally {
      setIsGeminiBridgeBusy(false);
    }
  }

  async function prepareGeminiBridgeTask() {
    if (!geminiBridgeTask) {
      setNotice("请先创建 Bridge 任务。");
      return;
    }
    setIsGeminiBridgeBusy(true);
    try {
      const task = await prepareBridgeTask(geminiBridgeUrl, geminiBridgeTask.id);
      setGeminiBridgeTask(task);
      setNotice("Gemini 页面已准备。请在 Gemini 页面检查内容并手动点击发送。");
    } catch (error) {
      if (error instanceof GeminiBridgeTaskError && error.task) {
        setGeminiBridgeTask(error.task);
      }
      setNotice(error instanceof Error ? error.message : "准备 Gemini 页面失败。");
    } finally {
      setIsGeminiBridgeBusy(false);
    }
  }

  async function captureGeminiBridgeResult() {
    if (!geminiBridgeTask) {
      setNotice("请先创建 Bridge 任务。");
      return;
    }
    setIsGeminiBridgeBusy(true);
    try {
      const task = await captureBridgeResult(geminiBridgeUrl, geminiBridgeTask.id);
      setGeminiBridgeTask(task);
      setRawGeminiResult(task.resultText || "");
      setNotice("已抓取 Gemini 回复并填入手动结果框。确认无误后可解析加载到工程。");
    } catch (error) {
      if (error instanceof GeminiBridgeTaskError && error.task) {
        setGeminiBridgeTask(error.task);
      }
      setNotice(error instanceof Error ? error.message : "抓取 Gemini 回复失败。");
    } finally {
      setIsGeminiBridgeBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Douyin Qianchuan Video Workflow</p>
          <h1>爆款视频分析与生成工作流</h1>
        </div>
        <div className="topbar-stats">
          <span>{analysisResult ? "已完成分析" : "等待分析"}</span>
          <strong>{doneCount}/{segments.length || 5}</strong>
        </div>
      </header>

      <ProjectBar
        projectName={projectName}
        lastSavedAt={lastSavedAt}
        sourceVideoMeta={sourceVideoMeta}
        analysisResult={analysisResult}
        segments={segments}
        onName={setProjectName}
        onNew={newProject}
        onSave={saveProject}
        onLoad={loadSavedProject}
        onExport={exportProjectJson}
        onImport={importProjectJson}
      />

      <nav className="stepper five-stepper" aria-label="工作流页面">
        {workflowPages.map((item, index) => (
          <button
            key={item.key}
            className={`step ${item.key === page ? "active" : ""}`}
            onClick={() => setPage(item.key)}
          >
            <span className="step-index">{index + 1}</span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.subtitle}</small>
            </span>
          </button>
        ))}
      </nav>

      {notice && <div className="notice">{notice}</div>}

      {page === "input" && (
        <AnalyzeInputPage
          prompt={prompt}
          sourceVideo={sourceVideo}
          sourceVideoMeta={sourceVideoMeta}
          sourcePreviewUrl={sourcePreviewUrl}
          videoDuration={videoDuration}
          analysisResult={analysisResult}
          analysisSource={analysisSource}
          segments={segments}
          geminiManualPrompt={geminiManualPrompt}
          rawGeminiResult={rawGeminiResult}
          geminiParseError={geminiParseError}
          isGeminiPromptCopied={isGeminiPromptCopied}
          geminiBridgeUrl={geminiBridgeUrl}
          geminiBridgeHealth={geminiBridgeHealth}
          geminiBridgeTask={geminiBridgeTask}
          isGeminiBridgeBusy={isGeminiBridgeBusy}
          isAnalyzing={isAnalyzing}
          onPromptChange={setPrompt}
          onFile={handleVideoFile}
          onDuration={setVideoDuration}
          onAnalyze={runAnalyze}
          onResetPrompt={() => setPrompt(defaultAnalysisPrompt)}
          onSavePrompt={savePrompt}
          onCopyGeminiPrompt={copyGeminiPrompt}
          onOpenGemini={openGemini}
          onRawGeminiResult={setRawGeminiResult}
          onLoadGeminiResult={loadGeminiResult}
          onGeminiBridgeUrl={setGeminiBridgeUrl}
          onCheckGeminiBridge={checkGeminiBridge}
          onCreateGeminiBridgeTask={createGeminiBridgeTask}
          onPrepareGeminiBridgeTask={prepareGeminiBridgeTask}
          onCaptureGeminiBridgeResult={captureGeminiBridgeResult}
          onNext={() => setPage("report")}
        />
      )}

      {page === "report" && (
        <AnalysisReportPage
          result={analysisResult}
          reportSection={reportSection}
          onSection={setReportSection}
          onBack={() => setPage("input")}
          onExtract={() => extractScriptsFromReport("script")}
          onCreateMock={() => {
            const result = createMockAnalysis(videoDuration);
            setAnalysisResult(result);
            setAnalysisSource("mock");
            setReportSection("basic");
            setNotice("已创建 API 分析报告。");
          }}
        />
      )}

      {page === "script" && (
        <ScriptEditorPage
          analysisResult={analysisResult}
          segments={segments}
          scriptRevisions={scriptRevisions}
          scriptSuggestions={scriptSuggestions}
          sourcePreviewUrl={sourcePreviewUrl}
          onSegment={updateSegment}
          onMove={moveSegment}
          onDuplicate={duplicateScriptSegment}
          onDelete={deleteScriptSegment}
          onAddSegment={addScriptSegment}
          onSaveRevision={saveScriptRevision}
          onRestoreRevision={restoreScriptRevision}
          onSuggestRewrite={suggestScriptRewrite}
          onApplySuggestion={applyScriptSuggestion}
          onToggleFaceMosaic={toggleSegmentFaceMosaic}
          onToggleAllFaceMosaic={toggleAllSegmentFaceMosaic}
          onUpdateBrandMasks={updateSegmentBrandMasks}
          onCreate={() => extractScriptsFromReport("script")}
          onBack={() => setPage("report")}
          onNext={() => setPage("generate")}
        />
      )}

      {page === "generate" && (
        <VideoGeneratePage
          options={options}
          providerSettings={providerSettings}
          videoBridgeHealth={videoBridgeHealth}
          isVideoBridgeBusy={isVideoBridgeBusy}
          isGenerationPolling={isGenerationPolling}
          segments={segments}
          materialBuckets={materialBuckets}
          sourcePreviewUrl={sourcePreviewUrl}
          onOptions={updateOptions}
          onProviderSettings={setProviderSettings}
          onCheckVideoBridge={checkVideoBridge}
          onSegment={updateSegment}
          onCreate={() => extractScriptsFromReport("generate")}
          onGenerate={startGeneration}
          onGenerateRemixBuckets={generateRemixBuckets}
          onRefreshGenerationResults={refreshRemixGenerationResults}
          onAssetMaxUses={updateRemixAssetMaxUses}
          onAssetToggle={toggleRemixAsset}
          onAssetRegenerate={regenerateMaterialAsset}
          onAssetOperationState={updateRemixAssetOperationState}
          onAddCustomBucket={addCustomMaterialBucket}
          onRenameBucket={renameMaterialBucket}
          onDeleteBucket={deleteMaterialBucket}
          onBack={() => setPage("script")}
          onNext={() => setPage("compose")}
        />
      )}

      {page === "compose" && (
        <ComposeExportPage
          segments={segments}
          materialBuckets={materialBuckets}
          timeline={composeTimeline}
          finalRuns={finalVideoRuns}
          totalDuration={totalDuration}
          composeStatus={composeStatus}
          onSegment={updateSegment}
          onTimelineClip={updateTimelineClip}
          onRerollTimelineClip={rerollTimelineClip}
          onMoveTimelineClip={moveTimelineClipInTimeline}
          onMove={moveSegment}
          onAssembleTimeline={assembleTimeline}
          onAssetMaxUses={updateRemixAssetMaxUses}
          onAssetToggle={toggleRemixAsset}
          onAssetOperationState={updateRemixAssetOperationState}
          onBack={() => setPage("generate")}
          onCompose={runCompose}
          onExport={exportDraft}
          onRunFeedback={updateRunFeedback}
          onExportRunFeedback={exportRunFeedbackJson}
          onImportRunFeedback={importRunFeedbackJson}
          onApplyOperationDecisions={applyOperationDecisionSuggestions}
        />
      )}
    </main>
  );
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readSavedPrompt() {
  return readPromptFromStorage(defaultAnalysisPrompt);
}
