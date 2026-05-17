import type { VideoSegment } from "../../types";

export const FACE_MOSAIC_PRIVACY_TAG = "face-mosaic";

export function hasSegmentFaceMosaic(segment: VideoSegment) {
  return Boolean(segment.privacyEdits?.faceMosaic);
}

export function setSegmentFaceMosaic(segment: VideoSegment, enabled: boolean): VideoSegment {
  return {
    ...segment,
    privacyEdits: {
      ...segment.privacyEdits,
      faceMosaic: enabled,
      faceMosaicPreprocess: enabled ? segment.privacyEdits?.faceMosaicPreprocess : undefined
    }
  };
}

export function faceMosaicCustomTags(segment: VideoSegment): Record<string, string[]> {
  if (!hasSegmentFaceMosaic(segment)) return {};
  const preprocess = segment.privacyEdits?.faceMosaicPreprocess;
  return {
    privacyEdit: [FACE_MOSAIC_PRIVACY_TAG],
    ...(preprocess?.id ? { privacyPreprocessId: [preprocess.id] } : {}),
    ...(preprocess?.status ? { privacyPreprocessStatus: [preprocess.status] } : {}),
    ...(preprocess?.outputVideoUrl ? { preprocessedSourceUrl: [preprocess.outputVideoUrl] } : {})
  };
}
