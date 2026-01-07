import type { PlasmoCSConfig } from "plasmo"

import { getCapturedTweetText, installXFullTextCaptureListener } from "~lib/x/fulltext"

export const config: PlasmoCSConfig = {
  matches: ["https://x.com/*", "https://twitter.com/*"],
  run_at: "document_idle",
}

type AiOrganizeResponse = { ok: true; content: string } | { ok: false; error: string }

const AI_STORAGE_KEYS = {
  modelscopeBaseUrl: "promptCollect.ai.modelscope.baseUrl",
  modelscopeApiKey: "promptCollect.ai.modelscope.apiKey",
  modelscopeModel: "promptCollect.ai.modelscope.model",
} as const

const MODELSCOPE_QWEN_DEFAULT_BASE_URL = "https://api-inference.modelscope.cn/v1"
const MODELSCOPE_QWEN_DEFAULT_MODEL = "qwen-plus"

type TweetInfo = {
  id: string
  url: string
  author: string | null
  createdAt: string | null
}

function getTweetIdFromUrl(url: string): string | null {
  const m = url.match(/\/status\/(\d+)/)
  return m?.[1] ?? null
}

function getAuthorFromStatusUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/)
    return m?.[1] ?? null
  } catch {
    const m = url.match(/\/([A-Za-z0-9_]{1,15})\/status\/\d+/)
    return m?.[1] ?? null
  }
}

function getTweetInfoFromArticle(article: Element): TweetInfo | null {
  const timeEl = article.querySelector("time") as HTMLTimeElement | null
  const createdAt = timeEl?.dateTime ?? null

  const urlEl =
    (timeEl?.closest("a") as HTMLAnchorElement | null) ??
    (article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null)
  const href = urlEl?.getAttribute("href")
  if (!href) return null

  const url = new URL(href, location.origin).toString()
  const id = getTweetIdFromUrl(url)
  if (!id) return null

  return { id, url, author: getAuthorFromStatusUrl(url), createdAt }
}

function getTweetTextFromArticle(article: Element): string {
  const textNodes = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
    .map((el) => (el as HTMLElement).innerText)
    .map((s) => s.replace(/\r/g, "").trim())
    .filter(Boolean)

  if (textNodes.length > 0) return textNodes.join("\n").trim()

  const langDivs = Array.from(article.querySelectorAll("div[lang]"))
    .map((el) => (el as HTMLElement).innerText.replace(/\r/g, "").trim())
    .filter(Boolean)
  return langDivs.sort((a, b) => b.length - a.length)[0] ?? ""
}

async function copyToClipboard(text: string): Promise<void> {
  const normalized = String(text ?? "")
  if (!normalized) return
  try {
    await navigator.clipboard.writeText(normalized)
    return
  } catch {
    // fallback
  }
  const ta = document.createElement("textarea")
  ta.value = normalized
  ta.style.position = "fixed"
  ta.style.left = "-9999px"
  ta.style.top = "0"
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  document.execCommand("copy")
  ta.remove()
}

type Overlay = {
  root: HTMLDivElement
  anchor: HTMLDivElement
  btn: HTMLButtonElement
  gear: HTMLButtonElement
  toast: HTMLDivElement
  modal: HTMLDivElement
  closeModal: () => void
  showToast: (text: string, tone?: "info" | "error") => void
  setBusy: (busy: boolean) => void
  setVisible: (visible: boolean) => void
  setPosition: (x: number, y: number) => void
}

let overlay: Overlay | null = null
let activeArticle: Element | null = null
let activeTweet: TweetInfo | null = null
let hideTimer: number | null = null
let rafPending = false

function ensureOverlay(): Overlay {
  if (overlay) return overlay

  const root = document.createElement("div")
  root.style.position = "fixed"
  root.style.inset = "0"
  root.style.zIndex = "2147483647"
  root.style.pointerEvents = "none"
  root.style.display = "none"

  const shadow = root.attachShadow({ mode: "open" })

  const style = document.createElement("style")
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .anchor { position: fixed; left: 0; top: 0; pointer-events: none; }
    .pill { pointer-events: auto; display: inline-flex; align-items: center; gap: 8px; padding: 8px; background: rgba(17,24,39,.92); border: 1px solid rgba(255,255,255,.14); border-radius: 999px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
    .btn { border: none; cursor: pointer; border-radius: 999px; padding: 8px 12px; font-size: 12px; font-weight: 650; color: #fff; background: #0ea5e9; white-space: nowrap; }
    .btn:disabled { opacity: .65; cursor: not-allowed; }
    .gear { border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.08); color: #fff; border-radius: 999px; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px; }
    .toast { pointer-events: none; position: fixed; left: 18px; bottom: 18px; max-width: min(520px, calc(100vw - 36px)); background: rgba(17,24,39,.92); color: #fff; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 10px 12px; font-size: 12px; line-height: 1.35; box-shadow: 0 10px 30px rgba(0,0,0,.25); opacity: 0; transform: translateY(6px); transition: opacity .16s ease, transform .16s ease; }
    .toast[data-show="true"] { opacity: 1; transform: translateY(0); }
    .toast[data-tone="error"] { background: rgba(153,27,27,.94); border-color: rgba(255,255,255,.18); }
    .backdrop { pointer-events: auto; position: fixed; inset: 0; background: rgba(0,0,0,.35); display: none; align-items: center; justify-content: center; padding: 24px 16px; }
    .backdrop[data-open="true"] { display: flex; }
    .modal { width: min(560px, 100%); background: #fff; border-radius: 16px; border: 1px solid rgba(17,24,39,.12); box-shadow: 0 18px 50px rgba(0,0,0,.25); overflow: hidden; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; color: #111827; }
    .hd { padding: 14px 16px; border-bottom: 1px solid rgba(17,24,39,.08); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .title { font-size: 14px; font-weight: 700; }
    .x { border: none; background: transparent; cursor: pointer; padding: 6px 8px; border-radius: 10px; }
    .x:hover { background: rgba(17,24,39,.06); }
    .bd { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; }
    .row { display: flex; flex-direction: column; gap: 6px; }
    .label { font-size: 12px; color: rgba(17,24,39,.72); }
    .input { width: 100%; border: 1px solid rgba(17,24,39,.18); border-radius: 12px; padding: 10px 12px; font-size: 13px; outline: none; }
    .input:focus { border-color: rgba(14,165,233,.7); box-shadow: 0 0 0 3px rgba(14,165,233,.18); }
    .ft { padding: 12px 16px; border-top: 1px solid rgba(17,24,39,.08); display: flex; gap: 10px; justify-content: flex-end; }
    .ghost { border: 1px solid rgba(17,24,39,.18); background: #fff; color: #111827; border-radius: 12px; padding: 10px 12px; font-weight: 650; cursor: pointer; }
    .primary { border: none; background: #0ea5e9; color: #fff; border-radius: 12px; padding: 10px 12px; font-weight: 650; cursor: pointer; }
  `

  const anchor = document.createElement("div")
  anchor.className = "anchor"

  const pill = document.createElement("div")
  pill.className = "pill"

  const btn = document.createElement("button")
  btn.className = "btn"
  btn.type = "button"
  btn.textContent = "AI 整理并复制"

  const gear = document.createElement("button")
  gear.className = "gear"
  gear.type = "button"
  gear.textContent = "⚙"

  pill.append(btn, gear)
  anchor.appendChild(pill)

  const toast = document.createElement("div")
  toast.className = "toast"
  toast.setAttribute("data-show", "false")
  toast.setAttribute("data-tone", "info")

  const backdrop = document.createElement("div")
  backdrop.className = "backdrop"

  const modal = document.createElement("div")
  modal.className = "modal"

  const hd = document.createElement("div")
  hd.className = "hd"
  const title = document.createElement("div")
  title.className = "title"
  title.textContent = "Prompt Collect AI 设置"
  const close = document.createElement("button")
  close.className = "x"
  close.type = "button"
  close.textContent = "关闭"
  hd.append(title, close)

  const bd = document.createElement("div")
  bd.className = "bd"

  const baseUrlRow = document.createElement("div")
  baseUrlRow.className = "row"
  const baseUrlLabel = document.createElement("div")
  baseUrlLabel.className = "label"
  baseUrlLabel.textContent = "Base URL（OpenAI 兼容，不要包含 /chat/completions）"
  const baseUrlInput = document.createElement("input")
  baseUrlInput.className = "input"
  baseUrlInput.placeholder = MODELSCOPE_QWEN_DEFAULT_BASE_URL
  baseUrlRow.append(baseUrlLabel, baseUrlInput)

  const modelRow = document.createElement("div")
  modelRow.className = "row"
  const modelLabel = document.createElement("div")
  modelLabel.className = "label"
  modelLabel.textContent = "模型名称"
  const modelInput = document.createElement("input")
  modelInput.className = "input"
  modelInput.placeholder = MODELSCOPE_QWEN_DEFAULT_MODEL
  modelRow.append(modelLabel, modelInput)

  const keyRow = document.createElement("div")
  keyRow.className = "row"
  const keyLabel = document.createElement("div")
  keyLabel.className = "label"
  keyLabel.textContent = "API Key"
  const keyInput = document.createElement("input")
  keyInput.className = "input"
  keyInput.type = "password"
  keyInput.placeholder = "sk-..."
  keyRow.append(keyLabel, keyInput)

  bd.append(baseUrlRow, modelRow, keyRow)

  const ft = document.createElement("div")
  ft.className = "ft"
  const cancelBtn = document.createElement("button")
  cancelBtn.className = "ghost"
  cancelBtn.type = "button"
  cancelBtn.textContent = "取消"
  const saveBtn = document.createElement("button")
  saveBtn.className = "primary"
  saveBtn.type = "button"
  saveBtn.textContent = "保存"
  ft.append(cancelBtn, saveBtn)

  modal.append(hd, bd, ft)
  backdrop.appendChild(modal)

  shadow.append(style, anchor, toast, backdrop)
  document.documentElement.appendChild(root)

  let toastTimer: number | null = null
  const showToast = (text: string, tone: "info" | "error" = "info") => {
    toast.textContent = text
    toast.setAttribute("data-tone", tone)
    toast.setAttribute("data-show", "true")
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toast.setAttribute("data-show", "false")
    }, 2200)
  }

  const closeModal = () => {
    backdrop.setAttribute("data-open", "false")
  }

  close.addEventListener("click", closeModal)
  cancelBtn.addEventListener("click", closeModal)
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal()
  })
  modal.addEventListener("click", (e) => e.stopPropagation())

  const loadSettingsIntoInputs = async () => {
    const raw = await chrome.storage.local.get([
      AI_STORAGE_KEYS.modelscopeBaseUrl,
      AI_STORAGE_KEYS.modelscopeApiKey,
      AI_STORAGE_KEYS.modelscopeModel,
    ])
    baseUrlInput.value =
      typeof raw[AI_STORAGE_KEYS.modelscopeBaseUrl] === "string"
        ? raw[AI_STORAGE_KEYS.modelscopeBaseUrl]
        : MODELSCOPE_QWEN_DEFAULT_BASE_URL
    modelInput.value =
      typeof raw[AI_STORAGE_KEYS.modelscopeModel] === "string"
        ? raw[AI_STORAGE_KEYS.modelscopeModel]
        : MODELSCOPE_QWEN_DEFAULT_MODEL
    keyInput.value =
      typeof raw[AI_STORAGE_KEYS.modelscopeApiKey] === "string"
        ? raw[AI_STORAGE_KEYS.modelscopeApiKey]
        : ""
  }

  const openSettings = async () => {
    await loadSettingsIntoInputs()
    backdrop.setAttribute("data-open", "true")
    baseUrlInput.focus()
  }

  saveBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({
      [AI_STORAGE_KEYS.modelscopeBaseUrl]: String(baseUrlInput.value || "").trim(),
      [AI_STORAGE_KEYS.modelscopeModel]: String(modelInput.value || "").trim(),
      [AI_STORAGE_KEYS.modelscopeApiKey]: String(keyInput.value || "").trim(),
    })
    showToast("已保存 AI 设置")
    closeModal()
  })

  gear.addEventListener("click", () => {
    void openSettings()
  })

  const setBusy = (busy: boolean) => {
    btn.disabled = busy
    gear.disabled = busy
    btn.textContent = busy ? "整理中…" : "AI 整理并复制"
  }

  const setVisible = (visible: boolean) => {
    root.style.display = visible ? "block" : "none"
  }

  const setPosition = (x: number, y: number) => {
    anchor.style.left = `${Math.round(x)}px`
    anchor.style.top = `${Math.round(y)}px`
  }

  overlay = {
    root,
    anchor,
    btn,
    gear,
    toast,
    modal: backdrop,
    closeModal,
    showToast,
    setBusy,
    setVisible,
    setPosition,
  }

  btn.addEventListener("click", () => {
    void organizeActiveTweet()
  })

  anchor.addEventListener("pointerenter", () => {
    if (hideTimer) {
      window.clearTimeout(hideTimer)
      hideTimer = null
    }
  })
  anchor.addEventListener("pointerleave", () => {
    scheduleHide(120)
  })

  return overlay
}

function scheduleHide(delayMs: number) {
  if (hideTimer) window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    hideTimer = null
    activeArticle = null
    activeTweet = null
    ensureOverlay().setVisible(false)
  }, delayMs)
}

function updateAnchorPosition() {
  if (!activeArticle) return
  const o = ensureOverlay()
  const rect = (activeArticle as HTMLElement).getBoundingClientRect()
  const margin = 10
  const x = Math.min(window.innerWidth - margin, Math.max(margin, rect.right - 8))
  const y = Math.min(window.innerHeight - margin, Math.max(margin, rect.top + 8))
  o.setPosition(x, y)
}

function scheduleReposition() {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    updateAnchorPosition()
  })
}

async function organizeActiveTweet() {
  const o = ensureOverlay()
  if (!activeTweet || !activeArticle) return

  const id = activeTweet.id
  const captured = getCapturedTweetText(id)
  const domText = getTweetTextFromArticle(activeArticle)
  const text = (captured && (!domText || captured.length >= domText.length) ? captured : domText).trim()

  if (!text) {
    o.showToast("未提取到正文", "error")
    return
  }

  const inputLines = [
    `url: ${activeTweet.url}`,
    activeTweet.author ? `author: @${activeTweet.author}` : "",
    activeTweet.createdAt ? `created_at: ${activeTweet.createdAt}` : "",
    "",
    text,
  ].filter(Boolean)

  o.setBusy(true)
  o.showToast("AI 整理中…")
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "AI_ORGANIZE",
      text: inputLines.join("\n"),
    })) as AiOrganizeResponse

    if (!res || typeof res !== "object" || !("ok" in res)) {
      throw new Error("AI 响应异常")
    }
    if (!res.ok) {
      const msg = res.error || "AI 失败"
      if (msg.includes("未配置")) {
        o.showToast(msg, "error")
        o.modal.setAttribute("data-open", "true")
      } else {
        o.showToast(msg, "error")
      }
      return
    }

    await copyToClipboard(res.content)
    o.showToast("已复制（content）")
  } catch (e) {
    o.showToast(e instanceof Error ? e.message : String(e), "error")
  } finally {
    o.setBusy(false)
  }
}

function closestTweetArticle(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  return target.closest('article[data-testid="tweet"]')
}

function onPointerOver(e: PointerEvent) {
  if (overlay?.modal.getAttribute("data-open") === "true") return
  const article = closestTweetArticle(e.target)
  if (!article) return
  if (activeArticle === article) return

  const info = getTweetInfoFromArticle(article)
  if (!info) return

  activeArticle = article
  activeTweet = info

  if (hideTimer) {
    window.clearTimeout(hideTimer)
    hideTimer = null
  }

  const o = ensureOverlay()
  o.setVisible(true)
  updateAnchorPosition()
}

function onPointerOut(e: PointerEvent) {
  const from = closestTweetArticle(e.target)
  if (!from) return
  const to = closestTweetArticle(e.relatedTarget)
  if (from && from === to) return
  scheduleHide(120)
}

installXFullTextCaptureListener()

document.addEventListener("pointerover", onPointerOver, true)
document.addEventListener("pointerout", onPointerOut, true)
window.addEventListener("scroll", scheduleReposition, true)
window.addEventListener("resize", scheduleReposition)

