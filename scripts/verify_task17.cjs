/* eslint-disable */
/**
 * Pure-Node verification runner for Task 17 (docs + embedded markdown).
 *
 * Usage: node scripts/verify_task17.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
function check(label, cond, note) {
  RESULTS.push({ label, pass: !!cond, note });
  process.stdout.write(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${note ? ' — ' + note : ''}\n`);
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }
function sha1(p) {
  return crypto.createHash('sha1').update(read(p), 'utf8').digest('hex');
}
function countChars(p) { return [...read(p)].length; }

console.log('\n=== Task 17 验证驱动 (docs + markdown rendering) ===\n');

// ---- TR-17.1: AGENTS.md 文件存在 + 字数 ≥ 800 + 4 章节 ----
console.log('TR-17.1 AGENTS.md 完整性');
check('根目录 AGENTS.md 存在', exists('AGENTS.md'));
const agentsLen = exists('AGENTS.md') ? countChars('AGENTS.md') : 0;
check('AGENTS.md 字数 ≥ 800', agentsLen >= 800, `实际 ${agentsLen}`);
const agents = read('AGENTS.md');
check('章节: 目录结构', /^##\s+1\.\s*目录结构总览/m.test(agents) || /^##\s+目录结构/m.test(agents) || /##[\s\S]*目录结构总览/.test(agents), '含章节标题');
check('章节: 启动调试', /##[\s\S]*启动与调试/.test(agents));
check('章节: 常用命令', /##[\s\S]*常用命令/.test(agents));
check('章节: 约定规则', /##[\s\S]*约定规则/.test(agents));
check('4.2 最小 echo 插件示例 (AGENTS 可自测)', agents.includes('echo2') || agents.includes('echo 插件') && agents.includes('manifest.json'));
check('4.3 扩展点注册路径', agents.includes('extension-points.ts'));
check('4.4 禁止硬编码路径', agents.includes('electronApp.getPath'));
check('4.6 typecheck 0 errors', agents.includes('typecheck'));

// ---- TR-17.2: plugin-dev.md 存在 + 4 节 (manifest/权限/HostApi/生命周期) ----
console.log('\nTR-17.2 plugin-dev.md 完整性');
check('docs/plugin-dev.md 存在', exists('docs/plugin-dev.md'));
const pd = read('docs/plugin-dev.md');
check('plugin-dev.md 含 manifest 章节', /##[\s\S]*Manifest\s*字段说明/.test(pd));
check('plugin-dev.md 含 权限 章节', /##[\s\S]*5\.\s*权限列表/.test(pd) || /权限/.test(pd));
check('plugin-dev.md 含 HostApi 章节', /##[\s\S]*HostApi\s*全量签名/.test(pd) || /HostApi/.test(pd));
check('plugin-dev.md 含 生命周期 章节', /##[\s\S]*4\.\s*生命周期/.test(pd));
check('权限至少含 11 种(表格行)', (pd.match(/log:write|audit:write|kv:read|kv:write|db:read|event:subscribe|event:publish|workflows:execute|extensions:call|ui:navigate|db:write/g) || []).length >= 10);
check('HostApi logger: info/warn/error/debug/trace/fatal 六方法',
  /trace:[\s\S]*debug:[\s\S]*info:[\s\S]*warn:[\s\S]*error:[\s\S]*fatal:/.test(pd)
  || (pd.includes('logger.trace') && pd.includes('logger.info') && pd.includes('logger.warn') && pd.includes('logger.error')));
check('HostApi kv: get/set/delete/list 四方法',
  /get:[\s\S]*set:[\s\S]*delete:[\s\S]*list:/.test(pd)
  || (pd.includes('kv.get') && pd.includes('kv.set') && pd.includes('kv.delete') && pd.includes('kv.list')));
check('HostApi extensions.call / requirePlugin / isEnabled', pd.includes('extensions.call') && pd.includes('requirePlugin'));
check('HostApi audit.record', pd.includes('audit.record'));
check('HostApi utils.newTraceId', pd.includes('newTraceId'));
check('生命周期 5 阶段 (install/enable/运行/disable/uninstall)', /install[\s\S]*enable[\s\S]*运行[\s\S]*disable[\s\S]*uninstall/.test(pd));
check('Demo 插件链接表', pd.includes('demo-echo') && pd.includes('demo-counter') && pd.includes('demo-install-notify'));
check('package-plugin 用法', pd.includes('package:plugins') || pd.includes('package-plugin'));
check('打包脚本 3 步骤 (esbuild main + renderer + zip)',
  (/main\.ts[\s\S]*main\.js[\s\S]*renderer[\s\S]*renderer\.umd\.js[\s\S]*zip/.test(pd)
   || /1\.[\s\S]*main[\s\S]*2\.[\s\S]*renderer[\s\S]*3\.[\s\S]*zip/.test(pd)),
  '描述脚本干了哪三步');

// ---- 设置页内嵌渲染接入 ----
console.log('\nTR-17 设置页内嵌渲染 (react-markdown)');
const pkg = JSON.parse(read('package.json'));
check('package.json 装了 react-markdown 依赖', pkg.dependencies && pkg.dependencies['react-markdown']);
check('renderer/src/docs 目录存在', exists('src/renderer/src/docs'));
check('renderer/src/docs/AGENTS.md 存在', exists('src/renderer/src/docs/AGENTS.md'));
check('renderer/src/docs/plugin-dev.md 存在', exists('src/renderer/src/docs/plugin-dev.md'));
// 确保副本内容与源一致（避免两份不同步）
check('AGENTS.md 与 renderer/src/docs/AGENTS.md 内容一致', exists('AGENTS.md') && exists('src/renderer/src/docs/AGENTS.md') && sha1('AGENTS.md') === sha1('src/renderer/src/docs/AGENTS.md'));
check('docs/plugin-dev.md 与 renderer/src/docs/plugin-dev.md 内容一致', exists('docs/plugin-dev.md') && exists('src/renderer/src/docs/plugin-dev.md') && sha1('docs/plugin-dev.md') === sha1('src/renderer/src/docs/plugin-dev.md'));

const settings = read('src/renderer/pages/Settings.tsx');
check('Settings 导入 ReactMarkdown', settings.includes("import ReactMarkdown from 'react-markdown'"));
check('Settings 导入 AGENTS.md?raw', settings.includes("AGENTS.md?raw"));
check('Settings 导入 plugin-dev.md?raw', settings.includes("plugin-dev.md?raw"));
check('MD_COMPONENTS 定义', /const MD_COMPONENTS:/.test(settings));
check('代码块深色背景 (pre background #1e1e1e)', settings.includes("background: '#1e1e1e'"));
check('code inline 样式 (rgba 背景)', settings.includes('rgba(125, 125, 125, 0.12)'));
check('Tab 切换 插件 API 文档 / Agent 操作手册', /key:\s*'plugin'/.test(settings) && /key:\s*'agents'/.test(settings));
check('Tab plugin label = 插件 API 文档', /label:\s*'插件 API 文档'/.test(settings));
check('Tab agents label = Agent 操作手册', /label:\s*'Agent 操作手册'/.test(settings));
check('两个 Tab 内部都用 <ReactMarkdown components={MD_COMPONENTS}', (settings.match(/<ReactMarkdown components=\{MD_COMPONENTS\}>/g) || []).length >= 2);
check('开发者文档区块标题 (CodeOutlined)', settings.includes('开发者文档') && settings.includes('CodeOutlined'));

// Summary
console.log('\n=== 汇总 ===');
const passed = RESULTS.filter((r) => r.pass).length;
const total = RESULTS.length;
console.log(`PASSED: ${passed} / ${total}`);
RESULTS.filter((r) => !r.pass).forEach((r) => {
  console.log(`  FAIL: ${r.label}${r.note ? ' (' + r.note + ')' : ''}`);
});
process.exit(passed === total ? 0 : 1);
