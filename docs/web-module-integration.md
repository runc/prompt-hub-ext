# Web 模块集成方案

> 为 Prompt Hub 扩展添加 Web 版本的目录与工程组织方案
> 
> 更新时间：2025-12-29

## 📋 背景

当前项目是基于 Plasmo 框架开发的 Chrome 扩展，主要功能是浏览和管理提示词库（Prompts）。现计划添加 Web 模块，使其可以快速托管到 Vercel 等平台，实现跨平台访问。

**技术栈：** React 19 + TypeScript + TailwindCSS + sql.js + Plasmo

## 🏗️ 推荐架构：pnpm Workspaces（Monorepo）

采用 **pnpm Workspaces** 组织代码，实现最大程度的代码复用（预计 70-80%）。

> 说明：先不引入 Turborepo。等包数量/CI 构建时间上来后，再按需加 Turborepo 做任务编排与缓存。

### 目录结构

```
prompt-hub/
├── apps/
│   ├── extension/                 # 现有 Chrome 扩展
│   │   ├── src/
│   │   │   ├── background.ts     # 扩展专属：后台脚本
│   │   │   ├── options.tsx       # 扩展专属：设置页
│   │   │   └── tabs/
│   │   │       └── prompt-hub.tsx # 迁移后使用共享组件
│   │   ├── package.json
│   │   └── .plasmorc              # Plasmo 配置
│   │
│   └── web/                       # 新增 Web 应用
│       ├── src/
│       │   ├── App.tsx           # Web 主应用
│       │   ├── pages/            # 路由页面
│       │   └── main.tsx
│       ├── vite.config.ts
│       ├── vercel.json            # Vercel 部署配置
│       └── package.json
│
├── packages/
│   ├── core/                      # 共享核心逻辑
│   │   ├── src/
│   │   │   ├── db/
│   │   │   │   └── prompt-db.ts  # SQLite 数据库加载器（95% 可复用）
│   │   │   ├── storage/
│   │   │   │   ├── interface.ts  # 存储接口抽象
│   │   │   │   ├── chrome.ts     # Chrome storage 实现
│   │   │   │   └── web.ts        # localStorage 实现
│   │   │   ├── types/
│   │   │   │   └── prompt.ts     # TypeScript 类型定义
│   │   │   └── utils/
│   │   └── package.json
│   │
│   ├── ui/                        # 共享 React 组件
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── PromptCard.tsx
│   │   │   │   ├── PromptGrid.tsx
│   │   │   │   ├── SearchBar.tsx
│   │   │   │   ├── TagCloud.tsx
│   │   │   │   └── Settings.tsx
│   │   │   └── styles/
│   │   │       └── prompt-hub.css
│   │   └── package.json
│   │
│   └── config/                    # 共享配置
│       ├── eslint-config/
│       ├── typescript-config/
│       └── tailwind-config/
│
├── pnpm-workspace.yaml            # pnpm 工作区配置
├── turbo.json                     # （可选）Turborepo 构建配置
├── package.json                   # 根 package.json
└── README.md
```

### 包依赖关系

```
@prompt-hub/core (纯 TS，无 React 依赖)
    ↓
@prompt-hub/ui (React 组件，依赖 core)
    ↓
┌─────────────┴─────────────┐
│                           │
apps/extension          apps/web
```

## 🎯 实施步骤

### 阶段 1：初始化 pnpm Workspaces（1 天）

1. **创建 Monorepo 结构**
   - 初始化根目录 `prompt-hub/`
   - 配置 pnpm workspace：`pnpm-workspace.yaml`
   - 配置根 `package.json` 的 workspace 脚本（用 `pnpm --filter ...` 组织 build/dev）

2. **设置共享配置**
   - 创建 `packages/config/` 目录
   - 提取 TailwindCSS 配置
   - 统一 TypeScript 和 ESLint 配置

### （可选）阶段 X：引入 Turborepo（按需）

当以下情况出现时再引入即可：
- 包/应用数量明显增多（例如 3+ apps、多个 packages）
- CI/构建耗时明显，需要增量构建与缓存
- 希望显式管理任务依赖与输出目录（outputs）

### 阶段 2：提取核心逻辑（2-3 天）

1. **创建 `@prompt-hub/core` 包**
   - 迁移 `src/lib/prompt-db.ts` → `packages/core/src/db/`
   - 提取类型定义到 `packages/core/src/types/`
   
2. **实现存储抽象层**
   ```typescript
   // packages/core/src/storage/interface.ts
   export interface IStorage {
     get<T>(key: string): Promise<T | undefined>;
     set<T>(key: string, value: T): Promise<void>;
   }
   
   // packages/core/src/storage/chrome.ts
   export class ChromeStorage implements IStorage {
     // 使用 @plasmohq/storage
   }
   
   // packages/core/src/storage/web.ts
   export class WebStorage implements IStorage {
     // 使用 localStorage
   }
   ```

### 阶段 3：拆分 UI 组件（3-4 天）

1. **创建 `@prompt-hub/ui` 包**
   - 将 `tabs/prompt-hub.tsx`（322 行）拆分为独立组件

2. **组件拆分清单**
   - `PromptCard.tsx` - 单个提示词卡片
   - `PromptGrid.tsx` - 瀑布流布局容器
   - `SearchBar.tsx` - 关键词搜索 + 标签输入
   - `TagCloud.tsx` - 标签云展示与筛选
   - `Settings.tsx` - 数据库 URL 配置
   - `EmptyState.tsx` - 空状态提示

3. **迁移样式**
   - `prompt-hub.css` → `packages/ui/src/styles/`
   - 保持 TailwindCSS 类名兼容性

### 阶段 4：迁移扩展到 Monorepo（1-2 天）

1. **迁移现有代码**
   - 移动 `prompt-hub-ext/` → `apps/extension/`
   - 更新 `package.json` 依赖：
     ```json
     {
       "dependencies": {
         "@prompt-hub/core": "workspace:*",
         "@prompt-hub/ui": "workspace:*"
       }
     }
     ```

2. **更新导入路径**
   ```typescript
   // 之前
   import { loadPromptDatabase } from '../../lib/prompt-db';
   
   // 之后
   import { loadPromptDatabase } from '@prompt-hub/core/db';
   import { PromptGrid, TagCloud } from '@prompt-hub/ui';
   ```

3. **实现 Chrome Storage 适配**
   ```typescript
   import { ChromeStorage } from '@prompt-hub/core/storage';
   const storage = new ChromeStorage();
   ```

### 阶段 5：创建 Web 应用（3-5 天）

1. **初始化 Vite 项目**
   ```bash
   cd apps/web
   pnpm create vite . --template react-ts
   ```

2. **集成共享包**
   ```typescript
   // apps/web/src/App.tsx
   import { loadPromptDatabase } from '@prompt-hub/core/db';
   import { WebStorage } from '@prompt-hub/core/storage';
   import { PromptGrid, SearchBar, TagCloud } from '@prompt-hub/ui';
   
   const storage = new WebStorage();
   ```

3. **添加 Web 特有功能**
   - 路由（可选，如使用 React Router）
   - PWA 支持（Service Worker）
   - SEO 优化（Meta 标签）

4. **配置 Vercel 部署**
   ```json
   // apps/web/vercel.json
   {
     "buildCommand": "pnpm build",
     "outputDirectory": "dist",
     "framework": "vite"
   }
   ```

### 阶段 6：优化与测试（2-3 天）

1. **性能优化**
   - 代码分割与懒加载
   - sql.js WASM 文件优化（bundle vs CDN）
   - TailwindCSS 生产构建优化

2. **跨平台测试**
   - 扩展功能测试（Chrome、Edge）
   - Web 应用测试（桌面、移动端）
   - 共享组件单元测试

## 🔄 代码复用分析

### 高度可复用（95%+）

- ✅ **`prompt-db.ts`** - 数据库加载器，已经是纯 Web API
- ✅ **类型定义** - TypeScript 类型完全通用
- ✅ **UI 组件逻辑** - React 组件与平台无关

### 需要适配（30-50%）

- ⚠️ **存储层** - Chrome sync storage → localStorage
  - 接口相同，实现不同
  - 通过依赖注入统一

### 平台专属（0% 复用）

- ❌ **`background.ts`** - Chrome 扩展后台脚本
- ❌ **Plasmo 配置** - 扩展特有的构建配置
- ❌ **Manifest** - Chrome 扩展清单文件

**总体复用率：预计 70-80%**

## 📦 配置文件示例

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "build/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^lint"]
    }
  }
}
```

### 根 `package.json`

```json
{
  "name": "prompt-hub",
  "private": true,
  "scripts": {
    "dev:ext": "turbo run dev --filter=extension",
    "dev:web": "turbo run dev --filter=web",
    "build": "turbo run build",
    "build:ext": "turbo run build --filter=extension",
    "build:web": "turbo run build --filter=web",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.0.0"
  }
}
```

## 🚀 部署方案

### Chrome 扩展

- **构建命令**：`pnpm build:ext`
- **输出目录**：`apps/extension/build/chrome-mv3-prod/`
- **发布平台**：Chrome Web Store

### Web 应用

- **托管平台**：Vercel / Netlify / Cloudflare Pages
- **构建命令**：`pnpm build:web`
- **输出目录**：`apps/web/dist/`
- **环境变量**：
  - `VITE_DEFAULT_DB_URL` - 默认数据库 URL

#### Vercel 一键部署

```bash
cd apps/web
vercel
```

或通过 GitHub 集成自动部署。

## 🎨 替代方案

### 方案 B：简单 pnpm Workspaces（不使用 Turborepo）

**适用场景**：小团队、简单构建流程

**优点**：
- 更轻量，学习曲线低
- 仍支持 workspace 依赖
- 减少工具复杂度

**缺点**：
- 没有构建缓存优化
- 手动管理构建顺序

### 方案 C：独立仓库 + npm 包共享

**结构**：
```
prompt-hub-core/         # npm 包
prompt-hub-ext/          # 扩展仓库（现有）
prompt-hub-web/          # Web 仓库（新建）
```

**适用场景**：团队分离、独立维护

**优点**：
- 仓库独立，部署解耦
- 权限管理更灵活

**缺点**：
- 共享代码同步复杂
- 版本管理开销大
- 跨仓库调试困难

## 💡 技术亮点

### 已有优势

1. **sql.js WebAssembly** - 完全客户端，无需后端
2. **类型安全** - TypeScript 严格模式
3. **响应式设计** - TailwindCSS 移动端友好
4. **无 CORS 限制** - Web 版本可直接访问远程数据库

### 可优化项

1. **状态管理** - 考虑启用已安装的 Zustand
2. **sql.js 优化** - 从 CDN 改为 bundle，减少加载时间
3. **组件测试** - 添加 Vitest 单元测试
4. **PWA 支持** - Web 版本可离线使用

## 📊 工作量评估

| 阶段 | 工作量 | 优先级 |
|------|--------|--------|
| 初始化 Monorepo | 1-2 天 | P0 |
| 提取核心逻辑 | 2-3 天 | P0 |
| 拆分 UI 组件 | 3-4 天 | P0 |
| 迁移扩展 | 1-2 天 | P1 |
| 创建 Web 应用 | 3-5 天 | P1 |
| 优化与测试 | 2-3 天 | P2 |

**总计：12-19 天**（约 2-3 周）

## 📖 参考资源

- [Turborepo 文档](https://turbo.build/repo/docs)
- [pnpm Workspace](https://pnpm.io/workspaces)
- [Plasmo 框架](https://docs.plasmo.com/)
- [Vercel 部署](https://vercel.com/docs)

---

> 建议从**方案 A（Monorepo + Turborepo）**开始，优先提取核心逻辑和 UI 组件，实现渐进式迁移。
