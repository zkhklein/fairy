# Fairy Maid Brigade (FMB)

> 妖精女仆团 · 插件式跨 PC 端软件间协作工作流平台基座。

将多软件协作流程固化为可复用工作流，面向人类用户与 AI Agents；提供 CLI 与 Localhost HTTP API，第一版 Windows、设计即兼容 Mac/Linux。

## 项目目录约定

| 目录                          | 用途                                                                    |
| --------------------------- | --------------------------------------------------------------------- |
| `src/main/`                 | Electron 主进程（核心能力：插件、工作流、调度、队列、事件、错误日历、HTTP）                          |
| `src/main/preload.ts`       | 安全 contextBridge IPC 暴露层（contextIsolation=true）                       |
| `src/renderer/`             | Electron 渲染进程（React 18 UI：主界面 + 应用插件子页面）                              |
| `src/shared/`               | 主 / 渲染 / 插件 三处共享：types / zod schemas / IPC 契约 / plugin-api / http-api |
| `plugins-source/atomic/`    | 原子能力插件源码（单一能力，无子页面）                                                   |
| `plugins-source/app/`       | 应用插件源码（多原子能力组合 + 唯一对应应用子页面）                                           |
| `plugins-source/extension/` | 拓展插件源码（挂载到核心拓展点）                                                      |
| `plugins-dist/`             | 插件编译打包产物（`.zip`）                                                      |
| `dist/`                     | Electron 打包输出（安装包 / portable exe）                                     |
| `.trae/specs/`              | Spec Mode 产物（spec.md / tasks.md / review\.md）                         |

## 环境要求

- Node.js **>= 20**
- pnpm **>= 9**（推荐 `npm i -g pnpm@9.15.0`）
- Git
- Windows 构建安装包需支持长路径（`dist/` 可能较深）

## 常用命令

```bash
# 安装依赖
pnpm install

# 启动开发模式（electron-vite HMR）
pnpm dev

# 仅构建（不打包安装包）
pnpm build

# 打包 Windows NSIS 安装包 + portable exe → dist/
pnpm build:win

# 全局 TypeScript 类型检查（main / renderer / shared 三处 strict=true）
pnpm typecheck
```

## 核心约定（必须遵守）

1. **严禁硬编码路径分隔符**：全部使用 `path.join()` / `path.resolve()` / `path.sep`，禁止 `'\\'` 或 `'/'` 直接拼接，确保 Mac/Linux 可迁移。
2. **全量 TypeScript strict=true**：`any` 类型不被接受；对外输入一律 zod schema 校验。
3. **IPC 命名规范**：主进程通道 `main:<domain>.<verb>`（例 `main:plugin.install`）；在 `src/shared/ipc/` 集中声明 params/result zod schema。
4. **零外部服务依赖**：第一版不依赖 Redis / Postgres / 云服务；仅用 SQLite 嵌入式数据库。
5. **插件沙箱**：插件代码永远不直接访问 Node 原生模块，必须通过宿主 `HostApi` Proxy（含权限声明校验）。
6. **审计日志优先**：所有写操作（插件安装、工作流执行、定时任务变更、HTTP/CLI 调用）先写 `audit_logs` 后落业务表。

## 技术选型（v1）

| 层        | 技术                                                                              |
| -------- | ------------------------------------------------------------------------------- |
| 桌面框架     | Electron 30                                                                     |
| 构建工具     | electron-vite 2 + Vite 5                                                        |
| 前端       | React 18 + TypeScript 5 + Ant Design 5 + TailwindCSS + Zustand + React Router 6 |
| 主进程      | Node.js 20 + TypeScript                                                         |
| 数据库      | SQLite 3 + better-sqlite3 + Kysely                                              |
| 事件总线     | EventEmitter2（通配符 + 错误隔离）                                                       |
| 定时任务     | node-cron + SQLite 持久化                                                          |
| 工作队列     | 自研 SQLite 持久化队列 + worker\_threads 并发                                            |
| CLI      | commander.js                                                                    |
| HTTP API | hono + zod-openapi + Swagger UI + Bearer Token                                  |
| 日志       | pino + rotating-file-stream                                                     |
| 打包分发     | electron-builder（Windows NSIS + portable）                                       |
| 插件沙箱     | node:vm + manifest.json 权限声明 + semver 依赖解析                                      |

## GitHub

远程：`git@github.com:zkhklein/fairy.git`
