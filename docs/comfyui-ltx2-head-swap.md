# ComfyUI LTX2 Head Swap Deployment

This project uses ComfyUI through the local Video Generation Bridge for LTX2 head-swap testing and later segment remix generation.

## Project Integration

- Workflow template: `comfyui-workflows/workflow_ltx2_head_swap_drag_and_drop_v3.0.json`
- Test page: top bar `ComfyUI 测试台`
- Generation settings: Provider `ComfyUI` -> `LTX2 Head Swap Preset` -> `应用`
- Bridge command: `npm run video:bridge`
- Web command: `npm run dev`
- Default bridge URL: `http://127.0.0.1:8790`
- Default local ComfyUI URL: `http://127.0.0.1:8188`

The test page uploads the source video and reference face image to the local bridge first. The bridge then uploads both files into ComfyUI `/upload/image`, injects the returned ComfyUI input filenames into the workflow, submits `/prompt`, polls `/history/{prompt_id}`, and syncs the output video back into `.videogen-assets/comfyui/...`.

## Active LTX2 Preset

- Prompt node: `498`
- Output node: `341`
- NAG node: `396`
- Ollama describer node: `586`
- Default duration: `5s`
- Default steps: `8`
- Default CFG: `1`
- Default Ollama model override: `gemma4:e4b-it-q4_K_M`

## Required ComfyUI Runtime

Install or verify these custom nodes on the ComfyUI server:

- `ComfyUI-LTXVideo`
- `ComfyUI-VideoHelperSuite`
- `ComfyUI-Ollama-Describer`
- `ComfyUI-NAG`, patched for LTXAV
- Workflow-specific nodes used by the checked-in workflow, including the BFS/head-swap and utility nodes already present in the workflow graph

The test page environment check requires:

- ComfyUI `/system_stats` reachable
- `GET /object_info/NAGCFGGuider` returns a registered node

## Remote Restart Checklist

```bash
cd /root/comfy/ComfyUI
/comfy-env/bin/python -m py_compile custom_nodes/ComfyUI-NAG/samplers.py custom_nodes/ComfyUI-NAG/ltxv/model.py

old=$(pgrep -f "^/comfy-env/bin/python main.py --listen 0.0.0.0 --port 8188" || true)
if [ -n "$old" ]; then kill $old || true; fi
sleep 4

mkdir -p /root/logs
log=/root/logs/comfyui-restart-$(date +%Y%m%d-%H%M%S).log
nohup /comfy-env/bin/python main.py --listen 0.0.0.0 --port 8188 --enable-manager > "$log" 2>&1 < /dev/null &
```

Health checks:

```bash
curl -fsS http://127.0.0.1:8188/system_stats
curl -fsS http://127.0.0.1:8188/object_info/NAGCFGGuider
```

## NAG LTXAV Bug Fix Notes

The upstream `ComfyUI-NAG` node was not directly compatible with this LTX2 AV workflow. These fixes were applied on the ComfyUI server and must be preserved when rebuilding the environment:

1. `samplers.py`
   - Makes Chroma import optional so NAG can load even when the current ComfyUI Chroma API differs.
   - Imports `LTXVModel` and `LTXAVModel`.
   - Dispatches `LTXVModel` to `NAGLTXVModelSwitch`.
   - Dispatches `LTXAVModel` to `NAGLTXAVModelSwitch`.
   - Mirrors ComfyUI core nested-latent handling by packing `NestedTensor` latent/noise/mask values and preserving `latent_shapes`.

2. `ltxv/model.py`
   - Adds LTXV cross-attention NAG support.
   - Adds LTXAV support for separate video/audio text contexts.
   - Handles tuple timestep input by routing audio timestep into `a_timestep`.
   - Pops `denoise_mask` before merging `kwargs`, avoiding duplicate `_process_input(..., denoise_mask=...)`.
   - Wraps `_apply_text_cross_attention` so main context and NAG negative context each receive matching AdaLN prompt timestep modulation before being concatenated.

## Known Error Map

| Error | Cause | Fix |
| --- | --- | --- |
| `Model type ... LTXAVModel is not support for NAGCFGGuider` | NAG did not dispatch LTXAV models | Add `LTXAVModel` switch and wrapper |
| `count_nonzero(): argument 'input' must be Tensor, not NestedTensor` | LTX2 workflow emits nested latents | Pack nested latents and pass `latent_shapes` through sampler |
| `name 'is_nested' is not defined` | Patch typo used a bare variable instead of string attribute | Use `getattr(value, "is_nested", False)` |
| `keywords must be strings` | Patch typo used a non-string key in `kwargs` or merged args | Ensure all `kwargs[...]` keys are quoted strings |
| `_process_input() got multiple values for argument 'denoise_mask'` | `denoise_mask` passed positionally and again through `**kwargs` | `denoise_mask = kwargs.pop("denoise_mask", None)` before merging |
| `tensor a (3) must match tensor b (2)` in `apply_cross_attention_adaln` | NAG appended a negative context row before AdaLN prompt timestep modulation | Apply AdaLN to main and NAG contexts separately, then concatenate |

## Frontend Test Flow

1. Start the bridge: `npm run video:bridge`
2. Start the web app: `npm run dev`
3. Open `http://localhost:5174`
4. Click top bar `ComfyUI 测试台`
5. Click `检查环境`
6. Select source video and reference face image
7. Submit `LTX2 换头`
8. Keep the page open while it auto-polls every 8 seconds

If `检查环境` says `NAGCFGGuider` is unavailable, fix the ComfyUI-NAG deployment before testing the workflow.
