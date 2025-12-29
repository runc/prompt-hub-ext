type SqlJsStatic = {
  Database: new (data?: Uint8Array) => {
    exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>
    close: () => void
  }
}

export type PromptRow = {
  id: number
  title: string
  content: string
  category: string | null
  tags: string | null
  created_at: string | null
  updated_at: string | null
}

export type Prompt = PromptRow & {
  tagsList: string[]
}

let sqlJsInitPromise: Promise<SqlJsStatic> | null = null

async function getSqlJs() {
  if (!sqlJsInitPromise) {
    sqlJsInitPromise = (async () => {
      const mod = (await import("sql.js")) as any
      const initSqlJs = mod?.default ?? mod
      const base = "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/"
      return initSqlJs({
        locateFile: (file: string) => new URL(file, base).toString()
      })
    })()
  }

  return sqlJsInitPromise
}

function safeParseTags(tagsText: string | null): string[] {
  if (!tagsText) return []

  const trimmed = tagsText.trim()
  if (!trimmed) return []

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean)
    }
  } catch {
    // fall through
  }

  return trimmed
    .split(/[,\n]/g)
    .map((t) => t.trim())
    .filter(Boolean)
}

export async function loadPromptsFromRemoteSqlite(dbUrl: string): Promise<{
  prompts: Prompt[]
  tags: Array<{ tag: string; count: number }>
}> {
  const response = await fetch(dbUrl, { cache: "no-store" })
  if (!response.ok) {
    throw new Error(`Failed to fetch DB: ${response.status} ${response.statusText}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())

  const SQL = await getSqlJs()
  const db = new SQL.Database(bytes)

  try {
    const result = db.exec(
      `SELECT id, title, content, category, tags, created_at, updated_at
       FROM prompts
       ORDER BY COALESCE(updated_at, created_at) DESC, id DESC`
    )

    const prompts: Prompt[] = []

    if (result.length > 0) {
      const [table] = result
      const colIndex = new Map<string, number>()
      table.columns.forEach((c, i) => colIndex.set(c, i))

      const get = (row: unknown[], col: string) => row[colIndex.get(col) ?? -1] ?? null

      for (const row of table.values) {
        const promptRow: PromptRow = {
          id: Number(get(row, "id") ?? 0),
          title: String(get(row, "title") ?? ""),
          content: String(get(row, "content") ?? ""),
          category: (get(row, "category") as string | null) ?? null,
          tags: (get(row, "tags") as string | null) ?? null,
          created_at: (get(row, "created_at") as string | null) ?? null,
          updated_at: (get(row, "updated_at") as string | null) ?? null
        }

        prompts.push({
          ...promptRow,
          tagsList: safeParseTags(promptRow.tags)
        })
      }
    }

    const tagCounter = new Map<string, number>()
    for (const p of prompts) {
      for (const t of p.tagsList) {
        tagCounter.set(t, (tagCounter.get(t) ?? 0) + 1)
      }
    }

    const tags = [...tagCounter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))

    return { prompts, tags }
  } finally {
    db.close()
  }
}
