import { Download, ExternalLink, Loader2, RefreshCw, Upload } from "lucide-react";
import type { GeminiBridgeTask } from "../../domain/geminiBridge";
import { bridgeHealthLabel, bridgeTaskStatusLabel, type GeminiBridgeHealth } from "./geminiLabels";

export function GeminiBridgePanel({
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
  health: GeminiBridgeHealth;
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
