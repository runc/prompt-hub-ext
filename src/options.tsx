import { useEffect, useMemo, useState } from "react"

import { STORAGE_KEYS, storage } from "~lib/storage"

import "./tabs/prompt-hub.css"

export default function OptionsPage() {
  const [dbUrl, setDbUrl] = useState("")
  const [savedUrl, setSavedUrl] = useState("")
  const [status, setStatus] = useState<string>("")
  const [error, setError] = useState<string>("")

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

  const hasChanges = useMemo(() => dbUrl.trim() !== savedUrl.trim(), [dbUrl, savedUrl])

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
              <li>表名 `prompts`，字段包含 `title`、`content`，可选 `category`、`tags`</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

