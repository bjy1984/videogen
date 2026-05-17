import assert from "node:assert/strict";
import JSZip from "jszip";
import { initialGenerationOptions } from "../src/app/workflow";
import {
  assembleTimelineFromBuckets,
  commitTimelineUsage,
  moveTimelineClip,
  rerollTimelineClipFromBuckets,
  serializeTimeline
} from "../src/features/compose/composeAssembler";
import { buildComposeReview } from "../src/features/compose/composeReview";
import type { ComposeTimeline } from "../src/features/compose/composeTypes";
import { buildJianyingDraftPackage } from "../src/features/export/jianyingDraft";
import { mergeProviderSettings, providerParamsFor } from "../src/features/generation/providers/providerConfig";
import {
  buildComfyUIPromptBody,
  mapComfyUITaskStatus,
  normalizeComfyUIHistoryResponse
} from "../src/features/generation/providers/comfyuiApi";
import {
  DEFAULT_SEEDANCE_ARK_BASE_URL,
  DEFAULT_SEEDANCE_BRIDGE_URL,
  DEFAULT_SEEDANCE_MODEL,
  buildSeedanceCreateTaskRequest,
  buildSeedanceCreateUrl,
  buildSeedanceTaskUrl,
  mapSeedanceTaskStatus
} from "../src/features/generation/providers/seedanceArk";
import type { GenerationJob } from "../src/features/generation/generationTypes";
import { regenerateRemixAsset } from "../src/features/generation/generationService";
import { createFinalVideoRun, mergeFinalRunsById, mergeRunFeedback } from "../src/features/lineage/lineageService";
import {
  DEFAULT_MAX_USES,
  createCustomBucket,
  createMockRemixAssets,
  deleteCustomBucket,
  ensureDefaultBuckets,
  mergeAssetsIntoBuckets,
  renameBucket,
  toggleAssetDisabled,
  applyOperationDecisionsToBuckets,
  updateAssetMaxUses
} from "../src/features/remix/remixBucketService";
import { createRemixPlan } from "../src/features/remix/remixPlanner";
import type { MaterialBucket, RemixAsset } from "../src/features/remix/remixTypes";
import { createSegmentsFromAnalysis } from "../src/features/script/segmentFactory";
import { buildScriptAudit } from "../src/features/script/scriptAudit";
import {
  buildScriptRewriteSuggestion,
  createScriptRevision,
  restoreSegmentsFromRevision
} from "../src/features/script/scriptRevision";
import { createMockAnalysis } from "../src/features/analysis/mockAnalysis";
import { buildOperationAnalytics } from "../src/features/lineage/operationAnalytics";

const analysis = createMockAnalysis(45);
const segments = createSegmentsFromAnalysis(analysis, initialGenerationOptions);

await run("merges provider settings and selects provider-specific params", () => {
  const settings = mergeProviderSettings({
    comfyui: {
      endpoint: "http://localhost:8188"
    }
  });
  assert.equal(settings.comfyui.endpoint, "http://localhost:8188");
  assert.equal(settings.comfyui.workflowTemplateId, "default-video-workflow");
  assert.equal(settings.seedance.bridgeUrl, DEFAULT_SEEDANCE_BRIDGE_URL);
  assert.equal(settings.seedance.endpoint, DEFAULT_SEEDANCE_ARK_BASE_URL);
  assert.equal(settings.seedance.model, DEFAULT_SEEDANCE_MODEL);
  assert.equal(settings.seedance.apiKeyEnvName, "ARK_API_KEY");

  const comfyParams = providerParamsFor("comfyui", settings);
  assert.equal(comfyParams.endpoint, "http://localhost:8188");
  const seedanceParams = providerParamsFor("seedance", settings);
  assert.equal(seedanceParams.model, DEFAULT_SEEDANCE_MODEL);
});

await run("builds official Ark Seedance task payload and URLs", () => {
  const request = buildSeedanceCreateTaskRequest({
    prompt: "  第一人称产品展示，快速切镜  ",
    aspectRatio: "9:16",
    duration: 3,
    referenceImageUrl: "https://example.com/ref.png",
    params: {
      model: DEFAULT_SEEDANCE_MODEL,
      endpoint: DEFAULT_SEEDANCE_ARK_BASE_URL,
      apiKeyEnvName: "ARK_API_KEY",
      resolution: "1080p",
      defaultDuration: 5,
      seed: "11",
      generateAudio: true,
      watermark: false,
      returnLastFrame: true
    }
  });
  assert.equal(request.endpoint, DEFAULT_SEEDANCE_ARK_BASE_URL);
  assert.equal(request.apiKeyEnvName, "ARK_API_KEY");
  assert.equal(request.body.model, DEFAULT_SEEDANCE_MODEL);
  assert.equal(request.body.content[0].type, "text");
  assert.equal(request.body.content[1].type, "image_url");
  assert.equal(request.body.duration, 5);
  assert.equal(request.body.seed, 11);
  assert.equal(request.body.generate_audio, true);
  assert.equal(request.body.return_last_frame, true);
  assert.equal(buildSeedanceCreateUrl(DEFAULT_SEEDANCE_ARK_BASE_URL), `${DEFAULT_SEEDANCE_ARK_BASE_URL}/contents/generations/tasks`);
  assert.equal(
    buildSeedanceTaskUrl(DEFAULT_SEEDANCE_ARK_BASE_URL, "cgt_test"),
    `${DEFAULT_SEEDANCE_ARK_BASE_URL}/contents/generations/tasks/cgt_test`
  );
  assert.equal(mapSeedanceTaskStatus("running"), "generating");
  assert.equal(mapSeedanceTaskStatus("succeeded"), "done");
  assert.equal(mapSeedanceTaskStatus("expired"), "failed");
});

await run("injects ComfyUI workflow controls and parses output history", () => {
  const body = buildComfyUIPromptBody({
    workflow: {
      "6": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: "old prompt"
        }
      },
      "3": {
        class_type: "KSampler",
        inputs: {
          seed: 1,
          steps: 12,
          cfg: 5
        }
      }
    },
    prompt: "new product demo prompt",
    promptNodeId: "6",
    seed: "42",
    steps: 24,
    cfgScale: 7,
    clientId: "videogen_test"
  });
  const workflow = body.prompt as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(workflow["6"].inputs.text, "new product demo prompt");
  assert.equal(workflow["3"].inputs.seed, 42);
  assert.equal(workflow["3"].inputs.steps, 24);
  assert.equal(workflow["3"].inputs.cfg, 7);

  const history = normalizeComfyUIHistoryResponse({
    endpoint: "http://127.0.0.1:8188",
    promptId: "prompt_001",
    payload: {
      prompt_001: {
        status: { completed: true, status_str: "success" },
        outputs: {
          save_video: {
            videos: [{ filename: "result.mp4", subfolder: "run_a", type: "output" }]
          }
        }
      }
    }
  });
  assert.equal(history.status, "succeeded");
  assert.equal(history.outputFiles?.[0].nodeId, "save_video");
  assert.match(history.outputFiles?.[0].viewUrl || "", /\/view\?/);
  assert.equal(mapComfyUITaskStatus("succeeded"), "done");
  assert.equal(mapComfyUITaskStatus("queued"), "queued");
});

await run("creates default buckets and mock remix assets with inherited tags", () => {
  const buckets = ensureDefaultBuckets();
  assert.equal(buckets.length, 5);
  assert.deepEqual(
    buckets.map((bucket) => bucket.id),
    ["hook", "pain", "usp", "trust", "cta"]
  );

  const assets = createMockRemixAssets({
    segments,
    analysisResult: analysis,
    options: initialGenerationOptions,
    sourcePreviewUrl: "blob:source"
  });
  assert.equal(assets.length, 5);
  assert.equal(assets[0].usage.maxUses, DEFAULT_MAX_USES);
  assert.equal(assets[0].usage.usedCount, 0);
  assert.equal(assets[0].tags.topicType, analysis.basicInfo.topicType);
  assert.equal(assets[0].tags.providerId, initialGenerationOptions.provider);
});

await run("uses editable segment bucket roles when planning remix assets", () => {
  const editedSegment = {
    ...segments[0],
    id: "custom_segment_001",
    bucketRole: "cta" as const,
    role: "45-50秒",
    duration: 5
  };
  const plan = createRemixPlan({
    segments: [editedSegment],
    analysisResult: analysis,
    options: initialGenerationOptions
  });
  const assets = createMockRemixAssets({
    segments: [editedSegment],
    analysisResult: analysis,
    options: initialGenerationOptions,
    sourcePreviewUrl: "blob:source"
  });
  assert.equal(plan.items[0].bucketId, "cta");
  assert.equal(plan.items[0].duration, 5);
  assert.equal(assets[0].bucketId, "cta");
  assert.equal(assets[0].tags.sourceRange, "45-50秒");
});

await run("creates script revisions and deterministic rewrite suggestions", () => {
  const segmentWithTransientUrls = {
    ...segments[0],
    videoUrl: "blob:video",
    referenceImageUrl: "blob:image"
  };
  const revision = createScriptRevision([segmentWithTransientUrls], "manual checkpoint");
  assert.equal(revision.label, "manual checkpoint");
  assert.equal(revision.segmentCount, 1);
  assert.equal(revision.totalDuration, segmentWithTransientUrls.duration);
  assert.equal(revision.segments[0].videoUrl, undefined);
  assert.equal(revision.segments[0].referenceImageUrl, undefined);

  const restored = restoreSegmentsFromRevision(revision);
  assert.equal(restored[0].id, segmentWithTransientUrls.id);

  const suggestion = buildScriptRewriteSuggestion({ ...segments[0], bucketRole: "hook" });
  assert.match(suggestion.scriptText, /3秒/);
  assert.match(suggestion.generationPrompt, /改写重点/);
});

await run("audits script content readiness and risky claims", () => {
  const blockedReport = buildScriptAudit([
    {
      ...segments[0],
      scriptText: "",
      generationPrompt: "",
      contentStatus: "blocked"
    }
  ]);
  assert.equal(blockedReport.readiness, "blocked");
  assert.ok(blockedReport.counts.error >= 2);

  const riskyReport = buildScriptAudit([
    {
      ...segments[0],
      scriptText: "这是全网第一，保证100%立刻见效。",
      generationPrompt: "真实短视频实拍，首帧强对比，产品和结果同屏展示，节奏紧凑。",
      contentStatus: "approved"
    },
    ...segments.slice(1)
  ]);
  assert.ok(riskyReport.issues.some((issue) => issue.id.includes("claim-risk")));
  assert.notEqual(riskyReport.readiness, "blocked");
});

await run("marks Seedance assets as generating and preserves provider trace", () => {
  const job: GenerationJob = {
    id: "job_local_seedance",
    remoteJobId: "cgt_remote",
    remoteStatus: "queued",
    input: {
      segmentId: segments[0].id,
      bucketId: "hook",
      providerId: "seedance",
      prompt: segments[0].generationPrompt,
      duration: segments[0].duration,
      aspectRatio: "9:16",
      providerParams: {
        model: DEFAULT_SEEDANCE_MODEL
      }
    },
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const assets = createMockRemixAssets({
    segments: [segments[0]],
    analysisResult: analysis,
    options: { ...initialGenerationOptions, provider: "seedance" },
    sourcePreviewUrl: "blob:source",
    generationJobs: [job]
  });
  assert.equal(assets[0].status, "generating");
  assert.equal(assets[0].videoUrl, undefined);
  assert.equal(assets[0].generationJobId, "job_local_seedance");
  assert.equal(assets[0].providerTrace?.remoteJobId, "cgt_remote");
  assert.deepEqual(assets[0].tags.custom?.remoteJobId, ["cgt_remote"]);
});

await run("merges assets into buckets and updates maxUses without changing usedCount", () => {
  const assets = createMockRemixAssets({
    segments,
    analysisResult: analysis,
    options: initialGenerationOptions,
    sourcePreviewUrl: ""
  });
  const buckets = mergeAssetsIntoBuckets(ensureDefaultBuckets(), assets);
  const hookAsset = buckets.find((bucket) => bucket.id === "hook")?.assets[0];
  assert.ok(hookAsset);
  assert.equal(hookAsset.usage.usedCount, 0);

  const updated = updateAssetMaxUses(buckets, hookAsset.id, 7);
  const updatedAsset = updated.find((bucket) => bucket.id === "hook")?.assets[0];
  assert.equal(updatedAsset?.usage.maxUses, 7);
  assert.equal(updatedAsset?.usage.usedCount, 0);
});

await run("regenerates an asset into the same bucket and disables the source asset", async () => {
  const assets = createMockRemixAssets({
    segments,
    analysisResult: analysis,
    options: { ...initialGenerationOptions, provider: "mock" },
    sourcePreviewUrl: "blob:source"
  });
  const buckets = mergeAssetsIntoBuckets(ensureDefaultBuckets(), assets);
  const sourceAsset = buckets.find((bucket) => bucket.id === "hook")?.assets[0];
  assert.ok(sourceAsset);

  const regenerated = await regenerateRemixAsset({
    assetId: sourceAsset.id,
    buckets,
    segments,
    analysisResult: analysis,
    options: { ...initialGenerationOptions, provider: "mock" },
    providerSettings: mergeProviderSettings(),
    sourcePreviewUrl: "blob:source"
  });

  const hookBucket = regenerated.buckets.find((bucket) => bucket.id === "hook");
  assert.ok(hookBucket);
  assert.equal(regenerated.asset.bucketId, "hook");
  assert.equal(hookBucket.assets[0].id, regenerated.asset.id);
  assert.equal(hookBucket.assets[1].id, sourceAsset.id);
  assert.equal(hookBucket.assets[1].disabled, true);
  assert.deepEqual(hookBucket.assets[1].tags.custom?.replacedBy, [regenerated.asset.id]);
  assert.deepEqual(regenerated.asset.tags.custom?.regeneratedFrom, [sourceAsset.id]);
  assert.equal(regenerated.asset.usage.usedCount, 0);
  assert.equal(regenerated.asset.usage.maxUses, sourceAsset.usage.maxUses);
});

await run("assembles timeline using least-used assets and does not consume usage on preview", () => {
  const highUse = makeAsset("asset_high", "hook", 2, 3);
  const lowUse = makeAsset("asset_low", "hook", 0, 3);
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [highUse, lowUse]
    }
  ];

  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook"], randomSeed: "seed_fixed" });
  assert.equal(timeline.clips.length, 1);
  assert.equal(timeline.clips[0].assetId, "asset_low");
  assert.equal(lowUse.usage.usedCount, 0);
});

await run("rerolls a single timeline clip from the same bucket without consuming usage", () => {
  const first = makeAsset("asset_reroll_first", "hook", 0, 3);
  const second = {
    ...makeAsset("asset_reroll_second", "hook", 0, 3),
    duration: 5,
    title: "hook replacement"
  };
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [first, second]
    }
  ];
  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook"], randomSeed: "reroll_start" });
  const rerolled = rerollTimelineClipFromBuckets({
    timeline,
    buckets,
    clipId: timeline.clips[0].id,
    randomSeed: "reroll_next"
  });

  assert.notEqual(rerolled.clips[0].assetId, timeline.clips[0].assetId);
  assert.equal(rerolled.clips[0].bucketId, "hook");
  assert.equal(rerolled.clips[0].order, 1);
  assert.equal(rerolled.clips[0].selectionTrace?.action, "rerolled");
  assert.equal(rerolled.clips[0].selectionTrace?.previousAssetId, timeline.clips[0].assetId);
  assert.equal(rerolled.totalDuration, rerolled.clips[0].duration);
  assert.equal(buckets[0].assets[0].usage.usedCount, 0);
  assert.equal(buckets[0].assets[1].usage.usedCount, 0);
});

await run("reorders timeline clips and normalizes clip order", () => {
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [makeAsset("asset_order_hook", "hook", 0, 3)]
    },
    {
      id: "cta",
      role: "cta",
      label: "行动",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [makeAsset("asset_order_cta", "cta", 0, 3)]
    }
  ];
  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook", "cta"], randomSeed: "order_seed" });
  const moved = moveTimelineClip({
    timeline,
    clipId: timeline.clips[1].id,
    direction: -1
  });

  assert.equal(moved.clips[0].assetId, "asset_order_cta");
  assert.equal(moved.clips[0].order, 1);
  assert.equal(moved.clips[1].assetId, "asset_order_hook");
  assert.equal(moved.clips[1].order, 2);
  assert.equal(moved.totalDuration, timeline.totalDuration);
});

await run("blocks assembly when bucket has no usable assets", () => {
  const exhausted = makeAsset("asset_exhausted", "hook", 3, 3);
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [exhausted]
    }
  ];

  assert.throws(
    () => assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook"] }),
    /没有可用片段/
  );
});

await run("skips disabled assets during least-used selection", () => {
  const disabledLowUse = makeAsset("asset_disabled_low", "hook", 0, 3, true);
  const enabledHighUse = makeAsset("asset_enabled_high", "hook", 2, 3);
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [disabledLowUse, enabledHighUse]
    }
  ];

  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook"], randomSeed: "disabled_seed" });
  assert.equal(timeline.clips[0].assetId, "asset_enabled_high");
});

await run("skips rejected assets during least-used selection", () => {
  const rejectedLowUse = { ...makeAsset("asset_rejected_low", "hook", 0, 3), operationState: "rejected" as const };
  const enabledHighUse = makeAsset("asset_enabled_high", "hook", 2, 3);
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [rejectedLowUse, enabledHighUse]
    }
  ];

  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook"], randomSeed: "rejected_seed" });
  assert.equal(timeline.clips[0].assetId, "asset_enabled_high");
});

await run("toggles asset disabled state and manages custom buckets", () => {
  const customBucket = createCustomBucket("product-shot");
  const buckets = ensureDefaultBuckets([customBucket]);
  assert.equal(buckets.at(-1)?.label, "product-shot");
  assert.equal(buckets.at(-1)?.isCustom, true);

  const renamed = renameBucket(buckets, customBucket.id, "testimonial");
  assert.equal(renamed.at(-1)?.label, "testimonial");
  assert.equal(renamed.at(-1)?.role, "testimonial");

  const asset = makeAsset("asset_toggle", "hook", 0, 3);
  const withAsset = mergeAssetsIntoBuckets(renamed, [asset]);
  const disabled = toggleAssetDisabled(withAsset, asset.id);
  assert.equal(disabled.find((bucket) => bucket.id === "hook")?.assets[0].disabled, true);
  const enabled = toggleAssetDisabled(disabled, asset.id);
  assert.equal(enabled.find((bucket) => bucket.id === "hook")?.assets[0].disabled, false);

  const deleted = deleteCustomBucket(enabled, customBucket.id);
  assert.equal(deleted.some((bucket) => bucket.id === customBucket.id), false);
});

await run("commits usage and creates lineage with before/after trace", () => {
  const asset = {
    ...makeAsset("asset_lineage", "cta", 1, 3),
    subtitleText: "lineage subtitle",
    overlayText: "LINEAGE CTA"
  };
  const buckets: MaterialBucket[] = [
    {
      id: "cta",
      role: "cta",
      label: "CTA尾段",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [asset]
    }
  ];
  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["cta"], randomSeed: "lineage_seed" });
  const { buckets: committed, changes } = commitTimelineUsage(buckets, timeline);
  assert.equal(changes[0].before, 1);
  assert.equal(changes[0].after, 2);
  assert.equal(committed[0].assets[0].usage.usedCount, 2);

  const lineage = createFinalVideoRun({
    projectId: "project_test",
    outputName: "lineage_test",
    fileName: "lineage_test.zip",
    timeline,
    buckets: committed,
    usageChanges: changes
  });
  assert.match(lineage.id, /^run_/);
  assert.equal(lineage.clips[0].usageBeforeExport, 1);
  assert.equal(lineage.clips[0].usageAfterExport, 2);
  assert.equal(lineage.clips[0].bucketId, "cta");
  assert.equal(lineage.clips[0].title, "cta asset");
  assert.equal(lineage.clips[0].subtitleText, "lineage subtitle");
  assert.equal(lineage.clips[0].overlayText, "LINEAGE CTA");
  assert.equal(lineage.clips[0].duration, 3);
  assert.equal(lineage.clips[0].selectionTrace?.action, "assembled");
});

await run("stores operation feedback on final video runs and merges imported runs", () => {
  const asset = makeAsset("asset_feedback", "hook", 0, 3);
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [asset]
    }
  ];
  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook"], randomSeed: "feedback_seed" });
  const { buckets: committed, changes } = commitTimelineUsage(buckets, timeline);
  const run = createFinalVideoRun({
    projectId: "project_feedback",
    outputName: "feedback_test",
    fileName: "feedback_test.zip",
    timeline,
    buckets: committed,
    usageChanges: changes
  });
  const withFeedback = mergeRunFeedback(run, {
    platform: "douyin",
    campaignId: "campaign_001",
    externalCreativeId: "creative_001",
    views: 1200,
    completionRate: 0.52,
    clickThroughRate: 0.08,
    conversionRate: 0.03,
    spend: 300,
    gmv: 960,
    roi: 3.2,
    notes: "hook 表现好"
  });

  assert.equal(withFeedback.feedback?.platform, "douyin");
  assert.equal(withFeedback.feedback?.views, 1200);
  assert.equal(withFeedback.feedback?.roi, 3.2);
  assert.ok(withFeedback.feedback?.updatedAt);

  const merged = mergeFinalRunsById([run], [withFeedback]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].feedback?.campaignId, "campaign_001");
});

await run("aggregates operation feedback by asset, bucket, provider, and prompt hash", () => {
  const hookAsset = makeAsset("asset_hook_feedback", "hook", 0, 3);
  const ctaAsset = makeAsset("asset_cta_feedback", "cta", 0, 3);
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [hookAsset]
    },
    {
      id: "cta",
      role: "cta",
      label: "CTA尾段",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [ctaAsset]
    }
  ];
  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook", "cta"], randomSeed: "analytics_seed" });
  const { buckets: committed, changes } = commitTimelineUsage(buckets, timeline);
  const run = mergeRunFeedback(createFinalVideoRun({
    projectId: "project_analytics",
    outputName: "analytics_test",
    fileName: "analytics_test.zip",
    timeline,
    buckets: committed,
    usageChanges: changes
  }), {
    views: 2000,
    completionRate: 0.61,
    clickThroughRate: 0.09,
    conversionRate: 0.04,
    spend: 500,
    gmv: 1500,
    roi: 3
  });

  const analytics = buildOperationAnalytics([run]);
  assert.equal(analytics.asset.length, 2);
  assert.equal(analytics.bucket.length, 2);
  assert.equal(analytics.provider.length, 1);
  assert.equal(analytics.provider[0].sampleRuns, 1);
  assert.equal(analytics.provider[0].clipUses, 2);
  assert.equal(analytics.provider[0].totalGmv, 1500);
  assert.equal(analytics.provider[0].avgCompletionRate, 0.61);
  assert.equal(analytics.bucket.find((item) => item.key === "hook")?.avgRoi, 3);
});

await run("applies operation decision suggestions from feedback analytics", () => {
  const winningAsset = makeAsset("asset_winning", "hook", 0, 3);
  const rejectedAsset = makeAsset("asset_rejected", "hook", 0, 3);
  const untestedAsset = makeAsset("asset_untested", "hook", 0, 3);
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [winningAsset, rejectedAsset, untestedAsset]
    }
  ];
  const runs = [
    createFeedbackRunForAsset(winningAsset, "winning_seed", {
      views: 1800,
      completionRate: 0.56,
      clickThroughRate: 0.08,
      conversionRate: 0.03,
      spend: 300,
      gmv: 960,
      roi: 3.2
    }),
    createFeedbackRunForAsset(rejectedAsset, "rejected_seed_1", {
      views: 800,
      completionRate: 0.18,
      clickThroughRate: 0.01,
      conversionRate: 0.002,
      spend: 300,
      gmv: 120,
      roi: 0.4
    }),
    createFeedbackRunForAsset(rejectedAsset, "rejected_seed_2", {
      views: 760,
      completionRate: 0.16,
      clickThroughRate: 0.012,
      conversionRate: 0.002,
      spend: 280,
      gmv: 100,
      roi: 0.36
    })
  ];

  const decided = applyOperationDecisionsToBuckets(buckets, buildOperationAnalytics(runs));
  const states = new Map(decided.flatMap((bucket) => bucket.assets.map((asset) => [asset.id, asset.operationState])));
  assert.equal(states.get("asset_winning"), "winning");
  assert.equal(states.get("asset_rejected"), "rejected");
  assert.equal(states.get("asset_untested"), "untested");
});

await run("exports jianying package with lineage, timeline, and assets manifests", async () => {
  const asset = {
    ...makeAsset("asset_export", "hook", 0, 3),
    subtitleText: "export subtitle",
    overlayText: "EXPORT HOOK"
  };
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [asset]
    }
  ];
  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook"], randomSeed: "export_seed" });
  const { buckets: committed, changes } = commitTimelineUsage(buckets, timeline);
  const review = buildComposeReview(timeline, committed);
  const lineage = mergeRunFeedback(createFinalVideoRun({
    projectId: "project_export",
    outputName: "export_test",
    fileName: "export_test.zip",
    timeline,
    buckets: committed,
    usageChanges: changes,
    review
  }), {
    platform: "ad-platform",
    externalCreativeId: "creative_export",
    views: 100
  });

  const { blob, fileName } = await buildJianyingDraftPackage({
    projectName: "export_test",
    timeline,
    materialBuckets: committed,
    lineage,
    options: initialGenerationOptions
  });
  assert.equal(fileName, "export_test.zip");

  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.ok(zip.file("export_test/lineage.json"));
  assert.ok(zip.file("export_test/timeline.json"));
  assert.ok(zip.file("export_test/assets.json"));
  assert.ok(zip.file("export_test/draft_content.json"));
  assert.ok(zip.file("export_test/subtitles/subtitles.srt"));
  assert.ok(zip.file("export_test/subtitles/text_manifest.json"));

  const lineageJson = JSON.parse(await zip.file("export_test/lineage.json")!.async("string"));
  assert.equal(lineageJson.clips[0].remixAssetId, "asset_export");
  assert.equal(lineageJson.clips[0].subtitleText, "export subtitle");
  assert.equal(lineageJson.clips[0].overlayText, "EXPORT HOOK");
  assert.equal(lineageJson.review.readiness, "needs-work");
  assert.ok(lineageJson.review.issues.some((issue: { id: string }) => issue.id.endsWith("media-missing")));
  assert.equal(lineageJson.feedback.externalCreativeId, "creative_export");
  const srt = await zip.file("export_test/subtitles/subtitles.srt")!.async("string");
  assert.match(srt, /export subtitle/);
  const textManifest = JSON.parse(await zip.file("export_test/subtitles/text_manifest.json")!.async("string"));
  assert.equal(textManifest.clips[0].subtitleText, "export subtitle");
  assert.equal(textManifest.clips[0].overlayText, "EXPORT HOOK");
  const draftContent = JSON.parse(await zip.file("export_test/draft_content.json")!.async("string"));
  assert.ok(draftContent.materials.texts.some((item: { content: string; style: string }) => item.content === "EXPORT HOOK" && item.style === "overlay"));
  assert.ok(draftContent.tracks.some((track: { id: string; segments: unknown[] }) => track.id.startsWith("track_overlay") && track.segments.length === 1));
});

await run("preserves final timeline text overrides before export", async () => {
  const asset = {
    ...makeAsset("asset_text_override", "hook", 0, 3),
    subtitleText: "original subtitle",
    overlayText: "ORIGINAL"
  };
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [asset]
    }
  ];
  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook"], randomSeed: "text_override_seed" });
  const editedTimeline: ComposeTimeline = {
    ...timeline,
    clips: timeline.clips.map((clip) => ({
      ...clip,
      scriptText: "edited script",
      subtitleText: "edited subtitle",
      overlayText: "EDITED"
    }))
  };
  const serialized = serializeTimeline(editedTimeline);

  assert.equal(serialized?.clips[0].scriptText, "edited script");
  assert.equal(serialized?.clips[0].subtitleText, "edited subtitle");
  assert.equal(serialized?.clips[0].overlayText, "EDITED");

  const { blob } = await buildJianyingDraftPackage({
    projectName: "override_export",
    timeline: editedTimeline,
    materialBuckets: buckets,
    options: initialGenerationOptions
  });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const srt = await zip.file("override_export/subtitles/subtitles.srt")!.async("string");
  const textManifest = JSON.parse(await zip.file("override_export/subtitles/text_manifest.json")!.async("string"));
  const draftContent = JSON.parse(await zip.file("override_export/draft_content.json")!.async("string"));

  assert.match(srt, /edited subtitle/);
  assert.equal(textManifest.clips[0].scriptText, "edited script");
  assert.equal(textManifest.clips[0].subtitleText, "edited subtitle");
  assert.equal(textManifest.clips[0].overlayText, "EDITED");
  assert.ok(draftContent.materials.texts.some((item: { content: string; style: string }) => item.content === "EDITED" && item.style === "overlay"));
});

await run("reviews compose timeline before locking export", () => {
  const buckets: MaterialBucket[] = [
    {
      id: "hook",
      role: "hook",
      label: "钩子",
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [makeAsset("asset_review", "hook", 0, 1)]
    }
  ];
  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: ["hook"], randomSeed: "review_seed" });
  const warningReport = buildComposeReview(timeline, buckets);
  assert.equal(warningReport.readiness, "needs-work");
  assert.ok(warningReport.issues.some((issue) => issue.id.endsWith("media-missing")));

  const depletedBuckets = buckets.map((bucket) => ({
    ...bucket,
    assets: bucket.assets.map((asset) => ({
      ...asset,
      usage: {
        ...asset.usage,
        usedCount: asset.usage.maxUses
      }
    }))
  }));
  const blockedReport = buildComposeReview(timeline, depletedBuckets);
  assert.equal(blockedReport.readiness, "blocked");
  assert.ok(blockedReport.issues.some((issue) => issue.id.endsWith("asset-depleted")));
});

console.log("All remix workflow tests passed.");

async function run(name: string, test: () => void | Promise<void>) {
  await test();
  console.log(`✓ ${name}`);
}

function makeAsset(id: string, role: string, usedCount: number, maxUses: number, disabled = false): RemixAsset {
  return {
    id,
    sourceSegmentId: `${role}_segment`,
    bucketId: role,
    role,
    title: `${role} asset`,
    scriptText: `${role} script`,
    prompt: `${role} prompt`,
    duration: 3,
    providerId: "mock",
    status: "ready",
    operationState: "untested",
    disabled,
    tags: {
      narrativeRole: role,
      sourceRange: "0-3秒",
      topicType: "分级概念",
      materialType: "mock",
      targetAudience: "test",
      visualStyle: "test",
      providerId: "mock",
      promptHash: `${id}_hash`
    },
    usage: {
      usedCount,
      maxUses
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    generationJobId: `${id}_job`,
    weight: 1
  };
}

function createFeedbackRunForAsset(asset: RemixAsset, randomSeed: string, feedback: Parameters<typeof mergeRunFeedback>[1]) {
  const buckets: MaterialBucket[] = [
    {
      id: asset.bucketId,
      role: asset.role,
      label: asset.bucketId === "hook" ? "钩子" : asset.bucketId,
      isCustom: false,
      selectionPolicy: "least-used",
      assets: [asset]
    }
  ];
  const timeline = assembleTimelineFromBuckets({ buckets, bucketSequence: [asset.bucketId], randomSeed });
  const { buckets: committed, changes } = commitTimelineUsage(buckets, timeline);
  return mergeRunFeedback(createFinalVideoRun({
    projectId: "project_feedback_decision",
    outputName: `${asset.id}_${randomSeed}`,
    fileName: `${asset.id}_${randomSeed}.zip`,
    timeline,
    buckets: committed,
    usageChanges: changes
  }), feedback);
}
