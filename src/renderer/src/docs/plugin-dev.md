# 插件开发者指南（Fairy Maid Brigade）

> FMB 的一切外部能力都通过插件接入。本指南覆盖三类插件的生命周期、manifest 字段、权限列表、HostApi 全量签名、打包脚本用法与 Demo 插件链接。

---

## 1. 三类插件一览

| 类型 | 说明 | 典型用途 |
|---|---|---|
| **atomic** | 纯后端：暴露一个或多个可被工作流调用的 action；无 UI | 某个动作 = 一个工作流节点（调用 HTTP 接口、解析 JSON、发消息）|
| **app** | 后端 + 前端：在 UI 里分配一个子页面 `/app-plugins/:pluginId`，可与 main action 双向通信 | 自定义管理台、数据看板、被编排软件的可视化配置 |
| **extension** | 纯后端：**订阅**宿主/其他插件广播的扩展点（事件），无 action，不被调用 | 审计落库、告警、安装通知、跨插件编排链 |

**一条黄金法则**：插件永远跑在 **vm 沙箱** 里（T5），`require()` 被彻底禁止；所有 IO 必须通过 `hostApi`（下文 §6）。manifest.permissions 决定你能调用 hostApi 的哪些方法，缺权限调用会抛 `Permission denied`。

---

## 2. 插件目录布局

```
my-plugin/
├─ manifest.json   # 必须
└─ main.ts         # 必须（编译后成 main.js，沙箱载入）
# type=app 多一个 renderer：
└─ renderer/
   └─ index.ts     # 或 index.tsx；manifest.renderer 指这里
```

安装包形态是一个 zip，zip 内必须有：`manifest.json`、`main.js`，以及 type=app 时附带 `renderer.umd.js`。安装器会校验 manifest（Zod），失败则回滚。

---

## 3. Manifest 字段说明

示例见 §7 Demo 插件的 3 个 `manifest.json`。字段如下：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | `reverse-DNS` 风格唯一 ID，如 `com.acme.todo`；不可冲突 |
| `name` | string | ✅ | UI 显示名 |
| `version` | string | ✅ | 语义化版本 (semver)；基座支持同 ID 多版本并存 + 随时切换 |
| `type` | `"atomic"` \| `"app"` \| `"extension"` | ✅ | 三类之一 |
| `description` | string | ✅ | 一段话，UI 展示 |
| `permissions` | string[] | 否 | 权限数组，见 §5；缺省 = 空数组（只能用 activate/deactivate）|
| `dependencies` | `{ [id]: semver-range }` | 否 | 依赖的其他插件；启用前会先启用依赖；未满足则拒绝启用 |
| `main` | string | ✅ | 指向 zip 根下的 main 入口（`.js`）|
| `renderer` | string | type=app 必填 | 指向 app 插件的渲染入口（开发态 `.ts/.tsx`，打包后改填 `renderer.umd.js`）|
| `extensionPoints` | `"<point>::<handler>"[]` | 否 | 订阅列表；格式 `事件点::导出名`；type=extension 建议必填，atomic/app 可选 |
| `assets` | string[] | 否 | 未来支持；目前预留 |

**`extensionPoints` 语法细则**：
- `"demo.echo::echo"` — 当宿主 emit `demo.echo` 时，调用 `exports.echo(payload)`
- 省略 `::<handler>` 等价于 `::default`，但建议显式写
- 事件点名必须已在 `src/shared/extension-points.ts` 注册；未知事件点在 enable 时被 warn 并跳过

---

## 4. 生命周期

插件在 FMB 里会经历 5 个阶段：

```
  install  →  installed  →  enable  →  enabled (loadedInstance)
                                  \        ↕ work node 调用、扩展点触发
                                   ↓
                              disable  →  uninstall
```

1. **install**：`fmb plugin install <zip>` 解压到 `<pluginsDir>/<id>@<version>/`，manifest 校验 + 冲突检查。写 `plugins` + `plugin_versions` 表。
2. **enable**：调用 `exports.activate(ctx)`；把 extensionPoints 逐个 `bus.on(...)`；写入 `loadedInstances`。对 app 插件如果还没有预编译 bundle，则调用 esbuild 现场编译 renderer。
3. **运行中**：
   - atomic 动作 = 工作流节点（`callAction(pluginId, actionName, payload)` → `exports[actionName](payload)`）
   - extension 动作 = 事件总线 `emit` → 你声明的 handler 被触发
   - app 动作 = 渲染层 HostUIApi → IPC → main action（双向通信）
4. **disable**：`bus.off` 解绑所有订阅；调用 `exports.deactivate()`；删除 loadedInstances；
5. **uninstall**：删除版本目录 + DB 行（当前版本且启用中则先 disable）。

**activate / deactivate 签名**：

```js
module.exports = {
  activate(ctx) {
    // ctx = { pluginId, version, hostApi }。
    // ctx.hostApi 与全局变量 hostApi 是同一个对象（permission-wrapped）。
  },
  deactivate() {
    // 释放 socket、关闭定时器、flush 队列。
  },
};
```

---

## 5. 权限列表

| 权限 | 能做什么 |
|---|---|
| `log:write` | `hostApi.logger.trace/debug/info/warn/error/fatal`；每一条都写到 DB 的 error_logs（按级别过滤）|
| `audit:write` | `hostApi.audit.record(event, data)`；写 audit_logs 表，附带 traceId + userId=pluginId |
| `kv:read` | `hostApi.kv.get(key)`；插件作用域隔离的 kv_store |
| `kv:write` | `hostApi.kv.set/delete(key, value)` |
| `db:read` | `hostApi.db.query(sql, params)`；只读 DB（SELECT only，其他权限错误）|
| `db:write` | 未来支持；当前沙箱未暴露 |
| `event:subscribe` | 订阅自己 manifest 声明以外的扩展点（目前 manifest 已够用；该权限预留）|
| `event:publish` | `hostApi.emit(point, payload)`；向宿主事件总线广播 |
| `workflows:execute` | `hostApi.execute(wfId, params)`；发起一次工作流运行（会被调度器接受/拒绝）|
| `extensions:call` | `hostApi.extensions.call(point, payload)`；同步发起扩展点（如 atomic 间互调）|
| `ui:navigate` | 未来渲染器侧 HostUIApi 用；目前保留 |

---

## 6. HostApi 全量签名

沙箱里的 `hostApi`（插件内用；`activate(ctx)` 里 `ctx.hostApi` 是同一个）：

```ts
interface HostApi {
  // ---- 日志 ---- 需要 log:write
  logger: {
    trace: (msg: string, data?: Record<string, unknown>) => void;
    debug: (msg: string, data?: Record<string, unknown>) => void;
    info:  (msg: string, data?: Record<string, unknown>) => void;
    warn:  (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
    fatal: (msg: string, data?: Record<string, unknown>) => void;
  };

  // ---- 审计 ---- 需要 audit:write
  audit: {
    record: (event: string, data?: Record<string, unknown>) => void;
  };

  // ---- KV ---- 需要 kv:read / kv:write（插件作用域隔离）
  kv: {
    get:    (key: string) => Promise<string | null>;
    set:    (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    list:   (prefix?: string) => Promise<string[]>; // keys 列表；prefix 可选
  };

  // ---- DB 只读 ---- 需要 db:read
  db: {
    query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  };

  // ---- 事件总线 ----
  emit: (point: string, payload: unknown) => Promise<unknown[]>;   // 需要 event:publish
  extensions: {
    call: (point: string, payload: unknown) => Promise<unknown[]>; // 需要 extensions:call
    requirePlugin: <T = any>(pluginId: string) => T;                // 直接访问其他插件 exports；已内置可用
    isEnabled: (pluginId: string) => boolean;                       // 查某插件是否启用
  };

  // ---- 工作流执行 ---- 需要 workflows:execute
  execute: (workflowId: string, params?: Record<string, unknown>) => Promise<{ runId: string }>;

  // ---- 工具 ----
  utils: {
    newTraceId: () => string;   // 与宿主用同一种 traceId 格式（便于链路追踪）
  };
}
```

**实现位置**：类型在 [src/shared/plugin-api/index.ts](../src/shared/plugin-api/index.ts)，权限包装在 [src/main-app/core/plugin/host-api.ts](../src/main-app/core/plugin/host-api.ts)。

---

## 7. Demo 插件链接（源码 + 打包脚本）

三个 Demo 同时是最小参考实现（源码注释即文档）：

| 插件 | 源码目录 | zip 包 |
|---|---|---|
| Echo + crashMe（atomic）| `plugins-source/atomic/demo-echo/` | `plugins-dist/com.fmb.demo.atomic@0.1.0.zip` |
| Counter（app，跨插件 ping atomic）| `plugins-source/app/demo-counter/` | `plugins-dist/com.fmb.demo.app@0.1.0.zip` |
| 安装通知（extension，写 kv+warn+audit）| `plugins-source/extension/demo-install-notify/` | `plugins-dist/com.fmb.demo.extension@0.1.0.zip` |

---

## 8. package-plugin 脚本用法

项目根目录运行：

```bash
# 打包全部 3 个 Demo
pnpm package:plugins

# 只打包指定的某（几）个
node scripts/package-plugin.ts app/demo-counter
node scripts/package-plugin.ts atomic/demo-echo extension/demo-install-notify
```

**脚本干了什么**（`scripts/package-plugin.ts`，3 步）：

1. esbuild 编译 `main.ts → main.js`（CJS，零 external，sandbox 不允许 require）
2. type=app 额外 esbuild 编译 `renderer → renderer.umd.js`（外置 `react / react-dom / antd`，宿主 runtime shim 提供；目标浏览器 ES2020）
3. 重写 staged manifest（renderer 字段指向 pre-compiled），用 adm-zip 压成 `plugins-dist/<id>@<version>.zip`

**打包后自测清单**（5 项，建议作为插件 PR 门禁）：
- ✅ zip 里有 `manifest.json` + `main.js`，app 多 `renderer.umd.js`
- ✅ `node scripts/verify_task16.cjs` 通过（adm-zip 静态检查）
- ✅ UI 里"安装"→"启用"不报错；插件页卡片显示正常
- ✅ atomic 插件：在工作流里拖一个节点运行，结果等于预期
- ✅ extension 插件：触发一次其订阅的事件后，DB/kv 里有对应记录

---

## 9. 调试插件

- **沙箱报错**：`error_logs.level = error` + `error_logs.plugin_id = <你的插件ID>`；设置页日志级别切到 debug 可看到 activate/deactivate 的细粒度日志。
- **SyntaxError（strict mode）**：`with (Proxy)` 开启严格模式，`with(obj)`、未声明变量赋值、八进制字面量都会炸；`echo` 插件用 strict 模式先 `node --use-strict out.js` 跑一遍就能发现。
- **权限 `Permission denied`**：hostApi 会把缺的权限名列出来；补到 manifest.permissions，卸载重装。
- **renderer 样式丢了**：渲染跑在 Shadow DOM 里，外部 stylesheet 进不去。主题变量（`--ant-*`、`--fmb-*`）会由 AppPluginPage 复制过去；其他样式直接写 inline 或 CSS-in-JS。
- **renderer 的 React 找不到**：宿主的 require shim 只提供 react/react-dom/antd/react/jsx-runtime；打包时外部化了这几个，不能 `import 'react'` from 'react' 在独立脚本里调。

---

**文档版本**：v1.0 · 对应基座版本 ≥ 2026.08，T1–T16 冻结后稳定。
