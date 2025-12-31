import type { PlasmoCSConfig } from "plasmo"

type LocalPromptRecord = {
  id: number
  title: string
  content: string
  category?: string | null
  tags?: string[]
  images?: string[]
  videos?: string[]
  created_at?: string | null
  updated_at?: string | null
}

type ListLocalPromptsResponse =
  | { ok: true; prompts: LocalPromptRecord[] }
  | { ok: false; error: string }

export const config: PlasmoCSConfig = {
  matches: [
    "https://deepseek.com/*",
    "https://www.deepseek.com/*",
    "https://chat.deepseek.com/*"
  ],
  all_frames: true
}

const TRIGGER = "@@"
const MAX_RESULTS = 60

function isTextInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (!(el instanceof HTMLInputElement)) return false
  const type = (el.type || "").toLowerCase()
  return (
    type === "text" ||
    type === "search" ||
    type === "email" ||
    type === "url" ||
    type === "tel" ||
    type === "password"
  )
}

function isEditable(el: Element | null): el is HTMLElement {
  return !!el && el instanceof HTMLElement && (el.isContentEditable || isTextInput(el))
}

function getActiveEditable(): HTMLElement | null {
  const a = document.activeElement
  if (!isEditable(a)) return null
  return a
}

function getEditableFromComposedPath(path: EventTarget[]): HTMLElement | null {
  for (const t of path) {
    if (t instanceof HTMLElement && isEditable(t)) return t
  }
  return null
}

function getLastTwoCharsBeforeCaret(el: HTMLElement): string | null {
  if (isTextInput(el)) {
    const pos = el.selectionStart ?? 0
    if (pos < 2) return null
    return el.value.slice(pos - 2, pos)
  }

  if (!el.isContentEditable) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return null

  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  const textNode = node as Text
  const offset = range.startOffset
  if (offset < 2) return null
  return (textNode.data || "").slice(offset - 2, offset)
}

function replaceTriggerWithText(el: HTMLElement, text: string): boolean {
  if (isTextInput(el)) {
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? start
    if (start < 2) return false
    const before = el.value.slice(0, start - 2)
    const after = el.value.slice(end)
    el.value = `${before}${text}${after}`
    const nextPos = before.length + text.length
    el.setSelectionRange(nextPos, nextPos)
    el.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  }

  if (!el.isContentEditable) return false
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return false

  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return false
  const textNode = node as Text
  const offset = range.startOffset
  if (offset < 2) return false
  const lastTwo = (textNode.data || "").slice(offset - 2, offset)
  if (lastTwo !== TRIGGER) return false

  const r = document.createRange()
  r.setStart(textNode, offset - 2)
  r.setEnd(textNode, offset)
  r.deleteContents()
  const inserted = document.createTextNode(text)
  r.insertNode(inserted)

  const after = document.createRange()
  after.setStart(inserted, inserted.data.length)
  after.setEnd(inserted, inserted.data.length)
  sel.removeAllRanges()
  sel.addRange(after)
  el.dispatchEvent(new Event("input", { bubbles: true }))
  return true
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // fallthrough
  }
  const ta = document.createElement("textarea")
  ta.value = text
  ta.style.position = "fixed"
  ta.style.left = "-9999px"
  ta.style.top = "0"
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  document.execCommand("copy")
  ta.remove()
}

async function listLocalPrompts(): Promise<LocalPromptRecord[]> {
  const res = (await chrome.runtime.sendMessage({
    type: "promptHub.listLocalPrompts"
  })) as ListLocalPromptsResponse
  if (!res || typeof res !== "object") return []
  if (!("ok" in res) || !res.ok) throw new Error((res as any).error || "加载本地 prompts 失败")
  return res.prompts ?? []
}

function normalize(text: string): string {
  return text.trim().toLowerCase()
}

function matchPrompt(p: LocalPromptRecord, needle: string): boolean {
  if (!needle) return true
  const n = normalize(needle)
  if (normalize(p.title).includes(n)) return true
  if (normalize(p.content).includes(n)) return true
  if (normalize(p.category ?? "").includes(n)) return true
  for (const t of p.tags ?? []) {
    if (normalize(t).includes(n)) return true
  }
  return false
}

type OverlayState = {
  root: HTMLDivElement
  shadow: ShadowRoot
  backdrop: HTMLDivElement
  panel: HTMLDivElement
  search: HTMLInputElement
  list: HTMLDivElement
  status: HTMLDivElement
  close: () => void
}

let overlay: OverlayState | null = null
let lastActiveEditable: HTMLElement | null = null

function ensureOverlay(): OverlayState {
  if (overlay) return overlay

  const root = document.createElement("div")
  root.id = "prompt-hub-overlay-root"
  root.style.position = "fixed"
  root.style.inset = "0"
  root.style.zIndex = "2147483647"
  root.style.display = "none"

  const shadow = root.attachShadow({ mode: "open" })

  const style = document.createElement("style")
  style.textContent = `
    :host { all: initial; }
    :host, * { box-sizing: border-box; }
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.35);
      backdrop-filter: blur(2px);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 64px 18px 18px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
    }
    .panel {
      width: min(860px, 100%);
      background: #fff;
      border: 1px solid rgba(0,0,0,.10);
      border-radius: 16px;
      box-shadow: 0 18px 60px rgba(0,0,0,.25);
      overflow: hidden;
      --px: 18px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px var(--px, 18px);
      border-bottom: 1px solid rgba(0,0,0,.08);
      background: linear-gradient(180deg, #ffffff, #fafafa);
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      color: #111827;
      white-space: nowrap;
    }
    .hint {
      font-size: 12px;
      color: #6b7280;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .close {
      border: 1px solid rgba(0,0,0,.12);
      background: #fff;
      border-radius: 10px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
      color: #111827;
    }
    .body {
      padding: 16px var(--px, 18px) 18px;
    }
    .search {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(0,0,0,.18);
      outline: none;
      font-size: 14px;
    }
    .status {
      margin-top: 10px;
      font-size: 12px;
      color: #6b7280;
      min-height: 16px;
    }
    .list {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: min(520px, calc(100vh - 220px));
      overflow: auto;
      padding: 10px;
    }
    .item {
      border: 1px solid rgba(0,0,0,.10);
      border-radius: 14px;
      padding: 12px 14px;
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      background: #fff;
    }
    .item:hover { border-color: rgba(37, 99, 235, .4); }
    .meta { min-width: 0; }
    .itemTitle {
      font-size: 14px;
      font-weight: 600;
      color: #111827;
      word-break: break-word;
    }
    .itemSub {
      margin-top: 2px;
      font-size: 12px;
      color: #6b7280;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(0,0,0,.05);
      color: #374151;
    }
    .actions {
      display: flex;
      flex-direction: row;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }
    .btn {
      border: 1px solid rgba(0,0,0,.12);
      background: #fff;
      border-radius: 10px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
      color: #111827;
      white-space: nowrap;
    }
    .primary {
      background: #2563eb;
      border-color: #2563eb;
      color: #fff;
    }
    .btn:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
  `

  const backdrop = document.createElement("div")
  backdrop.className = "backdrop"

  const panel = document.createElement("div")
  panel.className = "panel"
  panel.addEventListener("click", (e) => e.stopPropagation())

  const header = document.createElement("div")
  header.className = "header"

  const title = document.createElement("div")
  title.className = "title"
  title.textContent = "Prompt Hub"

  const hint = document.createElement("div")
  hint.className = "hint"
  hint.textContent = "输入 @@ 召出；Esc 关闭；点击“插入”会替换 @@"

  const closeBtn = document.createElement("button")
  closeBtn.className = "close"
  closeBtn.type = "button"
  closeBtn.textContent = "关闭 (Esc)"

  header.append(title, hint, closeBtn)

  const body = document.createElement("div")
  body.className = "body"

  const search = document.createElement("input")
  search.className = "search"
  search.placeholder = "搜索标题 / 内容 / 分类 / 标签…"

  const status = document.createElement("div")
  status.className = "status"

  const list = document.createElement("div")
  list.className = "list"

  body.append(search, status, list)
  panel.append(header, body)
  backdrop.append(panel)

  shadow.append(style, backdrop)
  document.documentElement.appendChild(root)

  const close = () => {
    root.style.display = "none"
    list.replaceChildren()
    status.textContent = ""
    overlay = overlay // keep instance
  }

  backdrop.addEventListener("click", close)
  closeBtn.addEventListener("click", close)

  overlay = { root, shadow, backdrop, panel, search, list, status, close }
  return overlay
}

function renderList(
  state: OverlayState,
  prompts: LocalPromptRecord[],
  onInsert: (p: LocalPromptRecord) => void,
  onCopy: (p: LocalPromptRecord) => void
) {
  state.list.replaceChildren()
  const frag = document.createDocumentFragment()

  for (const p of prompts) {
    const item = document.createElement("div")
    item.className = "item"

    const meta = document.createElement("div")
    meta.className = "meta"

    const t = document.createElement("div")
    t.className = "itemTitle"
    t.textContent = p.title || "(无标题)"

    const sub = document.createElement("div")
    sub.className = "itemSub"
    if (p.category) {
      const badge = document.createElement("span")
      badge.className = "badge"
      badge.textContent = p.category
      sub.appendChild(badge)
    }
    const tags = (p.tags ?? []).slice(0, 5)
    for (const tag of tags) {
      const badge = document.createElement("span")
      badge.className = "badge"
      badge.textContent = tag
      sub.appendChild(badge)
    }

    meta.append(t, sub)

    const actions = document.createElement("div")
    actions.className = "actions"

    const insertBtn = document.createElement("button")
    insertBtn.className = "btn primary"
    insertBtn.type = "button"
    insertBtn.textContent = "插入"
    insertBtn.addEventListener("click", () => onInsert(p))

    const copyBtn = document.createElement("button")
    copyBtn.className = "btn"
    copyBtn.type = "button"
    copyBtn.textContent = "复制"
    copyBtn.addEventListener("click", () => onCopy(p))

    actions.append(insertBtn, copyBtn)

    item.append(meta, actions)
    frag.appendChild(item)
  }

  state.list.appendChild(frag)
}

async function openOverlay() {
  const state = ensureOverlay()
  state.root.style.display = "block"
  state.search.value = ""
  state.status.textContent = "加载中…"
  state.search.focus()

  let prompts: LocalPromptRecord[] = []
  try {
    prompts = await listLocalPrompts()
  } catch (e) {
    state.status.textContent = e instanceof Error ? e.message : String(e)
    renderList(state, [], () => {}, () => {})
    return
  }

  const applyFilter = () => {
    const needle = state.search.value
    const filtered = prompts.filter((p) => matchPrompt(p, needle)).slice(0, MAX_RESULTS)
    state.status.textContent =
      filtered.length === 0
        ? "无匹配结果"
        : `显示 ${filtered.length}${prompts.length > filtered.length ? ` / ${prompts.length}` : ""}`
    renderList(
      state,
      filtered,
      (p) => {
        const target = lastActiveEditable
        if (target && replaceTriggerWithText(target, p.content)) {
          state.close()
          target.focus()
          return
        }
        void copyToClipboard(p.content).then(() => {
          state.status.textContent = "已复制（未能插入）"
        })
      },
      (p) => {
        void copyToClipboard(p.content).then(() => {
          state.status.textContent = "已复制"
        })
      }
    )
  }

  state.search.oninput = applyFilter
  applyFilter()
}

function isOverlayOpen(): boolean {
  return !!overlay && overlay.root.style.display !== "none"
}

function closeOverlayIfOpen() {
  if (!overlay) return
  if (overlay.root.style.display === "none") return
  overlay.close()
}

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") {
      closeOverlayIfOpen()
      return
    }
  },
  true
)

document.addEventListener(
  "input",
  async (e) => {
    if (isOverlayOpen()) return
    const fromPath = getEditableFromComposedPath(
      typeof (e as any).composedPath === "function" ? (e as any).composedPath() : []
    )
    const target = fromPath ?? getActiveEditable()
    if (!target) return
    const lastTwo = getLastTwoCharsBeforeCaret(target)
    if (lastTwo !== TRIGGER) return
    lastActiveEditable = target
    await openOverlay()
  },
  true
)
