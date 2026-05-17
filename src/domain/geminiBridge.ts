export interface GeminiBridgeTask {
  id: string;
  projectId: string;
  projectName: string;
  videoOriginalName?: string;
  status: string;
  resultText: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
}
