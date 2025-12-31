export type FullTextCaptureItem = {
  id: string
  text: string
}

const EVENT_NAME = "prompt-collect-x-fulltext"
const LISTENER_KEY = "__prompt_collect_x_fulltext_listener_installed__"

const tweetTextById = new Map<string, string>()

function normalizeText(text: string): string {
  return text.replace(/\r/g, "").trim()
}

export function upsertCapturedTweetText(id: string, text: string): void {
  const normalizedId = String(id).trim()
  const normalizedText = normalizeText(String(text))
  if (!normalizedId || !normalizedText) return

  const existing = tweetTextById.get(normalizedId)
  if (!existing || normalizedText.length > existing.length) {
    tweetTextById.set(normalizedId, normalizedText)
  }
}

export function getCapturedTweetText(id: string): string | null {
  const normalizedId = String(id).trim()
  if (!normalizedId) return null
  return tweetTextById.get(normalizedId) ?? null
}

export function installXFullTextCaptureListener(): () => void {
  const w = window as unknown as Record<string, unknown>
  if (w[LISTENER_KEY]) return () => {}
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
      if (typeof id !== "string" || typeof text !== "string") continue
      upsertCapturedTweetText(id, text)
    }
  }

  window.addEventListener(EVENT_NAME, onEvent as EventListener)

  return () => {
    window.removeEventListener(EVENT_NAME, onEvent as EventListener)
    delete w[LISTENER_KEY]
  }
}

