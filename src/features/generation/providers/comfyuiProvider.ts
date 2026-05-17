import { createId } from "../../../services/id";
import { createComfyUIBridgeTask, getComfyUIBridgeTask } from "../../../services/videoGenerationBridgeClient";
import type { GenerationJob, GenerationJobInput } from "../generationTypes";
import {
  buildComfyUICreateTaskRequest,
  extractComfyUITaskError,
  mapComfyUITaskStatus,
  selectBestComfyUIOutputFile,
  type ComfyUIProviderParams
} from "./comfyuiApi";
import type { VideoGenerationProvider } from "./providerTypes";

const jobs = new Map<string, GenerationJob>();

export const comfyuiVideoProvider: VideoGenerationProvider = {
  id: "comfyui",
  label: "ComfyUI",
  capabilities: ["text-to-video", "image-to-video", "video-to-video", "reference-image", "seed", "local-workflow"],
  async createJob(input: GenerationJobInput) {
    const now = new Date().toISOString();
    try {
      const params = input.providerParams as ComfyUIProviderParams | undefined;
      const request = buildComfyUICreateTaskRequest({
        prompt: input.prompt,
        duration: input.duration,
        aspectRatio: input.aspectRatio,
        referenceImageUrl: input.referenceImageUrl,
        params
      });
      const task = await createComfyUIBridgeTask({
        bridgeUrl: params?.bridgeUrl,
        request
      });
      const output = selectBestComfyUIOutputFile(task.outputFiles, request.outputNodeId);
      const job: GenerationJob = {
        id: task.promptId || task.id || createId("job_comfyui"),
        remoteJobId: task.promptId || task.id,
        remoteStatus: task.status,
        input,
        status: mapComfyUITaskStatus(task.status),
        createdAt: now,
        updatedAt: new Date().toISOString(),
        resultVideoUrl: output?.viewUrl,
        providerResponse: task,
        error: extractComfyUITaskError(task)
      };
      jobs.set(job.id, job);
      return job;
    } catch (error) {
      const job: GenerationJob = {
        id: createId("job_comfyui_failed"),
        input,
        status: "failed",
        createdAt: now,
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "ComfyUI 任务创建失败。"
      };
      jobs.set(job.id, job);
      return job;
    }
  },
  async getJob(jobId: string) {
    const current = jobs.get(jobId);
    if (!current?.remoteJobId) return current ?? null;
    try {
      const params = current.input.providerParams as ComfyUIProviderParams | undefined;
      const request = buildComfyUICreateTaskRequest({
        prompt: current.input.prompt,
        duration: current.input.duration,
        aspectRatio: current.input.aspectRatio,
        referenceImageUrl: current.input.referenceImageUrl,
        params
      });
      const task = await getComfyUIBridgeTask({
        bridgeUrl: params?.bridgeUrl,
        endpoint: request.endpoint,
        taskId: current.remoteJobId
      });
      const output = selectBestComfyUIOutputFile(task.outputFiles, request.outputNodeId);
      const next: GenerationJob = {
        ...current,
        remoteStatus: task.status,
        status: mapComfyUITaskStatus(task.status),
        updatedAt: new Date().toISOString(),
        resultVideoUrl: output?.viewUrl,
        providerResponse: task,
        error: extractComfyUITaskError(task)
      };
      jobs.set(next.id, next);
      return next;
    } catch (error) {
      const failed: GenerationJob = {
        ...current,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "ComfyUI 任务查询失败。"
      };
      jobs.set(failed.id, failed);
      return failed;
    }
  }
};
