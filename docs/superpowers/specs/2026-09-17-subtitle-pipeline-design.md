# 字幕提取与翻译流水线（Subtitle Pipeline）设计文档

- 日期：2026-09-17
- 状态：待用户审阅
- 方案：A（3 atomic + 1 app，app 层串行任务队列）

## 1. 背景与目标

用户有大量无字幕外语视频/音频（日语、英语为主），需要一个 FMB app 插件完成：

1. 从视频/音频中提取外语字幕（ASR，Whisper）
2. 用 LLM 把字幕翻译成中文
3. 把带时间轴的纯中文字幕写到媒体同目录，PotPlayer 打开视频即可自动加载

已确认的用户偏好：

- 输出形态：**纯中文** `<视频名>.zh.srt`（不生成双语版）
- 源语言：**自动检测**，可在任务级手动覆盖（ja / en / auto）

## 2. 已验证的基础设施事实（调查结论）

| 事实 | 证据 |
|---|---|
| PotPlayer 已下载 Faster-Whisper-XXL 独立 CLI 引擎 | `%APPDATA%\PotPlayerMini64\Engine\Faster-Whisper-XXL\faster-whisper-xxl.exe`（41MB） |
| 引擎内置 PyAV/ffmpeg 解码，可直接吃 mp4/mkv/mp3 | `_xxl_data\av`、`av.libs` 存在；`--ff_*` 系列参数 |
| large-v3-turbo 模型已下载（CTRANSLATE2 格式，1.6GB） | `%APPDATA%\PotPlayerMini64\Model\faster-whisper-large-v3-turbo\model.bin` |
| CLI 支持所需全部参数 | `--help` 实测：`--language ja/en`、`--output_format srt`、`--output_dir`、`--print_progress`、`--vad_filter`、`--standard_asia`、`--device`、`--compute_type`、`--model_dir` |
| 本机 GPU 可加速 | NVIDIA RTX 4060 Laptop 8GB |
| FMB 插件沙箱无 fs/net/child_process | sandbox.ts DISALLOWED_REQUIRE |
| 外部脚本执行有成熟先例 | baidunetdisk：内嵌 Node 脚本字符串 → PowerShell `Set-Content` 落盘 → `node.exe` 执行（全功能 fs/https）→ 结果 POST 回 FMB HTTP API `/api/v1/plugins/<id>/invoke` |
| node.exe 可用 | `C:\Program Files\nodejs\node.exe`（baidunetdisk 同款默认值，KV 可覆盖） |
| 渲染层文件选择器 | `window.fmb.dialogShowOpen({ multiSelections, openFile, filters })`，插件 renderer 页可直接用 |
| `hostApi.workflows.start` 同步阻塞至 DAG 完成 | crud.ts `run()` await `execute()` |
| 工作流输入插值 | `${input.x}`、`${nodes.<nodeId>.output.<field>}`（executor.ts resolveExpr） |
| LLM 协议（SUCCUBUSQ 会话，已实测打通） | DeepInfra `https://api.deepinfra.com/v1/openai/chat/completions`，模型 `Qwen/Qwen3-30B-A3B`，必须带 `chat_template_kwargs: { enable_thinking: false }` |

对 SUCCUBUSQ `translate.py` 的评估结论：协议层（端点/模型/关思考/术语表注入/temperature 0.3）直接复用；但单发整篇模式不适合字幕（需分块+编号契约），且不应跨项目耦合 `D:\BOAT\SUCCUBUSQ` 路径与 Python 环境。因此**按同协议在插件内自包含实现 Node 版批处理脚本**。

## 3. 总体架构

```
plugins-source/subtitle-pipeline/
├─ atomic/asr/            com.fmb.subtitle.asr          whisper CLI 包装
├─ atomic/llmtranslate/   com.fmb.subtitle.llmtranslate DeepInfra 分块翻译
├─ atomic/writer/         com.fmb.subtitle.writer       字幕落盘+清理
└─ app/studio/            com.fmb.subtitle.studio       UI + 任务队列 + 工作流注册
```

数据流：

```
Studio 页选 N 个媒体文件 → app 写 KV 任务队列（串行消费，_runningTasks 防重入）
每任务 = hostApi.workflows.start('wf-subtitle-flow', { taskId, mediaPath, language })
  节点1 asr.transcribe   → node 包装脚本 spawn whisper --print_progress
                           逐行解析百分比 → 周期性 POST 进度回调
                           → 产出 raw.srt + 检测语言
  节点2 llm.translateSrt → node 脚本：解析 srt → 分块 → 逐块 DeepInfra 翻译
                           每块完成 POST 进度 → 产出 translated.srt
  节点3 writer.emit      → 校验行数/时间轴 → 写 <stem>.zh.srt 到媒体同目录
                           → 删除工作目录 → 完成
```

中间产物放 FMB 数据目录 `subtitle-tasks/<taskId>/`（不污染媒体目录，媒体目录只新增最终 `.zh.srt`）。

## 4. 插件详细设计

### 4.1 `com.fmb.subtitle.asr`（atomic）

**manifest.json**

```json
{
  "id": "com.fmb.subtitle.asr",
  "name": "Whisper ASR",
  "version": "0.1.0",
  "type": "atomic",
  "description": "Wraps faster-whisper-xxl.exe (shipped with PotPlayer) to transcribe audio/video to SRT with timeline.",
  "permissions": ["system:process:start", "system:process:read", "kv:read", "kv:write", "log:write"],
  "dependencies": {},
  "main": "main.js"
}
```

**导出 action：`transcribe(payload)`**

输入：

| 字段 | 类型 | 说明 |
|---|---|---|
| `taskId` | string | 任务 ID（进度回调键、工作目录名） |
| `mediaPath` | string | 媒体文件绝对路径 |
| `language` | `"ja" \| "en" \| "auto"` | auto 时省略 `--language` 由 whisper 检测 |
| `workDir` | string | 中间产物目录（脚本自建） |

输出：`{ ok, srtPath, detectedLanguage, durationMs }`

**执行机制**（内嵌 Node 包装脚本，照 baidunetdisk `_launchScript` 模式）：

1. 插件把 `buildAsrScript(...)` 生成的 JS 字符串经 PowerShell `Set-Content`（UTF-8 无 BOM）写到 `<workDir>\_asr_runner.js`。
2. `processes.start({ executablePath: nodePath, args: [scriptPath], detached: true })`。
3. 包装脚本 spawn whisper：

```
faster-whisper-xxl.exe "<mediaPath>"
  --model "<modelDir>"            # 直接指向已下载的 faster-whisper-large-v3-turbo 目录
  --output_dir "<workDir>" --output_format srt
  --vad_filter true --standard_asia --print_progress
  --device cuda --compute_type int8_float16
  [--language ja|en]              # auto 时省略
```

4. 脚本逐行读 stdout：解析进度百分比与 "Detected language: xx"，节流（≥2s）POST 到 `/api/v1/plugins/com.fmb.subtitle.studio/invoke`（action=`storeProgress`）。
5. 子进程退出后：exit 0 且 `*.srt` 存在于 workDir → POST 终态到**自己的** invoke 端点（`/api/v1/plugins/com.fmb.subtitle.asr/invoke`，action=`storeResult`，含 srtPath、detectedLanguage）；exit≠0 且日志含 CUDA/cuBLAS 特征 → 以 `--device cpu --compute_type int8` 自动重试一次；仍败 → POST 失败（含日志尾部 20 行摘要）。
6. 插件侧轮询 KV `asrResult:<taskId>` 直到出现终态（活性等待：有进度心跳就不算停滞；10 分钟无进度判停滞失败；硬上限 4 小时）。

**whisper 路径/模型定位**（KV 可覆盖，默认自动探测）：

- `config:whisperExe` 默认 `%APPDATA%\PotPlayerMini64\Engine\Faster-Whisper-XXL\faster-whisper-xxl.exe`
- `config:whisperModel` 默认 `%APPDATA%\PotPlayerMini64\Model\faster-whisper-large-v3-turbo`
- `config:nodePath` 默认 `C:\Program Files\nodejs\node.exe`
- `%APPDATA%` 由 `__hostEnv` 无此键 —— 用 `__hostEnv.HOME` + `\AppData\Roaming` 推导，或探测默认候选路径（实现时以 spike 验证为准）。

**备注**：`--model` 直传本地目录 vs `--model large-v3-turbo --model_dir <父目录>` 的确切形态，实现第一步用真实小文件 spike 验证后锁定。

### 4.2 `com.fmb.subtitle.llmtranslate`（atomic）

**manifest.json**

```json
{
  "id": "com.fmb.subtitle.llmtranslate",
  "name": "LLM Subtitle Translator",
  "version": "0.1.0",
  "type": "atomic",
  "description": "Translates SRT subtitle entries to Chinese via DeepInfra (Qwen3-30B-A3B) with chunked numbered-line contract, retries and optional glossary.",
  "permissions": ["system:process:start", "system:process:read", "kv:read", "kv:write", "secrets:read", "log:write"],
  "dependencies": {},
  "main": "main.js"
}
```

**导出 action：`translateSrt(payload)`**

输入：`{ taskId, srtPath, sourceLang, workDir }`（v1 目标语言固定中文）
输出：`{ ok, translatedSrtPath, lineCount, chunks, usage }`

**翻译脚本**（内嵌 Node 脚本，stdlib `https`/`fs`，经环境变量 `FMB_LLM_API_KEY` 收 key——不写进脚本文件、不上命令行）：

1. **SRT 解析**：解析为条目数组 `{ index, start, end, text }`（支持多行文本合并、CRLF/LF、BOM 剔除）。
2. **分块**：按"≤25 条 且 ≤1500 字符"贪心切块（先到先切）。
3. **每块请求**：
   - system（沿用 SUCCUBUSQ RULES 精神，面向字幕调整）：
     ```
     你是专业字幕翻译引擎。规则：
     1. 把每行从{src}翻译为中文，只输出译文行，不输出解释。
     2. 输入每行格式 «i» 原文；输出必须严格逐行对应 «i» 译文，行数一致，不得合并、拆分、遗漏。
     3. 忠实原文的语气、风格和尺度，不自行净化或改写。
     4. 译文是字幕：口语化、简洁，单行译文尽量不超过 30 个汉字。
     5. 【上下文】仅帮助理解，不要翻译。
     ```
   - user：`【术语表】…`（可选，见 §5 `config:glossary`）+ `【上下文】`（前块末 2 条原文，首块省略）+ 编号行 `«i» 原文`。
   - payload：`model`（KV 默认 `Qwen/Qwen3-30B-A3B`）、`temperature: 0.3`、`max_tokens: 8192`、`chat_template_kwargs: { enable_thinking: false }`。
4. **响应解析**：正则逐行抓 `«i» 译文`；**行数不等或编号不连续 → 该块重试**（最多 3 次：第 2 次 temperature 降 0.15 并追加"上次行数不符，必须严格逐行"提醒；HTTP 429/5xx/网络错误 → 指数退避 2/4/8/16s 最多 4 次）。块最终失败 → 整个 action 失败并报出错块号。
5. **进度**：每块完成 POST 进度到 studio（action=`storeProgress`，`done/total` 块数）。
6. **写盘**：按原时间轴重组 `translated.srt`（保留 index/start/end，text 换译文），写 `<workDir>\translated.srt`（UTF-8 无 BOM，CRLF）。
7. 完成 POST 终态到自己的 invoke 端点（action=`storeResult`，含 usage 汇总，供 UI 展示 token 消耗）。

**空文本条目**直接透传不占翻译请求。

### 4.3 `com.fmb.subtitle.writer`（atomic）

**manifest.json**

```json
{
  "id": "com.fmb.subtitle.writer",
  "name": "Subtitle Writer",
  "version": "0.1.0",
  "type": "atomic",
  "description": "Validates translated SRT timeline alignment, writes <stem>.zh.srt next to the media file, cleans up the work directory.",
  "permissions": ["system:process:start", "system:process:read", "kv:read", "kv:write", "log:write"],
  "dependencies": {},
  "main": "main.js"
}
```

**导出 action：`emit(payload)`**

输入：`{ taskId, mediaPath, translatedSrtPath, workDir }`
输出：`{ ok, finalPath, entries }`

**写盘脚本**（内嵌 Node 脚本）：

1. 重新解析 `translated.srt`：条目数 > 0、每条 text 非空、时间轴格式合法（`HH:MM:SS,mmm --> HH:MM:SS,mmm`）——不满足则失败（带具体条目号）。
2. 目标路径：`<mediaDir>\<stem>.zh.srt`（`stem` = 媒体文件名去扩展名）。**存在则覆盖**（重跑幂等；用户主动触发）。
3. 写入 UTF-8 无 BOM、CRLF 行尾（PotPlayer 兼容性最好）。
4. 删除 `<workDir>` 整个目录（raw.srt、runner 脚本、日志等中间产物）。
5. POST 终态到自己的 invoke 端点（action=`storeResult`）→ 插件轮询 KV `writeResult:<taskId>`（短任务，2 分钟超时足够）。

### 4.4 `com.fmb.subtitle.studio`（app）

**manifest.json** 要点：

- `type: "app"`，`renderer: "renderer/index.ts"`
- `dependencies`：`com.fmb.subtitle.asr ^0.1.0`、`com.fmb.subtitle.llmtranslate ^0.1.0`、`com.fmb.subtitle.writer ^0.1.0`（打包时自动 bundled，装一个 app zip 即全套）
- `permissions`：`log:write`、`audit:write`、`kv:read/write`、`plugins:read`、`plugins:invoke`、`workflows:create/read/execute`、`secrets:read/write`、`system:process:start/read`
- `scheduleTemplates`：**不声明**（字幕处理是 ad-hoc 行为，v2 再考虑目录监视）

**activate() 职责**：

1. 注册工作流 `wf-subtitle-flow`（已存在则跳过，容忍 UNIQUE/duplicate 报错，照 uploader 模式）：

```
nodes:
  - { id: 'asr',       type: 'atomic', pluginId: 'com.fmb.subtitle.asr',
      action: 'transcribe',
      inputs: { taskId: '${input.taskId}', mediaPath: '${input.mediaPath}',
                language: '${input.language}', workDir: '${input.workDir}' } }
  - { id: 'translate', type: 'atomic', pluginId: 'com.fmb.subtitle.llmtranslate',
      action: 'translateSrt',
      inputs: { taskId: '${input.taskId}', srtPath: '${nodes.asr.output.srtPath}',
                sourceLang: '${nodes.asr.output.detectedLanguage}', workDir: '${input.workDir}' } }
  - { id: 'write',     type: 'atomic', pluginId: 'com.fmb.subtitle.writer',
      action: 'emit',
      inputs: { taskId: '${input.taskId}', mediaPath: '${input.mediaPath}',
                translatedSrtPath: '${nodes.translate.output.translatedSrtPath}',
                workDir: '${input.workDir}' } }
edges: [asr→translate, translate→write]
entryNode: asr
```

2. 恢复 KV 中未完成任务队列（重启续跑）。

**任务模型**（KV `tasks` 数组，照 uploader 任务表模式）：

```json
{ "taskId": "t_<nanoid8>", "mediaPath": "...", "fileName": "...",
  "language": "auto", "status": "queued|asr|translating|writing|done|failed",
  "progressText": "...", "error": "", "finalPath": "",
  "createdAt": 0, "finishedAt": 0 }
```

**队列消费**：内部 `setInterval`（2s）扫队列 → 有 queued 且无 `_runningTasks` → 取一个执行 `await hostApi.workflows.start('wf-subtitle-flow', …)`（同步阻塞返回即终态）→ 更新任务状态 → 继续下一个。串行是必须的：whisper 独占 GPU。

**断点续跑**：任务重试时若 `<workDir>\raw.srt` 已存在（ASR 已完成过），asr.transcribe 检测到即跳过转写直接返回（`reused: true`）；翻译重跑成本极低（分钟级、分钱级），不做块级断点。

**回调 action**：外部脚本统一走 `/api/v1/plugins/<pluginId>/invoke` POST 回传（baidunetdisk 同款机制）：

| 接收方 | action | 载荷 | 行为 |
|---|---|---|---|
| 各原子插件自己 | `storeResult` | `{ taskId, ok, ...终态字段, error? }` | 写自己 KV 的 `<stage>Result:<taskId>`，供该原子插件轮询等待 |
| studio | `storeProgress` | `{ taskId, stage, percent?, text }` | 更新任务 progressText（UI 5s 轮询展示） |

即：终态结果由脚本直接 POST 给发起它的原子插件（一跳）；过程进度由脚本 POST 给 studio 展示（与结果通道分离，互不干扰）。

**UI 页面**（renderer，antd，风格照 uploader 页）：

- 顶部操作栏：【选择媒体文件】（`window.fmb.dialogShowOpen({ multiSelections: true, openFile: true, filters: [{ name: '媒体文件', extensions: ['mp4','mkv','avi','mov','webm','mp3','m4a','aac','flac','wav','ogg'] }] })`）、语言覆盖下拉（自动检测/日语/英语，作为新任务默认值）
- 任务表格：文件名、源语言、状态（queued/asr/translating/writing/done/failed）、进度文本（如 `转写中 · 42%`、`翻译中 · 块 7/24`）、最终路径（可复制）、操作（重试/删除）
- 配置区（折叠）：DeepInfra API Key（secrets.set）、模型名、API Base（默认 `https://api.deepinfra.com/v1/openai`）、whisper 路径/模型路径（留空=自动探测）、术语表 textarea（可选，格式兼容 SUCCUBUSQ characters.md 的 markdown 表格原文粘贴）
- 5s 轮询任务表刷新；操作反馈用 antd message（成功/失败明确提示）

## 5. KV / secrets 键约定

| 键 | 属主 | 内容 |
|---|---|---|
| `tasks` | studio | 任务数组（JSON） |
| `asrResult:<taskId>` | asr | ASR 脚本终态结果 |
| `translateResult:<taskId>` | llmtranslate | 翻译脚本终态结果 |
| `writeResult:<taskId>` | writer | 写盘脚本终态结果 |
| `progress:<taskId>` | studio | 最新进度文本（storeProgress 覆盖写） |
| `config:nodePath` | 三原子各自 | node.exe 路径覆盖 |
| `config:whisperExe` / `config:whisperModel` | asr | 引擎/模型路径覆盖 |
| `config:apiBase` / `config:model` | llmtranslate | DeepInfra 端点/模型覆盖 |
| `config:glossary` | llmtranslate | 术语表文本（可选） |
| secret key `deepinfra_api_key` | studio 写入、llmtranslate 读 | DeepInfra API Key |

secrets 为全局键空间（`secret-store.ts getSecret(key)` 按 key 直查，不按插件隔离）：studio 写入、llmtranslate 读取即可。key 只经环境变量传给脚本进程，**绝不写进 KV/日志/脚本文件**。

## 6. 错误处理矩阵

| 故障 | 检测 | 行为 |
|---|---|---|
| whisper exe / 模型缺失 | spawn ENOENT / 输出文件不存在 | 任务 failed，错误提示含期望路径与配置入口 |
| CUDA 初始化失败 | 子进程非 0 + 日志含 CUDA 特征 | 自动 `--device cpu --compute_type int8` 重试一次 |
| whisper 停滞 | 10 分钟无进度心跳 | 任务 failed（硬上限 4h） |
| DeepInfra 429/5xx/断网 | HTTP 状态/异常 | 块级指数退避 ×4 → 仍败则任务 failed（可整任务重试） |
| 翻译行数契约违反 | 响应行数≠块条目数 | 块级重试 ×3（降温+严格提醒）→ 仍败任务 failed |
| 时间轴损坏/空译文 | writer 校验 | 任务 failed，报具体条目号，**不落盘**半成品 |
| FMB 重启 | activate 恢复队列 | asr 中任务 → 有 raw.srt 则跳过转写直接进翻译 |
| 目标 .zh.srt 已存在 | —— | 覆盖（重跑幂等） |

## 7. 安全与权限

- API Key 只走 secrets + 环境变量，不进脚本文件/命令行/KV/日志。
- 脚本内嵌字符串插值一律 `JSON.stringify`（防引号注入），路径参数白名单校验（拒绝空值）。
- 三原子权限最小化（见各 manifest）；studio 不申请 `system:process:*` 以外的系统权限。

## 8. 测试与验收

1. `pnpm typecheck` 0 errors（4 个 tsconfig）
2. `pnpm package:plugins` 产出 4 个 zip（app zip 内嵌 3 个原子 bundled zip）
3. 单元级：srt 解析/重组、分块、编号契约解析抽成脚本内自测模式（`--selftest` 用本地桩数据，不打真实 API），在 `ELECTRON_RUN_AS_NODE=1 electron.exe` 下跑
4. 真实 E2E（`scripts/verify_subtitle_e2e.cjs`，照 verify_uploader_e2e.cjs 先例打运行中实例 HTTP API）：用户提供 1-3 分钟日语测试视频 → 全链路 → 断言：`<stem>.zh.srt` 存在于媒体同目录、条目数>0、时间轴合法、中文译文非空；人工在 PotPlayer 打开视频确认字幕自动挂载
5. `pnpm build:win` 产物覆盖 `dist/`（standing rule）

## 9. 打包发布

- `scripts/package-plugin.ts` 的 `ALL_PLUGINS` 追加 4 个条目
- 插件 zip 固定输出 `plugins-dist/`；安装器 extraResources 随包分发
- 每轮功能完成执行 `pnpm build:win` 覆盖 `dist/`

## 10. 范围外（YAGNI，v2 候选）

- 双语字幕输出、目标语言可配（v1 固定中文）
- 定时扫描目录自动处理（scheduleTemplate）
- 说话人分离（whisper `--diarize`）、人声分离（`--ff_vocal_extract`）
- 翻译并发块、块级断点续翻
- 术语表 UI 管理（v1 为纯文本粘贴）
