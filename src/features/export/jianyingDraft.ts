import JSZip from "jszip";
import { downloadBlob, sanitizeFileName } from "../../services/fileDownload";
import { createId } from "../../services/id";
import type { GenerationOptions, VideoSegment } from "../../types";
import type { ComposeTimeline, TimelineClip } from "../compose/composeTypes";
import type { FinalVideoRun } from "../lineage/lineageTypes";
import type { MaterialBucket } from "../remix/remixTypes";

export interface ExportDraftInput {
  projectName: string;
  segments?: VideoSegment[];
  timeline?: ComposeTimeline;
  materialBuckets?: MaterialBucket[];
  lineage?: FinalVideoRun;
  options: GenerationOptions;
  sourceVideo?: File;
}

const canvasByRatio = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 }
} satisfies Record<GenerationOptions["aspectRatio"], { width: number; height: number }>;

export async function exportJianyingDraftPackage(input: ExportDraftInput) {
  const { blob, fileName } = await buildJianyingDraftPackage(input);
  downloadBlob(blob, fileName);
}

export async function buildJianyingDraftPackage(input: ExportDraftInput) {
  const projectName = sanitizeFileName(input.projectName || "videogen_jianying_draft", "videogen_jianying_draft");
  const draftId = createId("draft");
  const now = new Date().toISOString();
  const zip = new JSZip();
  const root = zip.folder(projectName);

  if (!root) {
    throw new Error("无法创建剪映草稿目录");
  }

  const mediaFolder = root.folder("material/import");
  const scriptFolder = root.folder("scripts");
  const subtitleFolder = root.folder("subtitles");
  const clips = input.timeline ? input.timeline.clips : clipsFromSegments(input.segments ?? []);
  const mediaEntries = await Promise.all(
    clips.map((clip, index) => createMediaEntry(clip, index, input.sourceVideo))
  );

  for (const entry of mediaEntries) {
    if (entry.file && mediaFolder) {
      mediaFolder.file(entry.fileName, await entry.file.arrayBuffer());
    } else if (entry.blob && mediaFolder) {
      mediaFolder.file(entry.fileName, await entry.blob.arrayBuffer());
    } else if (mediaFolder) {
      mediaFolder.file(
        entry.fileName,
        `Placeholder for ${entry.segmentTitle}. Replace this file with a generated video clip before importing.`
      );
    }
  }

  const draftContent = buildDraftContent({
    draftId,
    projectName,
    now,
    options: input.options,
    clips,
    mediaEntries
  });
  const draftMetaInfo = buildDraftMetaInfo({
    draftId,
    projectName,
    now,
    options: input.options,
    segmentCount: clips.length
  });

  root.file("draft_content.json", JSON.stringify(draftContent, null, 2));
  root.file("draft_meta_info.json", JSON.stringify(draftMetaInfo, null, 2));
  root.file("draft_info.json", JSON.stringify(draftContent, null, 2));
  scriptFolder?.file("segments.json", JSON.stringify(input.segments ?? [], null, 2));
  if (input.timeline) root.file("timeline.json", JSON.stringify(serializeTimeline(input.timeline), null, 2));
  if (input.materialBuckets) root.file("assets.json", JSON.stringify(serializeBuckets(input.materialBuckets), null, 2));
  if (input.lineage) root.file("lineage.json", JSON.stringify(input.lineage, null, 2));
  subtitleFolder?.file("subtitles.srt", buildSrt(clips));
  subtitleFolder?.file("text_manifest.json", JSON.stringify(buildTextManifest(clips), null, 2));
  root.file("README.md", buildReadme(projectName));

  const blob = await zip.generateAsync({ type: "blob" });
  return {
    blob,
    fileName: `${projectName}.zip`
  };
}

function buildDraftContent(input: {
  draftId: string;
  projectName: string;
  now: string;
  options: GenerationOptions;
  clips: DraftClip[];
  mediaEntries: MediaEntry[];
}) {
  const canvas = canvasByRatio[input.options.aspectRatio];
  let cursor = 0;
  const videoMaterials = input.mediaEntries.map((entry) => ({
    id: entry.materialId,
    type: "video",
    name: entry.segmentTitle,
    path: entry.relativePath,
    duration: entry.durationUs,
    width: canvas.width,
    height: canvas.height,
    local_material_id: entry.materialId,
    category_name: "local",
    extra_info: "generated_by_videogen",
    missing: !entry.file && !entry.blob
  }));

  const subtitleMaterials = input.options.subtitles
    ? input.clips.map((clip, index) => ({
        id: createId(`subtitle_${index + 1}`),
        type: "text",
        content: subtitleTextForClip(clip),
        name: `${clip.title} 字幕`,
        font_size: 42,
        alignment: "center",
        color: "#ffffff",
        style: "subtitle"
      }))
    : [];
  const overlayMaterials = input.clips
    .map((clip, index) => ({
      clip,
      material: {
        id: createId(`overlay_${index + 1}`),
        type: "text",
        content: (clip.overlayText || "").trim(),
        name: `${clip.title} 贴片`,
        font_size: 58,
        alignment: "center",
        color: "#ffffff",
        style: "overlay"
      }
    }))
    .filter((item) => item.material.content);
  const textMaterials = [...subtitleMaterials, ...overlayMaterials.map((item) => item.material)];

  const scriptMaterials = input.clips.map((clip, index) => ({
    id: createId(`script_${index + 1}`),
    type: "text",
    content: clip.scriptText,
    name: `${clip.title} 脚本`,
    font_size: 32,
    alignment: "left",
    color: "#dfe8e3",
    style: "script-note"
  }));

  const videoSegments = input.mediaEntries.map((entry) => {
    const start = cursor;
    cursor += entry.durationUs;
    return {
      id: createId("segment"),
      material_id: entry.materialId,
      render_index: 0,
      source_timerange: {
        start: 0,
        duration: entry.durationUs
      },
      target_timerange: {
        start,
        duration: entry.durationUs
      },
      speed: 1,
      volume: 1,
      extra_material_refs: []
    };
  });

  cursor = 0;
  const subtitleSegments = subtitleMaterials.map((material, index) => {
    const clip = input.clips[index];
    const duration = secondsToMicroseconds(clip.duration);
    const start = cursor;
    cursor += duration;
    return {
      id: createId("caption"),
      material_id: material.id,
      render_index: 1,
      target_timerange: {
        start,
        duration
      },
      text: material.content,
      role: "subtitle"
    };
  });
  cursor = 0;
  const overlaySegments = input.clips.flatMap((clip) => {
    const duration = secondsToMicroseconds(clip.duration);
    const start = cursor;
    cursor += duration;
    const item = overlayMaterials.find((entry) => entry.clip.id === clip.id);
    if (!item) return [];
    return [{
      id: createId("overlay"),
      material_id: item.material.id,
      render_index: 2,
      target_timerange: {
        start,
        duration
      },
      text: item.material.content,
      role: "overlay"
    }];
  });

  return {
    id: input.draftId,
    name: input.projectName,
    version: "videogen-draft-adapter-0.1",
    created_at: input.now,
    updated_at: input.now,
    platform: "web",
    fps: 30,
    duration: input.mediaEntries.reduce((total, entry) => total + entry.durationUs, 0),
    canvas_config: {
      ratio: input.options.aspectRatio,
      width: canvas.width,
      height: canvas.height
    },
    materials: {
      videos: videoMaterials,
      texts: [...textMaterials, ...scriptMaterials],
      audios: [],
      effects: [],
      transitions: []
    },
    tracks: [
      {
        id: createId("track_video"),
        type: "video",
        attribute: 0,
        flag: 0,
        segments: videoSegments
      },
      {
        id: createId("track_subtitle"),
        type: "text",
        attribute: 0,
        flag: 0,
        segments: subtitleSegments
      },
      {
        id: createId("track_overlay"),
        type: "text",
        attribute: 0,
        flag: 0,
        segments: overlaySegments
      }
    ],
    extra: {
      provider: input.options.provider,
      style: input.options.style,
      resolution: input.options.resolution,
      subtitles: input.options.subtitles,
      compatibility_note:
        "Jianying/CapCut draft fields vary by desktop version. Use this package as an adapter output and calibrate against a local blank draft template when needed."
    }
  };
}

function buildDraftMetaInfo(input: {
  draftId: string;
  projectName: string;
  now: string;
  options: GenerationOptions;
  segmentCount: number;
}) {
  return {
    id: input.draftId,
    name: input.projectName,
    draft_version: "template-compatible",
    app: "JianyingPro/CapCut",
    create_time: input.now,
    modify_time: input.now,
    segment_count: input.segmentCount,
    canvas: canvasByRatio[input.options.aspectRatio],
    source: "videogen-workflow",
    note:
      "This metadata is generated for a draft-package workflow. Exact Jianying import behavior depends on the installed desktop version."
  };
}

function buildSrt(clips: DraftClip[]) {
  let cursor = 0;
  return clips
    .map((clip, index) => {
      const start = cursor;
      const end = cursor + clip.duration;
      cursor = end;
      return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${subtitleTextForClip(clip)}\n`;
    })
    .join("\n");
}

function buildTextManifest(clips: DraftClip[]) {
  return {
    clips: clips.map((clip, index) => ({
      order: index + 1,
      clipId: clip.id,
      title: clip.title,
      scriptText: clip.scriptText,
      subtitleText: subtitleTextForClip(clip),
      overlayText: (clip.overlayText || "").trim()
    }))
  };
}

function buildReadme(projectName: string) {
  return `# ${projectName}

This package is generated by videogen.

Contents:
- draft_content.json: timeline, materials, text tracks and segment timing.
- draft_meta_info.json: project-level metadata.
- draft_info.json: compatibility copy for CapCut/Jianying variants.
- material/import/: generated or placeholder media files.
- scripts/segments.json: editable segment scripts and generation prompts.
- subtitles/subtitles.srt: subtitle timing generated from segment durations.
- subtitles/text_manifest.json: script, subtitle and overlay text provenance.

Jianying/CapCut draft structures are version-sensitive. For production use, create a blank draft in the target desktop version, then calibrate this adapter against that template.
`;
}

interface MediaEntry {
  materialId: string;
  segmentTitle: string;
  relativePath: string;
  fileName: string;
  file?: File;
  blob?: Blob;
  durationUs: number;
}

interface DraftClip {
  id: string;
  title: string;
  scriptText: string;
  subtitleText?: string;
  overlayText?: string;
  duration: number;
  videoUrl?: string;
  sourceFile?: File;
}

async function createMediaEntry(clip: DraftClip, index: number, fallback?: File): Promise<MediaEntry> {
  const file = clip.sourceFile ?? fallback;
  const blob = file ? undefined : await fetchClipBlob(clip.videoUrl);
  const ext = file ? getExtension(file.name) : blob ? getExtensionFromUrl(clip.videoUrl) : "placeholder.txt";
  const fileName = `segment_${String(index + 1).padStart(2, "0")}_${sanitizeFileName(clip.id)}.${ext}`;

  return {
    materialId: createId(`material_${index + 1}`),
    segmentTitle: clip.title,
    relativePath: `material/import/${fileName}`,
    fileName,
    file,
    blob,
    durationUs: secondsToMicroseconds(clip.duration)
  };
}

function clipsFromSegments(segments: VideoSegment[]): DraftClip[] {
  return segments.map((segment) => ({
    id: segment.id,
    title: segment.title,
    scriptText: segment.scriptText,
    subtitleText: segment.subtitleText,
    overlayText: segment.overlayText,
    duration: segment.duration,
    videoUrl: segment.videoUrl,
    sourceFile: segment.sourceFile
  }));
}

function subtitleTextForClip(clip: DraftClip) {
  return (clip.subtitleText || clip.scriptText).trim();
}

function serializeTimeline(timeline: ComposeTimeline) {
  return {
    ...timeline,
    clips: timeline.clips.map(({ sourceFile, ...clip }) => clip)
  };
}

function serializeBuckets(buckets: MaterialBucket[]) {
  return buckets.map((bucket) => ({
    ...bucket,
    assets: bucket.assets.map(({ sourceFile, ...asset }) => asset)
  }));
}

function secondsToMicroseconds(seconds: number) {
  return Math.max(1, Math.round(seconds * 1_000_000));
}

function formatSrtTime(seconds: number) {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, "0")}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function getExtension(name: string) {
  const match = name.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "mp4";
}

function getExtensionFromUrl(url?: string) {
  if (!url) return "mp4";
  const cleanUrl = url.split("?")[0] || "";
  return getExtension(cleanUrl);
}

async function fetchClipBlob(url?: string) {
  if (!url || url.startsWith("blob:")) return undefined;
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    return await response.blob();
  } catch {
    return undefined;
  }
}
