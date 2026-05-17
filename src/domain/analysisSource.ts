export type AnalysisSource = "none" | "mock" | "gemini-web-manual" | "gemini-web-automation";

export function analysisSourceLabel(value: AnalysisSource) {
  const labels = {
    none: "无",
    mock: "模拟",
    "gemini-web-manual": "Gemini手动",
    "gemini-web-automation": "Gemini网页辅助"
  };
  return labels[value];
}
