import type { BrandMaskTrack } from "../../types";

export function buildBrandMaskReview(tracks: BrandMaskTrack[]) {
  const issues = tracks.flatMap((track) => {
    const result = [...(track.reviewIssues ?? [])];
    if (!track.keyframes.length) {
      result.push({
        trackId: track.id,
        frameIndex: 0,
        time: 0,
        severity: "error" as const,
        reason: `${track.label} 还没有人工关键帧。`
      });
    }
    if ((track.trackMode === "planar" || track.trackMode === "optical-flow" || track.trackMode === "interpolate") && track.keyframes.length < 2) {
      result.push({
        trackId: track.id,
        frameIndex: 0,
        time: 0,
        severity: "warning" as const,
        reason: `${track.label} 建议至少补打2个关键帧，便于校验传播是否漂移。`
      });
    }
    if (track.effect === "blur") {
      result.push({
        trackId: track.id,
        frameIndex: 0,
        time: 0,
        severity: "warning" as const,
        reason: `${track.label} 使用模糊遮挡，细节仍可能被识别。`
      });
    }
    return result;
  });
  return {
    issues,
    errorCount: issues.filter((issue) => issue.severity === "error").length,
    warningCount: issues.filter((issue) => issue.severity === "warning").length,
    keyframeCount: tracks.reduce((total, track) => total + track.keyframes.length, 0)
  };
}
