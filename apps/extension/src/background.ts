import { loadLocalPromptRecords, type LocalPromptRecord } from "~lib/local-prompts"

type PromptHubMessage =
  | { type: "promptHub.listLocalPrompts" }
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
  }
)
