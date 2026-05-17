export type GeminiBridgeHealth = "unknown" | "online" | "offline";

export function bridgeHealthLabel(value: GeminiBridgeHealth) {
  const labels = {
    unknown: "未检查",
    online: "Bridge在线",
    offline: "Bridge离线"
  };
  return labels[value];
}

export function bridgeTaskStatusLabel(value: string) {
  const labels: Record<string, string> = {
    created: "任务已创建",
    "browser-opened": "Gemini已打开",
    "prompt-filled": "Prompt已填入",
    "video-attached": "视频已挂载",
    "ready-for-user-send": "等待用户发送",
    "capture-ready": "已抓取回复",
    error: "任务异常"
  };
  return labels[value] ?? value;
}
