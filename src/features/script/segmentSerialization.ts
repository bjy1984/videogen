import type { VideoSegment } from "../../types";

export function serializeSegments(segments: VideoSegment[]) {
  return segments.map(stripTransientSegmentFields);
}

export function stripTransientSegmentFields(segment: VideoSegment): VideoSegment {
  const { sourceFile, referenceImageFile, isGeneratingImage, ...rest } = segment;
  return {
    ...rest,
    videoUrl: isDurableUrl(rest.videoUrl) ? rest.videoUrl : undefined,
    referenceImageUrl: isDurableUrl(rest.referenceImageUrl) ? rest.referenceImageUrl : undefined
  };
}

function isDurableUrl(url?: string) {
  return Boolean(url && !url.startsWith("blob:"));
}
