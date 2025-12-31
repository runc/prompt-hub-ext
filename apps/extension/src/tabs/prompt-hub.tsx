import { useEffect, useMemo, useRef, useState } from "react"

import {
  getPromptVariableInitialValues,
  loadPromptsFromRemoteSqlite,
  renderPromptTemplate,
  type Prompt
} from "~lib/prompt-db"
import {
  createLocalPromptId,
  deleteLocalPromptRecord,
  hydrateLocalPrompt,
  loadLocalPromptRecords,
  upsertLocalPromptRecord,
  type LocalPromptRecord
} from "~lib/local-prompts"
import { isModelScopeQwenConfigured, organizeWithModelScopeQwen } from "~lib/ai-organizer"
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
  const seed = Math.abs(id)
  const hueA = (seed * 47) % 360
  const hueB = (hueA + 60) % 360
  return {
    background: `linear-gradient(135deg, hsl(${hueA} 85% 60%), hsl(${hueB} 85% 55%))`
  } as const
}

function parseTagsText(input: string): string[] {
  return input
    .split(/[,\n，]/g)
    .map((t) => t.trim())
    .filter(Boolean)
}

function parseLinksText(input: string): string[] {
  return input
    .split(/[,\n，]/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter(
      (link) =>
        link.startsWith("http://") || link.startsWith("https://") || link.startsWith("/")
    )
}

function promptSortKey(p: Pick<Prompt, "updated_at" | "created_at" | "id">): number {
  const t = p.updated_at ?? p.created_at
  if (!t) return 0
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return 0
  return d.getTime()
}

export default function PromptHubTab() {
  const [dbUrl, setDbUrl] = useState<string>("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>("")

  const [remotePrompts, setRemotePrompts] = useState<Prompt[]>([])
  const [localPromptRecords, setLocalPromptRecords] = useState<LocalPromptRecord[]>(
    []
  )

  const [keyword, setKeyword] = useState("")
  const [tagInput, setTagInput] = useState("")
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [activePrompt, setActivePrompt] = useState<Prompt | null>(null)
  const [variableValues, setVariableValues] = useState<Record<string, string>>({})
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)
  const closeDialogButtonRef = useRef<HTMLButtonElement | null>(null)

  const [editorDraft, setEditorDraft] = useState<{
    id?: number
    title: string
    content: string
    category: string
    tagsText: string
    imagesText: string
    videosText: string
  } | null>(null)
  const [editorMode, setEditorMode] = useState<"form" | "paste">("form")
  const [editorPasteText, setEditorPasteText] = useState("")
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState("")
  const [editorAiLoading, setEditorAiLoading] = useState(false)
  const [editorAiError, setEditorAiError] = useState("")

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

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const records = await loadLocalPromptRecords()
        if (cancelled) return
        setLocalPromptRecords(records)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      }
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
      const { prompts } = await loadPromptsFromRemoteSqlite(trimmed)
      setRemotePrompts(prompts)
    } catch (e) {
      setRemotePrompts([])
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

  const localPrompts = useMemo(
    () => localPromptRecords.map(hydrateLocalPrompt),
    [localPromptRecords]
  )

  const localIdSet = useMemo(
    () => new Set(localPromptRecords.map((r) => r.id)),
    [localPromptRecords]
  )

  const allPrompts = useMemo(() => {
    return [...localPrompts, ...remotePrompts].sort((a, b) => {
      const diff = promptSortKey(b) - promptSortKey(a)
      if (diff) return diff
      return b.id - a.id
    })
  }, [localPrompts, remotePrompts])

  const allTags = useMemo(() => {
    const tagCounter = new Map<string, number>()
    for (const p of allPrompts) {
      for (const t of p.tagsList) {
        tagCounter.set(t, (tagCounter.get(t) ?? 0) + 1)
      }
    }
    return [...tagCounter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }, [allPrompts])

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

  const openCreatePrompt = () => {
    setEditorError("")
    setEditorAiError("")
    setEditorMode("paste")
    setEditorPasteText("")
    setEditorDraft({
      title: "",
      content: "",
      category: "",
      tagsText: "",
      imagesText: "",
      videosText: ""
    })
  }

  const openEditPrompt = (p: Prompt) => {
    if (!localIdSet.has(p.id)) return
    setActivePrompt(null)
    setEditorError("")
    setEditorAiError("")
    setEditorMode("form")
    setEditorPasteText("")
    setEditorDraft({
      id: p.id,
      title: p.title,
      content: p.content,
      category: p.category ?? "",
      tagsText: p.tagsList.join(", "),
      imagesText: p.imagesList.join("\n"),
      videosText: p.videosList.join("\n")
    })
  }

  const deleteLocalPrompt = async (id: number): Promise<boolean> => {
    if (!localIdSet.has(id)) return false
    const ok = window.confirm("确定要删除这个本地 Prompt 吗？此操作不可撤销。")
    if (!ok) return false

    try {
      await deleteLocalPromptRecord(id)
      setLocalPromptRecords((prev) => prev.filter((r) => r.id !== id))
      if (activePrompt?.id === id) setActivePrompt(null)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  const saveEditorDraft = async () => {
    if (!editorDraft) return
    const title = editorDraft.title.trim()
    const content = editorDraft.content.trim()
    const category = editorDraft.category.trim()
    const tags = parseTagsText(editorDraft.tagsText)
    const images = parseLinksText(editorDraft.imagesText)
    const videos = parseLinksText(editorDraft.videosText)

    if (!title) {
      setEditorError("标题不能为空")
      return
    }
    if (!content) {
      setEditorError("内容不能为空")
      return
    }

    setEditorSaving(true)
    setEditorError("")
    try {
      const now = new Date().toISOString()
      const prev = localPromptRecords

      if (editorDraft.id != null) {
        const record: LocalPromptRecord = {
          id: editorDraft.id,
          title,
          content,
          category: category ? category : null,
          tags,
          images,
          videos,
          created_at: prev.find((r) => r.id === editorDraft.id)?.created_at ?? now,
          updated_at: now
        }
        await upsertLocalPromptRecord(record)
        setLocalPromptRecords((prevState) => {
          const idx = prevState.findIndex((r) => r.id === record.id)
          if (idx < 0) return [record, ...prevState]
          const next = [...prevState]
          next[idx] = record
          return next
        })
      } else {
        const id = createLocalPromptId(prev)
        const record: LocalPromptRecord = {
          id,
          title,
          content,
          category: category ? category : null,
          tags,
          images,
          videos,
          created_at: now,
          updated_at: now
        }
        await upsertLocalPromptRecord(record)
        setLocalPromptRecords((prevState) => [record, ...prevState])
      }

      setEditorDraft(null)
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : String(e))
    } finally {
      setEditorSaving(false)
    }
  }

  const organizePasteWithAI = async () => {
    if (!editorDraft) return
    const pasted = editorPasteText.trim()
    if (!pasted) return

    setEditorError("")
    setEditorAiError("")
    setEditorAiLoading(true)
    try {
      const configured = await isModelScopeQwenConfigured()
      if (!configured) {
        throw new Error("未配置 ModelScope 千问：请到扩展设置页填写 Base URL / 模型 / API Key。")
      }

      const organized = await organizeWithModelScopeQwen(pasted)
      setEditorDraft((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          title: organized.title || prev.title,
          category: organized.category || prev.category,
          tagsText: organized.tags.length > 0 ? organized.tags.join(", ") : prev.tagsText,
          imagesText:
            organized.images.length > 0 ? organized.images.join("\n") : prev.imagesText,
          videosText:
            organized.videos.length > 0 ? organized.videos.join("\n") : prev.videosText,
          content: organized.content || prev.content
        }
      })
    } catch (e) {
      setEditorAiError(e instanceof Error ? e.message : String(e))
    } finally {
      setEditorAiLoading(false)
    }
  }

  useEffect(() => {
    if (!activePrompt) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (previewImageUrl) {
        setPreviewImageUrl(null)
        return
      }
      setActivePrompt(null)
    }

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", onKeyDown)
    closeDialogButtonRef.current?.focus()
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [activePrompt, previewImageUrl])

  useEffect(() => {
    if (!activePrompt) {
      setVariableValues({})
      setPreviewImageUrl(null)
      return
    }
    setVariableValues(getPromptVariableInitialValues(activePrompt))
  }, [activePrompt])

  const renderedActiveContent = useMemo(() => {
    if (!activePrompt) return ""
    return renderPromptTemplate(activePrompt.content, variableValues)
  }, [activePrompt, variableValues])

  const EmptyState = (
    <div className="max-w-2xl mx-auto mt-6 bg-white rounded-xl border border-gray-200 p-6">
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
                  {localIdSet.has(activePrompt.id) ? (
                    <>
                      <button
                        type="button"
                        onClick={() => openEditPrompt(activePrompt)}
                        className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50"
                        title="编辑本地 Prompt"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteLocalPrompt(activePrompt.id)}
                        className="px-3 py-1.5 text-sm rounded-lg border border-red-200 text-red-700 hover:bg-red-50"
                        title="删除本地 Prompt"
                      >
                        删除
                      </button>
                    </>
                  ) : null}
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

              {activePrompt.imagesList.length > 0 ? (
                <div className="mt-6">
                  <div className="text-sm font-medium text-gray-900">图片</div>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {activePrompt.imagesList.map((url) => (
                      <button
                        key={url}
                        type="button"
                        className="relative rounded-lg overflow-hidden border border-gray-200 bg-gray-50 hover:shadow-sm"
                        onClick={() => setPreviewImageUrl(url)}
                        title="点击放大查看"
                      >
                        <img
                          src={url}
                          alt={activePrompt.title}
                          loading="lazy"
                          className="w-full h-28 object-cover"
                        />
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-col gap-1">
                    {activePrompt.imagesList.map((url) => (
                      <a
                        key={`${url}-link`}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-700 hover:underline break-all"
                      >
                        {url}
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {previewImageUrl ? (
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-8"
              role="dialog"
              aria-modal="true"
              aria-label="图片预览"
            >
              <div
                className="absolute inset-0 bg-black/70"
                aria-hidden="true"
                onClick={() => setPreviewImageUrl(null)}
              />
              <div className="relative max-w-6xl w-full">
                <div className="absolute right-0 -top-12 flex items-center gap-2">
                  <a
                    href={previewImageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 text-sm rounded-lg bg-white/90 hover:bg-white"
                  >
                    新标签打开
                  </a>
                  <button
                    type="button"
                    onClick={() => setPreviewImageUrl(null)}
                    className="px-3 py-1.5 text-sm rounded-lg bg-white/90 hover:bg-white"
                  >
                    关闭
                  </button>
                </div>
                <img
                  src={previewImageUrl}
                  alt={activePrompt.title}
                  className="max-h-[85vh] w-full object-contain rounded-xl shadow-2xl bg-black"
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {editorDraft ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={editorDraft.id != null ? "编辑提示词" : "新建提示词"}
        >
          <div
            className="absolute inset-0 bg-black/40"
            aria-hidden="true"
            onClick={() => {
              if (editorSaving) return
              setEditorDraft(null)
            }}
          />

          <div className="relative w-full max-w-3xl bg-white rounded-2xl shadow-xl border border-gray-200 overflow-hidden">
            <div className="h-2" style={cardAccentStyle(editorDraft.id ?? -1)} />
            <div className="p-4 sm:p-6 max-h-[85vh] overflow-auto">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-semibold text-gray-900 break-words">
                    {editorDraft.id != null ? "编辑本地 Prompt" : "新建本地 Prompt"}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    支持模板变量：<code className="font-mono">{"{变量}"}</code> /{" "}
                    <code className="font-mono">{"{{变量}}"}</code>
                  </div>
                  <div className="mt-3 inline-flex rounded-lg border border-gray-200 overflow-hidden">
                    <button
                      type="button"
                      disabled={editorSaving}
                      onClick={() => setEditorMode("paste")}
                      className={`px-3 py-1.5 text-sm ${
                        editorMode === "paste"
                          ? "bg-gray-900 text-white"
                          : "bg-white text-gray-700 hover:bg-gray-50"
                      } disabled:opacity-50`}
                    >
                      粘贴整理
                    </button>
                    <button
                      type="button"
                      disabled={editorSaving}
                      onClick={() => setEditorMode("form")}
                      className={`px-3 py-1.5 text-sm border-l border-gray-200 ${
                        editorMode === "form"
                          ? "bg-gray-900 text-white"
                          : "bg-white text-gray-700 hover:bg-gray-50"
                      } disabled:opacity-50`}
                    >
                      表单录入
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {editorDraft.id != null ? (
                    <button
                      type="button"
                      disabled={editorSaving}
                      onClick={async () => {
                        const deleted = await deleteLocalPrompt(editorDraft.id!)
                        if (deleted) setEditorDraft(null)
                      }}
                      className="px-3 py-1.5 text-sm rounded-lg border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      删除
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={editorSaving}
                    onClick={() => setEditorDraft(null)}
                    className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={editorSaving}
                    onClick={() => void saveEditorDraft()}
                    className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {editorSaving ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>

              {editorError ? (
                <div className="mt-4 text-sm text-red-600 whitespace-pre-wrap">
                  {editorError}
                </div>
              ) : null}
              {editorAiError ? (
                <div className="mt-4 text-sm text-red-600 whitespace-pre-wrap">
                  {editorAiError}
                </div>
              ) : null}

              {editorMode === "paste" ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 sm:p-4">
                  <div className="text-sm font-medium text-gray-900">粘贴一段文本</div>
                  <div className="mt-1 text-xs text-gray-600">
                    支持识别：标题/分类/标签/图片/视频（包含链接也可自动提取）
                  </div>
                  <textarea
                    value={editorPasteText}
                    onChange={(e) => setEditorPasteText(e.target.value)}
                    rows={8}
                    placeholder={`示例：\n标题：写一封求职邮件\n分类：写作\n标签：邮件, 求职\n\n这里是正文...\nhttps://example.com/a.png\nhttps://example.com/demo.mp4`}
                    className="mt-3 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm bg-white"
                  />
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={editorSaving || editorAiLoading || !editorPasteText.trim()}
                      onClick={() => void organizePasteWithAI()}
                      className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                      title="使用 ModelScope 千问自动整理"
                    >
                      {editorAiLoading ? "AI 整理中…" : "AI 整理（千问）"}
                    </button>
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    若提示未配置，可在扩展设置页配置 ModelScope（Options）。{" "}
                    <button
                      type="button"
                      className="text-blue-700 hover:underline"
                      onClick={() => chrome?.runtime?.openOptionsPage?.()}
                    >
                      打开设置
                    </button>
                  </div>
                </div>
              ) : null}

              <div className={editorMode === "paste" ? "mt-4" : "mt-4"}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block">
                    <div className="text-sm font-medium text-gray-900">标题</div>
                    <input
                      value={editorDraft.title}
                      onChange={(e) =>
                        setEditorDraft((prev) =>
                          prev ? { ...prev, title: e.target.value } : prev
                        )
                      }
                      placeholder="例如：写一封求职邮件"
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </label>
                  <label className="block">
                    <div className="text-sm font-medium text-gray-900">分类（可选）</div>
                    <input
                      value={editorDraft.category}
                      onChange={(e) =>
                        setEditorDraft((prev) =>
                          prev ? { ...prev, category: e.target.value } : prev
                        )
                      }
                      placeholder="例如：写作 / 编程 / 产品"
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </label>
                </div>

                <label className="block mt-4">
                  <div className="text-sm font-medium text-gray-900">标签（可选）</div>
                  <input
                    value={editorDraft.tagsText}
                    onChange={(e) =>
                      setEditorDraft((prev) =>
                        prev ? { ...prev, tagsText: e.target.value } : prev
                      )
                    }
                    placeholder="逗号分隔，例如：邮件, 求职, 模板"
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </label>

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block">
                    <div className="text-sm font-medium text-gray-900">图片链接（可选）</div>
                    <textarea
                      value={editorDraft.imagesText}
                      onChange={(e) =>
                        setEditorDraft((prev) =>
                          prev ? { ...prev, imagesText: e.target.value } : prev
                        )
                      }
                      rows={3}
                      placeholder="每行一个链接"
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                    />
                  </label>
                  <label className="block">
                    <div className="text-sm font-medium text-gray-900">视频链接（可选）</div>
                    <textarea
                      value={editorDraft.videosText}
                      onChange={(e) =>
                        setEditorDraft((prev) =>
                          prev ? { ...prev, videosText: e.target.value } : prev
                        )
                      }
                      rows={3}
                      placeholder="每行一个链接"
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                    />
                  </label>
                </div>

                <label className="block mt-4">
                  <div className="text-sm font-medium text-gray-900">内容</div>
                  <textarea
                    value={editorDraft.content}
                    onChange={(e) =>
                      setEditorDraft((prev) =>
                        prev ? { ...prev, content: e.target.value } : prev
                      )
                    }
                    rows={10}
                    placeholder="在这里输入提示词正文…"
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                  />
                </label>
              </div>
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
              onClick={openCreatePrompt}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700"
              title="新建本地 Prompt"
            >
              新建
            </button>
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

        {!dbUrl.trim() ? <div className="mb-6">{EmptyState}</div> : null}

        <div className="text-sm text-gray-600 mb-4">
          共 {filteredPrompts.length} 条（总 {allPrompts.length} 条，本地 {localPrompts.length}{" "}
          条）
        </div>

        <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4">
          <div
            className="ph-masonry-item mb-4 bg-white rounded-xl border-2 border-dashed border-gray-300 overflow-hidden shadow-sm cursor-pointer hover:shadow-md transition-shadow focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            role="button"
            tabIndex={0}
            aria-label="新建本地 Prompt"
            onClick={openCreatePrompt}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                openCreatePrompt()
              }
            }}
          >
            <div className="p-6">
              <div className="text-base font-semibold text-gray-900">＋ 新建 Prompt</div>
              <div className="mt-2 text-sm text-gray-600">
                在扩展中录入并维护本地提示词
              </div>
            </div>
          </div>

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
              {p.imagesList.length > 0 ? (
                <img
                  src={p.imagesList[0]}
                  alt={p.title}
                  loading="lazy"
                  className="w-full h-36 object-cover bg-gray-100"
                />
              ) : null}
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-gray-900 truncate">{p.title}</div>
                    <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-2 gap-y-1">
                      {localIdSet.has(p.id) ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                          本地
                        </span>
                      ) : null}
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
                  <div className="flex items-center gap-2 shrink-0">
                    {localIdSet.has(p.id) ? (
                      <>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            openEditPrompt(p)
                          }}
                          className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 hover:bg-gray-50"
                          title="编辑本地 Prompt"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void deleteLocalPrompt(p.id)
                          }}
                          className="px-2.5 py-1.5 text-xs rounded-lg border border-red-200 text-red-700 hover:bg-red-50"
                          title="删除本地 Prompt"
                        >
                          删除
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void copyPrompt(p.content)
                      }}
                      className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white hover:bg-black"
                      title="复制提示词"
                    >
                      复制
                    </button>
                  </div>
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
      </div>
    </div>
  )
}
