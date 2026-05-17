import type { AnalysisResult, GenerationOptions, VideoSegment } from "../../types";

export function createSegmentsFromAnalysis(
  analysis: AnalysisResult,
  options: GenerationOptions,
  sourceFile?: File
): VideoSegment[] {
  return [
    {
      id: "hook",
      title: "第1段：钩子",
      role: "0-3秒",
      bucketRole: "hook",
      contentStatus: "draft",
      duration: 3,
      scriptText: "染烫后先看你是哪一级受损。",
      subtitleText: "染烫后先看你是哪一级受损。",
      overlayText: "先判断受损等级",
      generationPrompt: analysis.videoPrompts.hookPrompt,
      provider: options.provider,
      status: "idle",
      sourceFile
    },
    {
      id: "pain",
      title: "第2段：痛点放大",
      role: "3-10秒",
      bucketRole: "pain",
      contentStatus: "draft",
      duration: 7,
      scriptText: "不是你不会护发，是你没先判断受损等级。",
      subtitleText: "不是你不会护发，是你没先判断受损等级。",
      overlayText: "问题在判断",
      generationPrompt: analysis.videoPrompts.painPointPrompt,
      provider: options.provider,
      status: "idle",
      sourceFile
    },
    {
      id: "usp",
      title: "第3段：解决方案/USP",
      role: "10-20秒",
      bucketRole: "usp",
      contentStatus: "draft",
      duration: 10,
      scriptText: "不同受损等级，要用不同修护思路。",
      subtitleText: "不同受损等级，要用不同修护思路。",
      overlayText: "分级修护",
      generationPrompt: analysis.videoPrompts.uspPrompt,
      provider: options.provider,
      status: "idle",
      sourceFile
    },
    {
      id: "trust",
      title: "第4段：信任证明",
      role: "20-28秒",
      bucketRole: "trust",
      contentStatus: "draft",
      duration: 8,
      scriptText: "看发尾顺滑度和毛躁变化，比只听功效更直接。",
      subtitleText: "看发尾顺滑度和毛躁变化，比只听功效更直接。",
      overlayText: "看得见的变化",
      generationPrompt: analysis.videoPrompts.trustPrompt,
      provider: options.provider,
      status: "idle",
      sourceFile
    },
    {
      id: "cta",
      title: "第5段：行动号召CTA",
      role: "最后5秒",
      bucketRole: "cta",
      contentStatus: "draft",
      duration: 5,
      scriptText: "今晚前拍，先测发质等级再护理。",
      subtitleText: "今晚前拍，先测发质等级再护理。",
      overlayText: "先测再护理",
      generationPrompt: analysis.videoPrompts.ctaPrompt,
      provider: options.provider,
      status: "idle",
      sourceFile
    }
  ];
}
