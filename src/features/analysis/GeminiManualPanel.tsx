import { Copy, ExternalLink, FileJson } from "lucide-react";
import type { ProjectSnapshot } from "../../domain/project";

export function GeminiManualPanel({
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
