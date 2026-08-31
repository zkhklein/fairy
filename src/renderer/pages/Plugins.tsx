/**
 * Plugins page — Plugin list management.
 *
 * Features:
 *   - Table with columns: ID, Name, Type, Status (Switch), Version (Select for switch),
 *     Dependencies, Actions (open sub-page / uninstall)
 *   - Expandable rows showing manifest details
 *   - Version switching via usePluginStore.switchVersion()
 *   - "Open sub-page" button for type=app plugins → /app-plugins/:pluginId
 *   - Install via zip (dialog placeholder)
 */
import {
  Button, Space, Switch, Table, Tag, Popconfirm, Select, Tooltip, message,
} from 'antd';
import {
  ReloadOutlined, UploadOutlined, ExportOutlined, DeleteOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import PageShell from '../components/PageShell';
import { usePluginStore } from '../stores';
import { fmbApi } from '../api/fmb';

interface PluginRow {
  id: string;
  name: string;
  type: string;
  status: string;
  current_version: string;
  author: string;
  description: string;
  manifest: Record<string, unknown>;
  dependencies: Record<string, string>;
  versions: Array<{ version: string; installed_at: number }>;
}

export default function Plugins(): JSX.Element {
  const loading = usePluginStore((s) => s.loading);
  const error = usePluginStore((s) => s.error);
  const data = usePluginStore((s) => s.data);
  const list = usePluginStore((s) => s.list);
  const versions = usePluginStore((s) => s.versions);
  const versionsError = usePluginStore((s) => s.versionsError);
  const listVersions = usePluginStore((s) => s.listVersions);
  const switchVersion = usePluginStore((s) => s.switchVersion);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  useEffect(() => { void list(); }, [list]);

  const onToggle = async (id: string, nextEnabled: boolean): Promise<void> => {
    try {
      await fmbApi.pluginSetStatus({ id, status: nextEnabled ? 'enabled' : 'disabled' });
      message.success(nextEnabled ? '已启用' : '已停用');
      void list();
    } catch (e) { message.error((e as { message?: string }).message ?? '操作失败'); }
  };

  const onUninstall = async (id: string): Promise<void> => {
    try {
      await fmbApi.pluginUninstall({ id });
      message.success('已卸载');
      void list();
    } catch (e) { message.error((e as { message?: string }).message ?? '卸载失败'); }
  };

  const onVersionChange = async (id: string, version: string): Promise<void> => {
    setSwitchingId(id);
    try {
      await switchVersion(id, version);
      message.success(`已切换到版本 ${version}`);
    } catch (e) {
      message.error((e as { message?: string }).message ?? '版本切换失败');
    } finally { setSwitchingId(null); }
  };

  const cols = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 200, ellipsis: true },
    { title: '名称', dataIndex: 'name', key: 'name', width: 160 },
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 90,
      render: (v: string) => {
        const color = v === 'app' ? 'blue' : v === 'atomic' ? 'green' : 'orange';
        return <Tag color={color}>{v}</Tag>;
      },
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 110,
      render: (v: string, row: PluginRow) => (
        <Switch
          checked={v === 'enabled'}
          checkedChildren="启用"
          unCheckedChildren="停用"
          onChange={(next) => void onToggle(row.id, next)}
        />
      ),
    },
    {
      title: '版本', key: 'version', width: 160,
      render: (_: unknown, row: PluginRow) => {
        const rowVersions = (row.versions ?? []).length > 0 ? row.versions : [{ version: row.current_version }];
        if (rowVersions.length <= 1) {
          return <Tag>{row.current_version}</Tag>;
        }
        return (
          <Select
            size="small"
            defaultValue={row.current_version}
            style={{ width: 130 }}
            loading={switchingId === row.id}
            onChange={(v) => void onVersionChange(row.id, v)}
            options={rowVersions.map((rv) => ({
              label: rv.version === row.current_version ? `${rv.version} (当前)` : rv.version,
              value: rv.version,
            }))}
          />
        );
      },
    },
    {
      title: '依赖', key: 'deps', width: 160, ellipsis: true,
      render: (_: unknown, row: PluginRow) => {
        const deps = Object.entries(row.dependencies ?? {});
        if (deps.length === 0) return <Tag color="default">无</Tag>;
        return (
          <Tooltip title={deps.map(([k, v]) => `${k}@${v}`).join('\n')}>
            <span style={{ fontSize: 12, color: '#888' }}>{deps.length} 项依赖</span>
          </Tooltip>
        );
      },
    },
    {
      title: '操作', key: 'op', width: 200,
      render: (_: unknown, row: PluginRow) => (
        <Space size={4}>
          {row.type === 'app' && (
            <Link to={`/app-plugins/${row.id}`}>
              <Button size="small" type="link" icon={<ExportOutlined />}>子页面</Button>
            </Link>
          )}
          <Popconfirm title="确定卸载？" onConfirm={() => void onUninstall(row.id)} okText="卸载" cancelText="取消">
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>卸载</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <PageShell
      loading={loading && !data}
      error={error}
      empty={!!data && data.total === 0}
      emptyDescription="还没有安装任何插件。请通过插件 zip 安装。"
      title="插件管理"
      extra={
        <Space>
          <Button onClick={() => void list()} icon={<ReloadOutlined />}>刷新</Button>
          <Button
            type="primary"
            onClick={() => message.info('安装功能链路已就绪：将走 main_plugin_install IPC。集成文件选择对话框后即可启用。')}
            icon={<UploadOutlined />}
          >安装插件 zip</Button>
        </Space>
      }
    >
      <Table<any>
        size="small"
        rowKey={(r: any) => r.id}
        columns={cols as any}
        dataSource={(data?.items ?? []) as any[]}
        pagination={{
          current: data?.page ?? 1,
          pageSize: data?.pageSize ?? 20,
          total: data?.total ?? 0,
          showSizeChanger: true,
          onChange: (page, pageSize) => void list({ page, pageSize }),
        }}
        expandable={{
          expandedRowRender: (row: any) => (
            <Space direction="vertical" style={{ width: '100%' }}>
              <div><strong>描述：</strong>{row.description ?? row.manifest?.description ?? '—'}</div>
              <div><strong>作者：</strong>{row.author ?? row.manifest?.author ?? '—'}</div>
              <div>
                <strong>权限：</strong>
                {Array.isArray(row.manifest?.permissions)
                  ? (row.manifest.permissions as string[]).map((p, i) => <Tag key={i}>{p}</Tag>)
                  : '无'}
              </div>
              <div>
                <strong>依赖详情：</strong>
                {Object.entries(row.dependencies ?? {}).length > 0
                  ? Object.entries(row.dependencies).map(([k, v]) => (
                    <Tag key={k} color="blue">{k}@{String(v)}</Tag>
                  ))
                  : '无'}
              </div>
            </Space>
          ),
          rowExpandable: () => true,
        }}
      />
      {versionsError && <div style={{ color: 'red', marginTop: 8 }}>{versionsError}</div>}
    </PageShell>
  );
}
