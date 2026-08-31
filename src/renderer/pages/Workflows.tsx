import React from 'react';

/**
 * Workflows page — list + create/delete/run actions.
 * Four states are delegated to PageShell.
 */
import { Button, Space, Table, Tag, message, Tooltip } from 'antd';
import { ReloadOutlined, PlusOutlined, PlayCircleOutlined, DeleteOutlined } from '@ant-design/icons';
import { useEffect } from 'react';
import PageShell from '../components/PageShell';
import { useWorkflowStore } from '../stores';

export default function Workflows(): JSX.Element {
  const { loading, error, data, list, del, create, run } = useWorkflowStore();

  useEffect(() => { void list(); }, [list]);

  const onCreateSample = async (): Promise<void> => {
    try {
      const wf = await create({
        name: `示例工作流 #${Date.now().toString(36)}`,
        description: '由 UI 创建的示例 DAG：noop → noop',
        definition: {
          version: 1,
          kind: 'dag',
          nodes: [
            { id: 'start', type: 'noop', config: {} },
            { id: 'end', type: 'noop', config: {} },
          ],
          edges: [{ from: 'start', to: 'end' }],
          variables: [],
        },
      });
      message.success(`已创建：${wf.name}`);
    } catch (e) {
      message.error((e as { message?: string }).message ?? '创建失败');
    }
  };

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

  const cols = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 220 },
    { title: '名称', dataIndex: 'name', key: 'name' },
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
      render: (_: unknown, row: { id: string; name: string }) => (
        <Space>
          <Tooltip title="立即运行一次">
            <Button size="small" type="link" icon={<PlayCircleOutlined />} onClick={() => void onRun(row.id)}>运行</Button>
          </Tooltip>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void onDelete(row.id, row.name)}>删除</Button>
        </Space>
      ),
    },
  ];

  return (
    <PageShell
      loading={loading && !data}
      error={error}
      empty={!!data && data.total === 0}
      emptyDescription="还没有工作流。点击右上角「创建示例」快速创建一个最简单的 DAG。"
      title="工作流"
      extra={
        <Space>
          <Tag color="blue">{(data?.total ?? 0).toString()} 个工作流</Tag>
          <Button onClick={() => void list()} icon={<ReloadOutlined />}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreateSample}>创建示例</Button>
        </Space>
      }
    >
      <Table
        size="small"
        rowKey="id"
        columns={cols}
        dataSource={data?.items ?? []}
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
