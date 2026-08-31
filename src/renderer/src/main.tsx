/**
 * Renderer entry.
 *
 * Wires up:
 *   - StrictMode
 *   - AntD ConfigProvider (locale=zhCN + compact-less tokens override kept minimal)
 *   - React Router BrowserRouter via App.tsx's `createBrowserRouter` + RouterProvider
 *
 * We intentionally use react-router's `<BrowserRouter>` default basename because
 * the renderer loads as a single HTML file (no server-side path rewriting needed).
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
