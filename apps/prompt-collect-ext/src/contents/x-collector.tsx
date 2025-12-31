/* eslint-disable react-refresh/only-export-components */
import type { PlasmoCSConfig } from "plasmo"
import React, { useEffect, useMemo, useRef, useState } from "react"
import {
  collectTweetsFromCurrentPage,
} from "~lib/x/scrape"
import { installXFullTextCaptureListener } from "~lib/x/fulltext"
import type {
  CollectFilters,
  CollectMode,
  CollectProgress,
  CollectResult,
} from "~lib/x/types"

export const config: PlasmoCSConfig = {
  matches: ["https://x.com/*", "https://twitter.com/*"],
  run_at: "document_start",
}

type CollectMethod = "tab" | "window" | "current"

type BgProgressMessage = {
  type: "COLLECT_PROGRESS"
  requestId: string
  progress: { stage: "opening" | "collecting" | "finalizing"; collected: number; scanned: number }
}

type BgFinishedMessage = {
  type: "COLLECT_FINISHED"
  requestId: string
  result: CollectResult
}

type BgFailedMessage = {
  type: "COLLECT_FAILED"
  requestId: string
  error: string
}

type BgRunCollectMessage = {
  type: "RUN_COLLECT"
  requestId: string
  filters: CollectFilters
}

const RESERVED_PATHS = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "i",
  "search",
  "compose",
  "settings",
  "login",
  "signup",
  "logout",
  "intent",
  "hashtag",
])

function isProfilePath(pathname: string): { username: string; mode: CollectMode } | null {
  const parts = pathname.split("?")[0]?.split("/").filter(Boolean) ?? []
  if (parts.length === 0) return null
  if (parts[0].startsWith("@")) return null
  if (RESERVED_PATHS.has(parts[0])) return null
  if (parts[1] === "status") return null
  if (parts.length === 1) return { username: parts[0], mode: "posts" }
  if (parts.length === 2 && parts[1] === "with_replies")
    return { username: parts[0], mode: "replies" }
  return null
}

function ensureLocationPatch(): void {
  const key = "__prompt_collect_location_patch__"
  const w = window as unknown as Record<string, unknown>
  if (w[key]) return
  w[key] = true

  const dispatch = () => window.dispatchEvent(new Event("prompt-collect-locationchange"))

  const pushState = history.pushState.bind(history)
  const replaceState = history.replaceState.bind(history)

  history.pushState = (...args: Parameters<History["pushState"]>) => {
    pushState(...args)
    dispatch()
  }
  history.replaceState = (...args: Parameters<History["replaceState"]>) => {
    replaceState(...args)
    dispatch()
  }
  window.addEventListener("popstate", dispatch)
}

function formatMarkdown(result: CollectResult): string {
  const lines: string[] = []
  lines.push(`# X Collect`)
  lines.push(``)
  lines.push(`- target: ${result.targetUrl}`)
  lines.push(`- collectedAt: ${result.collectedAt}`)
  lines.push(`- count: ${result.items.length}`)
  lines.push(``)
  for (const item of result.items) {
    const when = item.createdAt ? ` (${item.createdAt})` : ""
    const text = item.text ? item.text.replace(/\n+/g, " ").trim() : ""
    lines.push(`- ${item.url}${when}${text ? ` — ${text}` : ""}`)
  }
  lines.push(``)
  return lines.join("\n")
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function isSilentCollectMode(): boolean {
  const hash = location.hash.replace(/^#/, "")
  if (!hash) return false
  return hash.split("&").includes("pc_collect=1")
}

function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return initial
      return JSON.parse(raw) as T
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // ignore
    }
  }, [key, value])

  return [value, setValue] as const
}

// Install early so we don't miss the initial timeline GraphQL responses.
installXFullTextCaptureListener()

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = `
  :host{ all: initial; }
  .pc-root{ font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; color: #111827; }
  .pc-root, .pc-root *{ box-sizing: border-box; }
  .pc-btn{ width: 44px; height: 44px; border-radius: 999px; background:#111827; color:#fff; border:1px solid rgba(255,255,255,.12); box-shadow:0 10px 30px rgba(0,0,0,.25); display:flex; align-items:center; justify-content:center; cursor:pointer; user-select:none; }
  .pc-btn:active{ transform: translateY(1px); }
  .pc-fab{ position: fixed; z-index: 2147483647; }
  .pc-panel-backdrop{ position: fixed; inset:0; background: rgba(0,0,0,.35); z-index:2147483647; }
  .pc-panel{ position: fixed; z-index:2147483647; right: 18px; top: 18px; width: 360px; max-width: calc(100vw - 24px); background:#fff; border:1px solid rgba(17,24,39,.12); border-radius: 14px; box-shadow:0 18px 50px rgba(0,0,0,.25); overflow:hidden; }
  .pc-panel-hd{ padding: 12px 14px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(17,24,39,.08); }
  .pc-title{ font-size: 14px; font-weight: 650; }
  .pc-close{ border:none; background:transparent; cursor:pointer; padding: 6px 8px; border-radius: 8px; }
  .pc-close:hover{ background: rgba(17,24,39,.06); }
  .pc-body{ padding: 12px 14px; display:flex; flex-direction:column; gap: 10px; }
  .pc-row{ display:flex; gap: 10px; align-items:flex-start; flex-wrap: wrap; }
  .pc-row .pc-col{ min-width: 160px; flex: 1 1 160px; }
  .pc-col{ display:flex; flex-direction:column; gap: 6px; }
  .pc-label{ font-size: 12px; color: rgba(17,24,39,.75); }
  .pc-input{ width:100%; border:1px solid rgba(17,24,39,.18); border-radius: 10px; padding: 8px 10px; font-size: 13px; outline:none; }
  .pc-input:focus{ border-color: rgba(14,165,233,.7); box-shadow: 0 0 0 3px rgba(14,165,233,.18); }
  .pc-radio{ display:flex; gap:10px; flex-wrap:wrap; }
  .pc-chip{ border:1px solid rgba(17,24,39,.18); border-radius: 999px; padding: 6px 10px; font-size: 12px; cursor:pointer; user-select:none; background:#fff; }
  .pc-chip[data-active="true"]{ border-color: rgba(14,165,233,.8); background: rgba(14,165,233,.08); }
  .pc-actions{ display:flex; gap: 10px; padding: 12px 14px; border-top:1px solid rgba(17,24,39,.08); }
  .pc-primary{ flex: 1; border:none; background: #0ea5e9; color:#fff; border-radius: 12px; padding: 10px 12px; font-weight: 650; cursor:pointer; }
  .pc-primary:disabled{ opacity:.6; cursor:not-allowed; }
  .pc-ghost{ border:1px solid rgba(17,24,39,.18); background:#fff; color:#111827; border-radius: 12px; padding: 10px 12px; font-weight: 650; cursor:pointer; }
  .pc-muted{ font-size: 12px; color: rgba(17,24,39,.65); line-height: 1.4; }
  .pc-results{ max-height: 40vh; overflow:auto; border:1px solid rgba(17,24,39,.10); border-radius: 12px; padding: 10px; background: rgba(17,24,39,.02); }
  .pc-results a{ color:#0b72a6; text-decoration:none; }
  .pc-results a:hover{ text-decoration:underline; }
  `
  return style
}

export default function XCollector() {
  const silentCollect = isSilentCollectMode()
  const [profile, setProfile] = useState(() => isProfilePath(location.pathname))
  const [panelOpen, setPanelOpen] = useState(false)
  const [mode, setMode] = useState<CollectMode>(
    "posts",
  )
  const [collectMethod, setCollectMethod] = useStoredState<CollectMethod>(
    "pc_collectMethod",
    "tab",
  )
  const [days, setDays] = useStoredState<number>("pc_days", 7)
  const [keywordQuery, setKeywordQuery] = useStoredState<string>("pc_keywords", "")
  const [maxItems, setMaxItems] = useStoredState<number>("pc_maxItems", 200)
  const [keepCollectTabOpen, setKeepCollectTabOpen] = useStoredState<boolean>(
    "pc_keepCollectTabOpen",
    false,
  )
  const [autoFocusPopup, setAutoFocusPopup] = useStoredState<boolean>(
    "pc_autoFocusPopup",
    true,
  )

  const [requestId, setRequestId] = useState<string | null>(null)
  const [progress, setProgress] = useState<CollectProgress | { stage: "opening"; collected: number; scanned: number } | null>(null)
  const [result, setResult] = useState<CollectResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const keepAlivePortRef = useRef<chrome.runtime.Port | null>(null)
  const currentAbortRef = useRef<AbortController | null>(null)

  const draggingRef = useRef<{
    startX: number
    startY: number
    startTop: number
    startLeft: number
  } | null>(null)
  const didDragRef = useRef(false)
  const pointerIdRef = useRef<number | null>(null)

  const [fabPos, setFabPos] = useStoredState<{ top: number; left: number; dock: "left" | "right" }>(
    "pc_fabPos",
    { top: Math.round(window.innerHeight * 0.35), left: 0, dock: "right" },
  )

  const fabStyle = useMemo(() => {
    const top = clamp(fabPos.top, 12, window.innerHeight - 56)
    const base: React.CSSProperties = { top }
    if (fabPos.dock === "right") base.right = 14
    else base.left = 14
    return base
  }, [fabPos])

  useEffect(() => {
    ensureLocationPatch()
    const onChange = () => {
      const nextProfile = isProfilePath(location.pathname)
      setProfile(nextProfile)
    }
    window.addEventListener("prompt-collect-locationchange", onChange)
    return () => window.removeEventListener("prompt-collect-locationchange", onChange)
  }, [])

  useEffect(() => {
    if (!requestId) return
    return () => {
      const port = keepAlivePortRef.current
      keepAlivePortRef.current = null
      if (!port) return
      try {
        port.disconnect()
      } catch {
        // ignore
      }
    }
  }, [requestId])

  useEffect(() => {
    const onMessage = (msg: unknown) => {
      if (!msg || typeof msg !== "object") return
      const message = msg as BgProgressMessage | BgFinishedMessage | BgFailedMessage | BgRunCollectMessage

      if (message.type === "RUN_COLLECT") {
        void (async () => {
          try {
            let lastSent = 0
            const collected = await collectTweetsFromCurrentPage(
              message.filters,
              (p) => {
                const now = Date.now()
                if (now - lastSent < 350) return
                lastSent = now
                void chrome.runtime.sendMessage({
                  type: "COLLECT_PROGRESS",
                  requestId: message.requestId,
                  progress: p,
                })
              },
            )
            await chrome.runtime.sendMessage({
              type: "COLLECT_FINISHED",
              requestId: message.requestId,
              result: collected,
            })
          } catch (e) {
            await chrome.runtime.sendMessage({
              type: "COLLECT_FAILED",
              requestId: message.requestId,
              error: e instanceof Error ? e.message : "Unknown error",
            })
          }
        })()
        return
      }

      if (!requestId || message.requestId !== requestId) return

      if (message.type === "COLLECT_PROGRESS") {
        setProgress(message.progress)
        return
      }

      if (message.type === "COLLECT_FINISHED") {
        setProgress(null)
        setResult(message.result)
        setError(null)
        const port = keepAlivePortRef.current
        keepAlivePortRef.current = null
        if (port) {
          try {
            port.disconnect()
          } catch {
            // ignore
          }
        }
        return
      }

      if (message.type === "COLLECT_FAILED") {
        setProgress(null)
        setError(message.error)
        const port = keepAlivePortRef.current
        keepAlivePortRef.current = null
        if (port) {
          try {
            port.disconnect()
          } catch {
            // ignore
          }
        }
      }
    }

    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [requestId])

  const beginDrag: React.PointerEventHandler<HTMLDivElement> = (e) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    draggingRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTop: rect.top,
      startLeft: rect.left,
    }
    didDragRef.current = false
    pointerIdRef.current = e.pointerId
  }

  const onDragMove: React.PointerEventHandler<HTMLDivElement> = (e) => {
    const state = draggingRef.current
    if (!state) return
    const dx = e.clientX - state.startX
    const dy = e.clientY - state.startY
    if (!didDragRef.current) {
      if (Math.hypot(dx, dy) < 6) return
      didDragRef.current = true
      try {
        ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      } catch {
        // ignore
      }
    }
    const newTop = clamp(state.startTop + dy, 12, window.innerHeight - 56)
    const midpoint = window.innerWidth / 2
    const dock: "left" | "right" = e.clientX < midpoint ? "left" : "right"
    setFabPos({ top: Math.round(newTop), left: 0, dock })
  }

  const endDrag: React.PointerEventHandler<HTMLDivElement> = () => {
    draggingRef.current = null
    pointerIdRef.current = null
  }

  if (!profile) return null

  const filters: CollectFilters = {
    mode,
    username: profile.username,
    days: clamp(Number(days) || 0, 0, 365),
    keywordQuery,
    maxItems: clamp(Number(maxItems) || 1, 1, 2000),
    keepCollectTabOpen: collectMethod === "current" ? false : keepCollectTabOpen,
    usePopupWindow: collectMethod === "window",
    autoFocusPopup: collectMethod === "current" ? false : autoFocusPopup,
  }

  const targetUrl = `${location.origin}/${profile.username}`
  const previewUrl =
    mode === "replies" ? `${targetUrl}/with_replies` : targetUrl

  const busy = Boolean(progress)

  const startCollect = async () => {
    setResult(null)
    setError(null)

    const newRequestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    setRequestId(newRequestId)

    if (collectMethod === "current") {
      try {
        currentAbortRef.current?.abort()
      } catch {
        // ignore
      }
      const controller = new AbortController()
      currentAbortRef.current = controller
      try {
        setProgress({ stage: "collecting", collected: 0, scanned: 0 })
        const res = await collectTweetsFromCurrentPage(filters, setProgress, {
          signal: controller.signal,
        })
        setProgress(null)
        setResult(res)
        setError(null)
      } catch (e) {
        setProgress(null)
        setError(e instanceof Error ? e.message : "Unknown error")
      } finally {
        if (currentAbortRef.current === controller) currentAbortRef.current = null
      }
      return
    }

    setProgress({ stage: "opening", collected: 0, scanned: 0 })
    const port = chrome.runtime.connect({ name: `pc-collect:${newRequestId}` })
    keepAlivePortRef.current = port
    port.onDisconnect.addListener(() => {
      if (keepAlivePortRef.current === port) keepAlivePortRef.current = null
    })
    await chrome.runtime.sendMessage({
      type: "START_COLLECT",
      requestId: newRequestId,
      targetUrl,
      filters,
    })
  }

  const cancelCollect = async () => {
    if (!requestId) return
    setProgress(null)
    setError("Canceled")
    const controller = currentAbortRef.current
    currentAbortRef.current = null
    if (controller) {
      controller.abort()
      return
    }
    const port = keepAlivePortRef.current
    keepAlivePortRef.current = null
    if (port) {
      try {
        port.disconnect()
      } catch {
        // ignore
      }
    }
    await chrome.runtime.sendMessage({ type: "CANCEL_COLLECT", requestId })
  }

  const copyMarkdown = async () => {
    if (!result) return
    await navigator.clipboard.writeText(formatMarkdown(result))
  }

  return (
    <div className="pc-root">
      {!silentCollect && (
        <div
          className="pc-fab"
          style={fabStyle}
        >
          <div
            className="pc-btn"
            role="button"
            aria-label="Collect X"
            title="抓取该博主推文/回复"
            onPointerDown={beginDrag}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={() => {
              if (didDragRef.current) {
                didDragRef.current = false
                return
              }
              setMode("posts")
              setPanelOpen(true)
            }}
          >
            抓
          </div>
        </div>
      )}

      {!silentCollect && panelOpen && (
        <>
          <div className="pc-panel-backdrop" onClick={() => setPanelOpen(false)} />
          <div className="pc-panel" role="dialog" aria-modal="true">
            <div className="pc-panel-hd">
              <div className="pc-title">抓取 @{profile.username}</div>
              <button className="pc-close" onClick={() => setPanelOpen(false)}>
                ✕
              </button>
            </div>

            <div className="pc-body">
              <div className="pc-col">
                <div className="pc-label">内容类型</div>
                <div className="pc-radio">
                  <div className="pc-chip" data-active={mode === "posts"} onClick={() => setMode("posts")}>
                    推文 posts
                  </div>
                  <div className="pc-chip" data-active={mode === "replies"} onClick={() => setMode("replies")}>
                    回复 replies
                  </div>
                </div>
              </div>

              <div className="pc-row">
                <div className="pc-col" style={{ flex: 1 }}>
                  <div className="pc-label">最近几天 (0=不限)</div>
                  <input
                    className="pc-input"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={365}
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  />
                </div>
                <div className="pc-col" style={{ flex: 1 }}>
                  <div className="pc-label">最大条数</div>
                  <input
                    className="pc-input"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={2000}
                    value={maxItems}
                    onChange={(e) => setMaxItems(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="pc-col">
                <div className="pc-label">关键词 (逗号分隔, 任意命中)</div>
                <input
                  className="pc-input"
                  value={keywordQuery}
                  onChange={(e) => setKeywordQuery(e.target.value)}
                  placeholder="例如: AI, prompt, agent"
                />
              </div>

              <div className="pc-col">
                <div className="pc-label">抓取方式（默认新标签页）</div>
                <div className="pc-radio">
                  <div
                    className="pc-chip"
                    data-active={collectMethod === "tab"}
                    onClick={() => setCollectMethod("tab")}
                  >
                    新标签页 tab
                  </div>
                  <div
                    className="pc-chip"
                    data-active={collectMethod === "window"}
                    onClick={() => setCollectMethod("window")}
                  >
                    独立窗口 window（更稳）
                  </div>
                  <div
                    className="pc-chip"
                    data-active={collectMethod === "current"}
                    onClick={() => setCollectMethod("current")}
                  >
                    当前页 current（会滚动页面）
                  </div>
                </div>
              </div>

              {collectMethod !== "current" && (
                <div className="pc-col">
                  <div className="pc-label">排查/高级</div>
                  <label className="pc-row" style={{ gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={keepCollectTabOpen}
                      onChange={(e) => setKeepCollectTabOpen(e.target.checked)}
                    />
                    <div className="pc-muted">抓取完成后保留抓取页</div>
                  </label>

                  <label className="pc-row" style={{ gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={autoFocusPopup}
                      onChange={(e) => setAutoFocusPopup(e.target.checked)}
                    />
                    <div className="pc-muted">
                      卡住时自动激活抓取页（tab 模式会短暂切换标签）
                    </div>
                  </label>
                </div>
              )}

              <div className="pc-muted">
                目标页面: <a href={previewUrl} target="_blank" rel="noreferrer">{previewUrl}</a>
              </div>

              {progress && (
                <div className="pc-muted">
                  {progress.stage === "opening" ? "正在打开后台页…" : null}
                  {progress.stage === "collecting"
                    ? `正在抓取… 已收集 ${progress.collected} / 扫描 ${progress.scanned}`
                    : null}
                  {progress.stage === "finalizing"
                    ? `正在整理… 已收集 ${progress.collected} / 扫描 ${progress.scanned}`
                    : null}
                </div>
              )}

              {error && <div className="pc-muted" style={{ color: "#b91c1c" }}>错误: {error}</div>}

              {result && (
                <div className="pc-col">
                  <div className="pc-muted">结果: {result.items.length} 条</div>
                  <div className="pc-results">
                    {result.items.slice(0, 50).map((it) => (
                      <div key={it.id} style={{ marginBottom: 8 }}>
                        <a href={it.url} target="_blank" rel="noreferrer">{it.url}</a>
                        {it.createdAt ? <span className="pc-muted"> {" "}({it.createdAt})</span> : null}
                        {it.text ? <div className="pc-muted">{it.text}</div> : null}
                      </div>
                    ))}
                    {result.items.length > 50 ? (
                      <div className="pc-muted">仅预览前 50 条；复制可获得完整列表。</div>
                    ) : null}
                  </div>
                </div>
              )}
            </div>

            <div className="pc-actions">
              {busy ? (
                <button className="pc-ghost" onClick={cancelCollect}>
                  取消
                </button>
              ) : (
                <button className="pc-ghost" onClick={() => setPanelOpen(false)}>
                  关闭
                </button>
              )}

              {result ? (
                <button className="pc-primary" onClick={copyMarkdown}>
                  复制 Markdown
                </button>
              ) : (
                <button className="pc-primary" onClick={startCollect} disabled={busy}>
                  {busy ? "抓取中…" : "开始抓取"}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
