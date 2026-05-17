import { ClipboardList, FileText, Layers } from "lucide-react";
import { analysisReportSections } from "../../app/workflow";
import { InfoItem } from "../../components/common/InfoItem";
import type { AnalysisResult } from "../../types";

export function AnalysisReportPage({
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
          {analysisReportSections.map((section) => (
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
