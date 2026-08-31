/**
 * Schedules page — list/create/toggle/delete Cron/one-shot schedules.
 * Four states via PageShell.
 */
import { Button, Space, Table, Tag, Switch, message, Popconfirm } from 'antd';
import { ReloadOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect } from 'react';
import PageShell from '../components/PageShell';
import { useScheduleStore } from '../stores';

export default function Schedules(): JSX.Element {
  const { loading, error, data, list, create, toggle, del } = useScheduleStore();
  useEffect(() => { void list(); }, [list]);

  const onAddSample = async (): Promise<void> => {
    try {
      await create({
        name: `每5分钟示例 #${Date.now().toString(36)}`,
        cronExpr: '*/5 * * * *',
        misfirePolicy: 'skip',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone as 'Asia/Shanghai' | 'UTC' | 'local' | undefined,
        enabled: 1,
      });
      message.success('已添加示例定时任务');
    } catch (e) {
      message.error((e as { message?: string }).message ?? '创建失败');
    }
  };

  const cols = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 220 },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: 'Cron', dataIndex: 'cron_expr', key: 'cron', width: 160, render: (v: string | null) => v ?? <Tag color="gold">单次</Tag> },
    { title: '关联工作流', dataIndex: 'workflow_id', key: 'wf', width: 220 },
    {
      title: '下次触发',
      dataIndex: 'next_fired_at',
      key: 'next',
      width: 180,
      render: (v: number | null) => (v ? new Date(v).toLocaleString() : '—'),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'en',
      width: 100,
      render: (v: 0 | 1, row: { id: string }) => (
        <Switch checked={v === 1} onChange={(next) => void toggle(row.id, next ? 1 : 0)} />
      ),
    },
    {
      title: '操作',
      key: 'op',
      width: 100,
      render: (_: unknown, row: { id: string; name: string }) => (
        <Popconfirm title={`确定删除定时任务 "${row.name}"？`} onConfirm={() => void del(row.id)} okText="删除" cancelText="取消">
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <PageShell
      loading={loading && !data}
      error={error}
      empty={!!data && data.total === 0}
      emptyDescription="还没有定时任务。点击右上角「添加示例」创建一个每 5 分钟的 Cron 任务。"
      title="定时任务"
      extra={
        <Space>
          <Tag color="purple">{(data?.total ?? 0).toString()} 个任务</Tag>
          <Button onClick={() => void list()} icon={<ReloadOutlined />}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={onAddSample}>添加示例</Button>
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
