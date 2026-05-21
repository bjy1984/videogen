import { CheckCircle2, Clock3, FileVideo, Image as ImageIcon, Loader2, RefreshCw, Upload, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createComfyUIBridgeTask,
  getComfyUIBridgeTask,
  checkVideoGenerationBridgeHealth,
  normalizeVideoGenerationBridgeUrl,
  syncComfyUIBridgeAsset,
  uploadVideoGenerationBridgeAsset,
  type VideoGenerationBridgeHealth
} from "../../services/videoGenerationBridgeClient";
import {
  buildComfyUICreateTaskRequest,
  LTX2_HEAD_SWAP_COMFYUI_PRESET,
  mapComfyUITaskStatus,
  selectComfyUIOutputFileForNode,
  type ComfyUITaskResponse
} from "./providers/comfyuiApi";

type HeadSwapStatus = "idle" | "uploading" | "queued" | "running" | "syncing" | "done" | "failed";

const HEAD_SWAP_PROJECT_ID = "comfyui_head_swap_test";
const HEAD_SWAP_SEGMENT_ID = "head_swap_source";
const HEAD_SWAP_OUTPUT_NODE_ID = LTX2_HEAD_SWAP_COMFYUI_PRESET.outputNodeId;
const POLL_INTERVAL_MS = 8000;
const HEAD_SWAP_FALLBACK_DURATION_SECONDS = 5;
const HEAD_SWAP_MAX_DURATION_SECONDS = 60;
const HEAD_SWAP_WORKFLOW_STEPS = 8;
const HEAD_SWAP_WORKFLOW_CFG_SCALE = 1;
const HEAD_SWAP_OLLAMA_MODEL_OPTIONS = [
  "gemma4:e4b-it-q4_K_M",
  "gemma4:e2b-it-q4_K_M",
  "gemma3:12b"
];
const DEFAULT_HEAD_SWAP_PROMPT = "Identity lock: use the uploaded reference face as the only identity source. Preserve the reference face shape, facial proportions, skin tone, age range, hairline or hairstyle, eye shape, nose, mouth, and distinctive facial traits. Do not beautify, age-shift, gender-shift, average, stylize, or merge with the source-video face. Keep the original body motion, camera framing, clothing silhouette, background, readable text, logos, product details, source aspect ratio, and lighting.";

export function ComfyUITestPage({
  bridgeUrl
}: {
  bridgeUrl: string;
}) {
  const [videoFile, setVideoFile] = useState<File>();
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);
  const [referenceFile, setReferenceFile] = useState<File>();
  const [referencePreviewUrl, setReferencePreviewUrl] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_HEAD_SWAP_PROMPT);
  const [endpoint, setEndpoint] = useState(LTX2_HEAD_SWAP_COMFYUI_PRESET.endpoint);
  const [ollamaModel, setOllamaModel] = useState(LTX2_HEAD_SWAP_COMFYUI_PRESET.ollamaModel);
  const [taskEndpoint, setTaskEndpoint] = useState("");
  const [taskId, setTaskId] = useState("");
  const [status, setStatus] = useState<HeadSwapStatus>("idle");
  const [error, setError] = useState("");
  const [outputUrl, setOutputUrl] = useState("");
  const [task, setTask] = useState<ComfyUITaskResponse>();
  const [statusText, setStatusText] = useState("选择源视频和参考脸图后，可以提交 LTX2 Head Swap workflow。");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCheckingEnv, setIsCheckingEnv] = useState(false);
  const [health, setHealth] = useState<VideoGenerationBridgeHealth | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState("");
  const [pollCount, setPollCount] = useState(0);
  const isRefreshingRef = useRef(false);
  const syncedTaskRef = useRef("");

  const displayBridgeUrl = normalizeVideoGenerationBridgeUrl(bridgeUrl);
  const isBusy = status === "uploading" || status === "queued" || status === "running" || status === "syncing";
  const isPolling = Boolean(taskId && (status === "queued" || status === "running"));
  const taskStatusLabel = headSwapStatusLabel(status);
  const taskEndpointDisplay = taskEndpoint || endpoint;
  const effectiveDurationSeconds = normalizeHeadSwapDuration(videoDuration);

  const refreshComfyHeadSwapTask = useCallback(
    async (input: { manual?: boolean; taskId?: string } = {}) => {
      const activeTaskId = input.taskId || taskId;
      if (!activeTaskId || isRefreshingRef.current) return;
      isRefreshingRef.current = true;
      setIsRefreshing(true);
      setLastPolledAt(formatClock(new Date()));
      setPollCount((current) => current + 1);
      if (input.manual) setStatusText(`正在刷新 ComfyUI 任务：${activeTaskId}`);
      try {
        const nextTask = await getComfyUIBridgeTask({
          bridgeUrl,
          endpoint: taskEndpoint || endpoint,
          taskId: activeTaskId
        });
        setTask(nextTask);
        const jobStatus = mapComfyUITaskStatus(nextTask.status);
        if (jobStatus === "failed") {
          const message = nextTask.error || "ComfyUI 任务失败。";
          setStatus("failed");
          setError(message);
          setStatusText(`ComfyUI 换头失败：${message}`);
          return;
        }
        if (jobStatus === "done") {
          setStatus("syncing");
          setStatusText("ComfyUI 已完成，正在回传生成结果。");
          const output = selectComfyUIOutputFileForNode(nextTask.outputFiles, HEAD_SWAP_OUTPUT_NODE_ID);
          if (syncedTaskRef.current !== activeTaskId) {
            try {
              const synced = await syncComfyUIBridgeAsset({
                bridgeUrl,
                endpoint: taskEndpoint || endpoint,
                taskId: activeTaskId,
                projectId: HEAD_SWAP_PROJECT_ID,
                assetId: `head_swap_${Date.now()}`,
                outputNodeId: HEAD_SWAP_OUTPUT_NODE_ID,
                targetDuration: effectiveDurationSeconds
              });
              setOutputUrl(synced.asset.localAssetUrl);
              syncedTaskRef.current = activeTaskId;
            } catch (syncError) {
              if (!output?.viewUrl) throw syncError;
              setOutputUrl(output.viewUrl);
              syncedTaskRef.current = activeTaskId;
            }
          }
          setStatus("done");
          setError("");
          setStatusText("ComfyUI 换头完成，结果已回传到测试页。");
          return;
        }
        const nextStatus = jobStatus === "queued" ? "queued" : "running";
        setStatus(nextStatus);
        setStatusText(`ComfyUI 换头任务处理中：${headSwapStatusLabel(nextStatus)}，页面会继续自动轮询。`);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "未知错误";
        setStatus("failed");
        setError(message);
        setStatusText(`ComfyUI 换头刷新失败：${message}`);
      } finally {
        isRefreshingRef.current = false;
        setIsRefreshing(false);
      }
    },
    [bridgeUrl, effectiveDurationSeconds, endpoint, taskEndpoint, taskId]
  );

  useEffect(() => {
    return () => {
      if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    };
  }, [sourcePreviewUrl]);

  useEffect(() => {
    return () => {
      if (referencePreviewUrl) URL.revokeObjectURL(referencePreviewUrl);
    };
  }, [referencePreviewUrl]);

  useEffect(() => {
    if (!isPolling || !taskId) return;
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      void refreshComfyHeadSwapTask({ manual: false, taskId });
    };
    poll();
    const intervalId = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isPolling, taskId, refreshComfyHeadSwapTask]);

  const readiness = useMemo(
    () => [
      { key: "video", label: videoFile ? `源视频：${videoFile.name}` : "源视频：未选择", ready: Boolean(videoFile) },
      { key: "reference", label: referenceFile ? `参考脸图：${referenceFile.name}` : "参考脸图：未选择", ready: Boolean(referenceFile) },
      { key: "endpoint", label: endpoint.trim() ? "Endpoint：已填写" : "Endpoint：未填写", ready: Boolean(endpoint.trim()) },
      { key: "ollama", label: ollamaModel.trim() ? `Ollama：${ollamaModel.trim()}` : "Ollama：不覆盖", ready: Boolean(ollamaModel.trim()) }
    ],
    [endpoint, ollamaModel, referenceFile, videoFile]
  );

  function handleSourceVideo(file?: File) {
    if (!file) return;
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    setVideoFile(file);
    setSourcePreviewUrl(URL.createObjectURL(file));
    setVideoDuration(0);
    resetTaskState("源视频已加载。请选择参考脸图后提交 ComfyUI workflow。");
  }

  function handleReference(file?: File) {
    if (!file) return;
    if (referencePreviewUrl) URL.revokeObjectURL(referencePreviewUrl);
    setReferenceFile(file);
    setReferencePreviewUrl(URL.createObjectURL(file));
    resetTaskState("参考脸图已加载。可以提交换头测试。");
  }

  function resetTaskState(nextStatusText: string) {
    syncedTaskRef.current = "";
    setTaskEndpoint("");
    setTaskId("");
    setTask(undefined);
    setStatus("idle");
    setError("");
    setOutputUrl("");
    setLastPolledAt("");
    setPollCount(0);
    setStatusText(nextStatusText);
  }

  async function checkComfyHeadSwapEnvironment() {
    setIsCheckingEnv(true);
    setError("");
    setStatusText("正在检查 Video Bridge、ComfyUI endpoint 和 NAGCFGGuider。");
    try {
      const nextHealth = await checkVideoGenerationBridgeHealth(
        bridgeUrl,
        "ARK_API_KEY",
        endpoint.trim() || LTX2_HEAD_SWAP_COMFYUI_PRESET.endpoint
      );
      setHealth(nextHealth);
      if (!nextHealth.comfyui?.reachable) {
        const message = nextHealth.comfyui?.error || "ComfyUI endpoint 不可达。";
        setError(message);
        setStatusText(`环境检查失败：${message}`);
        return;
      }
      if (!nextHealth.comfyui.nagCfgGuiderAvailable) {
        const message = nextHealth.comfyui.nagCfgGuiderError || "ComfyUI 未注册 NAGCFGGuider，请先部署 ComfyUI-NAG LTXAV 补丁。";
        setError(message);
        setStatusText(`环境检查失败：${message}`);
        return;
      }
      setStatusText("环境检查通过：Video Bridge 在线，ComfyUI 可达，NAGCFGGuider 已注册。");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "未知错误";
      setError(message);
      setStatusText(`环境检查失败：${message}`);
    } finally {
      setIsCheckingEnv(false);
    }
  }

  async function runComfyHeadSwapTest() {
    if (!videoFile) {
      const message = "请先选择源视频。";
      setError(message);
      setStatusText(message);
      return;
    }
    if (!referenceFile) {
      const message = "请先选择参考脸图。";
      setError(message);
      setStatusText(message);
      return;
    }
    if (!endpoint.trim()) {
      const message = "请先填写 ComfyUI endpoint。";
      setError(message);
      setStatusText(message);
      return;
    }
    if (isBusy) return;

    const activeEndpoint = endpoint.trim();
    const durationSeconds = effectiveDurationSeconds;
    syncedTaskRef.current = "";
    setStatus("uploading");
    setError("");
    setOutputUrl("");
    setTask(undefined);
    setTaskId("");
    setTaskEndpoint(activeEndpoint);
    setLastPolledAt("");
    setPollCount(0);
    setStatusText("正在上传源视频和参考图到本地 Video Bridge。");
    try {
      const [sourceUpload, referenceUpload] = await Promise.all([
        uploadVideoGenerationBridgeAsset({
          bridgeUrl,
          projectId: HEAD_SWAP_PROJECT_ID,
          segmentId: HEAD_SWAP_SEGMENT_ID,
          kind: "comfyui-source-video",
          file: videoFile
        }),
        uploadVideoGenerationBridgeAsset({
          bridgeUrl,
          projectId: HEAD_SWAP_PROJECT_ID,
          segmentId: HEAD_SWAP_SEGMENT_ID,
          kind: "comfyui-reference-image",
          file: referenceFile
        })
      ]);
      const request = {
        ...buildComfyUICreateTaskRequest({
          prompt: prompt.trim() || DEFAULT_HEAD_SWAP_PROMPT,
          duration: durationSeconds,
          aspectRatio: "9:16",
          sourceVideoUrl: sourceUpload.asset.localAssetUrl,
          referenceImageUrl: referenceUpload.asset.localAssetUrl,
          params: {
            endpoint: activeEndpoint,
            workflowTemplateId: LTX2_HEAD_SWAP_COMFYUI_PRESET.workflowTemplateId,
            promptNodeId: LTX2_HEAD_SWAP_COMFYUI_PRESET.promptNodeId,
            outputNodeId: HEAD_SWAP_OUTPUT_NODE_ID,
            seed: "-1",
            steps: HEAD_SWAP_WORKFLOW_STEPS,
            cfgScale: HEAD_SWAP_WORKFLOW_CFG_SCALE,
            ollamaModel: ollamaModel.trim()
          }
        }),
        sourceVideoName: videoFile.name,
        referenceImageName: referenceFile.name
      };
      setStatusText("正在提交 ComfyUI LTX2 换头 workflow。");
      const nextTask = await createComfyUIBridgeTask({ bridgeUrl, request });
      const nextTaskId = nextTask.promptId || nextTask.id;
      if (!nextTaskId) throw new Error("ComfyUI 未返回任务 ID。");
      setTask(nextTask);
      setTaskId(nextTaskId);
      const nextStatus = toHeadSwapStatus(nextTask.status);
      if (nextStatus === "failed") {
        const message = nextTask.error || "ComfyUI workflow 提交失败。";
        setStatus("failed");
        setError(message);
        setStatusText(message);
        return;
      }
      setStatus(nextStatus === "done" ? "running" : nextStatus);
      setStatusText(`ComfyUI 换头任务已提交：${nextTaskId}。页面会立即请求结果，并每 ${POLL_INTERVAL_MS / 1000} 秒自动轮询。`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "未知错误";
      setStatus("failed");
      setError(message);
      setStatusText(`ComfyUI 换头提交失败：${message}`);
    }
  }

  return (
    <section className="workspace comfyui-test-layout">
      <div className="panel comfyui-test-main">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">ComfyUI Test</p>
            <h2>LTX2 换头测试台</h2>
          </div>
          <button className="secondary-button" onClick={runComfyHeadSwapTest} disabled={isBusy}>
            {isBusy ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
            提交换头
          </button>
        </div>

        <div className="comfyui-source-grid">
          <label className="upload-box mask-test-upload">
            <Upload size={30} />
            <strong>选择源视频</strong>
            <small>用于换头的原视频；提交后会先上传到本地 Video Bridge。</small>
            <input type="file" accept="video/*" onChange={(event) => handleSourceVideo(event.target.files?.[0])} />
          </label>
          <label className="comfyui-reference-picker large">
            {referencePreviewUrl ? <img src={referencePreviewUrl} alt="Head swap reference" /> : <ImageIcon size={30} />}
            <span>{referenceFile ? referenceFile.name : "选择参考脸图"}</span>
            <input type="file" accept="image/*" onChange={(event) => handleReference(event.target.files?.[0])} />
          </label>
        </div>

        {sourcePreviewUrl ? (
          <div className="mask-test-preview">
            <video
              src={sourcePreviewUrl}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration) && duration > 0) setVideoDuration(Math.round(duration * 100) / 100);
              }}
            />
          </div>
        ) : (
          <div className="mask-test-empty">
            <FileVideo size={42} />
            <strong>还没有选择源视频</strong>
            <span>这个页面只测试 ComfyUI 换头，不参与打码流程。</span>
          </div>
        )}

        {outputUrl && (
          <div className="comfyui-test-output standalone">
            <video src={outputUrl} controls playsInline preload="metadata" />
          </div>
        )}
      </div>

      <aside className="panel comfyui-test-side">
        <div className="panel-heading compact-heading">
          <div>
            <p className="eyebrow">Task Status</p>
            <h2>任务状态</h2>
          </div>
        </div>

        <div className={`comfyui-run-status ${status}`}>
          {isBusy ? <Loader2 className="spin" size={16} /> : status === "done" ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}
          <strong>{statusText}</strong>
        </div>

        <div className="comfyui-test-readiness" aria-label="ComfyUI 换头输入状态">
          {readiness.map((item) => (
            <span key={item.key} className={item.ready ? "ready" : "missing"}>
              {item.label}
            </span>
          ))}
        </div>

        <div className="mask-test-stats">
          <InfoBlock label="Bridge" value={displayBridgeUrl} />
          <InfoBlock label="ComfyUI" value={health?.comfyui?.reachable ? "可达" : health ? "不可达" : "未检查"} />
          <InfoBlock label="NAGCFGGuider" value={health?.comfyui?.nagCfgGuiderAvailable ? "可用" : health ? "不可用" : "未检查"} />
          <InfoBlock label="任务状态" value={taskStatusLabel} />
          <InfoBlock label="任务 ID" value={taskId ? taskId.slice(0, 12) : "-"} />
          <InfoBlock label="源视频时长" value={videoDuration ? `${videoDuration}秒` : "-"} />
          <InfoBlock label="生成参数" value={`${effectiveDurationSeconds}秒 / ${HEAD_SWAP_WORKFLOW_STEPS} steps / CFG ${HEAD_SWAP_WORKFLOW_CFG_SCALE}`} />
          <InfoBlock label="Ollama 模型" value={ollamaModel.trim() || "workflow 默认"} />
          <InfoBlock label="队列位置" value={task?.queuePosition !== undefined ? String(task.queuePosition) : "-"} />
          <InfoBlock label="轮询次数" value={String(pollCount)} />
          <InfoBlock label="最后轮询" value={lastPolledAt || "-"} />
        </div>

        <label className="comfyui-test-field">
          <span>Endpoint</span>
          <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} disabled={isBusy} />
        </label>

        <label className="comfyui-test-field">
          <span>Ollama 描述模型</span>
          <input list="comfyui-ollama-models" value={ollamaModel} onChange={(event) => setOllamaModel(event.target.value)} disabled={isBusy} />
          <datalist id="comfyui-ollama-models">
            {HEAD_SWAP_OLLAMA_MODEL_OPTIONS.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </label>

        <label className="comfyui-test-field">
          <span>Prompt</span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </label>

        <div className="comfyui-test-actions">
          <button className="secondary-button compact" onClick={() => void checkComfyHeadSwapEnvironment()} disabled={isCheckingEnv || isBusy}>
            {isCheckingEnv ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            检查环境
          </button>
          <button className="secondary-button compact" onClick={() => void refreshComfyHeadSwapTask({ manual: true })} disabled={!taskId || isRefreshing}>
            {isRefreshing ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            手动刷新
          </button>
          <span>{isPolling ? `自动轮询 ${POLL_INTERVAL_MS / 1000}s` : taskId ? "轮询已停止" : "未提交"}</span>
        </div>

        {error && <div className="comfyui-test-error">{error}</div>}
        {taskEndpointDisplay && <div className="comfyui-test-meta">当前查询 Endpoint：{taskEndpointDisplay}</div>}
        <div className="comfyui-test-meta">部署与排障文档：docs/comfyui-ltx2-head-swap.md</div>
      </aside>
    </section>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="mask-test-info">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function toHeadSwapStatus(status?: string): HeadSwapStatus {
  const jobStatus = mapComfyUITaskStatus(status);
  if (jobStatus === "done") return "done";
  if (jobStatus === "failed") return "failed";
  if (jobStatus === "queued") return "queued";
  return "running";
}

function headSwapStatusLabel(status: HeadSwapStatus) {
  if (status === "uploading") return "上传中";
  if (status === "queued") return "排队中";
  if (status === "running") return "生成中";
  if (status === "syncing") return "回传中";
  if (status === "done") return "已完成";
  if (status === "failed") return "失败";
  return "未提交";
}

function formatClock(value: Date) {
  return value.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function normalizeHeadSwapDuration(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return HEAD_SWAP_FALLBACK_DURATION_SECONDS;
  return Math.round(Math.min(duration, HEAD_SWAP_MAX_DURATION_SECONDS) * 100) / 100;
}
