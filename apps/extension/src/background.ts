import { loadLocalPromptRecords, type LocalPromptRecord } from "~lib/local-prompts"

const PENDING_PASTE_KEY = "promptHub.pendingPasteText" as const

function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve()
    })
  })
}

type PromptHubMessage =
  | { type: "promptHub.listLocalPrompts" }
  | { type: "promptHub.openPasteEditor"; text: string }
  | { type: "promptHub.ping" }

type PromptHubResponse =
  | { ok: true; prompts: LocalPromptRecord[] }
  | { ok: true }
  | { ok: false; error: string }

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("tabs/prompt-hub.html") })
})

chrome.runtime.onMessage.addListener(
  (
    message: PromptHubMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: PromptHubResponse) => void
  ) => {
    if (!message || typeof message !== "object") return

    if (message.type === "promptHub.ping") {
      sendResponse({ ok: true })
      return
    }

    if (message.type === "promptHub.listLocalPrompts") {
      void (async () => {
        try {
          const prompts = await loadLocalPromptRecords()
          sendResponse({ ok: true, prompts })
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      })()
      return true
    }

    if (message.type === "promptHub.openPasteEditor") {
      void (async () => {
        try {
          const text = String(message.text ?? "").trim()
          await storageLocalSet({ [PENDING_PASTE_KEY]: text })

          const baseUrl = chrome.runtime.getURL("tabs/prompt-hub.html")
          const matches = await chrome.tabs.query({ url: `${baseUrl}*` })
          const existing = matches.find((t) => typeof t.id === "number")

          if (existing?.id != null) {
            try {
              if (typeof existing.windowId === "number") {
                await chrome.windows.update(existing.windowId, { focused: true })
              }
            } catch {
              // ignore
            }
            await chrome.tabs.update(existing.id, { active: true })
          } else {
            await chrome.tabs.create({ url: baseUrl })
          }

          try {
            chrome.runtime.sendMessage({ type: "promptHub.pendingPasteReady" })
          } catch {
            // ignore
          }

          sendResponse({ ok: true })
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      })()
      return true
    }
  }
)
