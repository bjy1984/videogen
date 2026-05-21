import type { GenerationOptions, Provider, StepKey } from "../types";

export const workflowPages: Array<{ key: StepKey; title: string; subtitle: string }> = [
  { key: "input", title: "视频分析输入", subtitle: "Prompt + 上传" },
  { key: "report", title: "爆款分析报告", subtitle: "6层拆解" },
  { key: "script", title: "脚本拆分编辑", subtitle: "5段式脚本" },
  { key: "generate", title: "分段视频生成", subtitle: "模型 + 队列" },
  { key: "depth", title: "深度视频工作台", subtitle: "标签 + 深度 + AI" },
  { key: "compose", title: "审核合成导出", subtitle: "剪映工程包" }
];

export const generationProviders: Array<{ value: Provider; label: string }> = [
  { value: "mock", label: "Local Mock" },
  { value: "comfyui", label: "ComfyUI" },
  { value: "seedance", label: "Seedance" }
];

export const analysisReportSections = [
  { key: "basic", label: "视频基本信息" },
  { key: "narrative", label: "L3叙事拆解" },
  { key: "technique", label: "L4手法分析" },
  { key: "data", label: "L5数据预测" },
  { key: "execution", label: "执行方案" },
  { key: "prompts", label: "生成提示语" }
];

export const initialGenerationOptions: GenerationOptions = {
  provider: "seedance",
  aspectRatio: "9:16",
  style: "抖音电商实拍，真实生活场景，结果感强",
  resolution: "1080p",
  subtitles: true
};
