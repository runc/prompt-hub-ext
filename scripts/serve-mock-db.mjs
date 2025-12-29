import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const projectRoot = path.resolve(__dirname, "..")
const mockDir = path.resolve(projectRoot, "mock")
const dbFile = path.resolve(mockDir, "prompts.sqlite")

const port = Number(process.env.PORT ?? 8787)

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "*")
}

const server = http.createServer(async (req, res) => {
  try {
    setCors(res)

    if (!req.url) {
      res.statusCode = 400
      res.end("Bad Request")
      return
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204
      res.end()
      return
    }

    if (req.url === "/" || req.url === "/index.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end(`
<!doctype html>
<meta charset="utf-8" />
<title>Prompt Hub Mock DB</title>
<h1>Prompt Hub Mock DB</h1>
<p><a href="/prompts.sqlite">Download prompts.sqlite</a></p>
<p>DB URL: <code>http://localhost:${port}/prompts.sqlite</code></p>
      `.trim())
      return
    }

    if (req.url !== "/prompts.sqlite") {
      res.statusCode = 404
      res.setHeader("Content-Type", "text/plain; charset=utf-8")
      res.end("Not Found")
      return
    }

    const data = await fs.readFile(dbFile)
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Length", String(data.byteLength))

    if (req.method === "HEAD") {
      res.statusCode = 200
      res.end()
      return
    }

    res.statusCode = 200
    res.end(data)
  } catch (e) {
    res.statusCode = 500
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.end(e instanceof Error ? e.stack ?? e.message : String(e))
  }
})

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Mock DB server: http://localhost:${port}`)
  // eslint-disable-next-line no-console
  console.log(`DB URL: http://localhost:${port}/prompts.sqlite`)
  // eslint-disable-next-line no-console
  console.log(`File: ${dbFile}`)
})

