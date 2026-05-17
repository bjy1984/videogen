export const PROJECT_STORAGE_KEY = "videogen.currentProject";
export const PROMPT_STORAGE_KEY = "videogen.savedPrompt";

export function readSavedPrompt(fallback: string) {
  return localStorage.getItem(PROMPT_STORAGE_KEY) || fallback;
}

export function savePrompt(prompt: string) {
  localStorage.setItem(PROMPT_STORAGE_KEY, prompt);
}

export function saveProjectSnapshot(snapshot: unknown) {
  localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(snapshot));
}

export function loadProjectSnapshot<T>() {
  const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as T) : null;
}
