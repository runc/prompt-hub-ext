import { Storage } from "@plasmohq/storage"

import type { IStorage } from "./interface"

export class ChromeStorage implements IStorage {
  #inner: Storage

  constructor(area: "sync" | "local" = "sync") {
    this.#inner = new Storage({ area })
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.#inner.get(key)) as T | undefined
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.#inner.set(key, value as any)
  }
}

