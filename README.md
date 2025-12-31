# Prompt Hub

一个用于管理和组织 AI 提示词的工具集，包含浏览器扩展和 Web 应用。

## 项目结构

这是一个基于 pnpm workspace 的 monorepo 项目，包含以下模块：

- **apps/extension** - Prompt Hub 主扩展（Chrome/Firefox）
- **apps/prompt-collect-ext** - 提示词收集扩展
- **apps/web** - Web 应用
- **packages/core** - 核心共享库（数据库、存储等）

## 快速开始

### 安装依赖

```bash
pnpm i
```

### 开发

```bash
# 开发主扩展
pnpm dev:ext

# 开发收集扩展
pnpm dev:collect

# 开发 Web 应用
pnpm dev:web
```

### 构建

```bash
# 构建所有项目
pnpm build

# 单独构建
pnpm build:ext       # 构建主扩展
pnpm build:collect   # 构建收集扩展
pnpm build:web       # 构建 Web 应用
```

### 扩展打包

```bash
cd apps/extension
pnpm zip  # 生成 Chrome 扩展压缩包
```

## 技术栈

- **框架**: React 19
- **构建工具**: Plasmo (扩展), Vite (Web)
- **语言**: TypeScript
- **包管理**: pnpm workspace
- **存储**: Chrome Storage API, SQL.js
- **AI SDK**: Vercel AI SDK

## 代码检查

```bash
# 运行 lint
pnpm lint

# 运行类型检查
pnpm typecheck
```

## 开发工具

主扩展提供了一些开发辅助命令：

```bash
cd apps/extension

# 生成模拟数据库
pnpm mock:db

# 启动模拟数据库服务器
pnpm mock:serve
```

## 文档

更多文档请查看 [docs](./docs) 目录。
