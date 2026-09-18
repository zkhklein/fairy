/**
 * com.fmb.baidunetdisk.uploader — renderer.
 *
 * Plain-DOM UI (no React) inside the host Shadow DOM. Uses:
 *   - hostApi.callPluginMainAction(action, payload) → sandbox main module
 *   - window.fmb.dialogShowOpen(...)                 → native file picker
 *   - navigator.clipboard.writeText(...)             → copy identity info
 *
 * Layout:
 *   ┌─ Toolbar: [添加任务]  [配置 ▾] ─────────────────────┐
 *   ├─ Config panel (collapsible)                         │
 *   └─ Task list table                                    │
 */
module.exports = {
  mount(hostEl, hostApi) {
    var root = document.createElement('div');
    root.style.fontFamily = '-apple-system, "Segoe UI", sans-serif';
    root.style.padding = '12px';
    root.style.color = '#1f2937';

    // ---- State ----
    var tasks = [];
    var config = null;
    var configOpen = false;
    var refreshTimer = null;

    // ---- Toolbar ----
    var toolbar = document.createElement('div');
    toolbar.style.display = 'flex';
    toolbar.style.alignItems = 'center';
    toolbar.style.gap = '12px';
    toolbar.style.marginBottom = '12px';

    var addBtn = document.createElement('button');
    addBtn.textContent = '＋ 添加任务';
    addBtn.style.cssText = 'padding:8px 18px;background:#5b21b6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;';

    var cfgBtn = document.createElement('button');
    cfgBtn.textContent = '⚙ 配置';
    cfgBtn.style.cssText = 'padding:8px 14px;background:#fff;color:#5b21b6;border:1px solid #c4b5fd;border-radius:6px;cursor:pointer;font-size:14px;';

    var statusMsg = document.createElement('span');
    statusMsg.style.fontSize = '13px';
    statusMsg.style.color = '#6b7280';
    statusMsg.style.marginLeft = 'auto';

    // ---- Notification banner (prominent, auto-dismiss) ----
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
      notif._t = setTimeout(function () { notif.style.display = 'none'; }, type === 'loading' ? 60000 : 5000);
    }

    toolbar.appendChild(addBtn);
    toolbar.appendChild(cfgBtn);
    toolbar.appendChild(statusMsg);

    // ---- Config panel ----
    var cfgPanel = document.createElement('div');
    cfgPanel.style.cssText = 'display:none;background:#fafafa;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;';

    function cfgRow(label, value, placeholder, isPassword) {
      var row = document.createElement('div');
      row.style.marginBottom = '12px';
      var lbl = document.createElement('div');
      lbl.textContent = label;
      lbl.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:4px;color:#374151;';
      var input = document.createElement('input');
      input.type = isPassword ? 'password' : 'text';
      input.value = value || '';
      input.placeholder = placeholder || '';
      input.style.cssText = 'width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;box-sizing:border-box;';
      row.appendChild(lbl);
      row.appendChild(input);
      return { row: row, input: input };
    }

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

    // ---- Section 1: 路径配置 ----
    cfgPanel.appendChild(sectionHeader('路径配置'));
    var rSeven = cfgRow('7-Zip 路径', '', 'C:\\Program Files\\7-Zip\\7z.exe', false);
    var rNode = cfgRow('Node.js 路径', '', 'C:\\Program Files\\nodejs\\node.exe', false);
    var rRemote = cfgRow('远程根目录', '', '/apps/', false);
    var rWork = cfgRow('本地工作目录', '', '%LOCALAPPDATA%\\fairy-maid-brigade\\baidu-uploader', false);
    var rConc = cfgRow('上传并发数', '', '默认 4，范围 1-16（分片并行上传数）', false);
    [rSeven, rNode, rRemote, rWork, rConc].forEach(function (r) { cfgPanel.appendChild(r.row); });

    // ---- Section 2: 授权配置（OAuth API Key）----
    cfgPanel.appendChild(sectionHeader('授权配置', '使用百度网盘开放平台 OAuth 2.0 授权，文件上传到 /apps/ 目录下'));

    // OAuth API 面板
    var panelOauth = document.createElement('div');
    panelOauth.style.cssText = 'padding:12px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;margin-bottom:12px;';
    var rAppId = cfgRow('百度网盘 AppID', '', '应用 ID（选填）', false);
    var rAppKey = cfgRow('百度网盘 AppKey (API Key)', '', '开放平台 AppKey', false);
    var rSecret = cfgRow('百度网盘 SecretKey', '', '开放平台 SecretKey', true);
    var rSign = cfgRow('百度网盘 SignKey', '', '开放平台 SignKey（选填）', false);
    [rAppId, rAppKey, rSecret, rSign].forEach(function (r) { panelOauth.appendChild(r.row); });

    // OAuth authorization section（嵌套在 OAuth 面板内）
    var authDiv = document.createElement('div');
    authDiv.style.cssText = 'margin-top:12px;padding:12px;background:#fff;border:1px solid #c7d2fe;border-radius:8px;';
    var authTitle = document.createElement('div');
    authTitle.textContent = '百度网盘授权（OAuth 2.0）';
    authTitle.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px;color:#3730a3;';
    var authHint = document.createElement('div');
    authHint.innerHTML = '1. 填入 AppKey / SecretKey 后保存配置<br>2. 点击下方按钮打开百度授权页，登录并授权<br>3. 复制页面上显示的授权码，粘贴到输入框，点「确认授权」';
    authHint.style.cssText = 'font-size:12px;color:#4b5563;line-height:1.6;margin-bottom:10px;';
    var authBtnRow = document.createElement('div');
    authBtnRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
    var openAuthBtn = document.createElement('button');
    openAuthBtn.textContent = '打开百度授权页';
    openAuthBtn.style.cssText = 'padding:6px 14px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;';
    var codeInput = document.createElement('input');
    codeInput.placeholder = '粘贴授权码 (code)';
    codeInput.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;';
    var confirmAuthBtn = document.createElement('button');
    confirmAuthBtn.textContent = '确认授权';
    confirmAuthBtn.style.cssText = 'padding:6px 14px;background:#10b981;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;';
    authBtnRow.appendChild(openAuthBtn);
    authBtnRow.appendChild(codeInput);
    authBtnRow.appendChild(confirmAuthBtn);
    authDiv.appendChild(authTitle);
    authDiv.appendChild(authHint);
    authDiv.appendChild(authBtnRow);
    panelOauth.appendChild(authDiv);
    cfgPanel.appendChild(panelOauth);

    var saveCfgBtn = document.createElement('button');
    saveCfgBtn.textContent = '保存配置';
    saveCfgBtn.style.cssText = 'padding:8px 16px;background:#10b981;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;margin-top:12px;';
    cfgPanel.appendChild(saveCfgBtn);

    // ---- Task list ----
    var listWrap = document.createElement('div');
    listWrap.style.overflowX = 'auto';

    var table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
    table.innerHTML = '<thead><tr style="background:#f3f4f6;">' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">任务名</th>' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">状态</th>' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">压缩文件名</th>' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">创建时间</th>' +
      '<th style="padding:10px;text-align:left;border-bottom:1px solid #e5e7eb;">操作</th>' +
      '</tr></thead><tbody></tbody>';
    var tbody = table.querySelector('tbody');
    listWrap.appendChild(table);

    var emptyHint = document.createElement('div');
    emptyHint.textContent = '暂无任务，点击「添加任务」开始。';
    emptyHint.style.cssText = 'text-align:center;color:#9ca3af;padding:32px;font-size:14px;';
    listWrap.appendChild(emptyHint);

    root.appendChild(notif);
    root.appendChild(toolbar);
    root.appendChild(cfgPanel);
    root.appendChild(listWrap);
    hostEl.appendChild(root);

    // ---- Status label mapping ----
    var STATUS_META = {
      pending: { label: '等待中', color: '#6b7280' },
      compressing: { label: '压缩中', color: '#2563eb' },
      compressed: { label: '压缩完成', color: '#2563eb' },
      uploading: { label: '上传中', color: '#2563eb' },
      uploaded: { label: '上传完成', color: '#2563eb' },
      completed: { label: '已完成', color: '#16a34a' },
      paused: { label: '已暂停', color: '#d97706' },
      aborted_recoverable: { label: '可恢复中止', color: '#ea580c' },
      aborted_unrecoverable: { label: '不可恢复中止', color: '#dc2626' },
    };

    function fmtTime(ms) {
      if (!ms) return '-';
      var d = new Date(ms);
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function renderTasks() {
      tbody.innerHTML = '';
      if (tasks.length === 0) {
        emptyHint.style.display = 'block';
        return;
      }
      emptyHint.style.display = 'none';
      tasks.forEach(function (t) {
        var meta = STATUS_META[t.status] || { label: t.status, color: '#6b7280' };
        var tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #f3f4f6';

        var tdName = document.createElement('td');
        tdName.style.padding = '10px';
        tdName.textContent = t.displayName || t.sourcePath || '(未知)';
        tdName.title = t.sourcePath || '';
        if (t.level && t.level !== 'normal') {
          var lvTag = document.createElement('span');
          var lvLabels = { store: '仅存储', fastest: '极速', max: '最大' };
          lvTag.textContent = lvLabels[t.level] || t.level;
          lvTag.style.cssText = 'margin-left:6px;padding:1px 6px;border-radius:8px;font-size:11px;background:#eef2ff;color:#4f46e5;';
          tdName.appendChild(lvTag);
        }

        var tdStatus = document.createElement('td');
        tdStatus.style.padding = '10px';
        var badge = document.createElement('span');
        badge.textContent = meta.label;
        badge.style.cssText = 'display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600;color:#fff;background:' + meta.color + ';';
        if (t.error) badge.title = t.error;
        tdStatus.appendChild(badge);
        // Lightweight liveness hint (from listTasks progressText) — shows the
        // task is alive without precise progress tracking.
        if (t.progressText) {
          var prog = document.createElement('div');
          prog.textContent = t.progressText;
          prog.style.cssText = 'margin-top:4px;font-size:11px;color:#9ca3af;';
          tdStatus.appendChild(prog);
        }

        var tdId = document.createElement('td');
        tdId.style.padding = '10px';
        tdId.style.fontFamily = 'monospace';
        tdId.textContent = t.randomId || '-';

        var tdTime = document.createElement('td');
        tdTime.style.padding = '10px';
        tdTime.textContent = fmtTime(t.createdAt || t._createdAt);

        var tdActions = document.createElement('td');
        tdActions.style.padding = '10px';
        tdActions.style.whiteSpace = 'nowrap';

        // Copy identity button
        var copyBtn = document.createElement('button');
        copyBtn.textContent = '复制身份信息';
        copyBtn.style.cssText = 'padding:4px 10px;background:#fff;color:#5b21b6;border:1px solid #c4b5fd;border-radius:4px;cursor:pointer;font-size:12px;margin-right:6px;';
        copyBtn.onclick = function () {
          var text = '压缩文件名：' + (t.randomId || '') + '\n密钥：' + (t.password || '');
          navigator.clipboard.writeText(text).then(function () {
            copyBtn.textContent = '已复制 ✓';
            setTimeout(function () { copyBtn.textContent = '复制身份信息'; }, 1500);
          }).catch(function () {
            // Fallback for non-secure context
            var ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); copyBtn.textContent = '已复制 ✓'; } catch (_) {}
            document.body.removeChild(ta);
            setTimeout(function () { copyBtn.textContent = '复制身份信息'; }, 1500);
          });
        };
        tdActions.appendChild(copyBtn);

        // Pause / Resume / Delete
        var running = t.status === 'compressing' || t.status === 'uploading';
        var canResume = t.status === 'paused' || t.status === 'aborted_recoverable';
        if (running) {
          var pauseBtn = document.createElement('button');
          pauseBtn.textContent = '暂停';
          pauseBtn.style.cssText = 'padding:4px 10px;background:#fff;color:#d97706;border:1px solid #fcd34d;border-radius:4px;cursor:pointer;font-size:12px;margin-right:6px;';
          pauseBtn.onclick = function () {
            hostApi.callPluginMainAction('pauseTask', { taskId: t._id }).then(refreshTasks).catch(function (e) { statusMsg.textContent = '暂停失败: ' + (e.message || e); });
          };
          tdActions.appendChild(pauseBtn);
        } else if (canResume) {
          var resumeBtn = document.createElement('button');
          resumeBtn.textContent = '恢复';
          resumeBtn.style.cssText = 'padding:4px 10px;background:#fff;color:#16a34a;border:1px solid #86efac;border-radius:4px;cursor:pointer;font-size:12px;margin-right:6px;';
          resumeBtn.onclick = function () {
            hostApi.callPluginMainAction('resumeTask', { taskId: t._id }).then(refreshTasks).catch(function (e) { statusMsg.textContent = '恢复失败: ' + (e.message || e); });
          };
          tdActions.appendChild(resumeBtn);
        }

        var delBtn = document.createElement('button');
        delBtn.textContent = '删除';
        delBtn.style.cssText = 'padding:4px 10px;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:4px;cursor:pointer;font-size:12px;';
        delBtn.onclick = function () {
          if (!confirm('确定删除任务「' + (t.displayName || '') + '」？')) return;
          hostApi.callPluginMainAction('deleteTask', { taskId: t._id }).then(refreshTasks).catch(function (e) { statusMsg.textContent = '删除失败: ' + (e.message || e); });
        };
        tdActions.appendChild(delBtn);

        tr.appendChild(tdName);
        tr.appendChild(tdStatus);
        tr.appendChild(tdId);
        tr.appendChild(tdTime);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);
      });
    }

    function refreshTasks() {
      hostApi.callPluginMainAction('listTasks').then(function (r) {
        tasks = r || [];
        renderTasks();
      }).catch(function (e) {
        statusMsg.textContent = '加载任务失败: ' + (e.message || e);
      });
    }

    function loadConfig() {
      hostApi.callPluginMainAction('getConfig').then(function (r) {
        config = r;
        rSeven.input.value = r.sevenzipPath || '';
        rNode.input.value = r.nodePath || '';
        rRemote.input.value = r.remoteRoot || '';
        rWork.input.value = r.workDir || '';
        rConc.input.value = String(r.uploadConcurrency || 4);
        rAppId.input.value = r.appId || '';
        rAppKey.input.value = r.appKey || '';
        rSecret.input.value = r.secretKey || '';
        rSign.input.value = r.signKey || '';
      }).catch(function (e) {
        statusMsg.textContent = '加载配置失败: ' + (e.message || e);
      });
    }

    // ---- Modal prompt helper (replaces window.prompt which Electron blocks) ----
    function showPrompt(title, placeholder, defaultValue) {
      return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:99999;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:10px;padding:20px;min-width:360px;box-shadow:0 10px 40px rgba(0,0,0,0.2);';
        var lbl = document.createElement('div');
        lbl.textContent = title;
        lbl.style.cssText = 'font-size:14px;font-weight:600;color:#1f2937;margin-bottom:10px;';
        var input = document.createElement('input');
        input.type = 'text';
        input.value = defaultValue || '';
        input.placeholder = placeholder || '';
        input.style.cssText = 'width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;box-sizing:border-box;margin-bottom:14px;';
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding:6px 16px;background:#f3f4f6;color:#374151;border:none;border-radius:6px;cursor:pointer;font-size:13px;';
        var okBtn = document.createElement('button');
        okBtn.textContent = '确定';
        okBtn.style.cssText = 'padding:6px 16px;background:#5b21b6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;';
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        box.appendChild(lbl);
        box.appendChild(input);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        root.appendChild(overlay);
        input.focus();
        input.select();

        function cleanup(val) {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          resolve(val);
        }
        okBtn.onclick = function () { cleanup(input.value); };
        cancelBtn.onclick = function () { cleanup(null); };
        input.onkeydown = function (e) {
          if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); }
          else if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
        };
        overlay.onclick = function (e) { if (e.target === overlay) cleanup(null); };
      });
    }

    // ---- Directory picker modal (browses Baidu Netdisk directory tree) ----
    function showDirPicker() {
      return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:99999;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:10px;padding:20px;min-width:480px;max-width:600px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.2);';
        var title = document.createElement('div');
        title.textContent = '选择百度网盘目标目录';
        title.style.cssText = 'font-size:15px;font-weight:600;color:#1f2937;margin-bottom:8px;';
        var pathLabel = document.createElement('div');
        pathLabel.style.cssText = 'font-size:12px;color:#6b7280;margin-bottom:10px;font-family:monospace;word-break:break-all;';
        var dirList = document.createElement('div');
        dirList.style.cssText = 'flex:1;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;padding:8px;min-height:200px;';
        var loading = document.createElement('div');
        loading.textContent = '加载中…';
        loading.style.cssText = 'text-align:center;color:#9ca3af;padding:20px;';
        dirList.appendChild(loading);
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:space-between;margin-top:12px;';
        var leftBtns = document.createElement('div');
        leftBtns.style.cssText = 'display:flex;gap:8px;';
        var upBtn = document.createElement('button');
        upBtn.textContent = '← 返回上级';
        upBtn.style.cssText = 'padding:6px 14px;background:#f3f4f6;color:#374151;border:none;border-radius:6px;cursor:pointer;font-size:13px;';
        var rightBtns = document.createElement('div');
        rightBtns.style.cssText = 'display:flex;gap:8px;';
        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding:6px 16px;background:#f3f4f6;color:#374151;border:none;border-radius:6px;cursor:pointer;font-size:13px;';
        var selectBtn = document.createElement('button');
        selectBtn.textContent = '选择此目录';
        selectBtn.style.cssText = 'padding:6px 16px;background:#5b21b6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;';
        leftBtns.appendChild(upBtn);
        rightBtns.appendChild(cancelBtn);
        rightBtns.appendChild(selectBtn);
        btnRow.appendChild(leftBtns);
        btnRow.appendChild(rightBtns);
        box.appendChild(title);
        box.appendChild(pathLabel);
        box.appendChild(dirList);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        root.appendChild(overlay);

        var currentDir = '/';
        var history = [];

        function cleanup(val) {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          resolve(val);
        }

        function renderDirs(list) {
          dirList.innerHTML = '';
          if (!list || list.length === 0) {
            var empty = document.createElement('div');
            empty.textContent = '（无子目录）';
            empty.style.cssText = 'text-align:center;color:#9ca3af;padding:20px;';
            dirList.appendChild(empty);
            return;
          }
          list.forEach(function (p) {
            var item = document.createElement('div');
            item.textContent = '📁 ' + p.split('/').pop();
            item.style.cssText = 'padding:8px 10px;cursor:pointer;border-radius:6px;font-size:13px;';
            item.onmouseenter = function () { item.style.background = '#f3f4f6'; };
            item.onmouseleave = function () { item.style.background = 'transparent'; };
            item.onclick = function () { loadDir(p); };
            dirList.appendChild(item);
          });
        }

        async function loadDir(dir) {
          if (dir !== currentDir) { history.push(currentDir); currentDir = dir; }
          pathLabel.textContent = '当前目录: ' + currentDir;
          dirList.innerHTML = '';
          var ld = document.createElement('div');
          ld.textContent = '加载中…';
          ld.style.cssText = 'text-align:center;color:#9ca3af;padding:20px;';
          dirList.appendChild(ld);
          upBtn.disabled = history.length === 0;
          upBtn.style.opacity = history.length === 0 ? '0.5' : '1';
          try {
            var r = await hostApi.callPluginMainAction('listRemoteDir', { dir: dir });
            renderDirs(r.list);
          } catch (e) {
            dirList.innerHTML = '';
            var err = document.createElement('div');
            err.textContent = '加载失败: ' + (e.message || e);
            err.style.cssText = 'text-align:center;color:#dc2626;padding:20px;';
            dirList.appendChild(err);
          }
        }

        upBtn.onclick = function () {
          if (history.length > 0) {
            currentDir = history.pop();
            pathLabel.textContent = '当前目录: ' + currentDir;
            loadDir(currentDir);
          }
        };
        selectBtn.onclick = function () { cleanup(currentDir); };
        cancelBtn.onclick = function () { cleanup(null); };
        overlay.onclick = function (e) { if (e.target === overlay) cleanup(null); };

        // Start from the configured remote root. If it doesn't exist,
        // automatically fall back to the top-level root "/" so the user
        // can still browse and pick a valid directory.
        (async function () {
          var startDir = '/apps/';
          try {
            var cfg = await hostApi.callPluginMainAction('getConfig', {});
            if (cfg && cfg.remoteRoot) startDir = cfg.remoteRoot.replace(/\/+$/, '') || '/apps/';
          } catch (_) {}
          currentDir = startDir;
          pathLabel.textContent = '当前目录: ' + currentDir;
          try {
            var r = await hostApi.callPluginMainAction('listRemoteDir', { dir: currentDir });
            renderDirs(r.list);
          } catch (e) {
            // Remote root doesn't exist or is inaccessible — fall back to "/apps/"
            if (currentDir !== '/apps/') {
              currentDir = '/apps/';
              history = [];
              pathLabel.textContent = '当前目录: /apps/';
              loadDir('/apps/');
            } else {
              dirList.innerHTML = '';
              var err = document.createElement('div');
              err.textContent = '加载失败: ' + (e.message || e);
              err.style.cssText = 'text-align:center;color:#dc2626;padding:20px;';
              dirList.appendChild(err);
            }
          }
        })();
      });
    }

    // ---- Level picker modal (compression level) ----
    // Shown at task creation. Levels map to 7z -mx: store=0 / fastest=1 /
    // normal=5 / max=9. For pre-compressed assets (games, videos, archives)
    // 'fastest' is several times faster with almost no size penalty.
    function showLevelPicker() {
      return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:99999;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:10px;padding:20px;min-width:420px;box-shadow:0 10px 40px rgba(0,0,0,0.2);';
        var title = document.createElement('div');
        title.textContent = '选择压缩级别';
        title.style.cssText = 'font-size:15px;font-weight:600;color:#1f2937;margin-bottom:12px;';
        box.appendChild(title);
        var LEVELS = [
          { key: 'fastest', label: '极速', desc: '最快，体积略大。适合已压缩的内容（游戏/视频/安装包）' },
          { key: 'normal', label: '平衡', desc: '默认。速度与体积均衡' },
          { key: 'store', label: '仅存储', desc: '不压缩只打包，最快，体积=原始大小' },
          { key: 'max', label: '最大压缩', desc: '最慢，体积最小' },
        ];
        function cleanup(val) {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          resolve(val);
        }
        LEVELS.forEach(function (lv) {
          var row = document.createElement('button');
          row.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer;';
          row.onmouseenter = function () { row.style.borderColor = '#5b21b6'; row.style.background = '#f5f3ff'; };
          row.onmouseleave = function () { row.style.borderColor = '#e5e7eb'; row.style.background = '#fff'; };
          var name = document.createElement('div');
          name.textContent = lv.label;
          name.style.cssText = 'font-size:14px;font-weight:600;color:#1f2937;';
          var desc = document.createElement('div');
          desc.textContent = lv.desc;
          desc.style.cssText = 'font-size:12px;color:#6b7280;margin-top:2px;';
          row.appendChild(name);
          row.appendChild(desc);
          row.onclick = function () { cleanup(lv.key); };
          box.appendChild(row);
        });
        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding:6px 16px;background:#f3f4f6;color:#374151;border:none;border-radius:6px;cursor:pointer;font-size:13px;';
        cancelBtn.onclick = function () { cleanup(null); };
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:4px;';
        btnRow.appendChild(cancelBtn);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        root.appendChild(overlay);
      });
    }

    // ---- Source type picker (file vs folder) ----
    // Windows quirk: Electron's dialog with BOTH openFile+openDirectory shows
    // only folders. So we ask first, then open the dialog with one flag.
    function showTypePicker() {
      return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:99999;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:10px;padding:20px;min-width:320px;box-shadow:0 10px 40px rgba(0,0,0,0.2);';
        var title = document.createElement('div');
        title.textContent = '要上传什么？';
        title.style.cssText = 'font-size:15px;font-weight:600;color:#1f2937;margin-bottom:12px;';
        box.appendChild(title);
        function cleanup(val) {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          resolve(val);
        }
        [['file', '📄 文件'], ['folder', '📁 文件夹']].forEach(function (opt) {
          var b = document.createElement('button');
          b.textContent = opt[1];
          b.style.cssText = 'display:block;width:100%;padding:12px;margin-bottom:8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer;font-size:14px;text-align:center;';
          b.onmouseenter = function () { b.style.borderColor = '#5b21b6'; b.style.background = '#f5f3ff'; };
          b.onmouseleave = function () { b.style.borderColor = '#e5e7eb'; b.style.background = '#fff'; };
          b.onclick = function () { cleanup(opt[0]); };
          box.appendChild(b);
        });
        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding:6px 16px;background:#f3f4f6;color:#374151;border:none;border-radius:6px;cursor:pointer;font-size:13px;';
        cancelBtn.onclick = function () { cleanup(null); };
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:4px;';
        btnRow.appendChild(cancelBtn);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        root.appendChild(overlay);
      });
    }

    // ---- Event handlers ----
    addBtn.onclick = async function () {
      try {
        var srcType = await showTypePicker();
        if (srcType === null) return; // user cancelled
        var dlg = await window.fmb.dialogShowOpen({
          title: srcType === 'folder' ? '选择要压缩上传的文件夹' : '选择要压缩上传的文件',
          openFile: srcType === 'file',
          openDirectory: srcType === 'folder',
          multiSelections: false,
        });
        if (dlg.canceled || !dlg.filePaths || dlg.filePaths.length === 0) return;
        var sourcePath = dlg.filePaths[0];
        var remotePath = await showDirPicker();
        if (remotePath === null) return; // user cancelled
        var level = await showLevelPicker();
        if (level === null) return; // user cancelled
        var created = await hostApi.callPluginMainAction('createTask', {
          sourcePath: sourcePath,
          remotePath: remotePath || '',
          level: level,
        });
        statusMsg.textContent = '任务已创建，正在启动…';
        await hostApi.callPluginMainAction('startTask', { taskId: created._id });
        refreshTasks();
        statusMsg.textContent = '任务已启动';
      } catch (e) {
        statusMsg.textContent = '添加任务失败: ' + (e.message || e);
        showNotif('添加任务失败: ' + (e.message || e), 'error');
      }
    };

    cfgBtn.onclick = function () {
      configOpen = !configOpen;
      cfgPanel.style.display = configOpen ? 'block' : 'none';
      if (configOpen && !config) loadConfig();
    };

    saveCfgBtn.onclick = function () {
      saveCfgBtn.disabled = true;
      saveCfgBtn.textContent = '保存中…';
      var payload = {
        sevenzipPath: rSeven.input.value.trim(),
        nodePath: rNode.input.value.trim(),
        remoteRoot: rRemote.input.value.trim(),
        workDir: rWork.input.value.trim(),
        uploadConcurrency: parseInt(rConc.input.value.trim(), 10) || 4,
        appId: rAppId.input.value.trim(),
        appKey: rAppKey.input.value.trim(),
        secretKey: rSecret.input.value.trim(),
        signKey: rSign.input.value.trim(),
        bduss: '',
      };
      hostApi.callPluginMainAction('setConfig', payload).then(function () {
        showNotif('✓ 配置已保存成功', 'success');
        statusMsg.textContent = '配置已保存';
        loadConfig();
      }).catch(function (e) {
        showNotif('保存配置失败: ' + (e.message || e), 'error');
        statusMsg.textContent = '保存配置失败';
      }).then(function () {
        saveCfgBtn.disabled = false;
        saveCfgBtn.textContent = '保存配置';
      });
    };

    // OAuth: open Baidu authorization page in default browser
    openAuthBtn.onclick = function () {
      var ak = rAppKey.input.value.trim();
      if (!ak) { statusMsg.textContent = '请先填写 AppKey'; return; }
      var url = 'https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=' +
        encodeURIComponent(ak) + '&redirect_uri=oob&scope=basic,netdisk&display=popup';
      window.open(url, '_blank');
      statusMsg.textContent = '已打开授权页，请复制授权码后粘贴到输入框';
    };

    // OAuth: exchange the pasted code for tokens
    confirmAuthBtn.onclick = function () {
      var code = codeInput.value.trim();
      if (!code) { showNotif('请先粘贴授权码', 'error'); return; }
      confirmAuthBtn.disabled = true;
      confirmAuthBtn.textContent = '授权中…';
      showNotif('正在换取访问令牌，请稍候…', 'loading');
      hostApi.callPluginMainAction('authorize', { code: code }).then(function () {
        showNotif('✓ 授权成功！现在可以开始上传任务了', 'success');
        statusMsg.textContent = '授权成功';
        codeInput.value = '';
      }).catch(function (e) {
        showNotif('授权失败: ' + (e.message || e), 'error');
        statusMsg.textContent = '授权失败';
      }).then(function () {
        confirmAuthBtn.disabled = false;
        confirmAuthBtn.textContent = '确认授权';
      });
    };

    // ---- Init ----
    loadConfig();
    refreshTasks();
    refreshTimer = setInterval(refreshTasks, 5000);

    module.exports._root = root;
    module.exports._timer = refreshTimer;
  },

  unmount(hostEl) {
    if (module.exports._timer) { try { clearInterval(module.exports._timer); } catch (_) {} }
    while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
    module.exports._root = null;
    module.exports._timer = null;
  },
};
