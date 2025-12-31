import { useEffect, useMemo, useState } from "react"

import {
  MODELSCOPE_QWEN_DEFAULT_BASE_URL,
  MODELSCOPE_QWEN_DEFAULT_MODEL,
  loadModelScopeQwenSettings,
  normalizeOpenAICompatBaseUrl,
  saveModelScopeQwenSettings
} from "~lib/ai-organizer"
import { STORAGE_KEYS, storage } from "~lib/storage"

import "./tabs/prompt-hub.css"

export default function OptionsPage() {
  const [dbUrl, setDbUrl] = useState("")
  const [savedUrl, setSavedUrl] = useState("")
  const [status, setStatus] = useState<string>("")
  const [error, setError] = useState<string>("")

  const [msBaseUrl, setMsBaseUrl] = useState(MODELSCOPE_QWEN_DEFAULT_BASE_URL)
  const [msModel, setMsModel] = useState(MODELSCOPE_QWEN_DEFAULT_MODEL)
  const [msApiKey, setMsApiKey] = useState("")
  const [msSaved, setMsSaved] = useState<{
    baseUrl: string
    model: string
    apiKey: string
  }>({
    baseUrl: MODELSCOPE_QWEN_DEFAULT_BASE_URL,
    model: MODELSCOPE_QWEN_DEFAULT_MODEL,
    apiKey: ""
  })
  const [aiStatus, setAiStatus] = useState("")
  const [aiError, setAiError] = useState("")

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const v = (await storage.get(STORAGE_KEYS.dbUrl)) as string | undefined
      if (cancelled) return
      setDbUrl(v ?? "")
      setSavedUrl(v ?? "")
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await loadModelScopeQwenSettings()
        if (cancelled) return
        setMsBaseUrl(s.baseUrl)
        setMsModel(s.model)
        setMsApiKey(s.apiKey)
        setMsSaved(s)
      } catch (e) {
        if (cancelled) return
        setAiError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const hasChanges = useMemo(() => dbUrl.trim() !== savedUrl.trim(), [dbUrl, savedUrl])
  const hasAiChanges = useMemo(() => {
    return (
      msBaseUrl.trim() !== msSaved.baseUrl.trim() ||
      msModel.trim() !== msSaved.model.trim() ||
      msApiKey.trim() !== msSaved.apiKey.trim()
    )
  }, [msApiKey, msBaseUrl, msModel, msSaved])

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto p-8">
        <h1 className="text-2xl font-bold">Prompt Hub 设置</h1>
        <p className="text-gray-600 mt-2">
          配置远程 SQLite3（WASM + SQLite）提示词库地址。
        </p>

        <div className="mt-6 bg-white rounded-xl border border-gray-200 p-6">
          <label className="block text-sm font-medium text-gray-900">数据库 URL</label>
          <div className="mt-2 flex gap-2">
            <input
              value={dbUrl}
              onChange={(e) => setDbUrl(e.target.value)}
              placeholder="https://example.com/prompts.sqlite"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={async () => {
                const trimmed = dbUrl.trim()
                setError("")
                setStatus("保存中…")
                try {
                  await storage.set(STORAGE_KEYS.dbUrl, trimmed)
                  setSavedUrl(trimmed)
                  setStatus("已保存")
                } catch (e) {
                  setStatus("")
                  setError(e instanceof Error ? e.message : String(e))
                }
              }}
              disabled={!hasChanges}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              保存
            </button>
          </div>

          {status ? <div className="mt-3 text-sm text-gray-600">{status}</div> : null}
          {error ? (
            <div className="mt-3 text-sm text-red-600 whitespace-pre-wrap">{error}</div>
          ) : null}

          <div className="mt-4 text-sm text-gray-600 space-y-1">
            <div>要求：</div>
            <ul className="list-disc list-inside space-y-1">
              <li>URL 需要能直接下载 `.sqlite/.db` 文件</li>
              <li>服务端需允许跨域访问（或扩展已获得 host 权限）</li>
              <li>
                表名 `prompts`，字段包含 `title`、`content`，可选 `category`、`tags`、`images`、`videos`
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-6 bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900">自动整理（ModelScope 千问）</h2>
          <p className="text-gray-600 mt-2 text-sm">
            用于“粘贴整理”模式的 AI 自动整理（可选，不配置也能用规则整理）。
          </p>

          <div className="mt-4 space-y-4">
            <label className="block">
              <div className="text-sm font-medium text-gray-900">Base URL</div>
              <input
                value={msBaseUrl}
                onChange={(e) => setMsBaseUrl(e.target.value)}
                placeholder={MODELSCOPE_QWEN_DEFAULT_BASE_URL}
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
              <div className="mt-1 text-xs text-gray-500">
                需为 OpenAI 兼容接口地址（不要包含 `/chat/completions`），例如
                `https://dashscope.aliyuncs.com/compatible-mode/v1`
              </div>
            </label>

            <label className="block">
              <div className="text-sm font-medium text-gray-900">模型名称</div>
              <input
                value={msModel}
                onChange={(e) => setMsModel(e.target.value)}
                placeholder={MODELSCOPE_QWEN_DEFAULT_MODEL}
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
            </label>

            <label className="block">
              <div className="text-sm font-medium text-gray-900">API Key</div>
              <input
                type="password"
                value={msApiKey}
                onChange={(e) => setMsApiKey(e.target.value)}
                placeholder="sk-..."
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
              <div className="mt-1 text-xs text-gray-500">
                保存在浏览器本地存储（local），不会与远程 DB URL 复用。
              </div>
            </label>

            <div className="flex gap-2">
              <button
                onClick={async () => {
                  setAiError("")
                  setAiStatus("保存中…")
                  try {
                    const next = {
                      baseUrl: normalizeOpenAICompatBaseUrl(msBaseUrl),
                      apiKey: msApiKey.trim(),
                      model: msModel.trim()
                    }
                    await saveModelScopeQwenSettings(next)
                    setMsSaved(next)
                    setAiStatus("已保存")
                  } catch (e) {
                    setAiStatus("")
                    setAiError(e instanceof Error ? e.message : String(e))
                  }
                }}
                disabled={!hasAiChanges}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                保存
              </button>
              <button
                onClick={async () => {
                  setAiError("")
                  setAiStatus("已重置为默认值（未保存）")
                  setMsBaseUrl(MODELSCOPE_QWEN_DEFAULT_BASE_URL)
                  setMsModel(MODELSCOPE_QWEN_DEFAULT_MODEL)
                }}
                className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50"
              >
                重置
              </button>
            </div>

            {aiStatus ? <div className="text-sm text-gray-600">{aiStatus}</div> : null}
            {aiError ? (
              <div className="text-sm text-red-600 whitespace-pre-wrap">{aiError}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
