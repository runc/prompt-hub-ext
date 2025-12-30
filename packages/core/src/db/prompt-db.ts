type SqlJsStatic = {
  Database: new (data?: Uint8Array) => {
    exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>
    close: () => void
  }
}

type SqlDatabase = {
  exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>
  close: () => void
}

export type PromptRow = {
  id: number
  title: string
  content: string
  category: string | null
  tags: string | null
  variables: string | null
  images: string | null
  videos: string | null
  created_at: string | null
  updated_at: string | null
}

export type PromptVariable = {
  name: string
  label?: string
  defaultValue?: string
}

export type Prompt = PromptRow & {
  tagsList: string[]
  variablesList: PromptVariable[]
  imagesList: string[]
  videosList: string[]
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

function safeParseLinks(linksText: string | null): string[] {
  if (!linksText) return []

  const trimmed = linksText.trim()
  if (!trimmed) return []

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed
        .map((link) => (typeof link === "string" ? link.trim() : ""))
        .filter(
          (link) =>
            link &&
            (link.startsWith("http://") ||
              link.startsWith("https://") ||
              link.startsWith("/"))
        )
    }
  } catch {
    // fall through
  }

  return trimmed
    .split(/[,\n]/g)
    .map((link) => link.trim())
    .filter(
      (link) =>
        link &&
        (link.startsWith("http://") ||
          link.startsWith("https://") ||
          link.startsWith("/"))
    )
}

function safeParseVariables(variablesText: string | null): PromptVariable[] {
  if (!variablesText) return []

  const trimmed = variablesText.trim()
  if (!trimmed) return []

  const add = (
    acc: PromptVariable[],
    seen: Set<string>,
    variable: PromptVariable | null
  ) => {
    if (!variable) return
    const name = variable.name.trim()
    if (!name) return
    if (seen.has(name)) return
    seen.add(name)
    acc.push({ ...variable, name })
  }

  try {
    const parsed = JSON.parse(trimmed)
    const seen = new Set<string>()
    const out: PromptVariable[] = []

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string") {
          add(out, seen, { name: item })
        } else if (item && typeof item === "object") {
          const maybe = item as any
          add(out, seen, {
            name: String(maybe.name ?? maybe.key ?? ""),
            label: typeof maybe.label === "string" ? maybe.label : undefined,
            defaultValue:
              maybe.defaultValue != null
                ? String(maybe.defaultValue)
                : maybe.default != null
                  ? String(maybe.default)
                  : maybe.value != null
                    ? String(maybe.value)
                    : undefined
          })
        }
      }

      return out
    }

    if (parsed && typeof parsed === "object") {
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value == null) {
          add(out, seen, { name })
          continue
        }

        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          add(out, seen, { name, defaultValue: String(value) })
          continue
        }

        if (typeof value === "object") {
          const v = value as any
          add(out, seen, {
            name,
            label: typeof v.label === "string" ? v.label : undefined,
            defaultValue:
              v.defaultValue != null
                ? String(v.defaultValue)
                : v.default != null
                  ? String(v.default)
                  : v.value != null
                    ? String(v.value)
                    : undefined
          })
          continue
        }

        add(out, seen, { name })
      }

      return out
    }
  } catch {
    // fall through
  }

  return trimmed
    .split(/[,\n]/g)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }))
}

function extractTemplateVariableNames(content: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  const push = (raw: string) => {
    const name = raw.trim()
    if (!name) return
    if (seen.has(name)) return
    seen.add(name)
    out.push(name)
  }

  for (const match of content.matchAll(/\{\{\s*([^{}\n]+?)\s*\}\}/g)) {
    push(match[1] ?? "")
  }

  for (const match of content.matchAll(/\{(?!\{)\s*([^{}\n]+?)\s*\}(?!\})/g)) {
    push(match[1] ?? "")
  }

  return out
}

function mergeVariables(dbVariables: PromptVariable[], content: string): PromptVariable[] {
  const out: PromptVariable[] = []
  const seen = new Set<string>()

  for (const v of dbVariables) {
    const name = v.name.trim()
    if (!name) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ ...v, name })
  }

  for (const name of extractTemplateVariableNames(content)) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name })
  }

  return out
}

function hasColumn(db: SqlDatabase, table: string, col: string) {
  const result = db.exec(`PRAGMA table_info(${table})`)
  if (result.length === 0) return false
  const [info] = result
  const nameIndex = info.columns.findIndex((c) => c === "name")
  if (nameIndex < 0) return false
  return info.values.some((row) => String(row[nameIndex] ?? "") === col)
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
    const hasVariables = hasColumn(db, "prompts", "variables")
    const result = db.exec(
      `SELECT id, title, content, category, tags, ${
        hasVariables ? "variables" : "NULL as variables"
      }, images, videos, created_at, updated_at
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
          variables: (get(row, "variables") as string | null) ?? null,
          images: (get(row, "images") as string | null) ?? null,
          videos: (get(row, "videos") as string | null) ?? null,
          created_at: (get(row, "created_at") as string | null) ?? null,
          updated_at: (get(row, "updated_at") as string | null) ?? null
        }

        const dbVariables = safeParseVariables(promptRow.variables)
        prompts.push({
          ...promptRow,
          tagsList: safeParseTags(promptRow.tags),
          variablesList: mergeVariables(dbVariables, promptRow.content),
          imagesList: safeParseLinks(promptRow.images),
          videosList: safeParseLinks(promptRow.videos)
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
