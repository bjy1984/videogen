export const PROJECT_STORAGE_KEY = "videogen.currentProject";
export const PROMPT_STORAGE_KEY = "videogen.savedPrompt";

export function readSavedPrompt(fallback: string) {
  try {
    return localStorage.getItem(PROMPT_STORAGE_KEY) || fallback;
  } catch {
    return fallback;
  }
}

export function savePrompt(prompt: string) {
  try {
    localStorage.setItem(PROMPT_STORAGE_KEY, prompt);
  } catch (error) {
    throw new Error(storageErrorMessage(error, "Prompt"));
  }
}

export function saveProjectSnapshot(snapshot: unknown) {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    throw new Error(storageErrorMessage(error, "工程"));
  }
}

export function loadProjectSnapshot<T>() {
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function storageErrorMessage(error: unknown, target: string) {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return `${target}保存失败：浏览器本地存储空间不足，请导出 JSON 后清理旧数据。`;
  }
  return `${target}保存失败：浏览器本地存储不可用。`;
}
