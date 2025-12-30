import { useEffect, useMemo, useRef, useState } from "react"

import {
  getPromptVariableInitialValues,
  loadPromptsFromRemoteSqlite,
  renderPromptTemplate,
  type Prompt
} from "~lib/prompt-db"
import { STORAGE_KEYS, storage } from "~lib/storage"

import "./prompt-hub.css"

function normalizeText(text: string) {
  return text.trim().toLowerCase()
}

function includesNormalized(haystack: string, needle: string) {
  if (!needle) return true
  return normalizeText(haystack).includes(needle)
}

function formatDate(text: string | null) {
  if (!text) return ""
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) return text
  return d.toLocaleString()
}

function cardAccentStyle(id: number) {
  const hueA = (id * 47) % 360
  const hueB = (hueA + 60) % 360
  return {
    background: `linear-gradient(135deg, hsl(${hueA} 85% 60%), hsl(${hueB} 85% 55%))`
  } as const
}

export default function PromptHubTab() {
  const [dbUrl, setDbUrl] = useState<string>("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>("")

  const [allPrompts, setAllPrompts] = useState<Prompt[]>([])
  const [allTags, setAllTags] = useState<Array<{ tag: string; count: number }>>(
    []
  )

  const [keyword, setKeyword] = useState("")
  const [tagInput, setTagInput] = useState("")
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [activePrompt, setActivePrompt] = useState<Prompt | null>(null)
  const [variableValues, setVariableValues] = useState<Record<string, string>>({})
  const closeDialogButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const savedUrl = (await storage.get(STORAGE_KEYS.dbUrl)) as string | undefined
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
      const { prompts, tags } = await loadPromptsFromRemoteSqlite(trimmed)
      setAllPrompts(prompts)
      setAllTags(tags)
    } catch (e) {
      setAllPrompts([])
      setAllTags([])
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!dbUrl.trim()) return
    void reload(dbUrl)
  }, [dbUrl])

  const normalizedKeyword = useMemo(() => normalizeText(keyword), [keyword])

  const filteredPrompts = useMemo(() => {
    const tagsNeedle = selectedTags.map((t) => normalizeText(t))

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

      if (tagsNeedle.length > 0) {
        const promptTags = p.tagsList.map((t) => normalizeText(t))
        for (const t of tagsNeedle) {
          if (!promptTags.includes(t)) return false
        }
      }

      return true
    })
  }, [allPrompts, normalizedKeyword, selectedTags])

  const displayedTags = useMemo(() => allTags.slice(0, 40), [allTags])

  const addTag = (raw: string) => {
    const t = raw.trim()
    if (!t) return
    if (selectedTags.includes(t)) return
    setSelectedTags((prev) => [...prev, t])
    setTagInput("")
  }

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    )
  }

  const copyPrompt = async (text: string) => {
    await navigator.clipboard.writeText(text)
  }

  useEffect(() => {
    if (!activePrompt) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActivePrompt(null)
    }

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", onKeyDown)
    closeDialogButtonRef.current?.focus()
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [activePrompt])

  useEffect(() => {
    if (!activePrompt) {
      setVariableValues({})
      return
    }
    setVariableValues(getPromptVariableInitialValues(activePrompt))
  }, [activePrompt])

  const renderedActiveContent = useMemo(() => {
    if (!activePrompt) return ""
    return renderPromptTemplate(activePrompt.content, variableValues)
  }, [activePrompt, variableValues])

  const EmptyState = (
    <div className="max-w-2xl mx-auto mt-16 bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="text-xl font-semibold">配置远程 SQLite 数据库</h2>
      <p className="text-gray-600 mt-2">
        请输入一个可直接下载的 `.sqlite/.db` 文件 URL（需要支持跨域访问）。
      </p>
      <div className="mt-4 flex gap-2">
        <input
          value={dbUrl}
          onChange={(e) => setDbUrl(e.target.value)}
          placeholder="https://example.com/prompts.sqlite"
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={async () => {
            const trimmed = dbUrl.trim()
            await storage.set(STORAGE_KEYS.dbUrl, trimmed)
            await reload(trimmed)
          }}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
        >
          加载
        </button>
      </div>
      {error ? (
        <div className="mt-4 text-sm text-red-600 whitespace-pre-wrap">{error}</div>
      ) : null}
      <p className="text-xs text-gray-500 mt-3">
        表结构示例：prompts(id, title, content(支持模板变量), category, tags(JSON字符串),
        variables(JSON), images, videos, created_at, updated_at)
      </p>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      {activePrompt ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="提示词详情"
        >
          <div
            className="absolute inset-0 bg-black/40"
            aria-hidden="true"
            onClick={() => setActivePrompt(null)}
          />

          <div className="relative w-full max-w-3xl bg-white rounded-2xl shadow-xl border border-gray-200 overflow-hidden">
            <div className="h-2" style={cardAccentStyle(activePrompt.id)} />
            <div className="p-4 sm:p-6 max-h-[85vh] overflow-auto">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-semibold text-gray-900 break-words">
                    {activePrompt.title}
                  </div>
                  <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-2 gap-y-1">
                    {activePrompt.category ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
                        {activePrompt.category}
                      </span>
                    ) : null}
                    {activePrompt.updated_at ? (
                      <span>更新：{formatDate(activePrompt.updated_at)}</span>
                    ) : null}
                    {activePrompt.created_at ? (
                      <span>创建：{formatDate(activePrompt.created_at)}</span>
                    ) : null}
                    <span>ID：{activePrompt.id}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void copyPrompt(renderedActiveContent)}
                    className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white hover:bg-black"
                    title="复制提示词"
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50"
                    ref={closeDialogButtonRef}
                    onClick={() => setActivePrompt(null)}
                  >
                    关闭
                  </button>
                </div>
              </div>

              {activePrompt.variablesList.length > 0 ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 sm:p-4">
                  <div className="text-sm font-medium text-gray-900">变量替换</div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {activePrompt.variablesList.map((v) => (
                      <label key={v.name} className="block">
                        <div className="text-xs text-gray-600">
                          {v.label ? v.label : v.name}
                        </div>
                        <input
                          value={variableValues[v.name] ?? ""}
                          onChange={(e) =>
                            setVariableValues((prev) => ({
                              ...prev,
                              [v.name]: e.target.value
                            }))
                          }
                          placeholder={v.defaultValue ?? ""}
                          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </label>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <div className="text-xs text-gray-500">
                      支持{" "}
                      <code className="font-mono text-gray-700">{"{变量}"}</code> /{" "}
                      <code className="font-mono text-gray-700">{"{{变量}}"}</code>{" "}
                      占位符
                    </div>
                    <button
                      type="button"
                      className="px-2 py-1 text-xs rounded-lg border border-gray-300 hover:bg-white"
                      onClick={() =>
                        setVariableValues(getPromptVariableInitialValues(activePrompt))
                      }
                    >
                      重置
                    </button>
                  </div>
                </div>
              ) : null}

              {activePrompt.tagsList.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {activePrompt.tagsList.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTag(t)}
                      className="px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100"
                      title="点击筛选该标签"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="mt-4 text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                {renderedActiveContent}
              </div>

              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-gray-600 hover:text-gray-900">
                  查看模板原文
                </summary>
                <div className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">
                  {activePrompt.content}
                </div>
              </details>

              {activePrompt.imagesList.length > 0 ? (
                <div className="mt-6">
                  <div className="text-sm font-medium text-gray-900">图片</div>
                  <div className="mt-2 flex flex-col gap-2">
                    {activePrompt.imagesList.map((url) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-blue-700 hover:underline break-all"
                      >
                        {url}
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}

              {activePrompt.videosList.length > 0 ? (
                <div className="mt-6">
                  <div className="text-sm font-medium text-gray-900">视频</div>
                  <div className="mt-2 flex flex-col gap-2">
                    {activePrompt.videosList.map((url) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-blue-700 hover:underline break-all"
                      >
                        {url}
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="font-semibold text-gray-900">Prompt Hub</div>
            <div className="text-xs text-gray-500 truncate flex-1">
              {dbUrl ? dbUrl : "未配置数据库 URL"}
            </div>
            <button
              onClick={() => void reload(dbUrl)}
              disabled={!dbUrl.trim() || loading}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              {loading ? "加载中…" : "刷新"}
            </button>
          </div>

          <div className="flex flex-col md:flex-row gap-2">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="关键词搜索（标题 / 正文 / 分类 / 标签）"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex gap-2">
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTag(tagInput)
                }}
                placeholder="标签搜索（回车添加）"
                className="w-full md:w-72 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                list="ph-tags-datalist"
              />
              <datalist id="ph-tags-datalist">
                {allTags.slice(0, 200).map((t) => (
                  <option key={t.tag} value={t.tag} />
                ))}
              </datalist>
            </div>
          </div>

          {selectedTags.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {selectedTags.map((t) => (
                <button
                  key={t}
                  onClick={() => toggleTag(t)}
                  className="px-2 py-1 text-sm rounded-full bg-blue-600 text-white hover:bg-blue-700"
                  title="点击移除标签过滤"
                >
                  {t} ×
                </button>
              ))}
              <button
                onClick={() => setSelectedTags([])}
                className="px-2 py-1 text-sm rounded-full border border-gray-300 hover:bg-gray-50"
              >
                清空
              </button>
            </div>
          ) : displayedTags.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {displayedTags.map((t) => (
                <button
                  key={t.tag}
                  onClick={() => toggleTag(t.tag)}
                  className="px-2 py-1 text-sm rounded-full border border-gray-300 hover:bg-gray-50"
                  title={`使用次数：${t.count}`}
                >
                  {t.tag}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {error ? (
          <div className="mb-4 text-sm text-red-600 whitespace-pre-wrap">{error}</div>
        ) : null}

        {!dbUrl.trim() ? (
          EmptyState
        ) : (
          <>
            <div className="text-sm text-gray-600 mb-4">
              共 {filteredPrompts.length} 条（总 {allPrompts.length} 条）
            </div>

            <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4">
              {filteredPrompts.map((p) => (
                <div
                  key={p.id}
                  className="ph-masonry-item mb-4 bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm cursor-pointer hover:shadow-md transition-shadow focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  role="button"
                  tabIndex={0}
                  aria-label={`查看详情：${p.title}`}
                  onClick={() => setActivePrompt(p)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      setActivePrompt(p)
                    }
                  }}
                >
                  <div className="h-2" style={cardAccentStyle(p.id)} />
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-900 truncate">
                          {p.title}
                        </div>
                        <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-2 gap-y-1">
                          {p.category ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
                              {p.category}
                            </span>
                          ) : null}
                          {p.updated_at || p.created_at ? (
                            <span>{formatDate(p.updated_at ?? p.created_at)}</span>
                          ) : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void copyPrompt(p.content)
                        }}
                        className="shrink-0 px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white hover:bg-black"
                        title="复制提示词"
                      >
                        复制
                      </button>
                    </div>

                    <div className="mt-3 text-sm text-gray-700 whitespace-pre-wrap">
                      {p.content.length > 260 ? `${p.content.slice(0, 260)}…` : p.content}
                    </div>

                    {p.tagsList.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {p.tagsList.slice(0, 12).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleTag(t)
                            }}
                            className="px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100"
                            title="点击筛选该标签"
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    <div className="mt-3 text-xs text-gray-400">点击卡片查看详情</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
