/**
 * Renderer entry.
 *
 * Wires up:
 *   - StrictMode
 *   - AntD ConfigProvider (locale=zhCN + compact-less tokens override kept minimal)
 *   - React Router HashRouter via App.tsx's `createHashRouter` + RouterProvider
 *
 * HashRouter is used (not BrowserRouter) because in packaged mode the renderer
 * loads via `file://` loadFile(); BrowserRouter would try to match the OS file
 * path against the route table and silently render nothing (blank screen).
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#5b21b6',
          borderRadius: 6,
        },
      }}
    >
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
