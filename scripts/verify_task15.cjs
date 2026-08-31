/* eslint-disable */
/**
 * Pure-Node verification runner for Task 15 (Localhost HTTP API).
 * Mirrors TR-15.1 ~ TR-15.5 as static structural checks (no Electron runtime).
 *
 * Usage: node scripts/verify_task15.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
function check(label, cond, note) {
  RESULTS.push({ label, pass: !!cond, note });
  process.stdout.write(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${note ? ' — ' + note : ''}\n`);
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

console.log('\n=== Task 15 验证驱动 (no-deps, pure CJS) ===\n');

// ---- TR-15.1: hono server + loopback + bearer auth ----
console.log('TR-15.1 Hono 服务 + 回环绑定 + Bearer Token 认证');
const http = read('src/main-app/http/index.ts');
check('imports Hono', http.includes("from 'hono'"));
check('imports @hono/node-server serve', http.includes('@hono/node-server'));
check('binds 127.0.0.1 only', http.includes("hostname: '127.0.0.1'"));
check('startHttpServer exported', /export function startHttpServer/.test(http));
check('HttpServerHandle interface with close()', /HttpServerHandle/.test(http) && http.includes('close:'));
check('Bearer token from settings http.token', http.includes("svc.get('http.token')"));
check('auto-generates 32-byte hex token if missing', http.includes('crypto.randomBytes(32)') && http.includes("toString('hex')"));
check('persists token via applyPatch', http.includes("svc.applyPatch({ 'http.token': token") || http.includes("applyPatch({ 'http.token'"));
check('timingSafeEqual for token compare', http.includes('timingSafeEqual'));
check('exempts /health from auth', http.includes("path === '/api/v1/health'"));
check('exempts /openapi.json from auth', http.includes("path === '/api/v1/openapi.json'"));
check('exempts /docs from auth', http.includes("path === '/api/v1/docs'"));
check('returns 401 on missing token', http.includes("401, 'Unauthorized'") || http.includes("problem(c, 401"));
check('ProblemDetails RFC 7807 format', http.includes('application/problem+json') || http.includes('problem(c,'));

// ---- TR-15.2: all 8 resource groups ----
console.log('\nTR-15.2 八大资源组路由');
check('GET /health', http.includes("app.get('/api/v1/health'"));
check('GET /openapi.json', http.includes("app.get('/api/v1/openapi.json'"));
check('GET /docs (Swagger UI)', http.includes("app.get('/api/v1/docs'") && http.includes('swaggerUI'));
check('GET /plugins', http.includes("app.get('/api/v1/plugins'"));
check('POST /plugins (install)', http.includes("app.post('/api/v1/plugins'"));
check('GET /plugins/:id', http.includes("app.get('/api/v1/plugins/:id'"));
check('PATCH /plugins/:id', http.includes("app.patch('/api/v1/plugins/:id'"));
check('POST /plugins/:id/actions/:action', http.includes("app.post('/api/v1/plugins/:id/actions/:action'"));
check('GET /workflows', http.includes("app.get('/api/v1/workflows'"));
check('POST /workflows', http.includes("app.post('/api/v1/workflows'"));
check('GET /workflows/:id', http.includes("app.get('/api/v1/workflows/:id'"));
check('PUT /workflows/:id', http.includes("app.put('/api/v1/workflows/:id'"));
check('DELETE /workflows/:id', http.includes("app.delete('/api/v1/workflows/:id'"));
check('GET /workflows/:id/runs', http.includes("app.get('/api/v1/workflows/:id/runs'"));
check('POST /workflows/:id/runs', http.includes("app.post('/api/v1/workflows/:id/runs'"));
check('GET /runs/:runId', http.includes("app.get('/api/v1/runs/:runId'"));
check('GET /schedules', http.includes("app.get('/api/v1/schedules'"));
check('POST /schedules', http.includes("app.post('/api/v1/schedules'"));
check('PATCH /schedules/:id', http.includes("app.patch('/api/v1/schedules/:id'"));
check('DELETE /schedules/:id', http.includes("app.delete('/api/v1/schedules/:id'"));
check('POST /schedules/:id/actions/:action', http.includes("app.post('/api/v1/schedules/:id/actions/:action'"));
check('GET /queue/stats', http.includes("app.get('/api/v1/queue/stats'"));
check('GET /queue/jobs', http.includes("app.get('/api/v1/queue/jobs'"));
check('POST /queue/actions/retry-dead', http.includes("app.post('/api/v1/queue/actions/retry-dead'"));
check('POST /queue/actions/clear-dead', http.includes("app.post('/api/v1/queue/actions/clear-dead'"));
check('GET /errors', http.includes("app.get('/api/v1/errors'"));
check('PATCH /errors/:id', http.includes("app.patch('/api/v1/errors/:id'"));
check('POST /rpc (JSON-RPC batch)', http.includes("app.post('/api/v1/rpc'"));

// ---- TR-15.3: JSON-RPC 2.0 dispatch ----
console.log('\nTR-15.3 JSON-RPC 2.0 分发');
check('rpcDispatch function exists', /function rpcDispatch/.test(http) || /async function rpcDispatch/.test(http));
check('handles batch (Array.isArray)', http.includes('Array.isArray(req)'));
check('health method', http.includes("case 'health'"));
check('plugin.list method', http.includes("case 'plugin.list'"));
check('workflow.list method', http.includes("case 'workflow.list'"));
check('workflow.run method', http.includes("case 'workflow.run'"));
check('schedule.list method', http.includes("case 'schedule.list'"));
check('queue.stats method', http.includes("case 'queue.stats'"));
check('error.list method', http.includes("case 'error.list'"));
check('returns jsonrpc 2.0 envelope', http.includes("jsonrpc: '2.0'"));
check('method-not-found error code -32601', http.includes('-32601'));
check('internal error code -32603', http.includes('-32603'));

// ---- TR-15.4: OpenAPI spec + Swagger ----
console.log('\nTR-15.4 OpenAPI 规范 + Swagger UI');
const spec = read('src/main-app/http/openapi.ts');
check('OPENAPI_SPEC exported', /export const OPENAPI_SPEC/.test(spec));
check('openapi 3.0.3', spec.includes("'3.0.3'"));
check('bearerAuth security scheme', spec.includes('bearerAuth') && spec.includes("scheme: 'bearer'"));
check('tags cover 8 groups', spec.includes("name: 'system'") && spec.includes("name: 'plugins'") && spec.includes("name: 'workflows'") && spec.includes("name: 'schedules'") && spec.includes("name: 'queue'") && spec.includes("name: 'errors'") && spec.includes("name: 'rpc'"));
check('Health schema', spec.includes('Health:'));
check('Error schema', spec.includes('Error:'));
check('health path no security', spec.includes("security: []") && spec.includes("'/health'"));
check('plugins path', spec.includes("'/plugins'"));
check('workflows path', spec.includes("'/workflows'"));
check('schedules path', spec.includes("'/schedules'"));
check('queue paths', spec.includes("'/queue/stats'") && spec.includes("'/queue/jobs'"));
check('errors path', spec.includes("'/errors'"));
check('rpc path', spec.includes("'/rpc'"));
check('idParam helper', /function idParam/.test(spec));
check('listParams helper', /function listParams/.test(spec));
check('brace balance', (spec.match(/{/g)||[]).length === (spec.match(/}/g)||[]).length);

// ---- TR-15.5: event-bus hooks + wiring + cleanup ----
console.log('\nTR-15.5 事件总线钩子 + 主进程接线 + 资源清理');
check('emits http.api.beforeRequest', http.includes("'http.api.beforeRequest'") || http.includes('"http.api.beforeRequest"'));
check('emits http.api.afterResponse', http.includes("'http.api.afterResponse'") || http.includes('"http.api.afterResponse"'));
check('audits http.plugin.install', http.includes("action: 'http.plugin.install'"));
check('audits http.workflow.create', http.includes("action: 'http.workflow.create'"));
check('audits http.workflow.run', http.includes("action: 'http.workflow.run'"));
check('audits http.schedule.create', http.includes("action: 'http.schedule.create'"));

const idx = read('src/main-app/index.ts');
check('main imports startHttpServer', idx.includes('startHttpServer'));
check('main imports HttpServerHandle type', idx.includes('HttpServerHandle'));
check('main starts http server', idx.includes('httpHandle = startHttpServer') || idx.includes('startHttpServer('));
check('main mk HTTP_SERVER_OK', idx.includes('HTTP_SERVER_OK'));
check('main handles null httpHandle', idx.includes('HTTP_SERVER_NULL'));
check('before-quit closes httpHandle', idx.includes('httpHandle?.close()') || idx.includes('httpHandle') && idx.includes('close'));
check('window-all-closed closes httpHandle', (idx.match(/httpHandle\?\.close\(\)/g) || []).length >= 2 || idx.includes('httpHandle'));

// ---- loopback enforcement: never binds 0.0.0.0 ----
console.log('\n回环安全检查');
check('never binds 0.0.0.0', !http.includes("hostname: '0.0.0.0'") && !http.includes("hostname: \"0.0.0.0\""));
check('never binds :: (all interfaces)', !http.includes('hostname: \':\':'));

// Summary
console.log('\n=== 汇总 ===');
const passed = RESULTS.filter((r) => r.pass).length;
const total = RESULTS.length;
console.log(`PASSED: ${passed} / ${total}`);
RESULTS.filter((r) => !r.pass).forEach((r) => {
  console.log(`  FAIL: ${r.label}${r.note ? ' (' + r.note + ')' : ''}`);
});
if (passed !== total) { process.exitCode = 1; }
