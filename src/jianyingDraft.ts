import JSZip from "jszip";
import type { GenerationOptions, VideoSegment } from "./types";

interface ExportDraftInput {
  projectName: string;
  segments: VideoSegment[];
  options: GenerationOptions;
  sourceVideo?: File;
}

const canvasByRatio = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 }
} satisfies Record<GenerationOptions["aspectRatio"], { width: number; height: number }>;

export async function exportJianyingDraftPackage(input: ExportDraftInput) {
  const projectName = sanitizeName(input.projectName || "videogen_jianying_draft");
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
  const mediaEntries = await Promise.all(
    input.segments.map((segment, index) => createMediaEntry(segment, index, input.sourceVideo))
  );

  for (const entry of mediaEntries) {
    if (entry.file && mediaFolder) {
      mediaFolder.file(entry.fileName, await entry.file.arrayBuffer());
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
    segments: input.segments,
    mediaEntries
  });
  const draftMetaInfo = buildDraftMetaInfo({
    draftId,
    projectName,
    now,
    options: input.options,
    segmentCount: input.segments.length
  });

  root.file("draft_content.json", JSON.stringify(draftContent, null, 2));
  root.file("draft_meta_info.json", JSON.stringify(draftMetaInfo, null, 2));
  root.file("draft_info.json", JSON.stringify(draftContent, null, 2));
  scriptFolder?.file("segments.json", JSON.stringify(input.segments, null, 2));
  subtitleFolder?.file("subtitles.srt", buildSrt(input.segments));
  root.file("README.md", buildReadme(projectName));

  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, `${projectName}.zip`);
}

function buildDraftContent(input: {
  draftId: string;
  projectName: string;
  now: string;
  options: GenerationOptions;
  segments: VideoSegment[];
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
    missing: !entry.file
  }));

  const textMaterials = input.segments.map((segment, index) => ({
    id: createId(`text_${index + 1}`),
    type: "text",
    content: segment.scriptText,
    name: `${segment.title} 脚本`,
    font_size: 42,
    alignment: "center",
    color: "#ffffff"
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
  const textSegments = input.segments.map((segment, index) => {
    const duration = secondsToMicroseconds(segment.duration);
    const start = cursor;
    cursor += duration;
    return {
      id: createId("caption"),
      material_id: textMaterials[index].id,
      render_index: 1,
      target_timerange: {
        start,
        duration
      },
      text: segment.scriptText
    };
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
      texts: textMaterials,
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
        id: createId("track_text"),
        type: "text",
        attribute: 0,
        flag: 0,
        segments: textSegments
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

function buildSrt(segments: VideoSegment[]) {
  let cursor = 0;
  return segments
    .map((segment, index) => {
      const start = cursor;
      const end = cursor + segment.duration;
      cursor = end;
      return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${segment.scriptText}\n`;
    })
    .join("\n");
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

Jianying/CapCut draft structures are version-sensitive. For production use, create a blank draft in the target desktop version, then calibrate this adapter against that template.
`;
}

interface MediaEntry {
  materialId: string;
  segmentTitle: string;
  relativePath: string;
  fileName: string;
  file?: File;
  durationUs: number;
}

async function createMediaEntry(segment: VideoSegment, index: number, fallback?: File): Promise<MediaEntry> {
  const file = segment.sourceFile ?? fallback;
  const ext = file ? getExtension(file.name) : "placeholder.txt";
  const fileName = `segment_${String(index + 1).padStart(2, "0")}_${sanitizeName(segment.id)}.${ext}`;

  return {
    materialId: createId(`material_${index + 1}`),
    segmentTitle: segment.title,
    relativePath: `material/import/${fileName}`,
    fileName,
    file,
    durationUs: secondsToMicroseconds(segment.duration)
  };
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

function sanitizeName(name: string) {
  return name
    .trim()
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
