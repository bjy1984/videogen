import { Check, Clock3, Coins, Film, Image as ImageIcon, Layers3, Plus, RefreshCw, Sparkles, Tag, Trash2, Upload, Wand2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { VideoSegment } from "../../types";
import { createId } from "../../services/id";
import {
  createSeedanceBridgeTask,
  getSeedanceBridgeTask,
  loadWorkbenchLibraryState,
  preprocessDepthVideoBridge,
  preprocessGrayscaleVideoBridge,
  saveWorkbenchLibraryState,
  syncSeedanceBridgeAsset,
  uploadVideoGenerationBridgeAsset
} from "../../services/videoGenerationBridgeClient";
import {
  SEEDANCE_MODEL_PRICING,
  buildSeedanceCreateTaskRequest,
  extractSeedanceTaskError,
  mapSeedanceTaskStatus
} from "../generation/providers/seedanceArk";
import type { SeedanceProviderConfig } from "../generation/providers/providerConfig";
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
  MaterialTagType,
  VideoAiJob
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

interface AiPromptTemplate {
  id: string;
  name: string;
  content: string;
  builtin?: boolean;
}

const AI_PROMPT_TEMPLATE_STORAGE_KEY = "videogen.aiPromptTemplates";
const defaultAiPromptTemplates: AiPromptTemplate[] = [
  {
    id: "tpl_replace_product_keep_audio",
    name: "更换产品，保留声音",
    content: "全面参考【@视频1】视频《{videoName}》{imageInstruction}，保留视频声音。",
    builtin: true
  },
  {
    id: "tpl_product_only",
    name: "只换产品信息",
    content: "参考【@视频1】视频《{videoName}》的镜头、动作和声音{productInstruction}。",
    builtin: true
  },
  {
    id: "tpl_face_product",
    name: "产品与人脸参考",
    content: "全面参考【@视频1】视频《{videoName}》{productInstruction}{faceInstruction}，保留视频声音。",
    builtin: true
  }
];

type DepthWorkbenchTab = "library" | "preprocess" | "ai" | "cost" | "compose";
type MaterialLibraryMode = "video" | "image";
type DepthQualityPreset = "fast" | "standard" | "portrait";
type VideoPreprocessMethod = "depth" | "grayscale";

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
  { key: "preprocess", title: "前置处理", subtitle: "深度 / 黑白" },
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
  sourceVideoLocalPath,
  sourceVideoName,
  projectId,
  bridgeUrl,
  seedanceSettings,
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
  sourceVideoLocalPath?: string;
  sourceVideoName?: string;
  projectId: string;
  bridgeUrl: string;
  seedanceSettings: SeedanceProviderConfig;
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
  const [aiReferenceClipId, setAiReferenceClipId] = useState("");
  const [aiReferenceOutputType, setAiReferenceOutputType] = useState<MaterialOutput["type"]>("original");
  const [aiPromptTemplates, setAiPromptTemplates] = useState<AiPromptTemplate[]>(loadSavedAiPromptTemplates);
  const [activePromptTemplateId, setActivePromptTemplateId] = useState(defaultAiPromptTemplates[0].id);
  const [promptTemplateDraft, setPromptTemplateDraft] = useState(defaultAiPromptTemplates[0].content);
  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<DepthWorkbenchTab>("library");
  const [preprocessMethod, setPreprocessMethod] = useState<VideoPreprocessMethod>("depth");
  const [depthQualityPreset, setDepthQualityPreset] = useState<DepthQualityPreset>("standard");
  const [depthInputSize, setDepthInputSize] = useState(518);
  const [depthLetterbox, setDepthLetterbox] = useState(true);
  const [depthEdgeFilterStrength, setDepthEdgeFilterStrength] = useState(0.35);
  const [depthEdgeFilterDiameter, setDepthEdgeFilterDiameter] = useState(7);
  const libraryHydratedRef = useRef(false);
  const lastSavedLibraryRef = useRef("");

  const selectedClips = clips.filter((clip) => selectedIds.includes(clip.id));
  const aiReferenceClip = useMemo(() => clips.find((clip) => clip.id === aiReferenceClipId), [aiReferenceClipId, clips]);
  const aiReferenceImages = useMemo(
    () => selectedImageIds.map((id) => images.find((image) => image.id === id)).filter((image): image is ImageMaterial => Boolean(image)),
    [images, selectedImageIds]
  );
  const stats = useMemo(() => buildStats(clips), [clips]);
  const depthMonitor = useMemo(() => buildDepthMonitor(clips), [clips]);
  const depthProcessableIds = useMemo(
    () => clips.filter((clip) => !isDepthBusy(clip)).map((clip) => clip.id),
    [clips]
  );
  const depthUnfinishedIds = useMemo(
    () => clips.filter((clip) => !isPreprocessDoneForMethod(clip, preprocessMethod) && !isDepthBusy(clip)).map((clip) => clip.id),
    [clips, preprocessMethod]
  );

  useEffect(() => {
    if (aiReferenceClipId && clips.some((clip) => clip.id === aiReferenceClipId)) return;
    setAiReferenceClipId(clips[0]?.id || "");
  }, [aiReferenceClipId, clips]);

  useEffect(() => {
    const template = aiPromptTemplates.find((item) => item.id === activePromptTemplateId) || aiPromptTemplates[0] || defaultAiPromptTemplates[0];
    setPromptTemplateDraft(template.content);
  }, [activePromptTemplateId, aiPromptTemplates]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AI_PROMPT_TEMPLATE_STORAGE_KEY, JSON.stringify(aiPromptTemplates.filter((item) => !item.builtin)));
    } catch {
      // Template persistence is a convenience layer; generation should remain usable without it.
    }
  }, [aiPromptTemplates]);

  useEffect(() => {
    if (promptDirty) return;
    setPrompt(renderAiPrompt(promptTemplateDraft, aiReferenceClip, aiReferenceImages));
  }, [aiReferenceClip, aiReferenceImages, promptDirty, promptTemplateDraft]);

  useEffect(() => {
    let cancelled = false;
    libraryHydratedRef.current = false;
    lastSavedLibraryRef.current = "";
    loadWorkbenchLibraryState({ bridgeUrl, projectId })
      .then(({ state }) => {
        if (cancelled) return;
        const storedClips = Array.isArray(state.clips) ? state.clips : [];
        const storedImages = Array.isArray(state.images) ? state.images : [];
        if (storedClips.length || storedImages.length) {
          onClips(storedClips);
          onImages(storedImages);
          lastSavedLibraryRef.current = stableLibrarySnapshot(storedClips, storedImages);
          onNotice(`已从 MongoDB 素材库恢复 ${storedClips.length} 个视频、${storedImages.length} 张图片。`);
        } else if (clips.length || images.length) {
          lastSavedLibraryRef.current = stableLibrarySnapshot(clips, images);
      void saveWorkbenchLibraryState({
            bridgeUrl,
            projectId,
            clips: serializeLibraryClips(clips),
            images: serializeLibraryImages(images)
          });
        } else {
          lastSavedLibraryRef.current = stableLibrarySnapshot([], []);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          onNotice(error instanceof Error ? `MongoDB 素材库加载失败：${error.message}` : "MongoDB 素材库加载失败。");
        }
      })
      .finally(() => {
        if (!cancelled) libraryHydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [bridgeUrl, projectId]);

  useEffect(() => {
    if (!libraryHydratedRef.current) return;
    const snapshot = stableLibrarySnapshot(clips, images);
    if (snapshot === lastSavedLibraryRef.current) return;
    const timer = window.setTimeout(() => {
      const serializedClips = serializeLibraryClips(clips);
      const serializedImages = serializeLibraryImages(images);
      saveWorkbenchLibraryState({
        bridgeUrl,
        projectId,
        clips: serializedClips,
        images: serializedImages
      })
        .then(() => {
          lastSavedLibraryRef.current = stableLibrarySnapshot(serializedClips, serializedImages);
        })
        .catch((error) => {
          onNotice(error instanceof Error ? `MongoDB 素材库保存失败：${error.message}` : "MongoDB 素材库保存失败。");
        });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [bridgeUrl, clips, images, onNotice, projectId]);

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
        .map((segment) => createClipFromSegment(segment, sourcePreviewUrl || segment.videoUrl || "", now, sourceVideo, sourceVideoLocalPath, sourceVideoName));
      return [...current, ...nextClips];
    });
    onNotice("已把脚本分段写入深度视频素材片段库，并生成全流程 lineageId。");
  }

  async function importFiles(files?: FileList | null) {
    if (!files?.length) return;
    const now = new Date().toISOString();
    const videoFiles = Array.from(files).filter((file) => file.type.startsWith("video/"));
    const nextClips = await Promise.all(videoFiles.map((file) => createClipFromFile(file, now, projectId, bridgeUrl)));
    if (!nextClips.length) {
      onNotice("请选择视频文件。");
      return;
    }
    onClips((current) => [...current, ...nextClips]);
    onNotice(`已导入 ${nextClips.length} 个已切分视频片段。`);
  }

  async function importImageFiles(files?: FileList | null) {
    if (!files?.length) return;
    const now = new Date().toISOString();
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    const nextImages = await Promise.all(imageFiles.map((file) => createImageMaterial(file, imageCategory, now, projectId, bridgeUrl)));
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

  async function runDepthPreprocess(targetIds = selectedIds, method: VideoPreprocessMethod = preprocessMethod) {
    const nextTargetIds = unique(targetIds).filter((id) => clips.some((clip) => clip.id === id && !isDepthBusy(clip)));
    if (!nextTargetIds.length) {
      onNotice(targetIds.length ? "所选素材正在处理中，请等待当前任务完成后再重新处理。" : "请先选择要前置处理的素材。");
      return;
    }
    const now = new Date().toISOString();
    const methodLabel = preprocessMethodLabel(method);
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
            method,
            inputVideoUrl: clip.originalVideoUrl,
            provider: "local-bridge",
            params: {
              resolution: "1080p",
              fps: 24,
              depthModel: method === "depth" ? "depth-anything-dnn" : "opencv-grayscale",
              inputSize: method === "depth" ? depthInputSize : undefined,
              letterbox: method === "depth" ? depthLetterbox : undefined,
              edgeFilterStrength: method === "depth" ? depthEdgeFilterStrength : undefined,
              edgeFilterDiameter: method === "depth" ? depthEdgeFilterDiameter : undefined
            },
            cost: { elapsedSec: 0, gpuSec: 0 },
            createdAt: now,
            startedAt: undefined,
            finishedAt: undefined,
            updatedAt: now
          },
          updatedAt: now
        };
      })
    );
    onNotice(`已提交 ${nextTargetIds.length} 个${methodLabel}前置处理任务。`);
    for (const clipId of nextTargetIds) {
      const clip = clips.find((item) => item.id === clipId);
      if (!clip) continue;
      markDepthProcessing(clipId);
      const video = clip.sourceFile instanceof File
        ? clip.sourceFile
        : clip.sourceSegmentId && sourceVideo instanceof File
          ? sourceVideo
          : undefined;
      const sourceLocalPath = clip.sourceLocalPath || (clip.sourceSegmentId ? sourceVideoLocalPath : undefined);
      const sourceVideoUrl = sourceLocalPath || video ? undefined : persistentVideoUrl(clip);
      if (!video && !sourceLocalPath && !sourceVideoUrl) {
        markDepthFailed(clipId, "该素材缺少可用的视频文件或本地资产链接，请重新上传素材后再执行前置处理。");
        continue;
      }
      try {
        const result = method === "depth"
          ? await preprocessDepthVideoBridge({
              bridgeUrl,
              projectId,
              clipId: clip.id,
              video,
              sourceLocalPath,
              sourceVideoUrl,
              sourceVideoName: clip.sourceFileName || clip.title,
              model: "depth-anything-dnn",
              resolution: "1080p",
              fps: 24,
              colorMode: "grayscale",
              invert: false,
              inputSize: depthInputSize,
              letterbox: depthLetterbox,
              edgeFilterStrength: depthEdgeFilterStrength,
              edgeFilterDiameter: depthEdgeFilterDiameter
            })
          : await preprocessGrayscaleVideoBridge({
              bridgeUrl,
              projectId,
              clipId: clip.id,
              video,
              sourceLocalPath,
              sourceVideoUrl,
              sourceVideoName: clip.sourceFileName || clip.title,
              resolution: "1080p",
              fps: 24
            });
        markPreprocessDone(clipId, method, result.trace);
      } catch (error) {
        markDepthFailed(clipId, error instanceof Error ? error.message : `${methodLabel}生成失败。`);
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

  function markPreprocessDone(
    clipId: string,
    method: VideoPreprocessMethod,
    trace: Awaited<ReturnType<typeof preprocessDepthVideoBridge>>["trace"] | Awaited<ReturnType<typeof preprocessGrayscaleVideoBridge>>["trace"]
  ) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => {
        if (clip.id !== clipId || !clip.preprocess) return clip;
        const summary = trace.summary as {
          elapsedSec?: number;
          fps?: number;
          model?: string;
          inputSize?: number;
          letterbox?: boolean;
          edgeFilter?: { strength?: number; diameter?: number };
        } | undefined;
        const elapsedSec = summary?.elapsedSec ?? 0;
        const outputVideoUrl = trace.outputVideoUrl;
        const parentOutput = getOriginalOutput(clip);
        return {
          ...clip,
          preprocess: {
            ...clip.preprocess,
            status: "done",
            method,
            outputVideoUrl,
            depthVideoUrl: method === "depth" ? outputVideoUrl : clip.preprocess.depthVideoUrl,
            provider: "local-bridge",
            params: {
              resolution: "1080p",
              fps: summary?.fps ?? 24,
              depthModel: method === "depth" ? summary?.model || "depth-anything-dnn" : "opencv-grayscale",
              inputSize: method === "depth" ? summary?.inputSize ?? clip.preprocess.params.inputSize : undefined,
              letterbox: method === "depth" ? summary?.letterbox ?? clip.preprocess.params.letterbox : undefined,
              edgeFilterStrength: method === "depth" ? summary?.edgeFilter?.strength ?? clip.preprocess.params.edgeFilterStrength : undefined,
              edgeFilterDiameter: method === "depth" ? summary?.edgeFilter?.diameter ?? clip.preprocess.params.edgeFilterDiameter : undefined
            },
            cost: { elapsedSec, gpuSec: elapsedSec },
            finishedAt: now,
            updatedAt: now
          },
          outputs: upsertOutput(clip.outputs, {
            id: createId("output"),
            sourceClipId: clip.id,
            lineageId: clip.lineageId,
            parentOutputId: parentOutput?.id,
            type: method === "depth" ? "depth_video" : "grayscale_video",
            provider: "local-bridge",
            videoUrl: outputVideoUrl,
            createdAt: now
          }),
          updatedAt: now
        };
      })
    );
    onNotice(`${preprocessMethodLabel(method)}生成完成，已写入真实产物。`);
  }

  function selectAiReferenceClip(clipId: string) {
    setAiReferenceClipId(clipId);
    setSelectedIds([clipId]);
  }

  function regenerateAiPrompt() {
    setPrompt(renderAiPrompt(promptTemplateDraft, aiReferenceClip, aiReferenceImages));
    setPromptDirty(false);
  }

  function saveCurrentPromptTemplate() {
    const content = promptTemplateDraft.trim();
    if (!content) {
      onNotice("模板内容不能为空。");
      return;
    }
    const name = window.prompt("模板名称", "自定义模板");
    if (!name?.trim()) return;
    const template: AiPromptTemplate = {
      id: createId("prompt_tpl"),
      name: name.trim(),
      content,
      builtin: false
    };
    setAiPromptTemplates((items) => [...items, template]);
    setActivePromptTemplateId(template.id);
    onNotice(`已保存提示词模板「${template.name}」。`);
  }

  function deleteCurrentPromptTemplate() {
    const template = aiPromptTemplates.find((item) => item.id === activePromptTemplateId);
    if (!template || template.builtin) {
      onNotice("内置模板不能删除，可以修改后另存为新模板。");
      return;
    }
    if (!window.confirm(`确认删除提示词模板「${template.name}」？`)) return;
    setAiPromptTemplates((items) => items.filter((item) => item.id !== template.id));
    setActivePromptTemplateId(defaultAiPromptTemplates[0].id);
    onNotice(`已删除提示词模板「${template.name}」。`);
  }

  async function runAiGeneration() {
    if (!aiReferenceClip) {
      onNotice("请先选择一条参考视频。");
      return;
    }
    const finalPrompt = prompt.trim();
    if (!finalPrompt) {
      onNotice("请先生成或填写提示词。");
      return;
    }
    const now = new Date().toISOString();
    const job = createAiJob(aiReferenceClip, aiProvider, finalPrompt, now, aiReferenceImages, aiReferenceOutputType, seedanceSettings);
    onClips((current) =>
      current.map((clip) => {
        if (clip.id !== aiReferenceClip.id) return clip;
        return { ...clip, aiJobs: [job, ...clip.aiJobs], updatedAt: now };
      })
    );
    if (aiProvider !== "seedance_api") {
      window.setTimeout(() => markAiGenerating([aiReferenceClip.id]), 450);
      window.setTimeout(() => markAiDone([aiReferenceClip.id]), 1500);
      onNotice(`已提交「${aiReferenceClip.title}」到 ${providerLabel(aiProvider)}，参考图片 ${aiReferenceImages.length} 张。`);
      return;
    }
    try {
      markAiGenerating([aiReferenceClip.id]);
      const task = await submitSeedanceAiJob(aiReferenceClip, job, finalPrompt);
      updateAiJob(aiReferenceClip.id, job.id, {
        remoteTaskId: task.id,
        status: mapSeedanceTaskStatus(task.status) === "done" ? "done" : "generating",
        outputVideoUrl: task.content?.video_url,
        error: extractSeedanceTaskError(task)
      });
      onNotice(`Seedance 任务已提交：${task.id || "等待返回任务ID"}。可稍后刷新任务状态。`);
      if (task.id) {
        window.setTimeout(() => void refreshSeedanceAiJob(aiReferenceClip.id, job.id, task.id), 8000);
      }
    } catch (error) {
      updateAiJob(aiReferenceClip.id, job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Seedance 任务提交失败。"
      });
      onNotice(error instanceof Error ? error.message : "Seedance 任务提交失败。");
    }
  }

  async function submitSeedanceAiJob(clip: MaterialClip, job: VideoAiJob, finalPrompt: string) {
    const sourceVideoUrl = persistentAiVideoUrl(clip, aiReferenceOutputType);
    if (!sourceVideoUrl) {
      throw new Error("Seedance 需要可访问的参考视频 URL。请先上传素材到本地素材库，并配置可被后台访问的 VIDEOGEN_PUBLIC_ASSET_BASE_URL。");
    }
    const imageUrls = aiReferenceImages.map((image) => image.imageUrl).filter((url) => url && !url.startsWith("blob:"));
    const request = buildSeedanceCreateTaskRequest({
      prompt: withSeedanceMediaRefs(finalPrompt, imageUrls.length, Boolean(sourceVideoUrl)),
      aspectRatio: "9:16",
      duration: 5,
      sourceVideoUrl,
      referenceImageUrls: imageUrls,
      params: {
        bridgeUrl,
        endpoint: seedanceSettings.endpoint,
        apiKeyEnvName: seedanceSettings.apiKeyEnvName,
        model: seedanceSettings.model,
        defaultDuration: seedanceSettings.defaultDuration,
        resolution: seedanceSettings.resolution,
        seed: seedanceSettings.seed,
        generateAudio: seedanceSettings.generateAudio,
        watermark: seedanceSettings.watermark,
        returnLastFrame: seedanceSettings.returnLastFrame
      }
    });
    const task = await createSeedanceBridgeTask({ bridgeUrl, request });
    return { ...task, localJobId: job.id };
  }

  async function refreshSeedanceAiJob(clipId: string, jobId: string, taskId: string) {
    try {
      const task = await getSeedanceBridgeTask({
        bridgeUrl,
        endpoint: seedanceSettings.endpoint,
        apiKeyEnvName: seedanceSettings.apiKeyEnvName,
        taskId
      });
      const status = mapSeedanceTaskStatus(task.status);
      if (status !== "done") {
        updateAiJob(clipId, jobId, {
          status: status === "failed" ? "failed" : "generating",
          remoteStatus: task.status,
          progress: task.progress ?? 0,
          error: extractSeedanceTaskError(task)
        });
        if (status !== "failed") {
          window.setTimeout(() => void refreshSeedanceAiJob(clipId, jobId, taskId), 8000);
        }
        return;
      }
      const synced = await syncSeedanceBridgeAsset({
        bridgeUrl,
        endpoint: seedanceSettings.endpoint,
        apiKeyEnvName: seedanceSettings.apiKeyEnvName,
        taskId,
        projectId,
        assetId: jobId,
        sourceUrl: task.content?.video_url
      });
      markAiDoneWithOutput(clipId, jobId, synced.asset.localAssetUrl);
    } catch (error) {
      updateAiJob(clipId, jobId, {
        status: "failed",
        error: error instanceof Error ? error.message : "Seedance 任务刷新失败。"
      });
    }
  }

  function updateAiJob(clipId: string, jobId: string, patch: Partial<VideoAiJob>) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              aiJobs: clip.aiJobs.map((job) => {
                if (job.id !== jobId) return job;
                const updated = { ...job, ...patch };
                const end = updated.finishedAt || now;
                updated.elapsedSec = elapsedBetween(job.createdAt, end);
                if (updated.status === "done" || updated.status === "failed") {
                  updated.finishedAt = updated.finishedAt || end;
                  updated.cost = {
                    ...updated.cost,
                    generationSec: updated.elapsedSec
                  };
                }
                return updated;
              }),
              updatedAt: now
            }
          : clip
      )
    );
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
        const elapsedSec = elapsedBetween(clip.aiJobs[0].createdAt, now);
        const job = {
          ...clip.aiJobs[0],
          status: "done" as const,
          outputVideoUrl: clip.preprocess?.depthVideoUrl || clip.originalVideoUrl,
          finishedAt: now,
          elapsedSec,
          cost: {
            ...clip.aiJobs[0].cost,
            generationSec: elapsedSec
          }
        };
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
    onNotice("AI 加工任务已完成，已写入成本、耗时 and 生成产物。");
  }

  function markAiDoneWithOutput(clipId: string, jobId: string, outputVideoUrl: string) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => {
        if (clip.id !== clipId) return clip;
        const currentJob = clip.aiJobs.find((job) => job.id === jobId);
        if (!currentJob) return clip;
        const elapsedSec = elapsedBetween(currentJob.createdAt, now);
        const job = {
          ...currentJob,
          status: "done" as const,
          remoteStatus: "completed",
          progress: 100,
          outputVideoUrl,
          finishedAt: now,
          elapsedSec,
          cost: {
            ...currentJob.cost,
            generationSec: elapsedSec
          }
        };
        const parentOutput = getBestParentOutputForAi(clip);
        return {
          ...clip,
          aiJobs: clip.aiJobs.map((item) => (item.id === jobId ? job : item)),
          outputs: upsertOutput(clip.outputs, {
            id: createId("output"),
            sourceClipId: clip.id,
            lineageId: clip.lineageId,
            parentOutputId: parentOutput?.id,
            type: "ai_video",
            provider: job.provider,
            videoUrl: outputVideoUrl,
            jobId: job.id,
            createdAt: now
          }),
          updatedAt: now
        };
      })
    );
    onNotice("Seedance 任务完成，产物已转存并写入素材库。");
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
        <StatCard label="已前处理" value={stats.depthDone} />
        <StatCard label="AI产物" value={stats.aiDone} />
        <StatCard label="累计积分" value={stats.credits} />
        <StatCard label="AI成本" value={`¥${stats.cash.toFixed(2)}`} />
      </div>

      <nav className="depth-tabs" aria-label="视频生成工作台步骤">
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
              <h2>视频前置处理</h2>
            </div>
            <button className="secondary-button compact" onClick={() => setActiveTab("library")}>返回素材库</button>
          </div>
          <div className="preprocess-method-row">
            <button className={preprocessMethod === "depth" ? "active" : ""} onClick={() => setPreprocessMethod("depth")}>
              <Film size={16} />
              <span>
                <strong>深度视频</strong>
                <small>OpenCV DNN + Depth Anything，输出深度图视频。</small>
              </span>
            </button>
            <button className={preprocessMethod === "grayscale" ? "active" : ""} onClick={() => setPreprocessMethod("grayscale")}>
              <Film size={16} />
              <span>
                <strong>黑白视频</strong>
                <small>OpenCV 灰度转换，输出保留音频的黑白视频。</small>
              </span>
            </button>
          </div>
          {preprocessMethod === "depth" && <div className="depth-quality-panel">
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
          </div>}
          {preprocessMethod === "grayscale" && (
            <div className="depth-quality-panel">
              <div className="quality-help-grid">
                <div>
                  <strong>处理算法</strong>
                  <small>逐帧使用 OpenCV `cv2.cvtColor(frame, COLOR_BGR2GRAY)` 转灰度，再转回 BGR 写入 MP4。</small>
                </div>
                <div>
                  <strong>输出规格</strong>
                  <small>默认 1080p 高度、24fps，保持 9:16 画面比例；音频通过 ffmpeg 合并回产物。</small>
                </div>
                <div>
                  <strong>使用场景</strong>
                  <small>适合做黑白风格素材、后续 AI 风格化输入，处理速度显著快于深度视频。</small>
                </div>
              </div>
            </div>
          )}
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
                  {(clip.preprocess?.outputVideoUrl || clip.preprocess?.depthVideoUrl) && (
                    <a className="secondary-button compact" href={clip.preprocess.outputVideoUrl || clip.preprocess.depthVideoUrl} target="_blank" rel="noreferrer">
                      查看{preprocessMethodLabel(clip.preprocess.method || "depth")}
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
          <div className="ai-workbench-grid">
            <section className="ai-config-panel">
              <div className="ai-panel-title">
                <span>1</span>
                <div>
                  <strong>参考视频</strong>
                  <small>单选一条视频作为完整参考</small>
                </div>
              </div>
              <div className="ai-video-list">
                {clips.map((clip) => (
                  <button
                    className={`ai-video-option ${aiReferenceClipId === clip.id ? "active" : ""}`}
                    key={clip.id}
                    onClick={() => selectAiReferenceClip(clip.id)}
                  >
                    <span className="radio-dot" />
                    <strong>{clip.title}</strong>
                    <small>{clip.tags.map((tag) => tag.label).join(" / ") || "未打标签"}</small>
                  </button>
                ))}
                {!clips.length && <p className="muted-note">素材片段库为空，请先导入或上传参考视频。</p>}
              </div>
              {aiReferenceClip && (
                <div className="ai-reference-preview">
                  <video src={selectedClipVideoUrl(aiReferenceClip, aiReferenceOutputType)} controls muted playsInline />
                  <label>
                    <span>使用版本</span>
                    <select value={aiReferenceOutputType} onChange={(event) => setAiReferenceOutputType(event.target.value as MaterialOutput["type"])}>
                      {availableVideoOutputTypes(aiReferenceClip).map((type) => (
                        <option value={type} key={type}>{outputTypeLabel(type)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </section>

            <section className="ai-config-panel">
              <div className="ai-panel-title">
                <span>2</span>
                <div>
                  <strong>参考图片</strong>
                  <small>可多选，图片名会写入提示词</small>
                </div>
              </div>
              <div className="image-library-tabs compact-tabs">
                {imageCategoryOptions.map((item) => (
                  <button
                    className={imageCategory === item.value ? "active" : ""}
                    key={item.value}
                    onClick={() => setImageCategory(item.value)}
                  >
                    {item.label}
                    <span>{images.filter((image) => image.category === item.value).length}</span>
                  </button>
                ))}
              </div>
              <div className="ai-selected-images">
                {aiReferenceImages.length ? aiReferenceImages.map((image) => (
                  <button key={image.id} onClick={() => toggleSelectedImage(image.id)} title="移除参考图片">
                    <img src={image.imageUrl} alt={image.title} />
                    <span>{image.title}</span>
                  </button>
                )) : <small>还没有选择参考图片。</small>}
              </div>
              <div className="ai-image-list">
                {images.filter((image) => image.category === imageCategory).map((image) => (
                  <button
                    className={`ai-image-option ${selectedImageIds.includes(image.id) ? "active" : ""}`}
                    key={image.id}
                    onClick={() => toggleSelectedImage(image.id)}
                  >
                    <img src={image.imageUrl} alt={image.title} />
                    <span>{image.title}</span>
                  </button>
                ))}
                {!images.some((image) => image.category === imageCategory) && <p className="muted-note">当前图片库为空，请先上传图片素材。</p>}
              </div>
            </section>

            <section className="ai-config-panel ai-prompt-panel">
              <div className="ai-panel-title">
                <span>3</span>
                <div>
                  <strong>提示词与生成</strong>
                  <small>模板可多选保存，最终提示词可编辑</small>
                </div>
              </div>
              <div className="control-grid single-column">
                <label>
                  <span>提示词模板</span>
                  <select value={activePromptTemplateId} onChange={(event) => setActivePromptTemplateId(event.target.value)}>
                    {aiPromptTemplates.map((item) => (
                      <option value={item.id} key={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>模板内容</span>
                  <textarea
                    value={promptTemplateDraft}
                    onChange={(event) => setPromptTemplateDraft(event.target.value)}
                    placeholder="例如：全面参考【@视频1】视频《{videoName}》{imageInstruction}，保留视频声音。"
                  />
                </label>
              </div>
              <div className="prompt-actions wrap-actions">
                <button className="secondary-button compact" onClick={regenerateAiPrompt}>
                  <RefreshCw size={15} />
                  重新生成提示词
                </button>
                <button className="secondary-button compact" onClick={saveCurrentPromptTemplate}>
                  <Plus size={15} />
                  保存为模板
                </button>
                <button className="secondary-button compact" onClick={deleteCurrentPromptTemplate}>
                  <Trash2 size={15} />
                  删除模板
                </button>
              </div>
              <div className="ai-source-summary">
                <strong>参考来源</strong>
                <span>视频：{aiReferenceClip?.title || "未选择"}</span>
                <span>图片：{aiReferenceImages.map((image) => image.title).join("、") || "未选择"}</span>
              </div>
              <label className="ai-final-prompt">
                <span>生成后的提示词</span>
                <textarea
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setPromptDirty(true);
                  }}
                />
              </label>
              <label className="ai-provider-select">
                <span>加工方式</span>
                <select value={aiProvider} onChange={(event) => setAiProvider(event.target.value as DepthAiProvider)}>
                  {providerOptions.map((item) => (
                    <option value={item.value} key={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
              <button className="primary-button" onClick={runAiGeneration} disabled={!aiReferenceClip}>
                <Wand2 size={16} />
                提交AI加工
              </button>
            </section>
          </div>

          <section className="ai-job-panel">
            <div className="ai-panel-title">
              <span>4</span>
              <div>
                <strong>最近任务</strong>
                <small>查看当前素材库里的 AI 加工状态</small>
              </div>
            </div>
            <div className="depth-table ai-job-table">
              {clips.map((clip) => (
                <div className="depth-table-row" key={clip.id}>
                  <strong>{clip.title}</strong>
                  <span title={clip.aiJobs[0]?.error || undefined}>
                    {clip.aiJobs[0] ? renderAiJobStatus(clip.aiJobs[0]) : "未AI加工"}
                  </span>
                  <small>{clip.aiJobs[0] ? `${providerLabel(clip.aiJobs[0].provider)} · ${clip.aiJobs[0].cost.generationSec}s · ¥${clip.aiJobs[0].cost.estimatedCash.toFixed(2)}` : "选择为参考视频后提交加工"}</small>
                </div>
              ))}
              {!clips.length && <p className="muted-note">素材片段库为空，请先导入素材。</p>}
            </div>
          </section>
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
              {clip.outputs.some((item) => item.type === "grayscale_video") && (
                <button
                  className={currentPreviewType(clip, previewByClipId[clip.id]) === "grayscale_video" ? "active" : ""}
                  onClick={() => setPreviewByClipId((items) => ({ ...items, [clip.id]: "grayscale_video" }))}
                >
                  黑白视频
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
              <span title={clip.aiJobs[0]?.error || undefined}>
                {clip.aiJobs[0] ? renderAiJobStatus(clip.aiJobs[0]) : "未AI加工"}
              </span>
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

function createClipFromSegment(
  segment: VideoSegment,
  videoUrl: string,
  now: string,
  sourceFile?: File,
  sourceLocalPath?: string,
  sourceFileName?: string
): MaterialClip {
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
    sourceFileName,
    sourceLocalPath,
    tags: tag ? [{ ...tag, id: createId("tag"), source: "import", createdAt: now }] : [],
    customTags: [],
    aiJobs: [],
    outputs: videoUrl ? [{ id: originalOutputId, sourceClipId: id, lineageId, type: "original", provider: "import", videoUrl, createdAt: now }] : [],
    usageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

async function createClipFromFile(file: File, now: string, projectId: string, bridgeUrl: string): Promise<MaterialClip> {
  const id = createId("clip");
  const lineageId = createId("lineage");
  const originalOutputId = createId("output");
  const uploaded = await uploadWorkbenchAsset(file, "video", projectId, id, bridgeUrl);
  const videoUrl = uploaded?.localAssetUrl || URL.createObjectURL(file);
  return {
    id,
    lineageId,
    title: file.name.replace(/\.[^.]+$/, ""),
    description: "",
    duration: 0,
    originalVideoUrl: videoUrl,
    sourceFileName: file.name,
    sourceLocalPath: uploaded?.localPath,
    sourceMimeType: file.type,
    sourceSize: file.size,
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

async function createImageMaterial(file: File, category: ImageLibraryCategory, now: string, projectId: string, bridgeUrl: string): Promise<ImageMaterial> {
  const id = createId("image");
  const lineageId = createId("lineage");
  const uploaded = await uploadWorkbenchAsset(file, "image", projectId, id, bridgeUrl);
  const imageUrl = uploaded?.localAssetUrl || URL.createObjectURL(file);
  return {
    id,
    lineageId,
    title: file.name.replace(/\.[^.]+$/, ""),
    description: "",
    imageUrl,
    sourceFileName: file.name,
    sourceLocalPath: uploaded?.localPath,
    sourceMimeType: file.type,
    sourceSize: file.size,
    category,
    tags: [createDefaultImageTag(category, now)],
    customTags: [],
    usageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

async function uploadWorkbenchAsset(file: File, kind: "video" | "image", projectId: string, segmentId: string, bridgeUrl: string) {
  try {
    const result = await uploadVideoGenerationBridgeAsset({
      bridgeUrl,
      projectId,
      segmentId,
      kind: `video_workbench_${kind}`,
      file
    });
    return result.asset;
  } catch {
    return undefined;
  }
}

function selectedClipVideoUrl(clip: MaterialClip, preferredType?: MaterialOutput["type"]) {
  const type = currentPreviewType(clip, preferredType);
  if (type === "original") return clip.originalVideoUrl;
  return clip.outputs.find((item) => item.type === type)?.videoUrl || clip.originalVideoUrl;
}

function availableVideoOutputTypes(clip: MaterialClip): MaterialOutput["type"][] {
  const types: MaterialOutput["type"][] = ["original"];
  for (const type of ["depth_video", "grayscale_video", "ai_video"] as MaterialOutput["type"][]) {
    if (clip.outputs.some((item) => item.type === type)) types.push(type);
  }
  return types;
}

function currentPreviewType(clip: MaterialClip, preferredType?: MaterialOutput["type"]): MaterialOutput["type"] {
  if (preferredType === "depth_video" && clip.outputs.some((item) => item.type === "depth_video")) return "depth_video";
  if (preferredType === "grayscale_video" && clip.outputs.some((item) => item.type === "grayscale_video")) return "grayscale_video";
  if (preferredType === "ai_video" && clip.outputs.some((item) => item.type === "ai_video")) return "ai_video";
  if (preferredType === "original") return "original";
  if (clip.outputs.some((item) => item.type === "depth_video")) return "depth_video";
  if (clip.outputs.some((item) => item.type === "grayscale_video")) return "grayscale_video";
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

function persistentVideoUrl(clip: MaterialClip) {
  const originalUrl = getOriginalOutput(clip)?.videoUrl || clip.originalVideoUrl;
  if (!originalUrl || originalUrl.startsWith("blob:")) return undefined;
  return originalUrl;
}

function persistentAiVideoUrl(clip: MaterialClip, preferredType: MaterialOutput["type"]) {
  const videoUrl = selectedClipVideoUrl(clip, preferredType);
  if (!videoUrl || videoUrl.startsWith("blob:")) return undefined;
  return videoUrl;
}

function getBestParentOutputForAi(clip: MaterialClip) {
  return clip.outputs.find((item) => item.type === "depth_video")
    || clip.outputs.find((item) => item.type === "grayscale_video")
    || getOriginalOutput(clip);
}

function outputTypeLabel(type: MaterialOutput["type"]) {
  const labels: Record<MaterialOutput["type"], string> = {
    original: "原视频",
    depth_video: "深度视频",
    grayscale_video: "黑白视频",
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

function loadSavedAiPromptTemplates(): AiPromptTemplate[] {
  try {
    const raw = window.localStorage.getItem(AI_PROMPT_TEMPLATE_STORAGE_KEY);
    const customTemplates = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(customTemplates)) return defaultAiPromptTemplates;
    return [
      ...defaultAiPromptTemplates,
      ...customTemplates
        .filter((item) => item && typeof item.name === "string" && typeof item.content === "string")
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : createId("prompt_tpl"),
          name: item.name,
          content: item.content,
          builtin: false
        }))
    ];
  } catch {
    return defaultAiPromptTemplates;
  }
}

function renderAiPrompt(template: string, clip?: MaterialClip, images: ImageMaterial[] = []) {
  const videoName = clip?.title || "未选择参考视频";
  const imageNames = formatPromptNames(images.map((image) => image.title));
  const productImages = formatPromptNames(images.filter((image) => image.category === "product").map((image) => image.title));
  const faceImages = formatPromptNames(images.filter((image) => image.category === "face").map((image) => image.title));
  const styleImages = formatPromptNames(images.filter((image) => image.category === "other").map((image) => image.title));
  const imageRefs = formatSeedanceImageRefs(images);
  const productImageRefs = formatSeedanceImageRefs(images.filter((image) => image.category === "product"), images);
  const faceImageRefs = formatSeedanceImageRefs(images.filter((image) => image.category === "face"), images);
  const styleImageRefs = formatSeedanceImageRefs(images.filter((image) => image.category === "other"), images);
  const imageInstruction = images.length ? `，根据${imageRefs}更换产品信息为${imageNames}` : "";
  const productInstruction = productImageRefs
    ? `，根据${productImageRefs}将产品信息替换为${productImages}`
    : imageRefs
      ? `，根据${imageRefs}将产品信息替换为${imageNames}`
      : "";
  const faceInstruction = faceImageRefs ? `，人物或人脸参考${faceImageRefs}${faceImages}` : "";
  const styleInstruction = styleImageRefs ? `，风格参考${styleImageRefs}${styleImages}` : "";
  const videoTags = clip?.tags.map((tag) => tag.label).join("、") || "无";
  const imageTags = unique(images.flatMap((image) => image.tags.map((tag) => tag.label))).join("、") || "无";
  return [
    ["{videoName}", videoName],
    ["{imageNames}", imageNames || "未选择参考图片"],
    ["{productImages}", productImages || imageNames || "未选择产品图片"],
    ["{faceImages}", faceImages || "未选择人脸图片"],
    ["{styleImages}", styleImages || "未选择风格图片"],
    ["{imageRefs}", imageRefs || "参考图片"],
    ["{productImageRefs}", productImageRefs || imageRefs || "产品参考图片"],
    ["{faceImageRefs}", faceImageRefs || "人脸参考图片"],
    ["{styleImageRefs}", styleImageRefs || "风格参考图片"],
    ["{imageInstruction}", imageInstruction],
    ["{productInstruction}", productInstruction],
    ["{faceInstruction}", faceInstruction],
    ["{styleInstruction}", styleInstruction],
    ["{videoTags}", videoTags],
    ["{imageTags}", imageTags]
  ].reduce((text, [token, value]) => text.split(token).join(value), template);
}

function formatPromptNames(names: string[]) {
  return names.filter(Boolean).map((name) => `《${name}》`).join("");
}

function formatSeedanceImageRefs(targetImages: ImageMaterial[], allImages = targetImages) {
  return targetImages
    .map((image) => {
      const index = allImages.findIndex((item) => item.id === image.id);
      return index >= 0 ? `【@图片${index + 1}】` : "";
    })
    .filter(Boolean)
    .join("");
}

function withSeedanceMediaRefs(prompt: string, imageCount: number, hasVideo: boolean) {
  let nextPrompt = prompt.trim();
  if (hasVideo && !nextPrompt.includes("【@视频1】")) {
    nextPrompt = `参考【@视频1】视频，${nextPrompt}`;
  }
  const missingImageRefs = Array.from({ length: imageCount }, (_, index) => `【@图片${index + 1}】`)
    .filter((ref) => !nextPrompt.includes(ref));
  if (missingImageRefs.length) {
    nextPrompt = `${missingImageRefs.join("")}作为产品/人物/风格参考，${nextPrompt}`;
  }
  return nextPrompt;
}

function upsertOutput(outputs: MaterialClip["outputs"], output: MaterialClip["outputs"][number]) {
  return [...outputs.filter((item) => item.type !== output.type || item.provider !== output.provider), output];
}

function createAiJob(
  clip: MaterialClip,
  provider: DepthAiProvider,
  prompt: string,
  now: string,
  referenceImages: ImageMaterial[],
  preferredInputType: MaterialOutput["type"],
  seedanceSettings: SeedanceProviderConfig
) {
  const cost = estimateProviderCost(provider, seedanceSettings);
  const inputOutput = preferredInputType === "original"
    ? getOriginalOutput(clip)
    : clip.outputs.find((item) => item.type === preferredInputType) || getBestParentOutputForAi(clip);
  return {
    id: createId("aijob"),
    sourceClipId: clip.id,
    lineageId: clip.lineageId,
    inputAssetType: inputOutput?.type === "depth_video" || inputOutput?.type === "grayscale_video" ? inputOutput.type : "original" as const,
    inputVideoUrl: inputOutput?.videoUrl || clip.originalVideoUrl,
    provider,
    status: "queued" as const,
    prompt: `${prompt}\n\n参考图片：${referenceImages.map((image) => image.title).join("、") || "无"}`,
    referenceImageUrls: referenceImages.map((image) => image.imageUrl),
    cost,
    createdAt: now
  };
}

function estimateProviderCost(provider: DepthAiProvider, seedanceSettings?: SeedanceProviderConfig): AiGenerationCost {
  if (provider === "seedance_api" && seedanceSettings) {
    const pricing = SEEDANCE_MODEL_PRICING.find(
      (item) => item.model === seedanceSettings.model && item.resolution === seedanceSettings.resolution
    ) || SEEDANCE_MODEL_PRICING.find((item) => item.model === seedanceSettings.model) || SEEDANCE_MODEL_PRICING[0];
    const duration = Math.max(1, seedanceSettings.defaultDuration || 5);
    return {
      creditsUsed: undefined,
      queueWaitSec: 8,
      generationSec: duration,
      estimatedCash: Number((pricing.cnyPerSecond * duration).toFixed(3))
    };
  }
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

function isPreprocessDoneForMethod(clip: MaterialClip, method: VideoPreprocessMethod) {
  return clip.preprocess?.status === "done" && (clip.preprocess.method || "depth") === method;
}

function elapsedSince(isoDate: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000));
}

function serializeLibraryClips(clips: MaterialClip[]): MaterialClip[] {
  return clips.map((clip) => {
    const { sourceFile: _sourceFile, ...serializableClip } = clip;
    return serializableClip;
  });
}

function serializeLibraryImages(images: ImageMaterial[]): ImageMaterial[] {
  return images.map((image) => ({ ...image }));
}

function stableLibrarySnapshot(clips: MaterialClip[], images: ImageMaterial[]) {
  return JSON.stringify({
    clips: serializeLibraryClips(clips),
    images: serializeLibraryImages(images)
  });
}

function elapsedBetween(startIso: string, endIso: string) {
  return Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
}

function depthMetaText(clip: MaterialClip) {
  const record = clip.preprocess;
  if (!record) return "等待处理，可单独选择或批量处理";
  const method = record.method || "depth";
  const quality = method === "depth"
    ? `${record.params.inputSize ?? 518}px · ${record.params.letterbox === false ? "拉伸" : "Letterbox"} · 滤波 ${record.params.edgeFilterStrength ?? 0}`
    : "OpenCV 灰度转换";
  const runtime = `${quality} · 耗时 ${record.cost.elapsedSec}s`;
  if (record.status === "queued") return `${record.params.depthModel} · 已进入队列`;
  if (record.status === "processing") return `${record.params.depthModel} · 正在生成 · ${runtime}`;
  if (record.status === "done") return `${record.params.depthModel} · ${runtime}`;
  return `${record.params.depthModel} · 处理失败 · ${runtime}`;
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
    || clip.outputs.find((item) => item.type === "grayscale_video")?.videoUrl
    || clip.originalVideoUrl;
}

function clipCost(clip: MaterialClip) {
  return clip.aiJobs.reduce((total, job) => total + job.cost.estimatedCash, 0);
}

function providerLabel(provider: DepthAiProvider) {
  return providerOptions.find((item) => item.value === provider)?.label ?? provider;
}

function depthStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    queued: "前处理排队中",
    processing: "前处理中",
    done: "已前处理",
    failed: "前处理失败"
  };
  return status ? labels[status] ?? status : "未前处理";
}

function preprocessMethodLabel(method: VideoPreprocessMethod) {
  return method === "depth" ? "深度视频" : "黑白视频";
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

function renderAiJobStatus(job: VideoAiJob) {
  if (job.status === "generating") {
    const progressText = job.progress !== undefined ? ` ${job.progress}%` : "";
    const remoteText = job.remoteStatus ? ` [${job.remoteStatus}]` : "";
    const elapsedText = job.elapsedSec !== undefined ? ` ${job.elapsedSec}s` : "";
    return `生成中${progressText}${remoteText}${elapsedText}`;
  }
  if (job.status === "done") {
    const elapsedText = job.elapsedSec !== undefined ? ` (${job.elapsedSec}s)` : "";
    return `完成${elapsedText}`;
  }
  if (job.status === "failed") {
    const remoteText = job.remoteStatus ? ` [${job.remoteStatus}]` : "";
    return `失败${remoteText}`;
  }
  return aiStatusLabel(job.status);
}
