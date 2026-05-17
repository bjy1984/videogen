import { createId } from "../../../services/id";
import { createSeedanceBridgeTask, getSeedanceBridgeTask } from "../../../services/videoGenerationBridgeClient";
import type { GenerationJob, GenerationJobInput } from "../generationTypes";
import {
  buildSeedanceCreateTaskRequest,
  extractSeedanceTaskError,
  mapSeedanceTaskStatus,
  type SeedanceProviderParams
} from "./seedanceArk";
import type { VideoGenerationProvider } from "./providerTypes";

const jobs = new Map<string, GenerationJob>();

export const seedanceVideoProvider: VideoGenerationProvider = {
  id: "seedance",
  label: "Seedance",
  capabilities: ["text-to-video", "image-to-video", "reference-image", "seed"],
  async createJob(input: GenerationJobInput) {
    const now = new Date().toISOString();
    try {
      const params = input.providerParams as SeedanceProviderParams | undefined;
      const request = buildSeedanceCreateTaskRequest({
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        duration: input.duration,
        referenceImageUrl: input.referenceImageUrl,
        params
      });
      const task = await createSeedanceBridgeTask({
        bridgeUrl: params?.bridgeUrl,
        request
      });
      const job: GenerationJob = {
        id: task.id || createId("job_seedance"),
        remoteJobId: task.id,
        remoteStatus: task.status,
        input,
        status: task.status ? mapSeedanceTaskStatus(task.status) : "queued",
        createdAt: now,
        updatedAt: new Date().toISOString(),
        resultVideoUrl: task.content?.video_url,
        resultLastFrameUrl: task.content?.last_frame_url,
        providerResponse: task,
        error: extractSeedanceTaskError(task)
      };
      jobs.set(job.id, job);
      return job;
    } catch (error) {
      const job: GenerationJob = {
        id: createId("job_seedance_failed"),
        input,
        status: "failed",
        createdAt: now,
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Seedance 任务创建失败。"
      };
      jobs.set(job.id, job);
      return job;
    }
  },
  async getJob(jobId: string) {
    const current = jobs.get(jobId);
    if (!current?.remoteJobId) return current ?? null;
    try {
      const params = current.input.providerParams as SeedanceProviderParams | undefined;
      const request = buildSeedanceCreateTaskRequest({
        prompt: current.input.prompt,
        aspectRatio: current.input.aspectRatio,
        duration: current.input.duration,
        referenceImageUrl: current.input.referenceImageUrl,
        params
      });
      const task = await getSeedanceBridgeTask({
        bridgeUrl: params?.bridgeUrl,
        endpoint: request.endpoint,
        apiKeyEnvName: request.apiKeyEnvName,
        taskId: current.remoteJobId
      });
      const next: GenerationJob = {
        ...current,
        remoteStatus: task.status,
        status: mapSeedanceTaskStatus(task.status),
        updatedAt: new Date().toISOString(),
        resultVideoUrl: task.content?.video_url,
        resultLastFrameUrl: task.content?.last_frame_url,
        providerResponse: task,
        error: extractSeedanceTaskError(task)
      };
      jobs.set(next.id, next);
      return next;
    } catch (error) {
      const failed: GenerationJob = {
        ...current,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Seedance 任务查询失败。"
      };
      jobs.set(failed.id, failed);
      return failed;
    }
  }
};
