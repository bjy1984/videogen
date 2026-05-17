import type { AnalysisResult, GenerationOptions, VideoSegment } from "../../types";
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
  syncComfyUIBridgeAsset,
  syncSeedanceBridgeAsset
} from "../../services/videoGenerationBridgeClient";
import { extractComfyUITaskError, mapComfyUITaskStatus, selectBestComfyUIOutputFile } from "./providers/comfyuiApi";
import { extractSeedanceTaskError, mapSeedanceTaskStatus } from "./providers/seedanceArk";

export async function generateRemixBuckets(input: {
  buckets: MaterialBucket[];
  segments: VideoSegment[];
  analysisResult: AnalysisResult | null;
  options: GenerationOptions;
  providerSettings: ProviderSettings;
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
    plan.items.map((item) =>
      provider.createJob({
        segmentId: item.segmentId,
        bucketId: item.bucketId,
        providerId: input.options.provider,
        prompt: item.prompt,
        duration: item.duration,
        aspectRatio: input.options.aspectRatio,
        sourceVideoName: input.sourceVideo?.name,
        providerParams: providerParamsFor(String(input.options.provider), input.providerSettings)
      })
    )
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
  const job = await provider.createJob({
    segmentId: asset.sourceSegmentId,
    bucketId: bucket.id,
    providerId: input.options.provider,
    prompt,
    duration,
    aspectRatio: input.options.aspectRatio,
    referenceImageUrl: segment?.referenceImageUrl || asset.referenceImageUrl,
    sourceVideoName: input.sourceVideo?.name,
    providerParams
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
