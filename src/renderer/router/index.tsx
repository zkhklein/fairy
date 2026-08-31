import React from 'react';

/**
 * Route definition + left-nav config for TR-10.1 (8 navigation items).
 *
 * Each entry is a single source of truth used in:
 *   - AntD Sider Menu item rendering (`Menu.menuItems` with <NavigateOutlined> icons)
 *   - Top breadcrumb generation (traverse `items` to find matching label by path)
 *   - React Router 6 `createHashRouter` table (HashRouter: dev http:// + packaged file://)
 *
 * The 8 pages are:
 *   1. /dashboard          — Dashboard（仪表盘 / 总览）
 *   2. /plugins            — Plugins（插件管理）
 *   3. /workflows          — Workflows（工作流）
 *   4. /schedules          — Scheduled Tasks（定时任务）
 *   5. /queue              — Queue Monitoring（任务队列）
 *   6. /error-calendar     — Error Calendar（错误日历）
 *   7. /extension-points   — Extension Points（扩展点注册总览）
 *   8. /settings           — Settings（设置）
 *
 * Pages are intentionally small. Each page component implements the
 * Four-State pattern: loading Skeleton → (data?) Success Table/Cards
 *                                  → (empty?) Empty → (throw?) Result error.
 */
import {
  DashboardOutlined,
  AppstoreOutlined,
  ShareAltOutlined,
  ScheduleOutlined,
  UnorderedListOutlined,
  WarningOutlined,
  ApiOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import Dashboard from '../pages/Dashboard';
import Plugins from '../pages/Plugins';
import Workflows from '../pages/Workflows';
import Schedules from '../pages/Schedules';
import QueueMonitoring from '../pages/QueueMonitoring';
import ErrorCalendar from '../pages/ErrorCalendar';
import ExtensionPoints from '../pages/ExtensionPoints';
import Settings from '../pages/Settings';

export interface NavItem {
  key: string;        // 作为 menu key；同时等于 path (便于 Menu 与路由同步)
  label: string;      // 菜单 / 面包屑文本
  path: string;       // React Router route path
  icon: ReactNode;    // AntD Menu icon
  element: ReactNode; // React Router element
}

export const NAV_ITEMS: NavItem[] = [
  { key: '/dashboard',       label: '仪表盘',         path: '/dashboard',       icon: <DashboardOutlined />,      element: <Dashboard /> },
  { key: '/plugins',         label: '插件管理',       path: '/plugins',         icon: <AppstoreOutlined />,       element: <Plugins /> },
  { key: '/workflows',       label: '工作流',         path: '/workflows',       icon: <ShareAltOutlined />,       element: <Workflows /> },
  { key: '/schedules',       label: '定时任务',       path: '/schedules',       icon: <ScheduleOutlined />,       element: <Schedules /> },
  { key: '/queue',           label: '队列监控',       path: '/queue',           icon: <UnorderedListOutlined />,  element: <QueueMonitoring /> },
  { key: '/error-calendar',  label: '错误日历',       path: '/error-calendar',  icon: <WarningOutlined />,        element: <ErrorCalendar /> },
  { key: '/extension-points',label: '扩展点',         path: '/extension-points',icon: <ApiOutlined />,            element: <ExtensionPoints /> },
  { key: '/settings',        label: '设置',           path: '/settings',        icon: <SettingOutlined />,        element: <Settings /> },
];

/** 根据 path 反查 label（用于面包屑）。找不到时返回 path 本身。 */
export function labelByPath(p: string): string {
  const item = NAV_ITEMS.find((it) => it.path === p);
  return item?.label ?? p;
}
