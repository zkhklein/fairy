// @ts-nocheck
/**
 * subtitle-studio renderer — 任务列表 + 文件选择 + 语言覆盖 + 配置区。
 * Renderer contract: host compiles to renderer.umd.js; AppPluginPage calls
 * module.exports.mount(container, hostUIApi). Plain DOM (no React).
 * hostUIApi.callPluginMainAction(action, payload) → sandbox main module.
 * window.fmb.dialogShowOpen → native file picker.
 */
var pollTimer = null;

module.exports = {
  mount(hostEl, hostApi) {
    var root = document.createElement('div');
    root.style.cssText = 'font-family:-apple-system,system-ui,sans-serif;padding:16px;color:var(--fmb-text,#222)';

    var h2 = document.createElement('h2');
    h2.textContent = '字幕工坊';
    h2.style.cssText = 'margin:0 0 12px';
    root.appendChild(h2);

    var statusMsg = document.createElement('div');
    statusMsg.style.cssText = 'margin:8px 0;min-height:20px;font-size:13px;color:#666';
    function say(msg, isErr) { statusMsg.textContent = msg; statusMsg.style.color = isErr ? '#c00' : '#060'; }

    /* ---- toolbar ---- */
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap';

    var btnPick = document.createElement('button');
    btnPick.textContent = '选择媒体文件';
    btnPick.style.cssText = 'padding:6px 14px;cursor:pointer';

    var langSel = document.createElement('select');
    langSel.style.cssText = 'padding:5px';
    [['auto', '自动检测'], ['ja', '日语'], ['en', '英语']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; langSel.appendChild(op);
    });

    var btnCfg = document.createElement('button');
    btnCfg.textContent = '配置';
    btnCfg.style.cssText = 'padding:6px 14px;cursor:pointer';

    bar.appendChild(btnPick); bar.appendChild(langSel); bar.appendChild(btnCfg);
    root.appendChild(bar);
    root.appendChild(statusMsg);

    /* ---- config panel (collapsed) ---- */
    var cfgBox = document.createElement('div');
    cfgBox.style.cssText = 'display:none;border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:12px;font-size:13px';
    cfgBox.innerHTML =
      '<div style="margin-bottom:6px;font-weight:600">DeepInfra API Key（<a href="https://deepinfra.com" target="_blank">deepinfra.com</a> 创建，只显示一次）</div>' +
      '<input id="fmb-cfg-key" type="password" placeholder="留空则不修改" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:4px">' +
      '<div id="fmb-cfg-key-state" style="color:#888;margin-bottom:10px"></div>' +
      '<div style="margin-bottom:4px">LLM 模型</div><input id="fmb-cfg-model" placeholder="默认 Qwen/Qwen2.5-72B-Instruct" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="margin-bottom:4px">API Base</div><input id="fmb-cfg-apibase" placeholder="默认 https://api.deepinfra.com/v1/openai" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div id="fmb-cfg-effective" style="margin-bottom:10px;color:#555"></div>' +
      '<label style="display:block;margin-bottom:8px"><input id="fmb-cfg-review" type="checkbox"> 启用额外模型对齐复核（增加 API 调用和费用；不能代替原音/人工校对）</label>' +
      '<label style="display:block;margin-bottom:8px"><input id="fmb-cfg-diagnostics" type="checkbox"> 保留详细诊断（含字幕原文、参考资料和模型响应；不含密钥；默认关闭）</label>' +
      '<div style="margin-bottom:10px;color:#666">每次翻译均保留本地逐条对照报告，包含原文和译文；任务删除不会删除报告，可按报告路径自行清理。</div>' +
      '<div style="margin-bottom:4px">Whisper 引擎路径（留空=PotPlayer 默认）</div><input id="fmb-cfg-wexe" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="margin-bottom:4px">Whisper 模型父目录（留空=PotPlayer 默认 %APPDATA%\\PotPlayerMini64\\Model）</div><input id="fmb-cfg-wmodel" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="margin-bottom:4px">Node.exe 路径（留空=C:\\Program Files\\nodejs\\node.exe）</div><input id="fmb-cfg-node" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="margin-bottom:4px">术语表（可选，直接粘贴 markdown）</div><textarea id="fmb-cfg-glossary" rows="3" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px"></textarea>' +
      '<div style="margin-bottom:4px">知识库文件路径（可选，每行一个绝对路径；失效跳过不阻断）</div><textarea id="fmb-cfg-gpaths" rows="3" placeholder="D:\\BOAT\\SUCCUBUSQ\\knowledge\\terminology\\characters.md" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:10px"></textarea>' +
      '<div id="fmb-cfg-references" style="margin-bottom:10px;color:#555"></div>' +
      '<button id="fmb-cfg-save" style="padding:6px 14px;cursor:pointer">保存配置</button>';
    root.appendChild(cfgBox);

    function loadConfigIntoPanel() {
      hostApi.callPluginMainAction('getConfig', {}).then(function (r) {
        cfgBox.querySelector('#fmb-cfg-key-state').textContent = r && r.hasApiKey ? '已配置 Key（输入新值可覆盖）' : '尚未配置 Key';
      }).catch(function () {});
      hostApi.callPluginMainAction('getAsrConfig', {}).then(function (r) {
        if (!r) return;
        cfgBox.querySelector('#fmb-cfg-wexe').value = r.whisperExe || '';
        cfgBox.querySelector('#fmb-cfg-wmodel').value = r.whisperModelDir || '';
        cfgBox.querySelector('#fmb-cfg-node').value = r.nodePath || '';
      }).catch(function () {});
      hostApi.callPluginMainAction('getLlmConfig', {}).then(function (r) {
        if (!r) return;
        cfgBox.querySelector('#fmb-cfg-model').value = r.model || '';
        cfgBox.querySelector('#fmb-cfg-apibase').value = r.apiBase || '';
        cfgBox.querySelector('#fmb-cfg-effective').textContent = '当前配置（用于后续执行，非历史请求）：' + (r.effectiveModel || '未知') + ' · ' + (r.effectiveApiBase || '未知');
        cfgBox.querySelector('#fmb-cfg-review').checked = !!r.semanticReview;
        cfgBox.querySelector('#fmb-cfg-diagnostics').checked = !!r.retainDiagnostics;
        cfgBox.querySelector('#fmb-cfg-glossary').value = r.glossary || '';
        cfgBox.querySelector('#fmb-cfg-gpaths').value = (r.glossaryPaths || []).join('\n');
        cfgBox.querySelector('#fmb-cfg-references').textContent = '参考资料：粘贴文本 ' + ((r.glossary || '').trim() ? '已配置' : '未配置') + '；文件路径 ' + (r.glossaryPaths || []).length + ' 个（实际读取情况见每次报告）。不会自动加载 SUCCUBUSQ 人格或知识库。';
      }).catch(function () {});
    }
    btnCfg.onclick = function () {
      cfgBox.style.display = cfgBox.style.display === 'none' ? 'block' : 'none';
      if (cfgBox.style.display === 'block') loadConfigIntoPanel();
    };
    cfgBox.querySelector('#fmb-cfg-save').onclick = function () {
      var v = cfgBox.querySelector('#fmb-cfg-key').value.trim();
      var gpaths = cfgBox.querySelector('#fmb-cfg-gpaths').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var jobs = [];
      if (v) jobs.push(hostApi.callPluginMainAction('setConfig', { apiKey: v }));
      jobs.push(hostApi.callPluginMainAction('setAsrConfig', {
        whisperExe: cfgBox.querySelector('#fmb-cfg-wexe').value,
        whisperModelDir: cfgBox.querySelector('#fmb-cfg-wmodel').value,
        nodePath: cfgBox.querySelector('#fmb-cfg-node').value,
      }));
      jobs.push(hostApi.callPluginMainAction('setLlmConfig', {
        model: cfgBox.querySelector('#fmb-cfg-model').value,
        apiBase: cfgBox.querySelector('#fmb-cfg-apibase').value,
        glossary: cfgBox.querySelector('#fmb-cfg-glossary').value,
        glossaryPaths: gpaths,
        semanticReview: cfgBox.querySelector('#fmb-cfg-review').checked,
        retainDiagnostics: cfgBox.querySelector('#fmb-cfg-diagnostics').checked,
        nodePath: cfgBox.querySelector('#fmb-cfg-node').value,
      }));
      jobs.push(hostApi.callPluginMainAction('setWriterConfig', {
        nodePath: cfgBox.querySelector('#fmb-cfg-node').value,
      }));
      Promise.all(jobs).then(function () {
        cfgBox.querySelector('#fmb-cfg-key').value = '';
        say('配置已保存');
        loadConfigIntoPanel();
      }).catch(function (e) { say('保存失败: ' + (e.message || e), true); });
    };

    /* ---- task table ---- */
    var table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px';
    table.innerHTML = '<thead><tr>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">文件</th>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">语言</th>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">状态</th>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">进度</th>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">结果 / 错误</th>' +
      '<th style="border-bottom:1px solid #ddd;padding:6px"></th>' +
      '</tr></thead><tbody></tbody>';
    root.appendChild(table);
    var tbody = table.querySelector('tbody');

    var STATUS_TEXT = { queued: '排队中', asr: '转写中', translating: '翻译中', writing: '写出中', done: '完成', failed: '失败' };

    function refreshTasks() {
      hostApi.callPluginMainAction('listTasks').then(function (r) {
        var tasks = (r && r.tasks) || [];
        tbody.innerHTML = '';
        if (!tasks.length) {
          var tr0 = document.createElement('tr');
          tr0.innerHTML = '<td colspan="6" style="padding:18px;color:#999;text-align:center">暂无任务——点击「选择媒体文件」开始</td>';
          tbody.appendChild(tr0); return;
        }
        tasks.forEach(function (t) {
          var tr = document.createElement('tr');
          var result = t.status === 'done' ? t.finalPath : (t.error || '');
          tr.innerHTML =
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0"></td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0">' + ({ auto: '自动', ja: '日语', en: '英语' })[t.language || 'auto'] + '</td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0">' + (STATUS_TEXT[t.status] || t.status) + '</td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0"></td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right"></td>';
          tr.children[0].textContent = t.fileName || t.mediaPath;
          tr.children[0].title = t.mediaPath || '';
          tr.children[1].textContent = ({ auto: '自动', ja: '日语', en: '英语' })[t.language || 'auto'] + (t.sourceLang ? ' → ' + (t.sourceLang === 'unknown' ? '未识别' : t.sourceLang) : '');
          tr.children[3].textContent = t.progressText || '';
          tr.children[4].textContent = result || '';
          tr.children[4].title = String(result || '');
          tr.children[4].style.color = t.status === 'failed' ? '#c00' : 'inherit';
          if (t.timelineWarnings && t.timelineWarnings.length) {
            var warningInfo = document.createElement('div');
            warningInfo.textContent = '时间轴警告：零时长 ID ' + t.timelineWarnings.map(function (w) { return w.id; }).join(', ') + '（已保留，需按原音核查）';
            warningInfo.title = t.timelineWarnings.map(function (w) { return 'ID ' + w.id + ': ' + w.start + ' → ' + w.end; }).join('\n');
            warningInfo.style.cssText = 'color:#9a5b00;font-size:12px;white-space:normal'; tr.children[4].appendChild(warningInfo);
          }
          if (t.model) {
            var modelInfo = document.createElement('div'); modelInfo.textContent = '本次请求模型：' + t.model; modelInfo.style.fontSize = '12px'; tr.children[4].appendChild(modelInfo);
          }
          var ops = tr.children[5];
          if (t.reviewPath) {
            var reportPath = document.createElement('input'); reportPath.readOnly = true; reportPath.value = t.reviewPath;
            reportPath.title = '逐条对照报告：复制路径后在浏览器打开'; reportPath.style.cssText = 'display:block;width:240px;font-size:12px;margin:4px 0';
            reportPath.onclick = function () { reportPath.select(); }; tr.children[4].appendChild(reportPath);
          }
          if (t.status === 'failed') {
            var retryLang = document.createElement('select');
            [['auto', '自动'], ['ja', '日语'], ['en', '英语']].forEach(function (o) { var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; retryLang.appendChild(opt); });
            retryLang.value = t.language || 'auto'; retryLang.title = '重试时明确源语言（自动识别缺失时选择日语或英语）'; ops.appendChild(retryLang);
            var bRetry = document.createElement('button');
            bRetry.textContent = '重试'; bRetry.style.cssText = 'padding:2px 10px;cursor:pointer;margin-right:6px';
            bRetry.onclick = function () { hostApi.callPluginMainAction('retryTask', { taskId: t.taskId, language: retryLang.value }).then(refreshTasks).catch(function (e) { say('重试失败: ' + (e.message || e), true); }); };
            ops.appendChild(bRetry);
          }
          if (t.status === 'queued' || t.status === 'done' || t.status === 'failed') {
            var bDel = document.createElement('button');
            bDel.textContent = '删除'; bDel.style.cssText = 'padding:2px 10px;cursor:pointer';
            bDel.onclick = function () { hostApi.callPluginMainAction('deleteTask', { taskId: t.taskId }).then(refreshTasks).catch(function (e) { say('删除失败: ' + (e.message || e), true); }); };
            ops.appendChild(bDel);
          }
          tbody.appendChild(tr);
        });
      }).catch(function (e) { say('刷新失败: ' + (e.message || e), true); });
    }

    btnPick.onclick = function () {
      window.fmb.dialogShowOpen({
        title: '选择视频/音频文件', multiSelections: true, openFile: true, openDirectory: false,
        filters: [{ name: '媒体文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg'] }],
      }).then(function (r) {
        /* dialogShowOpen 返回 { canceled, filePaths }（MainDialogShowOpenResult 契约） */
        var paths = (r && Array.isArray(r.filePaths)) ? r.filePaths : [];
        if (r && r.canceled) return;
        if (!paths.length) { say('未选择任何文件', true); return; }
        hostApi.callPluginMainAction('createTasks', { paths: paths, language: langSel.value }).then(function (res) {
          say('已添加 ' + (res && res.added != null ? res.added : paths.length) + ' 个任务');
          refreshTasks();
        }).catch(function (e) { say('添加失败: ' + (e.message || e), true); });
      }).catch(function () {});
    };

    hostEl.appendChild(root);
    refreshTasks();
    pollTimer = setInterval(refreshTasks, 5000);
  },

  unmount: function () {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
};
