import { Storage } from "@plasmohq/storage"

export const storage = new Storage({ area: "sync" })

export const STORAGE_KEYS = {
  dbUrl: "promptHub.dbUrl"
} as const

