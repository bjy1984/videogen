import type { AnalysisResult } from "./types";

export interface GeminiPromptInput {
  basePrompt: string;
  sourceVideoMeta?: {
    name: string;
    size: number;
    type: string;
  };
  videoDuration: number;
}

export function buildGeminiManualPrompt(input: GeminiPromptInput) {
  const videoInfo = [
    `视频文件名：${input.sourceVideoMeta?.name ?? "请分析我在本轮 Gemini 对话中上传的视频"}`,
    `视频类型：${input.sourceVideoMeta?.type ?? "未知"}`,
    `视频大小：${input.sourceVideoMeta ? formatBytes(input.sourceVideoMeta.size) : "未知"}`,
    `本地读取时长：${input.videoDuration ? `${Math.round(input.videoDuration)}秒` : "以 Gemini 实际识别为准"}`
  ].join("\n");

  return `${input.basePrompt}

═════════════════════════════════════════════════════
▎ 当前视频信息
═════════════════════════════════════════════════════

${videoInfo}

请基于我在 Gemini 对话中上传的视频完成分析。如果视频时长、画面内容或音频信息与上述本地信息不一致，以你实际识别到的视频内容为准。

═════════════════════════════════════════════════════
▎ 工程回填要求
═════════════════════════════════════════════════════

请先输出完整 Markdown 分析报告，保持前文要求的中文结构。

然后在最后额外输出一个 JSON 代码块，用于系统解析。JSON 必须满足：
- 只输出合法 JSON，不要写注释
- 不要使用 Markdown 表格字符串替代数组对象
- 所有字段必须存在，没有信息时用合理的空字符串或空数组
- 字段名必须使用下面的英文 key

\`\`\`json
{
  "basicInfo": {
    "duration": 45,
    "topicType": "分级概念",
    "materialType": "人工优化",
    "targetAudience": "35岁+女性",
    "priorityLevel": "P0"
  },
  "narrative": {
    "hook": {
      "range": "0-3秒",
      "actual": "",
      "type": "",
      "rating": "有效",
      "reason": "",
      "suggestions": []
    },
    "painPoint": {
      "range": "3-10秒",
      "actual": "",
      "type": "",
      "rating": "一般",
      "reason": "",
      "suggestions": []
    },
    "usp": {
      "range": "10-20秒",
      "actual": "",
      "type": "",
      "rating": "一般",
      "reason": "",
      "suggestions": []
    },
    "trustProof": {
      "range": "贯穿全程",
      "actual": "",
      "type": "",
      "rating": "一般",
      "reason": "",
      "suggestions": []
    },
    "cta": {
      "range": "最后5秒",
      "actual": "",
      "type": "",
      "rating": "一般",
      "reason": "",
      "suggestions": []
    },
    "completenessScore": "4/5段",
    "rhythm": "紧凑合理",
    "structureIssue": "",
    "priority": ""
  },
  "techniques": {
    "visualStyle": "",
    "pacing": "",
    "subtitles": "",
    "bgm": "",
    "voice": "",
    "specialTechniques": "",
    "highlights": [],
    "problems": []
  },
  "dataPrediction": {
    "rows": [
      {
        "metric": "3秒播放率",
        "predicted": "24%",
        "standard": "20-30%",
        "passed": true
      }
    ],
    "coreProbability": "中",
    "biggestShortboard": "",
    "keyOptimization": ""
  },
  "executionPlan": {
    "rewriteSegments": [
      {
        "range": "0-3秒",
        "content": "",
        "reason": "",
        "direction": ""
      }
    ],
    "replaceSegments": [
      {
        "range": "最后5秒",
        "current": "",
        "reason": "",
        "replacement": ""
      }
    ],
    "expansionPlans": {
      "downCopy": "",
      "downVisual": "",
      "downBgm": "",
      "upStrategy": "",
      "upAudience": ""
    }
  },
  "videoPrompts": {
    "hookPrompt": "",
    "painPointPrompt": "",
    "uspPrompt": "",
    "trustPrompt": "",
    "ctaPrompt": ""
  },
  "summary": ""
}
\`\`\``;
}

export function parseGeminiAnalysisResult(raw: string): AnalysisResult {
  const jsonText = extractJsonText(raw);
  const parsed = JSON.parse(jsonText) as unknown;
  const candidate = unwrapAnalysisResult(parsed);
  assertAnalysisShape(candidate);
  return candidate as AnalysisResult;
}

function extractJsonText(raw: string) {
  const blocks = Array.from(raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) => match[1].trim());

  for (const block of blocks.reverse()) {
    if (canParseJson(block)) return block;
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = raw.slice(firstBrace, lastBrace + 1);
    if (canParseJson(candidate)) return candidate;
  }

  throw new Error("没有找到可解析的 JSON 代码块。请确认 Gemini 输出最后包含 ```json ... ```。");
}

function canParseJson(value: string) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function unwrapAnalysisResult(value: unknown) {
  if (isRecord(value) && isRecord(value.analysisResult)) {
    return value.analysisResult;
  }
  return value;
}

function assertAnalysisShape(value: unknown): asserts value is AnalysisResult {
  if (!isRecord(value)) throw new Error("JSON 根节点必须是对象。");

  const required = [
    "basicInfo",
    "narrative",
    "techniques",
    "dataPrediction",
    "executionPlan",
    "videoPrompts",
    "summary"
  ];

  for (const key of required) {
    if (!(key in value)) {
      throw new Error(`JSON 缺少字段：${key}`);
    }
  }

  if (!isRecord(value.basicInfo) || typeof value.basicInfo.duration !== "number") {
    throw new Error("basicInfo.duration 必须是数字。");
  }
  if (!isRecord(value.narrative) || !isRecord(value.narrative.hook)) {
    throw new Error("narrative.hook 缺失或格式不正确。");
  }
  if (!isRecord(value.dataPrediction) || !Array.isArray(value.dataPrediction.rows)) {
    throw new Error("dataPrediction.rows 必须是数组。");
  }
  if (!isRecord(value.videoPrompts) || typeof value.videoPrompts.hookPrompt !== "string") {
    throw new Error("videoPrompts.hookPrompt 缺失或格式不正确。");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
