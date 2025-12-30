import type {
  CollectFilters,
  CollectProgress,
  CollectResult,
  CollectedTweet,
} from "./types"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function parseKeywords(keywordQuery: string): string[] {
  return keywordQuery
    .split(/[,，\n]/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

function getTweetIdFromUrl(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/)
  return match?.[1] ?? null
}

function isPinnedTweet(article: Element): boolean {
  const social = article.querySelector('[data-testid="socialContext"]')
  const text = (social?.textContent ?? "").trim()
  return text.includes("Pinned") || text.includes("置顶") || text.includes("已置顶")
}

function extractTweetFromArticle(article: Element): CollectedTweet | null {
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

  const textNodes = Array.from(
    article.querySelectorAll('[data-testid="tweetText"]'),
  )
    .map((el) => (el as HTMLElement).innerText)
    .map((s) => s.trim())
    .filter(Boolean)

  let text = textNodes.join("\n").trim()
  if (!text) {
    const langDivs = Array.from(article.querySelectorAll("div[lang]"))
      .map((el) => (el as HTMLElement).innerText.trim())
      .filter(Boolean)
    text = langDivs.sort((a, b) => b.length - a.length)[0] ?? ""
  }

  return { id, url, createdAt, text }
}

function applyFilters(
  items: CollectedTweet[],
  filters: CollectFilters,
): CollectedTweet[] {
  const keywords = parseKeywords(filters.keywordQuery).map((k) =>
    k.toLowerCase(),
  )

  const cutoff =
    Number.isFinite(filters.days) && filters.days > 0
      ? Date.now() - filters.days * 24 * 60 * 60 * 1000
      : null

  const filtered = items.filter((item) => {
    if (cutoff && item.createdAt) {
      const ts = Date.parse(item.createdAt)
      if (Number.isFinite(ts) && ts < cutoff) return false
    }

    if (keywords.length > 0) {
      const haystack = `${item.text}\n${item.url}`.toLowerCase()
      if (!keywords.some((k) => haystack.includes(k))) return false
    }

    return true
  })

  filtered.sort((a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : 0
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0
    return bt - at
  })

  return filtered.slice(0, Math.max(1, filters.maxItems))
}

async function waitForTweets(timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (document.querySelector('article[data-testid="tweet"]')) return
    await sleep(250)
  }
  throw new Error("No tweets found on the page (maybe not logged in?)")
}

export async function collectTweetsFromCurrentPage(
  filters: CollectFilters,
  onProgress?: (progress: CollectProgress) => void,
): Promise<CollectResult> {
  const maxItems = Math.max(1, Math.min(2000, Math.floor(filters.maxItems)))
  const normalizedFilters: CollectFilters = { ...filters, maxItems }

  await waitForTweets()

  const seen = new Set<string>()
  const collected: CollectedTweet[] = []

  let scanned = 0
  let noNewRounds = 0
  let stableHeightRounds = 0
  let lastHeight = document.body.scrollHeight

  const cutoff =
    Number.isFinite(filters.days) && filters.days > 0
      ? Date.now() - filters.days * 24 * 60 * 60 * 1000
      : null

  let consecutiveNewOlderThanCutoff = 0

  while (collected.length < maxItems) {
    const articles = Array.from(
      document.querySelectorAll('article[data-testid="tweet"]'),
    )

    let newCount = 0

    for (const article of articles) {
      const tweet = extractTweetFromArticle(article)
      if (!tweet) continue
      if (seen.has(tweet.id)) continue
      seen.add(tweet.id)
      scanned++

      collected.push(tweet)
      newCount++

      if (cutoff && tweet.createdAt && !isPinnedTweet(article)) {
        const ts = Date.parse(tweet.createdAt)
        if (Number.isFinite(ts) && ts < cutoff) {
          consecutiveNewOlderThanCutoff++
        } else {
          consecutiveNewOlderThanCutoff = 0
        }
      }
    }

    onProgress?.({ stage: "collecting", collected: collected.length, scanned })

    if (newCount === 0) noNewRounds++
    else noNewRounds = 0

    if (noNewRounds >= 5) break
    if (cutoff && consecutiveNewOlderThanCutoff >= 25) break

    window.scrollTo(0, document.body.scrollHeight)
    await sleep(1200)

    const height = document.body.scrollHeight
    if (height === lastHeight) stableHeightRounds++
    else stableHeightRounds = 0
    lastHeight = height

    if (stableHeightRounds >= 5) break
  }

  onProgress?.({ stage: "finalizing", collected: collected.length, scanned })

  const items = applyFilters(collected, normalizedFilters)

  return {
    targetUrl: location.href,
    collectedAt: new Date().toISOString(),
    items,
  }
}

