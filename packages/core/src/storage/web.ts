import type { IStorage } from "./interface"

export class WebStorage implements IStorage {
  #prefix: string

  constructor(prefix = "") {
    this.#prefix = prefix
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = localStorage.getItem(this.#prefix + key)
    if (raw == null) return undefined

    try {
      return JSON.parse(raw) as T
    } catch {
      return raw as T
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (typeof value === "string") {
      localStorage.setItem(this.#prefix + key, value)
      return
    }

    localStorage.setItem(this.#prefix + key, JSON.stringify(value))
  }
}

