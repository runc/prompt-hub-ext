import { useEffect, useMemo, useState } from "react"

import { loadPromptsFromRemoteSqlite, type Prompt } from "@prompt-hub/core/db"
import { STORAGE_KEYS } from "@prompt-hub/core/storage"
import { WebStorage } from "@prompt-hub/core/storage/web"

import "./App.css"

const storage = new WebStorage()

function normalizeText(text: string) {
  return text.trim().toLowerCase()
}

function includesNormalized(haystack: string, needle: string) {
  if (!needle) return true
  return normalizeText(haystack).includes(needle)
}

export default function App() {
  const [dbUrl, setDbUrl] = useState<string>("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>("")

  const [allPrompts, setAllPrompts] = useState<Prompt[]>([])
  const [keyword, setKeyword] = useState("")

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const savedUrl = await storage.get<string>(STORAGE_KEYS.dbUrl)
      if (cancelled) return
      setDbUrl(savedUrl ?? "")
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const reload = async (url: string) => {
    const trimmed = url.trim()
    if (!trimmed) return

    setLoading(true)
    setError("")

    try {
      await storage.set(STORAGE_KEYS.dbUrl, trimmed)
      const { prompts } = await loadPromptsFromRemoteSqlite(trimmed)
      setAllPrompts(prompts)
    } catch (e) {
      setAllPrompts([])
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const normalizedKeyword = useMemo(() => normalizeText(keyword), [keyword])

  const filteredPrompts = useMemo(() => {
    return allPrompts.filter((p) => {
      if (
        normalizedKeyword &&
        !(
          includesNormalized(p.title, normalizedKeyword) ||
          includesNormalized(p.content, normalizedKeyword) ||
          includesNormalized(p.category ?? "", normalizedKeyword) ||
          p.tagsList.some((t) => includesNormalized(t, normalizedKeyword))
        )
      ) {
        return false
      }
      return true
    })
  }, [allPrompts, normalizedKeyword])

  const copyPrompt = async (text: string) => {
    await navigator.clipboard.writeText(text)
  }

  return (
    <div className="ph-page">
      <header className="ph-header">
        <div className="ph-header-inner">
          <div className="ph-title">Prompt Hub (Web)</div>
          <div className="ph-controls">
            <input
              value={dbUrl}
              onChange={(e) => setDbUrl(e.target.value)}
              placeholder="https://example.com/prompts.sqlite"
              className="ph-input"
            />
            <button
              onClick={() => void reload(dbUrl)}
              disabled={!dbUrl.trim() || loading}
              className="ph-button"
            >
              {loading ? "加载中…" : "加载"}
            </button>
          </div>

          <div className="ph-controls">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="关键词搜索（标题 / 正文 / 分类 / 标签）"
              className="ph-input"
            />
          </div>

          {error ? <div className="ph-error">{error}</div> : null}
          <div className="ph-meta">
            {allPrompts.length > 0
              ? `共 ${filteredPrompts.length} 条（总 ${allPrompts.length} 条）`
              : "请输入数据库 URL 并加载"}
          </div>
        </div>
      </header>

      <main className="ph-main">
        <div className="ph-grid">
          {filteredPrompts.map((p) => (
            <div key={p.id} className="ph-card">
              <div className="ph-card-title">{p.title}</div>
              {p.category ? <div className="ph-card-category">{p.category}</div> : null}
              <div className="ph-card-content">
                {p.content.length > 320 ? `${p.content.slice(0, 320)}…` : p.content}
              </div>
              <div className="ph-card-actions">
                <button className="ph-button-secondary" onClick={() => void copyPrompt(p.content)}>
                  复制
                </button>
              </div>
              {p.tagsList.length > 0 ? (
                <div className="ph-tags">
                  {p.tagsList.slice(0, 12).map((t) => (
                    <span key={t} className="ph-tag">
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
