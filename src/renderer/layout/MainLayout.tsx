/**
 * Global layout for the FMB UI.
 *
 *  - Left Sider: AntD `<Menu>` synced to `useLocation().pathname` → Navigates via `<Link>`
 *  - Top Header: collapsible trigger + breadcrumb + system info pill (version/platform)
 *  - Content area: React Router `<Outlet />` (renders matched page)
 *  - Footer: copyright + uptime
 *
 * TR-10.1 checks rely on this layout: all 8 routes render without overlap.
 * TR-10.2: no Node globals (all IPC goes through the preload-bridged API).
 */
import { Layout, Menu, Breadcrumb, Button, Tag, Tooltip } from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import { useEffect, useMemo } from 'react';
import { NAV_ITEMS, labelByPath } from '../router';
import { useUiStore } from '../stores';

const { Header, Sider, Content, Footer } = Layout;

export default function MainLayout(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useUiStore((s) => s.siderCollapsed);
  const toggleSider = useUiStore((s) => s.toggleSider);
  const loadSystem = useUiStore((s) => s.loadSystem);
  const sysInfo = useUiStore((s) => s.systemInfo);
  const sysLoading = useUiStore((s) => s.systemLoading);
  const sysError = useUiStore((s) => s.systemError);

  // Trigger once on mount: system.info + system.health (TR-10: startup采集).
  useEffect(() => { void loadSystem(); }, [loadSystem]);

  // Ensure a sensible default route: "/" always redirects to /dashboard.
  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      navigate('/dashboard', { replace: true });
    }
  }, [location.pathname, navigate]);

  const selectedKey = useMemo(() => {
    const match = NAV_ITEMS.find((it) => location.pathname.startsWith(it.path));
    return match?.key ?? '/dashboard';
  }, [location.pathname]);

  const breadcrumbItems = useMemo(() => {
    const home = { title: <Link to="/dashboard">首页</Link> };
    const currentLabel = labelByPath(selectedKey);
    const items: Array<{ title: React.ReactNode }> = [home];
    if (selectedKey !== '/dashboard') items.push({ title: currentLabel });
    return items;
  }, [selectedKey]);

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
        width={220}
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
          items={NAV_ITEMS.map((it) => ({
            key: it.key,
            icon: it.icon,
            label: <Link to={it.path}>{it.label}</Link>,
          }))}
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
