import type { BrandMaskEffect, BrandMaskTargetType, FaceMosaicEffect, VideoPreprocessTrace, VideoSegment } from "../../types";

export const FACE_MOSAIC_PRIVACY_TAG = "face-mosaic";
export const BRAND_MASK_PRIVACY_TAG = "brand-mask";
export const DEFAULT_MASK_STRENGTH = 0.85;
export const MIN_MASK_STRENGTH = 0.2;
export const MAX_MASK_STRENGTH = 1;

export function hasSegmentFaceMosaic(segment: VideoSegment) {
  return Boolean(segment.privacyEdits?.faceMosaic);
}

export function hasSegmentBrandMasks(segment: VideoSegment) {
  return Boolean(segment.privacyEdits?.brandMasks?.some((track) => track.keyframes.length > 0));
}

export function brandMaskDefaultEffect(_targetType: BrandMaskTargetType): BrandMaskEffect {
  return "mosaic";
}

export function brandMaskDefaultStrength() {
  return DEFAULT_MASK_STRENGTH;
}

export function normalizeMaskStrength(value: number | string | null | undefined) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MASK_STRENGTH;
  return Math.min(MAX_MASK_STRENGTH, Math.max(MIN_MASK_STRENGTH, numeric));
}

export function setSegmentFaceMosaic(segment: VideoSegment, enabled: boolean): VideoSegment {
  return {
    ...segment,
    privacyEdits: {
      ...segment.privacyEdits,
      faceMosaic: enabled,
      faceMosaicEffect: enabled ? segment.privacyEdits?.faceMosaicEffect ?? "mosaic" : segment.privacyEdits?.faceMosaicEffect,
      faceMosaicStrength: enabled
        ? normalizeMaskStrength(segment.privacyEdits?.faceMosaicStrength)
        : segment.privacyEdits?.faceMosaicStrength,
      faceMosaicPreprocess: enabled ? segment.privacyEdits?.faceMosaicPreprocess : undefined
    }
  };
}

export function setSegmentFaceMosaicEffect(segment: VideoSegment, effect: FaceMosaicEffect): VideoSegment {
  return {
    ...segment,
    privacyEdits: {
      ...segment.privacyEdits,
      faceMosaic: true,
      faceMosaicEffect: effect,
      faceMosaicStrength: normalizeMaskStrength(segment.privacyEdits?.faceMosaicStrength),
      faceMosaicPreprocess: undefined
    }
  };
}

export function setSegmentFaceMosaicStrength(segment: VideoSegment, strength: number): VideoSegment {
  return {
    ...segment,
    privacyEdits: {
      ...segment.privacyEdits,
      faceMosaic: true,
      faceMosaicEffect: segment.privacyEdits?.faceMosaicEffect ?? "mosaic",
      faceMosaicStrength: normalizeMaskStrength(strength),
      faceMosaicPreprocess: undefined
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
