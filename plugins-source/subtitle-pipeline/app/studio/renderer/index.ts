// @ts-nocheck
// Placeholder renderer — replaced by Task 6 (studio UI).
module.exports = {
  mount(hostEl) {
    var root = document.createElement('div');
    root.style.padding = '16px';
    root.textContent = '字幕工坊 UI 加载中…';
    hostEl.appendChild(root);
  },
  unmount(hostEl) {
    while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
  },
};
