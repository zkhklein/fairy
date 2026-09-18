# Fairy Maid Brigade (FMB) — Agent 操作手册

> 给不了解项目的 Agent：读这份文件即可 **启动开发、定位代码路径、写出一个最小插件并自测**。
> 不认识的缩写：`IPC`=进程间通信、`EP`=扩展点(extension point)、`KV`=键值对持久化。

---

## 0. 一句话定位

FMB 是一个 **Electron 基座 + 插件体系** 的工作流编排桌面应用（Win 优先，设计跨 PC 端兼容）。基座提供页面外壳、核心工作流/调度/队列/错误日历/HTTP API/CLI，插件分三类（atomic / app / extension）把"软件间协作"固化成可调用节点、UI 子页或事件监听。

所有开发都落在 `src/` 下；插件 Demo 落在 `plugins-source/`，压缩包在 `plugins-dist/`。

---

## 1. 目录结构总览

```
FAIRY/
├─ package.json                 # 脚本入口；bin.fmb = CLI 可执行文件
├─ tsconfig.base.json           # TS 基础；4 个项目继承：main / renderer / shared / cli
├─ electron-vite.config.ts      # electron-vite 渲染层打包
├─ scripts/
│  ├─ dev-runner.mjs            # pnpm dev → 启动渲染 vite + 主进程 esbuild watch + Electron
│  ├─ build-main.mjs            # 主进程 esbuild 打包 → out/main/
│  ├─ build-cli.mjs             # CLI 打包 → out/cli/index.js（单文件，commander 内置）
│  ├─ package-plugin.ts         # 把 plugins-source/ 下的插件 TS 编进 zip → plugins-dist/
│  └─ verify_task{5,6-9,10,13,14,15,16,17,20}.cjs  # 各任务的纯 Node 验收脚本
├─ out/                         # 构建产物（主进程 + CLI）；渲染层构建产物在 dist/
├─ plugins-dist/                # 打包好的插件 zip（<id>@<version>.zip），供安装器读
│
├─ src/
│  ├─ shared/                   # **跨进程共享的契约（新增通道/类型先改这里）**
│  │  ├─ types/index.ts         # PluginManifestSchema、PluginType、Status、Workflow 类型
│  │  ├─ ipc/index.ts           # IPC 通道 + Zod params/result schema + 注册表 + 类型别名
│  │  ├─ plugin-api/index.ts    # HostApi（插件沙箱里暴露的上下文）完整签名
│  │  └─ extension-points.ts    # 事件总线已知扩展点列表（payload Zod 校验）
│  │
│  ├─ main-app/                 # **Electron 主进程（Node 上下文）**
│  │  ├─ core/
│  │  │  ├─ db.ts               # better-sqlite3 单例 + 建表脚本（schema v1）
│  │  │  ├─ audit.ts            # newTraceId() + audit.record(ctx, event, data)
│  │  │  ├─ logger.ts           # pino createLogger('子系统名') → 文件+console
│  │  │  ├─ event-bus.ts        # 事件总线（getEventBus().on/emit）；EP 列表
│  │  │  ├─ settings/service.ts # kv_store 表作为配置中心（get/patch）
│  │  │  ├─ plugin/             # ← **插件系统核心**
│  │  │  │  ├─ manifest.ts      # 安装时 manifest 校验（Zod）
│  │  │  │  ├─ sandbox.ts       # vm.Script + Proxy 权限沙箱 + hostApi 注入
│  │  │  │  ├─ host-api.ts      # 构建给沙箱用的 permission-check HostApi 实例
│  │  │  │  └─ loader.ts        # install/uninstall/enable/disable/switchVersion
│  │  │  ├─ workflow/           # CRUD(crud.ts) + Executor(executor.ts)
│  │  │  ├─ scheduler/service.ts# Cron + one-shot，emit workflow.start
│  │  │  ├─ queue/service.ts    # 并发队列（可抢占、dead-letter、retry/cancel/clear）
│  │  │  ├─ error-calendar/service.ts # error_logs 分解决 / 忽略 / 未解决
│  │  │  └─ ipc/handlers.ts     # ← **IPC 接线盘：通道 → service 方法**
│  │  ├─ index.ts               # Electron 主进程入口：建窗 + IPC 注册 + 启动 HTTP
│  │  └─ http/                  # Localhost Hono HTTP API（T15）
│  │
│  ├─ preload/
│  │  └─ index.ts               # contextIsolation=true，暴露 window.fmb（全部 IPC 通道）
│  │
│  ├─ renderer/                 # **React 18 + antd 5（Vite 打包）**
│  │  ├─ src/main.tsx, App.tsx  # 入口 + 8 路由
│  │  ├─ router/index.tsx       # 8 页面路径 + NAV 配置
│  │  ├─ layout/MainLayout.tsx  # 全局布局（左导航 + 面包屑 + 4 状态 Shell）
│  │  ├─ api/fmb.ts             # ← **渲染端 typed client（包装 window.fmb）**
│  │  ├─ stores/index.ts        # 6 个 Zustand stores（plugins/workflow/schedule/job/settings/ui）
│  │  ├─ pages/                 # Dashboard / Plugins / Workflows / Schedules / QueueMonitoring
│  │  │                        # / ErrorCalendar / ExtensionPoints / Settings / AppPluginPage
│  │  └─ components/PageShell.tsx
│  │
│  └─ cli/index.ts              # fmb 命令（commander + HTTP API 通信；基座不在会自启）
│
└─ plugins-source/              # Demo 插件源码（同时作为开发者最小示例）
   ├─ atomic/demo-echo/         # atomic：echo + crashMe（故障注入）
   ├─ app/demo-counter/         # app：+1/-1 Counter UI + 跨插件 ping atomic
   └─ extension/demo-install-notify/  # extension：监听 plugin.afterInstall
```

---

## 2. 启动与调试

### 2.1 环境

- Node ≥ **22.6**（主进程打包用 type stripping 直接跑 `.ts`）；推荐 Node 24 LTS
- pnpm ≥ 9（lockfile v9）
- Windows 10+（第一阶段目标）；macOS/Linux 只保证代码兼容，不保证安装包构建

### 2.2 启动开发

```bash
pnpm install              # 初次 / 拉取后
pnpm dev                  # 一键：vite 渲染层 → esbuild 主进程 → spawn Electron
```

`pnpm dev` 内部干了 3 件事（见 `scripts/dev-runner.mjs`）：

1. `electron-vite dev` 启动渲染层（默认 5173，BrowserWindow `loadURL` 指过去）
2. `node scripts/build-main.mjs watch` 主进程 esbuild watch，out/main/index.js 热更新后自动重启 Electron
3. 有变动 500ms 内重启子进程

### 2.3 调试

- **渲染层断点**：Electron 主窗里开 DevTools（Ctrl+Shift+I），Vite HMR 可用
- **主进程断点**：`node --inspect-brk out/main/index.js` + Chrome `about://inspect` 连 9229；或 VSCode launch.json 跑 `.vscode/launch` 若已添加
- **CLI 调试**：直接 `node out/cli/index.js <cmd>`（单文件 CJS，无依赖）
- **日志**：`<userData>/logs/fmb-<date>.log`（pino）。设置页可切级别。
- **DB**：`<userData>/fmb.db`（better-sqlite3）。设置页有复制 DB 路径按钮。

---

## 3. 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动开发（渲染 vite + 主进程 watch + Electron） |
| `pnpm typecheck` | 4 个 tsconfig（main / renderer / shared / cli）无 emit 校验 |
| `pnpm build` | build:main + build:cli + electron-vite build（产线构建） |
| `pnpm build:cli` | 只打包 CLI → `out/cli/index.js`（`fmb` bin 指向它） |
| `pnpm package:plugins` | 打包 3 个 Demo 插件 zip 到 `plugins-dist/` |
| `pnpm build:win` | pnpm build + electron-builder NSIS + portable（需先配 T18） |
| `node scripts/verify_taskNN.cjs` | 跑某个任务的纯 Node 验收脚本（不启动 Electron） |
| `node out/cli/index.js --help` | CLI 总览；基座未启动会自动拉起 |
| `node scripts/package-plugin.ts app/demo-counter` | 只打包单个插件 |

---

## 4. 约定规则（Add something? Follow these.）

### 4.1 IPC 通道三文件同步改

新增一个 IPC 通道（例如 `main:foo.bar`）必须改 **3 个文件**，顺序如下：

1. **`src/shared/ipc/index.ts`** — 写 Zod `make({ channel, params, result })` + 加 `IPC_REGISTRY` + 加 `IPC_CHANNELS` + 导出 4 个类型别名（`MainFooBarParams`, `MainFooBarResult`）。命名：
   - channel: `main:<domain>.<action>`（驼峰 action，点号分隔）
2. **`src/main-app/core/ipc/handlers.ts`** — `wire(main_foo_bar, async (p) => svc.fn(p.xx))`，**必须用 Zod params 解析 + 结果校验**，handler 单条 <10 行，只转调。
3. **`src/preload/index.ts`** — `contextBridge.exposeInMainWorld('fmb', {... fooBar: (p) => ipcRenderer.invoke(IPC_CHANNELS.main_foo_bar, p) ...})`。
4. **`src/renderer/api/fmb.ts`** — `fooBar(p: MainFooBarParams): Promise<MainFooBarResult>`，UI 里必须走这个，**不许直接写 `window.fmb.xx`**。

违反这条 = 迟早出类型不匹配 Bug（历史上出现过 3 次 `as any` 逃逸）。

### 4.2 插件开发者最小示例：一个 echo 插件

给 Agent 实操：写一个 `atomic` 类 echo 插件并安装自测，步骤 **3 分钟**，不接触基座代码：

```
# 在 plugins-source/atomic/ 下新增
plugins-source/atomic/demo-echo2/
├─ manifest.json
└─ main.ts
```

`manifest.json`：
```json
{
  "id": "com.fmb.demo.echo2",
  "name": "Echo 2",
  "version": "0.1.0",
  "type": "atomic",
  "description": "self-test echo plugin",
  "permissions": ["log:write"],
  "dependencies": {},
  "main": "main.js"
}
```

`main.ts`：
```ts
module.exports = {
  activate(ctx) { ctx.hostApi.logger.info('echo2 up', { id: ctx.pluginId }); },
  deactivate() { hostApi.logger.info('echo2 down'); },
  echo(x) { return x; },
};
```

```bash
pnpm package:plugins                              # 产出 plugins-dist/com.fmb.demo.echo2@0.1.0.zip
node out/cli/index.js plugin install plugins-dist/com.fmb.demo.echo2@0.1.0.zip
# 打开 FMB UI → 插件 → Echo 2 → 启用
# 或用 fmb plugin enable com.fmb.demo.echo2
# 工作流 → 新建工作流 → 拖一个 echo 节点 → 运行 → 节点结果等于输入 = 自测通过
```

### 4.3 扩展点（EP）注册路径

想新增一个宿主级事件，让插件订阅：

1. **`src/shared/extension-points.ts`** — 加一行（Zod payload schema）：
   ```ts
   'workflow.stageComplete': z.object({ runId: z.string(), stage: z.string() }),
   ```
2. **发射方**（例如 executor.ts）— `getEventBus().emit('workflow.stageComplete', { runId, stage })`；**发射时必须是同一个 Zod schema 类型**，任何 mismatch 的字段会被事件总线忽略（不抛错，但日志 warn）。
3. **插件订阅** — 插件清单 `extensionPoints: ["workflow.stageComplete::onStage"]`；`exports.onStage = async (payload) => { ... }`。loader.enable 时自动 `bus.on(point, exports[handlerName])`。

### 4.4 禁止硬编码路径 / 文件名

- 用户数据一律走 `electronApp.getPath('userData')`（Win = `%APPDATA%\fairy-maid-brigade`，macOS=`~/Library/Application Support/fairy-maid-brigade`）。
- 资源（插件 zip 内置等）走 `process.resourcesPath` 或 `app.getAppPath()` 的 `electron-builder extraResources`。
- 不许写 `C:\\Users\\...`、`~`、`./dist/` 这类相对/假设路径。

### 4.5 Zod schema 放 shared

所有跨边界（IPC、HTTP、manifest、EP 载荷）的 schema 都放在 `src/shared/` 下，主/渲染/CLI 只 import，**不复制**。新增 schema 前先 grep 确认没有现成的（`MainPluginListResult` 之类）。

### 4.6 typecheck 0 errors 才能合入

历史曾发生 7 次 typecheck 非 0 的合入导致连锁问题。每改完一轮必跑 `pnpm typecheck`；若出现 `as any`，优先修类型契约而不是转义。

### 4.7 文件命名约定

- 主进程：`src/main-app/<domain>/service.ts`、`core/<domain>/<职责>.ts`（如 loader/sandbox/manifest/host-api）
- 渲染层：页面 `pages/<Name>.tsx`、组件 `components/<Name>.tsx`、布局 `layout/<Name>.tsx`、stores `stores/index.ts` 汇总
- shared：`<领域>/index.ts` 单文件
- 脚本：`scripts/<verb>-<noun>.[mt]s`；验收脚本统一 `scripts/verify_task<NN>.cjs`（CJS 零依赖，`node scripts/...` 直接跑）

### 4.8 工作流（Workflow）定义规范

**工作流是 App 插件的内置资产，不是用户手动创建的。**

核心原则：
- **工作流 = App 插件的业务流程定义**，在插件 `activate()` 时通过 `hostApi.workflows.create()` 注册，随插件生命周期存在
- **工作流不可手动新增/删除/编辑**（UI 上不提供这些操作），只能由所属 App 插件管理
- **工作流可被定时任务触发**（通过 `scheduleTemplates` 声明），**也可被手动触发**（工作流页"运行"按钮）
- **App 插件必须为其核心业务流程声明工作流**，不能只在内部用 `plugins.invoke` 编排而不注册工作流

工作流与定时任务的关系：
- **工作流**定义"做什么"（DAG 节点编排：压缩→上传→清理）
- **定时任务**定义"什么时候做"（cron / 一次性触发）
- App 插件在 `manifest.json` 的 `scheduleTemplates[]` 中声明可被用户添加的定时任务模板，每个模板指定 `targetWorkflowId` 关联到具体工作流

示例：百度上传插件的正确结构
```
App 插件 com.fmb.baidunetdisk.uploader
├─ manifest.json
│  ├─ scheduleTemplates[]     ← 声明用户可添加的定时任务模板
│  │   ├─ { id:"scheduled_upload", label:"定时上传", targetWorkflowId:"wf-baidu-upload-flow", paramsSchema:{...} }
│  │   └─ { id:"auto_resume",      label:"自动恢复", targetWorkflowId:"wf-baidu-uploader-auto-resume" }
│  └─ extensionPoints[]       ← 注册模板处理器
│      ├─ "schedule.template.com.fmb.baidunetdisk.uploader.scheduled_upload::onScheduledUpload"
│      └─ "schedule.template.com.fmb.baidunetdisk.uploader.auto_resume::onAutoResume"
│
└─ main.ts activate()
   ├─ workflows.create({ id:"wf-baidu-upload-flow", definition:{ nodes:[compress,upload,cleanup] } })
   ├─ workflows.create({ id:"wf-baidu-uploader-auto-resume", ... })
   └─ schedules.create({ ... })  ← 内部自用的默认定时任务（可选）
```

违反这条 = 工作流页面看不到插件的核心业务流程，定时任务页无法添加该插件的模板，用户无法手动触发或定时触发插件的核心功能。

### 4.9 Windows 开发环境约定（pwsh + UTF-8 无 BOM + LF）

本机在 Windows 上开发时统一：

- **Shell 用 pwsh（PowerShell 7，路径 `C:\Program Files\PowerShell\7\pwsh.exe`）**，不要用 Windows PowerShell 5.1（`powershell.exe`）。老 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM、参数编码行为也不同，历史上坑过 KV 文件解析。
- **文本文件一律 UTF-8 无 BOM**（BOM 会让 `JSON.parse` 炸掉；写过文件后可用 `[System.IO.File]::ReadAllText($p)[0] -ne "`uFEFF"` 自查）。
- **行尾 LF**：仓库已带 `.gitattributes`（`* text=lf eol=lf`，bat/cmd/ps1 例外仍 CRLF），且本仓库 git 配置 `core.autocrlf=false` + `core.eol=lf`。编辑器/IDE 保持 LF 保存，不要整文件转成 CRLF 造成全量 diff。

---

## 5. 调试故障时的快速定位表

| 现象 | 先查这些文件 |
|---|---|
| UI 按钮点了没反应 | renderer/pages/XX.tsx → stores/index.ts IPC 有没有结果 |
| IPC 通道错误 `no handler registered` | shared/ipc/index.ts 有没有加 IPC_REGISTRY |
| 插件 enable 后没反应 | loader.ts enableFlow / sandbox.ts 有没有 SyntaxError（检查 strict-mode） |
| 权限报错 `Permission denied` | host-api.ts 对应方法的权限声明有没有在 manifest.permissions 里 |
| HTTP 401 Unauthorized | 设置页 http.token 已生成；CLI 读 `.fmb-http.json`（userData 下）|
| HTTP 端口占用 | settings page 改 http.port，重启生效 |
| 工作流节点 failed 但没日志 | error_logs 表 / Queue deadLetter；AC-14 用 crashMe action 验证 |
| 打包后插件加载慢且吃 CPU | T12-B：确认 zip 里已有 `renderer.umd.js`（预编译），宿主就跳 esbuild |
| typecheck 通了但 build 失败 | esbuild external 模式不支持 RegExp（只支持 string glob）|
| 插件卸载重装后内容没清 | loader.ts uninstall 会删整目录；版本切换删 .fmb-kv.json 重置 state |

---

**文档版本**：v1.0 · 代码冻结于 T1–T16 完成。T17 之后新增核心模块时同步追加章节。
