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

type CollectFilters = {
  days: number
  keywordQuery: string
  maxItems: number
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
    collectTabId: number
    targetUrl: string
  }
>()

const keepAlivePorts = new Map<string, chrome.runtime.Port>()

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

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!message || typeof message !== "object") return

  const typed = message as
    | StartCollectMessage
    | CancelCollectMessage
    | CollectProgressMessage
    | CollectFinishedMessage
    | CollectFailedMessage

  if (typed.type === "START_COLLECT") {
    const sourceTabId = sender.tab?.id
    if (typeof sourceTabId !== "number") return

    void (async () => {
      const { requestId, targetUrl, filters } = typed

      const existing = inflight.get(requestId)
      if (existing) {
        try {
          await chrome.tabs.remove(existing.collectTabId)
        } catch {
          // ignore
        }
        inflight.delete(requestId)
      }

      await chrome.tabs.sendMessage(sourceTabId, {
        type: "COLLECT_PROGRESS",
        requestId,
        progress: { stage: "opening", collected: 0, scanned: 0 },
      } satisfies CollectProgressMessage)

      const tab = await chrome.tabs.create({
        url: withCollectHash(targetUrl),
        active: false,
      })
      const collectTabId = tab.id
      if (typeof collectTabId !== "number") {
        await chrome.tabs.sendMessage(sourceTabId, {
          type: "COLLECT_FAILED",
          requestId,
          error: "Failed to open background tab",
        } satisfies CollectFailedMessage)
        return
      }

      inflight.set(requestId, { sourceTabId, collectTabId, targetUrl })

      try {
        await waitForTabComplete(collectTabId)
        await sendMessageWithRetry(collectTabId, {
          type: "RUN_COLLECT",
          requestId,
          filters,
        } satisfies RunCollectMessage)
      } catch (error) {
        inflight.delete(requestId)
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
    const port = keepAlivePorts.get(requestId)
    if (port) {
      keepAlivePorts.delete(requestId)
      try {
        port.disconnect()
      } catch {
        // ignore
      }
    }
    void chrome.tabs.remove(job.collectTabId)
    return
  }

  if (typed.type === "COLLECT_PROGRESS") {
    const job = inflight.get(typed.requestId)
    if (!job) return
    void chrome.tabs.sendMessage(job.sourceTabId, typed)
    return
  }

  if (typed.type === "COLLECT_FINISHED") {
    const job = inflight.get(typed.requestId)
    if (!job) return
    inflight.delete(typed.requestId)

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
        try {
          await chrome.tabs.remove(job.collectTabId)
        } catch {
          // ignore
        }
      }
    })()
    return
  }

  if (typed.type === "COLLECT_FAILED") {
    const job = inflight.get(typed.requestId)
    if (!job) return
    inflight.delete(typed.requestId)

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
        try {
          await chrome.tabs.remove(job.collectTabId)
        } catch {
          // ignore
        }
      }
    })()
  }
})
