import { Check, Clock3, Coins, Film, Image as ImageIcon, Layers3, Plus, RefreshCw, Sparkles, Tag, Trash2, Upload, Wand2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";
import type { VideoSegment } from "../../types";
import { createId } from "../../services/id";
import { preprocessDepthVideoBridge } from "../../services/videoGenerationBridgeClient";
import type {
  AiGenerationCost,
  ComposeRecipeStep,
  DepthAiProvider,
  DepthWorkbenchState,
  DepthComposePlanItem,
  ImageLibraryCategory,
  ImageMaterial,
  MaterialClip,
  MaterialOutput,
  MaterialTag,
  MaterialTagType
} from "./depthTypes";

const tagOptions: Array<{ type: MaterialTagType; label: string }> = [
  { type: "hook", label: "钩子" },
  { type: "purchase_reason", label: "购买理由" },
  { type: "product_shaping", label: "塑品" },
  { type: "conversion", label: "促成交" },
  { type: "custom", label: "自定义" }
];

const imageCategoryOptions: Array<{ value: ImageLibraryCategory; label: string; defaultTag: MaterialTagType }> = [
  { value: "product", label: "产品素材库", defaultTag: "product" },
  { value: "face", label: "人脸素材库", defaultTag: "face" },
  { value: "other", label: "其他图片", defaultTag: "other_image" }
];

const imageTagOptions: Array<{ type: MaterialTagType; label: string }> = [
  { type: "product", label: "产品" },
  { type: "face", label: "人脸" },
  { type: "other_image", label: "其他图片" },
  { type: "custom", label: "自定义" }
];

const providerOptions: Array<{ value: DepthAiProvider; label: string }> = [
  { value: "seedance_api", label: "Seedance 接口" },
  { value: "jimeng_web", label: "即梦网页版" },
  { value: "comfyui_remote_gpu", label: "ComfyUI 远程GPU" },
  { value: "kling_web", label: "可灵网页版" },
  { value: "gemini_web", label: "Gemini 网页版" }
];

type DepthWorkbenchTab = "library" | "preprocess" | "ai" | "cost" | "compose";
type MaterialLibraryMode = "video" | "image";
type DepthQualityPreset = "fast" | "standard" | "portrait";

const depthQualityDefaults: Record<DepthQualityPreset, {
  label: string;
  inputSize: number;
  letterbox: boolean;
  edgeFilterStrength: number;
  edgeFilterDiameter: number;
}> = {
  fast: { label: "快速", inputSize: 518, letterbox: false, edgeFilterStrength: 0, edgeFilterDiameter: 5 },
  standard: { label: "标准", inputSize: 518, letterbox: true, edgeFilterStrength: 0.35, edgeFilterDiameter: 7 },
  portrait: { label: "人像边缘", inputSize: 518, letterbox: true, edgeFilterStrength: 0.55, edgeFilterDiameter: 9 }
};

const workbenchTabs: Array<{ key: DepthWorkbenchTab; title: string; subtitle: string }> = [
  { key: "library", title: "素材片段库", subtitle: "导入 / 标签 / 选择" },
  { key: "preprocess", title: "前置处理", subtitle: "原片转深度视频" },
  { key: "ai", title: "AI加工", subtitle: "多平台生成" },
  { key: "cost", title: "成本追踪", subtitle: "积分 / 时间 / 产物" },
  { key: "compose", title: "标签拼接", subtitle: "排序 / 抽取 / 预览" }
];

const defaultRecipe: ComposeRecipeStep[] = [
  { id: "recipe_hook", tagType: "hook", label: "钩子", count: 1, selectionPolicy: "least_used" },
  { id: "recipe_product", tagType: "product_shaping", label: "塑品", count: 2, selectionPolicy: "least_used" },
  { id: "recipe_reason", tagType: "purchase_reason", label: "购买理由", count: 1, selectionPolicy: "lowest_cost" },
  { id: "recipe_conversion", tagType: "conversion", label: "促成交", count: 1, selectionPolicy: "least_used" }
];

export function createInitialDepthWorkbenchState(): DepthWorkbenchState {
  return {
    clips: [],
    images: [],
    recipe: defaultRecipe,
    composePlan: []
  };
}

export function DepthVideoWorkbenchPage({
  clips,
  images,
  recipe,
  composePlan,
  segments,
  sourcePreviewUrl,
  sourceVideo,
  projectId,
  bridgeUrl,
  onClips,
  onImages,
  onRecipe,
  onComposePlan,
  onNotice,
  onBack,
  onNext
}: {
  clips: MaterialClip[];
  images: ImageMaterial[];
  recipe: ComposeRecipeStep[];
  composePlan: DepthComposePlanItem[];
  segments: VideoSegment[];
  sourcePreviewUrl: string;
  sourceVideo?: File;
  projectId: string;
  bridgeUrl: string;
  onClips: Dispatch<SetStateAction<MaterialClip[]>>;
  onImages: Dispatch<SetStateAction<ImageMaterial[]>>;
  onRecipe: Dispatch<SetStateAction<ComposeRecipeStep[]>>;
  onComposePlan: Dispatch<SetStateAction<DepthComposePlanItem[]>>;
  onNotice: (notice: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [tagType, setTagType] = useState<MaterialTagType>("hook");
  const [customTag, setCustomTag] = useState("");
  const [libraryMode, setLibraryMode] = useState<MaterialLibraryMode>("video");
  const [imageCategory, setImageCategory] = useState<ImageLibraryCategory>("product");
  const [imageTagType, setImageTagType] = useState<MaterialTagType>("product");
  const [customImageTag, setCustomImageTag] = useState("");
  const [aiProvider, setAiProvider] = useState<DepthAiProvider>("seedance_api");
  const [prompt, setPrompt] = useState("保留原素材内容，增强镜头运动和产品质感，适合电商短视频投放。");
  const [activeTab, setActiveTab] = useState<DepthWorkbenchTab>("library");
  const [depthQualityPreset, setDepthQualityPreset] = useState<DepthQualityPreset>("standard");
  const [depthInputSize, setDepthInputSize] = useState(518);
  const [depthLetterbox, setDepthLetterbox] = useState(true);
  const [depthEdgeFilterStrength, setDepthEdgeFilterStrength] = useState(0.35);
  const [depthEdgeFilterDiameter, setDepthEdgeFilterDiameter] = useState(7);

  const selectedClips = clips.filter((clip) => selectedIds.includes(clip.id));
  const stats = useMemo(() => buildStats(clips), [clips]);
  const depthMonitor = useMemo(() => buildDepthMonitor(clips), [clips]);
  const depthProcessableIds = useMemo(
    () => clips.filter((clip) => !isDepthBusy(clip)).map((clip) => clip.id),
    [clips]
  );
  const depthUnfinishedIds = useMemo(
    () => clips.filter((clip) => clip.preprocess?.status !== "done" && !isDepthBusy(clip)).map((clip) => clip.id),
    [clips]
  );

  useEffect(() => {
    if (!clips.some((clip) => clip.preprocess?.status === "processing")) return;
    const timer = window.setInterval(() => {
      onClips((current) => {
        let changed = false;
        const next = current.map((clip) => {
          if (clip.preprocess?.status !== "processing") return clip;
          const elapsedSec = elapsedSince(clip.preprocess.startedAt || clip.preprocess.updatedAt);
          if (clip.preprocess.cost.elapsedSec === elapsedSec) return clip;
          changed = true;
          return {
            ...clip,
            preprocess: {
              ...clip.preprocess,
              cost: { ...clip.preprocess.cost, elapsedSec, gpuSec: elapsedSec },
              updatedAt: new Date().toISOString()
            }
          };
        });
        return changed ? next : current;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [clips, onClips]);

  function toggleSelected(id: string) {
    setSelectedIds((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items, id]));
  }

  function selectAll() {
    setSelectedIds((items) => (items.length === clips.length ? [] : clips.map((clip) => clip.id)));
  }

  function toggleSelectedImage(id: string) {
    setSelectedImageIds((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items, id]));
  }

  function selectAllImages() {
    const visibleImages = images.filter((item) => item.category === imageCategory);
    setSelectedImageIds((items) =>
      visibleImages.length && visibleImages.every((image) => items.includes(image.id))
        ? items.filter((id) => !visibleImages.some((image) => image.id === id))
        : unique([...items, ...visibleImages.map((image) => image.id)])
    );
  }

  function applyDepthQualityPreset(preset: DepthQualityPreset) {
    const defaults = depthQualityDefaults[preset];
    setDepthQualityPreset(preset);
    setDepthInputSize(defaults.inputSize);
    setDepthLetterbox(defaults.letterbox);
    setDepthEdgeFilterStrength(defaults.edgeFilterStrength);
    setDepthEdgeFilterDiameter(defaults.edgeFilterDiameter);
  }

  function importSegments() {
    if (!segments.length) {
      onNotice("当前没有脚本分段。可以先在脚本页创建分段，或直接上传已切分视频片段。");
      return;
    }
    const now = new Date().toISOString();
    onClips((current) => {
      const existingSegmentIds = new Set(current.map((clip) => clip.sourceSegmentId).filter(Boolean));
      const nextClips = segments
        .filter((segment) => !existingSegmentIds.has(segment.id))
        .map((segment) => createClipFromSegment(segment, sourcePreviewUrl || segment.videoUrl || "", now, sourceVideo));
      return [...current, ...nextClips];
    });
    onNotice("已把脚本分段写入深度视频素材片段库，并生成全流程 lineageId。");
  }

  function importFiles(files?: FileList | null) {
    if (!files?.length) return;
    const now = new Date().toISOString();
    const nextClips = Array.from(files)
      .filter((file) => file.type.startsWith("video/"))
      .map((file) => createClipFromFile(file, now));
    if (!nextClips.length) {
      onNotice("请选择视频文件。");
      return;
    }
    onClips((current) => [...current, ...nextClips]);
    onNotice(`已导入 ${nextClips.length} 个已切分视频片段。`);
  }

  function importImageFiles(files?: FileList | null) {
    if (!files?.length) return;
    const now = new Date().toISOString();
    const nextImages = Array.from(files)
      .filter((file) => file.type.startsWith("image/"))
      .map((file) => createImageMaterial(file, imageCategory, now));
    if (!nextImages.length) {
      onNotice("请选择图片文件。");
      return;
    }
    onImages((current) => [...current, ...nextImages]);
    setSelectedImageIds((items) => unique([...items, ...nextImages.map((image) => image.id)]));
    onNotice(`已导入 ${nextImages.length} 张图片到「${imageCategoryLabel(imageCategory)}」，并写入默认标签。`);
  }

  function applyTag() {
    if (!selectedIds.length) {
      onNotice("请先选择要打标签的素材片段。");
      return;
    }
    const optionLabel = tagOptions.find((item) => item.type === tagType)?.label ?? "自定义";
    const label = tagType === "custom" ? customTag.trim() : optionLabel;
    if (!label) {
      onNotice("请输入自定义标签名称。");
      return;
    }
    const now = new Date().toISOString();
    const tag: MaterialTag = {
      id: createId("tag"),
      type: tagType,
      label,
      source: "manual",
      createdAt: now
    };
    onClips((current) =>
      current.map((clip) => {
        if (!selectedIds.includes(clip.id) || hasTag(clip, tag.type, tag.label)) return clip;
        return {
          ...clip,
          tags: [...clip.tags, tag],
          customTags: tag.type === "custom" ? unique([...clip.customTags, tag.label]) : clip.customTags,
          updatedAt: now
        };
      })
    );
    onNotice(`已给 ${selectedIds.length} 个素材添加「${label}」标签。`);
  }

  function applyQuickVideoTag(nextTagType: MaterialTagType, label: string) {
    if (!selectedIds.length) {
      onNotice("请先选择要打标签的视频素材。");
      return;
    }
    addTagsToClips(selectedIds, nextTagType, label);
  }

  function addTagsToClips(targetIds: string[], nextTagType: MaterialTagType, label: string) {
    const now = new Date().toISOString();
    const tag: MaterialTag = {
      id: createId("tag"),
      type: nextTagType,
      label,
      source: "manual",
      createdAt: now
    };
    onClips((current) =>
      current.map((clip) => {
        if (!targetIds.includes(clip.id) || hasTag(clip, tag.type, tag.label)) return clip;
        return {
          ...clip,
          tags: [...clip.tags, tag],
          customTags: tag.type === "custom" ? unique([...clip.customTags, tag.label]) : clip.customTags,
          updatedAt: now
        };
      })
    );
    onNotice(`已给 ${targetIds.length} 个视频素材添加「${label}」标签。`);
  }

  function updateClipDescription(clipId: string, description: string) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => (clip.id === clipId ? { ...clip, description, updatedAt: now } : clip))
    );
  }

  function addClipTag(clipId: string, nextTagType: MaterialTagType, label: string) {
    addTagsToClips([clipId], nextTagType, label);
  }

  function removeClipTag(clipId: string, tagId: string) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => {
        if (clip.id !== clipId) return clip;
        const tags = clip.tags.filter((tag) => tag.id !== tagId);
        return {
          ...clip,
          tags,
          customTags: tags.filter((tag) => tag.type === "custom").map((tag) => tag.label),
          updatedAt: now
        };
      })
    );
    onNotice("已移除视频素材标签。");
  }

  function deleteClip(clipId: string) {
    const clip = clips.find((item) => item.id === clipId);
    if (!clip) return;
    if (!window.confirm(`确认删除视频素材「${clip.title}」？关联的深度视频、AI产物和拼接计划引用也会移除。`)) return;
    onClips((current) => current.filter((item) => item.id !== clipId));
    setSelectedIds((items) => items.filter((id) => id !== clipId));
    onComposePlan((items) => items.filter((item) => item.clipId !== clipId).map((item, index) => ({ ...item, order: index })));
    onNotice(`已删除视频素材「${clip.title}」。`);
  }

  function clearSelectedVideoTags() {
    if (!selectedIds.length) {
      onNotice("请先选择要清除标签的视频素材。");
      return;
    }
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => selectedIds.includes(clip.id) ? { ...clip, tags: [], customTags: [], updatedAt: now } : clip)
    );
    onNotice(`已清除 ${selectedIds.length} 个视频素材的标签。`);
  }

  function applyVideoTagTemplate() {
    const targetIds = selectedIds.length ? selectedIds : clips.map((clip) => clip.id);
    if (!targetIds.length) {
      onNotice("当前没有可套用模板的视频素材。");
      return;
    }
    const template: Array<{ type: MaterialTagType; label: string }> = [
      { type: "hook", label: "钩子" },
      { type: "product_shaping", label: "塑品" },
      { type: "product_shaping", label: "塑品" },
      { type: "purchase_reason", label: "购买理由" },
      { type: "conversion", label: "促成交" }
    ];
    const now = new Date().toISOString();
    onClips((current) => {
      const targets = current.filter((clip) => targetIds.includes(clip.id));
      const tagById = new Map(targets.map((clip, index) => [clip.id, template[Math.min(index, template.length - 1)]]));
      return current.map((clip) => {
        const tagMeta = tagById.get(clip.id);
        if (!tagMeta) return clip;
        const tag: MaterialTag = { id: createId("tag"), type: tagMeta.type, label: tagMeta.label, source: "manual", createdAt: now };
        return {
          ...clip,
          tags: hasTag(clip, tag.type, tag.label) ? clip.tags : [...clip.tags, tag],
          updatedAt: now
        };
      });
    });
    onNotice(`已按电商五段式模板给 ${targetIds.length} 个视频素材套标签。`);
  }

  function applyImageTag() {
    if (!selectedImageIds.length) {
      onNotice("请先选择要打标签的图片素材。");
      return;
    }
    const label = imageTagType === "custom"
      ? customImageTag.trim()
      : imageTagOptions.find((item) => item.type === imageTagType)?.label ?? "自定义";
    if (!label) {
      onNotice("请输入自定义图片标签。");
      return;
    }
    addTagsToImages(selectedImageIds, imageTagType, label);
  }

  function addTagsToImages(targetIds: string[], nextTagType: MaterialTagType, label: string) {
    const now = new Date().toISOString();
    const tag: MaterialTag = { id: createId("tag"), type: nextTagType, label, source: "manual", createdAt: now };
    onImages((current) =>
      current.map((image) => {
        if (!targetIds.includes(image.id) || hasImageTag(image, tag.type, tag.label)) return image;
        return {
          ...image,
          tags: [...image.tags, tag],
          customTags: tag.type === "custom" ? unique([...image.customTags, tag.label]) : image.customTags,
          updatedAt: now
        };
      })
    );
    onNotice(`已给 ${targetIds.length} 张图片添加「${label}」标签。`);
  }

  function updateImageDescription(imageId: string, description: string) {
    const now = new Date().toISOString();
    onImages((current) =>
      current.map((image) => (image.id === imageId ? { ...image, description, updatedAt: now } : image))
    );
  }

  function addImageTag(imageId: string, nextTagType: MaterialTagType, label: string) {
    addTagsToImages([imageId], nextTagType, label);
  }

  function removeImageTag(imageId: string, tagId: string) {
    const now = new Date().toISOString();
    onImages((current) =>
      current.map((image) => {
        if (image.id !== imageId) return image;
        const tags = image.tags.filter((tag) => tag.id !== tagId);
        return {
          ...image,
          tags: tags.length ? tags : [createDefaultImageTag(image.category, now)],
          customTags: tags.filter((tag) => tag.type === "custom").map((tag) => tag.label),
          updatedAt: now
        };
      })
    );
    onNotice("已移除图片素材标签。");
  }

  function deleteImage(imageId: string) {
    const image = images.find((item) => item.id === imageId);
    if (!image) return;
    if (!window.confirm(`确认删除图片素材「${image.title}」？`)) return;
    onImages((current) => current.filter((item) => item.id !== imageId));
    setSelectedImageIds((items) => items.filter((id) => id !== imageId));
    onNotice(`已删除图片素材「${image.title}」。`);
  }

  function clearSelectedImageTags() {
    if (!selectedImageIds.length) {
      onNotice("请先选择要清除标签的图片素材。");
      return;
    }
    const now = new Date().toISOString();
    onImages((current) =>
      current.map((image) => {
        if (!selectedImageIds.includes(image.id)) return image;
        const defaultTag = createDefaultImageTag(image.category, now);
        return { ...image, tags: [defaultTag], customTags: [], updatedAt: now };
      })
    );
    onNotice(`已清除 ${selectedImageIds.length} 张图片的自定义标签，并保留默认分类标签。`);
  }

  async function runDepthPreprocess(targetIds = selectedIds) {
    const nextTargetIds = unique(targetIds).filter((id) => clips.some((clip) => clip.id === id && !isDepthBusy(clip)));
    if (!nextTargetIds.length) {
      onNotice(targetIds.length ? "所选素材正在处理中，请等待当前任务完成后再重新处理。" : "请先选择要处理为深度视频的素材。");
      return;
    }
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => {
        if (!nextTargetIds.includes(clip.id)) return clip;
        return {
          ...clip,
          preprocess: {
            id: createId("depth"),
            sourceClipId: clip.id,
            lineageId: clip.lineageId,
            status: "queued",
            inputVideoUrl: clip.originalVideoUrl,
            provider: "local-bridge",
            params: {
              resolution: "1080p",
              fps: 24,
              depthModel: "depth-anything-dnn",
              inputSize: depthInputSize,
              letterbox: depthLetterbox,
              edgeFilterStrength: depthEdgeFilterStrength,
              edgeFilterDiameter: depthEdgeFilterDiameter
            },
            cost: { elapsedSec: 0, gpuSec: 0, estimatedCash: 0 },
            createdAt: now,
            startedAt: undefined,
            finishedAt: undefined,
            updatedAt: now
          },
          updatedAt: now
        };
      })
    );
    onNotice(`已提交 ${nextTargetIds.length} 个深度视频前置处理任务。`);
    for (const clipId of nextTargetIds) {
      const clip = clips.find((item) => item.id === clipId);
      if (!clip) continue;
      markDepthProcessing(clipId);
      const video = clip.sourceFile instanceof File
        ? clip.sourceFile
        : clip.sourceSegmentId && sourceVideo instanceof File
          ? sourceVideo
          : undefined;
      if (!video) {
        markDepthFailed(clipId, "该素材缺少本地视频文件，请重新上传素材或接入后端素材库后再生成深度视频。");
        continue;
      }
      try {
        const result = await preprocessDepthVideoBridge({
          bridgeUrl,
          projectId,
          clipId: clip.id,
          video,
          model: "depth-anything-dnn",
          resolution: "1080p",
          fps: 24,
          colorMode: "grayscale",
          invert: false,
          inputSize: depthInputSize,
          letterbox: depthLetterbox,
          edgeFilterStrength: depthEdgeFilterStrength,
          edgeFilterDiameter: depthEdgeFilterDiameter
        });
        markDepthDone(clipId, result.trace);
      } catch (error) {
        markDepthFailed(clipId, error instanceof Error ? error.message : "深度视频生成失败。");
      }
    }
  }

  function markDepthProcessing(clipId: string) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) =>
        clip.id === clipId && clip.preprocess
          ? { ...clip, preprocess: { ...clip.preprocess, status: "processing", startedAt: now, updatedAt: now }, updatedAt: now }
          : clip
      )
    );
  }

  function markDepthFailed(clipId: string, message: string) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) =>
        clip.id === clipId && clip.preprocess
          ? {
              ...clip,
              preprocess: {
                ...clip.preprocess,
                status: "failed",
                error: message,
                finishedAt: now,
                cost: {
                  ...clip.preprocess.cost,
                  elapsedSec: clip.preprocess.startedAt ? elapsedBetween(clip.preprocess.startedAt, now) : clip.preprocess.cost.elapsedSec
                },
                updatedAt: now
              },
              updatedAt: now
            }
          : clip
      )
    );
    onNotice(message);
  }

  function markDepthDone(
    clipId: string,
    trace: Awaited<ReturnType<typeof preprocessDepthVideoBridge>>["trace"]
  ) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => {
        if (clip.id !== clipId || !clip.preprocess) return clip;
        const elapsedSec = trace.summary?.elapsedSec ?? 0;
        const depthVideoUrl = trace.outputVideoUrl;
        const parentOutput = getOriginalOutput(clip);
        return {
          ...clip,
          preprocess: {
            ...clip.preprocess,
            status: "done",
            depthVideoUrl,
            provider: "local-bridge",
            params: {
              resolution: "1080p",
              fps: trace.summary?.fps ?? 24,
              depthModel: trace.summary?.model || "depth-anything-dnn",
              inputSize: trace.summary?.inputSize ?? clip.preprocess.params.inputSize,
              letterbox: trace.summary?.letterbox ?? clip.preprocess.params.letterbox,
              edgeFilterStrength: trace.summary?.edgeFilter?.strength ?? clip.preprocess.params.edgeFilterStrength,
              edgeFilterDiameter: trace.summary?.edgeFilter?.diameter ?? clip.preprocess.params.edgeFilterDiameter
            },
            cost: { elapsedSec, gpuSec: elapsedSec, estimatedCash: Number((elapsedSec * 0.012).toFixed(2)) },
            finishedAt: now,
            updatedAt: now
          },
          outputs: upsertOutput(clip.outputs, {
            id: createId("output"),
            sourceClipId: clip.id,
            lineageId: clip.lineageId,
            parentOutputId: parentOutput?.id,
            type: "depth_video",
            provider: "local-bridge",
            videoUrl: depthVideoUrl,
            createdAt: now
          }),
          updatedAt: now
        };
      })
    );
    onNotice("深度视频生成完成，已写入真实 depth_video 产物。");
  }

  function runAiGeneration() {
    if (!selectedIds.length) {
      onNotice("请先选择要进行 AI 加工的素材。");
      return;
    }
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => {
        if (!selectedIds.includes(clip.id)) return clip;
        const job = createAiJob(clip, aiProvider, prompt, now);
        return { ...clip, aiJobs: [job, ...clip.aiJobs], updatedAt: now };
      })
    );
    window.setTimeout(() => markAiGenerating(selectedIds), 450);
    window.setTimeout(() => markAiDone(selectedIds), 1500);
    onNotice(`已提交 ${selectedIds.length} 个 AI 加工任务到 ${providerLabel(aiProvider)}。`);
  }

  function markAiGenerating(targetIds: string[]) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) =>
        targetIds.includes(clip.id)
          ? {
              ...clip,
              aiJobs: clip.aiJobs.map((job, index) =>
                index === 0 ? { ...job, status: "generating", startedAt: now } : job
              ),
              updatedAt: now
            }
          : clip
      )
    );
  }

  function markAiDone(targetIds: string[]) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => {
        if (!targetIds.includes(clip.id) || !clip.aiJobs[0]) return clip;
        const job = { ...clip.aiJobs[0], status: "done" as const, outputVideoUrl: clip.preprocess?.depthVideoUrl || clip.originalVideoUrl, finishedAt: now };
        const parentOutput = getBestParentOutputForAi(clip);
        return {
          ...clip,
          aiJobs: [job, ...clip.aiJobs.slice(1)],
          outputs: upsertOutput(clip.outputs, {
            id: createId("output"),
            sourceClipId: clip.id,
            lineageId: clip.lineageId,
            parentOutputId: parentOutput?.id,
            type: "ai_video",
            provider: job.provider,
            videoUrl: job.outputVideoUrl || clip.originalVideoUrl,
            jobId: job.id,
            createdAt: now
          }),
          updatedAt: now
        };
      })
    );
    onNotice("AI 加工任务已完成，已写入成本、耗时和生成产物。");
  }

  function updateRecipeStep(stepId: string, patch: Partial<ComposeRecipeStep>) {
    onRecipe((items) => items.map((item) => (item.id === stepId ? { ...item, ...patch } : item)));
    onComposePlan([]);
  }

  function assembleByTags() {
    try {
      const plan = buildComposePlan(clips, recipe);
      onComposePlan(plan);
      onClips((current) =>
        current.map((clip) =>
          plan.some((item) => item.clipId === clip.id) ? { ...clip, usageCount: clip.usageCount + 1 } : clip
        )
      );
      onNotice(`已按标签规则组装 ${plan.length} 个片段。`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "按标签拼接失败。");
    }
  }

  return (
    <section className="depth-workbench">
      <div className="depth-stats">
        <StatCard label="素材片段" value={clips.length} />
        <StatCard label="图片素材" value={images.length} />
        <StatCard label="已深度化" value={stats.depthDone} />
        <StatCard label="AI产物" value={stats.aiDone} />
        <StatCard label="累计积分" value={stats.credits} />
        <StatCard label="累计成本" value={`¥${stats.cash.toFixed(2)}`} />
      </div>

      <nav className="depth-tabs" aria-label="深度视频工作台步骤">
        {workbenchTabs.map((tab, index) => (
          <button
            className={`depth-tab ${activeTab === tab.key ? "active" : ""}`}
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
          >
            <span>{index + 1}</span>
            <strong>{tab.title}</strong>
            <small>{tab.subtitle}</small>
          </button>
        ))}
      </nav>

      {activeTab === "library" && (
        <section className="panel depth-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Material Library</p>
              <h2>{libraryMode === "video" ? "视频素材片段库" : "图片素材库"}</h2>
            </div>
            {libraryMode === "video" ? (
              <div className="prompt-actions">
                <button className="secondary-button compact" onClick={importSegments}>
                  <Layers3 size={15} />
                  导入脚本分段
                </button>
                <label className="secondary-button compact">
                  <Upload size={15} />
                  上传片段
                  <input type="file" accept="video/*" multiple onChange={(event) => importFiles(event.target.files)} />
                </label>
              </div>
            ) : (
              <label className="secondary-button compact">
                <Upload size={15} />
                上传图片
                <input type="file" accept="image/*" multiple onChange={(event) => importImageFiles(event.target.files)} />
              </label>
            )}
          </div>

          <div className="library-mode-tabs">
            <button className={libraryMode === "video" ? "active" : ""} onClick={() => setLibraryMode("video")}>
              <Film size={15} />
              视频素材
            </button>
            <button className={libraryMode === "image" ? "active" : ""} onClick={() => setLibraryMode("image")}>
              <ImageIcon size={15} />
              图片素材
            </button>
          </div>

          {libraryMode === "video" ? (
            <>
              <div className="depth-toolbar">
                <button className="secondary-button compact" onClick={selectAll} disabled={!clips.length}>
                  <Check size={15} />
                  {selectedIds.length === clips.length && clips.length ? "取消全选" : "全选"}
                </button>
                {tagOptions.filter((item) => item.type !== "custom").map((item) => (
                  <button className="secondary-button compact" key={item.type} onClick={() => applyQuickVideoTag(item.type, item.label)}>
                    <Tag size={15} />
                    {item.label}
                  </button>
                ))}
                <select value={tagType} onChange={(event) => setTagType(event.target.value as MaterialTagType)}>
                  {tagOptions.map((item) => (
                    <option value={item.type} key={item.type}>{item.label}</option>
                  ))}
                </select>
                {tagType === "custom" && (
                  <input value={customTag} onChange={(event) => setCustomTag(event.target.value)} placeholder="自定义标签" />
                )}
                <button className="secondary-button compact" onClick={applyTag}>
                  <Tag size={15} />
                  应用标签
                </button>
                <button className="secondary-button compact" onClick={applyVideoTagTemplate}>
                  <Sparkles size={15} />
                  套用模板
                </button>
                <button className="secondary-button compact" onClick={clearSelectedVideoTags}>
                  <Trash2 size={15} />
                  清除标签
                </button>
                <button className="secondary-button compact" onClick={() => runDepthPreprocess(selectedIds)} disabled={!selectedIds.length}>
                  <RefreshCw size={15} />
                  深度化所选
                </button>
                <button className="primary-button compact" onClick={() => runDepthPreprocess(depthProcessableIds)} disabled={!depthProcessableIds.length}>
                  <RefreshCw size={15} />
                  全库深度化
                </button>
              </div>

              <ClipGrid
                clips={clips}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                onAddTag={addClipTag}
                onRemoveTag={removeClipTag}
                onDelete={deleteClip}
                onDescription={updateClipDescription}
              />
            </>
          ) : (
            <>
              <div className="image-library-tabs">
                {imageCategoryOptions.map((item) => (
                  <button
                    className={imageCategory === item.value ? "active" : ""}
                    key={item.value}
                    onClick={() => {
                      setImageCategory(item.value);
                      setImageTagType(item.defaultTag);
                    }}
                  >
                    {item.label}
                    <span>{images.filter((image) => image.category === item.value).length}</span>
                  </button>
                ))}
              </div>

              <div className="depth-toolbar">
                <button className="secondary-button compact" onClick={selectAllImages} disabled={!images.some((image) => image.category === imageCategory)}>
                  <Check size={15} />
                  全选当前库
                </button>
                {imageTagOptions.filter((item) => item.type !== "custom").map((item) => (
                  <button className="secondary-button compact" key={item.type} onClick={() => addTagsToImages(selectedImageIds, item.type, item.label)}>
                    <Tag size={15} />
                    {item.label}
                  </button>
                ))}
                <select value={imageTagType} onChange={(event) => setImageTagType(event.target.value as MaterialTagType)}>
                  {imageTagOptions.map((item) => (
                    <option value={item.type} key={item.type}>{item.label}</option>
                  ))}
                </select>
                {imageTagType === "custom" && (
                  <input value={customImageTag} onChange={(event) => setCustomImageTag(event.target.value)} placeholder="自定义图片标签" />
                )}
                <button className="secondary-button compact" onClick={applyImageTag}>
                  <Tag size={15} />
                  应用标签
                </button>
                <button className="secondary-button compact" onClick={clearSelectedImageTags}>
                  <Trash2 size={15} />
                  清除标签
                </button>
              </div>

              <ImageGrid
                images={images.filter((image) => image.category === imageCategory)}
                selectedIds={selectedImageIds}
                onToggleSelected={toggleSelectedImage}
                onAddTag={addImageTag}
                onRemoveTag={removeImageTag}
                onDelete={deleteImage}
                onDescription={updateImageDescription}
              />
            </>
          )}
        </section>
      )}

      {activeTab === "preprocess" && (
        <section className="panel depth-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Preprocess</p>
              <h2>深度视频前置处理</h2>
            </div>
            <button className="secondary-button compact" onClick={() => setActiveTab("library")}>返回素材库</button>
          </div>
          <div className="depth-quality-panel">
            <div className="quality-preset-row">
              {Object.entries(depthQualityDefaults).map(([key, item]) => (
                <button
                  className={depthQualityPreset === key ? "active" : ""}
                  key={key}
                  onClick={() => applyDepthQualityPreset(key as DepthQualityPreset)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="quality-control-grid">
              <label>
                <span>输入尺寸</span>
                <input
                  type="number"
                  min={518}
                  step={14}
                  value={depthInputSize}
                  onChange={(event) => {
                    setDepthQualityPreset("standard");
                    setDepthInputSize(Number(event.target.value) || 518);
                  }}
                />
                <small>模型推理方形输入边长。当前默认模型支持 518；728 需更换同尺寸 ONNX。</small>
              </label>
              <label>
                <span>边缘滤波强度</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={depthEdgeFilterStrength}
                  onChange={(event) => {
                    setDepthQualityPreset("standard");
                    setDepthEdgeFilterStrength(Number(event.target.value) || 0);
                  }}
                />
                <small>范围 0-1，默认 0.35。越高越贴合边缘，但可能抹平细节。</small>
              </label>
              <label>
                <span>滤波直径</span>
                <input
                  type="number"
                  min={1}
                  max={21}
                  step={2}
                  value={depthEdgeFilterDiameter}
                  onChange={(event) => {
                    setDepthQualityPreset("standard");
                    setDepthEdgeFilterDiameter(Number(event.target.value) || 7);
                  }}
                />
                <small>范围 1-21，建议奇数，默认 7。越大影响范围越广、速度越慢。</small>
              </label>
              <label className="quality-toggle-card">
                <span>比例保护</span>
                <div className="quality-toggle">
                  <input type="checkbox" checked={depthLetterbox} onChange={(event) => setDepthLetterbox(event.target.checked)} />
                  <strong>Letterbox</strong>
                </div>
                <small>默认开启。保留竖屏比例并补边，避免人像被拉伸。</small>
              </label>
            </div>
            <div className="quality-help-grid">
              <div>
                <strong>快速</strong>
                <small>518 输入，不做比例保护和边缘滤波，适合批量预览。</small>
              </div>
              <div>
                <strong>标准</strong>
                <small>默认值：518 + Letterbox + 0.35 滤波，适合当前竖屏素材。</small>
              </div>
              <div>
                <strong>人像边缘</strong>
                <small>518 + Letterbox + 0.55 滤波，优先改善人物和发丝边界。</small>
              </div>
            </div>
          </div>
          <div className="depth-action-card">
            <div>
              <strong>已选择 {selectedClips.length} 个素材</strong>
              <small>
                排队 {depthMonitor.queued} · 处理中 {depthMonitor.processing} · 已完成 {depthMonitor.done} · 失败 {depthMonitor.failed}
              </small>
            </div>
            <div className="prompt-actions">
              <button className="secondary-button compact" onClick={selectAll} disabled={!clips.length}>
                <Check size={15} />
                {selectedIds.length === clips.length && clips.length ? "取消全选" : "选择全部"}
              </button>
              <button className="secondary-button compact" onClick={() => runDepthPreprocess(depthUnfinishedIds)} disabled={!depthUnfinishedIds.length}>
                <RefreshCw size={15} />
                处理全部未完成
              </button>
              <button className="primary-button compact" onClick={() => runDepthPreprocess(selectedIds)} disabled={!selectedIds.length}>
                <RefreshCw size={15} />
                处理所选
              </button>
            </div>
          </div>
          <div className="depth-monitor-grid" aria-label="深度视频处理状态监控">
            <StatCard label="排队中" value={depthMonitor.queued} />
            <StatCard label="处理中" value={depthMonitor.processing} />
            <StatCard label="失败" value={depthMonitor.failed} />
            <StatCard label="累计耗时" value={`${depthMonitor.elapsedSec}s`} />
          </div>
          <div className="depth-table preprocess-table">
            {clips.map((clip) => (
              <div className={`depth-table-row preprocess-row ${selectedIds.includes(clip.id) ? "selected" : ""}`} key={clip.id}>
                <label className="row-check">
                  <input type="checkbox" checked={selectedIds.includes(clip.id)} onChange={() => toggleSelected(clip.id)} />
                  <span>{clip.title}</span>
                </label>
                <span className={`depth-status-badge ${clip.preprocess?.status || "idle"}`}>
                  {depthStatusLabel(clip.preprocess?.status)}
                </span>
                <div className="depth-live-meta">
                  <small>{depthMetaText(clip)}</small>
                  {clip.preprocess?.status === "processing" && (
                    <div className="depth-live-bar"><span /></div>
                  )}
                  {clip.preprocess?.error && <em>{clip.preprocess.error}</em>}
                </div>
                <div className="depth-row-actions">
                  {clip.preprocess?.depthVideoUrl && (
                    <a className="secondary-button compact" href={clip.preprocess.depthVideoUrl} target="_blank" rel="noreferrer">
                      查看深度视频
                    </a>
                  )}
                  <button className="secondary-button compact" onClick={() => runDepthPreprocess([clip.id])} disabled={isDepthBusy(clip)}>
                    <RefreshCw size={15} />
                    {clip.preprocess?.status === "done" ? "重新处理" : "处理"}
                  </button>
                </div>
              </div>
            ))}
            {!clips.length && <p className="muted-note">素材片段库为空，请先导入素材。</p>}
          </div>
        </section>
      )}

      {activeTab === "ai" && (
        <section className="panel depth-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">AI Processing</p>
              <h2>视频AI加工</h2>
            </div>
            <button className="secondary-button compact" onClick={() => setActiveTab("preprocess")}>返回前置处理</button>
          </div>
          <div className="depth-two-column">
            <div>
              <div className="control-grid single-column">
                <label>
                  <span>加工方式</span>
                  <select value={aiProvider} onChange={(event) => setAiProvider(event.target.value as DepthAiProvider)}>
                    {providerOptions.map((item) => (
                      <option value={item.value} key={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>加工提示词</span>
                  <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
                </label>
              </div>
              <button className="primary-button" onClick={runAiGeneration}>
                <Wand2 size={16} />
                提交AI加工
              </button>
            </div>
            <div className="depth-table">
              {clips.map((clip) => (
                <div className="depth-table-row" key={clip.id}>
                  <strong>{clip.title}</strong>
                  <span>{clip.aiJobs[0] ? aiStatusLabel(clip.aiJobs[0].status) : "未AI加工"}</span>
                  <small>{clip.aiJobs[0] ? `${providerLabel(clip.aiJobs[0].provider)} · ${clip.aiJobs[0].cost.generationSec}s · ¥${clip.aiJobs[0].cost.estimatedCash.toFixed(2)}` : "可选择后提交加工"}</small>
                </div>
              ))}
              {!clips.length && <p className="muted-note">素材片段库为空，请先导入素材。</p>}
            </div>
          </div>
        </section>
      )}

      {activeTab === "cost" && (
        <section className="panel depth-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Cost</p>
              <h2>成本与产物追踪</h2>
            </div>
            <button className="secondary-button compact" onClick={() => setActiveTab("ai")}>返回AI加工</button>
          </div>
          <div className="cost-list">
            {clips.flatMap((clip) => clip.aiJobs.map((job) => ({ clip, job }))).map(({ clip, job }) => (
              <div className="cost-row" key={job.id}>
                <span>{clip.title}</span>
                <strong>{providerLabel(job.provider)}</strong>
                <small><Coins size={13} /> {job.cost.creditsUsed ?? 0} 分 · <Clock3 size={13} /> {job.cost.generationSec}s · ¥{job.cost.estimatedCash.toFixed(2)} · lineage {clip.lineageId}</small>
              </div>
            ))}
            {!clips.some((clip) => clip.aiJobs.length) && <p className="muted-note">暂无AI加工成本。</p>}
          </div>
        </section>
      )}

      {activeTab === "compose" && (
        <section className="panel depth-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Compose</p>
              <h2>标签化拼接</h2>
            </div>
            <div className="prompt-actions">
              <button className="secondary-button compact" onClick={onBack}>返回生成页</button>
              <button className="secondary-button compact" onClick={onNext}>去导出页</button>
            </div>
          </div>
          <div className="depth-two-column">
            <div>
              <div className="recipe-list">
                {recipe.map((step) => (
                  <div className="recipe-row" key={step.id}>
                    <select value={step.tagType} onChange={(event) => updateRecipeStep(step.id, { tagType: event.target.value as MaterialTagType, label: tagOptions.find((item) => item.type === event.target.value)?.label ?? step.label })}>
                      {tagOptions.map((item) => (
                        <option value={item.type} key={item.type}>{item.label}</option>
                      ))}
                    </select>
                    <input type="number" min={1} max={6} value={step.count} onChange={(event) => updateRecipeStep(step.id, { count: Number(event.target.value) })} />
                    <select value={step.selectionPolicy} onChange={(event) => updateRecipeStep(step.id, { selectionPolicy: event.target.value as ComposeRecipeStep["selectionPolicy"] })}>
                      <option value="least_used">少使用优先</option>
                      <option value="lowest_cost">低成本优先</option>
                      <option value="manual">手动优先</option>
                    </select>
                  </div>
                ))}
                <button className="secondary-button compact" onClick={() => onRecipe((items) => [...items, { id: createId("recipe"), tagType: "custom", label: "自定义", count: 1, selectionPolicy: "least_used" }])}>
                  <Plus size={15} />
                  添加规则
                </button>
              </div>
              <button className="primary-button" onClick={assembleByTags}>按标签规则拼接</button>
            </div>
            <div className="compose-plan">
              {composePlan.map((item) => (
                <div className="compose-plan-row" key={item.id}>
                  <strong>{item.order + 1}. {item.title}</strong>
                  <span>{item.tagLabel} · ¥{item.cost.toFixed(2)} · lineage {item.lineageId}</span>
                </div>
              ))}
              {!composePlan.length && <p className="muted-note">暂无拼接计划，请先按标签规则拼接。</p>}
            </div>
          </div>
        </section>
      )}
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="depth-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ClipGrid({
  clips,
  selectedIds,
  onToggleSelected,
  onAddTag,
  onRemoveTag,
  onDelete,
  onDescription
}: {
  clips: MaterialClip[];
  selectedIds: string[];
  onToggleSelected: (id: string) => void;
  onAddTag: (id: string, type: MaterialTagType, label: string) => void;
  onRemoveTag: (id: string, tagId: string) => void;
  onDelete: (id: string) => void;
  onDescription: (id: string, description: string) => void;
}) {
  const [previewByClipId, setPreviewByClipId] = useState<Record<string, MaterialOutput["type"]>>({});
  const [tagDrafts, setTagDrafts] = useState<Record<string, { type: MaterialTagType; custom: string }>>({});

  if (!clips.length) {
    return (
      <div className="empty-state compact-empty">
        <Film size={38} />
        <strong>还没有素材片段</strong>
        <span>导入脚本分段或上传已经切分好的视频片段。</span>
      </div>
    );
  }

  return (
    <div className="clip-grid">
      {clips.map((clip) => (
        <article className={`clip-card ${selectedIds.includes(clip.id) ? "selected" : ""}`} key={clip.id}>
          <div className="asset-card-actions">
            <button className="clip-select" onClick={() => onToggleSelected(clip.id)}>
              {selectedIds.includes(clip.id) ? "已选" : "选择"}
            </button>
            <button className="clip-delete" onClick={() => onDelete(clip.id)} title="删除素材">
              <Trash2 size={16} />
            </button>
          </div>
          {selectedClipVideoUrl(clip, previewByClipId[clip.id]) ? (
            <video src={selectedClipVideoUrl(clip, previewByClipId[clip.id])} controls muted playsInline />
          ) : (
            <div className="clip-placeholder"><Film size={28} /></div>
          )}
          <div className="clip-body">
            <strong>{clip.title}</strong>
            <small>ID {clip.id} · lineage {clip.lineageId}</small>
            <div className="asset-preview-switcher">
              {clip.originalVideoUrl && (
                <button
                  className={currentPreviewType(clip, previewByClipId[clip.id]) === "original" ? "active" : ""}
                  onClick={() => setPreviewByClipId((items) => ({ ...items, [clip.id]: "original" }))}
                >
                  原视频
                </button>
              )}
              {clip.outputs.some((item) => item.type === "depth_video") && (
                <button
                  className={currentPreviewType(clip, previewByClipId[clip.id]) === "depth_video" ? "active" : ""}
                  onClick={() => setPreviewByClipId((items) => ({ ...items, [clip.id]: "depth_video" }))}
                >
                  深度视频
                </button>
              )}
              {clip.outputs.some((item) => item.type === "ai_video") && (
                <button
                  className={currentPreviewType(clip, previewByClipId[clip.id]) === "ai_video" ? "active" : ""}
                  onClick={() => setPreviewByClipId((items) => ({ ...items, [clip.id]: "ai_video" }))}
                >
                  AI产物
                </button>
              )}
            </div>
            {currentPreviewType(clip, previewByClipId[clip.id]) === "depth_video" && isPlaceholderDepthOutput(clip) && (
              <div className="asset-preview-note">
                当前深度视频为占位预览，文件仍是原视频。接入真实深度处理后这里会播放新的深度视频产物。
              </div>
            )}
            <LineageOutputs outputs={clip.outputs} />
            <div className="tag-list">
              {clip.tags.length ? clip.tags.map((item) => (
                <button className={`tag-pill removable ${item.type}`} key={item.id} onClick={() => onRemoveTag(clip.id, item.id)}>
                  {item.label}
                  <span>×</span>
                </button>
              )) : <span className="tag-pill muted">未打标签</span>}
            </div>
            <div className="clip-status-row">
              <span>{depthStatusLabel(clip.preprocess?.status)}</span>
              <span>{clip.aiJobs[0] ? aiStatusLabel(clip.aiJobs[0].status) : "未AI加工"}</span>
            </div>
            <InlineTagEditor
              options={tagOptions}
              draft={tagDrafts[clip.id] || { type: "hook", custom: "" }}
              onDraft={(draft) => setTagDrafts((items) => ({ ...items, [clip.id]: draft }))}
              onAdd={(type, label) => onAddTag(clip.id, type, label)}
            />
            <label className="description-field">
              <span>Description</span>
              <textarea
                value={clip.description || ""}
                onChange={(event) => onDescription(clip.id, event.target.value)}
                placeholder="给 LLM 使用的素材描述，例如画面内容、产品状态、人脸动作、可用场景。"
              />
            </label>
          </div>
        </article>
      ))}
    </div>
  );
}

function ImageGrid({
  images,
  selectedIds,
  onToggleSelected,
  onAddTag,
  onRemoveTag,
  onDelete,
  onDescription
}: {
  images: ImageMaterial[];
  selectedIds: string[];
  onToggleSelected: (id: string) => void;
  onAddTag: (id: string, type: MaterialTagType, label: string) => void;
  onRemoveTag: (id: string, tagId: string) => void;
  onDelete: (id: string) => void;
  onDescription: (id: string, description: string) => void;
}) {
  const [tagDrafts, setTagDrafts] = useState<Record<string, { type: MaterialTagType; custom: string }>>({});

  if (!images.length) {
    return (
      <div className="empty-state compact-empty">
        <ImageIcon size={38} />
        <strong>当前图片库为空</strong>
        <span>上传图片后会自动写入产品、人脸或其他图片默认标签。</span>
      </div>
    );
  }

  return (
    <div className="image-grid">
      {images.map((image) => (
        <article className={`image-card ${selectedIds.includes(image.id) ? "selected" : ""}`} key={image.id}>
          <div className="asset-card-actions">
            <button className="clip-select" onClick={() => onToggleSelected(image.id)}>
              {selectedIds.includes(image.id) ? "已选" : "选择"}
            </button>
            <button className="clip-delete" onClick={() => onDelete(image.id)} title="删除素材">
              <Trash2 size={16} />
            </button>
          </div>
          <img src={image.imageUrl} alt={image.title} />
          <div className="clip-body">
            <strong>{image.title}</strong>
            <small>ID {image.id} · lineage {image.lineageId}</small>
            <div className="tag-list">
              {image.tags.map((item) => (
                <button className={`tag-pill removable ${item.type}`} key={item.id} onClick={() => onRemoveTag(image.id, item.id)}>
                  {item.label}
                  <span>×</span>
                </button>
              ))}
            </div>
            <InlineTagEditor
              options={imageTagOptions}
              draft={tagDrafts[image.id] || { type: image.category === "product" ? "product" : image.category === "face" ? "face" : "other_image", custom: "" }}
              onDraft={(draft) => setTagDrafts((items) => ({ ...items, [image.id]: draft }))}
              onAdd={(type, label) => onAddTag(image.id, type, label)}
            />
            <label className="description-field">
              <span>Description</span>
              <textarea
                value={image.description || ""}
                onChange={(event) => onDescription(image.id, event.target.value)}
                placeholder="给 LLM 使用的图片描述，例如产品角度、人脸表情、光线、用途。"
              />
            </label>
          </div>
        </article>
      ))}
    </div>
  );
}

function InlineTagEditor({
  options,
  draft,
  onDraft,
  onAdd
}: {
  options: Array<{ type: MaterialTagType; label: string }>;
  draft: { type: MaterialTagType; custom: string };
  onDraft: (draft: { type: MaterialTagType; custom: string }) => void;
  onAdd: (type: MaterialTagType, label: string) => void;
}) {
  const selectedLabel = options.find((item) => item.type === draft.type)?.label ?? "自定义";
  const label = draft.type === "custom" ? draft.custom.trim() : selectedLabel;

  return (
    <div className="inline-tag-editor">
      <select value={draft.type} onChange={(event) => onDraft({ ...draft, type: event.target.value as MaterialTagType })}>
        {options.map((item) => (
          <option value={item.type} key={item.type}>{item.label}</option>
        ))}
      </select>
      <input
        value={draft.custom}
        onChange={(event) => onDraft({ ...draft, custom: event.target.value })}
        placeholder={draft.type === "custom" ? "输入标签内容" : "可输入自定义标签"}
        onFocus={() => {
          if (draft.type !== "custom") onDraft({ ...draft, type: "custom" });
        }}
      />
      <button
        className="secondary-button compact"
        disabled={!label}
        onClick={() => {
          onAdd(draft.type, label);
          if (draft.type === "custom") onDraft({ ...draft, custom: "" });
        }}
      >
        <Tag size={14} />
        添加
      </button>
    </div>
  );
}

function LineageOutputs({ outputs }: { outputs: MaterialOutput[] }) {
  if (!outputs.length) return null;
  return (
    <div className="lineage-output-list">
      {outputs.map((output) => (
        <div className="lineage-output-row" key={output.id}>
          <span>{outputTypeLabel(output.type)}</span>
          <small>{output.id}{output.parentOutputId ? ` ← ${output.parentOutputId}` : " · root"}</small>
        </div>
      ))}
    </div>
  );
}

function createClipFromSegment(segment: VideoSegment, videoUrl: string, now: string, sourceFile?: File): MaterialClip {
  const tag = roleToTag(segment.bucketRole || segment.role);
  const id = createId("clip");
  const lineageId = createId("lineage");
  const originalOutputId = createId("output");
  return {
    id,
    lineageId,
    sourceSegmentId: segment.id,
    title: segment.title,
    description: segment.scriptText || segment.generationPrompt || "",
    duration: segment.duration,
    originalVideoUrl: videoUrl,
    sourceFile,
    tags: tag ? [{ ...tag, id: createId("tag"), source: "import", createdAt: now }] : [],
    customTags: [],
    aiJobs: [],
    outputs: videoUrl ? [{ id: originalOutputId, sourceClipId: id, lineageId, type: "original", provider: "import", videoUrl, createdAt: now }] : [],
    usageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

function createClipFromFile(file: File, now: string): MaterialClip {
  const id = createId("clip");
  const lineageId = createId("lineage");
  const originalOutputId = createId("output");
  const videoUrl = URL.createObjectURL(file);
  return {
    id,
    lineageId,
    title: file.name.replace(/\.[^.]+$/, ""),
    description: "",
    duration: 0,
    originalVideoUrl: videoUrl,
    sourceFileName: file.name,
    sourceFile: file,
    tags: [],
    customTags: [],
    aiJobs: [],
    outputs: [{ id: originalOutputId, sourceClipId: id, lineageId, type: "original", provider: "upload", videoUrl, createdAt: now }],
    usageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

function createImageMaterial(file: File, category: ImageLibraryCategory, now: string): ImageMaterial {
  const id = createId("image");
  const lineageId = createId("lineage");
  const imageUrl = URL.createObjectURL(file);
  return {
    id,
    lineageId,
    title: file.name.replace(/\.[^.]+$/, ""),
    description: "",
    imageUrl,
    sourceFileName: file.name,
    category,
    tags: [createDefaultImageTag(category, now)],
    customTags: [],
    usageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

function selectedClipVideoUrl(clip: MaterialClip, preferredType?: MaterialOutput["type"]) {
  const type = currentPreviewType(clip, preferredType);
  if (type === "original") return clip.originalVideoUrl;
  return clip.outputs.find((item) => item.type === type)?.videoUrl || clip.originalVideoUrl;
}

function currentPreviewType(clip: MaterialClip, preferredType?: MaterialOutput["type"]): MaterialOutput["type"] {
  if (preferredType === "depth_video" && clip.outputs.some((item) => item.type === "depth_video")) return "depth_video";
  if (preferredType === "ai_video" && clip.outputs.some((item) => item.type === "ai_video")) return "ai_video";
  if (preferredType === "original") return "original";
  if (clip.outputs.some((item) => item.type === "depth_video")) return "depth_video";
  if (clip.outputs.some((item) => item.type === "ai_video")) return "ai_video";
  return "original";
}

function isPlaceholderDepthOutput(clip: MaterialClip) {
  const depthOutput = clip.outputs.find((item) => item.type === "depth_video");
  return Boolean(depthOutput && depthOutput.videoUrl === clip.originalVideoUrl);
}

function createDefaultImageTag(category: ImageLibraryCategory, now: string): MaterialTag {
  const meta = imageCategoryOptions.find((item) => item.value === category) ?? imageCategoryOptions[2];
  return {
    id: createId("tag"),
    type: meta.defaultTag,
    label: meta.defaultTag === "product" ? "产品" : meta.defaultTag === "face" ? "人脸" : "其他图片",
    source: "import",
    createdAt: now
  };
}

function getOriginalOutput(clip: MaterialClip) {
  return clip.outputs.find((item) => item.type === "original");
}

function getBestParentOutputForAi(clip: MaterialClip) {
  return clip.outputs.find((item) => item.type === "depth_video") || getOriginalOutput(clip);
}

function outputTypeLabel(type: MaterialOutput["type"]) {
  const labels: Record<MaterialOutput["type"], string> = {
    original: "原视频",
    depth_video: "深度视频",
    ai_video: "AI产物"
  };
  return labels[type];
}

function imageCategoryLabel(category: ImageLibraryCategory) {
  return imageCategoryOptions.find((item) => item.value === category)?.label ?? category;
}

function roleToTag(role: string): Omit<MaterialTag, "id" | "source" | "createdAt"> | null {
  if (role.includes("hook") || role.includes("钩子")) return { type: "hook", label: "钩子" };
  if (role.includes("usp") || role.includes("塑品") || role.includes("卖点")) return { type: "product_shaping", label: "塑品" };
  if (role.includes("pain") || role.includes("购买")) return { type: "purchase_reason", label: "购买理由" };
  if (role.includes("cta") || role.includes("促成") || role.includes("转化")) return { type: "conversion", label: "促成交" };
  return null;
}

function hasTag(clip: MaterialClip, type: MaterialTagType, label: string) {
  return clip.tags.some((tag) => tag.type === type && tag.label === label);
}

function hasImageTag(image: ImageMaterial, type: MaterialTagType, label: string) {
  return image.tags.some((tag) => tag.type === type && tag.label === label);
}

function unique(items: string[]) {
  return Array.from(new Set(items));
}

function upsertOutput(outputs: MaterialClip["outputs"], output: MaterialClip["outputs"][number]) {
  return [...outputs.filter((item) => item.type !== output.type || item.provider !== output.provider), output];
}

function createAiJob(clip: MaterialClip, provider: DepthAiProvider, prompt: string, now: string) {
  const cost = estimateProviderCost(provider);
  return {
    id: createId("aijob"),
    sourceClipId: clip.id,
    lineageId: clip.lineageId,
    inputAssetType: clip.preprocess?.status === "done" ? "depth_video" as const : "original" as const,
    inputVideoUrl: clip.preprocess?.depthVideoUrl || clip.originalVideoUrl,
    provider,
    status: "queued" as const,
    prompt,
    remoteTaskId: createId("remote"),
    cost,
    createdAt: now
  };
}

function estimateProviderCost(provider: DepthAiProvider): AiGenerationCost {
  const table: Record<DepthAiProvider, AiGenerationCost> = {
    seedance_api: { creditsUsed: 18, queueWaitSec: 8, generationSec: 42, estimatedCash: 3.6 },
    jimeng_web: { creditsUsed: 12, queueWaitSec: 15, generationSec: 55, captureSec: 12, manualSec: 20, estimatedCash: 2.4 },
    comfyui_remote_gpu: { gpuSec: 75, queueWaitSec: 5, generationSec: 75, estimatedCash: 1.8 },
    kling_web: { creditsUsed: 20, queueWaitSec: 20, generationSec: 70, captureSec: 10, manualSec: 20, estimatedCash: 4 },
    gemini_web: { creditsUsed: 6, queueWaitSec: 6, generationSec: 35, captureSec: 8, manualSec: 15, estimatedCash: 1.2 }
  };
  return table[provider];
}

function buildStats(clips: MaterialClip[]) {
  return clips.reduce(
    (stats, clip) => {
      stats.depthDone += clip.preprocess?.status === "done" ? 1 : 0;
      stats.aiDone += clip.aiJobs.filter((job) => job.status === "done").length;
      stats.credits += clip.aiJobs.reduce((total, job) => total + (job.cost.creditsUsed ?? 0), 0);
      stats.cash += clip.aiJobs.reduce((total, job) => total + job.cost.estimatedCash, 0);
      return stats;
    },
    { depthDone: 0, aiDone: 0, credits: 0, cash: 0 }
  );
}

function buildDepthMonitor(clips: MaterialClip[]) {
  return clips.reduce(
    (stats, clip) => {
      const status = clip.preprocess?.status;
      if (status === "queued") stats.queued += 1;
      if (status === "processing") stats.processing += 1;
      if (status === "done") stats.done += 1;
      if (status === "failed") stats.failed += 1;
      stats.elapsedSec += clip.preprocess?.cost.elapsedSec ?? 0;
      return stats;
    },
    { queued: 0, processing: 0, done: 0, failed: 0, elapsedSec: 0 }
  );
}

function isDepthBusy(clip: MaterialClip) {
  return clip.preprocess?.status === "queued" || clip.preprocess?.status === "processing";
}

function elapsedSince(isoDate: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000));
}

function elapsedBetween(startIso: string, endIso: string) {
  return Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
}

function depthMetaText(clip: MaterialClip) {
  const record = clip.preprocess;
  if (!record) return "等待处理，可单独选择或批量处理";
  const quality = `${record.params.inputSize ?? 518}px · ${record.params.letterbox === false ? "拉伸" : "Letterbox"} · 滤波 ${record.params.edgeFilterStrength ?? 0}`;
  const cost = `${quality} · 耗时 ${record.cost.elapsedSec}s · 估算 ¥${(record.cost.estimatedCash ?? 0).toFixed(2)}`;
  if (record.status === "queued") return `${record.params.depthModel} · 已进入队列`;
  if (record.status === "processing") return `${record.params.depthModel} · 正在生成 · ${cost}`;
  if (record.status === "done") return `${record.params.depthModel} · ${cost}`;
  return `${record.params.depthModel} · 处理失败 · ${cost}`;
}

function buildComposePlan(clips: MaterialClip[], recipe: ComposeRecipeStep[]): DepthComposePlanItem[] {
  const used = new Set<string>();
  const plan: DepthComposePlanItem[] = [];
  recipe.forEach((step) => {
    const candidates = clips
      .filter((clip) => !used.has(clip.id) && clip.tags.some((tag) => tag.type === step.tagType) && getBestVideoUrl(clip))
      .sort((a, b) => {
        if (step.selectionPolicy === "lowest_cost") return clipCost(a) - clipCost(b);
        return a.usageCount - b.usageCount;
      })
      .slice(0, step.count);
    if (candidates.length < step.count) {
      throw new Error(`标签「${step.label}」可用素材不足，需要 ${step.count} 个，当前 ${candidates.length} 个。`);
    }
    candidates.forEach((clip) => {
      used.add(clip.id);
      plan.push({
        id: createId("compose_clip"),
        order: plan.length,
        stepId: step.id,
        clipId: clip.id,
        lineageId: clip.lineageId,
        title: clip.title,
        tagLabel: step.label,
        videoUrl: getBestVideoUrl(clip),
        cost: clipCost(clip)
      });
    });
  });
  return plan;
}

function getBestVideoUrl(clip: MaterialClip) {
  return clip.outputs.find((item) => item.type === "ai_video")?.videoUrl
    || clip.outputs.find((item) => item.type === "depth_video")?.videoUrl
    || clip.originalVideoUrl;
}

function clipCost(clip: MaterialClip) {
  const aiCost = clip.aiJobs.reduce((total, job) => total + job.cost.estimatedCash, 0);
  return aiCost + (clip.preprocess?.cost.estimatedCash ?? 0);
}

function providerLabel(provider: DepthAiProvider) {
  return providerOptions.find((item) => item.value === provider)?.label ?? provider;
}

function depthStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    queued: "深度排队中",
    processing: "深度处理中",
    done: "已深度化",
    failed: "深度失败"
  };
  return status ? labels[status] ?? status : "未深度化";
}

function aiStatusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: "AI排队中",
    uploading: "上传中",
    generating: "AI生成中",
    capturing: "抓取中",
    done: "AI完成",
    failed: "AI失败"
  };
  return labels[status] ?? status;
}
