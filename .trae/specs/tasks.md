# Fairy Maid Brigade - Implementation Plan (tasks.md)

## Task 1: 项目脚手架初始化（monorepo 结构 + Electron-Vite 配置）
- **Status**: `in_progress`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 初始化目录：`src/main/`, `src/renderer/`, `src/shared/`, `plugins-source/atomic/`, `plugins-source/app/`, `plugins-source/extension/`, `plugins-dist/`, `dist/`
  - `package.json`: Node 20 LTS + pnpm 9，脚本 `pnpm dev` / `pnpm build` / `pnpm build:win` / `pnpm typecheck`
  - `tsconfig.json` 三处（main / renderer / shared），strict=true, noImplicitAny=true
  - `electron-vite.config.ts`：主进程 preload + 渲染进程 React entry，alias `@/` 指向对应目录
  - `.gitignore`：node_modules / dist / plugins-dist / .vite / *.log
  - 初始化 Git 仓库，设置 remote=`git@github.com:zkhklein/fairy.git`，首次提交空骨架
  - 创建根 `README.md`（简述 Fairy Maid Brigade、启动命令、目录说明）
- **Acceptance Criteria Addressed**: AC-1, AC-12, AC-13
- **Test Requirements**:
  - `rule` TR-1.1: `pnpm install` 后 `pnpm typecheck` 退出码 0，0 error
  - `rule` TR-1.2: `pnpm dev` 启动后 Electron 窗口渲染 React 默认模板 "Hello FMB"，3s 内可见
  - `rule` TR-1.3: `git remote -v` 输出包含 origin=git@github.com:zkhklein/fairy.git
- **Notes**: 此阶段不引入 AntD、Kysely 等业务依赖（Task 2 再装），只装 electron-vite/electron/react/react-dom/typescript 基础依赖

---

## Task 2: 基础设施层 - SQLite + Kysely + Migrations + 日志系统 + 审计日志
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - 安装 `better-sqlite3` `kysely` `pino` `rotating-file-stream` `electron-log`
  - `src/main/core/db/index.ts`：封装 Database 单例，路径=`app.getPath('userData')/fmb.db`
  - Migrations 框架：`src/main/core/db/migrations/` 目录 + 按时间戳前缀编号，启动时自动执行未应用迁移
  - 首次迁移 `001_init.sql` 创建 12 张表：plugins, plugin_versions, workflows, workflow_runs, workflow_nodes, schedules, job_queue, error_logs, audit_logs, extension_point_bindings, secrets, kv_store
  - `src/main/core/logger/index.ts`：pino 结构化日志 + 按天轮转；主进程/worker/HTTP 三套 logger 实例，日志目录统一 `app.getPath('userData')/logs/`
  - `src/main/core/audit/index.ts`：`audit(action, payload, source)` 写 `audit_logs` 表，自动附带 timestamp / traceId / actor
- **Acceptance Criteria Addressed**: AC-1, AC-7, AC-8, AC-13
- **Test Requirements**:
  - `rule` TR-2.1: 启动后 `userData/fmb.db` 文件存在；`PRAGMA table_list` 返回包含上述 12 张表
  - `rule` TR-2.2: `audit('test.action', {k:'v'}, 'test')` 后查询 `SELECT COUNT(*) FROM audit_logs` = 1
  - `rule` TR-2.3: 连续写 100 条日志后 `logs/main.log` 文件大小 > 0；日志 JSON 每行合法（`jq .level` 能解析）
- **Notes**: DB 层**只**用 Kysely query builder，不允许手写字符串拼接 SQL

---

## Task 3: Shared 类型定义 + IPC 契约（zod schemas）+ Host-Plugin API 边界
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - `src/shared/types/`：全量领域类型（Plugin / PluginManifest / Workflow / WorkflowRun / WorkflowNode / Schedule / Job / ErrorLog / AuditLog 等），导出同名 zod schema
  - `src/shared/ipc/`：所有主↔渲染进程 IPC 通道定义（命名 `main:plugin.*` `main:workflow.*` 等），每个通道含 `params: ZodSchema` + `result: ZodSchema`
  - `src/shared/plugin-api/`：宿主暴露给插件的 TypeScript 类型（HostApi 接口，含 eventBus / logger / secretStore / workflowEngine 等方法），每个方法有入参出参 zod 校验声明
  - `src/shared/http-api/`：HTTP API OpenAPI 片段，zod schema + path/method 映射
  - 所有 zod 错误转为结构化 ProblemDetails 响应
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-10, AC-11, AC-13
- **Test Requirements**:
  - `rule` TR-3.1: `tsc --noEmit` 0 error；`import type * as T from '@fmb/shared'` 在 main、renderer、plugins 三处均可无错导入
  - `rule` TR-3.2: 用非法 manifest（缺 version 字段）调用 `PluginManifestSchema.parse` 抛出 ZodError，错误路径含 "version"
  - `rubric` TR-3.3: IPC/Plugin/HTTP 三类契约一致性；scale 1-5; 1=各有独立类型不共享 3=大部分共享小部分重复 5=100% 一套 shared schema 三处复现且命名统一; threshold >= 4; evidence: grep 统计关键类型重复次数
- **Notes**: 参考 AAS Skill `api-and-interface-design` 设计边界与错误格式

---

## Task 4: 核心模块 - 事件总线（EventEmitter2 + 内置 12+ 拓展点定义 + 错误隔离）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 3
- **Description**:
  - 安装 `eventemitter2`
  - `src/main/core/event-bus/index.ts`：`EventBusService` 单例封装 EventEmitter2（wildcard=true, delimiter=.）
  - `src/main/core/event-bus/extension-points.ts`：定义 12 个标准拓展点常量 + 类型签名：
    - `app.onReady`, `app.beforeQuit`
    - `plugin.beforeInstall`, `plugin.afterInstall`, `plugin.beforeUninstall`
    - `workflow.beforeExecute`, `workflow.afterExecute`, `workflow.nodeComplete`, `workflow.nodeError`
    - `schedule.triggered`
    - `queue.jobEnqueued`, `queue.jobCompleted`, `queue.jobFailed`
    - `errorLog.newEntry`
    - `ui.mainMenu.render`, `ui.mainDashboard.card`
  - 订阅方法 `safeEmit(event, payload)`：每个 handler 独立 try-catch，失败不中断其他；写入 error_logs（level=warn）；记录调用耗时到 traceId
  - 订阅者查询 API：`listBindings(event)` 返回 handler 列表（给拓展点页面展示用）
- **Acceptance Criteria Addressed**: AC-9, AC-14
- **Test Requirements**:
  - `rule` TR-4.1: 同一事件订阅 3 个 handler，其中第 2 个抛异常 → 第 1、3 仍被调用；error_logs 新增 1 条 warn
  - `rule` TR-4.2: 通配符订阅 `workflow.*` → `emit('workflow.nodeComplete')` 与 `emit('workflow.nodeError')` 均命中
  - `rule` TR-4.3: `listBindings('plugin.afterInstall').length` 准确返回当前订阅数（含 extension 插件声明的）
- **Notes**: **不能**用 Node 原生 EventEmitter（缺通配符）

---

## Task 5: 核心模块 - 插件系统（zip 解压 + manifest 校验 + vm 沙箱 + 权限 + 依赖解析 + 版本管理 + 生命周期）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 3, Task 4
- **Description**:
  - 安装 `adm-zip` `semver` `vm2` 或用原生 `node:vm`（后者足够，减少依赖）
  - `src/main/core/plugin/manifest.ts`：zod 校验 manifest.json 10 字段（id/name/version/type/description/permissions/dependencies/main/renderer/extensionPoints）
  - `src/main/core/plugin/loader.ts`：
    - `installFromZip(zipPath)` → 解压到 `userData/plugins/<id>@<version>/` → 校验 manifest → 写 `plugins` 与 `plugin_versions` 表 → emit `plugin.beforeInstall/afterInstall`
    - `parseDependencies(deps)` → semver 解析，查已装 atomic 插件，循环依赖/冲突直接返回错误
    - `enablePlugin(id)` → 选择版本（默认最新）→ 创建 sandbox vm context → 注入受限 HostApi（权限过滤 Proxy）→ 加载入口 main.js 并执行 `activate(ctx)` 函数
    - extension 插件：遍历 manifest.extensionPoints 绑定到 EventBus
    - `disablePlugin(id)` → 调用 `deactivate()` → 取消 EventBus 绑定 → 清理 vm context
    - `switchVersion(id, version)` → 停用 → 切换目录 → 启用
    - `uninstallPlugin(id, version?)` → emit beforeUninstall → 删除目录 + 表记录
  - 沙箱权限控制：HostApi Proxy 调用前查 manifest.permissions，未声明的返回 PermissionDenied 错误
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-8, AC-9, AC-14
- **Test Requirements**:
  - `rule` TR-5.1: 安装 invalid manifest（缺 type 字段）的 zip → 返回 ZodError；表中无记录；无文件残留
  - `rule` TR-5.2: 安装声明依赖不存在 atomic-x@^2 的 app 插件 → 安装失败并返回具体缺失信息
  - `rule` TR-5.3: 未声明 `fs:write` 权限的插件调用 `hostApi.fs.writeFile(...)` → 抛 PermissionDenied 错误；写入 error_logs
  - `rule` TR-5.4: 先装 v1.0.0 再装 v1.1.0 → `switchVersion` 后再次调用插件方法 → 返回新版本输出；`plugins.current_version` 字段更新
  - `rubric` TR-5.5: 沙箱隔离完整性；scale 1-5; 1=插件能直接 require('fs') 3=大部分API代理但有遗漏 5=插件访问原生模块一律失败，只能用 hostApi，且所有副作用审计落库; threshold >= 4; evidence: 构造 5 种逃逸尝试全部被拦截的测试脚本输出
- **Notes**: 参考 AAS Skill `api-and-interface-design` 设计 HostApi；插件异常被 vm catch 不影响主进程

---

## Task 6: 核心模块 - 工作流引擎（JSON DSL + DAG 执行器 + 上下文 + 重试 + 密钥）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 3, Task 4, Task 5
- **Description**:
  - `src/main/core/workflow/dsl.ts`：定义 WorkflowDefinition zod schema（nodes[] edges[] vars?）
  - 节点类型 zod discriminator：`atomic`(pluginId, action, inputs), `condition`(expr, trueNode, falseNode), `loop`(collection, bodyId), `subflow`(workflowId), `delay`(ms)
  - `src/main/core/workflow/dag.ts`：DAG 校验（拓扑排序，循环检测，孤岛节点检测），校验不通过 reject
  - `src/main/core/workflow/executor.ts`：`execute(workflowId, input, trigger)`
    - 初始化 Context（全局 vars + 密钥解密 + 输入），每节点执行前替换 `${var.x}` 占位符
    - 按拓扑顺序执行，atomic 节点通过 PluginService 调用对应插件 action
    - 节点级重试策略 `retry.maxAttempts` + `retry.backoff=fixed|exponential`
    - 每步写 workflow_nodes（start/end 时间、status、input、output、error_stack）
    - emit workflow.beforeExecute / nodeComplete / nodeError / afterExecute
    - 最终状态 success / failed / cancelled 写 workflow_runs
  - `src/main/core/workflow/secret-store.ts`：Windows 用 DPAPI + keytar 加密 secrets 表 value 列
  - CRUD 服务：list/get/create/update/delete/duplicate/importJson/exportJson
- **Acceptance Criteria Addressed**: AC-4, AC-5, AC-9, AC-14
- **Test Requirements**:
  - `rule` TR-6.1: 构造 2 节点 echo DAG（echo1→echo2），input='hello' → 节点 1 output='hello'，节点 2 output='hello'
  - `rule` TR-6.2: 构造含环 DAG A→B→C→A → dag.validate() 抛 CycleDetectedError
  - `rule` TR-6.3: atomic 节点 retry 配置 max=3 backoff=exponential；节点抛 2 次错后成功 → workflow_nodes 显示 attempt_count=3；总执行耗时符合指数退避
  - `rule` TR-6.4: 节点 input 含 `${secrets.API_KEY}` → 执行后 output 中包含解密后明文值；`secrets` 表中值仍为密文（肉眼不可读）
- **Notes**: JSON DSL 支持 YAML 导入自动转换（安装 `yaml` 包）

---

## Task 7: 核心模块 - 定时任务（node-cron + 持久化 + missed 策略 + 状态恢复）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 4, Task 6
- **Description**:
  - 安装 `node-cron`
  - `src/main/core/scheduler/service.ts`：
    - CRUD schedule：id、name、cronExpr 或 oneShotAt、workflowId、enabled、input、misfirePolicy(run_now|skip|last_missed)、timezone
    - 启动时：从 schedules 表加载 enabled=true 的，全部注册到 cron
    - 暂停/恢复：update + reschedule；missed job 检测基于 `lastFiredAt` + `nextFiredAt` 持久化
    - 触发：emit `schedule.triggered` → 调 WorkflowExecutor.execute 或通过 QueueService 入队（按配置）
    - `nextRunTimes(scheduleId, n=5)`：返回后 5 次预计时间，UI 展示用
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `rule` TR-7.1: 新增 cron=`* * * * *` 任务，enabled=true → 70s 内至少触发 2 次；`workflow_runs` 中 trigger='schedule'
  - `rule` TR-7.2: 关闭基座 3 分钟再开启（模拟 missed），misfirePolicy=run_now → 启动后 5s 内立刻补执行 1 次
  - `rule` TR-7.3: `schedule.enabled=false` 60s 内 0 次触发
- **Notes**: 所有时间统一 UTC 存库，展示时按 timezone 转换

---

## Task 8: 核心模块 - 工作队列（SQLite 持久化 + worker_threads 并发 + 优先级 + 死信）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 4, Task 6
- **Description**:
  - 安装 `async-mutex`（防止 SQLite 并发读写出错，事务级并发控制）
  - `src/main/core/queue/schema.ts`：job_queue 表字段 id、type(workflow_run|atomic_call)、payload、priority(0-9)、status(pending|running|completed|failed|dead)、attempts、maxAttempts、retryBackoff、startedAt、finishedAt、lastError、workerId
  - `src/main/core/queue/service.ts`：
    - `enqueue(type, payload, priority, opts)` → 写入 status=pending；emit `queue.jobEnqueued`
    - `dispatcherLoop()`：每个 tick 查 pending 数 - running 数 < `globalConcurrency` 则按 priority DESC、id ASC 取差额条；标记 running + 分配 workerId
    - Worker：`worker_threads` 独立线程执行；worker 通过受保护消息通道调用 Plugin / Workflow 服务（worker 自身不直接连 DB）
    - 成功：status=completed + emit jobCompleted；失败：attempts+1；attempts>=maxAttempts → status=dead；否则按 retryBackoff sleep 后重入队
    - `metrics()`：返回各 status 计数 + 当前运行任务详情；`retryDeadJobs()` / `clearDead()`
  - 全局并发数默认=4，设置页可配置并热更新
- **Acceptance Criteria Addressed**: AC-6, AC-14
- **Test Requirements**:
  - `rule` TR-8.1: 并发=2；一次性入队 5 个 3s 延迟 job → running 峰值 ≤ 2；总完成时间 ∈ [8s, 11s]
  - `rule` TR-8.2: 高优先级(p=9)与低优先级(p=1)交替入队，同时空闲 → 高优先级先被取出执行
  - `rule` TR-8.3: maxAttempts=3，job 连续抛错 → 第 4 次判断 status=dead；队列统计 dead=1；其他 job 不受影响继续执行
  - `rule` TR-8.4: 执行中强制杀进程重启 → 启动 dispatcher 后 `status=running` 的 job 自动重置为 pending（超时回收），并重新执行
- **Notes**: **不能**使用 BullMQ（因为要求 Redis 外部依赖）；必须 SQLite 自实现

---

## Task 9: 核心模块 - 错误日历（error_logs 服务 + 聚合查询 + 标记解决）
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 2, Task 4
- **Description**:
  - `src/main/core/error-calendar/service.ts`：
    - `log(entry)`：校验 entry.zod → 写入 error_logs（level/source/traceId/stack/metadata）→ emit `errorLog.newEntry`（触发 Extension 与 Toast）
    - `query(filters)`：level / source / range / resolved / keyword 多维筛选 + 分页
    - `markResolved(id, resolved: boolean)` / `markIgnored(id)`
    - `dailyCount(year, month)`：月视图热力图所需数组 [1..31] 的每日计数
    - `dailyDetail(date)`：某天所有错误列表
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `rule` TR-9.1: 批量插入 8 条日志（3 error + 5 warn 跨 7 天）→ dailyCount 返回正确每日分布；筛选 level=error 后返回 3 条
  - `rule` TR-9.2: 调用 markResolved → 下次 query(includeResolved=false) 不返回；includeResolved=true 则返回且 resolved=true
  - `rule` TR-9.3: PluginService 中任意抛错经上层 catch 调 errorCalendar.log() 后，表中新增且 source=plugin:xxx

---

## Task 10: 渲染进程 UI 基座 - Electron 主窗口 + 路由 + 左侧导航 + 全局布局 + Zustand stores
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1, Task 3
- **Description**:
  - 安装 `antd` `@ant-design/icons` `tailwindcss` `postcss` `autoprefixer` `zustand` `react-router-dom` `dayjs`
  - `src/main/window/main-window.ts`：BrowserWindow 配置（width=1280, height=800, title=Fairy Maid Brigade）；preload 脚本暴露 contextBridge 安全 IPC（`window.fmb.*`），**开启 contextIsolation=true**
  - `src/renderer/src/App.tsx`：Router + 全局 Layout（Sider 左侧导航 + Header + Content + Footer）
  - 左侧导航（AntD Menu）：Dashboard、插件管理、工作流、定时任务、队列监控、错误日历、拓展点、设置（对应 spec FR-1.1 的 8 项）
  - Zustand stores（每类一个）：`usePluginStore`, `useWorkflowStore`, `useScheduleStore`, `useQueueStore`, `useErrorStore`, `useUiStore`；通过 preload 暴露的 IPC 封装服务端调用
  - UI 设计：参考 AAS Skill `anti-ui-slop`；所有页面必须覆盖 loading / empty / error / success 四状态
- **Acceptance Criteria Addressed**: AC-1, AC-13
- **Test Requirements**:
  - `rule` TR-10.1: 启动后主界面 8 项导航渲染；点击各项路由切换无 404；布局无重叠/溢出
  - `rule` TR-10.2: contextIsolation=true；DevTools console 输入 `window.require` 返回 undefined（防止渲染进程直接访问原生）
  - `rubric` TR-10.3: 四状态覆盖完整性；scale 1-5; 1=无加载骨架直接白屏 3=部分页面缺少 error/empty 态 5=每个独立数据源对应 Skeleton/Empty/Result(status=error)/数据表格四组件齐全且响应合理; threshold >= 4; evidence: 8 个页面逐页状态截图合集
- **Notes**: 参考 AAS Skill `anti-ui-slop`；不要生成假数据/假用户/假统计让页面好看，loading/empty 要真实

---

## Task 11: 各功能页面完整实现（Dashboard + 7 个管理页 + 设置页）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 10 (UI 基座), Task 5~9 (核心服务)
- **Description**:
  - **Dashboard**（FR-1.2）：4 个 Statistic 卡片（运行中、今日错误、队列等待、最近24h执行总数）+ 最近执行 Table + Quick actions（手动执行工作流 / 新建定时任务）
  - **插件管理**（FR-1.3, FR-8）：表格列 ID/名称/类型/版本/状态/依赖/安装时间；操作列 启用/停用/卸载/切换版本/升级；顶部 安装zip 上传 + 搜索 + 类型筛选；切换版本 Modal 展示历史版本
  - **工作流**（FR-4.2）：列表（名称/描述/节点数/最后运行/状态）+ 新建/编辑 JSON 编辑器（Monaco 或 CodeMirror）+ Schema 实时校验 + 导入导出 JSON/YAML + 执行记录 tab
  - **定时任务**（FR-5.4）：表格 + 新建表单（cron 助手组件）+ Next run 列表 + 暂停/恢复按钮
  - **队列监控**（FR-6.4）：5 个大数字 + 实时刷新 Table（当前执行中的 job + workerId + 耗时）+ 死信列表 + Retry all/Clear 按钮
  - **错误日历**（FR-7.2, FR-7.3, FR-7.4）：AntD Calendar 月视图 + 单元格右上角徽标数热力染色 + 点击日列表下方切换明细 Table + 筛选器 + 标记操作
  - **拓展点**（FR-3.1）：12+ 标准拓展点折叠面板，每个展示当前订阅者（名称、插件 ID、handler）
  - **设置**：全局并发数滑块、端口号(HTTP API)、Token 重置、日志级别、开机自启、关闭窗口行为（托盘/退出）、关于（版本号 + 插件宿主 API 文档链接）
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-7, AC-8
- **Test Requirements**:
  - `rule` TR-11.1: 插件管理页上传 3 Demo zip → 列表新增 3 行，类型列分别显示 atomic/app/extension 彩色 tag；app 行出现"打开子页面"按钮
  - `rule` TR-11.2: 错误日历有 8 条错误月视图 → 单元格日期底色根据数量深度变化；点击某日 → 下方 Table 显示仅当日记录
  - `rule` TR-11.3: 工作流编辑提交非法 JSON → 编辑器行内红字标注；保存按钮被禁用
  - `rubric` TR-11.4: 信息密度与层级合理性（anti-ui-slop）；scale 1-5; 1=所有信息大号字体+大间距+一屏仅3条数据 3=信息密度合适但层级不明显 5=表格密度合理(每页20条)+层级对比清晰+主操作按钮与次操作视觉差别显著+无空洞占位; threshold >= 4; evidence: 8 个页面截图逐页打分
- **Notes**: 参考 AAS Skill `anti-ui-slop`；优先用 Ant Design ProComponents（ProTable 等）提效但避免过度依赖默认模板

---

## Task 12: 应用插件子页面动态挂载机制 + 渲染进程插件 UI 沙箱
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 5 (插件系统), Task 10 (UI 基座)
- **Description**:
  - 插件 manifest type=app → 存在 `renderer` 字段指向子页面入口
  - 安装时：`loader` 编译 app 插件的 renderer 代码为单一 UMD bundle（使用 esbuild 在运行时或安装时一次性编译）
  - `src/renderer/src/pages/app-plugins/[pluginId].tsx`：路由占位页，通过 `React.lazy + import(/* webpackIgnore: true */ url)` 动态加载插件 bundle
  - 插件 UI 沙箱：Shadow DOM 隔离 CSS；props 传入受控 HostUIApi（readPluginState / callPluginMainAction / navigate），禁止访问主应用全局状态
  - 插件卸载后自动清理路由缓存与 Shadow DOM
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `rule` TR-12.1: 打开 app-demo 插件子页面 → URL 切换到 `/app-plugins/com.fmb.demo.app`；页面 ShadowRoot 内部渲染其 Hello 组件；主应用样式（如 body {margin:0}）不影响插件内自定义元素样式
  - `rule` TR-12.2: app 插件调用 `hostUIApi.callPluginMainAction('echo', 'hi')` → 底层走 IPC → main 端调用插件的 main 模块 echo 方法 → 插件 UI 收到 return='hi'
  - `rule` TR-12.3: 卸载 app 插件后手动访问 URL → 路由返回 404 页，无残留渲染
- **Notes**: UI 隔离是关键，用 Shadow DOM + CSS custom properties 共享主题色即可

---

## Task 13: 系统托盘 + 关闭隐藏 + Windows Toast 通知
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 10
- **Description**:
  - `src/main/tray/index.ts`：Electron Tray（默认 16x16 图标）+ 菜单：打开主界面 / 暂停所有任务 / 恢复 / 查看日志 / 退出
  - 主窗口 close 事件：默认 `event.preventDefault() + hide()`（设置里"关闭窗口→退出"可关）
  - `src/main/notify/index.ts`：封装 Notification 服务；订阅 errorLog.newEntry + workflow.afterExecute(failed) 触发 Toast；设置页按级别开关
- **Acceptance Criteria Addressed**: FR-1.6, FR-7.5
- **Test Requirements**:
  - `rule` TR-13.1: 点击窗口 X 按钮 → 窗口消失；任务管理器中进程仍存在；托盘右键"打开主界面"→ 窗口重现
  - `rule` TR-13.2: 手动 `errorCalendar.log({level:'error', ...})` → 10s 内 Windows 通知中心出现 Toast（需开启通知权限）
  - `rule` TR-13.3: 托盘点"退出"→ `app.quit()` 触发；所有进程正确释放无僵尸进程
- **Notes**: 若 Electron 原生 Notification 失败则降级 HTML 通知；不引入 COM 依赖的 Action Center

---

## Task 14: CLI 实现（commander.js）fmb 命令 8 组 + 进程间通信通道
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 5~9 (核心服务)
- **Description**:
  - 安装 `commander`
  - `src/cli/index.ts`：编译为独立可执行入口；打包后通过 `electron-builder extraMetadata` 暴露 `bin: {fmb: dist/cli.js}`
  - 命令组：
    - `fmb plugin list / install <zip> / uninstall <id> [--version] / enable <id> / disable <id> / switch <id> <version>`
    - `fmb workflow list / get <id> / run <id> [--input JSON] [--format json|table] / export <id> / import <file> / delete <id>`
    - `fmb schedule list / add --cron|--at --workflowId / remove <id> / pause <id> / resume <id>`
    - `fmb queue stats / retry-dead / clear-dead / list [--status]`
    - `fmb error list [--level] [--from --to] / resolve <id> / ignore <id>`
    - `fmb logs tail [--lines N] [--level]`
    - `fmb status`（健康检查）
    - `fmb plugin init --type atomic|app|extension <name>`（脚手架，S-8 可延后，此处一并实现）
  - CLI ↔ 运行中基座通信：查找 userData 下 `fmb.sock`（Windows 命名管道或本地 HTTP），若基座未运行则启动静默基座 + 重试连接
- **Acceptance Criteria Addressed**: AC-10
- **Test Requirements**:
  - `rule` TR-14.1: 基座运行中 + 工作流 wf-001 存在 → `fmb workflow run wf-001 --input '{}' --format json | jq .status` 输出 "success"；退出码 0
  - `rule` TR-14.2: `fmb plugin install <valid.zip>` → 表格输出新插件 ID / 名称 / 版本；`fmb plugin list` 包含该条
  - `rule` TR-14.3: 未启动基座执行 `fmb status` → 自动拉起基座；5s 后 status 返回 version + uptime
- **Notes**: 参考 AAS Skill `agent-tool-builder` 设计输入输出（减少 Agent 解析歧义）

---

## Task 15: Localhost HTTP API（hono + zod + Swagger UI + Bearer Token）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 5~9
- **Description**:
  - 安装 `hono` `@hono/swagger-ui` `@hono/zod-openapi`
  - `src/main/http/index.ts`：app.onReady 后启动，监听 `127.0.0.1:<port>` 默认 18765，仅绑定回环地址（不暴露局域网）
  - 路由（namespace `/api/v1`）：
    - `GET  /health` → 版本、uptime、active_workers
    - `GET  /openapi.json` + `GET /docs`（Swagger UI）
    - 插件：`GET/POST /plugins`, `PATCH /plugins/:id`, `POST /plugins/:id/actions/{enable,disable,switch-version}`
    - 工作流：`GET/POST /workflows`, `GET/PUT/DELETE /workflows/:id`, `POST /workflows/:id/runs` → 执行并返回 run_id；`GET /workflows/:id/runs`, `GET /runs/:runId`
    - 定时任务：`GET/POST /schedules`, `PATCH/DELETE /schedules/:id`, `POST /schedules/:id/actions/{pause,resume}`
    - 队列：`GET /queue/stats`, `GET /queue/jobs`, `POST /queue/actions/retry-dead`, `POST /queue/actions/clear-dead`
    - 错误：`GET /errors`, `PATCH /errors/:id`（resolve/ignore）
    - `POST /rpc`（JSON-RPC 2.0 batch 入口，Agent 一次性调用多个）
  - 鉴权：Bearer Token 从 settings 读取，首次启动自动生成 32 字节随机值存 `secrets` 表；`GET /health` 例外免鉴权
- **Acceptance Criteria Addressed**: AC-11
- **Test Requirements**:
  - `rule` TR-15.1: 未带 Token `POST /api/v1/workflows/xxx/runs` → HTTP 401；带正确 Token 相同请求 → 201 + JSON 含 run_id
  - `rule` TR-15.2: `GET /api/v1/openapi.json` 能被 Swagger UI 成功解析（无 schema 错误）；所有 8 类资源均有 path 定义
  - `rule` TR-15.3: JSON-RPC batch `[{"jsonrpc":"2.0","method":"health","id":1},...]` → 响应数组长度匹配，每 id 对应
  - `rubric` TR-15.4: Agent 调用体验（agent-tool-builder 标准）；scale 1-5; 1=字段模糊/大小写混乱/无示例 3=基本可用但错误信息差 5=每个 endpoint 含 schema 示例/错误响应结构化/幂等/返回 run_id 便于轮询; threshold >= 4; evidence: Swagger UI 导出文档质量抽查

---

## Task 16: 三类 Demo 插件开发 + zip 打包（验证插件系统与集成）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 5, Task 12
- **Description**:
  - 每个插件目录包含：`manifest.json`, `main.ts`, （app 类型多 `renderer/`）
  - 编写插件打包脚本 `scripts/package-plugin.ts`：tsc + esbuild → 产物目录 → 压缩为 `<id>@<version>.zip` 输出到 `plugins-dist/`
  - **atomic-demo**（plugins-source/atomic/demo-echo/）：一个 action=`echo`，返回 input；另一个 action=`crashMe`，无条件抛 Error（用于 AC-14 测试）
  - **app-demo**（plugins-source/app/demo-counter/）：依赖 atomic-demo；renderer 是一个 +1/-1 Counter，按钮点击时通过 HostUIApi 调 main action → main 里再调 atomic-demo echo 确认双向通信；manifest 声明 permissions: `workflow:execute`
  - **extension-demo**（plugins-source/extension/demo-install-notify/）：声明订阅 `plugin.afterInstall`，handler 写一条 warn 级日志到自定义表 `ext_demo_logs`（需要在插件 activate 时调用 db createTableIfNotExists 或改走 extension_metadata kv 存储）
  - 产出 3 个 zip 包并放 `plugins-dist/` 提供给 AC 测试
- **Acceptance Criteria Addressed**: AC-2, AC-9, AC-14
- **Test Requirements**:
  - `rule` TR-16.1: 3 个 zip `unzip -l` 检查均含 manifest.json + 入口文件；插件安装器全部接受安装
  - `rule` TR-16.2: 用 atomic-demo crashMe action 构造工作流节点 → 节点 failed；主进程不崩；整个工作流失败状态正确写入 DB
  - `rule` TR-16.3: 安装任意新插件 → extension-demo 的表/存储新增一条含 traceId 记录
- **Notes**: Demo 插件代码同时**作为**插件开发者的最小示例 README 内嵌注释说明

---

## Task 17: 生成 AGENTS.md + 项目开发规范文档 + 插件开发者文档（内嵌设置页）
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 1~16（完成后代码结构稳定）
- **Description**:
  - 使用 AAS Skill `agents-generator` 分析代码生成根目录 `AGENTS.md`：
    - 项目结构总览、关键模块入口、技术栈、常用命令（dev/build/typecheck/package-plugin）、约定（IPC 命名、zod schema 放 shared、禁止硬编码路径等）、调试方法（electron-vite --inspect）、文件新增命名约定
  - `docs/plugin-dev.md`：
    - 三类插件生命周期、manifest 字段说明、权限列表、HostApi 全量签名、Demo 插件链接、package-plugin 脚本用法
  - 设置页新增 "开发者 → 插件 API 文档" 内嵌渲染 docs/plugin-dev.md（安装 `react-markdown`）
- **Acceptance Criteria Addressed**: AC-13, NFR-2
- **Test Requirements**:
  - `rule` TR-17.1: 根目录 `AGENTS.md` 文件存在且 ≥ 800 字；含章节：目录结构 / 启动调试 / 常用命令 / 约定规则
  - `rule` TR-17.2: 设置页打开插件 API 文档 → Markdown 正常渲染，代码块高亮；标题清单包含 manifest、权限、HostApi、生命周期 4 节
  - `rubric` TR-17.3: AGENTS.md 对 Agent 的有用性；scale 1-5; 1=完全是废话 3=基本信息齐全但无调试指引 5=Agent 仅凭 AGENTS.md 就能 `pnpm dev` 启动、找到添加新拓展点的代码路径、写出一个最小插件; threshold >= 4; evidence: 模拟一个不了解项目的 Agent 基于文档可完成 echo 插件新增自测
- **Notes**: 这一步必须在代码结构稳定后做，否则生成的 AGENTS.md 很快过时

---

## Task 18: electron-builder 配置 + Windows NSIS 安装包 + Portable 构建验证
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1~16（代码冻结前至少能构建通过）
- **Description**:
  - 安装 `electron-builder` `-D`
  - 根目录 `electron-builder.yml`：
    - appId: `com.fairymaidbrigade.app`
    - productName: `Fairy Maid Brigade`
    - directories.output: `dist/`
    - win.target: nsis + portable
    - nsis: oneClick=false, allowToChangeInstallationDirectory=true, perMachine=false, createDesktopShortcut=true, createStartMenuShortcut=true
    - files: include dist-electron 输出；extraResources: plugins-dist 内置 3 Demo zip 随包
    - artifactName: "${productName} ${version} ${arch}.${ext}"
  - 图标：用 scripts 脚本生成临时 placeholder icon.ico（后续可替换品牌图标）
  - 执行 `pnpm build:win` 验证
- **Acceptance Criteria Addressed**: AC-12
- **Test Requirements**:
  - `rule` TR-18.1: `pnpm build:win` 退出码 0；`dist/` 下产出 2 个文件：Setup.exe（≥80MB）与 portable.exe（≥80MB）
  - `rule` TR-18.2: portable.exe 双击可直接启动（无需安装）；主界面 3s 内渲染
  - `rule` TR-18.3: Setup.exe 向导安装到 `%LocalAppData%\Programs\Fairy Maid Brigade\`；桌面快捷方式可启动；卸载程序能在"应用和功能"中找到
- **Notes**: 首次构建会下载 Electron 二进制，需稳定网络；如遇机器无签名证书则 NSIS 安装器会出现 Windows SmartScreen 警告（可接受，非 bug）

---

## Task 19: 故障注入测试与健壮性验证（AC-14 rubric 证据）
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 5, Task 6, Task 8, Task 9
- **Description**:
  - 编写 `scripts/fault-injection.test.ts`（vitest 或 node 脚本），覆盖：
    1. 插件 activate 中抛 uncaught → 沙箱被销毁；主进程继续运行；错误日志落库
    2. 插件运行时 worker_thread 崩溃（进程 kill）→ 队列该 job 标记 failed，重试策略生效
    3. 事件总线第 2/5 订阅者抛错 → 其余 1,3,4 正常执行；影响范围隔离
    4. DB 写入磁盘满（模拟）→ 错误捕获、不 white-screen，设置页提示
    5. HTTP API 恶意超大 JSON payload → hono bodyLimit 返回 413，服务不崩
  - 记录每次测试结果为 rubric AC-14 证据
- **Acceptance Criteria Addressed**: AC-14
- **Test Requirements**:
  - `rule` TR-19.1: 5 项故障注入全部执行完毕，主进程 pid 始终不变（仅非预期退出会换 pid）
  - `rubric` TR-19.2: 同 AC-14 直接打分；此处产出实际评分与 rationale；evidence 为 fault-injection.test.ts 输出日志
- **Notes**: 若机器无 vitest 环境则用 Node.js 原生 assert + child_process 自实现

---

## Task 20: 端到端全量自检脚本（一键验证 AC-1~AC-12 rule 全部满足）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 18 构建完成
- **Description**:
  - `scripts/self-check.ps1`（PowerShell，Windows 第一版）执行：
    1. 启动 portable exe（带 --self-check 标志，自动启动后执行以下脚本）
    2. 通过 HTTP API 按顺序调用：health → 安装 3 Demo 插件 → 创建 echo 工作流 → 添加 cron 每分钟任务 → 并发 5 job 入队 → 等待 → 查询 error_logs 条数 → 插件回滚 → 调 CLI workflow run → 调 HTTP 鉴权 + 未鉴权对比 → 退出
    3. 每一步输出 PASS/FAIL + 用时；全部通过时退出码 0；任何失败立即打印 FAIL 并退出码 1
  - 产出 self-check-report.log 作为所有 rule AC 的统一 Completion Evidence
- **Acceptance Criteria Addressed**: AC-1~AC-12
- **Test Requirements**:
  - `rule` TR-20.1: `.\scripts\self-check.ps1` 在干净 Windows 用户环境下执行时间 ≤ 90s；最后一行输出 "ALL 12 AC PASSED"；$LASTEXITCODE = 0
- **Notes**: 此脚本同时是 Review 阶段独立审核的核心证据来源
