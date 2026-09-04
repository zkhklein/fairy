import React from 'react';

/**
 * Workflows page — list + create/delete/run actions.
 * Four states are delegated to PageShell.
 *
 * Columns:
 *   - Owner plugin (enriched from DB join; NOT NULL per migration 002)
 *   - Referenced atomic plugin IDs (scanned from DAG definition.nodes[].pluginId)
 *   - Node summary (total / atomic / control-flow)
 *
 * Workflows can no longer be created from the UI directly (ownership contract
 * v3). The "创建示例" button is kept as a disabled affordance with a tooltip
 * explaining that workflows are owned exclusively by app-type plugins.
 */
import { Button, Space, Table, Tag, message, Tooltip, Empty } from 'antd';
import { ReloadOutlined, PlayCircleOutlined, DeleteOutlined, AppstoreAddOutlined } from '@ant-design/icons';
import { useEffect, useMemo } from 'react';
import PageShell from '../components/PageShell';
import { useWorkflowStore } from '../stores';
import type { WorkflowViewModel } from '@shared/types';

export default function Workflows(): JSX.Element {
  const { loading, error, data, list, run, del } = useWorkflowStore();

  useEffect(() => { void list(); }, [list]);

  const onRun = async (id: string): Promise<void> => {
    try {
      const r = await run({ id });
      message.success(`已启动 run_id=${(r as { run_id?: string; id?: string; status: unknown }).run_id ?? (r as any).id}，状态：${(r as any).status}`);
    } catch (e) {
      message.error((e as { message?: string }).message ?? '启动失败');
    }
  };

  const onDelete = async (id: string, name: string): Promise<void> => {
    try {
      await del(id);
      message.success(`已删除工作流：${name}`);
    } catch (e) {
      message.error((e as { message?: string }).message ?? '删除失败');
    }
  };

  const cols = useMemo(() => [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 220 },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '所属应用插件',
      key: 'owner',
      width: 260,
      render: (_v: unknown, row: WorkflowViewModel) => {
        const name = row.owner_name ?? row.owner_plugin_id;
        return (
          <Space size={4}>
            <Tag icon={<AppstoreAddOutlined />} color="geekblue">App</Tag>
            <span style={{ fontWeight: 500 }}>{name}</span>
            <span style={{ color: '#888', fontSize: 12 }}>{row.owner_plugin_id}</span>
          </Space>
        );
      },
    },
    {
      title: '引用原子插件',
      key: 'refs',
      width: 260,
      render: (_v: unknown, row: WorkflowViewModel) => {
        const ids = row.referenced_plugin_ids ?? [];
        if (ids.length === 0) return <span style={{ color: '#bbb' }}>— 无 —</span>;
        return (
          <Space size={4} wrap>
            {ids.map((pid) => (
              <Tag key={pid} color="blue">{pid}</Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '节点概况',
      key: 'nodes',
      width: 180,
      render: (_v: unknown, row: WorkflowViewModel) => {
        const nc = row.node_counts ?? { total: 0, atomic: 0, control: 0 };
        return `${nc.total} 节点 · ${nc.atomic} atomic · ${nc.control} 控制`;
      },
    },
    { title: '描述', dataIndex: 'description', key: 'desc', ellipsis: true },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (v: number) => new Date(v).toLocaleString(),
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 180,
      render: (v: number) => new Date(v).toLocaleString(),
    },
    {
      title: '操作',
      key: 'op',
      width: 200,
      render: (_: unknown, row: WorkflowViewModel) => (
        <Space>
          <Tooltip title="立即运行一次">
            <Button size="small" type="link" icon={<PlayCircleOutlined />} onClick={() => void onRun(row.id)}>运行</Button>
          </Tooltip>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void onDelete(row.id, row.name)}>删除</Button>
        </Space>
      ),
    },
  ], [onRun, onDelete]);

  return (
    <PageShell
      loading={loading && !data}
      error={error}
      empty={!!data && data.total === 0}
      emptyDescription={
        <Empty
          description={
            <span>
              还没有工作流。工作流由 <Tag color="geekblue">App 类型插件</Tag> 创建和维护，
              请前往左侧导航「应用插件」分组或插件管理子页面内创建。
            </span>
          }
        />
      }
      title="工作流"
      extra={
        <Space>
          <Tag color="blue">{(data?.total ?? 0).toString()} 个工作流</Tag>
          <Button onClick={() => void list()} icon={<ReloadOutlined />}>刷新</Button>
        </Space>
      }
    >
      <Table
        size="small"
        rowKey="id"
        columns={cols}
        dataSource={(data?.items ?? []) as WorkflowViewModel[]}
        scroll={{ x: 1600 }}
        pagination={{
          current: data?.page ?? 1,
          pageSize: data?.pageSize ?? 20,
          total: data?.total ?? 0,
          showSizeChanger: true,
          onChange: (page, pageSize) => void list({ page, pageSize }),
        }}
      />
    </PageShell>
  );
}
