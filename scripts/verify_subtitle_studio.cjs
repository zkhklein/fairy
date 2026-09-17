const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const ROOT = path.resolve(__dirname, '..');
function plugin(relative, values = {}) {
  const kv = new Map(Object.entries(values));
  const code = esbuild.buildSync({ entryPoints: [path.join(ROOT, 'plugins-source/subtitle-pipeline', relative, 'main.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, hostApi: {
    kv: { get: async k => kv.get(k), set: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) },
    secrets: { get: async () => null },
  } });
  return { api: module.exports, kv };
}
test('settings expose effective future-run model and opt-in controls', async () => {
  const { api } = plugin('atomic/llmtranslate');
  let cfg = await api.getConfig();
  assert.equal(cfg.effectiveModel, 'Qwen/Qwen2.5-72B-Instruct');
  assert.equal(cfg.semanticReview, false); assert.equal(cfg.retainDiagnostics, false);
  await api.setConfig({ model: 'custom-model', semanticReview: true, retainDiagnostics: true, glossaryPaths: ['C:/reference.md'] });
  cfg = await api.getConfig();
  assert.equal(cfg.effectiveModel, 'custom-model'); assert.equal(cfg.semanticReview, true);
  assert.equal(cfg.retainDiagnostics, true); assert.equal(cfg.glossaryPaths.length, 1);
});
test('retry may explicitly override unknown language; running tasks cannot retry', async () => {
  const { api, kv } = plugin('app/studio', { tasks: JSON.stringify([{ taskId: 'a', status: 'failed', language: 'auto' }, { taskId: 'b', status: 'asr', language: 'en' }]) });
  await api.retryTask({ taskId: 'a', language: 'ja' });
  assert.equal(JSON.parse(kv.get('tasks'))[0].language, 'ja');
  await assert.rejects(api.retryTask({ taskId: 'b' }), /执行/);
});
test('Studio retains task-specific review path and actual requested model', async () => {
  const { api, kv } = plugin('app/studio', { tasks: JSON.stringify([{ taskId: 'a', status: 'translating' }]) });
  await api.storeProgress({ taskId: 'a', reviewPath: 'C:/data/subtitle-reviews/run/review.html', model: 'actual-request-model', sourceLang: 'ja', timelineWarnings: [{ code: 'zero_duration', id: 45, start: '00:05:44,340', end: '00:05:44,340' }] });
  const task = JSON.parse(kv.get('tasks'))[0];
  assert.equal(task.reviewPath, 'C:/data/subtitle-reviews/run/review.html');
  assert.equal(task.model, 'actual-request-model'); assert.equal(task.sourceLang, 'ja');
  assert.equal(task.timelineWarnings[0].id, 45);
});
