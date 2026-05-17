import type { BrandMaskEffect, BrandMaskTargetType, VideoPreprocessTrace, VideoSegment } from "../../types";

export const FACE_MOSAIC_PRIVACY_TAG = "face-mosaic";
export const BRAND_MASK_PRIVACY_TAG = "brand-mask";

export function hasSegmentFaceMosaic(segment: VideoSegment) {
  return Boolean(segment.privacyEdits?.faceMosaic);
}

export function hasSegmentBrandMasks(segment: VideoSegment) {
  return Boolean(segment.privacyEdits?.brandMasks?.some((track) => track.keyframes.length > 0));
}

export function brandMaskDefaultEffect(targetType: BrandMaskTargetType): BrandMaskEffect {
  if (targetType === "text") return "solid";
  return "mosaic";
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

export function setSegmentBrandMasks(
  segment: VideoSegment,
  brandMasks: NonNullable<VideoSegment["privacyEdits"]>["brandMasks"]
): VideoSegment {
  return {
    ...segment,
    privacyEdits: {
      ...segment.privacyEdits,
      brandMasks,
      brandMaskPreprocess: brandMasks?.length ? segment.privacyEdits?.brandMaskPreprocess : undefined
    }
  };
}

export function applyPreprocessTrace(segment: VideoSegment, trace: VideoPreprocessTrace): VideoSegment {
  const previous = segment.privacyEdits?.preprocesses ?? [];
  const preprocesses = [...previous.filter((item) => item.kind !== trace.kind), trace];
  return {
    ...segment,
    privacyEdits: {
      ...segment.privacyEdits,
      preprocesses,
      faceMosaicPreprocess: trace.kind === "face-mosaic" ? trace : segment.privacyEdits?.faceMosaicPreprocess,
      brandMaskPreprocess: trace.kind === "brand-mask" ? trace : segment.privacyEdits?.brandMaskPreprocess
    }
  };
}

export function applyPreprocessTraces(segment: VideoSegment, traces: VideoPreprocessTrace[]): VideoSegment {
  return traces.reduce((current, trace) => applyPreprocessTrace(current, trace), segment);
}

export function faceMosaicCustomTags(segment: VideoSegment): Record<string, string[]> {
  return privacyEditCustomTags(segment);
}

export function privacyEditCustomTags(segment: VideoSegment): Record<string, string[]> {
  const privacyEdit: string[] = [];
  const preprocessIds: string[] = [];
  const preprocessStatuses: string[] = [];
  const preprocessedSourceUrls: string[] = [];
  if (hasSegmentFaceMosaic(segment)) {
    privacyEdit.push(FACE_MOSAIC_PRIVACY_TAG);
  }
  if (hasSegmentBrandMasks(segment)) {
    privacyEdit.push(BRAND_MASK_PRIVACY_TAG);
  }

  const traces = segment.privacyEdits?.preprocesses?.length
    ? segment.privacyEdits.preprocesses
    : [
        segment.privacyEdits?.faceMosaicPreprocess,
        segment.privacyEdits?.brandMaskPreprocess
      ].filter(Boolean);
  for (const preprocess of traces) {
    if (preprocess?.id) preprocessIds.push(preprocess.id);
    if (preprocess?.status) preprocessStatuses.push(preprocess.status);
    if (preprocess?.outputVideoUrl) preprocessedSourceUrls.push(preprocess.outputVideoUrl);
  }

  return {
    ...(privacyEdit.length ? { privacyEdit } : {}),
    ...(preprocessIds.length ? { privacyPreprocessId: preprocessIds } : {}),
    ...(preprocessStatuses.length ? { privacyPreprocessStatus: preprocessStatuses } : {}),
    ...(preprocessedSourceUrls.length ? { preprocessedSourceUrl: preprocessedSourceUrls } : {})
  };
}
