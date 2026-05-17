import { generationProviders } from "../app/workflow";
import type { Provider, VideoSegment } from "../types";

export function providerLabel(value: Provider) {
  return generationProviders.find((provider) => provider.value === value)?.label ?? value;
}

export function segmentStatusLabel(status: VideoSegment["status"]) {
  const labels = {
    idle: "待生成",
    queued: "排队中",
    generating: "生成中",
    done: "已完成",
    failed: "失败"
  };
  return labels[status];
}
