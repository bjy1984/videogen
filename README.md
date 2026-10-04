# VideoGen

面向抖音电商、千川素材制作的视频分析与生成工作台。项目将视频拆解、脚本编辑、分段生成、素材管理、预处理和剪映草稿导出串成一个本地工作流。

前端使用 React + TypeScript + Vite，后端由两个 Express Bridge 服务组成；视频处理通过 Python 与 FFmpeg 完成，真实 AI 生成接入 Seedance、ComfyUI 和 image2。

> 当前项目包含可用的服务集成和原型功能：默认分析按钮使用模拟报告，Local Mock 不生成真实视频，“一键合成”仅模拟完成状态。真实素材生成需要配置对应服务；导出产物为剪映草稿 ZIP，而非渲染后的完整 MP4。

## 功能概览

### 视频分析与生成

- **分析输入**：上传视频、编辑和保存分析 Prompt；支持复制 Prompt 到 Gemini、粘贴回复后解析，以及通过 Gemini Bridge 准备页面和抓取回复。
- **分析报告**：展示视频基本信息、叙事拆解、手法分析、数据预测、执行方案和生成提示语。
- **脚本编辑**：从报告提取五段式脚本，支持新增、复制、排序、删除、修订保存与恢复，以及改写建议。
- **分段生成**：支持 Local Mock、ComfyUI、Seedance，管理生成任务、轮询状态并同步真实视频素材。
- **素材桶与时间线**：管理二创素材桶，设置启用状态和最大使用次数，随机组装、替换及调整时间线，执行导出前审核。
- **导出与追踪**：导出剪映草稿、字幕、素材和 lineage 信息；录入完播率、点击率、ROI 等反馈，并按素材、素材桶、Provider 和 Prompt 汇总表现。

### 视频生成工作台

- 视频和图片素材库，支持产品、人脸等图片分类、标签管理和素材描述。
- 深度视频、灰度视频、视频切分、抽帧、单帧修改和产品信息替换。
- Seedance 参考素材加工、任务状态查询及生成产物同步。
- faster-whisper 语音转文字，以及按素材标签规划拼接。
- MongoDB 保存工作台素材状态；本地保存上传文件和处理产物。

顶部还提供独立的**打码测试台**和 **ComfyUI 测试台**，用于验证人脸/品牌遮挡、跟踪处理和 LTX2 换头工作流。

## 快速开始

### 1. 安装前端与 Bridge 依赖

建议使用 Node.js 20.19+ 或 22.12+，并准备 npm。Python、FFmpeg、MongoDB 和外部 AI 服务可根据要使用的功能单独配置。

```bash
git clone https://github.com/bjy1984/videogen.git
cd videogen
npm ci
cp .env.example .env.local
```

### 2. 启动

同时启动前端和两个 Bridge：

```bash
npm run dev:all
```

| 服务 | 默认地址 | 作用 |
| --- | --- | --- |
| Web | http://localhost:5174 | 工作台界面 |
| Gemini Bridge | http://127.0.0.1:8787 | Gemini 浏览器页面辅助 |
| Video Generation Bridge | http://127.0.0.1:8790 | 生成任务、素材存储、视频预处理 |

仅体验脚本、模拟分析和 Mock 流程时，可单独运行 `npm run dev`，默认访问 http://localhost:5173。生成设置默认选择 Seedance；体验模拟流程时需切换为 **Local Mock**。

Bridge 健康检查：

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8790/health
```

`restart.sh` 会强制结束占用 5174、8787、8790 端口的进程后重新启动服务，使用前请确认这些端口属于本项目。

## 配置服务

两个 Bridge 启动时依次读取根目录的 `.env`、`.env.local`，后者覆盖前者及同名进程环境变量。修改配置后需重启 Bridge。可从 [.env.example](.env.example) 开始填写，以下部分变量需要自行添加。

### Seedance

在 `.env.local` 中设置：

```dotenv
NEWAPI_BASE_URL=https://apicoco.com
NEWAPI_API_KEY=你的API密钥
```

也支持 `NEWAPI_USERNAME` 和 `NEWAPI_PASSWORD` 登录；同时配置用户名和密码时，后端优先使用登录认证。可通过 `SEEDANCE_NEWAPI_BASE_URL` 单独覆盖 Seedance 服务地址。

在页面 Provider 设置中检查 Bridge 地址、接口地址、模型、时长和分辨率。代码默认模型为 `xsdoubao/seedance2.0_fast_direct`，默认生成配置为 5 秒、720p；参考媒体能力随模型而异。

参考图片/视频需要生成服务可访问的 URL。可配置阿里云 OSS，或通过 `VIDEOGEN_PUBLIC_ASSET_BASE_URL` 指定对外可访问的 `/assets` 地址。远端服务无法直接读取本机的 `127.0.0.1` URL。

### ComfyUI

准备独立运行的 ComfyUI 服务，默认地址为 `http://127.0.0.1:8188`。在页面中设置服务地址、**API 格式的 workflow JSON**、提示词节点和输出节点，或应用内置 LTX2 Head Swap 预设。

ComfyUI 测试台通过 Video Bridge 上传素材、提交工作流、轮询结果，并将生成视频同步到本地资产目录。模型、显存环境、自定义节点及 Ollama 需在 ComfyUI 服务端另行准备。

工作流文件位于 [comfyui-workflows/](comfyui-workflows/)，节点依赖和部署细节见 [ComfyUI LTX2 换头部署说明](docs/comfyui-ltx2-head-swap.md)。

### Gemini 网页分析

Gemini Bridge 使用 `playwright-core` 启动已安装的 Google Chrome，并复用 `.gemini-bridge/chrome-profile` 中的独立用户配置。

1. 在分析输入页创建 Bridge 任务。
2. 准备 Gemini 页面，登录账号并检查视频和 Prompt。
3. **在 Gemini 页面手动点击发送**。
4. 回复完成后回到工作台抓取结果，确认并解析加载到工程。

也可直接复制 Prompt、手动上传视频，再将 Gemini 回复粘贴回工作台。网页结构变化可能影响自动填充和结果抓取。

### MongoDB 与资产存储

工作台素材库使用 MongoDB，默认连接和数据库如下：

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=videogen
```

请先启动可访问的 MongoDB。工作台状态存入 `workbench_library_states`，代码中的 Seedance 模型价格配置写入 `seedance_model_pricing`。未连接 MongoDB 时，素材库读写会失败。

上传文件和处理产物默认存放在 `.videogen-assets/`，通过 Video Bridge 的 `/assets` 路径提供访问；可使用 `VIDEOGEN_ASSET_ROOT` 更改存储目录。

如需 OSS 上传和远端引用，填写 `.env.example` 中的 `OSS_BUCKET`、`OSS_REGION`、`OSS_ENDPOINT`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 等字段。`OSS_PUBLIC_BASE_URL` 可指定公开访问前缀；未配置该项时使用签名 URL。

### image2 产品信息替换

```dotenv
IMAGE2_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
IMAGE2_API_KEY=你的API密钥
IMAGE2_MODEL=openai/gpt-5.4-image-2
```

以上是代码默认接口和模型配置。先在图片素材库准备产品图，再对视频抽帧并执行产品信息替换；远端访问同样依赖可访问的素材 URL。

设置 `IMAGE2_MOCK=passthrough` 可用于本地界面测试，该模式直接透传图片，不执行真实替换。

## 本地视频处理依赖

以下初始化脚本适用于 macOS/Linux，需已安装 Python 3。Windows 用户可按对应 requirements 文件手动建立虚拟环境，并配置 Python 路径。

### 人脸与品牌打码

```bash
bash scripts/setup-face-mosaic-venv.sh
```

脚本创建 `.venv-face-mosaic`，安装人脸与品牌遮挡依赖，并提供 `imageio-ffmpeg`。可通过 `VIDEOGEN_FACE_MOSAIC_PYTHON` 或 `VIDEOGEN_BRAND_MASK_PYTHON` 指定解释器。

不同跟踪引擎还可能需要独立依赖、模型权重或外部命令，相关脚本和 requirements 位于 [scripts/](scripts/)。

### 深度与灰度视频

```bash
bash scripts/setup-depth-video-venv.sh
```

深度视频还需自行准备兼容 OpenCV 的 Depth Anything ONNX 模型，默认路径为：

```text
models/depth_anything_vits14_fabiosim_v1_opencv_static_upsample.onnx
```

可通过 `VIDEOGEN_DEPTH_ANYTHING_ONNX` 覆盖模型路径，通过 `VIDEOGEN_DEPTH_VIDEO_PYTHON` 指定 Python。模型未随仓库提供；模型输入尺寸需与页面设置一致。灰度处理不需要深度模型。

视频切分、抽帧、音频处理等功能需要 FFmpeg/ffprobe。可安装系统版本，或通过 `VIDEOGEN_FFMPEG_PATH`、`VIDEOGEN_FFPROBE_PATH` 指定可执行文件。

### 语音转文字

初始化脚本默认使用作者机器上的绝对路径，建议显式指定本项目虚拟环境：

```bash
VIDEOGEN_FASTER_WHISPER_VENV="$PWD/.venv-faster-whisper" bash scripts/setup-faster-whisper-venv.sh
```

Bridge 默认查找项目内的 `.venv-faster-whisper`。可通过 `VIDEOGEN_FASTER_WHISPER_PYTHON` 更换解释器，使用 `VIDEOGEN_FASTER_WHISPER_MODEL` 更换模型，默认值为 `medium`；首次转写需准备或下载模型。

## 工程保存与剪映导出

工程栏支持新建、保存、加载及 JSON 导入导出。工程和 Prompt 使用浏览器 `localStorage` 保存；JSON 不包含上传媒体文件本体，迁移工程时需同时保留本地资产或重新上传源视频。

剪映草稿 ZIP 包含：

| 路径 | 内容 |
| --- | --- |
| `draft_content.json` / `draft_info.json` | 时间线、素材和文本轨道 |
| `draft_meta_info.json` | 工程元信息 |
| `material/import/` | 可获取的视频素材；Mock 场景可能包含占位文件 |
| `scripts/segments.json` | 分段脚本 |
| `subtitles/subtitles.srt` | 按片段时长生成的字幕 |
| `subtitles/text_manifest.json` | 文本来源记录 |
| `timeline.json` / `assets.json` / `lineage.json` | 使用素材桶时间线导出时的时间线、素材和追踪记录 |

导出前应完成素材审核并同步真实生成结果。剪映/CapCut 草稿结构随版本变化，使用时需对照目标桌面版本的空白草稿校准适配器；不保证所有版本直接兼容。

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 单独启动 Vite，默认 5173 |
| `npm run bridge` | 启动 Gemini Bridge |
| `npm run video:bridge` | 启动视频生成与预处理 Bridge |
| `npm run dev:all` | 同时启动前端（5174）和两个 Bridge |
| `npm run build` | TypeScript 检查并构建前端到 `dist/` |
| `npm run preview` | 预览前端构建结果；不启动 Bridge |
| `npm test` | 运行素材混剪、导出和相关工作流断言 |

Bridge 端口分别可通过 `GEMINI_BRIDGE_PORT`、`VIDEO_GENERATION_BRIDGE_PORT` 修改，修改后也需更新页面对应的 Bridge 地址。前端构建产物不包含后端服务、Python 环境或 AI 模型。

## 目录结构

```text
src/
  app/                   工作流页面与默认设置
  components/            公共组件
  domain/                工程、分析来源与标签模型
  features/
    analysis/            分析输入、报告与 Gemini 结果解析
    script/              脚本编辑、修订与隐私设置
    generation/          生成任务与 Provider 适配器
    depth-workbench/     素材库、预处理与 AI 加工
    privacy/             遮挡标注与打码测试台
    remix/               素材桶与混剪规划
    compose/             时间线组装与导出审核
    export/              剪映草稿打包
    lineage/             素材追踪与运营反馈统计
  services/              Bridge 客户端、存储与下载工具
server/                  Gemini/Video Bridge、MongoDB 与 OSS
scripts/                 Python 视频处理与环境初始化
comfyui-workflows/       ComfyUI 工作流模板
docs/                    部署说明
tests/                   工作流测试
```

## 当前边界

- 分析页的默认按钮调用 `createMockAnalysis`，报告中的预测指标是示例数据；真实 Gemini 分析通过网页回复导入。
- Local Mock 只模拟生成任务，不返回真实视频；主流程“一键合成”尚未接入最终视频渲染服务。
- 工程 JSON、浏览器存储、MongoDB 素材状态与磁盘媒体文件分别保存，备份时应一并保留。
- 本地 Bridge 当前没有应用级认证，且允许跨域访问，部署时应限制到可信环境并配置访问控制。
- 外部模型、账号、服务费用和模型权重需自行准备；仓库中的价格配置仅用于应用展示，应以实际服务计费为准。
