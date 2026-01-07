type StartCollectMessage = {
  type: "START_COLLECT"
  requestId: string
  targetUrl: string
  filters: CollectFilters
}

type CancelCollectMessage = {
  type: "CANCEL_COLLECT"
  requestId: string
}

type RunCollectMessage = {
  type: "RUN_COLLECT"
  requestId: string
  filters: CollectFilters
}

type CollectProgressMessage = {
  type: "COLLECT_PROGRESS"
  requestId: string
  progress: CollectProgress
}

type CollectFinishedMessage = {
  type: "COLLECT_FINISHED"
  requestId: string
  result: CollectResult
}

type CollectFailedMessage = {
  type: "COLLECT_FAILED"
  requestId: string
  error: string
}

type AiOrganizeMessage = {
  type: "AI_ORGANIZE"
  text: string
}

type AiOrganizeResponse =
  | { ok: true; content: string }
  | { ok: false; error: string }

type CollectFilters = {
  mode: "posts" | "replies"
  username: string
  days: number
  keywordQuery: string
  maxItems: number
  keepCollectTabOpen: boolean
  usePopupWindow: boolean
  autoFocusPopup: boolean
}

type CollectProgress = {
  stage: "opening" | "collecting" | "finalizing"
  collected: number
  scanned: number
}

type CollectedTweet = {
  id: string
  url: string
  createdAt: string | null
  text: string
}

type CollectResult = {
  targetUrl: string
  collectedAt: string
  items: CollectedTweet[]
}

const inflight = new Map<
  string,
  {
    sourceTabId: number
    sourceWindowId: number | null
    collectTabId: number
    collectWindowId: number | null
    targetUrl: string
    keepCollectTabOpen: boolean
    autoFocusPopup: boolean
    lastProgressAt: number
    lastProgressKey: string
    lastFocusKickAt: number
  }
>()

const keepAlivePorts = new Map<string, chrome.runtime.Port>()

const WATCHDOG_PREFIX = "pc-watchdog:"

const MODELSCOPE_QWEN_DEFAULT_BASE_URL = "https://api-inference.modelscope.cn/v1"
const MODELSCOPE_QWEN_DEFAULT_MODEL = "qwen-plus"

const AI_STORAGE_KEYS = {
  modelscopeBaseUrl: "promptCollect.ai.modelscope.baseUrl",
  modelscopeApiKey: "promptCollect.ai.modelscope.apiKey",
  modelscopeModel: "promptCollect.ai.modelscope.model",
} as const

const ORGANIZE_PROMPT_SYSTEM = `你是一个“提示词整理助手”。把用户粘贴的一段混合文本整理成一个 Prompt。
要求：
1) 只输出 JSON（不要 Markdown，不要解释）。
2) JSON 字段：title, category, tags, images, videos, content, author, date。
3) tags/images/videos 必须是数组；无则输出 []。
4) category 智能识别归类：
   - "图片"：提示词用于图片生成、图像处理、绘画、设计等场景（如 Midjourney、DALL-E、Stable Diffusion 等）
   - "视频"：提示词用于视频生成、视频编辑、动画制作等场景（如 Runway、Pika 等）
   - "文本"：提示词用于文本生成、写作、对话、翻译、分析等文本处理场景
   - 如果无法明确判断或不属于以上类别，可为空字符串
5) tags 最多 4 个，选择最核心的关键词标签；如果有作者信息，必须将作者作为其中一个标签。
6) 如果文本中明确提到作者或时间信息，务必提取到 author 和 date 字段；author 可以是人名或组织名；date 格式为 YYYY-MM-DD 或 YYYY-MM，无则为空字符串。
7) images/videos 只收录文本中出现的链接，不要编造；把图片/视频链接从正文中移到 images/videos（正文可保留必要上下文）。
8) title 尽量简短；content 为最终可直接使用的提示词正文。`

function normalizeOpenAICompatBaseUrl(input: string): string {
  let url = String(input ?? "").trim()
  if (!url) return ""
  url = url.replace(/\/+$/g, "")
  if (url.endsWith("/chat/completions")) url = url.slice(0, -"/chat/completions".length)
  if (url.endsWith("/responses")) url = url.slice(0, -"/responses".length)
  url = url.replace(/\/+$/g, "")
  return url
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < 0 || end <= start) return null
  const slice = text.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    return null
  }
}

function normalizeOrganizeContent(input: unknown): string {
  const obj =
    input && typeof input === "object" ? (input as Record<string, unknown>) : ({} as Record<string, unknown>)
  const content = typeof obj.content === "string" ? obj.content.trim() : ""
  return content
}

async function loadAiSettings(): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  const raw = await chrome.storage.local.get([
    AI_STORAGE_KEYS.modelscopeBaseUrl,
    AI_STORAGE_KEYS.modelscopeApiKey,
    AI_STORAGE_KEYS.modelscopeModel,
  ])
  const baseUrl =
    typeof raw[AI_STORAGE_KEYS.modelscopeBaseUrl] === "string"
      ? raw[AI_STORAGE_KEYS.modelscopeBaseUrl]
      : MODELSCOPE_QWEN_DEFAULT_BASE_URL
  const apiKey =
    typeof raw[AI_STORAGE_KEYS.modelscopeApiKey] === "string"
      ? raw[AI_STORAGE_KEYS.modelscopeApiKey]
      : ""
  const model =
    typeof raw[AI_STORAGE_KEYS.modelscopeModel] === "string"
      ? raw[AI_STORAGE_KEYS.modelscopeModel]
      : MODELSCOPE_QWEN_DEFAULT_MODEL

  return { baseUrl, apiKey, model }
}

async function organizeWithOpenAICompat(text: string): Promise<string> {
  const settings = await loadAiSettings()
  if (!settings.apiKey.trim()) throw new Error("未配置 API Key（Prompt Collect AI）")

  const baseURL = normalizeOpenAICompatBaseUrl(settings.baseUrl)
  if (!baseURL) throw new Error("未配置 Base URL（Prompt Collect AI）")
  if (!settings.model.trim()) throw new Error("未配置模型名称（Prompt Collect AI）")

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: settings.model.trim(),
      temperature: 0.2,
      messages: [
        { role: "system", content: ORGANIZE_PROMPT_SYSTEM },
        { role: "user", content: `请整理以下 X post 原文：\n\n${text}` },
      ],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`AI 请求失败：HTTP ${res.status}${body ? `\n${body.slice(0, 500)}` : ""}`)
  }

  const json = (await res.json().catch(() => null)) as any
  const outputText = String(json?.choices?.[0]?.message?.content ?? "").trim()
  if (!outputText) throw new Error("AI 返回为空")

  const parsed = extractJsonObject(outputText)
  const content = normalizeOrganizeContent(parsed)
  if (!content) throw new Error("AI 整理失败：未得到可用 content")
  return content
}

function withCollectHash(url: string): string {
  try {
    const u = new URL(url)
    const token = "pc_collect=1"
    if (!u.hash) {
      u.hash = token
    } else if (!u.hash.includes(token)) {
      u.hash = `${u.hash.replace(/^#/, "")}&${token}`
    }
    return u.toString()
  } catch {
    return url.includes("#") ? `${url}&pc_collect=1` : `${url}#pc_collect=1`
  }
}

function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error("Timed out waiting for tab to load"))
    }, timeoutMs)

    const listener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (
      updatedTabId,
      changeInfo,
    ) => {
      if (updatedTabId !== tabId) return
      if (changeInfo.status !== "complete") return
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }

    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function kickFocusIfSafe(requestId: string): Promise<void> {
  const job = inflight.get(requestId)
  if (!job) return
  if (!job.autoFocusPopup) return
  if (!job.sourceWindowId) return

  const now = Date.now()
  if (now - job.lastFocusKickAt < 20_000) return

  try {
    const src = await chrome.windows.get(job.sourceWindowId)
    if (!src.focused) return
  } catch {
    return
  }

  job.lastFocusKickAt = now
  inflight.set(requestId, job)

  // Popup window mode: focus the popup window, then restore focus.
  if (job.collectWindowId) {
    try {
      await chrome.windows.update(job.collectWindowId, { focused: true })
      try {
        await chrome.tabs.update(job.collectTabId, { active: true })
      } catch {
        // ignore
      }
    } catch {
      return
    }

    await new Promise((r) => setTimeout(r, 2500))

    try {
      await chrome.windows.update(job.sourceWindowId, { focused: true })
    } catch {
      // ignore
    }

    return
  }

  // New tab mode: briefly activate the collect tab in the current window, then return.
  try {
    await chrome.tabs.update(job.collectTabId, { active: true })
  } catch {
    return
  }

  await new Promise((r) => setTimeout(r, 2500))

  try {
    await chrome.tabs.update(job.sourceTabId, { active: true })
  } catch {
    // ignore
  }
}

function scheduleWatchdog(requestId: string): void {
  void chrome.alarms.create(`${WATCHDOG_PREFIX}${requestId}`, {
    periodInMinutes: 0.25, // 15s
    delayInMinutes: 0.25,
  })
}

function clearWatchdog(requestId: string): void {
  void chrome.alarms.clear(`${WATCHDOG_PREFIX}${requestId}`)
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("pc-collect:")) return
  const requestId = port.name.slice("pc-collect:".length)
  if (!requestId) return
  keepAlivePorts.set(requestId, port)
  port.onDisconnect.addListener(() => {
    const current = keepAlivePorts.get(requestId)
    if (current === port) keepAlivePorts.delete(requestId)
  })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(WATCHDOG_PREFIX)) return
  const requestId = alarm.name.slice(WATCHDOG_PREFIX.length)
  const job = inflight.get(requestId)
  if (!job) {
    clearWatchdog(requestId)
    return
  }
  const now = Date.now()
  if (now - job.lastProgressAt > 20_000) {
    void kickFocusIfSafe(requestId)
  }
})

async function sendMessageWithRetry<TMessage>(
  tabId: number,
  message: TMessage,
  tries = 10,
  delayMs = 300,
): Promise<void> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, message)
      return
    } catch {
      if (attempt === tries) throw new Error("Failed to message content script")
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== "object") return

  const typed = message as
    | StartCollectMessage
    | CancelCollectMessage
    | CollectProgressMessage
    | CollectFinishedMessage
    | CollectFailedMessage
    | AiOrganizeMessage

  if (typed.type === "AI_ORGANIZE") {
    void (async () => {
      try {
        const content = await organizeWithOpenAICompat(String(typed.text ?? ""))
        sendResponse({ ok: true, content } satisfies AiOrganizeResponse)
      } catch (e) {
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        } satisfies AiOrganizeResponse)
      }
    })()
    return true
  }

  if (typed.type === "START_COLLECT") {
    const sourceTabId = sender.tab?.id
    if (typeof sourceTabId !== "number") return
    const sourceWindowId =
      typeof sender.tab?.windowId === "number" ? sender.tab.windowId : null

    void (async () => {
      const { requestId, targetUrl, filters } = typed

      const existing = inflight.get(requestId)
      if (existing) {
        clearWatchdog(requestId)
        if (existing.collectWindowId) {
          try {
            await chrome.windows.remove(existing.collectWindowId)
          } catch {
            // ignore
          }
        } else {
          try {
            await chrome.tabs.remove(existing.collectTabId)
          } catch {
            // ignore
          }
        }
        inflight.delete(requestId)
      }

      await chrome.tabs.sendMessage(sourceTabId, {
        type: "COLLECT_PROGRESS",
        requestId,
        progress: { stage: "opening", collected: 0, scanned: 0 },
      } satisfies CollectProgressMessage)

      let collectTabId: number | undefined
      let collectWindowId: number | null = null

      const url = withCollectHash(targetUrl)

      try {
        if (filters.usePopupWindow) {
          const win = await chrome.windows.create({
            url,
            focused: false,
            type: "popup",
            width: 420,
            height: 820,
          })
          collectWindowId = typeof win.id === "number" ? win.id : null
          collectTabId = win.tabs?.[0]?.id
        } else {
          const tab = await chrome.tabs.create({
            url,
            active: false,
            windowId: sourceWindowId ?? undefined,
          })
          collectTabId = tab.id
        }
      } catch {
        // Fallback: some environments fail to create popup windows.
        try {
          const tab = await chrome.tabs.create({
            url,
            active: false,
            windowId: sourceWindowId ?? undefined,
          })
          collectTabId = tab.id
          collectWindowId = null
        } catch (error) {
          await chrome.tabs.sendMessage(sourceTabId, {
            type: "COLLECT_FAILED",
            requestId,
            error:
              error instanceof Error
                ? error.message
                : "Failed to open collect page",
          } satisfies CollectFailedMessage)
          return
        }
      }

      if (typeof collectTabId !== "number") {
        if (collectWindowId) {
          try {
            await chrome.windows.remove(collectWindowId)
          } catch {
            // ignore
          }
        }
        await chrome.tabs.sendMessage(sourceTabId, {
          type: "COLLECT_FAILED",
          requestId,
          error: "Failed to open collect page",
        } satisfies CollectFailedMessage)
        return
      }

      inflight.set(requestId, {
        sourceTabId,
        sourceWindowId,
        collectTabId,
        collectWindowId,
        targetUrl,
        keepCollectTabOpen: Boolean(filters.keepCollectTabOpen),
        autoFocusPopup: Boolean(filters.autoFocusPopup),
        lastProgressAt: Date.now(),
        lastProgressKey: "",
        lastFocusKickAt: 0,
      })

      scheduleWatchdog(requestId)
      if (filters.autoFocusPopup) {
        void kickFocusIfSafe(requestId)
      }

      try {
        await waitForTabComplete(collectTabId)
        await sendMessageWithRetry(collectTabId, {
          type: "RUN_COLLECT",
          requestId,
          filters,
        } satisfies RunCollectMessage)

        // Kick once after starting, because X may not load in a non-focused window.
        if (filters.autoFocusPopup) {
          void kickFocusIfSafe(requestId)
        }
      } catch (error) {
        inflight.delete(requestId)
        clearWatchdog(requestId)
        try {
          await chrome.tabs.remove(collectTabId)
        } catch {
          // ignore
        }

        await chrome.tabs.sendMessage(sourceTabId, {
          type: "COLLECT_FAILED",
          requestId,
          error: error instanceof Error ? error.message : "Unknown error",
        } satisfies CollectFailedMessage)
      }
    })()

    return
  }

  if (typed.type === "CANCEL_COLLECT") {
    const { requestId } = typed
    const job = inflight.get(requestId)
    if (!job) return
    inflight.delete(requestId)
    clearWatchdog(requestId)
    const port = keepAlivePorts.get(requestId)
    if (port) {
      keepAlivePorts.delete(requestId)
      try {
        port.disconnect()
      } catch {
        // ignore
      }
    }
    if (job.collectWindowId) {
      void chrome.windows.remove(job.collectWindowId)
    } else {
      void chrome.tabs.remove(job.collectTabId)
    }
    return
  }

  if (typed.type === "COLLECT_PROGRESS") {
    const job = inflight.get(typed.requestId)
    if (!job) return
    const progressKey = `${typed.progress.stage}:${typed.progress.collected}:${typed.progress.scanned}`
    const now = Date.now()
    const stuck =
      progressKey === job.lastProgressKey && now - job.lastProgressAt > 20_000
    job.lastProgressKey = progressKey
    job.lastProgressAt = now
    inflight.set(typed.requestId, job)

    void chrome.tabs.sendMessage(job.sourceTabId, typed)

    if (stuck) {
      void kickFocusIfSafe(typed.requestId)
    }
    return
  }

  if (typed.type === "COLLECT_FINISHED") {
    const job = inflight.get(typed.requestId)
    if (!job) return
    inflight.delete(typed.requestId)
    clearWatchdog(typed.requestId)

    void (async () => {
      try {
        await chrome.tabs.sendMessage(job.sourceTabId, typed)
      } finally {
        const port = keepAlivePorts.get(typed.requestId)
        if (port) {
          keepAlivePorts.delete(typed.requestId)
          try {
            port.disconnect()
          } catch {
            // ignore
          }
        }
        if (!job.keepCollectTabOpen) {
          if (job.collectWindowId) {
            try {
              await chrome.windows.remove(job.collectWindowId)
            } catch {
              // ignore
            }
          } else {
            try {
              await chrome.tabs.remove(job.collectTabId)
            } catch {
              // ignore
            }
          }
        }
      }
    })()
    return
  }

  if (typed.type === "COLLECT_FAILED") {
    const job = inflight.get(typed.requestId)
    if (!job) return
    inflight.delete(typed.requestId)
    clearWatchdog(typed.requestId)

    void (async () => {
      try {
        await chrome.tabs.sendMessage(job.sourceTabId, typed)
      } finally {
        const port = keepAlivePorts.get(typed.requestId)
        if (port) {
          keepAlivePorts.delete(typed.requestId)
          try {
            port.disconnect()
          } catch {
            // ignore
          }
        }
        if (!job.keepCollectTabOpen) {
          if (job.collectWindowId) {
            try {
              await chrome.windows.remove(job.collectWindowId)
            } catch {
              // ignore
            }
          } else {
            try {
              await chrome.tabs.remove(job.collectTabId)
            } catch {
              // ignore
            }
          }
        }
      }
    })()
  }
})
