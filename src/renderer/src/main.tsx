/**
 * Renderer entry.
 *
 * Wires up:
 *   - StrictMode
 *   - AntD ConfigProvider (locale=zhCN + compact-less tokens override kept minimal)
 *   - React Router HashRouter via App.tsx's `createHashRouter` + RouterProvider
 *   - ThemeWrapper: reacts to the `ui.compact` setting by swapping the compact
 *     algorithm in real time, without a reload.
 *
 * HashRouter is used (not BrowserRouter) because in packaged mode the renderer
 * loads via `file://` loadFile(); BrowserRouter would try to match the OS file
 * path against the route table and silently render nothing (blank screen).
 */
import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntdApp, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { useUiStore } from '../stores';

/**
 * Subscribes to the UI store's `uiCompact` flag and passes the matching
 * compact algorithm and `componentSize` down to ConfigProvider.
 */
function ThemeWrapper({ children }: { children: React.ReactNode }) {
  const uiCompact = useUiStore((s) => s.uiCompact);
  const loadSettings = useUiStore((s) => s.loadSystem);

  useEffect(() => {
    void loadSettings();
    const onSettingsChanged = () => {
      void loadSettings();
    };
    window.addEventListener('fmb:settingsChanged', onSettingsChanged);
    return () => window.removeEventListener('fmb:settingsChanged', onSettingsChanged);
  }, [loadSettings]);

  return (
    <ConfigProvider
      locale={zhCN}
      componentSize={uiCompact === 1 ? 'small' : 'middle'}
      theme={{
        algorithm: uiCompact === 1 ? (theme as any).compactAlgorithm : (theme as any).defaultAlgorithm,
        token: {
          colorPrimary: '#5b21b6',
          borderRadius: uiCompact === 1 ? 4 : 6,
        },
      }}
    >
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeWrapper>
      <App />
    </ThemeWrapper>
  </React.StrictMode>,
);
