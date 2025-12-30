import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "db/index": "src/db/index.ts",
    "storage/index": "src/storage/index.ts",
    "storage/chrome": "src/storage/chrome.ts",
    "storage/web": "src/storage/web.ts"
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2020"
})

