import { Loader2, RefreshCw, Save, Sparkles, UploadCloud } from "lucide-react";
import { InfoItem } from "../../components/common/InfoItem";
import type { AnalysisSource } from "../../domain/analysisSource";
import { analysisSourceLabel } from "../../domain/analysisSource";
import type { GeminiBridgeTask } from "../../domain/geminiBridge";
import type { ProjectSnapshot } from "../../domain/project";
import { formatBytes } from "../../services/formatters";
import type { AnalysisResult, VideoSegment } from "../../types";
import { GeminiBridgePanel } from "./GeminiBridgePanel";
import { GeminiManualPanel } from "./GeminiManualPanel";
import type { GeminiBridgeHealth } from "./geminiLabels";

export function AnalyzeInputPage({
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
  analysisSource: AnalysisSource;
  segments: VideoSegment[];
  geminiManualPrompt: string;
  rawGeminiResult: string;
  geminiParseError: string;
  isGeminiPromptCopied: boolean;
  geminiBridgeUrl: string;
  geminiBridgeHealth: GeminiBridgeHealth;
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
          <InfoItem label="分析状态" value={analysisResult ? `已有分析报告 · ${analysisSourceLabel(analysisSource)}` : "暂无分析报告"} />
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
