import type { AnalysisResult, GenerationOptions, Provider, VideoPreprocessTrace, VideoSegment } from "../../types";
import { createMockRemixAssets, ensureDefaultBuckets, mergeAssetsIntoBuckets } from "../remix/remixBucketService";
import { createRemixPlan } from "../remix/remixPlanner";
import type { MaterialBucket, RemixAsset } from "../remix/remixTypes";
import { createId } from "../../services/id";
import type { ProviderSettings } from "./providers/providerConfig";
import { providerParamsFor } from "./providers/providerConfig";
import { getVideoGenerationProvider } from "./providers/providerRegistry";
import {
  getComfyUIBridgeTask,
  getSeedanceBridgeTask,
  preprocessBrandMaskBridge,
  preprocessFaceMosaicBridge,
  syncComfyUIBridgeAsset,
  syncSeedanceBridgeAsset
} from "../../services/videoGenerationBridgeClient";
import { extractComfyUITaskError, mapComfyUITaskStatus, selectBestComfyUIOutputFile } from "./providers/comfyuiApi";
import { extractSeedanceTaskError, mapSeedanceTaskStatus } from "./providers/seedanceArk";
import { buildBrandMaskReview } from "../privacy/brandMaskReview";
import { hasSegmentBrandMasks, hasSegmentFaceMosaic } from "../script/privacyEdits";
import type { GenerationJob, GenerationJobInput } from "./generationTypes";

export async function generateRemixBuckets(input: {
  buckets: MaterialBucket[];
  segments: VideoSegment[];
  analysisResult: AnalysisResult | null;
  options: GenerationOptions;
  providerSettings: ProviderSettings;
  projectId?: string;
  sourceVideo?: File;
  sourcePreviewUrl: string;
}) {
  const plan = createRemixPlan({
    analysisResult: input.analysisResult,
    segments: input.segments,
    options: input.options
  });
  const provider = getVideoGenerationProvider(input.options.provider);
  const generationJobs = await Promise.all(
    plan.items.map(async (item): Promise<GenerationJob> => {
      const segment = input.segments.find((segmentItem) => segmentItem.id === item.segmentId);
      const providerParams = providerParamsFor(String(input.options.provider), input.providerSettings);
      const jobInput: GenerationJobInput = {
        segmentId: item.segmentId,
        bucketId: item.bucketId,
        providerId: input.options.provider,
        prompt: item.prompt,
        duration: item.duration,
        aspectRatio: input.options.aspectRatio,
        referenceImageUrl: segment?.referenceImageUrl,
        sourceVideoName: input.sourceVideo?.name,
        providerParams
      };
      const prepared = await prepareSourcePreprocess({
        projectId: input.projectId,
        segment,
        providerId: input.options.provider,
        providerSettings: input.providerSettings,
        sourceVideo: input.sourceVideo,
        sourcePreviewUrl: input.sourcePreviewUrl
      });
      if (prepared.error) {
        return createFailedPreprocessJob(jobInput, prepared.error, prepared.traces);
      }
      const finalTrace = prepared.traces[prepared.traces.length - 1];
      return provider.createJob({
        ...jobInput,
        sourceVideoUrl: finalTrace?.outputVideoUrl,
        sourceVideoLocalPath: finalTrace?.localPath,
        preprocessingTrace: finalTrace,
        preprocessingTraces: prepared.traces
      });
    })
  );
  const assets = createMockRemixAssets({
    segments: input.segments,
    analysisResult: input.analysisResult,
    options: input.options,
    sourceVideo: input.sourceVideo,
    sourcePreviewUrl: input.sourcePreviewUrl,
    generationJobs
  });
  return {
    plan,
    buckets: mergeAssetsIntoBuckets(ensureDefaultBuckets(input.buckets), assets),
    assets,
    generationJobs
  };
}

export const generateMockRemixBuckets = generateRemixBuckets;

export async function regenerateRemixAsset(input: {
  assetId: string;
  buckets: MaterialBucket[];
  segments: VideoSegment[];
  analysisResult: AnalysisResult | null;
  options: GenerationOptions;
  providerSettings: ProviderSettings;
  projectId?: string;
  sourceVideo?: File;
  sourcePreviewUrl: string;
}) {
  const located = findAsset(input.buckets, input.assetId);
  if (!located) throw new Error("未找到要重新生成的素材。");

  const { bucket, asset } = located;
  const segment = input.segments.find((item) => item.id === asset.sourceSegmentId);
  const prompt = segment?.generationPrompt || asset.prompt;
  const duration = segment?.duration || asset.duration;
  const provider = getVideoGenerationProvider(input.options.provider);
  const providerParams = providerParamsFor(String(input.options.provider), input.providerSettings);
  const jobInput: GenerationJobInput = {
    segmentId: asset.sourceSegmentId,
    bucketId: bucket.id,
    providerId: input.options.provider,
    prompt,
    duration,
    aspectRatio: input.options.aspectRatio,
    referenceImageUrl: segment?.referenceImageUrl || asset.referenceImageUrl,
    sourceVideoName: input.sourceVideo?.name,
    providerParams
  };
  const prepared = await prepareSourcePreprocess({
    projectId: input.projectId,
    segment,
    providerId: input.options.provider,
    providerSettings: input.providerSettings,
    sourceVideo: input.sourceVideo,
    sourcePreviewUrl: input.sourcePreviewUrl
  });
  const finalTrace = prepared.traces[prepared.traces.length - 1];
  const job = prepared.error
    ? createFailedPreprocessJob(jobInput, prepared.error, prepared.traces)
    : await provider.createJob({
        ...jobInput,
        sourceVideoUrl: finalTrace?.outputVideoUrl,
        sourceVideoLocalPath: finalTrace?.localPath,
        preprocessingTrace: finalTrace,
        preprocessingTraces: prepared.traces
      });

  const nextAsset = createRegeneratedAsset({
    bucket,
    sourceAsset: asset,
    segment,
    analysisResult: input.analysisResult,
    options: input.options,
    sourceVideo: input.sourceVideo,
    sourcePreviewUrl: input.sourcePreviewUrl,
    job,
    providerParams,
    prompt,
    duration
  });

  return {
    asset: nextAsset,
    sourceAsset: asset,
    generationJob: job,
    buckets: input.buckets.map((item) =>
      item.id === bucket.id
        ? {
            ...item,
            assets: [
              nextAsset,
              ...item.assets.map((current) =>
                current.id === asset.id
                  ? {
                      ...current,
                      disabled: true,
                      tags: {
                        ...current.tags,
                        custom: {
                          ...current.tags.custom,
                          replacedBy: [nextAsset.id]
                        }
                      }
                    }
                  : current
              )
            ]
          }
        : item
    )
  };
}

async function prepareSourcePreprocess(input: {
  projectId?: string;
  segment?: VideoSegment;
  providerId: Provider;
  providerSettings: ProviderSettings;
  sourceVideo?: File;
  sourcePreviewUrl: string;
}): Promise<{ traces: VideoPreprocessTrace[]; error?: string }> {
  if (!input.segment) return { traces: [] };
  const needsFaceMosaic = hasSegmentFaceMosaic(input.segment);
  const needsBrandMask = hasSegmentBrandMasks(input.segment);
  if (!needsFaceMosaic && !needsBrandMask) return { traces: [] };
  if (needsBrandMask) {
    const review = buildBrandMaskReview(input.segment.privacyEdits?.brandMasks ?? []);
    if (review.errorCount) {
      return {
        traces: [],
        error: `物体追踪打码还有 ${review.errorCount} 个红色阻塞项，需要补帧后才能生成。`
      };
    }
  }
  const now = new Date().toISOString();
  if (input.providerId === "mock") {
    const traces: VideoPreprocessTrace[] = [];
    if (needsFaceMosaic) {
      traces.push({
        id: createId("preprocess_mock_face_mosaic"),
        kind: "face-mosaic",
        provider: "mock",
        status: "done",
        sourceVideoName: input.sourceVideo?.name,
        sourceVideoUrl: input.sourcePreviewUrl || input.segment.videoUrl,
        outputVideoUrl: input.sourcePreviewUrl || input.segment.videoUrl,
        publicAssetRequired: false,
        createdAt: now,
        updatedAt: now
      });
    }
    if (needsBrandMask) {
      const tracks = input.segment.privacyEdits?.brandMasks ?? [];
      traces.push({
        id: createId("preprocess_mock_brand_mask"),
        kind: "brand-mask",
        provider: "mock",
        status: "done",
        sourceVideoName: input.sourceVideo?.name,
        sourceVideoUrl: input.sourcePreviewUrl || input.segment.videoUrl,
        outputVideoUrl: input.sourcePreviewUrl || input.segment.videoUrl,
        publicAssetRequired: false,
        summary: {
          trackCount: tracks.length,
          manualKeyframes: tracks.reduce((total, track) => total + track.keyframes.length, 0),
          blockedFrames: 0,
          warningFrames: 0
        },
        createdAt: now,
        updatedAt: now
      });
    }
    return {
      traces
    };
  }
  if (!input.sourceVideo) {
    return {
      traces: [],
      error: "隐私打码预处理需要先上传原素材视频。"
    };
  }
  const traces: VideoPreprocessTrace[] = [];
  try {
    const bridgeUrl = bridgeUrlForProvider(input.providerId, input.providerSettings);
    if (needsFaceMosaic) {
      const result = await preprocessFaceMosaicBridge({
        bridgeUrl,
        projectId: input.projectId || "default_project",
        segmentId: input.segment.id,
        sourceRange: input.segment.role,
        effect: input.segment.privacyEdits?.faceMosaicEffect ?? "mosaic",
        strength: input.segment.privacyEdits?.faceMosaicStrength ?? 0.85,
        video: input.sourceVideo
      });
      traces.push(result.trace);
    }
    if (needsBrandMask) {
      const previousTrace = traces[traces.length - 1];
      const result = await preprocessBrandMaskBridge({
        bridgeUrl,
        projectId: input.projectId || "default_project",
        segmentId: input.segment.id,
        sourceRange: input.segment.role,
        video: previousTrace?.localPath ? undefined : input.sourceVideo,
        sourceLocalPath: previousTrace?.localPath,
        sourceVideoName: input.sourceVideo.name,
        tracks: input.segment.privacyEdits?.brandMasks ?? []
      });
      traces.push(result.trace);
    }
    return { traces };
  } catch (error) {
    return {
      traces,
      error: error instanceof Error ? error.message : "隐私打码预处理失败。"
    };
  }
}

function bridgeUrlForProvider(providerId: Provider, providerSettings: ProviderSettings) {
  if (providerId === "comfyui") return providerSettings.comfyui.bridgeUrl;
  if (providerId === "seedance") return providerSettings.seedance.bridgeUrl;
  return undefined;
}

function createFailedPreprocessJob(
  input: GenerationJobInput,
  error: string,
  traces: VideoPreprocessTrace[] = []
): GenerationJob {
  const now = new Date().toISOString();
  const trace = traces[traces.length - 1];
  return {
    id: createId("job_preprocess_failed"),
    input: {
      ...input,
      preprocessingTrace: trace,
      preprocessingTraces: traces
    },
    status: "failed",
    createdAt: now,
    updatedAt: now,
    error
  };
}

export async function refreshSeedanceMaterialBuckets(input: {
  buckets: MaterialBucket[];
  providerSettings: ProviderSettings;
  projectId?: string;
  syncAssets?: boolean;
}) {
  let refreshedCount = 0;
  let readyCount = 0;
  let runningCount = 0;
  let failedCount = 0;

  const buckets = await Promise.all(
    input.buckets.map(async (bucket) => ({
      ...bucket,
      assets: await Promise.all(
        bucket.assets.map(async (asset): Promise<RemixAsset> => {
          if (asset.providerId !== "seedance" || !asset.providerTrace?.remoteJobId) return asset;
          refreshedCount += 1;
          try {
            const task = await getSeedanceBridgeTask({
              bridgeUrl: input.providerSettings.seedance.bridgeUrl,
              endpoint: input.providerSettings.seedance.endpoint,
              apiKeyEnvName: input.providerSettings.seedance.apiKeyEnvName,
              taskId: asset.providerTrace.remoteJobId
            });
            const jobStatus = mapSeedanceTaskStatus(task.status);
            if (jobStatus === "done") readyCount += 1;
            if (jobStatus === "generating" || jobStatus === "queued") runningCount += 1;
            if (jobStatus === "failed") failedCount += 1;
            const assetStatus: RemixAsset["status"] =
              jobStatus === "done" ? "ready" : jobStatus === "failed" ? "failed" : "generating";
            const synced = assetStatus === "ready" && input.syncAssets !== false
              ? await syncReadySeedanceAsset({
                  bridgeUrl: input.providerSettings.seedance.bridgeUrl,
                  endpoint: input.providerSettings.seedance.endpoint,
                  apiKeyEnvName: input.providerSettings.seedance.apiKeyEnvName,
                  taskId: asset.providerTrace.remoteJobId,
                  projectId: input.projectId || "default_project",
                  assetId: asset.id,
                  sourceUrl: task.content?.video_url
                })
              : null;
            return {
              ...asset,
              status: assetStatus,
              videoUrl: synced?.asset.localAssetUrl || task.content?.video_url || asset.videoUrl,
              providerTrace: {
                ...asset.providerTrace,
                status: task.status || jobStatus,
                error: extractSeedanceTaskError(task),
                resultLastFrameUrl: task.content?.last_frame_url,
                localAssetUrl: synced?.asset.localAssetUrl || asset.providerTrace.localAssetUrl,
                localAssetPath: synced?.asset.localPath || asset.providerTrace.localAssetPath,
                originalVideoUrl: task.content?.video_url || asset.providerTrace.originalVideoUrl,
                updatedAt: new Date().toISOString()
              },
              tags: {
                ...asset.tags,
                custom: {
                  ...asset.tags.custom,
                  ...(task.status ? { remoteStatus: [task.status] } : {})
                }
              }
            };
          } catch (error) {
            failedCount += 1;
            return {
              ...asset,
              status: "failed" as const,
              providerTrace: {
                ...asset.providerTrace,
                status: "failed",
                error: error instanceof Error ? error.message : "Seedance 任务查询失败。",
                updatedAt: new Date().toISOString()
              }
            };
          }
        })
      )
    }))
  );

  return {
    buckets,
    refreshedCount,
    readyCount,
    runningCount,
    failedCount
  };
}

export async function refreshComfyUIMaterialBuckets(input: {
  buckets: MaterialBucket[];
  providerSettings: ProviderSettings;
  projectId?: string;
  syncAssets?: boolean;
}) {
  let refreshedCount = 0;
  let readyCount = 0;
  let runningCount = 0;
  let failedCount = 0;

  const buckets = await Promise.all(
    input.buckets.map(async (bucket) => ({
      ...bucket,
      assets: await Promise.all(
        bucket.assets.map(async (asset): Promise<RemixAsset> => {
          if (asset.providerId !== "comfyui" || !asset.providerTrace?.remoteJobId) return asset;
          refreshedCount += 1;
          try {
            const task = await getComfyUIBridgeTask({
              bridgeUrl: input.providerSettings.comfyui.bridgeUrl,
              endpoint: input.providerSettings.comfyui.endpoint,
              taskId: asset.providerTrace.remoteJobId
            });
            const jobStatus = mapComfyUITaskStatus(task.status);
            if (jobStatus === "done") readyCount += 1;
            if (jobStatus === "generating" || jobStatus === "queued") runningCount += 1;
            if (jobStatus === "failed") failedCount += 1;
            const assetStatus: RemixAsset["status"] =
              jobStatus === "done" ? "ready" : jobStatus === "failed" ? "failed" : "generating";
            const output = selectBestComfyUIOutputFile(task.outputFiles, input.providerSettings.comfyui.outputNodeId);
            const synced = assetStatus === "ready" && input.syncAssets !== false
              ? await syncReadyComfyUIAsset({
                  bridgeUrl: input.providerSettings.comfyui.bridgeUrl,
                  endpoint: input.providerSettings.comfyui.endpoint,
                  outputNodeId: input.providerSettings.comfyui.outputNodeId,
                  taskId: asset.providerTrace.remoteJobId,
                  projectId: input.projectId || "default_project",
                  assetId: asset.id
                })
              : null;
            return {
              ...asset,
              status: assetStatus,
              videoUrl: synced?.asset.localAssetUrl || output?.viewUrl || asset.videoUrl,
              providerTrace: {
                ...asset.providerTrace,
                status: task.status || jobStatus,
                error: extractComfyUITaskError(task),
                localAssetUrl: synced?.asset.localAssetUrl || asset.providerTrace.localAssetUrl,
                localAssetPath: synced?.asset.localPath || asset.providerTrace.localAssetPath,
                originalVideoUrl: output?.viewUrl || asset.providerTrace.originalVideoUrl,
                updatedAt: new Date().toISOString()
              },
              tags: {
                ...asset.tags,
                custom: {
                  ...asset.tags.custom,
                  ...(task.status ? { remoteStatus: [task.status] } : {})
                }
              }
            };
          } catch (error) {
            failedCount += 1;
            return {
              ...asset,
              status: "failed" as const,
              providerTrace: {
                ...asset.providerTrace,
                status: "failed",
                error: error instanceof Error ? error.message : "ComfyUI 任务查询失败。",
                updatedAt: new Date().toISOString()
              }
            };
          }
        })
      )
    }))
  );

  return {
    buckets,
    refreshedCount,
    readyCount,
    runningCount,
    failedCount
  };
}

async function syncReadySeedanceAsset(input: {
  bridgeUrl: string;
  endpoint: string;
  apiKeyEnvName: string;
  taskId: string;
  projectId: string;
  assetId: string;
  sourceUrl?: string;
}) {
  try {
    return await syncSeedanceBridgeAsset(input);
  } catch {
    return null;
  }
}

async function syncReadyComfyUIAsset(input: {
  bridgeUrl: string;
  endpoint: string;
  outputNodeId?: string;
  taskId: string;
  projectId: string;
  assetId: string;
}) {
  try {
    return await syncComfyUIBridgeAsset(input);
  } catch {
    return null;
  }
}

function findAsset(buckets: MaterialBucket[], assetId: string) {
  for (const bucket of buckets) {
    const asset = bucket.assets.find((item) => item.id === assetId);
    if (asset) return { bucket, asset };
  }
  return null;
}

function createRegeneratedAsset(input: {
  bucket: MaterialBucket;
  sourceAsset: RemixAsset;
  segment?: VideoSegment;
  analysisResult: AnalysisResult | null;
  options: GenerationOptions;
  sourceVideo?: File;
  sourcePreviewUrl: string;
  job: Awaited<ReturnType<ReturnType<typeof getVideoGenerationProvider>["createJob"]>>;
  providerParams: Record<string, unknown>;
  prompt: string;
  duration: number;
}): RemixAsset {
  const assetStatus = getAssetStatus(input.job);
  const jobVideoUrl = input.job.resultVideoUrl || input.job.asset?.videoUrl;
  const promptHash = hashText(input.prompt);
  const preprocesses = input.job.input.preprocessingTraces || (input.job.input.preprocessingTrace ? [input.job.input.preprocessingTrace] : undefined) || input.segment?.privacyEdits?.preprocesses || [
    input.segment?.privacyEdits?.faceMosaicPreprocess,
    input.segment?.privacyEdits?.brandMaskPreprocess
  ].filter((trace): trace is NonNullable<typeof trace> => Boolean(trace));
  const preprocessTrace = input.job.input.preprocessingTrace || preprocesses[preprocesses.length - 1];
  const preprocessTags = preprocessCustomTags(preprocesses);
  return {
    id: createId(`asset_${String(input.bucket.role).replace(/[^a-zA-Z0-9_-]+/g, "_")}`),
    sourceSegmentId: input.sourceAsset.sourceSegmentId,
    sourceVideoId: input.sourceAsset.sourceVideoId,
    bucketId: input.bucket.id,
    role: input.bucket.role,
    title: `${input.segment?.title || input.sourceAsset.title} 重生成`,
    scriptText: input.segment?.scriptText || input.sourceAsset.scriptText,
    subtitleText: input.segment?.subtitleText ?? input.sourceAsset.subtitleText ?? input.segment?.scriptText ?? input.sourceAsset.scriptText,
    overlayText: input.segment?.overlayText ?? input.sourceAsset.overlayText,
    prompt: input.prompt,
    duration: input.duration,
    providerId: input.options.provider,
    status: assetStatus,
    operationState: "untested",
    disabled: false,
    tags: {
      ...input.sourceAsset.tags,
      narrativeRole: input.bucket.role,
      topicType: input.analysisResult?.basicInfo.topicType ?? input.sourceAsset.tags.topicType,
      materialType: input.analysisResult?.basicInfo.materialType ?? input.sourceAsset.tags.materialType,
      targetAudience: input.analysisResult?.basicInfo.targetAudience ?? input.sourceAsset.tags.targetAudience,
      visualStyle: input.analysisResult?.techniques.visualStyle ?? input.sourceAsset.tags.visualStyle,
      providerId: input.options.provider,
      promptHash,
      custom: {
        ...input.sourceAsset.tags.custom,
        regeneratedFrom: [input.sourceAsset.id],
        ...preprocessTags,
        ...(input.job.remoteJobId ? { remoteJobId: [input.job.remoteJobId] } : {}),
        ...(input.job.remoteStatus ? { remoteStatus: [input.job.remoteStatus] } : {})
      }
    },
    usage: {
      usedCount: 0,
      maxUses: input.sourceAsset.usage.maxUses
    },
    createdAt: new Date().toISOString(),
    generationJobId: input.job.id,
    providerTrace: {
      localJobId: input.job.id,
      remoteJobId: input.job.remoteJobId,
      model: String(input.providerParams.model || input.providerParams.workflowTemplateId || ""),
      status: input.job.remoteStatus || input.job.status,
      error: input.job.error,
      resultLastFrameUrl: input.job.resultLastFrameUrl,
      preprocess: preprocessTrace,
      preprocesses,
      createdAt: input.job.createdAt,
      updatedAt: input.job.updatedAt
    },
    videoUrl: jobVideoUrl || (assetStatus === "ready" ? input.sourcePreviewUrl || input.segment?.videoUrl || input.sourceAsset.videoUrl : undefined),
    sourceFile: input.segment?.sourceFile ?? input.sourceAsset.sourceFile ?? input.sourceVideo,
    referenceImageUrl: input.segment?.referenceImageUrl || input.sourceAsset.referenceImageUrl,
    weight: input.sourceAsset.weight
  };
}

function getAssetStatus(job: Awaited<ReturnType<ReturnType<typeof getVideoGenerationProvider>["createJob"]>>): RemixAsset["status"] {
  if (job.status === "done") return "ready";
  if (job.status === "failed") return "failed";
  if (job.status === "queued" || job.status === "generating") return "generating";
  return "idle";
}

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

function preprocessCustomTags(preprocesses: VideoPreprocessTrace[]): Record<string, string[]> {
  const ids = preprocesses.map((trace) => trace.id).filter(Boolean);
  const statuses = preprocesses.map((trace) => trace.status).filter(Boolean);
  const outputUrls = preprocesses.map((trace) => trace.outputVideoUrl).filter((url): url is string => Boolean(url));
  return {
    ...(ids.length ? { privacyPreprocessId: ids } : {}),
    ...(statuses.length ? { privacyPreprocessStatus: statuses } : {}),
    ...(outputUrls.length ? { preprocessedSourceUrl: outputUrls } : {})
  };
}
