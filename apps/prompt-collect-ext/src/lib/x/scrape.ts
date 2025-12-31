import type {
  CollectFilters,
  CollectProgress,
  CollectResult,
  CollectedTweet,
} from "./types"
import { getCapturedTweetText } from "./fulltext"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal) return
  if (signal.aborted) throw new Error("Canceled")
}

async function waitForSelector(
  selector: string,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<Element> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal)
    const el = document.querySelector(selector)
    if (el) return el
    await sleep(250)
  }
  throw new Error(`Timed out waiting for selector: ${selector}`)
}

function getTweetIdFromHref(href: string): string | null {
  try {
    const url = new URL(href, location.origin).toString()
    return getTweetIdFromUrl(url)
  } catch {
    return getTweetIdFromUrl(href)
  }
}

function getTweetIdFromArticle(article: Element): string | null {
  const href = (article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null)?.getAttribute(
    "href",
  )
  if (!href) return null
  return getTweetIdFromHref(href)
}

function hasNewUnseenTweet(seen: Set<string>): boolean {
  const articles = document.querySelectorAll('article[data-testid="tweet"]')
  for (const article of articles) {
    const href = (article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null)?.getAttribute(
      "href",
    )
    if (!href) continue
    const id = getTweetIdFromHref(href)
    if (!id) continue
    if (!seen.has(id)) return true
  }
  return false
}

async function waitForNewUnseenTweet(
  seen: Set<string>,
  timeoutMs = 12_000,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal)
  if (hasNewUnseenTweet(seen)) return true

  return await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      observer.disconnect()
      signal?.removeEventListener("abort", onAbort)
      clearTimeout(timer)
      resolve(value)
    }

    const observer = new MutationObserver(() => {
      if (hasNewUnseenTweet(seen)) finish(true)
    })

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })

    const onAbort = () => finish(false)
    signal?.addEventListener("abort", onAbort, { once: true })

    const timer = window.setTimeout(() => {
      finish(hasNewUnseenTweet(seen))
    }, timeoutMs)
  })
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

function getUsernameFromHref(href: string): string | null {
  const cleaned = href.split("?")[0]?.split("#")[0] ?? href
  const match = cleaned.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/)
  return match?.[1] ?? null
}

function normalizeUsername(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase()
}

function getAuthorUsernameFromStatusUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const match = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/)
    return match?.[1] ?? null
  } catch {
    const match = url.match(/\/([A-Za-z0-9_]{1,15})\/status\/\d+/)
    return match?.[1] ?? null
  }
}

function isPinnedTweet(article: Element): boolean {
  const social = article.querySelector('[data-testid="socialContext"]')
  const text = (social?.textContent ?? "").trim()
  return text.includes("Pinned") || text.includes("置顶") || text.includes("已置顶")
}

function isPromotedTweet(article: Element): boolean {
  const social = article.querySelector('[data-testid="socialContext"]')
  const text = (social?.textContent ?? "").trim()
  return text.includes("Promoted") || text.includes("推广") || text.includes("广告")
}

function isRepostedByTarget(article: Element, username: string): boolean {
  const social = article.querySelector('[data-testid="socialContext"]')
  if (!social) return false
  const u = normalizeUsername(username)

  const container = social.parentElement ?? social
  const links = Array.from(container.querySelectorAll('a[href^="/"]'))
  return links.some((a) => {
    const href = a.getAttribute("href")
    if (!href) return false
    return normalizeUsername(getUsernameFromHref(href) ?? "") === u
  })
}

function getAuthorUsernameFromArticle(article: Element): string | null {
  const fromUserName = article.querySelector(
    '[data-testid="User-Name"] a[href^="/"]',
  ) as HTMLAnchorElement | null
  const href = fromUserName?.getAttribute("href")
  if (href) return getUsernameFromHref(href)

  const fromProfileLink = article.querySelector(
    'a[href^="/"][role="link"]',
  ) as HTMLAnchorElement | null
  const href2 = fromProfileLink?.getAttribute("href")
  if (href2) return getUsernameFromHref(href2)

  return null
}

function isNestedTweetArticle(article: Element): boolean {
  const parent = article.parentElement
  if (!parent) return false
  return parent.closest('article[data-testid="tweet"]') !== null
}

type ExtractDetail = {
  tweet: CollectedTweet | null
  reason:
  | "ok"
  | "nested"
  | "promoted"
  | "author_mismatch"
  | "missing_href"
  | "missing_id"
}

function extractTweetFromArticleDetailed(
  article: Element,
  username: string,
  mode: CollectFilters["mode"],
): ExtractDetail {
  if (isNestedTweetArticle(article)) return { tweet: null, reason: "nested" }
  if (isPromotedTweet(article)) return { tweet: null, reason: "promoted" }

  const timeEl = article.querySelector("time") as HTMLTimeElement | null
  const createdAt = timeEl?.dateTime ?? null

  const urlEl =
    (timeEl?.closest("a") as HTMLAnchorElement | null) ??
    (article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null)
  const href = urlEl?.getAttribute("href")
  if (!href) return { tweet: null, reason: "missing_href" }

  const url = new URL(href, location.origin).toString()
  const id = getTweetIdFromUrl(url)
  if (!id) return { tweet: null, reason: "missing_id" }

  const target = normalizeUsername(username)
  const authorFromUrl = getAuthorUsernameFromStatusUrl(url)
  const author =
    authorFromUrl ??
    getAuthorUsernameFromArticle(article) ??
    getUsernameFromHref(href)

  const normalizedAuthor = author ? normalizeUsername(author) : null

  if (mode === "replies") {
    if (normalizedAuthor && normalizedAuthor !== target)
      return { tweet: null, reason: "author_mismatch" }
  } else {
    if (normalizedAuthor === target) {
      // ok
    } else if (isRepostedByTarget(article, target)) {
      // include reposted tweets in Posts tab
    } else if (normalizedAuthor) {
      return { tweet: null, reason: "author_mismatch" }
    }
  }

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

  const captured = getCapturedTweetText(id)
  if (captured && (!text || captured.length > text.length)) {
    text = captured
  }

  return { tweet: { id, url, createdAt, text }, reason: "ok" }
}

function matchesFilters(
  item: CollectedTweet,
  cutoff: number | null,
  keywords: string[],
): boolean {
  if (cutoff && item.createdAt) {
    const ts = Date.parse(item.createdAt)
    if (Number.isFinite(ts) && ts < cutoff) return false
  }

  if (keywords.length > 0) {
    const haystack = `${item.text}\n${item.url}`.toLowerCase()
    if (!keywords.some((k) => haystack.includes(k))) return false
  }

  return true
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

async function waitForTweets(timeoutMs = 20_000, signal?: AbortSignal): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal)
    if (document.querySelector('article[data-testid="tweet"]')) return
    await sleep(250)
  }
  throw new Error("No tweets found on the page (maybe not logged in?)")
}

async function ensureProfileTabSelected(
  username: string,
  mode: CollectFilters["mode"],
  signal?: AbortSignal,
): Promise<void> {
  const baseHref = `/${username}`
  const repliesHref = `/${username}/with_replies`
  const desiredHref = mode === "replies" ? repliesHref : baseHref

  if (location.pathname === desiredHref) return

  const selector = `a[role="tab"][href="${desiredHref}"]`
  await waitForSelector(selector, 15_000, signal)

  const tab = document.querySelector(selector) as HTMLAnchorElement | null
  if (!tab) return

  const selected = tab.getAttribute("aria-selected") === "true"
  if (!selected) tab.click()

  const selectedSelector = `${selector}[aria-selected="true"]`
  await waitForSelector(selectedSelector, 15_000, signal)
}

async function expandTweet(article: Element, signal?: AbortSignal): Promise<void> {
  const showMoreBtn = article.querySelector('[data-testid="tweet-text-show-more-link"]') as HTMLElement | null
  if (!showMoreBtn) return

  // Scroll into view to ensure clickability (sometimes needed)
  showMoreBtn.scrollIntoView({ block: "nearest" })

  showMoreBtn.click()

  // Wait for the text to likely expand. 
  // Since it's a React state update, it's usually fast, but we give it a small buffer.
  // We can't easily wait for a specific DOM change because we don't know the full text beforehand.
  await sleep(350)
  throwIfAborted(signal)
}

export async function collectTweetsFromCurrentPage(
  filters: CollectFilters,
  onProgress?: (progress: CollectProgress) => void,
  options?: { signal?: AbortSignal },
): Promise<CollectResult> {
  const maxItems = Math.max(1, Math.min(2000, Math.floor(filters.maxItems)))
  const normalizedFilters: CollectFilters = { ...filters, maxItems }

  const signal = options?.signal
  throwIfAborted(signal)

  await ensureProfileTabSelected(filters.username, filters.mode, signal)
  await waitForTweets(20_000, signal)

  const seen = new Set<string>()
  const accepted: CollectedTweet[] = []

  let scanned = 0
  let noNewRounds = 0

  const cutoff =
    Number.isFinite(filters.days) && filters.days > 0
      ? Date.now() - filters.days * 24 * 60 * 60 * 1000
      : null

  const keywords = parseKeywords(filters.keywordQuery).map((k) => k.toLowerCase())
  const maxScanned =
    keywords.length > 0 && !cutoff ? Math.min(50_000, Math.max(10_000, maxItems * 100)) : 20_000

  let consecutiveNewOlderThanCutoff = 0

  const debug = Boolean(filters.keepCollectTabOpen)
  const debugCounters = {
    seenArticles: 0,
    extractedOk: 0,
    skippedNested: 0,
    skippedPromoted: 0,
    skippedAuthorMismatch: 0,
    skippedMissingHref: 0,
    skippedMissingId: 0,
    matchedFilters: 0,
  }

  const startedAt = Date.now()
  let lastNewAt = Date.now()
  let stopReason:
    | "reached_max_items"
    | "max_scanned"
    | "cutoff_older"
    | "no_new_timeout"
    | "overall_timeout"
    | "unknown" = "unknown"

  while (accepted.length < maxItems) {
    throwIfAborted(signal)
    const articles = Array.from(
      document.querySelectorAll('article[data-testid="tweet"]'),
    )

    for (const article of articles) {
      throwIfAborted(signal)

      // If we already captured full text from network responses, avoid clicking "Show more".
      const maybeId = getTweetIdFromArticle(article)
      if (!maybeId || !getCapturedTweetText(maybeId)) {
        await expandTweet(article, signal)
      }

      debugCounters.seenArticles++
      const detail = extractTweetFromArticleDetailed(
        article,
        filters.username,
        filters.mode,
      )
      const tweet = detail.tweet

      if (!tweet) {
        if (detail.reason === "nested") debugCounters.skippedNested++
        if (detail.reason === "promoted") debugCounters.skippedPromoted++
        if (detail.reason === "author_mismatch") debugCounters.skippedAuthorMismatch++
        if (detail.reason === "missing_href") debugCounters.skippedMissingHref++
        if (detail.reason === "missing_id") debugCounters.skippedMissingId++
        continue
      }

      if (!tweet) continue
      if (seen.has(tweet.id)) continue
      seen.add(tweet.id)
      scanned++

      debugCounters.extractedOk++
      if (matchesFilters(tweet, cutoff, keywords)) {
        debugCounters.matchedFilters++
        accepted.push(tweet)
      }

      if (cutoff && tweet.createdAt) {
        if (isPinnedTweet(article)) continue
        const ts = Date.parse(tweet.createdAt)
        if (Number.isFinite(ts) && ts < cutoff) {
          consecutiveNewOlderThanCutoff++
        } else {
          consecutiveNewOlderThanCutoff = 0
        }
      }
    }

    onProgress?.({ stage: "collecting", collected: accepted.length, scanned })

    if (accepted.length >= maxItems) {
      stopReason = "reached_max_items"
      break
    }
    if (scanned >= maxScanned) {
      stopReason = "max_scanned"
      break
    }
    if (cutoff && consecutiveNewOlderThanCutoff >= 25) {
      stopReason = "cutoff_older"
      break
    }

    if (Date.now() - startedAt > 8 * 60_000) {
      stopReason = "overall_timeout"
      break
    }
    if (Date.now() - lastNewAt > 2 * 60_000) {
      stopReason = "no_new_timeout"
      break
    }

    const scrollEl = document.scrollingElement ?? document.documentElement
    const step = Math.max(420, Math.floor(scrollEl.clientHeight * 0.6))
    for (let i = 0; i < 5; i++) {
      throwIfAborted(signal)
      scrollEl.scrollBy(0, step)
      await sleep(220)
    }

    const gotNew = await waitForNewUnseenTweet(seen, 25_000, signal)
    if (!gotNew) {
      noNewRounds++
      await sleep(300 + Math.min(4000, noNewRounds * 700))
    } else {
      noNewRounds = 0
      lastNewAt = Date.now()
    }
  }

  onProgress?.({ stage: "finalizing", collected: accepted.length, scanned })

  const items = applyFilters(accepted, normalizedFilters)

  if (debug) {
    console.log("[prompt-collect] debug", {
      mode: filters.mode,
      username: filters.username,
      days: filters.days,
      maxItems: filters.maxItems,
      keywordQuery: filters.keywordQuery,
      stopReason,
      scanned,
      accepted: accepted.length,
      final: items.length,
      ...debugCounters,
    })
  }

  return {
    targetUrl: location.href.replace(/#.*$/, ""),
    collectedAt: new Date().toISOString(),
    items,
  }
}
