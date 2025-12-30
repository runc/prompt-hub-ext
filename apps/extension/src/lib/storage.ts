import { ChromeStorage } from "@prompt-hub/core/storage/chrome"

export { STORAGE_KEYS } from "@prompt-hub/core/storage"

export const storage = new ChromeStorage("sync")
