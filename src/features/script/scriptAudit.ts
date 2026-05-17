import type { SegmentBucketRole, VideoSegment } from "../../types";

export type ScriptAuditSeverity = "error" | "warning" | "info";
export type ScriptReadiness = "blocked" | "needs-work" | "ready";

export interface ScriptAuditIssue {
  id: string;
  severity: ScriptAuditSeverity;
  segmentId?: string;
  segmentTitle?: string;
  field: "structure" | "script" | "subtitle" | "overlay" | "prompt" | "review";
  message: string;
  suggestion: string;
}

export interface ScriptAuditReport {
  score: number;
  readiness: ScriptReadiness;
  issues: ScriptAuditIssue[];
  counts: Record<ScriptAuditSeverity, number>;
  segmentCount: number;
  totalDuration: number;
  bucketCoverage: Record<SegmentBucketRole, number>;
}

const requiredRoles: SegmentBucketRole[] = ["hook", "pain", "usp", "trust", "cta"];
const riskyClaimPatterns = [
  /第一|最[好佳强]|顶级|唯一/g,
  /100%|百分百|永久|根治|治愈/g,
  /保证|无效退款|绝对|立刻见效/g
];

export function buildScriptAudit(segments: VideoSegment[]): ScriptAuditReport {
  const issues: ScriptAuditIssue[] = [];
  const bucketCoverage = createBucketCoverage();
  const totalDuration = segments.reduce((total, segment) => total + safeDuration(segment.duration), 0);

  if (!segments.length) {
    issues.push({
      id: "project.empty",
      severity: "error",
      field: "structure",
      message: "当前没有脚本段。",
      suggestion: "先创建五段脚本，或从分析报告提取脚本。"
    });
  }

  for (const segment of segments) {
    const role = segment.bucketRole ?? inferBucketRole(segment.id);
    bucketCoverage[role] += 1;
    auditSegment(segment, role, issues);
  }

  for (const role of requiredRoles) {
    if (!bucketCoverage[role]) {
      issues.push({
        id: `bucket.${role}.missing`,
        severity: role === "hook" || role === "cta" ? "warning" : "info",
        field: "structure",
        message: `缺少 ${role.toUpperCase()} 归属段。`,
        suggestion: "如果不是固定五段式，可以忽略；否则建议补齐对应 bucket。"
      });
    }
  }

  if (totalDuration < 12 && segments.length) {
    issues.push({
      id: "project.duration.short",
      severity: "warning",
      field: "structure",
      message: "总时长偏短。",
      suggestion: "如果目标是完整带货短视频，建议补足承接、证明或 CTA 段。"
    });
  }

  if (totalDuration > 75) {
    issues.push({
      id: "project.duration.long",
      severity: "warning",
      field: "structure",
      message: "总时长偏长。",
      suggestion: "建议压缩单段脚本，避免合成后节奏变慢。"
    });
  }

  const counts = countIssues(issues);
  const score = Math.max(0, 100 - counts.error * 18 - counts.warning * 8 - counts.info * 2);
  return {
    score,
    readiness: counts.error ? "blocked" : counts.warning ? "needs-work" : "ready",
    issues,
    counts,
    segmentCount: segments.length,
    totalDuration,
    bucketCoverage
  };
}

function auditSegment(segment: VideoSegment, role: SegmentBucketRole, issues: ScriptAuditIssue[]) {
  const segmentTitle = segment.title || segment.id;
  const prefix = `segment.${segment.id}`;
  if (!segment.title.trim()) {
    issues.push(createIssue(prefix, "title", "warning", segment, "段落标题为空。", "补一个可读标题，方便运营追踪素材表现。", "structure"));
  }
  if (!segment.role.trim()) {
    issues.push(createIssue(prefix, "range", "warning", segment, "时间范围为空。", "补充来源时间范围，方便后续溯源。", "structure"));
  }
  if (!Number.isFinite(segment.duration) || segment.duration < 1) {
    issues.push(createIssue(prefix, "duration", "error", segment, "段落时长无效。", "时长至少设置为 1 秒。", "structure"));
  }
  if (role === "hook" && segment.duration > 5) {
    issues.push(createIssue(prefix, "hook-duration", "warning", segment, "Hook 段偏长。", "建议控制在 3-5 秒内，优先给结果或冲突。", "structure"));
  }
  if (segment.duration > 18) {
    issues.push(createIssue(prefix, "duration-long", "warning", segment, "单段时长偏长。", "建议拆分为多个更明确的素材段，提升随机合成灵活度。", "structure"));
  }
  if (!segment.scriptText.trim()) {
    issues.push(createIssue(prefix, "script-empty", "error", segment, "脚本文案为空。", "补充口播/字幕文案后再进入生成。", "script"));
  } else {
    if (segment.scriptText.trim().length < 8) {
      issues.push(createIssue(prefix, "script-short", "warning", segment, "脚本文案过短。", "补充一个具体动作、场景或结果表达。", "script"));
    }
    if (segment.scriptText.length > 80) {
      issues.push(createIssue(prefix, "script-long", "warning", segment, "脚本文案过长。", "建议压缩成更口语化的短句，避免字幕拥挤。", "script"));
    }
    const riskyClaims = findRiskyClaims(segment.scriptText);
    if (riskyClaims.length) {
      issues.push(createIssue(
        prefix,
        "claim-risk",
        "warning",
        segment,
        `${segmentTitle} 包含可能需要复核的绝对化表达：${riskyClaims.join("、")}。`,
        "改成可验证的结果描述，或在投放前走人工审核。",
        "script"
      ));
    }
  }
  if (!segment.generationPrompt.trim()) {
    issues.push(createIssue(prefix, "prompt-empty", "error", segment, "生成提示词为空。", "补充画面主体、镜头、场景、动作和风格。", "prompt"));
  } else if (segment.generationPrompt.trim().length < 24) {
    issues.push(createIssue(prefix, "prompt-short", "warning", segment, "生成提示词偏短。", "建议补充镜头、景别、光线、产品露出和动作细节。", "prompt"));
  }
  const subtitleText = (segment.subtitleText || segment.scriptText).trim();
  if (subtitleText.length > 48) {
    issues.push(createIssue(prefix, "subtitle-long", "warning", segment, "字幕文案偏长。", "建议拆成更短的逐句字幕，避免遮挡主体。", "subtitle"));
  }
  if ((segment.overlayText || "").trim().length > 18) {
    issues.push(createIssue(prefix, "overlay-long", "info", segment, "贴片文案偏长。", "贴片建议控制在 4-12 个字，突出一个核心信息。", "overlay"));
  }
  if (role === "cta" && !/(下单|点击|领取|购买|试试|马上|现在|评论|私信)/.test(segment.scriptText)) {
    issues.push(createIssue(prefix, "cta-action", "info", segment, "CTA 缺少明确行动词。", "补充购买、领取、点击、私信等明确动作。", "script"));
  }
  if (segment.contentStatus === "blocked") {
    issues.push(createIssue(prefix, "review-blocked", "error", segment, "该段被人工标记为阻塞。", "解决问题后再改为草稿、待审核或已通过。", "review"));
  } else if (segment.contentStatus === "needs-review") {
    issues.push(createIssue(prefix, "review-needed", "warning", segment, "该段待人工审核。", "审核通过后改为已通过，便于生成前确认。", "review"));
  }
}

function createIssue(
  prefix: string,
  key: string,
  severity: ScriptAuditSeverity,
  segment: VideoSegment,
  message: string,
  suggestion: string,
  field: ScriptAuditIssue["field"]
): ScriptAuditIssue {
  return {
    id: `${prefix}.${key}`,
    severity,
    segmentId: segment.id,
    segmentTitle: segment.title,
    field,
    message,
    suggestion
  };
}

function findRiskyClaims(value: string) {
  const matches = new Set<string>();
  for (const pattern of riskyClaimPatterns) {
    for (const match of value.matchAll(pattern)) {
      matches.add(match[0]);
    }
  }
  return Array.from(matches).slice(0, 6);
}

function countIssues(issues: ScriptAuditIssue[]) {
  return issues.reduce<Record<ScriptAuditSeverity, number>>(
    (counts, issue) => {
      counts[issue.severity] += 1;
      return counts;
    },
    { error: 0, warning: 0, info: 0 }
  );
}

function safeDuration(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function createBucketCoverage(): Record<SegmentBucketRole, number> {
  return {
    hook: 0,
    pain: 0,
    usp: 0,
    trust: 0,
    cta: 0
  };
}

function inferBucketRole(segmentId: string): SegmentBucketRole {
  if (segmentId === "pain" || segmentId === "usp" || segmentId === "trust" || segmentId === "cta") return segmentId;
  return "hook";
}
