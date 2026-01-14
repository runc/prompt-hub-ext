import { generateText } from "ai"
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai"
import { ChromeStorage } from "@prompt-hub/core/storage/chrome"

import { ORGANIZE_PROMPT_SYSTEM, buildOrganizePromptUser } from "~prompts"

export const MODELSCOPE_QWEN_DEFAULT_BASE_URL = "https://api-inference.modelscope.cn/v1"
export const MODELSCOPE_QWEN_DEFAULT_MODEL = "qwen-plus"

export const AI_STORAGE_KEYS = {
  modelscopeBaseUrl: "promptHub.ai.modelscope.baseUrl",
  modelscopeApiKey: "promptHub.ai.modelscope.apiKey",
  modelscopeModel: "promptHub.ai.modelscope.model"
} as const

const secretStorage = new ChromeStorage("local")

export type OrganizeResult = {
  title: string
  category: string
  tags: string[]
  images: string[]
  videos: string[]
  content: string
}

export type ModelScopeQwenSettings = {
  baseUrl: string
  apiKey: string
  model: string
}

export function normalizeOpenAICompatBaseUrl(input: string): string {
  let url = input.trim()
  if (!url) return ""
  url = url.replace(/\/+$/g, "")
  if (url.endsWith("/chat/completions")) url = url.slice(0, -"/chat/completions".length)
  if (url.endsWith("/responses")) url = url.slice(0, -"/responses".length)
  url = url.replace(/\/+$/g, "")
  return url
}

export async function loadModelScopeQwenSettings(): Promise<ModelScopeQwenSettings> {
  const baseUrl =
    (await secretStorage.get<string>(AI_STORAGE_KEYS.modelscopeBaseUrl)) ??
    MODELSCOPE_QWEN_DEFAULT_BASE_URL
  const apiKey = (await secretStorage.get<string>(AI_STORAGE_KEYS.modelscopeApiKey)) ?? ""
  const model =
    (await secretStorage.get<string>(AI_STORAGE_KEYS.modelscopeModel)) ??
    MODELSCOPE_QWEN_DEFAULT_MODEL

  return { baseUrl, apiKey, model }
}

export async function saveModelScopeQwenSettings(
  settings: ModelScopeQwenSettings
): Promise<void> {
  await secretStorage.set(
    AI_STORAGE_KEYS.modelscopeBaseUrl,
    normalizeOpenAICompatBaseUrl(settings.baseUrl)
  )
  await secretStorage.set(AI_STORAGE_KEYS.modelscopeApiKey, settings.apiKey.trim())
  await secretStorage.set(AI_STORAGE_KEYS.modelscopeModel, settings.model.trim())
}

export async function isModelScopeQwenConfigured(): Promise<boolean> {
  const s = await loadModelScopeQwenSettings()
  return Boolean(s.apiKey.trim() && s.baseUrl.trim() && s.model.trim())
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < 0 || end <= start) return null
  const slice = text.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    return null
  }
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
}

function normalizeLinks(input: unknown): string[] {
  const links = normalizeStringArray(input)
  return links.filter(
    (link) =>
      link &&
      (link.startsWith("http://") || link.startsWith("https://") || link.startsWith("/"))
  )
}

function normalizeResult(input: unknown): OrganizeResult {
  const obj = (input && typeof input === "object" ? (input as Record<string, unknown>) : {}) as
    | Record<string, unknown>
    | undefined

  const title = typeof obj?.title === "string" ? obj.title.trim() : ""
  const category = typeof obj?.category === "string" ? obj.category.trim() : ""
  const content =
    typeof obj?.content === "string"
      ? obj.content.trim()
      : typeof obj?.prompt === "string"
        ? obj.prompt.trim()
        : typeof obj?.text === "string"
          ? obj.text.trim()
          : typeof obj?.body === "string"
            ? obj.body.trim()
            : ""
  const tags = normalizeStringArray(obj?.tags)
  const images = normalizeLinks(obj?.images)
  const videos = normalizeLinks(obj?.videos)

  return { title, category, tags, images, videos, content }
}

export async function organizeWithModelScopeQwen(pastedText: string): Promise<OrganizeResult> {
  const settings = await loadModelScopeQwenSettings()
  if (!settings.apiKey.trim()) {
    throw new Error("未配置 ModelScope API Key，请先在扩展设置中填写。")
  }
  const baseURL = normalizeOpenAICompatBaseUrl(settings.baseUrl)
  if (!baseURL) {
    throw new Error("未配置 ModelScope Base URL，请先在扩展设置中填写。")
  }
  if (!settings.model.trim()) {
    throw new Error("未配置千问模型名称，请先在扩展设置中填写。")
  }

  const openai = createOpenAI({
    apiKey: settings.apiKey.trim(),
    baseURL
  })

  type OpenAIChatModelId = Parameters<OpenAIProvider["chat"]>[0]

  const system = ORGANIZE_PROMPT_SYSTEM
  const user = buildOrganizePromptUser(pastedText)

  const { text } = await generateText({
    model: openai.chat(settings.model.trim() as unknown as OpenAIChatModelId),
    system,
    prompt: user,
    temperature: 0.2
  })

  const parsed = extractJsonObject(text)
  const normalized = normalizeResult(parsed)

  if (!normalized.title && !normalized.content) {
    throw new Error("AI 整理失败：未得到可用的 title/content。")
  }

  return normalized
}
