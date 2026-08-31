import React from 'react';

/**
 * App root — defines the React Router 6 tree.
 *
 * Layout:
 *   /  → redirects to /dashboard (done inside MainLayout useEffect to avoid
 *        depending on another import cycle; also we add <Navigate /> here as a
 *        static fallback for SSR-like scenarios).
 *   /* → <MainLayout /> (Sider + Header + Content/Outlet + Footer)
 *        ├─ /dashboard
 *        ├─ /plugins
 *        ├─ /workflows
 *        ├─ /schedules
 *        ├─ /queue
 *        ├─ /error-calendar
 *        ├─ /extension-points
 *        ├─ /settings
 *        └─ * → AntD Result 404  (TR-10.1: 导航不会把人引到这里，但需渲染)
 */
import { Navigate, RouterProvider, createHashRouter } from 'react-router-dom';
import { Result, Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import MainLayout from '../layout/MainLayout';
import { NAV_ITEMS } from '../router';
import AppPluginPage from '../pages/AppPluginPage';

function NotFound(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}>
      <Result
        status="404"
        title="404"
        subTitle="该页面不存在，请从左侧菜单进入功能页。"
        extra={
          <Button type="primary" onClick={() => navigate('/dashboard')}>
            返回仪表盘
          </Button>
        }
      />
    </div>
  );
}

// HashRouter is required for the packaged Electron app: when the renderer is
// loaded via `file://` (loadFile), BrowserRouter silently fails because
// `window.location.pathname` is the OS file path (e.g. `/D:/.../index.html`)
// and matches no route → blank screen. HashRouter keys routing off the URL
// fragment (#/dashboard) which works identically under http:// (dev) and
// file:// (packaged).
const router = createHashRouter([
  {
    path: '/',
    element: <MainLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      ...NAV_ITEMS.map((it) => ({ path: it.path.replace(/^\//, ''), element: it.element as ReactNode })),
      // T12: type=app 插件的动态子页面（不在左侧菜单，从插件管理"打开子页面"按钮跳转）
      { path: 'app-plugins/:pluginId', element: <AppPluginPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

export default function App(): JSX.Element {
  return <RouterProvider router={router} />;
}
