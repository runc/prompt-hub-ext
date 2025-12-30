import type { Prompt } from "@prompt-hub/core/db"

export { loadPromptsFromRemoteSqlite } from "@prompt-hub/core/db"
export type { Prompt, PromptRow, PromptVariable } from "@prompt-hub/core/db"

export type PromptVariableValues = Record<string, string>

function normalizeVariableName(name: string) {
  return name.trim()
}

export function getPromptVariableInitialValues(
  prompt: Pick<Prompt, "variablesList">
): PromptVariableValues {
  const values: PromptVariableValues = {}
  for (const v of prompt.variablesList) {
    const name = normalizeVariableName(v.name)
    if (!name) continue
    values[name] = v.defaultValue ?? ""
  }
  return values
}

export function renderPromptTemplate(
  template: string,
  values: PromptVariableValues
): string {
  const render = (fullMatch: string, rawName: string) => {
    const name = normalizeVariableName(rawName)
    if (!name) return fullMatch
    const value = values[name]
    if (value == null || value === "") return fullMatch
    return value
  }

  return template
    .replace(/\{\{\s*([^{}\n]+?)\s*\}\}/g, (m, n) => render(m, String(n)))
    .replace(/\{(?!\{)\s*([^{}\n]+?)\s*\}(?!\})/g, (m, n) => render(m, String(n)))
}
