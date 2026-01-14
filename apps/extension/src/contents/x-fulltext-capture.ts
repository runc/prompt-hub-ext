import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://x.com/*", "https://twitter.com/*"],
  world: "MAIN",
  run_at: "document_start"
}

type FullTextCaptureItem = { id: string; text: string }

const EVENT_NAME = "prompt-hub-x-fulltext"
const INSTALL_KEY = "__prompt_hub_x_fulltext_capture_installed__"

function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const s = value.trim()
  return s ? s : null
}

type CapturedTweetData = {
  text?: string
  images: Set<string>
}

function upsertText(map: Map<string, CapturedTweetData>, id: string, text: string): void {
  const prev = map.get(id)
  if (!prev) {
    map.set(id, { text, images: new Set() })
    return
  }
  if (!prev.text || text.length > prev.text.length) prev.text = text
}

function upsertImage(map: Map<string, CapturedTweetData>, id: string, url: string): void {
  const prev = map.get(id)
  if (!prev) {
    map.set(id, { images: new Set([url]) })
    return
  }
  prev.images.add(url)
}

function safeUrl(value: unknown): string | null {
  const s = safeString(value)
  if (!s) return null
  try {
    const u = new URL(s)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    return u.toString()
  } catch {
    return null
  }
}

function collectPhotoUrls(maybeMedia: unknown): string[] {
  if (!Array.isArray(maybeMedia)) return []
  const out: string[] = []
  for (const item of maybeMedia) {
    if (!item || typeof item !== "object") continue
    const media = item as Record<string, unknown>
    const type = safeString(media.type)
    if (type && type !== "photo") continue
    const url = safeUrl(media.media_url_https ?? media.media_url)
    if (url) out.push(url)
  }
  return out
}

function collectTweetData(payload: unknown): Array<FullTextCaptureItem & { images: string[] }> {
  const out = new Map<string, CapturedTweetData>()

  const visit = (node: unknown) => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node !== "object") return

    const record = node as Record<string, unknown>
    const restId = safeString(record.rest_id)

    if (restId) {
      const legacy = record.legacy as Record<string, unknown> | undefined
      const fullText = safeString(legacy?.full_text ?? legacy?.text)

      const noteTweet = record.note_tweet as Record<string, unknown> | undefined
      const noteResults = noteTweet?.note_tweet_results as Record<string, unknown> | undefined
      const noteResult = noteResults?.result as Record<string, unknown> | undefined
      const noteText = safeString(noteResult?.text)

      const bestText = noteText ?? fullText
      if (bestText) upsertText(out, restId, bestText)

      const legacyExtended = legacy?.extended_entities as Record<string, unknown> | undefined
      const legacyEntities = legacy?.entities as Record<string, unknown> | undefined
      const recordExtended = record.extended_entities as Record<string, unknown> | undefined
      const recordEntities = record.entities as Record<string, unknown> | undefined

      const mediaArrays = [
        legacyExtended?.media,
        legacyEntities?.media,
        recordExtended?.media,
        recordEntities?.media
      ]

      for (const mediaArray of mediaArrays) {
        for (const url of collectPhotoUrls(mediaArray)) upsertImage(out, restId, url)
      }
    }

    for (const value of Object.values(record)) visit(value)
  }

  visit(payload)
  return Array.from(out, ([id, data]) => ({
    id,
    text: data.text ?? "",
    images: Array.from(data.images)
  })).filter((item) => item.text || item.images.length > 0)
}

function isLikelyTweetApiUrl(url: string): boolean {
  return (
    url.includes("/i/api/graphql/") ||
    url.includes("/i/api/2/timeline/") ||
    url.includes("/i/api/2/search/") ||
    url.includes("/i/api/2/") ||
    url.includes("/i/api/graphql")
  )
}

function dispatchItems(items: FullTextCaptureItem[]): void {
  if (items.length === 0) return
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { items } }))
}

async function captureFromResponse(url: string, response: Response): Promise<void> {
  try {
    if (!isLikelyTweetApiUrl(url)) return

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("application/json")) return

    const json = await response.clone().json()
    dispatchItems(collectTweetData(json))
  } catch {
    // ignore parse errors
  }
}

function patchFetch(): void {
  const originalFetch = window.fetch.bind(window)

  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const input = args[0]
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input)

    const res = await originalFetch(...args)
    void captureFromResponse(url, res)
    return res
  }
}

function patchXHR(): void {
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & { __ph_url?: string },
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    const resolvedUrl = typeof url === "string" ? url : url.toString()
    this.__ph_url = resolvedUrl
    return originalOpen.call(
      this,
      method,
      resolvedUrl,
      async ?? true,
      username ?? undefined,
      password ?? undefined
    )
  }

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest & { __ph_url?: string },
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    this.addEventListener(
      "loadend",
      () => {
        try {
          const url = this.__ph_url
          if (!url || !isLikelyTweetApiUrl(url)) return
          if (typeof this.responseText !== "string") return
          if (!this.responseText.trim().startsWith("{")) return
          const json = JSON.parse(this.responseText)
          dispatchItems(collectTweetData(json))
        } catch {
          // ignore
        }
      },
      { once: true }
    )

    return originalSend.call(this, body)
  }
}

function install(): void {
  const w = window as unknown as Record<string, unknown>
  if (w[INSTALL_KEY]) return
  w[INSTALL_KEY] = true

  patchFetch()
  patchXHR()
}

install()
