import { createId } from "../../../services/id";
import type { GenerationJob, GenerationJobInput } from "../generationTypes";
import type { VideoGenerationProvider } from "./providerTypes";

const jobs = new Map<string, GenerationJob>();

export const mockVideoProvider: VideoGenerationProvider = {
  id: "mock",
  label: "Local Mock",
  capabilities: ["text-to-video", "image-to-video", "video-to-video", "reference-image"],
  async createJob(input: GenerationJobInput) {
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: createId("job_mock"),
      input,
      status: "done",
      createdAt: now,
      updatedAt: now
    };
    jobs.set(job.id, job);
    return job;
  },
  async getJob(jobId: string) {
    return jobs.get(jobId) ?? null;
  }
};
