import type { GenerationOptions } from "../../types";
import { LTX2_HEAD_SWAP_COMFYUI_PRESET } from "./providers/comfyuiApi";
import type { ProviderSettings } from "./providers/providerConfig";
import { getVideoGenerationProvider } from "./providers/providerRegistry";

export function ProviderSettingsPanel({
  providerId,
  settings,
  onSettings
}: {
  providerId: GenerationOptions["provider"];
  settings: ProviderSettings;
  onSettings: (settings: ProviderSettings) => void;
}) {
  const provider = getVideoGenerationProvider(providerId);

  return (
    <section className="mini-card provider-settings-panel">
      <div className="card-title-row">
        <div>
          <h3>{provider.label} 配置</h3>
          <small>{provider.capabilities.join(" · ")}</small>
        </div>
        <span className="source-pill">{providerId === "seedance" || providerId === "comfyui" ? "local bridge" : "adapter"}</span>
      </div>

      {providerId === "comfyui" && (
        <>
          <div className="provider-preset-row">
            <div>
              <strong>LTX2 Head Swap Preset</strong>
              <small>使用项目内 workflow、NAGCFGGuider、Gemma4 描述模型和 8-step 测试参数。</small>
            </div>
            <button
              className="secondary-button compact"
              onClick={() =>
                onSettings({
                  ...settings,
                  comfyui: {
                    ...settings.comfyui,
                    endpoint: LTX2_HEAD_SWAP_COMFYUI_PRESET.endpoint,
                    workflowTemplateId: LTX2_HEAD_SWAP_COMFYUI_PRESET.workflowTemplateId,
                    promptNodeId: LTX2_HEAD_SWAP_COMFYUI_PRESET.promptNodeId,
                    outputNodeId: LTX2_HEAD_SWAP_COMFYUI_PRESET.outputNodeId,
                    steps: 8,
                    cfgScale: 1,
                    ollamaModel: LTX2_HEAD_SWAP_COMFYUI_PRESET.ollamaModel,
                    workflowJson: ""
                  }
                })
              }
            >
              应用
            </button>
          </div>
          <div className="provider-settings-grid">
            <Field label="Bridge URL" value={settings.comfyui.bridgeUrl} onValue={(value) => onSettings({ ...settings, comfyui: { ...settings.comfyui, bridgeUrl: value } })} />
            <Field label="Endpoint" value={settings.comfyui.endpoint} onValue={(value) => onSettings({ ...settings, comfyui: { ...settings.comfyui, endpoint: value } })} />
            <Field label="Workflow" value={settings.comfyui.workflowTemplateId} onValue={(value) => onSettings({ ...settings, comfyui: { ...settings.comfyui, workflowTemplateId: value } })} />
            <Field label="Prompt Node" value={settings.comfyui.promptNodeId} onValue={(value) => onSettings({ ...settings, comfyui: { ...settings.comfyui, promptNodeId: value } })} />
            <Field label="Output Node" value={settings.comfyui.outputNodeId} onValue={(value) => onSettings({ ...settings, comfyui: { ...settings.comfyui, outputNodeId: value } })} />
            <Field label="Ollama Model" value={settings.comfyui.ollamaModel} onValue={(value) => onSettings({ ...settings, comfyui: { ...settings.comfyui, ollamaModel: value } })} />
            <Field label="Seed" value={settings.comfyui.seed} onValue={(value) => onSettings({ ...settings, comfyui: { ...settings.comfyui, seed: value } })} />
            <NumberField label="Steps" value={settings.comfyui.steps} onValue={(value) => onSettings({ ...settings, comfyui: { ...settings.comfyui, steps: value } })} />
            <NumberField label="CFG" value={settings.comfyui.cfgScale} step={0.5} onValue={(value) => onSettings({ ...settings, comfyui: { ...settings.comfyui, cfgScale: value } })} />
            <label className="wide-field">
              <span>Workflow JSON</span>
              <textarea
                value={settings.comfyui.workflowJson}
                placeholder="粘贴 ComfyUI 的 Save API Format JSON；留空时使用 Workflow 字段作为本地 JSON 路径。"
                onChange={(event) => onSettings({ ...settings, comfyui: { ...settings.comfyui, workflowJson: event.target.value } })}
              />
            </label>
          </div>
        </>
      )}

      {providerId === "seedance" && (
        <div className="provider-settings-grid">
          <Field label="Bridge URL" value={settings.seedance.bridgeUrl} onValue={(value) => onSettings({ ...settings, seedance: { ...settings.seedance, bridgeUrl: value } })} />
          <Field label="Endpoint" value={settings.seedance.endpoint} onValue={(value) => onSettings({ ...settings, seedance: { ...settings.seedance, endpoint: value } })} />
          <Field label="Model" value={settings.seedance.model} onValue={(value) => onSettings({ ...settings, seedance: { ...settings.seedance, model: value } })} />
          <Field label="API Key Env" value={settings.seedance.apiKeyEnvName} onValue={(value) => onSettings({ ...settings, seedance: { ...settings.seedance, apiKeyEnvName: value } })} />
          <Field label="Seed" value={settings.seedance.seed} onValue={(value) => onSettings({ ...settings, seedance: { ...settings.seedance, seed: value } })} />
          <NumberField label="Duration" value={settings.seedance.defaultDuration} onValue={(value) => onSettings({ ...settings, seedance: { ...settings.seedance, defaultDuration: value } })} />
          <label>
            <span>Resolution</span>
            <select
              value={settings.seedance.resolution}
              onChange={(event) =>
                onSettings({
                  ...settings,
                  seedance: { ...settings.seedance, resolution: event.target.value as "720p" | "1080p" }
                })
              }
            >
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
            </select>
          </label>
          <CheckboxField
            label="Generate Audio"
            checked={settings.seedance.generateAudio}
            onChecked={(value) => onSettings({ ...settings, seedance: { ...settings.seedance, generateAudio: value } })}
          />
          <CheckboxField
            label="Watermark"
            checked={settings.seedance.watermark}
            onChecked={(value) => onSettings({ ...settings, seedance: { ...settings.seedance, watermark: value } })}
          />
          <CheckboxField
            label="Return Last Frame"
            checked={settings.seedance.returnLastFrame}
            onChecked={(value) => onSettings({ ...settings, seedance: { ...settings.seedance, returnLastFrame: value } })}
          />
        </div>
      )}

      {providerId !== "comfyui" && providerId !== "seedance" && (
        <div className="provider-settings-grid">
          <NumberField label="Mock Latency" value={settings.mock.latencyMs} onValue={(value) => onSettings({ ...settings, mock: { ...settings.mock, latencyMs: value } })} />
        </div>
      )}
    </section>
  );
}

function CheckboxField({
  label,
  checked,
  onChecked
}: {
  label: string;
  checked: boolean;
  onChecked: (value: boolean) => void;
}) {
  return (
    <label className="checkbox-field">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChecked(event.target.checked)} />
    </label>
  );
}

function Field({ label, value, onValue }: { label: string; value: string; onValue: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} onChange={(event) => onValue(event.target.value)} />
    </label>
  );
}

function NumberField({
  label,
  value,
  step = 1,
  onValue
}: {
  label: string;
  value: number;
  step?: number;
  onValue: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" step={step} value={value} onChange={(event) => onValue(Number(event.target.value))} />
    </label>
  );
}
