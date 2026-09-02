/**
 * com.fmb.watchdog renderer — Sub-page with two switches.
 *
 * Rendered inside AppPluginPage's Shadow DOM via:
 *   module.exports.mount(hostEl, hostUIApi)
 *
 * Layout (Plain DOM, zero React, lightweight):
 *  ┌─ 后台值守 / Watchdog ─────────────────────────────────────────┐
 *  │ 每 2 分钟检测一次；关闭开关=停止调度；打开=立刻执行一次拉起并启动调度器 │
 *  ├─ TraeWork ─────────────────────────────────────────────────────┤
 *  │  ▣ 是否值守 TraeWork     状态：运行中 ✅     最后检测：刚刚       │
 *  │  路径：C:\...\Trae.exe    [修改]  [立即拉一次]                  │
 *  ├─ ChatGPT ──────────────────────────────────────────────────────┤
 *  │  ▣ 是否值守 ChatGPT      状态：未运行 ⚠️    最后检测：30 秒前     │
 *  │  路径：C:\...\ChatGPT.exe [修改]  [立即拉一次]                  │
 *  └─ 每次拉起永远不会杀死正在运行的实例；仅在退出时重启。───────────────┘
 */
module.exports = {
  mount(hostEl: Element, hostApi: any) {
    const root = document.createElement('div');
    root.setAttribute('data-fmb-watchdog-root', '1');
    applyBoxStyle(root, {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
      padding: '20px 24px',
      color: 'var(--ant-color-text, #1f1f1f)',
      background: 'transparent',
    });

    // Header
    const header = document.createElement('div');
    applyBoxStyle(header, { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '16px' });
    const h1 = document.createElement('h1');
    applyBoxStyle(h1, { margin: 0, fontSize: '20px', fontWeight: 700 });
    h1.textContent = '后台值守 / Watchdog';
    const sub = document.createElement('span');
    applyBoxStyle(sub, { color: 'var(--ant-color-text-secondary, #8c8c8c)', fontSize: '12px' });
    sub.textContent = '每 2 分钟调度一次；仅在进程真正退出时重启，绝不干扰运行中的程序';
    header.appendChild(h1); header.appendChild(sub);
    root.appendChild(header);

    const notice = document.createElement('p');
    applyBoxStyle(notice, {
      background: 'var(--ant-color-info-bg, #e6f7ff)',
      border: '1px solid var(--ant-color-info-border, #91d5ff)',
      padding: '8px 12px', borderRadius: '6px',
      fontSize: '13px', margin: '0 0 18px',
      color: 'var(--ant-color-info, #1677ff)',
    });
    notice.textContent = '⚠️ 软件没退出 → 值守不会碰它任何一个线程。只做"没在运行才拉起"';
    root.appendChild(notice);

    // Cards per target
    const cards: Record<string, any> = {};
    for (const target of ['traework', 'chatgpt']) {
      cards[target] = buildCard(target as any, hostApi);
      root.appendChild(cards[target].wrap);
    }

    // 轮询：15s
    let stopped = false;
    let token = 0;
    const refresh = async () => {
      const myTok = ++token;
      try {
        const state = await hostApi.callPluginMainAction('getState');
        if (stopped || token !== myTok) return;
        for (const key of Object.keys(state.targets || {})) {
          if (cards[key]) cards[key].apply(state.targets[key]);
        }
      } catch (_e) { /* ignore transient */ }
    };
    refresh();
    const handle = setInterval(refresh, 15_000);
    (module.exports as any)._teardown = () => { stopped = true; clearInterval(handle); token++; };

    hostEl.appendChild(root);
    (module.exports as any)._root = root;
    (module.exports as any)._cards = cards;

    // --------- helpers ---------
    function buildCard(target: 'traework' | 'chatgpt', api: any) {
      const names: Record<string, string> = { traework: 'TraeWork', chatgpt: 'ChatGPT' };
      const wrap = document.createElement('section');
      applyBoxStyle(wrap, {
        border: '1px solid var(--ant-color-border, #f0f0f0)',
        borderRadius: '10px', padding: '14px 18px', marginBottom: '14px',
        background: 'var(--ant-color-bg-container, #fff)',
      });
      // row1: title + switch + status
      const r1 = document.createElement('div');
      applyBoxStyle(r1, { display: 'flex', alignItems: 'center', gap: '14px', justifyContent: 'space-between', marginBottom: '10px' });
      const title = document.createElement('span');
      applyBoxStyle(title, { fontSize: '16px', fontWeight: 600 });
      title.textContent = names[target];
      const switchWrap = document.createElement('label');
      applyBoxStyle(switchWrap, { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' });
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      applyBoxStyle(sw, { width: '18px', height: '18px', accentColor: 'var(--ant-color-primary, #1677ff)' });
      const swLabel = document.createElement('span');
      applyBoxStyle(swLabel, { fontSize: '13px' });
      swLabel.textContent = `是否值守 ${names[target]}`;
      switchWrap.appendChild(sw); switchWrap.appendChild(swLabel);
      const status = document.createElement('span');
      applyBoxStyle(status, { fontSize: '13px', fontWeight: 600 });
      status.textContent = '状态：…';
      r1.appendChild(title); r1.appendChild(switchWrap); r1.appendChild(status);

      // row2: path + modify + runNow + lastCheck
      const r2 = document.createElement('div');
      applyBoxStyle(r2, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--ant-color-text-secondary, #595959)' });
      const pathEl = document.createElement('div');
      applyBoxStyle(pathEl, { flex: '1 1 400px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'var(--ant-color-fill, #fafafa)', border: '1px dashed var(--ant-color-border, #e5e5e5)', padding: '6px 10px', borderRadius: '6px', minWidth: 0 });
      pathEl.textContent = '路径：…';
      pathEl.title = '';
      const btnMod = button('修改路径', async () => {
        const cur = (pathEl as any)._actualPath || '';
        const p = prompt(`请输入 ${names[target]} 完整 exe 路径（绝对路径）：`, cur);
        if (p && p.trim()) {
          try {
            await api.callPluginMainAction('setExecPath', { target, path: p.trim() });
            flash(pathEl, '✓ 已保存');
            await refresh();
          } catch (e: any) { flash(pathEl, '✗ ' + (e?.message || e), true); }
        }
      });
      const btnRun = button('立即检测 & 拉起', async () => {
        btnRun.disabled = true;
        try {
          const r = await api.callPluginMainAction('runNow', { target });
          flash(pathEl, '✓ ' + (r?.result?.action || r?.state?.targets?.[target]?.lastAction || 'done'));
          await refresh();
        } catch (e: any) { flash(pathEl, '✗ ' + (e?.message || e), true); }
        finally { btnRun.disabled = false; }
      }, { primary: true });
      const last = document.createElement('span');
      applyBoxStyle(last, { minWidth: '100px', textAlign: 'right' });
      last.textContent = '最后检测：-';
      r2.appendChild(pathEl); r2.appendChild(btnMod); r2.appendChild(btnRun); r2.appendChild(last);

      // row3: err hint
      const errRow = document.createElement('div');
      applyBoxStyle(errRow, { color: 'var(--ant-color-error, #ff4d4f)', fontSize: '12px', marginTop: '8px', minHeight: '1em' });

      wrap.appendChild(r1); wrap.appendChild(r2); wrap.appendChild(errRow);

      // Switch handler
      sw.addEventListener('change', async () => {
        sw.disabled = true;
        try {
          await api.callPluginMainAction('setEnabled', { target, enabled: sw.checked });
          flash(status, sw.checked ? '✓ 值守 开' : '∅ 值守 关');
        } catch (e: any) {
          sw.checked = !sw.checked;
          errRow.textContent = '切换失败：' + (e?.message || String(e));
        } finally { sw.disabled = false; await refresh(); }
      });

      return {
        wrap,
        apply(t: any) {
          sw.checked = !!t.enabled;
          status.textContent = t.running ? '状态：运行中 ✅' : (t.needSetup ? '状态：需配置路径 ⚠️' : '状态：未运行 ⚠️');
          const style = t.running ? 'color:var(--ant-color-success, #52c41a)' :
            (t.needSetup ? 'color:var(--ant-color-warning, #faad14)' : 'color:var(--ant-color-error, #ff4d4f)');
          status.setAttribute('style', (status.getAttribute('style') || '') + ';' + style);
          (pathEl as any)._actualPath = t.execPath || '';
          const shownPath = t.execPath || (t.needSetup ? '⚠️ 未配置路径：请点「修改路径」填完整 exe 路径' : '暂未解析出路径');
          pathEl.textContent = '路径：' + shownPath;
          pathEl.title = t.execPath || '';
          errRow.textContent = t.lastError ? ('上次失败：' + t.lastError) : '';
          last.textContent = t.lastCheckMs ? ('最后检测：' + agoStr(t.lastCheckMs)) : '最后检测：-';
        },
      };
    }

    function button(label: string, onClick: () => Promise<void> | void, opts?: { primary?: boolean }) {
      const b = document.createElement('button');
      applyBoxStyle(b, {
        padding: '6px 12px', borderRadius: '6px', border: '1px solid', cursor: 'pointer', fontSize: '12px',
        background: opts?.primary ? 'var(--ant-color-primary, #1677ff)' : 'var(--ant-color-bg-container, #fff)',
        color: opts?.primary ? '#fff' : 'var(--ant-color-text, #1f1f1f)',
        borderColor: opts?.primary ? 'var(--ant-color-primary, #1677ff)' : 'var(--ant-color-border, #d9d9d9)',
      });
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }
  },

  unmount(hostEl: Element) {
    try { (module.exports as any)._teardown && (module.exports as any)._teardown(); } catch {}
    while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
    (module.exports as any)._root = null;
    (module.exports as any)._cards = null;
  },
};

function applyBoxStyle(el: HTMLElement, kv: Record<string, string | number>) {
  for (const k of Object.keys(kv)) {
    const v = kv[k];
    if (v === undefined || v === null) continue;
    el.style.setProperty(k, String(v));
  }
}
function flash(el: HTMLElement, text: string, isErr?: boolean) {
  const oldBg = el.style.background;
  const oldCol = el.style.color;
  el.style.background = isErr ? '#fff2f0' : '#f6ffed';
  el.style.color = isErr ? '#cf1322' : '#389e0d';
  const prev = el.dataset.flash || '';
  el.setAttribute('title', `${text}  ·  ${prev}`);
  setTimeout(() => { el.style.background = oldBg; el.style.color = oldCol; }, 1200);
}
function agoStr(ms: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return `${h} 小时前`;
}
