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
  mode: "posts" | "replies"
  username: string
  days: number
  keywordQuery: string
  maxItems: number
  keepCollectTabOpen: boolean
  usePopupWindow: boolean
  autoFocusPopup: boolean
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
    sourceWindowId: number | null
    collectTabId: number
    collectWindowId: number | null
    targetUrl: string
    keepCollectTabOpen: boolean
    autoFocusPopup: boolean
    lastProgressAt: number
    lastProgressKey: string
    lastFocusKickAt: number
  }
>()

const keepAlivePorts = new Map<string, chrome.runtime.Port>()

const WATCHDOG_PREFIX = "pc-watchdog:"

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

async function kickFocusIfSafe(requestId: string): Promise<void> {
  const job = inflight.get(requestId)
  if (!job) return
  if (!job.autoFocusPopup) return
  if (!job.sourceWindowId) return

  const now = Date.now()
  if (now - job.lastFocusKickAt < 20_000) return

  try {
    const src = await chrome.windows.get(job.sourceWindowId)
    if (!src.focused) return
  } catch {
    return
  }

  job.lastFocusKickAt = now
  inflight.set(requestId, job)

  // Popup window mode: focus the popup window, then restore focus.
  if (job.collectWindowId) {
    try {
      await chrome.windows.update(job.collectWindowId, { focused: true })
      try {
        await chrome.tabs.update(job.collectTabId, { active: true })
      } catch {
        // ignore
      }
    } catch {
      return
    }

    await new Promise((r) => setTimeout(r, 2500))

    try {
      await chrome.windows.update(job.sourceWindowId, { focused: true })
    } catch {
      // ignore
    }

    return
  }

  // New tab mode: briefly activate the collect tab in the current window, then return.
  try {
    await chrome.tabs.update(job.collectTabId, { active: true })
  } catch {
    return
  }

  await new Promise((r) => setTimeout(r, 2500))

  try {
    await chrome.tabs.update(job.sourceTabId, { active: true })
  } catch {
    // ignore
  }
}

function scheduleWatchdog(requestId: string): void {
  void chrome.alarms.create(`${WATCHDOG_PREFIX}${requestId}`, {
    periodInMinutes: 0.25, // 15s
    delayInMinutes: 0.25,
  })
}

function clearWatchdog(requestId: string): void {
  void chrome.alarms.clear(`${WATCHDOG_PREFIX}${requestId}`)
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(WATCHDOG_PREFIX)) return
  const requestId = alarm.name.slice(WATCHDOG_PREFIX.length)
  const job = inflight.get(requestId)
  if (!job) {
    clearWatchdog(requestId)
    return
  }
  const now = Date.now()
  if (now - job.lastProgressAt > 20_000) {
    void kickFocusIfSafe(requestId)
  }
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
    const sourceWindowId =
      typeof sender.tab?.windowId === "number" ? sender.tab.windowId : null

    void (async () => {
      const { requestId, targetUrl, filters } = typed

      const existing = inflight.get(requestId)
      if (existing) {
        clearWatchdog(requestId)
        if (existing.collectWindowId) {
          try {
            await chrome.windows.remove(existing.collectWindowId)
          } catch {
            // ignore
          }
        } else {
          try {
            await chrome.tabs.remove(existing.collectTabId)
          } catch {
            // ignore
          }
        }
        inflight.delete(requestId)
      }

      await chrome.tabs.sendMessage(sourceTabId, {
        type: "COLLECT_PROGRESS",
        requestId,
        progress: { stage: "opening", collected: 0, scanned: 0 },
      } satisfies CollectProgressMessage)

      let collectTabId: number | undefined
      let collectWindowId: number | null = null

      const url = withCollectHash(targetUrl)

      try {
        if (filters.usePopupWindow) {
          const win = await chrome.windows.create({
            url,
            focused: false,
            type: "popup",
            width: 420,
            height: 820,
          })
          collectWindowId = typeof win.id === "number" ? win.id : null
          collectTabId = win.tabs?.[0]?.id
        } else {
          const tab = await chrome.tabs.create({
            url,
            active: false,
            windowId: sourceWindowId ?? undefined,
          })
          collectTabId = tab.id
        }
      } catch {
        // Fallback: some environments fail to create popup windows.
        try {
          const tab = await chrome.tabs.create({
            url,
            active: false,
            windowId: sourceWindowId ?? undefined,
          })
          collectTabId = tab.id
          collectWindowId = null
        } catch (error) {
          await chrome.tabs.sendMessage(sourceTabId, {
            type: "COLLECT_FAILED",
            requestId,
            error:
              error instanceof Error
                ? error.message
                : "Failed to open collect page",
          } satisfies CollectFailedMessage)
          return
        }
      }

      if (typeof collectTabId !== "number") {
        if (collectWindowId) {
          try {
            await chrome.windows.remove(collectWindowId)
          } catch {
            // ignore
          }
        }
        await chrome.tabs.sendMessage(sourceTabId, {
          type: "COLLECT_FAILED",
          requestId,
          error: "Failed to open collect page",
        } satisfies CollectFailedMessage)
        return
      }

      inflight.set(requestId, {
        sourceTabId,
        sourceWindowId,
        collectTabId,
        collectWindowId,
        targetUrl,
        keepCollectTabOpen: Boolean(filters.keepCollectTabOpen),
        autoFocusPopup: Boolean(filters.autoFocusPopup),
        lastProgressAt: Date.now(),
        lastProgressKey: "",
        lastFocusKickAt: 0,
      })

      scheduleWatchdog(requestId)
      if (filters.autoFocusPopup) {
        void kickFocusIfSafe(requestId)
      }

      try {
        await waitForTabComplete(collectTabId)
        await sendMessageWithRetry(collectTabId, {
          type: "RUN_COLLECT",
          requestId,
          filters,
        } satisfies RunCollectMessage)

        // Kick once after starting, because X may not load in a non-focused window.
        if (filters.autoFocusPopup) {
          void kickFocusIfSafe(requestId)
        }
      } catch (error) {
        inflight.delete(requestId)
        clearWatchdog(requestId)
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
    clearWatchdog(requestId)
    const port = keepAlivePorts.get(requestId)
    if (port) {
      keepAlivePorts.delete(requestId)
      try {
        port.disconnect()
      } catch {
        // ignore
      }
    }
    if (job.collectWindowId) {
      void chrome.windows.remove(job.collectWindowId)
    } else {
      void chrome.tabs.remove(job.collectTabId)
    }
    return
  }

  if (typed.type === "COLLECT_PROGRESS") {
    const job = inflight.get(typed.requestId)
    if (!job) return
    const progressKey = `${typed.progress.stage}:${typed.progress.collected}:${typed.progress.scanned}`
    const now = Date.now()
    const stuck =
      progressKey === job.lastProgressKey && now - job.lastProgressAt > 20_000
    job.lastProgressKey = progressKey
    job.lastProgressAt = now
    inflight.set(typed.requestId, job)

    void chrome.tabs.sendMessage(job.sourceTabId, typed)

    if (stuck) {
      void kickFocusIfSafe(typed.requestId)
    }
    return
  }

  if (typed.type === "COLLECT_FINISHED") {
    const job = inflight.get(typed.requestId)
    if (!job) return
    inflight.delete(typed.requestId)
    clearWatchdog(typed.requestId)

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
        if (!job.keepCollectTabOpen) {
          if (job.collectWindowId) {
            try {
              await chrome.windows.remove(job.collectWindowId)
            } catch {
              // ignore
            }
          } else {
            try {
              await chrome.tabs.remove(job.collectTabId)
            } catch {
              // ignore
            }
          }
        }
      }
    })()
    return
  }

  if (typed.type === "COLLECT_FAILED") {
    const job = inflight.get(typed.requestId)
    if (!job) return
    inflight.delete(typed.requestId)
    clearWatchdog(typed.requestId)

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
        if (!job.keepCollectTabOpen) {
          if (job.collectWindowId) {
            try {
              await chrome.windows.remove(job.collectWindowId)
            } catch {
              // ignore
            }
          } else {
            try {
              await chrome.tabs.remove(job.collectTabId)
            } catch {
              // ignore
            }
          }
        }
      }
    })()
  }
})
