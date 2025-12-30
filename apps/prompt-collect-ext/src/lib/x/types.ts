export type CollectMode = "posts" | "replies"

export type CollectFilters = {
  mode: CollectMode
  username: string
  days: number
  keywordQuery: string
  maxItems: number
  keepCollectTabOpen: boolean
  usePopupWindow: boolean
  autoFocusPopup: boolean
}

export type CollectProgress = {
  stage: "collecting" | "finalizing"
  collected: number
  scanned: number
}

export type CollectedTweet = {
  id: string
  url: string
  createdAt: string | null
  text: string
}

export type CollectResult = {
  targetUrl: string
  collectedAt: string
  items: CollectedTweet[]
}
