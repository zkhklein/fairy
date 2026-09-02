# FMB Watchers Suite（值守套件）

> 后台值守类插件集合：一个 App 插件 `com.fmb.watchdog`（左栏 Switch 子页面 + 调度器注册）+ 两个 Atomic 插件 `com.fmb.watcher.traework` / `com.fmb.watcher.chatgpt`（查进程 + 不在则重启，**永不打扰正在运行的实例**）。

## 目录（未来可作为独立 Git 仓直接迁移）

```
watchers/                           ← 未来独立仓的根
├─ package.json                     ← suite 元数据、含插件清单
├─ README.md                        ← 本文件
├─ app/
│  └─ fmb-watchdog/
│     ├─ manifest.json              ← com.fmb.watchdog (type=app, renderer=有)
│     ├─ main.ts                    ← 开关读/写 KV + 创建/删除两个 cron Schedule + readinessCheck
│     └─ renderer/index.ts          ← 两个 Switch 的 Shadow-DOM 子页面
└─ atomic/
   ├─ fmb-watcher-traework/
   │  ├─ manifest.json              ← com.fmb.watcher.traework
   │  └─ main.ts                    ← check() + ensureRunning()
   └─ fmb-watcher-chatgpt/
      ├─ manifest.json              ← com.fmb.watcher.chatgpt
      └─ main.ts                    ← check() + ensureRunning()
```

## 插件依赖关系

```
com.fmb.watchdog (app)
  └─ requires: com.fmb.watcher.traework ^0.1.0
  └─ requires: com.fmb.watcher.chatgpt ^0.1.0
```

`watchdog` 作为 app 插件创建两条工作流 + 两个 `*/2 * * * *`（每 2 分钟）调度，对应执行两个 atomic 的 `ensureRunning`。用户在 app 页切 Switch 时：
- `ON` → 存在则不创建（幂等），不存在则 `host.workflows.create` + `host.schedules.create(..., cron='*/2 * * * *')` 并启动调度
- `OFF` → 把对应 schedule `toggle(id, false)` 或删除（保留 workflow，下次开只需要再建/启用调度）

## 绝不打扰正在运行的软件

两个 atomic 都严格遵守：

1. **先 `hostApi.processes.query([processName])`** 看是否在运行
2. 只有 `false` 时才调 `hostApi.processes.start(executablePath)`
3. `start` 永远是 `detached: true` + `unref()` 模式，外部程序生命周期**不绑定** FMB
4. 如果 executablePath 没配置 → 跳过启动，并把 `needSetup=true` 返回给 UI，UI 让用户手动填可执行文件完整路径（KV 存）

## Windows 软件的默认候选路径

`ensureRunning` 会按顺序尝试以下常见安装位置（64bit/32bit）：

- **TraeWork**：`%LOCALAPPDATA%\Programs\Trae\Trae.exe` → `%PROGRAMFILES%\Trae\Trae.exe` → `%PROGRAMFILES(X86)%\Trae\Trae.exe`
- **ChatGPT**：`%LOCALAPPDATA%\Programs\chatgpt\ChatGPT.exe` → `%PROGRAMFILES%\chatgpt\ChatGPT.exe` → `%PROGRAMFILES(X86)%\chatgpt\ChatGPT.exe`

用户可以在 UI 上点击 “修改路径” 自行覆盖（KV `execPath:traework` / `execPath:chatgpt`）。

## 权限清单

| 插件 | 权限 |
|---|---|
| watchdog (app) | `log:write` `kv:read` `kv:write` `plugins:read` `workflows:create` `schedules:create` |
| watcher-traework (atomic) | `log:write` `kv:read` `kv:write` `system:process:read` `system:process:start` |
| watcher-chatgpt (atomic) | `log:write` `kv:read` `kv:write` `system:process:read` `system:process:start` |
