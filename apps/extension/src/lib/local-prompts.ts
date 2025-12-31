import type { Prompt, PromptRow, PromptVariable } from "~lib/prompt-db"

export type LocalPromptRecord = {
  id: number
  title: string
  content: string
  category?: string | null
  tags?: string[]
  images?: string[]
  videos?: string[]
  created_at?: string | null
  updated_at?: string | null
}

const LOCAL_PROMPTS_DB_NAME = "promptHub" as const
const LOCAL_PROMPTS_DB_VERSION = 1 as const
const LOCAL_PROMPTS_STORE_NAME = "localPrompts" as const

let localPromptsDbPromise: Promise<IDBDatabase> | null = null

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"))
  })
}

async function openLocalPromptsDb(): Promise<IDBDatabase> {
  if (localPromptsDbPromise) return localPromptsDbPromise
  localPromptsDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB 不可用：无法保存本地 Prompt"))
      return
    }

    const req = indexedDB.open(LOCAL_PROMPTS_DB_NAME, LOCAL_PROMPTS_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(LOCAL_PROMPTS_STORE_NAME)) {
        db.createObjectStore(LOCAL_PROMPTS_STORE_NAME, { keyPath: "id" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"))
  })

  return localPromptsDbPromise
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
}

function normalizeLinkArray(input: unknown): string[] {
  const links = normalizeStringArray(input)
  return links.filter(
    (link) =>
      link &&
      (link.startsWith("http://") || link.startsWith("https://") || link.startsWith("/"))
  )
}

function normalizeRecord(input: unknown): LocalPromptRecord | null {
  if (!input || typeof input !== "object") return null
  const r = input as Record<string, unknown>

  const id = Number(r["id"])
  if (!Number.isFinite(id) || id === 0) return null

  const title = typeof r["title"] === "string" ? r["title"] : ""
  const content = typeof r["content"] === "string" ? r["content"] : ""
  if (!title.trim() || !content.trim()) return null

  const category =
    r["category"] == null
      ? null
      : typeof r["category"] === "string"
        ? r["category"]
        : null

  const created_at =
    r["created_at"] == null
      ? null
      : typeof r["created_at"] === "string"
        ? r["created_at"]
        : null
  const updated_at =
    r["updated_at"] == null
      ? null
      : typeof r["updated_at"] === "string"
        ? r["updated_at"]
        : null

  return {
    id,
    title,
    content,
    category,
    tags: normalizeStringArray(r["tags"]),
    images: normalizeLinkArray(r["images"]),
    videos: normalizeLinkArray(r["videos"]),
    created_at,
    updated_at
  }
}

export async function loadLocalPromptRecords(): Promise<LocalPromptRecord[]> {
  const db = await openLocalPromptsDb()
  const tx = db.transaction(LOCAL_PROMPTS_STORE_NAME, "readonly")
  const store = tx.objectStore(LOCAL_PROMPTS_STORE_NAME)

  const raw = (await requestToPromise(store.getAll())) as unknown[]

  await txDone(tx)
  return raw.map(normalizeRecord).filter(Boolean) as LocalPromptRecord[]
}

export async function upsertLocalPromptRecord(record: LocalPromptRecord): Promise<void> {
  const db = await openLocalPromptsDb()
  const tx = db.transaction(LOCAL_PROMPTS_STORE_NAME, "readwrite")
  tx.objectStore(LOCAL_PROMPTS_STORE_NAME).put(record)
  await txDone(tx)
}

export async function deleteLocalPromptRecord(id: number): Promise<void> {
  const db = await openLocalPromptsDb()
  const tx = db.transaction(LOCAL_PROMPTS_STORE_NAME, "readwrite")
  tx.objectStore(LOCAL_PROMPTS_STORE_NAME).delete(id)
  await txDone(tx)
}

export async function replaceLocalPromptRecords(records: LocalPromptRecord[]): Promise<void> {
  const db = await openLocalPromptsDb()
  const tx = db.transaction(LOCAL_PROMPTS_STORE_NAME, "readwrite")
  const store = tx.objectStore(LOCAL_PROMPTS_STORE_NAME)
  store.clear()
  for (const record of records) store.put(record)
  await txDone(tx)
}

function extractTemplateVariableNames(content: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const push = (raw: string) => {
    const name = raw.trim()
    if (!name) return
    if (seen.has(name)) return
    seen.add(name)
    out.push(name)
  }

  for (const match of content.matchAll(/\{\{\s*([^{}\n]+?)\s*\}\}/g)) {
    push(String(match[1] ?? ""))
  }
  for (const match of content.matchAll(/\{(?!\{)\s*([^{}\n]+?)\s*\}(?!\})/g)) {
    push(String(match[1] ?? ""))
  }

  return out
}

function variablesFromContent(content: string): PromptVariable[] {
  return extractTemplateVariableNames(content).map((name) => ({ name }))
}

export function hydrateLocalPrompt(record: LocalPromptRecord): Prompt {
  const tagsList = normalizeStringArray(record.tags)
  const imagesList = normalizeLinkArray(record.images)
  const videosList = normalizeLinkArray(record.videos)
  const row: PromptRow = {
    id: record.id,
    title: record.title,
    content: record.content,
    category: record.category ?? null,
    tags: tagsList.length > 0 ? JSON.stringify(tagsList) : null,
    variables: null,
    images: imagesList.length > 0 ? JSON.stringify(imagesList) : null,
    videos: videosList.length > 0 ? JSON.stringify(videosList) : null,
    created_at: record.created_at ?? null,
    updated_at: record.updated_at ?? null
  }

  return {
    ...row,
    tagsList,
    variablesList: variablesFromContent(record.content),
    imagesList,
    videosList
  }
}

export function createLocalPromptId(existing: Iterable<{ id: number }>): number {
  let minId = 0
  for (const item of existing) {
    if (typeof item.id === "number" && item.id < minId) minId = item.id
  }

  const nowId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000))
  if (nowId < minId) return nowId
  return minId - 1
}
