import React from 'react';

/**
 * Global layout for the FMB UI.
 *
 *  - Left Sider: AntD `<Menu>` synced to `useLocation().pathname` → Navigates via `<Link>`
 *     * Top group: `NAV_ITEMS` with `groupKey='core'` (仪表盘 插件管理 工作流 ... 设置)
 *     * Bottom group: "应用插件" SubMenu — dynamically built from the plugin store
 *       (type=app AND status=enabled). Empty group is hidden entirely so the nav
 *       doesn't show a lonely disabled placeholder.
 *  - Top Header: collapsible trigger + breadcrumb + system info pill (version/platform)
 *  - Content area: React Router `<Outlet />` (renders matched page)
 *  - Footer: copyright + uptime
 *
 * App-plugin sub-page route: `/app-plugins/:pluginId` (see router/index.tsx).
 * Breadcrumb uses the plugin name when we can resolve it from the loaded plugin list.
 */
import { Layout, Menu, Breadcrumb, Button, Tag, Tooltip, Empty } from 'antd';
import type { MenuProps } from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  InfoCircleOutlined,
  AppstoreAddOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import { useEffect, useMemo } from 'react';
import { NAV_ITEMS, labelByPath } from '../router';
import { useUiStore, usePluginStore } from '../stores';

const { Header, Sider, Content, Footer } = Layout;

type MenuItem = Required<MenuProps>['items'][number];

export default function MainLayout(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useUiStore((s) => s.siderCollapsed);
  const toggleSider = useUiStore((s) => s.toggleSider);
  const loadSystem = useUiStore((s) => s.loadSystem);
  const sysInfo = useUiStore((s) => s.systemInfo);
  const sysLoading = useUiStore((s) => s.systemLoading);
  const sysError = useUiStore((s) => s.systemError);

  // Load plugins once so the "应用插件" submenu can be rendered.
  const pluginLoading = usePluginStore((s) => s.loading);
  const pluginData = usePluginStore((s) => s.data);
  const loadPlugins = usePluginStore((s) => s.list);
  useEffect(() => { void loadPlugins({ pageSize: 200 }); }, [loadPlugins]);

  // Trigger once on mount: system.info + system.health (TR-10: startup采集).
  useEffect(() => { void loadSystem(); }, [loadSystem]);

  // Ensure a sensible default route: "/" always redirects to /dashboard.
  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      navigate('/dashboard', { replace: true });
    }
  }, [location.pathname, navigate]);

  // ---- enabledAppPlugins: [{ id, name }] type=app + status=enabled ----
  const enabledAppPlugins = useMemo<Array<{ id: string; name: string; type: string; status: string }>>(() => {
    const items = (pluginData?.items as Array<Record<string, unknown>> | undefined) ?? [];
    return items
      .filter((p) => (p.type === 'app') && (p.status === 'enabled'))
      .map((p) => ({
        id: String(p.id ?? ''),
        name: String(p.name ?? String(p.id ?? '')),
        type: String(p.type),
        status: String(p.status),
      }))
      .filter((p) => p.id.length > 0)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  }, [pluginData]);

  // ---- pluginId → name Map (used by breadcrumb label resolver) ----
  const pluginNameMap = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    const all = (pluginData?.items as Array<Record<string, unknown>> | undefined) ?? [];
    for (const p of all) {
      const id = String(p.id ?? '');
      const name = String(p.name ?? id);
      if (id) m.set(id, name);
    }
    return m;
  }, [pluginData]);

  // ---- selectedKey / defaultOpenKeys ----
  // For app plugin sub-pages use the concrete `/app-plugins/<pluginId>` so
  // AntD Menu highlights the real child entry and auto-opens the SubMenu.
  const selectedKey = useMemo(() => {
    if (location.pathname.startsWith('/app-plugins/')) {
      return location.pathname;
    }
    const match = NAV_ITEMS.find((it) => it.path !== '/app-plugins/:pluginId' && location.pathname.startsWith(it.path));
    return match?.key ?? '/dashboard';
  }, [location.pathname]);
  const defaultOpenKeys = useMemo(() => ['group:app-plugins'], []);

  // ---- breadcrumb with plugin-name resolution ----
  const breadcrumbItems = useMemo(() => {
    const home = { title: <Link to="/dashboard">首页</Link> };
    const currentLabel = labelByPath(
      location.pathname.startsWith('/app-plugins/') ? location.pathname : selectedKey,
      pluginNameMap,
    );
    const items: Array<{ title: React.ReactNode }> = [home];
    // For app-plugin sub-pages, add an intermediate "应用插件" group level
    // so the breadcrumb reads "首页 / 应用插件 / 笔记中心" for example.
    if (location.pathname.startsWith('/app-plugins/')) {
      items.push({ title: '应用插件' });
    }
    if (selectedKey !== '/dashboard') items.push({ title: currentLabel });
    return items;
  }, [selectedKey, location.pathname, pluginNameMap]);

  // ---- Build AntD Menu items ----
  const menuItems = useMemo<MenuItem[]>(() => {
    const coreItems: MenuItem[] = NAV_ITEMS
      .filter((it) => it.groupKey !== 'app-plugins')
      .map((it) => ({
        key: it.key,
        icon: it.icon,
        label: <Link to={it.path}>{it.label}</Link>,
      }));

    const subMenuChildren: MenuItem[] = enabledAppPlugins.map((p) => ({
      key: `/app-plugins/${p.id}`,
      icon: <AppstoreAddOutlined />,
      label: <Link to={`/app-plugins/${p.id}`}>{p.name}</Link>,
    }));

    // Show "暂无已启用的应用插件" only when plugins have finished loading AND
    // no enabled app plugins are present. When loading we skip the SubMenu so
    // the UI doesn't flicker an empty group.
    const hasAppPlugins = subMenuChildren.length > 0;
    const loaded = !pluginLoading && pluginData !== null;
    const appPluginGroup: MenuItem[] = [];
    if (hasAppPlugins || loaded) {
      appPluginGroup.push({
        key: 'group:app-plugins',
        icon: <AppstoreAddOutlined />,
        label: '应用插件',
        children: hasAppPlugins
          ? subMenuChildren
          : [
              {
                key: 'app-plugins-empty',
                disabled: true,
                label: (
                  <span style={{ opacity: 0.7 }}>
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已启用的 App 类型插件" style={{ margin: '8px 0' }} />
                  </span>
                ),
              },
            ],
      });
    }

    // Separator between core nav and app plugin submenu (only if we render the group).
    if (appPluginGroup.length > 0) {
      coreItems.push({ type: 'divider', key: 'divider:app-plugins' } as MenuItem);
      return [...coreItems, ...appPluginGroup];
    }
    return coreItems;
  }, [enabledAppPlugins, pluginLoading, pluginData]);

  const versionTag = useMemo(() => {
    if (sysLoading) return <Tag color="blue">加载中…</Tag>;
    if (sysError) return (<Tooltip title={sysError}><Tag color="red">系统信息加载失败</Tag></Tooltip>);
    if (!sysInfo) return <Tag>—</Tag>;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Tag color="geekblue">v{sysInfo.version}</Tag>
        <Tag>{sysInfo.platform} / {sysInfo.arch}</Tag>
      </span>
    );
  }, [sysInfo, sysLoading, sysError]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        trigger={null}
        width={240}
        theme="dark"
        style={{ overflow: 'auto', height: '100vh', position: 'sticky', top: 0, left: 0 }}
      >
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            paddingLeft: collapsed ? 0 : 20,
            color: '#fff',
            fontSize: collapsed ? 14 : 16,
            fontWeight: 700,
            letterSpacing: 0.5,
            background: 'rgba(255,255,255,0.04)',
            margin: 12,
            borderRadius: 8,
          }}
        >
          {collapsed ? 'FMB' : 'Fairy Maid Brigade'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          defaultOpenKeys={defaultOpenKeys}
          items={menuItems}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>

      <Layout style={{ minWidth: 0 }}>
        <Header
          style={{
            background: '#fff',
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            borderBottom: '1px solid #f0f0f0',
            height: 56,
            lineHeight: '56px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
            <Button
              type="text"
              aria-label="toggle sider"
              onClick={toggleSider}
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            />
            <Breadcrumb items={breadcrumbItems} style={{ minWidth: 0, flex: '0 1 auto' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {versionTag}
            <Tooltip title="所有 IPC 调用均经由 contextBridge 暴露的 window.fmb 白名单通道，contextIsolation=true。">
              <InfoCircleOutlined style={{ color: '#888' }} />
            </Tooltip>
          </div>
        </Header>

        <Content
          style={{
            margin: 0,
            minHeight: 280,
            background: '#f5f7fa',
            overflow: 'auto',
          }}
        >
          <Outlet />
        </Content>

        <Footer style={{ textAlign: 'center', padding: '12px 16px', color: '#8c8c8c', fontSize: 12 }}>
          Fairy Maid Brigade · ©{new Date().getFullYear()} · Cross-PC Plugin Workflow Orchestrator
        </Footer>
      </Layout>
    </Layout>
  );
}
