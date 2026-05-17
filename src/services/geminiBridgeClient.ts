import type { GeminiBridgeTask } from "../domain/geminiBridge";

export class GeminiBridgeTaskError extends Error {
  task: GeminiBridgeTask | null;

  constructor(message: string, task: GeminiBridgeTask | null) {
    super(message);
    this.name = "GeminiBridgeTaskError";
    this.task = task;
  }
}

export async function checkGeminiBridgeHealth(baseUrl: string) {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) throw new Error(`Bridge 状态异常：${response.status}`);
  return response.json() as Promise<{
    ok: boolean;
    service: string;
    port: number;
    profileDir: string;
    taskCount: number;
  }>;
}

export async function createGeminiBridgeTask(
  baseUrl: string,
  input: {
    projectId: string;
    projectName: string;
    prompt: string;
    video?: File;
  }
) {
  const formData = new FormData();
  formData.append("projectId", input.projectId);
  formData.append("projectName", input.projectName);
  formData.append("prompt", input.prompt);
  if (input.video) formData.append("video", input.video, input.video.name);

  const response = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    body: formData
  });

  return parseTaskResponse(response, `创建 Bridge 任务失败：${response.status}`);
}

export async function prepareGeminiBridgeTask(baseUrl: string, taskId: string) {
  const response = await fetch(`${baseUrl}/tasks/${taskId}/prepare`, {
    method: "POST"
  });

  return parseTaskResponse(response, `准备 Gemini 页面失败：${response.status}`);
}

export async function captureGeminiBridgeResult(baseUrl: string, taskId: string) {
  const response = await fetch(`${baseUrl}/tasks/${taskId}/capture`, {
    method: "POST"
  });

  return parseTaskResponse(response, `抓取 Gemini 回复失败：${response.status}`);
}

async function parseTaskResponse(response: Response, fallbackMessage: string) {
  const task = (await response.json()) as GeminiBridgeTask;
  if (!response.ok) {
    throw new GeminiBridgeTaskError(lastTaskLog(task) || fallbackMessage, task);
  }
  return task;
}

export function lastTaskLog(task: GeminiBridgeTask) {
  return task.logs[task.logs.length - 1];
}
