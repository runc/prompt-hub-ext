## Prompt Hub Extension (Plasmo)

### 本地 mock SQLite DB（用于验证新 Tab 瀑布流）

1) 生成 mock 数据库：

`pnpm --filter @prompt-hub/extension mock:db`

会生成：`mock/prompts.sqlite`

2) 本地托管（带 CORS）：

`pnpm --filter @prompt-hub/extension mock:serve`

默认地址：`http://localhost:8787/prompts.sqlite`

3) 扩展里配置 DB URL：

打开扩展「选项」页，填入上面的 URL；或点击扩展图标打开的新 Tab 里直接填 URL。
