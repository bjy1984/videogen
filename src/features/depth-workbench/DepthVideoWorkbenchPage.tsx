import { Check, Clock3, Coins, Film, Image as ImageIcon, Layers3, Plus, RefreshCw, Sparkles, Tag, Trash2, Upload, Wand2 } from "lucide-react";
import type { Dispatch, PointerEvent, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { VideoSegment } from "../../types";
import { createId } from "../../services/id";
import { formatDateTime } from "../../services/formatters";
import {
  createSeedanceBridgeTask,
  extractVideoFramesBridge,
  getSeedanceBridgeTask,
  loadWorkbenchLibraryState,
  maskExtractedFrameBridge,
  preprocessDepthVideoBridge,
  preprocessGrayscaleVideoBridge,
  preprocessSplitVideoBridge,
  replaceProductFramesBridge,
  saveWorkbenchLibraryState,
  syncSeedanceBridgeAsset,
  transcribeVideoBridge,
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
  ProductFrameReplacementRecord,
  VideoFrameExtractionRecord,
  VideoPreprocessMethod,
  VideoAiJob
} from "./depthTypes";
import type { VideoSplitRange } from "./splitPlanning";

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

type AiGenerationMode = "direct_reference" | "frame_replacement";
type FrameMaskEffect = "mosaic" | "blur" | "solid";

interface FrameMaskDraft {
  clipId: string;
  frameIndex: number;
}

interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const seedanceFastDirectModel = "xsdoubao/seedance2.0_fast_direct";
const frameReplacementMaxFrames = 12;

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
    content: "全面参考【@视频1】视频{imageInstruction}，保留视频声音。",
    builtin: true
  },
  {
    id: "tpl_product_only",
    name: "只换产品信息",
    content: "参考【@视频1】视频的镜头、动作和声音{productInstruction}。",
    builtin: true
  },
  {
    id: "tpl_face_product",
    name: "产品与人脸参考",
    content: "全面参考【@视频1】视频{productInstruction}{faceInstruction}，保留视频声音。",
    builtin: true
  }
];

type DepthWorkbenchTab = "library" | "preprocess" | "ai" | "cost" | "compose";
type MaterialLibraryMode = "video" | "image";
type DepthQualityPreset = "fast" | "standard" | "portrait";
type SplitBridgeSegment = {
  id: string;
  sourceClipId: string;
  lineageId: string;
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  videoUrl: string;
  localPath: string;
  fileName: string;
  range: VideoSplitRange;
};

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
  { key: "preprocess", title: "前置处理", subtitle: "抽帧 / 替换" },
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
  onSeedanceSettings,
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
  onSeedanceSettings: (settings: SeedanceProviderConfig) => void;
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
  const [aiGenerationMode, setAiGenerationMode] = useState<AiGenerationMode>("direct_reference");
  const [aiReferenceClipId, setAiReferenceClipId] = useState("");
  const [aiReferenceOutputType, setAiReferenceOutputType] = useState<MaterialOutput["type"]>("original");
  const [frameReplacementDuration, setFrameReplacementDuration] = useState(5);
  const [sourceTranscriptByClipId, setSourceTranscriptByClipId] = useState<Record<string, VideoAiJob["transcript"]>>({});
  const [isTranscribingSource, setIsTranscribingSource] = useState(false);
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
  const [splitTargetSec, setSplitTargetSec] = useState(10);
  const [productFrameIntervalSec, setProductFrameIntervalSec] = useState(1);
  const [productFrameMaxFrames, setProductFrameMaxFrames] = useState(12);
  const [productFramePrompt, setProductFramePrompt] = useState(
    "保留原视频抽帧中的人物、场景、光线、构图和动作，只替换画面中的产品信息。"
  );
  const [expandedFrameClipIds, setExpandedFrameClipIds] = useState<string[]>([]);
  const [frameMaskDraft, setFrameMaskDraft] = useState<FrameMaskDraft | undefined>();
  const [frameMaskRect, setFrameMaskRect] = useState<NormalizedRect | undefined>();
  const [frameMaskEffect, setFrameMaskEffect] = useState<FrameMaskEffect>("mosaic");
  const [frameMaskStrength, setFrameMaskStrength] = useState(0.85);
  const [isMaskingFrame, setIsMaskingFrame] = useState(false);
  const [frameMaskError, setFrameMaskError] = useState("");
  const [aiClockNow, setAiClockNow] = useState(Date.now());
  const libraryHydratedRef = useRef(false);
  const lastSavedLibraryRef = useRef("");

  const selectedClips = clips.filter((clip) => selectedIds.includes(clip.id));
  const aiReferenceClip = useMemo(() => clips.find((clip) => clip.id === aiReferenceClipId), [aiReferenceClipId, clips]);
  const aiReferenceImages = useMemo(
    () => selectedImageIds.map((id) => images.find((image) => image.id === id)).filter((image): image is ImageMaterial => Boolean(image)),
    [images, selectedImageIds]
  );
  const selectedProductImages = useMemo(() => {
    const selected = selectedImageIds
      .map((id) => images.find((image) => image.id === id))
      .filter((image): image is ImageMaterial => Boolean(image))
      .filter((image) => image.category === "product");
    return selected.length ? selected : images.filter((image) => image.category === "product");
  }, [images, selectedImageIds]);
  const sourceTranscript = aiReferenceClip ? sourceTranscriptByClipId[aiReferenceClip.id] : undefined;
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
  const aiJobRows = useMemo(
    () => clips
      .flatMap((clip) => clip.aiJobs.map((job) => ({ clip, job })))
      .sort((a, b) => new Date(b.job.createdAt).getTime() - new Date(a.job.createdAt).getTime()),
    [clips]
  );
  const aiMonitorStats = useMemo(() => buildAiMonitorStats(aiJobRows, aiClockNow), [aiClockNow, aiJobRows]);
  const activeFrameMaskClip = frameMaskDraft ? clips.find((clip) => clip.id === frameMaskDraft.clipId) : undefined;
  const activeFrameMaskFrame = activeFrameMaskClip?.frameExtraction?.frames.find((frame) => frame.index === frameMaskDraft?.frameIndex);

  useEffect(() => {
    if (aiReferenceClipId && clips.some((clip) => clip.id === aiReferenceClipId)) return;
    setAiReferenceClipId(clips[0]?.id || "");
  }, [aiReferenceClipId, clips]);

  useEffect(() => {
    setFrameReplacementDuration(seedanceDurationFromClip(aiReferenceClip, undefined, seedanceSettings.defaultDuration));
  }, [aiReferenceClip, seedanceSettings.defaultDuration]);

  useEffect(() => {
    const template = aiPromptTemplates.find((item) => item.id === activePromptTemplateId) || aiPromptTemplates[0] || defaultAiPromptTemplates[0];
    setPromptTemplateDraft(sanitizeAiPromptTemplate(template.content));
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
    setPrompt(renderAiPromptForMode(aiGenerationMode, promptTemplateDraft, aiReferenceClip, aiReferenceImages, sourceTranscript, seedanceSettings.defaultDuration));
  }, [aiGenerationMode, aiReferenceClip, aiReferenceImages, promptDirty, promptTemplateDraft, seedanceSettings.defaultDuration, sourceTranscript]);

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

  useEffect(() => {
    if (!aiJobRows.some(({ job }) => isAiJobActive(job))) return;
    const timer = window.setInterval(() => setAiClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [aiJobRows]);

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

  function toggleFrameInspection(clipId: string) {
    setExpandedFrameClipIds((current) =>
      current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId]
    );
  }

  function openFrameMaskEditor(clipId: string, frameIndex: number) {
    setFrameMaskDraft({ clipId, frameIndex });
    setFrameMaskRect(undefined);
    setFrameMaskEffect("mosaic");
    setFrameMaskStrength(0.85);
    setFrameMaskError("");
  }

  async function applyFrameMask() {
    if (!frameMaskDraft || !frameMaskRect) {
      setFrameMaskError("请先在图片上拖拽选择需要打码的区域。");
      return;
    }
    const clip = clips.find((item) => item.id === frameMaskDraft.clipId);
    const frame = clip?.frameExtraction?.frames.find((item) => item.index === frameMaskDraft.frameIndex);
    if (!clip || !frame) {
      setFrameMaskError("没有找到要修改的抽帧素材。");
      return;
    }
    setIsMaskingFrame(true);
    setFrameMaskError("");
    try {
      const result = await maskExtractedFrameBridge({
        bridgeUrl,
        projectId,
        clipId: clip.id,
        frameIndex: frame.index,
        sourceImageUrl: frame.modifiedImageUrl || frame.imageUrl,
        sourceLocalPath: frame.modifiedLocalPath || frame.localPath,
        rects: [{ rect: frameMaskRect, effect: frameMaskEffect, strength: frameMaskStrength }]
      });
      const now = new Date().toISOString();
      onClips((current) =>
        current.map((item) => {
          if (item.id !== clip.id || !item.frameExtraction) return item;
          return {
            ...item,
            frameExtraction: {
              ...item.frameExtraction,
              frames: item.frameExtraction.frames.map((currentFrame) =>
                currentFrame.index === frame.index
                  ? {
                      ...currentFrame,
                      modifiedImageUrl: result.edit.imageUrl,
                      modifiedLocalPath: result.edit.localPath,
                      maskEdits: [
                        ...(currentFrame.maskEdits || []),
                        {
                          id: result.edit.id,
                          effect: frameMaskEffect,
                          strength: frameMaskStrength,
                          rect: frameMaskRect,
                          createdAt: now
                        }
                      ]
                    }
                  : currentFrame
              ),
              updatedAt: now
            },
            updatedAt: now
          };
        })
      );
      setFrameMaskDraft(undefined);
      setFrameMaskRect(undefined);
      onNotice(`已修改第 ${frame.index + 1} 张抽帧素材，后续产品信息替换会优先使用修改后的帧。`);
    } catch (error) {
      setFrameMaskError(error instanceof Error ? error.message : "抽帧打码失败。");
    } finally {
      setIsMaskingFrame(false);
    }
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
    const productImagesForReplacement = selectedProductImages;
    if (method === "product_frame_replace" && !productImagesForReplacement.length) {
      onNotice("产品信息替换需要至少 1 张产品图片素材。请先在图片素材库选择或上传产品图。");
      return;
    }
    if (method === "product_frame_replace") {
      const missingFrameClip = nextTargetIds
        .map((id) => clips.find((clip) => clip.id === id))
        .find((clip) => clip && (clip.frameExtraction?.status !== "done" || !clip.frameExtraction.frames.length));
      if (missingFrameClip) {
        onNotice(`「${missingFrameClip.title}」还没有完成视频抽帧，请先执行「视频抽帧」。`);
        return;
      }
    }
    if (method === "video_frame_extract" && !nextTargetIds.length) {
      return;
    }
    onClips((current) =>
      current.map((clip) => {
        if (!nextTargetIds.includes(clip.id)) return clip;
        const frameExtraction: VideoFrameExtractionRecord | undefined = method === "video_frame_extract"
          ? {
              id: createId("frames"),
              sourceClipId: clip.id,
              lineageId: clip.lineageId,
              status: "queued",
              provider: "local-bridge",
              inputVideoUrl: clip.originalVideoUrl,
              intervalSec: productFrameIntervalSec,
              maxFrames: productFrameMaxFrames,
              frames: [],
              cost: { elapsedSec: 0 },
              createdAt: now,
              updatedAt: now
            }
          : undefined;
        const productFrameReplacement: ProductFrameReplacementRecord | undefined = method === "product_frame_replace"
          ? {
              id: createId("pfr"),
              sourceClipId: clip.id,
              lineageId: clip.lineageId,
              status: "queued",
              provider: "image2",
              inputVideoUrl: clip.originalVideoUrl,
              productImageUrls: productImagesForReplacement.map((image) => image.imageUrl),
              prompt: productFramePrompt,
              intervalSec: productFrameIntervalSec,
              maxFrames: productFrameMaxFrames,
              frames: [],
              cost: { elapsedSec: 0 },
              createdAt: now,
              updatedAt: now
            }
          : undefined;
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
              depthModel: method === "depth"
                ? "depth-anything-dnn"
                : method === "grayscale"
                  ? "opencv-grayscale"
                  : method === "split"
                    ? "ffmpeg-split"
                    : method === "video_frame_extract"
                      ? "ffmpeg-frame-extract"
                      : "image2-product-frame-replacement",
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
          ...(frameExtraction ? { frameExtraction } : {}),
          ...(productFrameReplacement ? { productFrameReplacement } : {}),
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
        if (method === "split") {
          const result = await preprocessSplitVideoBridge({
            bridgeUrl,
            projectId,
            clipId: clip.id,
            lineageId: clip.lineageId,
            video,
            sourceLocalPath,
            sourceVideoUrl,
            sourceVideoName: clip.sourceFileName || clip.title,
            targetSec: splitTargetSec
          });
          markSplitDone(clipId, result);
          continue;
        }
        if (method === "product_frame_replace") {
          const activeProductUrls = productImagesForReplacement.map((image) => image.imageUrl).filter((url) => url && !url.startsWith("blob:"));
          if (!activeProductUrls.length) {
            markDepthFailed(clipId, "产品信息替换需要已保存到素材库的产品图片 URL。");
            continue;
          }
          const extractedFrames = clip.frameExtraction?.frames || [];
          if (clip.frameExtraction?.status !== "done" || !extractedFrames.length) {
            markDepthFailed(clipId, "请先执行「视频抽帧」，再执行「产品信息替换」。");
            continue;
          }
          const sourceFrames = extractedFrames
            .map((frame) => ({
              index: frame.index,
              timestampSec: frame.timestampSec,
              imageUrl: frame.modifiedImageUrl || frame.imageUrl,
              localPath: frame.modifiedLocalPath || frame.localPath
            }))
            .filter((frame) => frame.imageUrl && !frame.imageUrl.startsWith("blob:"));
          if (!sourceFrames.length) {
            markDepthFailed(clipId, "视频抽帧结果没有可用的图片 URL，请重新执行「视频抽帧」。");
            continue;
          }
          const replacementId = createId("image2");
          const replacementResult = await replaceProductFramesBridge({
            bridgeUrl,
            projectId,
            clipId: clip.id,
            replacementId,
            prompt: productFramePrompt,
            sourceFrames,
            productImageUrls: activeProductUrls
          });
          markProductFrameReplacementDone(clipId, replacementResult);
          continue;
        }
        if (method === "video_frame_extract") {
          const frameResult = await extractVideoFramesBridge({
            bridgeUrl,
            projectId,
            clipId: clip.id,
            video,
            sourceLocalPath,
            sourceVideoUrl,
            sourceVideoName: clip.sourceFileName || clip.title,
            intervalSec: productFrameIntervalSec,
            maxFrames: productFrameMaxFrames
          });
          markFrameExtractionDone(clipId, frameResult);
          continue;
        }
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
          ? {
              ...clip,
              preprocess: { ...clip.preprocess, status: "processing", startedAt: now, updatedAt: now },
              frameExtraction: clip.preprocess.method === "video_frame_extract" && clip.frameExtraction
                ? { ...clip.frameExtraction, status: "processing", startedAt: now, updatedAt: now }
                : clip.frameExtraction,
              productFrameReplacement: clip.preprocess.method === "product_frame_replace" && clip.productFrameReplacement
                ? { ...clip.productFrameReplacement, status: "processing", startedAt: now, updatedAt: now }
                : clip.productFrameReplacement,
              updatedAt: now
            }
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
              productFrameReplacement: clip.preprocess.method === "product_frame_replace" && clip.productFrameReplacement
                ? {
                    ...clip.productFrameReplacement,
                    status: "failed",
                    error: message,
                    finishedAt: now,
                    cost: {
                      ...clip.productFrameReplacement.cost,
                      elapsedSec: clip.productFrameReplacement.startedAt
                        ? elapsedBetween(clip.productFrameReplacement.startedAt, now)
                        : clip.productFrameReplacement.cost.elapsedSec
                    },
                    updatedAt: now
                  }
                : clip.productFrameReplacement,
              frameExtraction: clip.preprocess.method === "video_frame_extract" && clip.frameExtraction
                ? {
                    ...clip.frameExtraction,
                    status: "failed",
                    error: message,
                    finishedAt: now,
                    cost: {
                      ...clip.frameExtraction.cost,
                      elapsedSec: clip.frameExtraction.startedAt
                        ? elapsedBetween(clip.frameExtraction.startedAt, now)
                        : clip.frameExtraction.cost.elapsedSec
                    },
                    updatedAt: now
                  }
                : clip.frameExtraction,
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
            localPath: trace.localPath,
            createdAt: now
          }),
          updatedAt: now
        };
      })
    );
    onNotice(`${preprocessMethodLabel(method)}生成完成，已写入真实产物。`);
  }

  function markFrameExtractionDone(
    clipId: string,
    frameResult: Awaited<ReturnType<typeof extractVideoFramesBridge>>
  ) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => {
        if (clip.id !== clipId || !clip.preprocess || !clip.frameExtraction) return clip;
        const elapsedSec = frameResult.trace.summary.elapsedSec;
        return {
          ...clip,
          preprocess: {
            ...clip.preprocess,
            status: "done" as const,
            method: "video_frame_extract" as const,
            provider: "local-bridge" as const,
            params: {
              ...clip.preprocess.params,
              depthModel: "ffmpeg-frame-extract",
              fps: 1
            },
            cost: { elapsedSec, gpuSec: 0 },
            finishedAt: now,
            updatedAt: now
          },
          frameExtraction: {
            ...clip.frameExtraction,
            status: "done" as const,
            durationSec: frameResult.trace.summary.durationSec,
            intervalSec: frameResult.trace.summary.intervalSec,
            maxFrames: frameResult.trace.summary.maxFrames,
            frames: frameResult.frames.map((frame) => ({
              index: frame.index,
              timestampSec: frame.timestampSec,
              imageUrl: frame.imageUrl,
              localPath: frame.localPath,
              fileName: frame.fileName
            })),
            cost: { elapsedSec },
            finishedAt: now,
            updatedAt: now
          },
          updatedAt: now
        };
      })
    );
    onNotice(`视频抽帧完成，已生成 ${frameResult.frames.length} 张图片帧。`);
  }

  function markProductFrameReplacementDone(
    clipId: string,
    replacementResult: Awaited<ReturnType<typeof replaceProductFramesBridge>>
  ) {
    const now = new Date().toISOString();
    onClips((current) =>
      current.map((clip) => {
        if (clip.id !== clipId || !clip.preprocess || !clip.productFrameReplacement) return clip;
        const elapsedSec = replacementResult.trace.summary.elapsedSec;
        const sourceByIndex = new Map((clip.frameExtraction?.frames || []).map((frame) => [frame.index, frame]));
        return {
          ...clip,
          preprocess: {
            ...clip.preprocess,
            status: "done" as const,
            method: "product_frame_replace" as const,
            provider: "local-bridge" as const,
            params: {
              ...clip.preprocess.params,
              depthModel: "image2-product-frame-replacement",
              fps: 1
            },
            cost: { elapsedSec, gpuSec: 0 },
            finishedAt: now,
            updatedAt: now
          },
          productFrameReplacement: {
            ...clip.productFrameReplacement,
            status: "done" as const,
            durationSec: clip.frameExtraction?.durationSec,
            frames: replacementResult.frames.map((frame) => {
              const source = sourceByIndex.get(frame.index);
              return {
                index: frame.index,
                timestampSec: frame.timestampSec,
                sourceImageUrl: frame.sourceImageUrl || source?.imageUrl || "",
                sourceLocalPath: source?.localPath,
                imageUrl: frame.imageUrl,
                localPath: frame.localPath,
                remoteImageUrl: frame.remoteImageUrl,
                prompt: frame.prompt,
                usage: frame.usage
              };
            }),
            cost: {
              elapsedSec,
              estimatedUsd: replacementResult.trace.summary.estimatedUsd,
              inputTokens: replacementResult.trace.summary.inputTokens,
              outputTokens: replacementResult.trace.summary.outputTokens,
              totalTokens: replacementResult.trace.summary.totalTokens
            },
            finishedAt: now,
            updatedAt: now
          },
          updatedAt: now
        };
      })
    );
    onNotice(`产品信息替换完成，已生成 ${replacementResult.frames.length} 张替换帧。`);
  }

  function markSplitDone(
    clipId: string,
    result: Awaited<ReturnType<typeof preprocessSplitVideoBridge>>
  ) {
    const now = new Date().toISOString();
    onClips((current) => {
      const sourceClip = current.find((clip) => clip.id === clipId);
      if (!sourceClip?.preprocess) return current;
      const createdClips = result.segments.map((segment) => createClipFromSplitSegment(sourceClip, segment, result.trace.id, now));
      const outputClipIds = createdClips.map((clip) => clip.id);
      return [
        ...current.map((clip) => {
          if (clip.id !== clipId || !clip.preprocess) return clip;
          const elapsedSec = result.trace.summary.elapsedSec ?? 0;
          return {
            ...clip,
            split: {
              id: result.trace.id,
              sourceClipId: clip.id,
              lineageId: clip.lineageId,
              status: "done" as const,
              inputVideoUrl: clip.originalVideoUrl,
              provider: "local-bridge" as const,
              segmentCount: result.trace.summary.segmentCount,
              targetSec: result.trace.summary.targetSec,
              maxSec: result.trace.summary.maxSec,
              minLastSec: result.trace.summary.minLastSec,
              sourceDurationSec: result.trace.summary.sourceDurationSec,
              outputClipIds,
              cost: { elapsedSec },
              createdAt: clip.preprocess.createdAt,
              startedAt: clip.preprocess.startedAt,
              finishedAt: now,
              updatedAt: now
            },
            preprocess: {
              ...clip.preprocess,
              status: "done" as const,
              method: "split" as const,
              cost: { elapsedSec, gpuSec: 0 },
              finishedAt: now,
              updatedAt: now
            },
            updatedAt: now
          };
        }),
        ...createdClips
      ];
    });
    onNotice(`视频切分完成，已生成 ${result.segments.length} 个不超过 10 秒的素材片段。`);
  }

  function selectAiReferenceClip(clipId: string) {
    setAiReferenceClipId(clipId);
    setSelectedIds([clipId]);
  }

  function regenerateAiPrompt() {
    setPrompt(renderAiPromptForMode(aiGenerationMode, promptTemplateDraft, aiReferenceClip, aiReferenceImages, sourceTranscript, seedanceSettings.defaultDuration));
    setPromptDirty(false);
  }

  function changeAiGenerationMode(nextMode: AiGenerationMode) {
    setAiGenerationMode(nextMode);
    setPrompt(renderAiPromptForMode(nextMode, promptTemplateDraft, aiReferenceClip, aiReferenceImages, sourceTranscript, seedanceSettings.defaultDuration));
    setPromptDirty(false);
  }

  function saveCurrentPromptTemplate() {
    const content = sanitizeAiPromptTemplate(promptTemplateDraft).trim();
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
    const job = createAiJob(aiReferenceClip, aiProvider, finalPrompt, now, aiReferenceImages, aiReferenceOutputType, seedanceSettings, aiGenerationMode, sourceTranscript);
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
        prompt: task.finalPrompt || finalPrompt,
        frameSample: task.frameSample,
        transcript: task.transcript,
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
    if (aiGenerationMode === "frame_replacement") {
      return submitSeedanceFrameReplacementJob(clip, job, finalPrompt);
    }
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
    return { ...task, localJobId: job.id, finalPrompt, frameSample: undefined, transcript: undefined };
  }

  async function submitSeedanceFrameReplacementJob(clip: MaterialClip, job: VideoAiJob, scriptPrompt: string) {
    const replacement = clip.productFrameReplacement;
    if (replacement?.status !== "done" || !replacement.frames.length) {
      throw new Error("fast_direct 分帧替换生成需要先在前置处理依次执行「视频抽帧」和「产品信息替换」。");
    }
    const frameUrls = replacement.frames
      .map((frame) => frame.imageUrl)
      .filter((url): url is string => typeof url === "string" && Boolean(url) && !url.startsWith("blob:"));
    if (!frameUrls.length) {
      throw new Error("产品信息替换没有可用的替换帧 URL，请重新执行「产品信息替换」。");
    }
    const duration = normalizeSeedanceDuration(frameReplacementDuration, clip, replacement.durationSec, seedanceSettings.defaultDuration);
    const finalPrompt = promptDirty
      ? scriptPrompt
      : buildProductFrameVideoPrompt({
          scriptPrompt: cleanFrameReplacementScript(promptTemplateDraft),
          transcript: sourceTranscript,
          frameCount: frameUrls.length
        });
    const request = buildSeedanceCreateTaskRequest({
      prompt: finalPrompt,
      aspectRatio: "9:16",
      duration,
      referenceImageUrls: frameUrls,
      params: {
        bridgeUrl,
        endpoint: seedanceSettings.endpoint,
        apiKeyEnvName: seedanceSettings.apiKeyEnvName,
        model: seedanceFastDirectModel,
        defaultDuration: duration,
        resolution: "720p",
        seed: seedanceSettings.seed,
        generateAudio: seedanceSettings.generateAudio,
        watermark: seedanceSettings.watermark,
        returnLastFrame: seedanceSettings.returnLastFrame
      }
    });
    const task = await createSeedanceBridgeTask({ bridgeUrl, request });
    return {
      ...task,
      localJobId: job.id,
      finalPrompt,
      transcript: sourceTranscript,
      frameSample: {
        intervalSec: replacement.intervalSec,
        maxFrames: replacement.maxFrames,
        durationSec: replacement.durationSec || duration,
        frameUrls
      }
    };
  }

  async function transcribeAiReferenceClip() {
    if (!aiReferenceClip) {
      onNotice("请先选择一条参考视频。");
      return;
    }
    const sourceInput = seedanceSourceInput(aiReferenceClip);
    if (!sourceInput.sourceVideoUrl && !sourceInput.sourceLocalPath && !sourceInput.video) {
      onNotice("该素材缺少可转写的视频文件或本地资产链接。");
      return;
    }
    setIsTranscribingSource(true);
    try {
      const result = await transcribeVideoBridge({
        bridgeUrl,
        projectId,
        clipId: aiReferenceClip.id,
        video: sourceInput.video,
        sourceLocalPath: sourceInput.sourceLocalPath,
        sourceVideoUrl: sourceInput.sourceVideoUrl,
        sourceVideoName: sourceInput.sourceVideoName,
        language: "zh"
      });
      setSourceTranscriptByClipId((current) => ({ ...current, [aiReferenceClip.id]: result.transcript }));
      onNotice(`已提取素材语音文案：${result.transcript.segments.length} 段。`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "素材语音转文字失败。");
    } finally {
      setIsTranscribingSource(false);
    }
  }

  function updateSourceTranscriptText(text: string) {
    if (!aiReferenceClip) return;
    const nextTranscript = {
      text,
      segments: sourceTranscript?.segments || [],
      ...(sourceTranscript?.durationSec ? { durationSec: sourceTranscript.durationSec } : {}),
      ...(sourceTranscript?.language ? { language: sourceTranscript.language } : {})
    };
    setSourceTranscriptByClipId((current) => {
      const existing = current[aiReferenceClip.id];
      return {
        ...current,
        [aiReferenceClip.id]: {
          text,
          segments: existing?.segments || [],
          ...(existing?.durationSec ? { durationSec: existing.durationSec } : {}),
          ...(existing?.language ? { language: existing.language } : {})
        }
      };
    });
    if (aiGenerationMode === "frame_replacement" && !promptDirty) {
      setPrompt(renderAiPromptForMode(aiGenerationMode, promptTemplateDraft, aiReferenceClip, aiReferenceImages, nextTranscript, seedanceSettings.defaultDuration));
    }
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
      markAiDoneWithOutput(clipId, jobId, synced.asset.localAssetUrl, synced.asset.localPath);
    } catch (error) {
      updateAiJob(clipId, jobId, {
        status: "failed",
        error: error instanceof Error ? error.message : "Seedance 任务刷新失败。"
      });
    }
  }

  function refreshAiJobNow(clipId: string, job: VideoAiJob) {
    if (job.provider !== "seedance_api" || !job.remoteTaskId || job.status === "done") return;
    void refreshSeedanceAiJob(clipId, job.id, job.remoteTaskId);
    onNotice(`正在刷新 Seedance 任务：${job.remoteTaskId}`);
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
            localPath: localAssetPathFromUrl(job.outputVideoUrl || clip.originalVideoUrl),
            jobId: job.id,
            createdAt: now
          }),
          updatedAt: now
        };
      })
    );
    onNotice("AI 加工任务已完成，已写入成本、耗时 and 生成产物。");
  }

  function markAiDoneWithOutput(clipId: string, jobId: string, outputVideoUrl: string, outputLocalPath?: string) {
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
            localPath: outputLocalPath || localAssetPathFromUrl(outputVideoUrl),
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
            <button className={preprocessMethod === "split" ? "active" : ""} onClick={() => setPreprocessMethod("split")}>
              <Layers3 size={16} />
              <span>
                <strong>视频切分</strong>
                <small>按设定秒数切片，最小 1 秒，最大不超过 10 秒。</small>
              </span>
            </button>
            <button className={preprocessMethod === "video_frame_extract" ? "active" : ""} onClick={() => setPreprocessMethod("video_frame_extract")}>
              <ImageIcon size={16} />
              <span>
                <strong>视频抽帧</strong>
                <small>按间隔从原视频抽取图片帧，作为后续产品替换输入。</small>
              </span>
            </button>
            <button className={preprocessMethod === "product_frame_replace" ? "active" : ""} onClick={() => setPreprocessMethod("product_frame_replace")}>
              <Sparkles size={16} />
              <span>
                <strong>产品信息替换</strong>
                <small>基于已抽取的视频帧调用 image2，替换画面中的产品信息。</small>
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
          {preprocessMethod === "split" && (
            <div className="depth-quality-panel">
              <div className="quality-control-grid">
                <label>
                  <span>分段时长</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    value={splitTargetSec}
                    onChange={(event) => setSplitTargetSec(normalizeSplitTargetSec(Number(event.target.value)))}
                  />
                  <small>秒。按 1 秒为最小单位增减，提交时用于视频切分。</small>
                </label>
              </div>
              <div className="quality-help-grid">
                <div>
                  <strong>切分规则</strong>
                  <small>以 {splitTargetSec} 秒为目标长度切分；最后一段过短时，从前面片段均匀挪出时长。</small>
                </div>
                <div>
                  <strong>长度限制</strong>
                  <small>所有切片都会保持不超过设定时长，适配后续 AI 再加工的视频时长限制。</small>
                </div>
                <div>
                  <strong>关联关系</strong>
                  <small>原视频保留在素材库，新切片继承标签和 lineage，并记录父素材与原视频时间范围。</small>
                </div>
              </div>
            </div>
          )}
          {preprocessMethod === "video_frame_extract" && (
            <div className="depth-quality-panel">
              <div className="quality-control-grid">
                <label>
                  <span>抽帧间隔</span>
                  <input
                    type="number"
                    min={0.2}
                    max={10}
                    step={0.1}
                    value={productFrameIntervalSec}
                    onChange={(event) => setProductFrameIntervalSec(Math.max(0.2, Number(event.target.value) || 1))}
                  />
                  <small>默认每秒 1 帧。这里只保存原视频抽帧，不调用 image2。</small>
                </label>
                <label>
                  <span>最多帧数</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    step={1}
                    value={productFrameMaxFrames}
                    onChange={(event) => setProductFrameMaxFrames(Math.min(24, Math.max(1, Math.round(Number(event.target.value) || 12))))}
                  />
                  <small>建议不超过 12 帧，后续产品信息替换和 fast_direct 都会沿用这些帧。</small>
                </label>
              </div>
              <div className="quality-help-grid">
                <div>
                  <strong>第一步</strong>
                  <small>输出原始图片帧，可在列表中查看第一张抽帧。</small>
                </div>
                <div>
                  <strong>后续步骤</strong>
                  <small>抽帧完成后再运行「产品信息替换」，image2 不会重复读取原视频。</small>
                </div>
                <div>
                  <strong>服务依赖</strong>
                  <small>只依赖本地 ffmpeg；即使 image2 未配置，也可以先完成抽帧。</small>
                </div>
              </div>
            </div>
          )}
          {preprocessMethod === "product_frame_replace" && (
            <div className="depth-quality-panel">
              <div className="quality-control-grid">
                <label>
                  <span>已抽帧素材</span>
                  <input value={`${selectedClips.filter((clip) => clip.frameExtraction?.status === "done").length}/${selectedClips.length} 个已完成`} readOnly />
                  <small>必须先执行「视频抽帧」，本步骤只处理已抽取的图片帧。</small>
                </label>
                <label>
                  <span>产品图</span>
                  <input value={`${selectedProductImages.length} 张`} readOnly />
                  <small>优先使用已选产品图片；未选择时使用产品素材库中的全部产品图。</small>
                </label>
                <label>
                  <span>替换输出</span>
                  <input value="图片帧" readOnly />
                  <small>输出已替换产品信息的图片帧，不直接生成视频。</small>
                </label>
              </div>
              <label className="depth-textarea-control">
                <span>image2 替换要求</span>
                <textarea
                  value={productFramePrompt}
                  onChange={(event) => setProductFramePrompt(event.target.value)}
                  rows={3}
                />
              </label>
              <div className="quality-help-grid">
                <div>
                  <strong>第二步</strong>
                  <small>从第一步抽帧结果读取图片，提交 image2 做产品信息替换。</small>
                </div>
                <div>
                  <strong>生成方式</strong>
                  <small>后续 AI 加工选择 fast_direct 分帧替换生成时，只引用这些替换帧。</small>
                </div>
                <div>
                  <strong>服务配置</strong>
                  <small>后端读取 IMAGE2_ENDPOINT、IMAGE2_API_KEY、IMAGE2_MODEL；素材远端访问继续复用 OSS。</small>
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
                  {clip.frameExtraction?.status === "done" && clip.frameExtraction.frames.length > 0 && (
                    <button className="secondary-button compact" onClick={() => toggleFrameInspection(clip.id)}>
                      {expandedFrameClipIds.includes(clip.id) ? "收起抽帧" : "检查抽帧"}
                    </button>
                  )}
                  {clip.productFrameReplacement?.status === "done" && clip.productFrameReplacement.frames[0]?.imageUrl && (
                    <a className="secondary-button compact" href={clip.productFrameReplacement.frames[0].imageUrl} target="_blank" rel="noreferrer">
                      查看替换帧
                    </a>
                  )}
                  <button className="secondary-button compact" onClick={() => runDepthPreprocess([clip.id])} disabled={isDepthBusy(clip)}>
                    <RefreshCw size={15} />
                    {clip.preprocess?.status === "done" ? "重新处理" : "处理"}
                  </button>
                </div>
                {expandedFrameClipIds.includes(clip.id) && clip.frameExtraction?.status === "done" && (
                  <FrameExtractionInspector record={clip.frameExtraction} onEditFrame={(frameIndex) => openFrameMaskEditor(clip.id, frameIndex)} />
                )}
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
                  <small>可多选，提示词按 @图片编号引用</small>
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
                <select
                  value={aiProvider}
                  onChange={(event) => {
                    const nextProvider = event.target.value as DepthAiProvider;
                    setAiProvider(nextProvider);
                    if (nextProvider !== "seedance_api") changeAiGenerationMode("direct_reference");
                  }}
                >
                  {providerOptions.map((item) => (
                    <option value={item.value} key={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
              {aiProvider === "seedance_api" && (
                <label className="ai-provider-select">
                  <span>处理方法</span>
                  <select value={aiGenerationMode} onChange={(event) => changeAiGenerationMode(event.target.value as AiGenerationMode)}>
                    <option value="direct_reference">常规参考生成</option>
                    <option value="frame_replacement">fast_direct 分帧替换生成</option>
                  </select>
                </label>
              )}
              {aiProvider === "seedance_api" && (
                <label className="ai-provider-select">
                  <span>Seedance 模型</span>
                  <select
                    disabled={aiGenerationMode === "frame_replacement"}
                    value={aiGenerationMode === "frame_replacement" ? `${seedanceFastDirectModel}__720p` : `${seedanceSettings.model}__${seedanceSettings.resolution}`}
                    onChange={(event) => {
                      const option = SEEDANCE_MODEL_PRICING.find((item) => `${item.model}__${item.resolution}` === event.target.value);
                      if (!option) return;
                      onSeedanceSettings({
                        ...seedanceSettings,
                        model: option.model,
                        resolution: option.resolution
                      });
                    }}
                  >
                    {SEEDANCE_MODEL_PRICING.map((item) => (
                      <option value={`${item.model}__${item.resolution}`} key={`${item.model}_${item.resolution}`}>
                        {formatSeedanceModelOption(item)}
                      </option>
                    ))}
                  </select>
                  {aiGenerationMode === "frame_replacement" && (
                    <small>分帧替换固定使用 xsdoubao/seedance2.0_fast_direct · 720p，时长按素材长度控制。</small>
                  )}
                </label>
              )}
              {aiProvider === "seedance_api" && aiGenerationMode === "frame_replacement" && (
                <div className="ai-source-summary">
                  <strong>分帧替换输入</strong>
                  <span>
                    产品替换帧：{aiReferenceClip?.productFrameReplacement?.status === "done"
                      ? aiReferenceClip.productFrameReplacement.frames.filter((frame) => frame.imageUrl).length
                      : 0} 张
                  </span>
                  <span>
                    前置参数：每 {aiReferenceClip?.productFrameReplacement?.intervalSec ?? productFrameIntervalSec} 秒 1 帧，
                    最多 {aiReferenceClip?.productFrameReplacement?.maxFrames ?? productFrameMaxFrames} 帧
                  </span>
                  <label className="ai-duration-editor">
                    <span>生成时长</span>
                    <input
                      type="number"
                      min={3}
                      max={10}
                      step={1}
                      value={frameReplacementDuration}
                      onChange={(event) => setFrameReplacementDuration(normalizeSeedanceDuration(Number(event.target.value), aiReferenceClip, undefined, seedanceSettings.defaultDuration))}
                    />
                    <small>秒，提交时写入 duration 参数</small>
                  </label>
                  <label className="ai-transcript-editor">
                    <span>语音文案</span>
                    <textarea
                      value={sourceTranscript?.text || ""}
                      placeholder="提取后可编辑，也可以直接填写原视频口播文案。"
                      onChange={(event) => updateSourceTranscriptText(event.target.value)}
                    />
                  </label>
                  <button className="secondary-button compact" onClick={transcribeAiReferenceClip} disabled={!aiReferenceClip || isTranscribingSource}>
                    {isTranscribingSource ? <RefreshCw className="spin" size={15} /> : <Sparkles size={15} />}
                    提取素材语音文案
                  </button>
                </div>
              )}
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
                <strong>生成任务看板</strong>
                <small>实时查看 AI 视频生成状态、耗时、进度和产物同步</small>
              </div>
            </div>

            <div className="ai-monitor-stats">
              <StatCard label="任务总数" value={aiMonitorStats.total} />
              <StatCard label="生成中" value={aiMonitorStats.active} />
              <StatCard label="已完成" value={aiMonitorStats.done} />
              <StatCard label="失败" value={aiMonitorStats.failed} />
              <StatCard label="累计耗时" value={formatDuration(aiMonitorStats.elapsedSec)} />
              <StatCard label="预计成本" value={`¥${aiMonitorStats.cash.toFixed(2)}`} />
            </div>

            <div className="ai-job-board">
              {aiJobRows.map(({ clip, job }) => {
                const elapsedSec = displayAiJobElapsed(job, aiClockNow);
                const progress = normalizeJobProgress(job);
                return (
                  <article className="ai-job-card" key={job.id}>
                    <div className="ai-job-card-head">
                      <div>
                        <strong>{clip.title}</strong>
                        <small>{providerLabel(job.provider)} · {aiInputTypeLabel(job.inputAssetType)} · {formatDateTime(job.createdAt)}</small>
                      </div>
                      <span className={`ai-job-status ${job.status}`}>{renderAiJobStatus(job, aiClockNow)}</span>
                    </div>
                    <div className="ai-job-progress" aria-label="AI 任务进度">
                      <span style={{ width: `${progress}%` }} />
                    </div>
                    <div className="ai-job-meta-grid">
                      <InfoChip label="本地任务" value={job.id} />
                      <InfoChip label="远端任务" value={job.remoteTaskId || "-"} />
                      <InfoChip label="远端状态" value={job.remoteStatus || "-"} />
                      <InfoChip label="进度" value={`${progress}%`} />
                      <InfoChip label="已耗时" value={formatDuration(elapsedSec)} />
                      <InfoChip label="预计成本" value={`¥${job.cost.estimatedCash.toFixed(2)}`} />
                    </div>
                    {job.error && <div className="ai-job-error" title={job.error}>{job.error}</div>}
                    <div className="ai-job-actions">
                      {job.outputVideoUrl && (
                        <a className="secondary-button compact" href={job.outputVideoUrl} target="_blank" rel="noreferrer">
                          查看产物
                        </a>
                      )}
                      <button
                        className="secondary-button compact"
                        onClick={() => refreshAiJobNow(clip.id, job)}
                        disabled={job.provider !== "seedance_api" || !job.remoteTaskId || job.status === "done"}
                      >
                        <RefreshCw size={15} />
                        刷新状态
                      </button>
                    </div>
                  </article>
                );
              })}
              {!aiJobRows.length && (
                <div className="empty-state compact-empty">
                  <Wand2 size={34} />
                  <strong>暂无 AI 生成任务</strong>
                  <span>选择参考视频和素材后提交 AI 加工，任务会出现在这里。</span>
                </div>
              )}
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
      {frameMaskDraft && activeFrameMaskFrame && (
        <FrameMaskEditor
          frame={activeFrameMaskFrame}
          rect={frameMaskRect}
          effect={frameMaskEffect}
          strength={frameMaskStrength}
          busy={isMaskingFrame}
          error={frameMaskError}
          onRect={setFrameMaskRect}
          onEffect={setFrameMaskEffect}
          onStrength={setFrameMaskStrength}
          onApply={applyFrameMask}
          onClose={() => {
            setFrameMaskDraft(undefined);
            setFrameMaskRect(undefined);
            setFrameMaskError("");
          }}
        />
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

function InfoChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="ai-info-chip">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
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
            {clip.parentClipId && clip.sourceRange && (
              <small>来自 {clip.parentClipId} · {formatRangeLabel(clip.sourceRange.startSec, clip.sourceRange.endSec)}</small>
            )}
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
      {outputs.map((output) => {
        const localPath = output.localPath || localAssetPathFromUrl(output.videoUrl);
        return (
          <div className="lineage-output-row" key={output.id}>
            <span>{outputTypeLabel(output.type)}</span>
            <div className="lineage-output-links">
              <a
                href={localPath ? localFileHref(localPath) : output.videoUrl}
                title={localPath || output.videoUrl}
                target="_blank"
                rel="noreferrer"
              >
                {localPath || output.videoUrl}
              </a>
              {localPath && output.videoUrl && (
                <a href={output.videoUrl} title={output.videoUrl} target="_blank" rel="noreferrer">
                  预览地址
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FrameExtractionInspector({ record, onEditFrame }: { record: VideoFrameExtractionRecord; onEditFrame: (frameIndex: number) => void }) {
  return (
    <div className="frame-inspector">
      <div className="frame-inspector-heading">
        <strong>抽帧素材检查</strong>
        <small>
          {record.frames.length} 张 · 每 {record.intervalSec}s 1 帧 · 源视频约 {record.durationSec ? `${record.durationSec.toFixed(1)}s` : "未知时长"}
        </small>
      </div>
      <div className="frame-inspector-grid">
        {record.frames.map((frame) => {
          const displayUrl = frame.modifiedImageUrl || frame.imageUrl;
          const localPath = frame.modifiedLocalPath || frame.localPath || localAssetPathFromUrl(displayUrl);
          return (
            <article className="frame-inspector-card" key={`${record.id}_${frame.index}`}>
              <a className="frame-thumb-link" href={displayUrl} target="_blank" rel="noreferrer" title="打开预览地址">
                <img src={displayUrl} alt={`抽帧 ${frame.index + 1}`} />
              </a>
              <div className="frame-card-meta">
                <strong>#{frame.index + 1} · {formatTimestamp(frame.timestampSec)}{frame.modifiedImageUrl ? " · 已修改" : ""}</strong>
                <div className="frame-card-links">
                  <a href={displayUrl} target="_blank" rel="noreferrer" title={displayUrl}>预览地址</a>
                  {localPath && (
                    <a href={localFileHref(localPath)} target="_blank" rel="noreferrer" title={localPath}>本地文件</a>
                  )}
                </div>
                <button className="secondary-button compact frame-edit-button" onClick={() => onEditFrame(frame.index)}>
                  素材修改/打码
                </button>
                <small title={localPath || frame.imageUrl}>{localPath || frame.imageUrl}</small>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function FrameMaskEditor({
  frame,
  rect,
  effect,
  strength,
  busy,
  error,
  onRect,
  onEffect,
  onStrength,
  onApply,
  onClose
}: {
  frame: VideoFrameExtractionRecord["frames"][number];
  rect?: NormalizedRect;
  effect: FrameMaskEffect;
  strength: number;
  busy: boolean;
  error?: string;
  onRect: (rect: NormalizedRect | undefined) => void;
  onEffect: (effect: FrameMaskEffect) => void;
  onStrength: (strength: number) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | undefined>();
  const imageUrl = frame.modifiedImageUrl || frame.imageUrl;

  function pointFromEvent(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    return { x, y };
  }

  function rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }) {
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
  }

  return (
    <div className="frame-mask-sheet" role="dialog" aria-modal="true">
      <section className="frame-mask-panel">
        <div className="frame-mask-head">
          <div>
            <p className="eyebrow">Frame Edit</p>
            <h2>素材修改/打码</h2>
            <small>拖拽选择需要遮罩的区域，保存后后续产品信息替换会使用修改后的帧。</small>
          </div>
          <button className="secondary-button compact" onClick={onClose} disabled={busy}>关闭</button>
        </div>
        <div className="frame-mask-layout">
          <div className="frame-mask-stage">
            <div
              className="frame-mask-canvas"
              onPointerDown={(event) => {
                const point = pointFromEvent(event);
                setDragStart(point);
                onRect({ x: point.x, y: point.y, width: 0, height: 0 });
              }}
              onPointerMove={(event) => {
                if (!dragStart) return;
                onRect(rectFromPoints(dragStart, pointFromEvent(event)));
              }}
              onPointerUp={(event) => {
                if (!dragStart) return;
                const nextRect = rectFromPoints(dragStart, pointFromEvent(event));
                setDragStart(undefined);
                if (nextRect.width < 0.01 || nextRect.height < 0.01) {
                  onRect(undefined);
                  return;
                }
                onRect(nextRect);
              }}
            >
              <img src={imageUrl} alt={`编辑抽帧 ${frame.index + 1}`} draggable={false} />
              {rect && (
                <span
                  className="frame-mask-rect"
                  style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.width * 100}%`,
                    height: `${rect.height * 100}%`
                  }}
                />
              )}
            </div>
          </div>
          <aside className="frame-mask-sidebar">
            <label>
              <span>打码方式</span>
              <select value={effect} onChange={(event) => onEffect(event.target.value as FrameMaskEffect)}>
                <option value="mosaic">马赛克</option>
                <option value="blur">模糊</option>
                <option value="solid">遮挡</option>
              </select>
            </label>
            <label>
              <span>强度</span>
              <input type="range" min={0.1} max={1} step={0.05} value={strength} onChange={(event) => onStrength(Number(event.target.value))} />
              <strong>{Math.round(strength * 100)}%</strong>
            </label>
            <div className="frame-mask-info">
              <strong>当前帧</strong>
              <span>#{frame.index + 1} · {formatTimestamp(frame.timestampSec)}</span>
              <span>{frame.modifiedImageUrl ? "已存在修改版，可继续叠加打码。" : "正在编辑原始抽帧。"}</span>
            </div>
            {error && <p className="frame-mask-error">{error}</p>}
            <div className="frame-mask-actions">
              <button className="secondary-button compact" onClick={() => onRect(undefined)} disabled={busy || !rect}>清除区域</button>
              <button className="primary-button compact" onClick={onApply} disabled={busy || !rect}>
                {busy ? "处理中..." : "保存修改帧"}
              </button>
            </div>
          </aside>
        </div>
      </section>
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
    outputs: videoUrl ? [{ id: originalOutputId, sourceClipId: id, lineageId, type: "original", provider: "import", videoUrl, localPath: sourceLocalPath, createdAt: now }] : [],
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
  const videoUrl = uploaded?.remoteAssetUrl || uploaded?.localAssetUrl || URL.createObjectURL(file);
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
    outputs: [{ id: originalOutputId, sourceClipId: id, lineageId, type: "original", provider: "upload", videoUrl, localPath: uploaded?.localPath, createdAt: now }],
    usageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

function createClipFromSplitSegment(sourceClip: MaterialClip, segment: SplitBridgeSegment, splitBatchId: string, now: string): MaterialClip {
  const id = createId("clip");
  const originalOutputId = createId("output");
  const parentOutput = getOriginalOutput(sourceClip);
  const title = `${sourceClip.title} ${String(segment.index + 1).padStart(2, "0")} ${formatRangeLabel(segment.startSec, segment.endSec)}`;
  return {
    id,
    lineageId: sourceClip.lineageId,
    parentClipId: sourceClip.id,
    sourceSegmentId: sourceClip.sourceSegmentId,
    sourceRange: {
      startSec: segment.startSec,
      endSec: segment.endSec,
      durationSec: segment.durationSec
    },
    splitBatchId,
    title,
    description: sourceClip.description,
    duration: segment.durationSec,
    originalVideoUrl: segment.videoUrl,
    sourceFileName: segment.fileName,
    sourceLocalPath: segment.localPath,
    sourceMimeType: "video/mp4",
    sourceSize: undefined,
    tags: sourceClip.tags.map((tag) => ({ ...tag, id: createId("tag"), source: "import" as const, createdAt: now })),
    customTags: [...sourceClip.customTags],
    preprocess: {
      id: createId("split"),
      sourceClipId: id,
      lineageId: sourceClip.lineageId,
      status: "done",
      method: "split",
      inputVideoUrl: sourceClip.originalVideoUrl,
      outputVideoUrl: segment.videoUrl,
      provider: "local-bridge",
      params: {
        resolution: "1080p",
        fps: 24,
        depthModel: "ffmpeg-split"
      },
      cost: { elapsedSec: 0, gpuSec: 0 },
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      updatedAt: now
    },
    aiJobs: [],
    outputs: [{
      id: originalOutputId,
      sourceClipId: id,
      lineageId: sourceClip.lineageId,
      parentOutputId: parentOutput?.id,
      type: "original",
      provider: "split",
      videoUrl: segment.videoUrl,
      localPath: segment.localPath,
      createdAt: now
    }],
    usageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

async function createImageMaterial(file: File, category: ImageLibraryCategory, now: string, projectId: string, bridgeUrl: string): Promise<ImageMaterial> {
  const id = createId("image");
  const lineageId = createId("lineage");
  const uploaded = await uploadWorkbenchAsset(file, "image", projectId, id, bridgeUrl);
  const imageUrl = uploaded?.remoteAssetUrl || uploaded?.localAssetUrl || URL.createObjectURL(file);
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

function localFileHref(localPath: string) {
  return `file://${localPath.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

function localAssetPathFromUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const marker = "/assets/";
    const index = url.pathname.indexOf(marker);
    if (index < 0) return undefined;
    const relativePath = decodeURIComponent(url.pathname.slice(index + marker.length));
    return `/Volumes/7up/github/videogen/.videogen-assets/${relativePath}`;
  } catch {
    return undefined;
  }
}

function seedanceSourceInput(clip: MaterialClip) {
  return {
    video: clip.sourceFile instanceof File ? clip.sourceFile : undefined,
    sourceLocalPath: clip.sourceLocalPath,
    sourceVideoUrl: persistentVideoUrl(clip),
    sourceVideoName: clip.sourceFileName || clip.title
  };
}

function seedanceDurationFromClip(clip: MaterialClip | undefined, probedDurationSec: number | undefined, fallback: number) {
  const duration = clip?.duration || probedDurationSec || fallback || 5;
  return Math.min(10, Math.max(3, Math.round(duration)));
}

function normalizeSeedanceDuration(value: number, clip: MaterialClip | undefined, probedDurationSec: number | undefined, fallback: number) {
  const defaultDuration = seedanceDurationFromClip(clip, probedDurationSec, fallback);
  const duration = Number.isFinite(value) ? value : defaultDuration;
  return Math.min(10, Math.max(3, Math.round(duration)));
}

function normalizeSplitTargetSec(value: number) {
  return Math.min(10, Math.max(1, Math.round(Number.isFinite(value) ? value : 10)));
}

function plannedFrameCountFromClip(clip: MaterialClip | undefined, fallbackDuration: number) {
  const duration = seedanceDurationFromClip(clip, undefined, fallbackDuration);
  return Math.min(frameReplacementMaxFrames, Math.max(1, Math.floor(duration)));
}

function renderAiPromptForMode(
  mode: AiGenerationMode,
  template: string,
  clip: MaterialClip | undefined,
  images: ImageMaterial[],
  transcript: VideoAiJob["transcript"] | undefined,
  fallbackDuration: number
) {
  const basePrompt = renderAiPrompt(template, clip, images);
  if (mode !== "frame_replacement") return basePrompt;
  const replacedFrameCount = clip?.productFrameReplacement?.status === "done"
    ? clip.productFrameReplacement.frames.filter((frame) => frame.imageUrl).length
    : 0;
  if (replacedFrameCount) {
    return buildProductFrameVideoPrompt({
      scriptPrompt: cleanFrameReplacementScript(template),
      transcript,
      frameCount: replacedFrameCount
    });
  }
  const productImages = images.filter((image) => image.category === "product");
  return buildFrameReplacementPrompt({
    scriptPrompt: cleanFrameReplacementScript(template),
    transcript,
    frameCount: plannedFrameCountFromClip(clip, fallbackDuration),
    productCount: Math.max(1, productImages.length || images.length)
  });
}

function buildProductFrameVideoPrompt(input: {
  scriptPrompt: string;
  transcript?: VideoAiJob["transcript"];
  frameCount: number;
}) {
  const frameRefs = formatImageRefs(1, input.frameCount);
  const transcriptText = input.transcript?.text?.trim();
  const scriptText = cleanFrameReplacementScript(input.scriptPrompt);
  return cleanRenderedAiPrompt([
    `参考${frameRefs}的画面节奏、镜头构图、人物动作、场景变化和已替换后的产品呈现。`,
    transcriptText ? `使用以下文案：${transcriptText}。` : "",
    scriptText ? `结合脚本：${scriptText}。` : "",
    "生成一条电商短视频，保持真实实拍质感，延续参考帧中的产品信息和展示方式。"
  ].filter(Boolean).join("\n"));
}

function buildFrameReplacementPrompt(input: {
  scriptPrompt: string;
  transcript?: VideoAiJob["transcript"];
  frameCount: number;
  productCount: number;
}) {
  const frameRefs = formatImageRefs(1, input.frameCount);
  const productStart = input.frameCount + 1;
  const productRefs = formatImageRefs(productStart, input.productCount);
  const transcriptText = input.transcript?.text?.trim();
  const scriptText = cleanFrameReplacementScript(input.scriptPrompt);
  return cleanRenderedAiPrompt([
    `参考${frameRefs}的画面节奏、镜头构图、人物动作和场景变化。`,
    `使用和替换为${productRefs}的产品信息，包括产品外观、颜色、包装、使用状态。`,
    transcriptText ? `使用以下文案：${transcriptText}。` : "",
    scriptText ? `结合脚本：${scriptText}。` : "",
    "生成一条电商短视频，保持真实实拍质感，突出产品卖点和转化氛围。"
  ].filter(Boolean).join("\n"));
}

function formatImageRefs(startIndex: number, count: number) {
  return Array.from({ length: Math.max(1, count) }, (_, index) => `【@图片${startIndex + index}】`).join("");
}

function cleanFrameReplacementScript(script: string) {
  return sanitizeAiPromptTemplate(script)
    .split("{imageInstruction}").join("")
    .split("{productInstruction}").join("")
    .split("{faceInstruction}").join("")
    .split("{styleInstruction}").join("")
    .split("{videoName}").join("")
    .split("{imageNames}").join("")
    .split("{productImages}").join("")
    .split("{faceImages}").join("")
    .split("{styleImages}").join("")
    .split("{imageRefs}").join("")
    .split("{productImageRefs}").join("")
    .split("{faceImageRefs}").join("")
    .split("{styleImageRefs}").join("")
    .split("{videoTags}").join("")
    .split("{imageTags}").join("")
    .replace(/全面参考【@视频1】视频[，,]?\s*/g, "")
    .replace(/参考【@视频1】视频[，,]?\s*/g, "")
    .replace(/保留视频声音。?/g, "")
    .trim();
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

function aiInputTypeLabel(type: VideoAiJob["inputAssetType"]) {
  if (type === "ai_output") return "AI产物";
  return outputTypeLabel(type);
}

function formatRangeLabel(startSec: number, endSec: number) {
  return `${formatTimestamp(startSec)}-${formatTimestamp(endSec)}`;
}

function formatTimestamp(totalSec: number) {
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
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
          content: sanitizeAiPromptTemplate(item.content),
          builtin: false
        }))
    ];
  } catch {
    return defaultAiPromptTemplates;
  }
}

function renderAiPrompt(template: string, clip?: MaterialClip, images: ImageMaterial[] = []) {
  const videoName = "";
  const imageNames = images.length ? "参考图片" : "";
  const productImages = images.some((image) => image.category === "product") ? "参考产品" : imageNames;
  const faceImages = images.some((image) => image.category === "face") ? "参考人脸" : "";
  const styleImages = images.some((image) => image.category === "other") ? "参考风格" : "";
  const imageRefs = formatSeedanceImageRefs(images);
  const productImageRefs = formatSeedanceImageRefs(images.filter((image) => image.category === "product"), images);
  const faceImageRefs = formatSeedanceImageRefs(images.filter((image) => image.category === "face"), images);
  const styleImageRefs = formatSeedanceImageRefs(images.filter((image) => image.category === "other"), images);
  const imageInstruction = images.length ? `，根据${imageRefs}更换产品信息` : "";
  const productInstruction = productImageRefs
    ? `，根据${productImageRefs}将产品信息替换为参考产品`
    : imageRefs
      ? `，根据${imageRefs}将产品信息替换为参考产品`
      : "";
  const faceInstruction = faceImageRefs ? `，人物或人脸参考${faceImageRefs}` : "";
  const styleInstruction = styleImageRefs ? `，风格参考${styleImageRefs}` : "";
  const videoTags = clip?.tags.map((tag) => tag.label).join("、") || "无";
  const imageTags = unique(images.flatMap((image) => image.tags.map((tag) => tag.label))).join("、") || "无";
  return cleanRenderedAiPrompt([
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
  ].reduce((text, [token, value]) => text.split(token).join(value), sanitizeAiPromptTemplate(template)));
}

function sanitizeAiPromptTemplate(template: string) {
  return template
    .split("《{videoName}》").join("")
    .split("《{imageNames}》").join("{imageNames}")
    .split("《{productImages}》").join("{productImages}")
    .split("《{faceImages}》").join("{faceImages}")
    .split("《{styleImages}》").join("{styleImages}");
}

function cleanRenderedAiPrompt(prompt: string) {
  return prompt
    .split("《》").join("")
    .replace(/《参考(图片|产品|人脸|风格)》/g, "参考$1")
    .replace(/\s+，/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/。{2,}/g, "。")
    .trim();
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
  seedanceSettings: SeedanceProviderConfig,
  generationMode: AiGenerationMode,
  transcript?: VideoAiJob["transcript"]
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
    generationMode,
    status: "queued" as const,
    prompt: prompt,
    referenceImageUrls: referenceImages.map((image) => image.imageUrl),
    transcript,
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

function buildAiMonitorStats(rows: Array<{ job: VideoAiJob }>, nowMs: number) {
  return rows.reduce(
    (stats, { job }) => {
      stats.total += 1;
      if (isAiJobActive(job)) stats.active += 1;
      if (job.status === "done") stats.done += 1;
      if (job.status === "failed") stats.failed += 1;
      stats.elapsedSec += displayAiJobElapsed(job, nowMs);
      stats.cash += job.cost.estimatedCash;
      return stats;
    },
    { total: 0, active: 0, done: 0, failed: 0, elapsedSec: 0, cash: 0 }
  );
}

function isAiJobActive(job: VideoAiJob) {
  return job.status === "queued" || job.status === "uploading" || job.status === "generating" || job.status === "capturing";
}

function displayAiJobElapsed(job: VideoAiJob, nowMs: number) {
  if (!isAiJobActive(job) && job.elapsedSec !== undefined) return job.elapsedSec;
  const startIso = job.startedAt || job.createdAt;
  return Math.max(0, Math.floor((nowMs - new Date(startIso).getTime()) / 1000));
}

function normalizeJobProgress(job: VideoAiJob) {
  if (job.status === "done") return 100;
  if (job.status === "failed") return job.progress ?? 0;
  if (job.progress !== undefined) return Math.max(0, Math.min(99, Math.round(job.progress)));
  if (job.status === "generating") return 35;
  if (job.status === "uploading") return 15;
  if (job.status === "capturing") return 82;
  return 5;
}

function formatDuration(totalSec: number) {
  const sec = Math.max(0, Math.floor(totalSec));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
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
  const quality = method === "split"
    ? `${clip.split?.segmentCount ?? 0} 个切片 · 每段 ≤10s`
    : method === "video_frame_extract"
    ? `${clip.frameExtraction?.frames.length ?? 0} 张抽帧 · ffmpeg`
    : method === "product_frame_replace"
    ? `${clip.productFrameReplacement?.frames.length ?? 0} 张替换帧 · image2 · ${formatImage2Cost(clip.productFrameReplacement)}`
    : method === "depth"
    ? `${record.params.inputSize ?? 518}px · ${record.params.letterbox === false ? "拉伸" : "Letterbox"} · 滤波 ${record.params.edgeFilterStrength ?? 0}`
    : "OpenCV 灰度转换";
  const runtime = `${quality} · 耗时 ${record.cost.elapsedSec}s`;
  if (record.status === "queued") return `${record.params.depthModel} · 已进入队列`;
  if (record.status === "processing") return `${record.params.depthModel} · 正在生成 · ${runtime}`;
  if (record.status === "done") return `${record.params.depthModel} · ${runtime}`;
  return `${record.params.depthModel} · 处理失败 · ${runtime}`;
}

function formatImage2Cost(record: ProductFrameReplacementRecord | undefined) {
  if (!record?.cost.estimatedUsd) return "$0.000000";
  const tokenText = record.cost.inputTokens !== undefined || record.cost.outputTokens !== undefined
    ? ` · in ${record.cost.inputTokens ?? 0} / out ${record.cost.outputTokens ?? 0}`
    : "";
  return `$${record.cost.estimatedUsd.toFixed(6)}${tokenText}`;
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

function formatSeedanceModelOption(item: (typeof SEEDANCE_MODEL_PRICING)[number]) {
  const stabilityNote = item.model.includes("_direct") ? " · 生成时间不稳定" : "";
  const mediaNote = item.supportsReferenceMedia ? " · 支持多模态参考" : " · 文生视频";
  return `${item.model} · ${item.resolution} · ¥${item.cnyPerSecond}/秒${mediaNote}${stabilityNote}`;
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
  if (method === "depth") return "深度视频";
  if (method === "grayscale") return "黑白视频";
  if (method === "video_frame_extract") return "视频抽帧";
  if (method === "product_frame_replace") return "产品信息替换";
  return "视频切分";
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

function renderAiJobStatus(job: VideoAiJob, nowMs = Date.now()) {
  if (job.status === "generating") {
    const progressText = job.progress !== undefined ? ` ${job.progress}%` : "";
    const remoteText = job.remoteStatus ? ` [${job.remoteStatus}]` : "";
    const elapsedText = ` ${formatDuration(displayAiJobElapsed(job, nowMs))}`;
    return `生成中${progressText}${remoteText}${elapsedText}`;
  }
  if (job.status === "done") {
    const elapsedText = job.elapsedSec !== undefined ? ` (${formatDuration(job.elapsedSec)})` : "";
    return `完成${elapsedText}`;
  }
  if (job.status === "failed") {
    const remoteText = job.remoteStatus ? ` [${job.remoteStatus}]` : "";
    return `失败${remoteText}`;
  }
  return aiStatusLabel(job.status);
}
