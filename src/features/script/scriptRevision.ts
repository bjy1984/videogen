import { createId } from "../../services/id";
import type { SegmentBucketRole, VideoSegment } from "../../types";
import { serializeSegments, stripTransientSegmentFields } from "./segmentSerialization";

export interface ScriptRevision {
  id: string;
  createdAt: string;
  label: string;
  segments: VideoSegment[];
  segmentCount: number;
  totalDuration: number;
  totalScriptChars: number;
}

export interface ScriptRewriteSuggestion {
  segmentId: string;
  createdAt: string;
  scriptText: string;
  generationPrompt: string;
  reason: string;
}

export type ScriptSuggestionApplyTarget = "script" | "prompt" | "both";

export function createScriptRevision(segments: VideoSegment[], label?: string): ScriptRevision {
  const now = new Date().toISOString();
  const cleanSegments = serializeSegments(segments);
  return {
    id: createId("script_rev"),
    createdAt: now,
    label: label?.trim() || defaultRevisionLabel(now, cleanSegments),
    segments: cleanSegments,
    segmentCount: cleanSegments.length,
    totalDuration: cleanSegments.reduce((total, segment) => total + segment.duration, 0),
    totalScriptChars: cleanSegments.reduce((total, segment) => total + segment.scriptText.length, 0)
  };
}

export function restoreSegmentsFromRevision(revision: ScriptRevision): VideoSegment[] {
  return revision.segments.map(stripTransientSegmentFields);
}

export function buildScriptRewriteSuggestion(segment: VideoSegment): ScriptRewriteSuggestion {
  const role = segment.bucketRole ?? inferBucketRole(segment.id);
  const baseScript = cleanSentence(segment.scriptText) || fallbackScript(role);
  const scriptText = rewriteScript(baseScript, role);
  return {
    segmentId: segment.id,
    createdAt: new Date().toISOString(),
    scriptText,
    generationPrompt: rewritePrompt(segment.generationPrompt, role),
    reason: rewriteReason(role)
  };
}

function defaultRevisionLabel(createdAt: string, segments: VideoSegment[]) {
  const time = new Date(createdAt).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${time} · ${segments.length}段`;
}

function rewriteScript(script: string, role: SegmentBucketRole) {
  if (role === "hook") return `先别急着划走，${script} 3秒看出关键差别。`;
  if (role === "pain") return `如果你也遇到这个问题：${script} 先把原因说清楚。`;
  if (role === "usp") return `解决思路很简单：${script} 重点看前后变化。`;
  if (role === "trust") return `别只听功效，直接看结果：${script}`;
  return `现在就按这个方法做：${script} 下单前先确认适合自己的场景。`;
}

function rewritePrompt(prompt: string, role: SegmentBucketRole) {
  const base = prompt.trim() || "真实短视频实拍，竖屏，主体清晰，节奏紧凑。";
  return `${base}\n\n改写重点：${visualDirection(role)}`;
}

function rewriteReason(role: SegmentBucketRole) {
  if (role === "hook") return "强化前三秒停留理由，减少铺垫。";
  if (role === "pain") return "把痛点表达改成用户自我代入句式。";
  if (role === "usp") return "让卖点更像解决动作，而不是功能罗列。";
  if (role === "trust") return "把信任证明转成可见结果。";
  return "尾段补足明确行动指令和转化理由。";
}

function visualDirection(role: SegmentBucketRole) {
  if (role === "hook") return "首帧给出强对比或结果画面，字幕短句置顶，镜头快速进入主体。";
  if (role === "pain") return "展示具体问题现场，使用近景特写和轻微停顿放大痛点。";
  if (role === "usp") return "用步骤化画面解释解决方案，保持产品和结果同屏可见。";
  if (role === "trust") return "使用前后对比、细节特写、真实环境光，降低广告感。";
  return "展示明确行动动作、优惠或下一步指引，结尾保留产品/按钮视觉锚点。";
}

function fallbackScript(role: SegmentBucketRole) {
  if (role === "hook") return "这个变化很多人第一眼就能看出来。";
  if (role === "pain") return "问题不是不会选，而是没有先判断真实原因。";
  if (role === "usp") return "用更具体的方法处理，结果会更稳定。";
  if (role === "trust") return "结果能不能成立，看细节对比最直接。";
  return "适合就直接试，不适合也能快速排除。";
}

function cleanSentence(value: string) {
  return value.trim().replace(/[。！？!?]+$/g, "");
}

function inferBucketRole(segmentId: string): SegmentBucketRole {
  if (segmentId === "pain" || segmentId === "usp" || segmentId === "trust" || segmentId === "cta") return segmentId;
  return "hook";
}
