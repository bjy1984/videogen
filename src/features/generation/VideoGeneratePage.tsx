import { Boxes, Edit3, Film, Image as ImageIcon, Loader2, Plus, RefreshCw, Trash2, Upload, Wand2 } from "lucide-react";
import type { KeyboardEvent } from "react";
import { generationProviders } from "../../app/workflow";
import { providerLabel, segmentStatusLabel } from "../../domain/labels";
import type { GenerationOptions, Provider, VideoSegment } from "../../types";
import type { VideoGenerationBridgeHealth } from "../../services/videoGenerationBridgeClient";
import type { MaterialBucket, OperationDecisionState } from "../remix/remixTypes";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import type { ProviderSettings } from "./providers/providerConfig";

export function VideoGeneratePage({
  options,
  providerSettings,
  videoBridgeHealth,
  isVideoBridgeBusy,
  isGenerationPolling,
  segments,
  materialBuckets,
  sourcePreviewUrl,
  onOptions,
  onProviderSettings,
  onCheckVideoBridge,
  onSegment,
  onCreate,
  onGenerate,
  onGenerateRemixBuckets,
  onRefreshGenerationResults,
  onAssetMaxUses,
  onAssetToggle,
  onAssetRegenerate,
  onAssetOperationState,
  onAddCustomBucket,
  onRenameBucket,
  onDeleteBucket,
  onBack,
  onNext
}: {
  options: GenerationOptions;
  providerSettings: ProviderSettings;
  videoBridgeHealth: VideoGenerationBridgeHealth | null;
  isVideoBridgeBusy: boolean;
  isGenerationPolling: boolean;
  segments: VideoSegment[];
  materialBuckets: MaterialBucket[];
  sourcePreviewUrl: string;
  onOptions: (patch: Partial<GenerationOptions>) => void;
  onProviderSettings: (settings: ProviderSettings) => void;
  onCheckVideoBridge: () => void;
  onSegment: (id: string, patch: Partial<VideoSegment>) => void;
  onCreate: () => void;
  onGenerate: () => void;
  onGenerateRemixBuckets: () => void;
  onRefreshGenerationResults: () => void;
  onAssetMaxUses: (assetId: string, maxUses: number) => void;
  onAssetToggle: (assetId: string) => void;
  onAssetRegenerate: (assetId: string) => void;
  onAssetOperationState: (assetId: string, operationState: OperationDecisionState) => void;
  onAddCustomBucket: () => void;
  onRenameBucket: (bucketId: string) => void;
  onDeleteBucket: (bucketId: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <section className="workspace two-columns generate-layout">
      <div className="panel script-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Page 4</p>
            <h2>分段视频生成</h2>
          </div>
          <button className="secondary-button" onClick={onBack}>返回脚本页</button>
        </div>

        <div className="control-grid">
          <label>
            <span>视频模型</span>
            <select
              value={options.provider}
              onChange={(event) => onOptions({ provider: event.target.value as Provider })}
            >
              {generationProviders.map((provider) => (
                <option value={provider.value} key={provider.value}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>画幅</span>
            <select
              value={options.aspectRatio}
              onChange={(event) => onOptions({ aspectRatio: event.target.value as GenerationOptions["aspectRatio"] })}
            >
              <option value="9:16">9:16 竖屏</option>
              <option value="16:9">16:9 横屏</option>
              <option value="1:1">1:1 方屏</option>
            </select>
          </label>
          <label>
            <span>清晰度</span>
            <select
              value={options.resolution}
              onChange={(event) => onOptions({ resolution: event.target.value as GenerationOptions["resolution"] })}
            >
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
            </select>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={options.subtitles}
              onChange={(event) => onOptions({ subtitles: event.target.checked })}
            />
            <span>生成字幕轨道</span>
          </label>
        </div>

        <label className="field-label" htmlFor="style-input">统一风格</label>
        <input
          id="style-input"
          className="text-input"
          value={options.style}
          onChange={(event) => onOptions({ style: event.target.value })}
        />

        <ProviderSettingsPanel
          providerId={options.provider}
          settings={providerSettings}
          onSettings={onProviderSettings}
        />
        {(options.provider === "seedance" || options.provider === "comfyui") && (
          <div className="bridge-status-card">
            <div>
              <strong>Video Bridge</strong>
              <small>{bridgeStatusText(options.provider, videoBridgeHealth)}</small>
            </div>
            <button className="secondary-button compact" onClick={onCheckVideoBridge} disabled={isVideoBridgeBusy}>
              {isVideoBridgeBusy ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              检查
            </button>
          </div>
        )}

        {!segments.length ? (
          <div className="empty-state compact-empty">
            <Film size={38} />
            <strong>当前工程暂无生成队列</strong>
            <span>可以先创建五段脚本，再生成素材。</span>
            <button className="secondary-button" onClick={onCreate}>创建生成队列</button>
          </div>
        ) : (
          <div className="segment-editor-list relaxed">
            {segments.map((segment) => (
              <article className="segment-editor" key={segment.id}>
                <div className="card-title-row">
                  <div>
                    <h3>{segment.title}</h3>
                    <small>{segment.role} · {segment.duration}秒 · {providerLabel(segment.provider)}</small>
                  </div>
                  <span className={`status ${segment.status}`}>{segmentStatusLabel(segment.status)}</span>
                </div>
                <label>
                  <span>生成提示语</span>
                  <textarea
                    value={segment.generationPrompt}
                    onChange={(event) => onSegment(segment.id, { generationPrompt: event.target.value })}
                  />
                </label>
                <div className="reference-image-section">
                  <span className="section-label">参考图片</span>
                  <div className="reference-image-content">
                    {segment.referenceImageUrl ? (
                      <div className="reference-thumbnail-wrapper">
                        <img className="reference-thumbnail" src={segment.referenceImageUrl} alt="Reference" />
                        <button
                          className="icon-button delete-reference"
                          onClick={() => onSegment(segment.id, { referenceImageUrl: undefined, referenceImageFile: undefined })}
                          title="移除参考图"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div className="reference-thumbnail-placeholder">
                        <ImageIcon size={24} />
                        <span>无参考图</span>
                      </div>
                    )}
                    <div className="reference-actions">
                      <label
                        className="secondary-button compact"
                        tabIndex={0}
                        role="button"
                        aria-label={`为 ${segment.title} 上传参考图片`}
                        onKeyDown={triggerNestedFileInput}
                      >
                        <Upload size={14} />
                        上传图片
                        <input
                          type="file"
                          accept="image/*"
                          style={{ display: "none" }}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              const url = URL.createObjectURL(file);
                              onSegment(segment.id, { referenceImageFile: file, referenceImageUrl: url });
                            }
                            event.target.value = "";
                          }}
                        />
                      </label>
                      <button
                        className="secondary-button compact"
                        disabled={segment.isGeneratingImage}
                        onClick={() => {
                          onSegment(segment.id, { isGeneratingImage: true });
                          setTimeout(() => {
                            const mockUrl = `https://images.unsplash.com/photo-1616423640778-28d1b53229bd?w=400&q=80&random=${segment.id}`;
                            onSegment(segment.id, { isGeneratingImage: false, referenceImageUrl: mockUrl });
                          }, 2000);
                        }}
                      >
                        {segment.isGeneratingImage ? <Loader2 className="spin" size={14} /> : <ImageIcon size={14} />}
                        {segment.isGeneratingImage ? "生成中..." : "生成参考图"}
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="panel preview-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Generation Queue</p>
            <h2>素材预览</h2>
          </div>
          <div className="button-row">
            <button className="secondary-button" onClick={onAddCustomBucket}>
              <Plus size={16} />
              自定义桶
            </button>
            <button className="secondary-button" onClick={onGenerate}>
              <Wand2 size={16} />
              模拟分段
            </button>
            <button className="primary-button compact" onClick={onGenerateRemixBuckets}>
              <Boxes size={18} />
              生成素材桶
            </button>
            <button className="secondary-button" onClick={onRefreshGenerationResults} disabled={isGenerationPolling}>
              {isGenerationPolling ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
              轮询结果
            </button>
          </div>
        </div>

        <MaterialBucketGrid
          buckets={materialBuckets}
          onAssetMaxUses={onAssetMaxUses}
          onAssetToggle={onAssetToggle}
          onAssetRegenerate={onAssetRegenerate}
          onAssetOperationState={onAssetOperationState}
          onRenameBucket={onRenameBucket}
          onDeleteBucket={onDeleteBucket}
        />

        <SegmentVideoGrid segments={segments} sourcePreviewUrl={sourcePreviewUrl} />

        <div className="bottom-actions">
          <button className="secondary-button" onClick={onBack}>上一步</button>
          <button className="primary-button" onClick={onNext}>进入审核合成</button>
        </div>
      </div>
    </section>
  );
}

function triggerNestedFileInput(event: KeyboardEvent<HTMLLabelElement>) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.currentTarget.querySelector("input")?.click();
}

function MaterialBucketGrid({
  buckets,
  onAssetMaxUses,
  onAssetToggle,
  onAssetRegenerate,
  onAssetOperationState,
  onRenameBucket,
  onDeleteBucket
}: {
  buckets: MaterialBucket[];
  onAssetMaxUses: (assetId: string, maxUses: number) => void;
  onAssetToggle: (assetId: string) => void;
  onAssetRegenerate: (assetId: string) => void;
  onAssetOperationState: (assetId: string, operationState: OperationDecisionState) => void;
  onRenameBucket: (bucketId: string) => void;
  onDeleteBucket: (bucketId: string) => void;
}) {
  if (!buckets.length) return null;

  return (
    <div className="bucket-grid">
      {buckets.map((bucket) => (
        <article className="mini-card bucket-card" key={bucket.id}>
          <div className="card-title-row">
            <div>
              <h3>{bucket.label}</h3>
              <small>
                {bucket.role} · {bucket.selectionPolicy} · 可用 {availableAssetCount(bucket)}/{bucket.assets.length}
              </small>
            </div>
            <div className="icon-actions">
              {bucket.isCustom && (
                <>
                  <button className="icon-button" title="重命名素材桶" onClick={() => onRenameBucket(bucket.id)}>
                    <Edit3 size={15} />
                  </button>
                  <button className="icon-button" title="删除素材桶" onClick={() => onDeleteBucket(bucket.id)}>
                    <Trash2 size={15} />
                  </button>
                </>
              )}
              <span className={`source-pill ${availableAssetCount(bucket) ? "online" : "offline"}`}>
                {availableAssetCount(bucket) ? "可抽取" : "不可用"}
              </span>
            </div>
          </div>
          {bucket.assets.length ? (
            <div className="bucket-asset-list">
              {bucket.assets.map((asset) => (
                <div className={`bucket-asset ${asset.disabled ? "disabled" : ""}`} key={asset.id}>
                  <div className="bucket-asset-main">
                    <strong>{asset.title}</strong>
                    <small>
                      {asset.tags.sourceRange} · {asset.providerId} · {assetAvailabilityLabel(asset)}
                    </small>
                  </div>
                  <div className="asset-actions">
                    <button className="secondary-button compact" onClick={() => onAssetRegenerate(asset.id)}>
                      {asset.status === "failed" ? "重试" : "重生成"}
                    </button>
                    <button className="secondary-button compact" onClick={() => onAssetToggle(asset.id)}>
                      {asset.disabled ? "启用" : "禁用"}
                    </button>
                  </div>
                  <div className="asset-control-grid">
                    <label>
                      <span>最大使用</span>
                      <input
                        type="number"
                        min={asset.usage.usedCount}
                        value={asset.usage.maxUses}
                        onChange={(event) => onAssetMaxUses(asset.id, Number(event.target.value))}
                      />
                    </label>
                    <label>
                      <span>运营状态</span>
                      <select
                        value={asset.operationState ?? "untested"}
                        onChange={(event) => onAssetOperationState(asset.id, event.target.value as OperationDecisionState)}
                      >
                        {operationDecisionOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted-text">暂无可抽取素材。</p>
          )}
        </article>
      ))}
    </div>
  );
}

function availableAssetCount(bucket: MaterialBucket) {
  return bucket.assets.filter((asset) => isAssetAvailable(asset)).length;
}

function isAssetAvailable(asset: MaterialBucket["assets"][number]) {
  return !asset.disabled && asset.status === "ready" && asset.operationState !== "rejected" && asset.usage.usedCount < asset.usage.maxUses;
}

function assetAvailabilityLabel(asset: MaterialBucket["assets"][number]) {
  if (asset.disabled) return "已禁用";
  if (asset.status !== "ready") return "未就绪";
  if (asset.operationState === "rejected") return "已淘汰";
  if (asset.usage.usedCount >= asset.usage.maxUses) return `已耗尽 ${asset.usage.usedCount}/${asset.usage.maxUses}`;
  return `${operationDecisionLabel(asset.operationState)} · 可用 ${asset.usage.usedCount}/${asset.usage.maxUses}`;
}

const operationDecisionOptions: Array<{ value: OperationDecisionState; label: string }> = [
  { value: "untested", label: "未测试" },
  { value: "winning", label: "优胜" },
  { value: "fatigued", label: "疲劳" },
  { value: "rejected", label: "淘汰" }
];

function operationDecisionLabel(value?: OperationDecisionState) {
  return operationDecisionOptions.find((option) => option.value === (value ?? "untested"))?.label ?? "未测试";
}

function bridgeStatusText(provider: Provider, health: VideoGenerationBridgeHealth | null) {
  if (!health) return "未检查";
  if (provider === "comfyui") {
    return `${health.service} · ${health.comfyui?.reachable ? "ComfyUI 可达" : "ComfyUI 不可达"}`;
  }
  return `${health.service} · ${health.seedance?.authReady ? "Seedance 鉴权可用" : "缺少 Seedance 鉴权"}`;
}

function SegmentVideoGrid({ segments, sourcePreviewUrl }: { segments: VideoSegment[]; sourcePreviewUrl: string }) {
  if (!segments.length) {
    return (
      <div className="empty-state">
        <Film size={42} />
        <strong>暂无视频段</strong>
        <span>生成队列创建后，这里会展示每段视频和对应脚本。</span>
      </div>
    );
  }

  return (
    <div className="video-grid">
      {segments.map((segment) => (
        <article className="video-card" key={segment.id}>
          <div className="video-frame">
            {segment.status === "generating" ? (
              <div className="video-placeholder">
                <Loader2 className="spin" size={28} />
                <span>生成中</span>
              </div>
            ) : segment.videoUrl || sourcePreviewUrl ? (
              <video src={segment.videoUrl || sourcePreviewUrl} controls />
            ) : (
              <div className="video-placeholder">
                <Film size={28} />
                <span>等待素材</span>
              </div>
            )}
          </div>
          <div className="video-card-body">
            <strong>{segment.title}</strong>
            <small>{segment.scriptText}</small>
          </div>
        </article>
      ))}
    </div>
  );
}
