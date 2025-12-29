import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const projectRoot = path.resolve(__dirname, "..")
const outDir = path.resolve(projectRoot, "mock")
const outFile = path.resolve(outDir, "prompts.sqlite")

function pick(list, i) {
  return list[i % list.length]
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function escapeSqlString(s) {
  return String(s).replaceAll("'", "''")
}

async function main() {
  const initSqlJs = (await import("sql.js")).default
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm")

  const SQL = await initSqlJs({
    locateFile: (file) => {
      if (file === "sql-wasm.wasm") return wasmPath
      return file
    }
  })

  const db = new SQL.Database()
  db.exec(`
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  tags TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

DELETE FROM prompts;
  `)

  const categories = ["写作", "编程", "营销", "办公", "学习", "产品", "设计", "面试"]
  const tagsPool = [
    "email",
    "formal",
    "中文",
    "英文",
    "润色",
    "总结",
    "翻译",
    "改写",
    "debug",
    "review",
    "prompt",
    "persona",
    "SEO",
    "增长",
    "简历",
    "面试",
    "SQL",
    "JavaScript",
    "Python",
    "React"
  ]

  const templates = [
    {
      title: "写一封感谢信",
      content:
        "请帮我写一封感谢信，收件人是：{对方身份/姓名}。语气真诚、具体，包含：感谢原因、具体帮助细节、我学到的东西、后续计划。字数 300-500。"
    },
    {
      title: "把一段话润色为更专业的表达",
      content:
        "请把下面这段话润色为更专业、清晰、简洁的表达，保持原意不夸大：\n\n{原文}\n\n给出：润色版 + 关键修改点列表。"
    },
    {
      title: "为一个功能写 PRD 概要",
      content:
        "你是资深产品经理。请为功能「{功能名}」写一个 PRD 概要，包含：背景/目标、用户画像、核心流程、边界条件、埋点指标、风险与依赖。"
    },
    {
      title: "生成可执行的任务拆解",
      content:
        "请把目标「{目标描述}」拆解成可执行的任务清单（按优先级排序），每项包含：产出物、负责人角色、预计工时、验收标准。"
    },
    {
      title: "代码审查：找出潜在问题",
      content:
        "你是严格的代码审查员。请审查下面代码，指出：bug、性能问题、安全风险、可维护性问题，并给出改进建议：\n\n```{language}\n{code}\n```"
    },
    {
      title: "SQL 查询优化建议",
      content:
        "请分析下面 SQL 的执行瓶颈，给出可能的索引方案、改写建议和注意事项：\n\n```sql\n{sql}\n```"
    },
    {
      title: "生成营销文案（A/B）",
      content:
        "请为产品「{产品名}」生成 5 组 A/B 测试文案，渠道：{渠道}，目标：{转化目标}，每组包含：标题、正文、CTA。"
    },
    {
      title: "学习计划：从零到一",
      content:
        "请为我制定一个 {周期} 的学习计划，主题：{主题}。每周包含：学习目标、材料建议、练习任务、复盘问题。"
    }
  ]

  const rand = mulberry32(42)

  const rows = []
  for (let i = 0; i < 48; i++) {
    const tpl = pick(templates, i)
    const category = pick(categories, i + 2)
    const tagsCount = 2 + Math.floor(rand() * 4)
    const chosen = new Set()
    while (chosen.size < tagsCount) {
      chosen.add(pick(tagsPool, Math.floor(rand() * 1000)))
    }

    const title = `${tpl.title} #${i + 1}`
    const content = `${tpl.content}\n\n补充要求：\n- 输出结构清晰\n- 尽量给出可复制的模板\n- 先问 3 个澄清问题再开始（如果必要）`
    const tags = JSON.stringify([...chosen])

    rows.push({ title, content, category, tags })
  }

  const insertSql = rows
    .map(
      (r) =>
        `INSERT INTO prompts (title, content, category, tags) VALUES ('${escapeSqlString(
          r.title
        )}', '${escapeSqlString(r.content)}', '${escapeSqlString(
          r.category
        )}', '${escapeSqlString(r.tags)}');`
    )
    .join("\n")

  db.exec(insertSql)

  await fs.mkdir(outDir, { recursive: true })
  const data = db.export()
  await fs.writeFile(outFile, data)
  db.close()

  // eslint-disable-next-line no-console
  console.log(`Mock DB written: ${outFile}`)
  // eslint-disable-next-line no-console
  console.log(`Try serving it, then set DB URL to: http://localhost:8787/prompts.sqlite`)
}

await main()

