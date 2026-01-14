import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://x.com/*", "https://twitter.com/*"],
  run_at: "document_start"
}

const EVENT_NAME = "prompt-hub-x-fulltext"
const LISTENER_KEY = "__prompt_hub_x_fulltext_listener_installed__"

const tweetTextById = new Map<string, string>()
const tweetImagesById = new Map<string, string[]>()

function normalizeText(text: string): string {
  return text.replace(/\r/g, "").trim()
}

function upsertCapturedTweetText(id: string, text: string): void {
  const normalizedId = String(id).trim()
  const normalized = normalizeText(String(text))
  if (!normalizedId || !normalized) return
  const existing = tweetTextById.get(normalizedId)
  if (!existing || normalized.length > existing.length) tweetTextById.set(normalizedId, normalized)
}

function normalizeImageUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return []
  const out: string[] = []
  for (const u of urls) {
    if (typeof u !== "string") continue
    const s = u.trim()
    if (!s) continue
    out.push(s)
  }
  return Array.from(new Set(out))
}

function upsertCapturedTweetImages(id: string, urls: unknown): void {
  const normalizedId = String(id).trim()
  if (!normalizedId) return
  const next = normalizeImageUrls(urls)
  if (next.length === 0) return
  const prev = tweetImagesById.get(normalizedId) ?? []
  tweetImagesById.set(normalizedId, Array.from(new Set([...prev, ...next])))
}

function getCapturedTweetText(id: string): string | null {
  const normalizedId = String(id).trim()
  if (!normalizedId) return null
  return tweetTextById.get(normalizedId) ?? null
}

function getCapturedTweetImages(id: string): string[] {
  const normalizedId = String(id).trim()
  if (!normalizedId) return []
  return tweetImagesById.get(normalizedId) ?? []
}

function installFullTextListener(): void {
  const w = window as unknown as Record<string, unknown>
  if (w[LISTENER_KEY]) return
  w[LISTENER_KEY] = true

  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail
    if (!detail || typeof detail !== "object") return
    const items = (detail as { items?: unknown }).items
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (!item || typeof item !== "object") continue
      const id = (item as { id?: unknown }).id
      const text = (item as { text?: unknown }).text
      const images = (item as { images?: unknown }).images
      if (typeof id !== "string" || typeof text !== "string") continue
      upsertCapturedTweetText(id, text)
      upsertCapturedTweetImages(id, images)
    }
  }

  window.addEventListener(EVENT_NAME, onEvent as EventListener)
}

type TweetInfo = {
  id: string
  url: string
}

function getTweetIdFromUrl(url: string): string | null {
  const m = url.match(/\/status\/(\d+)/)
  return m?.[1] ?? null
}

function getTweetInfoFromArticle(article: Element): TweetInfo | null {
  const timeEl = article.querySelector("time") as HTMLTimeElement | null
  const urlEl =
    (timeEl?.closest("a") as HTMLAnchorElement | null) ??
    (article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null)
  const href = urlEl?.getAttribute("href")
  if (!href) return null

  const url = new URL(href, location.origin).toString()
  const id = getTweetIdFromUrl(url)
  if (!id) return null

  return { id, url }
}

function getTweetTextFromArticle(article: Element): string {
  const textNodes = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
    .map((el) => (el as HTMLElement).innerText)
    .map((s) => normalizeText(s))
    .filter(Boolean)

  if (textNodes.length > 0) return textNodes.join("\n").trim()

  const langDivs = Array.from(article.querySelectorAll("div[lang]"))
    .map((el) => normalizeText((el as HTMLElement).innerText))
    .filter(Boolean)
  return langDivs.sort((a, b) => b.length - a.length)[0] ?? ""
}

type Overlay = {
  root: HTMLDivElement
  anchor: HTMLDivElement
  btn: HTMLButtonElement
  gear: HTMLButtonElement
  toast: HTMLDivElement
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
    .btn { border: none; cursor: pointer; border-radius: 999px; padding: 8px 12px; font-size: 12px; font-weight: 650; color: #fff; background: #2563eb; white-space: nowrap; }
    .btn:disabled { opacity: .65; cursor: not-allowed; }
    .gear { border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.08); color: #fff; border-radius: 999px; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px; }
    .gear:disabled { opacity: .65; cursor: not-allowed; }
    .toast { pointer-events: none; position: fixed; left: 18px; bottom: 18px; max-width: min(520px, calc(100vw - 36px)); background: rgba(17,24,39,.92); color: #fff; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 10px 12px; font-size: 12px; line-height: 1.35; box-shadow: 0 10px 30px rgba(0,0,0,.25); opacity: 0; transform: translateY(6px); transition: opacity .16s ease, transform .16s ease; }
    .toast[data-show="true"] { opacity: 1; transform: translateY(0); }
    .toast[data-tone="error"] { background: rgba(153,27,27,.94); border-color: rgba(255,255,255,.18); }
  `

  const anchor = document.createElement("div")
  anchor.className = "anchor"

  const pill = document.createElement("div")
  pill.className = "pill"

  const btn = document.createElement("button")
  btn.className = "btn"
  btn.type = "button"
  btn.textContent = "AI 整理"

  const gear = document.createElement("button")
  gear.className = "gear"
  gear.type = "button"
  gear.textContent = "⚙"
  gear.title = "打开 Prompt Hub 设置（ModelScope）"

  pill.append(btn, gear)
  anchor.appendChild(pill)

  const toast = document.createElement("div")
  toast.className = "toast"
  toast.setAttribute("data-show", "false")
  toast.setAttribute("data-tone", "info")

  shadow.append(style, anchor, toast)

  const parent = document.documentElement ?? document.body
  parent?.appendChild(root)

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

  const setBusy = (busy: boolean) => {
    btn.disabled = busy
    gear.disabled = busy
  }

  const setVisible = (visible: boolean) => {
    root.style.display = visible ? "block" : "none"
  }

  const setPosition = (x: number, y: number) => {
    anchor.style.left = `${Math.round(x)}px`
    anchor.style.top = `${Math.round(y)}px`
  }

  btn.addEventListener("click", () => {
    void openPromptHubWithActiveTweet()
  })

  gear.addEventListener("click", () => {
    try {
      chrome?.runtime?.openOptionsPage?.()
    } catch {
      // ignore
    }
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

  overlay = { root, anchor, btn, gear, toast, showToast, setBusy, setVisible, setPosition }
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

async function openPromptHubWithActiveTweet() {
  const o = ensureOverlay()
  if (!activeTweet || !activeArticle) return

  const captured = getCapturedTweetText(activeTweet.id)
  const capturedImages = getCapturedTweetImages(activeTweet.id)
  const domText = getTweetTextFromArticle(activeArticle)
  const raw = (captured && (!domText || captured.length >= domText.length) ? captured : domText).trim()

  if (!raw) {
    o.showToast("未提取到正文", "error")
    return
  }

  o.setBusy(true)
  o.showToast("打开 Prompt Hub…")
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "promptHub.openPasteEditor",
      text:
        capturedImages.length > 0
          ? `${raw}\n\n相关引用图片:\n${capturedImages.map((u) => `- ${u}`).join("\n")}`
          : raw
    })) as { ok?: unknown; error?: unknown }

    if (!res || typeof res !== "object" || res.ok !== true) {
      throw new Error(typeof res?.error === "string" ? res.error : "打开 Prompt Hub 失败")
    }
    o.showToast("已填入「新建本地 Prompt / 粘贴整理」")
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

installFullTextListener()

document.addEventListener("pointerover", onPointerOver, true)
document.addEventListener("pointerout", onPointerOut, true)
window.addEventListener("scroll", scheduleReposition, true)
window.addEventListener("resize", scheduleReposition)
