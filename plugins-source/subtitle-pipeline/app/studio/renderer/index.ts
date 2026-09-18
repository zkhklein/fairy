// @ts-nocheck
/**
 * subtitle-studio renderer — 任务列表 + 文件选择 + 语言覆盖 + 配置区。
 * UI 遵循 FMB 插件统一风格（与 baidu-netdisk-uploader 一致，规范见 project memory：
 * 紫主色 #5b21b6 / 灰阶面板 / 圆角徽章状态 / 三色通知横幅 / sectionHeader 分节）。
 * Renderer contract: host compiles to renderer.umd.js; AppPluginPage calls
 * module.exports.mount(container, hostUIApi). Plain DOM (no React).
 * hostUIApi.callPluginMainAction(action, payload) → sandbox main module.
 * window.fmb.dialogShowOpen → native file picker.
 */
var pollTimer = null;

module.exports = {
  mount(hostEl, hostApi) {
    var root = document.createElement('div');
    root.style.fontFamily = '-apple-system, "Segoe UI", sans-serif';
    root.style.padding = '12px';
    root.style.color = '#1f2937';

    /* ---- Notification banner（成功/失败/进行中 三色，自动消失） ---- */
    var notif = document.createElement('div');
    notif.style.cssText = 'display:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;margin-bottom:12px;';
    function showNotif(msg, type) {
      var color = type === 'error' ? '#fee2e2' : type === 'success' ? '#dcfce7' : '#dbeafe';
      var border = type === 'error' ? '#fca5a5' : type === 'success' ? '#86efac' : '#93c5fd';
      var text = type === 'error' ? '#991b1b' : type === 'success' ? '#166534' : '#1e40af';
      notif.style.background = color;
      notif.style.border = '1px solid ' + border;
      notif.style.color = text;
      notif.textContent = msg;
      notif.style.display = 'block';
      clearTimeout(notif._t);
      notif._t = setTimeout(function () { notif.style.display = 'none'; }, 5000);
    }
    function say(msg, isErr) { showNotif(msg, isErr ? 'error' : 'success'); }

    /* ---- Toolbar ---- */
    var toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap';

    var btnPick = document.createElement('button');
    btnPick.textContent = '＋ 选择媒体文件';
    btnPick.style.cssText = 'padding:8px 18px;background:#5b21b6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;';

    var langSel = document.createElement('select');
    langSel.title = '新任务的源语言';
    langSel.style.cssText = 'padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:#fff;';
    [['auto', '自动检测'], ['ja', '日语'], ['en', '英语']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; langSel.appendChild(op);
    });

    var btnCfg = document.createElement('button');
    btnCfg.textContent = '⚙ 配置';
    btnCfg.style.cssText = 'padding:8px 14px;background:#fff;color:#5b21b6;border:1px solid #c4b5fd;border-radius:6px;cursor:pointer;font-size:14px;';

    var statusMsg = document.createElement('span');
    statusMsg.style.cssText = 'font-size:13px;color:#6b7280;margin-left:auto;';

    toolbar.appendChild(btnPick);
    toolbar.appendChild(langSel);
    toolbar.appendChild(btnCfg);
    toolbar.appendChild(statusMsg);

    /* ---- Config panel ---- */
    var cfgPanel = document.createElement('div');
    cfgPanel.style.cssText = 'display:none;background:#fafafa;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;';

    function sectionHeader(title, hint) {
      var h = document.createElement('div');
      h.style.cssText = 'font-size:14px;font-weight:700;color:#1f2937;margin:4px 0 10px 0;padding-bottom:6px;border-bottom:2px solid #5b21b6;';
      var t = document.createElement('span');
      t.textContent = title;
      h.appendChild(t);
      if (hint) {
        var sp = document.createElement('div');
        sp.style.cssText = 'font-size:12px;font-weight:400;color:#6b7280;margin-top:4px;';
        sp.textContent = hint;
        h.appendChild(sp);
      }
      return h;
    }
    function cfgRow(label, value, placeholder, isPassword, isArea) {
      var row = document.createElement('div');
      row.style.marginBottom = '12px';
      var lbl = document.createElement('div');
      lbl.textContent = label;
      lbl.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:4px;color:#374151;';
      var input = document.createElement(isArea ? 'textarea' : 'input');
      if (!isArea) input.type = isPassword ? 'password' : 'text';
      if (isArea) input.rows = 3;
      input.value = value || '';
      input.placeholder = placeholder || '';
      input.style.cssText = 'width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;box-sizing:border-box;font-family:inherit;';
      row.appendChild(lbl);
      row.appendChild(input);
      return { row: row, input: input };
    }
    function checkRow(id, label, hint) {
      var wrap = document.createElement('label');
      wrap.style.cssText = 'display:block;margin-bottom:10px;font-size:13px;color:#374151;';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.id = id;
      box.style.marginRight = '6px';
      var span = document.createElement('span');
      span.textContent = label;
      wrap.appendChild(box);
      wrap.appendChild(span);
      if (hint) {
        var h = document.createElement('div');
        h.style.cssText = 'font-size:12px;color:#6b7280;margin:2px 0 0 22px;';
        h.textContent = hint;
        wrap.appendChild(h);
      }
      return { row: wrap, box: box };
    }

    /* Section 1: 翻译服务 */
    cfgPanel.appendChild(sectionHeader('翻译服务（DeepInfra）', 'API Key 在 deepinfra.com 创建，只显示一次；密钥仅存本机 secrets，不写入日志或诊断文件'));
    var rKey = cfgRow('API Key', '', '留空则不修改已保存的 Key', true);
    var keyState = document.createElement('div');
    keyState.style.cssText = 'font-size:12px;color:#6b7280;margin:-6px 0 12px 0;';
    cfgPanel.appendChild(rKey.row);
    cfgPanel.appendChild(keyState);
    var rModel = cfgRow('LLM 模型', '', '默认 Qwen/Qwen2.5-72B-Instruct', false);
    var rApiBase = cfgRow('API Base', '', '默认 https://api.deepinfra.com/v1/openai', false);
    cfgPanel.appendChild(rModel.row);
    cfgPanel.appendChild(rApiBase.row);
    var effective = document.createElement('div');
    effective.style.cssText = 'font-size:12px;color:#6b7280;margin:-6px 0 12px 0;';
    cfgPanel.appendChild(effective);
    var cReview = checkRow('fmb-cfg-review', '启用额外模型对齐复核', '增加 API 调用和费用；不能代替原音/人工校对');
    var cDiag = checkRow('fmb-cfg-diagnostics', '保留详细诊断', '含字幕原文、参考资料和模型响应；不含密钥；默认关闭');
    cfgPanel.appendChild(cReview.row);
    cfgPanel.appendChild(cDiag.row);

    /* Section 2: ASR 引擎（复用 PotPlayer 已下载的 Faster-Whisper-XXL） */
    cfgPanel.appendChild(sectionHeader('ASR 引擎', '留空则使用 PotPlayer 自带的引擎与模型（自动探测默认路径）'));
    var rWexe = cfgRow('Whisper 引擎路径', '', '例 %APPDATA%\\PotPlayerMini64\\Engine\\Faster-Whisper-XXL\\faster-whisper-xxl.exe', false);
    var rWmodel = cfgRow('Whisper 模型父目录', '', '例 %APPDATA%\\PotPlayerMini64\\Model', false);
    var cDiarize = checkRow('fmb-cfg-diarize', '说话人分离（对话类音频更准）', '识别 [SPEAKER_NN] 标记辅助翻译判断对话轮次；最终字幕不显示；单人/重叠语音自动降级；首次启用约多花几分钟下载模型（约 423MB，之后离线可用）');
    cfgPanel.appendChild(rWexe.row);
    cfgPanel.appendChild(rWmodel.row);

    /* Section 3: 运行环境 */
    cfgPanel.appendChild(sectionHeader('运行环境'));
    var rNode = cfgRow('Node.exe 路径', '', '留空 = C:\\Program Files\\nodejs\\node.exe', false);
    cfgPanel.appendChild(rNode.row);

    /* Section 4: 参考资料（术语表） */
    cfgPanel.appendChild(sectionHeader('参考资料（术语表）', '翻译时注入 prompt 作术语/风格参照；不会自动加载 SUCCUBUSQ 人格或知识库'));
    var rGlossary = cfgRow('术语表（直接粘贴 markdown）', '', '', false, true);
    var rGpaths = cfgRow('知识库文件路径（每行一个绝对路径；失效跳过不阻断）', '', 'D:\\BOAT\\SUCCUBUSQ\\knowledge\\terminology\\characters.md', false, true);
    cfgPanel.appendChild(rGlossary.row);
    cfgPanel.appendChild(rGpaths.row);
    var references = document.createElement('div');
    references.style.cssText = 'font-size:12px;color:#6b7280;margin:-6px 0 12px 0;';
    cfgPanel.appendChild(references);

    var note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:#6b7280;margin-bottom:12px;line-height:1.6;';
    note.textContent = '每次翻译均保留本地逐条对照报告（原文 + 译文）；任务删除不会删除报告，可按报告路径自行清理。';
    cfgPanel.appendChild(note);

    var saveCfgBtn = document.createElement('button');
    saveCfgBtn.textContent = '保存配置';
    saveCfgBtn.style.cssText = 'padding:8px 16px;background:#10b981;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;';
    cfgPanel.appendChild(saveCfgBtn);

    function loadConfigIntoPanel() {
      hostApi.callPluginMainAction('getConfig', {}).then(function (r) {
        keyState.textContent = r && r.hasApiKey ? '已配置 Key（输入新值可覆盖）' : '尚未配置 Key';
      }).catch(function () {});
      hostApi.callPluginMainAction('getAsrConfig', {}).then(function (r) {
        if (!r) return;
        rWexe.input.value = r.whisperExe || '';
        rWmodel.input.value = r.whisperModelDir || '';
        rNode.input.value = r.nodePath || '';
        cDiarize.box.checked = !!r.diarize;
      }).catch(function () {});
      hostApi.callPluginMainAction('getLlmConfig', {}).then(function (r) {
        if (!r) return;
        rModel.input.value = r.model || '';
        rApiBase.input.value = r.apiBase || '';
        effective.textContent = '当前配置（用于后续执行，非历史请求）：' + (r.effectiveModel || '未知') + ' · ' + (r.effectiveApiBase || '未知');
        cReview.box.checked = !!r.semanticReview;
        cDiag.box.checked = !!r.retainDiagnostics;
        rGlossary.input.value = r.glossary || '';
        rGpaths.input.value = (r.glossaryPaths || []).join('\n');
        references.textContent = '参考资料：粘贴文本 ' + ((r.glossary || '').trim() ? '已配置' : '未配置') + '；文件路径 ' + (r.glossaryPaths || []).length + ' 个（实际读取情况见每次报告）。';
      }).catch(function () {});
    }
    btnCfg.onclick = function () {
      cfgPanel.style.display = cfgPanel.style.display === 'none' ? 'block' : 'none';
      if (cfgPanel.style.display === 'block') loadConfigIntoPanel();
    };
    saveCfgBtn.onclick = function () {
      var v = rKey.input.value.trim();
      var gpaths = rGpaths.input.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var jobs = [];
      if (v) jobs.push(hostApi.callPluginMainAction('setConfig', { apiKey: v }));
      jobs.push(hostApi.callPluginMainAction('setAsrConfig', {
        whisperExe: rWexe.input.value,
        whisperModelDir: rWmodel.input.value,
        nodePath: rNode.input.value,
        diarize: cDiarize.box.checked,
      }));
      jobs.push(hostApi.callPluginMainAction('setLlmConfig', {
        model: rModel.input.value,
        apiBase: rApiBase.input.value,
        glossary: rGlossary.input.value,
        glossaryPaths: gpaths,
        semanticReview: cReview.box.checked,
        retainDiagnostics: cDiag.box.checked,
        nodePath: rNode.input.value,
      }));
      jobs.push(hostApi.callPluginMainAction('setWriterConfig', {
        nodePath: rNode.input.value,
      }));
      Promise.all(jobs).then(function () {
        rKey.input.value = '';
        say('配置已保存');
        loadConfigIntoPanel();
      }).catch(function (e) { say('保存失败: ' + (e.message || e), true); });
    };

    /* ---- Task list ---- */
    var listWrap = document.createElement('div');
    listWrap.style.overflowX = 'auto';

    var table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
    table.innerHTML = '<thead><tr style="background:#f3f4f6;">' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">文件</th>' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">状态</th>' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">语言</th>' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">结果 / 错误</th>' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">创建时间</th>' +
      '<th style="padding:10px;border-bottom:1px solid #e5e7eb;"></th>' +
      '</tr></thead><tbody></tbody>';
    var tbody = table.querySelector('tbody');
    listWrap.appendChild(table);

    var emptyHint = document.createElement('div');
    emptyHint.textContent = '暂无任务，点击「选择媒体文件」开始。';
    emptyHint.style.cssText = 'text-align:center;color:#9ca3af;padding:32px;font-size:14px;';
    listWrap.appendChild(emptyHint);

    var STATUS_META = {
      queued: { label: '排队中', color: '#6b7280' },
      asr: { label: '转写中', color: '#2563eb' },
      translating: { label: '翻译中', color: '#2563eb' },
      writing: { label: '写出中', color: '#2563eb' },
      done: { label: '已完成', color: '#16a34a' },
      failed: { label: '失败', color: '#dc2626' },
    };
    var LANG_TEXT = { auto: '自动', ja: '日语', en: '英语' };

    function fmtTime(ms) {
      if (!ms) return '-';
      var d = new Date(ms);
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function refreshTasks() {
      hostApi.callPluginMainAction('listTasks').then(function (r) {
        var tasks = (r && r.tasks) || [];
        tbody.innerHTML = '';
        if (!tasks.length) { emptyHint.style.display = 'block'; return; }
        emptyHint.style.display = 'none';
        tasks.forEach(function (t) {
          var meta = STATUS_META[t.status] || { label: t.status, color: '#6b7280' };
          var tr = document.createElement('tr');
          tr.style.borderBottom = '1px solid #f3f4f6';

          var tdName = document.createElement('td');
          tdName.style.padding = '10px';
          tdName.textContent = t.fileName || t.mediaPath || '(未知)';
          tdName.title = t.mediaPath || '';
          tr.appendChild(tdName);

          var tdStatus = document.createElement('td');
          tdStatus.style.padding = '10px';
          tdStatus.style.whiteSpace = 'nowrap';
          var badge = document.createElement('span');
          badge.textContent = meta.label;
          badge.style.cssText = 'display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600;color:#fff;background:' + meta.color + ';';
          if (t.error) badge.title = t.error;
          tdStatus.appendChild(badge);
          if (t.progressText) {
            var prog = document.createElement('div');
            prog.textContent = t.progressText;
            prog.style.cssText = 'margin-top:4px;font-size:11px;color:#9ca3af;';
            tdStatus.appendChild(prog);
          }
          tr.appendChild(tdStatus);

          var tdLang = document.createElement('td');
          tdLang.style.padding = '10px';
          var langText = LANG_TEXT[t.language || 'auto'] || t.language || '自动';
          if (t.sourceLang) langText += ' → ' + (t.sourceLang === 'unknown' ? '未识别' : t.sourceLang);
          var langTag = document.createElement('span');
          langTag.textContent = langText;
          langTag.style.cssText = 'padding:1px 6px;border-radius:8px;font-size:11px;background:#eef2ff;color:#4f46e5;';
          tdLang.appendChild(langTag);
          tr.appendChild(tdLang);

          var tdResult = document.createElement('td');
          tdResult.style.cssText = 'padding:10px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          var result = t.status === 'done' ? t.finalPath : (t.error || '');
          tdResult.textContent = result || '';
          tdResult.title = String(result || '');
          tdResult.style.color = t.status === 'failed' ? '#dc2626' : 'inherit';
          if (t.timelineWarnings && t.timelineWarnings.length) {
            var warningInfo = document.createElement('div');
            warningInfo.textContent = '时间轴警告：零时长 ID ' + t.timelineWarnings.map(function (w) { return w.id; }).join(', ') + '（已保留，需按原音核查）';
            warningInfo.title = t.timelineWarnings.map(function (w) { return 'ID ' + w.id + ': ' + w.start + ' → ' + w.end; }).join('\n');
            warningInfo.style.cssText = 'color:#9a5b00;font-size:12px;white-space:normal;';
            tdResult.appendChild(warningInfo);
          }
          if (t.model) {
            var modelInfo = document.createElement('div');
            modelInfo.textContent = '本次请求模型：' + t.model;
            modelInfo.style.cssText = 'font-size:11px;color:#9ca3af;white-space:normal;';
            tdResult.appendChild(modelInfo);
          }
          if (t.reviewPath) {
            var reportPath = document.createElement('input');
            reportPath.readOnly = true;
            reportPath.value = t.reviewPath;
            reportPath.title = '逐条对照报告：复制路径后在浏览器打开';
            reportPath.style.cssText = 'display:block;width:260px;font-size:11px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;margin:4px 0;color:#374151;';
            reportPath.onclick = function () { reportPath.select(); };
            tdResult.appendChild(reportPath);
          }
          tr.appendChild(tdResult);

          var tdTime = document.createElement('td');
          tdTime.style.padding = '10px';
          tdTime.textContent = fmtTime(t.createdAt);
          tr.appendChild(tdTime);

          var tdActions = document.createElement('td');
          tdActions.style.cssText = 'padding:10px;white-space:nowrap;';
          if (t.status === 'failed') {
            var retryLang = document.createElement('select');
            retryLang.title = '重试时明确源语言（自动识别缺失时选择日语或英语）';
            retryLang.style.cssText = 'padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;margin-right:6px;background:#fff;';
            [['auto', '自动'], ['ja', '日语'], ['en', '英语']].forEach(function (o) { var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; retryLang.appendChild(opt); });
            retryLang.value = t.language || 'auto';
            tdActions.appendChild(retryLang);
            var bRetry = document.createElement('button');
            bRetry.textContent = '重试';
            bRetry.style.cssText = 'padding:4px 10px;background:#fff;color:#5b21b6;border:1px solid #c4b5fd;border-radius:4px;cursor:pointer;font-size:12px;margin-right:6px;';
            bRetry.onclick = function () { hostApi.callPluginMainAction('retryTask', { taskId: t.taskId, language: retryLang.value }).then(refreshTasks).catch(function (e) { say('重试失败: ' + (e.message || e), true); }); };
            tdActions.appendChild(bRetry);
          }
          if (t.status === 'queued' || t.status === 'done' || t.status === 'failed') {
            var bDel = document.createElement('button');
            bDel.textContent = '删除';
            bDel.style.cssText = 'padding:4px 10px;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:4px;cursor:pointer;font-size:12px;';
            bDel.onclick = function () { hostApi.callPluginMainAction('deleteTask', { taskId: t.taskId }).then(refreshTasks).catch(function (e) { say('删除失败: ' + (e.message || e), true); }); };
            tdActions.appendChild(bDel);
          }
          tr.appendChild(tdActions);
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

    root.appendChild(notif);
    root.appendChild(toolbar);
    root.appendChild(cfgPanel);
    root.appendChild(listWrap);
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
