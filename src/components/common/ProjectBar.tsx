import { Database, Download, FolderOpen, Plus, Save, Upload } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { ProjectSnapshot } from "../../domain/project";
import { formatDateTime } from "../../services/formatters";
import type { AnalysisResult, VideoSegment } from "../../types";

export function ProjectBar({
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
        <label
          className="secondary-button import-button"
          tabIndex={0}
          role="button"
          aria-label="导入工程 JSON"
          onKeyDown={triggerNestedFileInput}
        >
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

function triggerNestedFileInput(event: KeyboardEvent<HTMLLabelElement>) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.currentTarget.querySelector("input")?.click();
}
