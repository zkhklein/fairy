# Fairy Maid Brigade - 产品需求文档 (PRD)

## Overview
- **Summary**: 一款跨 PC 端（第一版 Windows、设计兼容 Mac/Linux）的插件式软件间协作工作流平台基座。通过三类插件（原子能力、应用、拓展）将软件协作流程固化为可复用工作流，同时提供 CLI 与本地 HTTP API，便于用户与 AI Agents 高效调用。
- **Purpose**: 解决"多软件串联操作重复性高、难以自动化、Agent 调用接口不统一"的痛点，提供高通用性、Agent 友好的桌面平台。
- **Target Users**: 个人生产力用户、AI Agent 开发者、自动化工作流构建者。

## Goals
- G1: 提供稳定的桌面端基座外壳（主界面 + 应用插件子页面）
- G2: 实现三类插件（原子/应用/拓展）的加载、版本管理、沙箱隔离与生命周期管理
- G3: 内置六大核心能力：工作流组织、定时任务、工作队列与并发控制、错误日历与记录、事件总线（核心拓展点）、插件版本管理
- G4: 暴露 CLI 命令与 Localhost HTTP API，Agent 可直接调用不经过 UI
- G5: 第一版 Windows 可运行安装包，架构设计保证 Mac/Linux 迁移无硬障碍

## Non-Goals
- NG1: 第一版**不**提供云端同步、多端协作（纯本地）
- NG2: 第一版**不**提供可视化拖拽工作流编辑器（仅支持 JSON/YAML DSL 导入导出与表格化管理）
- NG3: 第一版**不**构建插件市场 Web 服务（仅支持本地目录 + Git 仓库两种插件源）
- NG4: 第一版**不**打包 Mac/Linux 安装包（但代码保留跨平台兼容：路径用 path.join、避免 Win32 API）
- NG5: **不**包含移动端（iOS/Android）版本
- NG6: **不**内置任何垂直业务插件（仅提供 Demo 级别插件用于验证）

## Background & Context
- 项目名称：**Fairy Maid Brigade**（妖精女仆团）
- 项目目录约定：
  - `src/` — 源码（主进程 + 渲染进程 + shared）
  - `dist/` — 编译产物（Electron 打包输出、安装包）
  - `plugins-source/` — 插件源码（atomic/app/extension 三子目录）
  - `plugins-dist/` — 插件产物（.zip 压缩包）
- GitHub 地址：`git@github.com:zkhklein/fairy.git`
- 插件设计理念：三类插件各司其职
  - **原子能力插件 (atomic)**：单一能力，无 UI 子页面
  - **应用插件 (app)**：由 ≥1 个原子能力插件 + 自身逻辑组成，**唯一**对应一个应用子页面
  - **拓展插件 (extension)**：挂载到核心拓展点（钩子），横向增强基座功能

## 功能需求补充与优化建议（基于原始需求的增补项）
> 原始需求已包含 6 项功能（工作流组织、定时任务、工作队列并发、错误日历、事件总线、插件版本管理）。以下为建议新增功能，请用户确认是否纳入第一版范围。

### S-1（建议加入）: 插件沙箱与权限控制
- 问题：插件压缩包来源不确定，直接执行存在安全风险
- 方案：基于 `node:vm` + Electron `contextIsolation` 构建插件沙箱；`manifest.json` 声明权限列表（fs:read、net:http、workflow:execute 等），宿主校验后授予最小权限集

### S-2（建议加入）: 插件依赖声明与解析
- 问题：应用插件由原子能力插件组成，必须处理版本冲突
- 方案：`manifest.json` → `dependencies` 字段声明 semver 约束；插件管理器内置依赖解析，检测循环依赖与版本冲突并报错

### S-3（必须加入）: CLI + Localhost HTTP API（Agent 调用层）
- 理由：用户明确要求"其接口或能力应当能让你(Agents)直接调用"
- CLI 能力：plugin install/uninstall/list/enable/disable · workflow run/export/import/list · schedule add/list/remove/pause/resume · queue stats/retry · logs tail
- HTTP API：`hono` 监听 `127.0.0.1:<port>`，Bearer Token 鉴权，REST + JSON-RPC 双协议，完整映射 CLI 能力并返回结构化 JSON
- **这项对 Agent 开发体验是决定性的，强烈建议必须纳入第一版**

### S-4（建议加入）: 工作流上下文变量 + 密钥存储
- 问题：工作流节点间数据传递、敏感配置（API Key）不可明文入库
- 方案：运行时 Context 注入每个节点；敏感变量使用系统 keychain / 加密 SQLite 存储，内存中明文不落地

### S-5（建议加入）: 系统托盘 + 后台运行
- 问题：定时任务需要后台运行，关闭主窗口后进程不应退出
- 方案：Electron Tray 图标 + `close` → `hide`；托盘菜单提供"打开主界面/退出/查看日志/暂停所有任务"

### S-6（建议加入）: 通知中心 + Windows Toast
- 问题：工作流成功/失败、定时任务触发需要主动反馈
- 方案：集成 `electron-notifications` / 原生 Notification；错误日志新条目触发可选 Toast

### S-7（建议加入）: 审计日志
- 所有操作（安装插件、执行工作流、修改定时任务、API 调用）落库 `audit_logs`，支持筛选与导出

### S-8（建议延后 v1.1）: 国际化 i18n + 主题切换
- 中/英双语、深/浅色模式。影响范围大，可延后

---
> **以上 S-1 ~ S-7 建议全部纳入第一版范围；S-8 延后。以下技术选型与 AC 均以 S-1~S-7 纳入为假设。如用户有取舍，将回退 Specify 阶段调整。**

## Functional Requirements

### FR-1: 页面外壳（主界面 + 应用子页面）
- FR-1.1 主界面包含：左侧导航（Dashboard / 插件管理 / 工作流 / 定时任务 / 队列监控 / 错误日历 / 拓展点 / 设置），右侧内容区
- FR-1.2 Dashboard：运行中任务数、今日错误数、队列状态、最近执行记录卡片
- FR-1.3 插件管理：表格展示所有已装插件（ID、名称、类型、版本、状态、依赖），支持启用/停用/卸载/升级
- FR-1.4 应用插件点击后，路由切换到对应**应用子页面**（渲染进程动态挂载插件的 renderer 模块）
- FR-1.5 原子能力插件、拓展插件**不**对应子页面
- FR-1.6 系统托盘菜单；关闭主窗口 → 最小化到托盘不退出进程（设置项可配置）

### FR-2: 插件系统（三类插件）
- FR-2.1 支持从本地目录安装 `.zip` 插件包，按 `manifest.json` 识别类型
- FR-2.2 插件类型：atomic / app / extension
- FR-2.3 插件沙箱：独立 vm context，权限校验失败立即拒绝
- FR-2.4 依赖解析：安装前校验 `dependencies` 中所有原子能力插件是否已安装且满足 semver；冲突时阻止安装并给出具体冲突
- FR-2.5 插件生命周期：install → enable → disable → uninstall，每一步产出事件与审计日志
- FR-2.6 插件版本管理：多版本共存，可回滚到任意历史版本；语义化版本比较

### FR-3: 事件总线（核心拓展点）
- FR-3.1 内置 12+ 标准拓展点（app.onReady / plugin.afterInstall / workflow.beforeExecute / workflow.nodeError / schedule.triggered / queue.jobFailed / errorLog.newEntry / ui.mainMenu.render 等）
- FR-3.2 拓展插件通过 `manifest.extensionPoints[]` 声明挂载的点和 handler 方法名
- FR-3.3 事件支持通配符订阅（`workflow.*`）、异步 handler、错误隔离（单个扩展点异常不影响其他）
- FR-3.4 事件调用链可追踪（traceId）并写入审计日志

### FR-4: 工作流组织
- FR-4.1 工作流定义：JSON/YAML DSL，描述 DAG（节点 + 连线）
  - 节点类型：`atomic`（调用原子能力插件）、`condition`（条件分支）、`loop`（循环）、`subflow`（子工作流）、`delay`（等待）
- FR-4.2 工作流 CRUD：列表、详情、创建、编辑（JSON 编辑器）、导入/导出、复制、删除
- FR-4.3 工作流执行：手动点击执行 + API/CLI 调用 + 定时触发器 + 事件触发器
- FR-4.4 节点上下文：上一节点输出作为下一节点输入；支持全局变量与密钥注入
- FR-4.5 执行记录：每次运行写入 `workflow_runs`，包含节点粒度的状态、耗时、输入输出、错误堆栈
- FR-4.6 失败重试：节点级别重试策略（次数、退避算法）；支持手动重跑指定节点

### FR-5: 定时任务
- FR-5.1 支持 cron 表达式 + 一次性时间戳两种触发方式
- FR-5.2 任务绑定工作流，触发后自动入队执行
- FR-5.3 支持启用/停用/暂停；状态持久化到 SQLite，应用重启后自动恢复
- FR-5.4 下一次执行时间可视化；missed job 策略（run_now / skip / last_missed）

### FR-6: 工作队列与并发控制
- FR-6.1 基于 SQLite 的持久化队列（不依赖 Redis 等外部服务）
- FR-6.2 全局最大并发数（默认 4，可配置）；单工作流并发限制；优先级（0-9）
- FR-6.3 重试策略：固定间隔 / 指数退避；死信队列（超过最大重试次数的任务）
- FR-6.4 队列监控面板：等待中 / 执行中 / 已完成 / 失败 / 死信 数实时统计

### FR-7: 错误日历与记录
- FR-7.1 所有运行时错误（插件异常、工作流节点失败、队列 job 失败、定时任务 misfire）写入 `error_logs` 表
- FR-7.2 错误日历视图（月视图），每日错误数以热力图展示；点击日期查看当日错误列表
- FR-7.3 错误详情：时间、级别(error/warn)、来源（plugin id / workflow run id / queue job id）、堆栈、关联 traceId
- FR-7.4 错误筛选与标记：按来源/级别/时间筛选；标记为 resolved / ignored
- FR-7.5 Toast 通知（可按级别开关）

### FR-8: 插件版本管理
- FR-8.1 多版本共存（`plugins/<id>@<version>/` 目录结构）
- FR-8.2 版本切换：用户可切换到任意已安装历史版本，立即生效无需重启
- FR-8.3 插件元数据写入 `plugins` 表，包含安装时间、启用状态、当前版本、历史版本列表
- FR-8.4 从 Git 仓库更新：`plugins-source/<type>/<name>/` 读取 package.json 版本，若更新则重新打包为 .zip 并安装

### FR-9: CLI + Localhost HTTP API（Agent 友好层）
- FR-9.1 CLI：基于 `commander.js`，命令集覆盖 FR-2~FR-8 所有写操作与读操作
- FR-9.2 HTTP API：`hono` 监听 `127.0.0.1:18765`（默认端口可配置），Bearer Token 鉴权
- FR-9.3 健康检查端点 `GET /health` 返回基座版本、运行时间、活跃 worker 数
- FR-9.4 完整 OpenAPI 文档自动生成 `GET /openapi.json` + Swagger UI
- FR-9.5 所有操作写入审计日志（含来源 CLI/HTTP、调用者标识）

## Non-Functional Requirements

### NFR-1: 跨平台兼容性（Agent 开发友好）
- 代码中**严禁**出现 `\\` 硬编码路径，全部使用 `path.join()` / `path.resolve()`
- 主进程文件系统 API 统一封装在 `src/main/core/platform/`，屏蔽 Win/Mac 差异
- 配置存储：Electron `app.getPath('userData')`；日志：`logs/`；插件：`plugins/`
- Windows 特有功能（Toast 等）封装在 conditional 分支，Mac 环境优雅降级

### NFR-2: Agent 开发效率
- 前后端 100% TypeScript，`strict: true`
- 所有主/渲染/插件接口有完备 `.d.ts` 类型声明
- 自动生成 AGENTS.md（通过 AAS Skill `agents-generator`），写明项目结构、约定、常用命令
- 宿主暴露给插件的 API 文档自动生成并嵌入设置页
- 热重载：electron-vite HMR，主/渲染进程改动无需手动重启

### NFR-3: 性能与稳定性
- 冷启动时间（双击图标到主界面可交互）：≤ 3s
- 工作流节点调度延迟：≤ 100ms（非 IO 场景）
- 1000 条错误记录 + 50 个插件场景下，UI 切换无明显卡顿（单帧 ≤ 50ms）
- 单个插件 crash 不影响主进程（插件 worker 独立线程）

### NFR-4: 安全性
- 插件沙箱不可访问宿主 `require('fs')` 等原生模块，必须通过宿主授予的 Proxy API
- HTTP API Token 加密存储，首次启动自动生成随机 Token 写入配置
- 密钥变量：Windows 使用 `DPAPI`/`keytar` 加密；Mac 预留 Keychain 接口

### NFR-5: 可观测性
- 结构化日志（pino + JSON lines），分级 trace/debug/info/warn/error
- 日志轮转：按天切割，保留 30 天
- 审计日志完整保留 90 天（可配置）

## Constraints
- **Technical**:
  - T1: 前端 → React 18 + TypeScript + Vite 5 + electron-vite + Ant Design 5 + TailwindCSS + Zustand
  - T2: 主进程 → Node.js 20 LTS + TypeScript
  - T3: 数据库 → SQLite 3 + better-sqlite3 + Kysely（类型安全查询构建器）
  - T4: 事件总线 → EventEmitter2（通配符支持）
  - T5: 定时任务 → node-cron + SQLite 持久化
  - T6: 工作队列 → 自研持久化队列（SQLite）+ worker_threads 并发执行
  - T7: CLI → commander.js；HTTP API → hono + zod 校验 + @hono/swagger-ui
  - T8: 打包 → electron-builder（Windows NSIS 安装包 + portable exe）
  - T9: 插件加载 → `node:vm` 沙箱 + 动态 import()；清单 manifest.json（zod 校验）
  - T10: 日志 → pino + rotating-file-stream + electron-log 桥接
- **Business**:
  - B1: 第一版仅 Windows 打包验证通过
  - B2: 不提供任何收费功能/订阅服务
- **Dependencies**:
  - D1: GitHub 仓库 `git@github.com:zkhklein/fairy.git` 需本地可访问（或后续初始化）
  - D2: 开发环境需 Node.js ≥ 20、pnpm ≥ 9、Git

## Assumptions
- A1: 用户与 Agent 主要在 Windows 环境开发与使用第一版
- A2: 本地磁盘剩余空间 ≥ 2GB（Electron 打包缓存 + 安装包）
- A3: 插件作者遵循 manifest.json 规范，不尝试逃逸沙箱
- A4: 单机使用场景，不考虑多用户权限隔离

## Acceptance Criteria

### AC-1: 基座可启动并展示主界面
- **Type**: `rule`
- **Given**: Windows 环境安装完毕、首次启动
- **When**: 用户双击桌面快捷方式
- **Then**: 3s 内出现主界面窗口，左侧导航显示 Dashboard/插件管理/工作流/定时任务/队列监控/错误日历/拓展点/设置 8 项
- **Pass Condition**: 启动脚本 `pnpm start` 无 fatal error；主界面 8 项导航渲染；控制台无未捕获异常
- **Evidence**: 启动日志 screenshot + DevTools Console 截图

### AC-2: 插件系统可安装并运行三类插件
- **Type**: `rule`
- **Given**: 基座运行中，三个 Demo 插件 zip 包已准备（atomic-demo / app-demo / extension-demo）
- **When**: 插件管理页 → 安装插件 → 依次上传三个 zip → 启用
- **Then**: (a) atomic-demo 列表可见但无"打开子页面"按钮；(b) app-demo 列表可见并出现"打开"按钮，点击后加载其独立子页面；(c) extension-demo 挂载到 `ui.mainDashboard.card` 后 Dashboard 出现其注入的卡片
- **Pass Condition**: 插件表中 3 条记录状态=enabled；打开 app-demo 子页面正常渲染；Dashboard 注入卡片存在
- **Evidence**: 插件管理表格截图 + app-demo 子页面截图 + Dashboard 新卡片截图

### AC-3: 插件权限沙箱生效
- **Type**: `rule`
- **Given**: 一个未声明 `fs:write` 权限的恶意插件尝试写入 `C:\\Windows\\System32\\test.txt`
- **When**: 安装并启用该插件、触发其写文件操作
- **Then**: 宿主拦截并抛出 PermissionDenied 错误；目标文件不存在；错误日历新增 1 条 warn 级记录
- **Pass Condition**: `error_logs` 表中存在来源=该插件 id 的 PermissionDenied 条目；System32 下无 test.txt
- **Evidence**: 错误日志条目 + 审计日志条目 + 文件系统检查输出

### AC-4: 工作流可定义并手动执行
- **Type**: `rule`
- **Given**: 已安装 1 个原子能力插件（`atomic-echo`：将输入字符串原样返回）
- **When**: 工作流页 → 新建工作流 JSON：2 个 echo 节点串联，输入 `"hello"`；点击执行
- **Then**: `workflow_runs` 表新增 1 条 status=success；节点 1 输出="hello"，节点 2 输出="hello"；执行耗时字段非空
- **Pass Condition**: DB 查询 `SELECT status, duration_ms FROM workflow_runs ORDER BY id DESC LIMIT 1` 返回 success；节点输出与预期一致
- **Evidence**: 执行详情页截图 + SQLite 查询结果

### AC-5: 定时任务按 cron 触发工作流
- **Type**: `rule`
- **Given**: 工作流 A 已存在；cron=`* * * * *`（每分钟）绑定到工作流 A
- **When**: 等待 ≥ 70s（跨越 2 个分钟边界）
- **Then**: `workflow_runs` 表新增 ≥ 2 条由 schedule 触发的记录；触发时间差 ≈ 60s（±5s）
- **Pass Condition**: `SELECT trigger, COUNT(*) FROM workflow_runs WHERE trigger='schedule' AND created_at > datetime('now','-2 minutes')` 返回 COUNT ≥ 2
- **Evidence**: 定时任务执行记录列表 + 时间戳比对

### AC-6: 工作队列并发控制生效
- **Type**: `rule`
- **Given**: 全局最大并发数=2；创建 5 个工作流（每个内部 delay 3s）几乎同时入队，优先级一致
- **When**: 观察 10s 内执行时间线
- **Then**: 同一时间执行中的任务数 ≡ ≤ 2；总耗时 ≈ ceil(5/2) × 3s = 9s（±1s）
- **Pass Condition**: 队列监控图表显示 running 曲线不超过 2；完成时间在 [8s, 11s] 区间
- **Evidence**: 队列监控截图 + 5 条记录的 start_time / end_time 数据表

### AC-7: 错误日历可展示与筛选
- **Type**: `rule`
- **Given**: 过去 7 天内人为制造 3 条 error、5 条 warn
- **When**: 打开错误日历页 → 切换月视图 → 点击有错误的日期
- **Then**: 对应日期格显示 8 条标记；点击后详情列表展示 8 条记录；筛选器选择 level=error 后剩余 3 条
- **Pass Condition**: 日历热力图 DOM 中 3+ 错误单元格高亮；筛选后数量正确
- **Evidence**: 错误日历月视图截图 + 筛选后列表截图

### AC-8: 插件版本回滚功能可用
- **Type**: `rule`
- **Given**: 插件 P 已安装 v1.0.0（echo 返回 "v1"）→ 升级 v1.1.0（echo 返回 "v2"）；两个版本共存
- **When**: 插件管理 → 切换版本 → 选 v1.0.0 → 确认；执行使用 P 的工作流
- **Then**: 执行结果="v1"；`plugins` 表 current_version=1.0.0；审计日志记录 version_rollback 事件
- **Pass Condition**: DB 版本字段正确；执行输出正确；审计日志条目存在
- **Evidence**: 版本切换前后截图 + 审计日志条目

### AC-9: 事件总线拓展点可被 extension 插件订阅
- **Type**: `rule`
- **Given**: extension-demo 插件声明订阅 `plugin.afterInstall`，触发后写入 `extension_demo_logs` 表
- **When**: 安装任意新插件
- **Then**: `extension_demo_logs` 新增 1 行，含 traceId、新插件 id、时间戳；同一事件其他 handler 不受影响
- **Pass Condition**: 表记录存在；事件发射器内部计数正常
- **Evidence**: extension_demo_logs 查询结果 + 事件日志 traceId 链路

### AC-10: CLI 可直接执行工作流
- **Type**: `rule`
- **Given**: 工作流 W id=wf-001 已存在；基座进程运行中
- **When**: 执行命令 `fmb workflow run wf-001 --input '{"k":"v"}' --format json`
- **Then**: stdout 输出合法 JSON，含 run_id、status=success、output、duration_ms；CLI 退出码=0
- **Pass Condition**: `$LASTEXITCODE -eq 0`；stdout 可被 `jq .status` 解析为 "success"
- **Evidence**: PowerShell 命令执行截图 + 输出 JSON

### AC-11: HTTP API 可直接执行工作流并通过鉴权
- **Type**: `rule`
- **Given**: 基座 HTTP 服务运行在 127.0.0.1:18765；Token=T；工作流 W id=wf-001
- **When**: `curl -H "Authorization: Bearer T" -X POST http://127.0.0.1:18765/api/v1/workflows/wf-001/runs -d '{"input":{}}'`
- **Then**: HTTP 201；返回 JSON 含 run_id；未携带 Token 的相同请求返回 401
- **Pass Condition**: 响应码正确；响应 JSON schema 合法；审计日志来源=HTTP 条目存在
- **Evidence**: curl 命令输出 2 组（带Token / 不带Token）

### AC-12: 打包生成 Windows 可用安装包
- **Type**: `rule`
- **Given**: 源码编译无错误
- **When**: 执行 `pnpm build:win`（electron-builder --win nsis portable）
- **Then**: `dist/` 目录下产出 `Fairy Maid Brigade Setup 0.1.0.exe`（NSIS 安装包）与 `Fairy Maid Brigade 0.1.0.exe`（便携版）
- **Pass Condition**: 两个文件存在且大小 ≥ 80MB（Electron 合理范围）；在新 Windows 用户双击安装包可完成安装并启动
- **Evidence**: dist 目录截图 + 在干净虚拟机/另一台机器安装成功截图（若环境有限则至少构建产物存在 + 本地 portable 启动成功）

### AC-13: Agent 开发体验 - 代码完整度与类型覆盖
- **Type**: `rubric`
- **Dimension**: TypeScript 类型覆盖率与架构清晰度
- **Scale**: 1-5
- **Anchors**: 1 = 大量 any、无 shared 类型定义、主/渲染通信混乱；3 = shared 类型存在但部分接口缺失文档，模块边界模糊；5 = strict 模式无 any、IPC 完整 zod 校验、shared/types 覆盖 100% 跨进程通信契约、模块单一职责清晰
- **Pass Threshold**: >= 4
- **Evidence**: 全局 `tsc --noEmit` 结果（0 error）+ 关键模块文件抽查

### AC-14: 错误隔离健壮性
- **Type**: `rubric`
- **Dimension**: 单点异常对整体可用性影响
- **Scale**: 1-5
- **Anchors**: 1 = 单个插件崩溃导致白屏或主进程退出；3 = 插件崩溃不影响主进程，但会中断当前所有工作流；5 = 插件崩溃隔离到 worker，仅影响所在工作流单节点，重试后可恢复；事件总线扩展点异常不影响其他订阅者
- **Pass Threshold**: >= 4
- **Evidence**: 故障注入测试报告（故意抛异常 5 处，验证隔离效果）

## Open Questions
- [ ] Q1: S-3（CLI + HTTP API）是否确认**必须**纳入第一版？（强烈建议必须）
- [ ] Q2: S-4（密钥加密存储）是否使用 `keytar` 依赖系统 keychain，还是接受"SQLite + 用户密码加密"方案？
- [ ] Q3: S-6 通知中心是否需要接入 Windows 原生 Action Center（需要额外 COM 组件，复杂度较高），还是接受 Electron 自带 HTML 通知？
- [ ] Q4: 插件包除了 .zip，是否需要第一版即支持从 Git URL / npm 私有注册表直接安装？
- [ ] Q5: 基座与 Agent 通信除了 CLI + HTTP，是否需要预留 stdin/stdout JSON-RPC（便于直接被宿主 IDE 的 AI Agent 子进程 spawn）？
- [ ] Q6: 第一版是否需要内置"插件创建脚手架"命令 `fmb plugin init --type atomic my-plugin`？
