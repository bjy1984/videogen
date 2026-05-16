import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ClipboardList,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileJson,
  FileText,
  FileVideo,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Loader2,
  PackageOpen,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Sparkles,
  Upload,
  UploadCloud,
  Wand2
} from "lucide-react";
import { defaultAnalysisPrompt } from "./defaultPrompt";
import { exportJianyingDraftPackage } from "./jianyingDraft";
import { buildGeminiManualPrompt, parseGeminiAnalysisResult } from "./geminiManual";
import { createMockAnalysis, createSegmentsFromAnalysis } from "./mockAnalysis";
import type { AnalysisResult, GenerationOptions, Provider, StepKey, VideoSegment } from "./types";

const STORAGE_KEY = "videogen.currentProject";
const PROMPT_STORAGE_KEY = "videogen.savedPrompt";

const pages: Array<{ key: StepKey; title: string; subtitle: string }> = [
  { key: "input", title: "视频分析输入", subtitle: "Prompt + 上传" },
  { key: "report", title: "爆款分析报告", subtitle: "6层拆解" },
  { key: "script", title: "脚本拆分编辑", subtitle: "5段式脚本" },
  { key: "generate", title: "分段视频生成", subtitle: "模型 + 队列" },
  { key: "compose", title: "审核合成导出", subtitle: "剪映工程包" }
];

const providers: Array<{ value: Provider; label: string }> = [
  { value: "seedance", label: "Seedance" },
  { value: "veo", label: "Veo" },
  { value: "kling", label: "Kling" },
  { value: "runway", label: "Runway" },
  { value: "pika", label: "Pika" }
];

const reportSections = [
  { key: "basic", label: "视频基本信息" },
  { key: "narrative", label: "L3叙事拆解" },
  { key: "technique", label: "L4手法分析" },
  { key: "data", label: "L5数据预测" },
  { key: "execution", label: "执行方案" },
  { key: "prompts", label: "生成提示语" }
];

const initialOptions: GenerationOptions = {
  provider: "seedance",
  aspectRatio: "9:16",
  style: "抖音电商实拍，真实生活场景，结果感强",
  resolution: "1080p",
  subtitles: true
};

interface ProjectSnapshot {
  schemaVersion: 1;
  id: string;
  name: string;
  updatedAt: string;
  prompt: string;
  videoDuration: number;
  sourceVideoMeta?: {
    name: string;
    size: number;
    type: string;
  };
  analysisResult: AnalysisResult | null;
  analysisSource: "none" | "mock" | "gemini-web-manual" | "gemini-web-automation";
  rawGeminiResult: string;
  geminiBridgeUrl: string;
  geminiBridgeTask: GeminiBridgeTask | null;
  reportSection: string;
  options: GenerationOptions;
  segments: VideoSegment[];
  composeStatus: "idle" | "running" | "done";
}

interface GeminiBridgeTask {
  id: string;
  projectId: string;
  projectName: string;
  videoOriginalName?: string;
  status: string;
  resultText: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

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
  const [analysisSource, setAnalysisSource] = useState<"none" | "mock" | "gemini-web-manual" | "gemini-web-automation">("none");
  const [rawGeminiResult, setRawGeminiResult] = useState("");
  const [geminiParseError, setGeminiParseError] = useState("");
  const [isGeminiPromptCopied, setIsGeminiPromptCopied] = useState(false);
  const [geminiBridgeUrl, setGeminiBridgeUrl] = useState("http://localhost:8787");
  const [geminiBridgeTask, setGeminiBridgeTask] = useState<GeminiBridgeTask | null>(null);
  const [geminiBridgeHealth, setGeminiBridgeHealth] = useState<"unknown" | "online" | "offline">("unknown");
  const [isGeminiBridgeBusy, setIsGeminiBridgeBusy] = useState(false);
  const [reportSection, setReportSection] = useState("basic");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [options, setOptions] = useState<GenerationOptions>(initialOptions);
  const [segments, setSegments] = useState<VideoSegment[]>([]);
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
      segments: serializeSegments(segments),
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
    setOptions(snapshot.options || initialOptions);
    setSegments((snapshot.segments || []).map(stripTransientSegmentFields));
    setComposeStatus(snapshot.composeStatus === "done" ? "done" : "idle");
    setNotice("工程已加载。视频文件本体不会写入工程 JSON，如需预览或导出真实素材，请重新上传源视频或接入后端素材库。");
  }

  function saveProject() {
    const snapshot = buildSnapshot();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    setLastSavedAt(snapshot.updatedAt);
    setNotice("工程已保存到浏览器本地。");
  }

  function savePrompt() {
    localStorage.setItem(PROMPT_STORAGE_KEY, prompt);
    setNotice("Prompt 已保存。新建工程和下次打开会默认使用当前 Prompt。");
  }

  function loadSavedProject() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      setNotice("本地还没有已保存工程。");
      return;
    }
    applySnapshot(JSON.parse(raw) as ProjectSnapshot);
  }

  function exportProjectJson() {
    const snapshot = buildSnapshot();
    downloadBlob(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      `${sanitizeName(snapshot.name)}.videogen.json`
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
    setOptions(initialOptions);
    setSegments([]);
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
      setReportSection("basic");
      setIsAnalyzing(false);
      setPage("report");
    }, 900);
  }

  function extractScriptsFromReport(targetPage: StepKey = "script") {
    const result = analysisResult ?? createMockAnalysis(videoDuration);
    if (!analysisResult) setAnalysisResult(result);
    setSegments(createSegmentsFromAnalysis(result, options, sourceVideo));
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
  }

  function runCompose() {
    if (!segments.length) {
      setNotice("当前工程还没有视频段。可以先在脚本页创建五段脚本，或直接加载已有工程。");
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
    if (!segments.length) {
      setNotice("当前工程没有素材段，无法生成剪映工程包。");
      return;
    }
    await exportJianyingDraftPackage({
      projectName: sanitizeName(projectName || `videogen_${new Date().toISOString().slice(0, 10)}`),
      segments,
      options,
      sourceVideo
    });
    setNotice("已生成剪映草稿素材包。实际导入效果需要按本机剪映版本做模板校准。");
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
      const response = await fetch(`${geminiBridgeUrl}/health`);
      if (!response.ok) throw new Error(`Bridge 状态异常：${response.status}`);
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
      const formData = new FormData();
      formData.append("projectId", projectId);
      formData.append("projectName", projectName);
      formData.append("prompt", geminiManualPrompt);
      if (sourceVideo) formData.append("video", sourceVideo, sourceVideo.name);

      const response = await fetch(`${geminiBridgeUrl}/tasks`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) throw new Error(`创建 Bridge 任务失败：${response.status}`);
      const task = (await response.json()) as GeminiBridgeTask;
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
      const response = await fetch(`${geminiBridgeUrl}/tasks/${geminiBridgeTask.id}/prepare`, {
        method: "POST"
      });
      const task = (await response.json()) as GeminiBridgeTask;
      setGeminiBridgeTask(task);
      if (!response.ok) throw new Error(lastLog(task) || `准备 Gemini 页面失败：${response.status}`);
      setNotice("Gemini 页面已准备。请在 Gemini 页面检查内容并手动点击发送。");
    } catch (error) {
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
      const response = await fetch(`${geminiBridgeUrl}/tasks/${geminiBridgeTask.id}/capture`, {
        method: "POST"
      });
      const task = (await response.json()) as GeminiBridgeTask;
      setGeminiBridgeTask(task);
      if (!response.ok) throw new Error(lastLog(task) || `抓取 Gemini 回复失败：${response.status}`);
      setRawGeminiResult(task.resultText || "");
      setNotice("已抓取 Gemini 回复并填入手动结果框。确认无误后可解析加载到工程。");
    } catch (error) {
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
        {pages.map((item, index) => (
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
          onSegment={updateSegment}
          onCreate={() => extractScriptsFromReport("script")}
          onBack={() => setPage("report")}
          onNext={() => setPage("generate")}
        />
      )}

      {page === "generate" && (
        <VideoGeneratePage
          options={options}
          segments={segments}
          sourcePreviewUrl={sourcePreviewUrl}
          onOptions={updateOptions}
          onSegment={updateSegment}
          onCreate={() => extractScriptsFromReport("generate")}
          onGenerate={startGeneration}
          onBack={() => setPage("script")}
          onNext={() => setPage("compose")}
        />
      )}

      {page === "compose" && (
        <ComposeExportPage
          segments={segments}
          totalDuration={totalDuration}
          composeStatus={composeStatus}
          onSegment={updateSegment}
          onMove={moveSegment}
          onBack={() => setPage("generate")}
          onCompose={runCompose}
          onExport={exportDraft}
        />
      )}
    </main>
  );
}

function ProjectBar({
  projectName,
  lastSavedAt,
  sourceVideoMeta,
  analysisResult,
  segments,
  onName,
  onNew,
  onSave,
  onLoad,
  onExport,
  onImport
}: {
  projectName: string;
  lastSavedAt: string;
  sourceVideoMeta?: ProjectSnapshot["sourceVideoMeta"];
  analysisResult: AnalysisResult | null;
  segments: VideoSegment[];
  onName: (value: string) => void;
  onNew: () => void;
  onSave: () => void;
  onLoad: () => void;
  onExport: () => void;
  onImport: (file?: File) => void;
}) {
  return (
    <section className="project-bar">
      <div className="project-main">
        <Database size={18} />
        <label>
          <span>当前工程</span>
          <input value={projectName} onChange={(event) => onName(event.target.value)} />
        </label>
      </div>
      <div className="project-status">
        <span>{sourceVideoMeta ? sourceVideoMeta.name : "未挂载视频"}</span>
        <span>{analysisResult ? "有分析报告" : "无分析报告"}</span>
        <span>{segments.length}段脚本</span>
        <span>{lastSavedAt ? `已保存 ${formatDateTime(lastSavedAt)}` : "未保存"}</span>
      </div>
      <div className="project-actions">
        <button className="secondary-button" onClick={onNew}>
          <Plus size={16} />
          新建
        </button>
        <button className="secondary-button" onClick={onSave}>
          <Save size={16} />
          保存
        </button>
        <button className="secondary-button" onClick={onLoad}>
          <FolderOpen size={16} />
          加载
        </button>
        <button className="secondary-button" onClick={onExport}>
          <Download size={16} />
          导出JSON
        </button>
        <label className="secondary-button import-button">
          <Upload size={16} />
          导入JSON
          <input
            type="file"
            accept="application/json,.json,.videogen.json"
            onChange={(event) => onImport(event.target.files?.[0])}
          />
        </label>
      </div>
    </section>
  );
}

function AnalyzeInputPage({
  prompt,
  sourceVideo,
  sourceVideoMeta,
  sourcePreviewUrl,
  videoDuration,
  analysisResult,
  analysisSource,
  segments,
  geminiManualPrompt,
  rawGeminiResult,
  geminiParseError,
  isGeminiPromptCopied,
  geminiBridgeUrl,
  geminiBridgeHealth,
  geminiBridgeTask,
  isGeminiBridgeBusy,
  isAnalyzing,
  onPromptChange,
  onFile,
  onDuration,
  onAnalyze,
  onResetPrompt,
  onSavePrompt,
  onCopyGeminiPrompt,
  onOpenGemini,
  onRawGeminiResult,
  onLoadGeminiResult,
  onGeminiBridgeUrl,
  onCheckGeminiBridge,
  onCreateGeminiBridgeTask,
  onPrepareGeminiBridgeTask,
  onCaptureGeminiBridgeResult,
  onNext
}: {
  prompt: string;
  sourceVideo?: File;
  sourceVideoMeta?: ProjectSnapshot["sourceVideoMeta"];
  sourcePreviewUrl: string;
  videoDuration: number;
  analysisResult: AnalysisResult | null;
  analysisSource: "none" | "mock" | "gemini-web-manual" | "gemini-web-automation";
  segments: VideoSegment[];
  geminiManualPrompt: string;
  rawGeminiResult: string;
  geminiParseError: string;
  isGeminiPromptCopied: boolean;
  geminiBridgeUrl: string;
  geminiBridgeHealth: "unknown" | "online" | "offline";
  geminiBridgeTask: GeminiBridgeTask | null;
  isGeminiBridgeBusy: boolean;
  isAnalyzing: boolean;
  onPromptChange: (value: string) => void;
  onFile: (file?: File) => void;
  onDuration: (duration: number) => void;
  onAnalyze: () => void;
  onResetPrompt: () => void;
  onSavePrompt: () => void;
  onCopyGeminiPrompt: () => void;
  onOpenGemini: () => void;
  onRawGeminiResult: (value: string) => void;
  onLoadGeminiResult: () => void;
  onGeminiBridgeUrl: (value: string) => void;
  onCheckGeminiBridge: () => void;
  onCreateGeminiBridgeTask: () => void;
  onPrepareGeminiBridgeTask: () => void;
  onCaptureGeminiBridgeResult: () => void;
  onNext: () => void;
}) {
  return (
    <section className="workspace two-columns">
      <div className="panel input-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Page 1</p>
            <h2>视频分析输入</h2>
          </div>
          <div className="prompt-actions">
            <button className="icon-button" onClick={onSavePrompt} title="保存 Prompt">
              <Save size={18} />
            </button>
            <button className="icon-button" onClick={onResetPrompt} title="恢复默认提示词">
              <RefreshCw size={18} />
            </button>
          </div>
        </div>

        <textarea
          id="prompt-editor"
          className="prompt-editor"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
        />

        <label
          className="upload-box"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            onFile(event.dataTransfer.files[0]);
          }}
        >
          <input type="file" accept="video/*" onChange={(event) => onFile(event.target.files?.[0])} />
          <UploadCloud size={26} />
          <strong>{sourceVideo ? sourceVideo.name : "上传或拖入对标视频"}</strong>
          <small>
            {sourceVideo
              ? `${formatBytes(sourceVideo.size)} · ${videoDuration ? `${Math.round(videoDuration)}秒` : "读取时长中"}`
              : "可以先不上传，直接运行 API 分析；真实分析时再挂载视频"}
          </small>
        </label>

        {sourcePreviewUrl && (
          <video
            className="source-preview"
            src={sourcePreviewUrl}
            controls
            onLoadedMetadata={(event) => onDuration(event.currentTarget.duration)}
          />
        )}

        <button className="primary-button" onClick={onAnalyze} disabled={isAnalyzing}>
          {isAnalyzing ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
          {isAnalyzing ? "分析中" : "API分析"}
        </button>
      </div>

      <div className="panel result-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Project State</p>
            <h2>当前工程数据</h2>
          </div>
          <button className="secondary-button" onClick={onNext}>查看报告页</button>
        </div>

        <div className="info-grid">
          <InfoItem label="视频文件" value={sourceVideoMeta ? sourceVideoMeta.name : "未上传"} />
          <InfoItem label="视频时长" value={videoDuration ? `${Math.round(videoDuration)}秒` : "未读取"} />
          <InfoItem label="Prompt长度" value={`${prompt.length}字`} />
          <InfoItem label="分析状态" value={analysisResult ? `已有分析报告 · ${sourceLabel(analysisSource)}` : "暂无分析报告"} />
          <InfoItem label="脚本段数" value={`${segments.length}段`} />
          <InfoItem label="已生成素材" value={`${segments.filter((item) => item.status === "done").length}段`} />
          <InfoItem
            label="保存说明"
            value="工程会保存 Prompt、分析结果、脚本、生成参数和状态。视频文件本体不写入本地工程，需要重新上传或后续接素材库。"
            wide
          />
        </div>

        <GeminiManualPanel
          promptLength={geminiManualPrompt.length}
          sourceVideoMeta={sourceVideoMeta}
          rawGeminiResult={rawGeminiResult}
          parseError={geminiParseError}
          isCopied={isGeminiPromptCopied}
          onCopyPrompt={onCopyGeminiPrompt}
          onOpenGemini={onOpenGemini}
          onRawResult={onRawGeminiResult}
          onLoadResult={onLoadGeminiResult}
        />

        <GeminiBridgePanel
          bridgeUrl={geminiBridgeUrl}
          health={geminiBridgeHealth}
          task={geminiBridgeTask}
          isBusy={isGeminiBridgeBusy}
          hasVideo={Boolean(sourceVideo)}
          onBridgeUrl={onGeminiBridgeUrl}
          onCheck={onCheckGeminiBridge}
          onCreateTask={onCreateGeminiBridgeTask}
          onPrepare={onPrepareGeminiBridgeTask}
          onCapture={onCaptureGeminiBridgeResult}
        />
      </div>
    </section>
  );
}

function GeminiManualPanel({
  promptLength,
  sourceVideoMeta,
  rawGeminiResult,
  parseError,
  isCopied,
  onCopyPrompt,
  onOpenGemini,
  onRawResult,
  onLoadResult
}: {
  promptLength: number;
  sourceVideoMeta?: ProjectSnapshot["sourceVideoMeta"];
  rawGeminiResult: string;
  parseError: string;
  isCopied: boolean;
  onCopyPrompt: () => void;
  onOpenGemini: () => void;
  onRawResult: (value: string) => void;
  onLoadResult: () => void;
}) {
  return (
    <section className="gemini-panel">
      <div className="panel-heading inline-heading">
        <div>
          <p className="eyebrow">Gemini Web Manual Mode</p>
          <h2>手动 Gemini 分析</h2>
        </div>
        <span className="source-pill">{sourceVideoMeta ? "视频已挂载" : "可先复制 Prompt"}</span>
      </div>

      <div className="gemini-steps">
        <div>
          <strong>1</strong>
          <span>复制增强 Prompt</span>
        </div>
        <div>
          <strong>2</strong>
          <span>打开 Gemini 并上传视频</span>
        </div>
        <div>
          <strong>3</strong>
          <span>粘贴 Gemini 输出并加载</span>
        </div>
      </div>

      <div className="button-row">
        <button className="secondary-button" onClick={onCopyPrompt}>
          <Copy size={16} />
          {isCopied ? "已复制" : `复制 Prompt (${promptLength}字)`}
        </button>
        <button className="secondary-button" onClick={onOpenGemini}>
          <ExternalLink size={16} />
          打开 Gemini
        </button>
      </div>

      <label className="field-label" htmlFor="gemini-result">
        Gemini 返回结果
      </label>
      <textarea
        id="gemini-result"
        className="gemini-result-editor"
        value={rawGeminiResult}
        placeholder="把 Gemini 的完整输出粘贴到这里。系统会优先解析最后的 ```json 代码块。"
        onChange={(event) => onRawResult(event.target.value)}
      />
      {parseError && <div className="parse-error">{parseError}</div>}
      <button className="primary-button" onClick={onLoadResult} disabled={!rawGeminiResult.trim()}>
        <FileJson size={18} />
        解析并加载到工程
      </button>

    </section>
  );
}

function GeminiBridgePanel({
  bridgeUrl,
  health,
  task,
  isBusy,
  hasVideo,
  onBridgeUrl,
  onCheck,
  onCreateTask,
  onPrepare,
  onCapture
}: {
  bridgeUrl: string;
  health: "unknown" | "online" | "offline";
  task: GeminiBridgeTask | null;
  isBusy: boolean;
  hasVideo: boolean;
  onBridgeUrl: (value: string) => void;
  onCheck: () => void;
  onCreateTask: () => void;
  onPrepare: () => void;
  onCapture: () => void;
}) {
  return (
    <section className="gemini-panel bridge-panel">
      <div className="panel-heading inline-heading">
        <div>
          <p className="eyebrow">Gemini Web Automation</p>
          <h2>网页自动辅助</h2>
        </div>
        <span className={`source-pill ${health}`}>{bridgeHealthLabel(health)}</span>
      </div>

      <div className="bridge-url-row">
        <label>
          <span>Bridge 地址</span>
          <input value={bridgeUrl} onChange={(event) => onBridgeUrl(event.target.value)} />
        </label>
        <button className="secondary-button" onClick={onCheck} disabled={isBusy}>
          {isBusy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          检查
        </button>
      </div>

      <div className="gemini-steps">
        <div>
          <strong>1</strong>
          <span>创建 Bridge 任务并保存视频</span>
        </div>
        <div>
          <strong>2</strong>
          <span>准备 Gemini 页面，发送前停止</span>
        </div>
        <div>
          <strong>3</strong>
          <span>用户发送后抓取回复</span>
        </div>
      </div>

      <div className="button-row">
        <button className="secondary-button" onClick={onCreateTask} disabled={isBusy}>
          {isBusy ? <Loader2 className="spin" size={16} /> : <Upload size={16} />}
          创建任务
        </button>
        <button className="secondary-button" onClick={onPrepare} disabled={isBusy || !task}>
          {isBusy ? <Loader2 className="spin" size={16} /> : <ExternalLink size={16} />}
          准备 Gemini 页面
        </button>
        <button className="secondary-button" onClick={onCapture} disabled={isBusy || !task}>
          {isBusy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
          抓取回复
        </button>
      </div>

      {!hasVideo && (
        <div className="bridge-warning">当前工程未挂载视频。Bridge 仍可填入 Prompt，但视频需要你在 Gemini 页面手动上传。</div>
      )}

      {task ? (
        <div className="bridge-task">
          <div className="summary-strip">
            <strong>{bridgeTaskStatusLabel(task.status)}</strong>
            <span>{task.videoOriginalName || "无视频文件"}</span>
            <span>{task.id}</span>
          </div>
          <div className="bridge-log">
            {task.logs.length ? task.logs.map((line) => <span key={line}>{line}</span>) : <span>暂无日志</span>}
          </div>
        </div>
      ) : (
        <article className="mini-card automation-note">
          <h3>运行方式</h3>
          <p>先在终端运行 npm run bridge。首次准备 Gemini 页面时会打开一个独立 Chrome 用户目录，你需要登录一次 Gemini。Bridge 不会自动点击发送。</p>
        </article>
      )}
    </section>
  );
}

function AnalysisReportPage({
  result,
  reportSection,
  onSection,
  onBack,
  onExtract,
  onCreateMock
}: {
  result: AnalysisResult | null;
  reportSection: string;
  onSection: (value: string) => void;
  onBack: () => void;
  onExtract: () => void;
  onCreateMock: () => void;
}) {
  return (
    <section className="workspace report-layout">
      <aside className="panel report-nav">
        <p className="eyebrow">Page 2</p>
        <h2>报告目录</h2>
        <div className="report-nav-list">
          {reportSections.map((section) => (
            <button
              key={section.key}
              className={reportSection === section.key ? "active" : ""}
              onClick={() => onSection(section.key)}
            >
              <FileText size={16} />
              {section.label}
            </button>
          ))}
        </div>
        <button className="secondary-button full" onClick={onBack}>返回输入页</button>
        <button className="primary-button" onClick={onExtract}>
          <Layers size={18} />
          提取脚本进入下一页
        </button>
      </aside>

      <div className="panel result-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Analysis Report</p>
            <h2>爆款分析报告</h2>
          </div>
          <button className="secondary-button" onClick={onCreateMock}>生成API报告</button>
        </div>

        {!result ? (
          <div className="empty-state">
            <ClipboardList size={42} />
            <strong>当前工程暂无分析报告</strong>
            <span>页面可以直接进入；需要报告时可回到输入页分析，或先生成 API 报告继续搭建后续流程。</span>
          </div>
        ) : (
          <AnalysisTabContent result={result} tab={reportSection} />
        )}
      </div>
    </section>
  );
}

function ScriptEditorPage({
  analysisResult,
  segments,
  onSegment,
  onCreate,
  onBack,
  onNext
}: {
  analysisResult: AnalysisResult | null;
  segments: VideoSegment[];
  onSegment: (id: string, patch: Partial<VideoSegment>) => void;
  onCreate: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
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

        {!segments.length ? (
          <div className="empty-state compact-empty">
            <FileText size={38} />
            <strong>当前工程暂无脚本段</strong>
            <span>可以直接创建默认五段脚本，也可以先在报告页提取。</span>
          </div>
        ) : (
          <div className="segment-editor-list relaxed">
            {segments.map((segment) => (
              <article className="segment-editor" key={segment.id}>
                <div className="card-title-row">
                  <div>
                    <h3>{segment.title}</h3>
                    <small>{segment.role} · {segment.duration}秒</small>
                  </div>
                  <span className={`status ${segment.status}`}>{statusLabel(segment.status)}</span>
                </div>
                <label>
                  <span>脚本文案</span>
                  <textarea
                    value={segment.scriptText}
                    onChange={(event) => onSegment(segment.id, { scriptText: event.target.value })}
                  />
                </label>
                <label>
                  <span>画面/生成提示语</span>
                  <textarea
                    value={segment.generationPrompt}
                    onChange={(event) => onSegment(segment.id, { generationPrompt: event.target.value })}
                  />
                </label>
              </article>
            ))}
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
  );
}

function VideoGeneratePage({
  options,
  segments,
  sourcePreviewUrl,
  onOptions,
  onSegment,
  onCreate,
  onGenerate,
  onBack,
  onNext
}: {
  options: GenerationOptions;
  segments: VideoSegment[];
  sourcePreviewUrl: string;
  onOptions: (patch: Partial<GenerationOptions>) => void;
  onSegment: (id: string, patch: Partial<VideoSegment>) => void;
  onCreate: () => void;
  onGenerate: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <section className="workspace two-columns generate-layout">
      <div className="panel script-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Page 4</p>
            <h2>分段视频生成</h2>
          </div>
          <button className="secondary-button" onClick={onBack}>返回脚本页</button>
        </div>

        <div className="control-grid">
          <label>
            <span>视频模型</span>
            <select
              value={options.provider}
              onChange={(event) => onOptions({ provider: event.target.value as Provider })}
            >
              {providers.map((provider) => (
                <option value={provider.value} key={provider.value}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>画幅</span>
            <select
              value={options.aspectRatio}
              onChange={(event) => onOptions({ aspectRatio: event.target.value as GenerationOptions["aspectRatio"] })}
            >
              <option value="9:16">9:16 竖屏</option>
              <option value="16:9">16:9 横屏</option>
              <option value="1:1">1:1 方屏</option>
            </select>
          </label>
          <label>
            <span>清晰度</span>
            <select
              value={options.resolution}
              onChange={(event) => onOptions({ resolution: event.target.value as GenerationOptions["resolution"] })}
            >
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
            </select>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={options.subtitles}
              onChange={(event) => onOptions({ subtitles: event.target.checked })}
            />
            <span>生成字幕轨道</span>
          </label>
        </div>

        <label className="field-label" htmlFor="style-input">统一风格</label>
        <input
          id="style-input"
          className="text-input"
          value={options.style}
          onChange={(event) => onOptions({ style: event.target.value })}
        />

        {!segments.length ? (
          <div className="empty-state compact-empty">
            <Film size={38} />
            <strong>当前工程暂无生成队列</strong>
            <span>可以先创建五段脚本，再生成素材。</span>
            <button className="secondary-button" onClick={onCreate}>创建生成队列</button>
          </div>
        ) : (
          <div className="segment-editor-list relaxed">
            {segments.map((segment) => (
              <article className="segment-editor" key={segment.id}>
                <div className="card-title-row">
                  <div>
                    <h3>{segment.title}</h3>
                    <small>{segment.role} · {segment.duration}秒 · {providerLabel(segment.provider)}</small>
                  </div>
                  <span className={`status ${segment.status}`}>{statusLabel(segment.status)}</span>
                </div>
                <label>
                  <span>生成提示语</span>
                  <textarea
                    value={segment.generationPrompt}
                    onChange={(event) => onSegment(segment.id, { generationPrompt: event.target.value })}
                  />
                </label>
                <div className="reference-image-section">
                  <span className="section-label">参考图片</span>
                  <div className="reference-image-content">
                    {segment.referenceImageUrl ? (
                      <div className="reference-thumbnail-wrapper">
                        <img className="reference-thumbnail" src={segment.referenceImageUrl} alt="Reference" />
                        <button 
                          className="icon-button delete-reference" 
                          onClick={() => onSegment(segment.id, { referenceImageUrl: undefined, referenceImageFile: undefined })}
                          title="移除参考图"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div className="reference-thumbnail-placeholder">
                        <ImageIcon size={24} />
                        <span>无参考图</span>
                      </div>
                    )}
                    <div className="reference-actions">
                      <label className="secondary-button compact">
                        <Upload size={14} />
                        上传图片
                        <input
                          type="file"
                          accept="image/*"
                          style={{ display: "none" }}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              const url = URL.createObjectURL(file);
                              onSegment(segment.id, { referenceImageFile: file, referenceImageUrl: url });
                            }
                            e.target.value = '';
                          }}
                        />
                      </label>
                      <button 
                        className="secondary-button compact" 
                        disabled={segment.isGeneratingImage}
                        onClick={() => {
                          onSegment(segment.id, { isGeneratingImage: true });
                          setTimeout(() => {
                            const mockUrl = `https://images.unsplash.com/photo-1616423640778-28d1b53229bd?w=400&q=80&random=${segment.id}`;
                            onSegment(segment.id, { isGeneratingImage: false, referenceImageUrl: mockUrl });
                          }, 2000);
                        }}
                      >
                        {segment.isGeneratingImage ? <Loader2 className="spin" size={14} /> : <ImageIcon size={14} />}
                        {segment.isGeneratingImage ? "生成中..." : "生成参考图"}
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="panel preview-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Generation Queue</p>
            <h2>素材预览</h2>
          </div>
          <button className="primary-button compact" onClick={onGenerate}>
            <Wand2 size={18} />
            生成全部
          </button>
        </div>

        <SegmentVideoGrid segments={segments} sourcePreviewUrl={sourcePreviewUrl} />

        <div className="bottom-actions">
          <button className="secondary-button" onClick={onBack}>上一步</button>
          <button className="primary-button" onClick={onNext}>进入审核合成</button>
        </div>
      </div>
    </section>
  );
}

function ComposeExportPage({
  segments,
  totalDuration,
  composeStatus,
  onSegment,
  onMove,
  onBack,
  onCompose,
  onExport
}: {
  segments: VideoSegment[];
  totalDuration: number;
  composeStatus: "idle" | "running" | "done";
  onSegment: (id: string, patch: Partial<VideoSegment>) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onBack: () => void;
  onCompose: () => void;
  onExport: () => void;
}) {
  return (
    <section className="workspace compose-workspace">
      <div className="panel compose-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Page 5</p>
            <h2>素材审核、合成与剪映导入</h2>
          </div>
          <div className="compose-meta">
            <span>{segments.length}段</span>
            <span>{totalDuration}秒</span>
          </div>
        </div>

        {!segments.length ? (
          <div className="empty-state">
            <FileVideo size={42} />
            <strong>当前工程暂无素材段</strong>
            <span>页面不锁定，但一键合成和剪映工程包需要至少一段视频脚本。</span>
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
                      <small>{segment.duration}秒 · {statusLabel(segment.status)}</small>
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
                  <textarea
                    value={segment.scriptText}
                    onChange={(event) => onSegment(segment.id, { scriptText: event.target.value })}
                  />
                  <p>{segment.generationPrompt}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <footer className="fixed-action-bar">
        <button className="secondary-button" onClick={onBack}>返回生成页</button>
        <button className="primary-button" onClick={onCompose}>
          {composeStatus === "running" ? <Loader2 className="spin" size={18} /> : <Scissors size={18} />}
          {composeStatus === "done" ? "已合成" : "一键合成"}
        </button>
        <button className="primary-button dark" onClick={onExport}>
          <PackageOpen size={18} />
          导入剪映
        </button>
      </footer>
    </section>
  );
}

function SegmentVideoGrid({ segments, sourcePreviewUrl }: { segments: VideoSegment[]; sourcePreviewUrl: string }) {
  if (!segments.length) {
    return (
      <div className="empty-state">
        <Film size={42} />
        <strong>暂无视频段</strong>
        <span>生成队列创建后，这里会展示每段视频和对应脚本。</span>
      </div>
    );
  }

  return (
    <div className="video-grid">
      {segments.map((segment) => (
        <article className="video-card" key={segment.id}>
          <div className="video-frame">
            {segment.status === "generating" ? (
              <div className="video-placeholder">
                <Loader2 className="spin" size={28} />
                <span>生成中</span>
              </div>
            ) : segment.videoUrl || sourcePreviewUrl ? (
              <video src={segment.videoUrl || sourcePreviewUrl} controls />
            ) : (
              <div className="video-placeholder">
                <Film size={28} />
                <span>等待素材</span>
              </div>
            )}
          </div>
          <div className="video-card-body">
            <strong>{segment.title}</strong>
            <small>{segment.scriptText}</small>
          </div>
        </article>
      ))}
    </div>
  );
}

function AnalysisTabContent({ result, tab }: { result: AnalysisResult; tab: string }) {
  if (tab === "basic") {
    return (
      <div className="info-grid">
        <InfoItem label="视频时长" value={`${result.basicInfo.duration}秒`} />
        <InfoItem label="主题归类" value={result.basicInfo.topicType} />
        <InfoItem label="素材类型" value={result.basicInfo.materialType} />
        <InfoItem label="目标人群" value={result.basicInfo.targetAudience} />
        <InfoItem label="组合等级" value={result.basicInfo.priorityLevel} wide />
        <InfoItem label="一句话总结" value={result.summary} wide />
      </div>
    );
  }

  if (tab === "narrative") {
    const sections = [
      result.narrative.hook,
      result.narrative.painPoint,
      result.narrative.usp,
      result.narrative.trustProof,
      result.narrative.cta
    ];
    return (
      <div className="stack">
        {sections.map((section, index) => (
          <article className="mini-card" key={section.range}>
            <div className="card-title-row">
              <h3>第{index + 1}段 · {section.range}</h3>
              <span className={`rating ${section.rating}`}>{section.rating}</span>
            </div>
            <p>{section.actual}</p>
            <small>{section.type} · {section.reason}</small>
          </article>
        ))}
        <div className="summary-strip">
          <strong>{result.narrative.completenessScore}</strong>
          <span>{result.narrative.rhythm}</span>
          <span>{result.narrative.structureIssue}</span>
        </div>
      </div>
    );
  }

  if (tab === "technique") {
    return (
      <div className="info-grid">
        <InfoItem label="画面风格" value={result.techniques.visualStyle} />
        <InfoItem label="画面节奏" value={result.techniques.pacing} />
        <InfoItem label="字幕策略" value={result.techniques.subtitles} />
        <InfoItem label="BGM" value={result.techniques.bgm} />
        <InfoItem label="人声处理" value={result.techniques.voice} />
        <InfoItem label="特殊手法" value={result.techniques.specialTechniques} />
        <InfoItem label="亮点" value={result.techniques.highlights.join("；")} wide />
        <InfoItem label="问题" value={result.techniques.problems.join("；")} wide />
      </div>
    );
  }

  if (tab === "data") {
    return (
      <div className="stack">
        <table className="metric-table">
          <thead>
            <tr>
              <th>指标</th>
              <th>预测值</th>
              <th>核心素材标准</th>
              <th>达标</th>
            </tr>
          </thead>
          <tbody>
            {result.dataPrediction.rows.map((row) => (
              <tr key={row.metric}>
                <td>{row.metric}</td>
                <td>{row.predicted}</td>
                <td>{row.standard}</td>
                <td>{row.passed ? "达标" : "未达标"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="summary-strip">
          <strong>核心概率：{result.dataPrediction.coreProbability}</strong>
          <span>{result.dataPrediction.biggestShortboard}</span>
          <span>{result.dataPrediction.keyOptimization}</span>
        </div>
      </div>
    );
  }

  if (tab === "execution") {
    return (
      <div className="stack">
        {result.executionPlan.rewriteSegments.map((item) => (
          <article className="mini-card" key={item.range}>
            <h3>可仿写：{item.range}</h3>
            <p>{item.content}</p>
            <small>{item.reason} · {item.direction}</small>
          </article>
        ))}
        {result.executionPlan.replaceSegments.map((item) => (
          <article className="mini-card warning" key={item.range}>
            <h3>需替换：{item.range}</h3>
            <p>{item.current}</p>
            <small>{item.reason} · {item.replacement}</small>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className="stack">
      {Object.entries(result.videoPrompts).map(([key, value]) => (
        <article className="prompt-card" key={key}>
          <strong>{promptLabel(key)}</strong>
          <p>{value}</p>
        </article>
      ))}
    </div>
  );
}

function InfoItem({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`info-item ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function providerLabel(value: Provider) {
  return providers.find((provider) => provider.value === value)?.label ?? value;
}

function sourceLabel(value: "none" | "mock" | "gemini-web-manual" | "gemini-web-automation") {
  const labels = {
    none: "无",
    mock: "模拟",
    "gemini-web-manual": "Gemini手动",
    "gemini-web-automation": "Gemini网页辅助"
  };
  return labels[value];
}

function bridgeHealthLabel(value: "unknown" | "online" | "offline") {
  const labels = {
    unknown: "未检查",
    online: "Bridge在线",
    offline: "Bridge离线"
  };
  return labels[value];
}

function bridgeTaskStatusLabel(value: string) {
  const labels: Record<string, string> = {
    created: "任务已创建",
    "browser-opened": "Gemini已打开",
    "prompt-filled": "Prompt已填入",
    "video-attached": "视频已挂载",
    "ready-for-user-send": "等待用户发送",
    "capture-ready": "已抓取回复",
    error: "任务异常"
  };
  return labels[value] ?? value;
}

function lastLog(task: GeminiBridgeTask) {
  return task.logs[task.logs.length - 1];
}

function statusLabel(status: VideoSegment["status"]) {
  const labels = {
    idle: "待生成",
    queued: "排队中",
    generating: "生成中",
    done: "已完成",
    failed: "失败"
  };
  return labels[status];
}

function promptLabel(key: string) {
  const labels: Record<string, string> = {
    hookPrompt: "钩子优化",
    painPointPrompt: "痛点段落",
    uspPrompt: "USP展示",
    trustPrompt: "信任证明",
    ctaPrompt: "CTA优化"
  };
  return labels[key] ?? key;
}

function readSavedPrompt() {
  return localStorage.getItem(PROMPT_STORAGE_KEY) || defaultAnalysisPrompt;
}

function serializeSegments(segments: VideoSegment[]) {
  return segments.map(stripTransientSegmentFields);
}

function stripTransientSegmentFields(segment: VideoSegment): VideoSegment {
  const { sourceFile, referenceImageFile, isGeneratingImage, ...rest } = segment;
  return {
    ...rest,
    videoUrl: isDurableUrl(rest.videoUrl) ? rest.videoUrl : undefined,
    referenceImageUrl: isDurableUrl(rest.referenceImageUrl) ? rest.referenceImageUrl : undefined
  };
}

function isDurableUrl(url?: string) {
  return Boolean(url && !url.startsWith("blob:"));
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
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

function sanitizeName(name: string) {
  return (name || "videogen_project")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
