// TDD: 验证插件创建调度器崩溃修复 — 确保回调异步延迟到主进程事件循环
// RED 阶段：在修复前运行应全部 FAIL
// GREEN 阶段：修复后运行应全部 PASS
//
// 运行方式：node scripts/verify_schedule_crash_fix.cjs

const fs = require('fs');
const path = require('path');
const root = 'd:\\FAIRY';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || String(e))); fail++; }
}
function eq(a, b, why) { if (a !== b) throw new Error((why||'') + ` want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function inc(whole, part, why) { if (!String(whole).includes(String(part))) throw new Error((why||'') + ` missing: ${JSON.stringify(part)}`); }

const hostApiPath = path.join(root, 'src\\main-app\\core\\plugin\\host-api.ts');
const loaderPath = path.join(root, 'src\\main-app\\core\\plugin\\loader.ts');

const hostApi = fs.readFileSync(hostApiPath, 'utf8');
const loader = fs.readFileSync(loaderPath, 'utf8');

console.log('\n==== Phase A: HostApiServices 类型签名 ====\n');

t('A1: onCreateWorkflow 返回类型改为 Promise', () => {
  // 查找 onCreateWorkflow 的类型声明，应为 Promise<Record<string, unknown>>
  const m = hostApi.match(/onCreateWorkflow\?*\s*:*\s*\(.*?\)\s*=>\s*(\S+)/);
  eq(m !== null, true, 'A1 onCreateWorkflow type declaration found');
  inc(m[1], 'Promise', 'A1 onCreateWorkflow must return Promise (deferred to main process event loop)');
});

t('A2: onCreateSchedule 返回类型改为 Promise', () => {
  const m = hostApi.match(/onCreateSchedule\?*\s*:*\s*\(.*?\)\s*=>\s*(\S+)/);
  eq(m !== null, true, 'A2 onCreateSchedule type declaration found');
  inc(m[1], 'Promise', 'A2 onCreateSchedule must return Promise (deferred to main process event loop)');
});

t('A3: onToggleSchedule 返回类型改为 Promise', () => {
  const m = hostApi.match(/onToggleSchedule\?*\s*:*\s*\(.*?\)\s*=>\s*(\S+)/);
  eq(m !== null, true, 'A3 onToggleSchedule type declaration found');
  inc(m[1], 'Promise', 'A3 onToggleSchedule must return Promise');
});

console.log('\n==== Phase B: host-api.ts 中 await 回调 ====\n');

t('B1: workflows.create 中 await onCreateWorkflow', () => {
  // 查找 onCreateWorkflow 调用，前面应有 await
  const idx = hostApi.indexOf('svc.onCreateWorkflow(');
  eq(idx > 0, true, 'B1 onCreateWorkflow call found');
  // 检查 await 关键字（可能在前几行）
  const before = hostApi.slice(Math.max(0, idx - 20), idx);
  inc(before, 'await', 'B1 must await onCreateWorkflow to defer to main process event loop');
});

t('B2: schedules.create 中 await onCreateSchedule', () => {
  const idx = hostApi.indexOf('svc.onCreateSchedule(');
  eq(idx > 0, true, 'B2 onCreateSchedule call found');
  const before = hostApi.slice(Math.max(0, idx - 20), idx);
  inc(before, 'await', 'B2 must await onCreateSchedule to defer to main process event loop');
});

t('B3: schedules.toggle 中 await onToggleSchedule', () => {
  const idx = hostApi.indexOf('svc.onToggleSchedule(');
  eq(idx > 0, true, 'B3 onToggleSchedule call found');
  const before = hostApi.slice(Math.max(0, idx - 20), idx);
  inc(before, 'await', 'B3 must await onToggleSchedule');
});

console.log('\n==== Phase C: loader.ts 中 process.nextTick 延迟 ====\n');

t('C1: onCreateWorkflow 回调包装了 process.nextTick 或 setImmediate', () => {
  // 查找 onCreateWorkflow 在 loader.ts 中的实现
  const idx = loader.indexOf('onCreateWorkflow:');
  eq(idx > 0, true, 'C1 onCreateWorkflow implementation found in loader');
  const body = loader.slice(idx, idx + 500);
  const hasDefer = body.includes('process.nextTick') || body.includes('setImmediate') || body.includes('new Promise');
  eq(hasDefer, true, 'C1 onCreateWorkflow must defer execution via process.nextTick/setImmediate/Promise');
});

t('C2: onCreateSchedule 回调包装了 process.nextTick 或 setImmediate', () => {
  const idx = loader.indexOf('onCreateSchedule:');
  eq(idx > 0, true, 'C2 onCreateSchedule implementation found in loader');
  const body = loader.slice(idx, idx + 500);
  const hasDefer = body.includes('process.nextTick') || body.includes('setImmediate') || body.includes('new Promise');
  eq(hasDefer, true, 'C2 onCreateSchedule must defer execution via process.nextTick/setImmediate/Promise');
});

t('C3: onToggleSchedule 回调包装了 process.nextTick 或 setImmediate', () => {
  const idx = loader.indexOf('onToggleSchedule:');
  eq(idx > 0, true, 'C3 onToggleSchedule implementation found in loader');
  const body = loader.slice(idx, idx + 500);
  const hasDefer = body.includes('process.nextTick') || body.includes('setImmediate') || body.includes('new Promise');
  eq(hasDefer, true, 'C3 onToggleSchedule must defer execution via process.nextTick/setImmediate/Promise');
});

console.log('\n==== Phase D: 错误处理 ====\n');

t('D1: onCreateSchedule 回调有 try-catch 包裹，错误不导致进程崩溃', () => {
  const idx = loader.indexOf('onCreateSchedule:');
  eq(idx > 0, true, 'D1 onCreateSchedule found');
  const body = loader.slice(idx, idx + 800);
  const hasTryCatch = body.includes('try') && body.includes('catch');
  eq(hasTryCatch, true, 'D1 onCreateSchedule must have try-catch to prevent process crash');
});

t('D2: onCreateWorkflow 回调有 try-catch 包裹', () => {
  const idx = loader.indexOf('onCreateWorkflow:');
  eq(idx > 0, true, 'D2 onCreateWorkflow found');
  const body = loader.slice(idx, idx + 800);
  const hasTryCatch = body.includes('try') && body.includes('catch');
  eq(hasTryCatch, true, 'D2 onCreateWorkflow must have try-catch');
});

// ---------- summary ----------
const total = pass + fail;
console.log(`\n── ${pass}/${total} passed${fail>0?' —— '+fail+' FAILURES ❌':' —— ALL GREEN ✅'}`);
process.exit(fail === 0 ? 0 : 1);
