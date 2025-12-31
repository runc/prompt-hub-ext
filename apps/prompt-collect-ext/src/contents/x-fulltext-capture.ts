import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://x.com/*", "https://twitter.com/*"],
  world: "MAIN",
  run_at: "document_start",
}

type FullTextCaptureItem = { id: string; text: string }

const EVENT_NAME = "prompt-collect-x-fulltext"
const INSTALL_KEY = "__prompt_collect_x_fulltext_capture_installed__"

function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const s = value.trim()
  return s ? s : null
}

function upsert(map: Map<string, string>, id: string, text: string): void {
  const prev = map.get(id)
  if (!prev || text.length > prev.length) map.set(id, text)
}

function collectTweetText(payload: unknown): FullTextCaptureItem[] {
  const out = new Map<string, string>()

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
      const noteResults = noteTweet?.note_tweet_results as
        | Record<string, unknown>
        | undefined
      const noteResult = noteResults?.result as Record<string, unknown> | undefined
      const noteText = safeString(noteResult?.text)

      const bestText = noteText ?? fullText
      if (bestText) upsert(out, restId, bestText)
    }

    for (const value of Object.values(record)) visit(value)
  }

  visit(payload)
  return Array.from(out, ([id, text]) => ({ id, text }))
}

function isLikelyTweetApiUrl(url: string): boolean {
  // X frequently serves tweet/timeline data via GraphQL or i/api/2 endpoints.
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
    const items = collectTweetText(json)
    dispatchItems(items)
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
    this: XMLHttpRequest & { __pc_url?: string },
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    const resolvedUrl = typeof url === "string" ? url : url.toString()
    this.__pc_url = resolvedUrl
    return originalOpen.call(
      this,
      method,
      resolvedUrl,
      async,
      username ?? undefined,
      password ?? undefined,
    )
  }

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest & { __pc_url?: string },
    body?: Document | BodyInit | null,
  ) {
    this.addEventListener(
      "loadend",
      () => {
        try {
          const url = this.__pc_url
          if (!url || !isLikelyTweetApiUrl(url)) return
          if (typeof this.responseText !== "string") return
          if (!this.responseText.trim().startsWith("{")) return
          const json = JSON.parse(this.responseText)
          dispatchItems(collectTweetText(json))
        } catch {
          // ignore
        }
      },
      { once: true },
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
