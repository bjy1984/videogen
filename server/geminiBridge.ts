import cors from "cors";
import express from "express";
import multer from "multer";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";

type TaskStatus =
  | "created"
  | "browser-opened"
  | "prompt-filled"
  | "video-attached"
  | "ready-for-user-send"
  | "capture-ready"
  | "error";

interface BridgeTask {
  id: string;
  projectId: string;
  projectName: string;
  prompt: string;
  videoPath?: string;
  videoOriginalName?: string;
  status: TaskStatus;
  resultText: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const bridgeDir = path.join(rootDir, ".gemini-bridge");
const uploadDir = path.join(bridgeDir, "uploads");
const profileDir = process.env.GEMINI_BRIDGE_PROFILE_DIR || path.join(bridgeDir, "chrome-profile");
const port = Number(process.env.GEMINI_BRIDGE_PORT || 8787);

await mkdir(uploadDir, { recursive: true });
await mkdir(profileDir, { recursive: true });

const upload = multer({ dest: uploadDir });
const app = express();
const tasks = new Map<string, BridgeTask>();
let browserContext: BrowserContext | null = null;
let geminiPage: Page | null = null;

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "gemini-web-bridge",
    port,
    profileDir,
    taskCount: tasks.size
  });
});

app.post("/tasks", upload.single("video"), (req, res) => {
  const id = createId("gemini_task");
  const file = req.file;
  const task: BridgeTask = {
    id,
    projectId: String(req.body.projectId || ""),
    projectName: String(req.body.projectName || "未命名工程"),
    prompt: String(req.body.prompt || ""),
    videoPath: file?.path,
    videoOriginalName: file?.originalname,
    status: "created",
    resultText: "",
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  log(task, "任务已创建，视频已保存到本地 Bridge。");
  tasks.set(id, task);
  res.json(publicTask(task));
});

app.get("/tasks/:id", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(publicTask(task));
});

app.post("/tasks/:id/prepare", async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  try {
    const page = await getGeminiPage();
    await page.bringToFront();
    task.status = "browser-opened";
    log(task, "Gemini 页面已打开。");

    await fillPrompt(page, task);
    task.status = "prompt-filled";
    log(task, "Prompt 已尝试填入 Gemini 输入框。");

    if (task.videoPath) {
      const attached = await attachVideo(page, task.videoPath);
      if (attached) {
        task.status = "video-attached";
        log(task, `视频已尝试挂载：${task.videoOriginalName || task.videoPath}`);
      } else {
        log(task, "未找到可用上传入口，请在 Gemini 页面手动上传视频。");
      }
    } else {
      log(task, "当前任务没有视频文件，仅填入 Prompt。");
    }

    task.status = "ready-for-user-send";
    log(task, "已停在发送前。请用户在 Gemini 页面确认内容后手动发送。");
    res.json(publicTask(task));
  } catch (error) {
    task.status = "error";
    log(task, error instanceof Error ? error.message : "准备 Gemini 页面失败。");
    res.status(500).json(publicTask(task));
  }
});

app.post("/tasks/:id/capture", async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  try {
    const page = await getGeminiPage();
    task.resultText = await captureLatestGeminiResponse(page);
    task.status = "capture-ready";
    log(task, `已抓取 Gemini 页面文本，长度 ${task.resultText.length}。`);
    res.json(publicTask(task));
  } catch (error) {
    task.status = "error";
    log(task, error instanceof Error ? error.message : "抓取 Gemini 回复失败。");
    res.status(500).json(publicTask(task));
  }
});

app.listen(port, () => {
  console.log(`Gemini web bridge listening on http://localhost:${port}`);
});

async function getGeminiPage() {
  if (!browserContext) {
    browserContext = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: false,
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"]
    });
    
    // 监听浏览器关闭事件，重置上下文
    browserContext.on("close", () => {
      browserContext = null;
      geminiPage = null;
      console.log("浏览器已关闭，上下文已重置。");
    });
  }

  if (!geminiPage || geminiPage.isClosed()) {
    geminiPage = browserContext.pages()[0] || (await browserContext.newPage());
  }

  if (!geminiPage.url().startsWith("https://gemini.google.com")) {
    await geminiPage.goto("https://gemini.google.com/", { waitUntil: "domcontentloaded" });
  }

  return geminiPage;
}

async function fillPrompt(page: Page, task: BridgeTask) {
  const selectors = [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[aria-label*="prompt" i]',
    'textarea',
    '[role="textbox"]'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if ((await locator.count()) === 0) continue;

    try {
      await locator.waitFor({ state: "visible", timeout: 3500 });
      await locator.click({ timeout: 3500 });
      await page.keyboard.insertText(task.prompt);
      return;
    } catch {
      // Try the next selector.
    }
  }

  throw new Error("没有找到 Gemini Prompt 输入框。请确认已登录且页面加载完成。");
}

async function attachVideo(page: Page, videoPath: string) {
  const initialInputs = await page.locator('input[type="file"]').count();
  if (initialInputs > 0) {
    await page.locator('input[type="file"]').last().setInputFiles(videoPath);
    return true;
  }

  const uploadTriggers = [
    'button[aria-label*="Upload" i]',
    'button[aria-label*="Attach" i]',
    'button[aria-label*="Add files" i]',
    'button[aria-label*="添加" i]',
    'button[aria-label*="上传" i]',
    'button[aria-label*="附件" i]',
    '[role="button"][aria-label*="Upload" i]',
    '[role="button"][aria-label*="Attach" i]',
    '[role="button"][aria-label*="添加" i]',
    '[role="button"][aria-label*="上传" i]'
  ];

  for (const selector of uploadTriggers) {
    const trigger = page.locator(selector).first();
    if ((await trigger.count()) === 0) continue;

    try {
      await trigger.click({ timeout: 2500 });
      await page.waitForTimeout(700);
      const input = page.locator('input[type="file"]').last();
      if ((await input.count()) > 0) {
        await input.setInputFiles(videoPath);
        return true;
      }
    } catch {
      // Try the next upload trigger.
    }
  }

  return false;
}

async function captureLatestGeminiResponse(page: Page) {
  const selectors = [
    "message-content",
    '[data-response-index]',
    ".model-response-text",
    ".markdown",
    'div[class*="response"]',
    "main"
  ];

  for (const selector of selectors) {
    const texts = await page
      .locator(selector)
      .allTextContents()
      .catch(() => []);
    const cleaned = texts.map((text) => text.trim()).filter((text) => text.length > 200);
    if (cleaned.length) {
      return cleaned[cleaned.length - 1];
    }
  }

  const bodyText = await page.locator("body").innerText({ timeout: 5000 });
  if (bodyText.trim().length < 200) {
    throw new Error("没有抓取到足够长的 Gemini 回复文本。请确认回复已经生成完成。");
  }
  return bodyText.trim();
}

function publicTask(task: BridgeTask) {
  return {
    id: task.id,
    projectId: task.projectId,
    projectName: task.projectName,
    videoOriginalName: task.videoOriginalName,
    status: task.status,
    resultText: task.resultText,
    logs: task.logs,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function log(task: BridgeTask, message: string) {
  task.updatedAt = new Date().toISOString();
  task.logs = [...task.logs, `${new Date().toLocaleTimeString("zh-CN")} ${message}`].slice(-40);
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
