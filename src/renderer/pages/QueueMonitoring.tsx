import React from 'react';

/**
 * Queue monitoring page — list jobs, cancel pending/running or retry failed/dead.
 * Four states via PageShell.
 */
import { Button, Space, Table, Tag, Select, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import PageShell from '../components/PageShell';
import { useJobStore } from '../stores';

type StatusFilter = 'all' | 'pending' | 'running' | 'completed' | 'failed' | 'dead';

const STATUS_COLOR: Record<string, string> = {
  pending: 'blue',
  running: 'cyan',
  completed: 'green',
  failed: 'orange',
  dead: 'red',
};

export default function QueueMonitoring(): JSX.Element {
  const { loading, error, data, list, cancel, retry } = useJobStore();
  const [status, setStatus] = useState<StatusFilter>('all');
  useEffect(() => { void list(status === 'all' ? {} : { status }); }, [list, status]);

  const totals = useMemo(() => {
    const by = new Map<string, number>();
    (data?.items ?? []).forEach((row: any) => {
      const key = row.status ?? 'unknown';
      by.set(key, (by.get(key) ?? 0) + 1);
    });
    return by;
  }, [data]);

  const cols = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 80 },
    { title: '类型', dataIndex: 'type', key: 'type', width: 160, render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    { title: '尝试 / 最大', key: 'attempts', width: 120, render: (_: unknown, r: { attempts: number; max_attempts: number }) => `${r.attempts}/${r.max_attempts}` },
    {
      title: '创建',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (v: number) => new Date(v).toLocaleString(),
    },
    {
      title: '完成',
      dataIndex: 'finished_at',
      key: 'finished_at',
      width: 170,
      render: (v: number | null) => (v ? new Date(v).toLocaleString() : '—'),
    },
    { title: '最后错误', dataIndex: 'last_error', key: 'last_error', ellipsis: true },
    {
      title: '操作',
      key: 'op',
      width: 160,
      render: (_: unknown, row: { id: number; status: string }) => {
        const canCancel = row.status === 'pending' || row.status === 'running';
        const canRetry = row.status === 'failed' || row.status === 'dead';
        return (
          <Space>
            <Button size="small" disabled={!canCancel} onClick={async () => { try { await cancel(row.id); message.success('已取消'); } catch (e) { message.error((e as { message?: string }).message ?? '取消失败'); } }}>
              取消
            </Button>
            <Button size="small" type="primary" disabled={!canRetry} onClick={async () => { try { await retry(row.id); message.success('已重试'); } catch (e) { message.error((e as { message?: string }).message ?? '重试失败'); } }}>
              重试
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <PageShell
      loading={loading && !data}
      error={error}
      empty={!!data && data.total === 0}
      emptyDescription="队列里目前没有作业。运行一个工作流或创建一个定时任务后，作业会出现在这里。"
      title="队列监控"
      extra={
        <Space wrap>
          <Tag color="blue">pending {totals.get('pending') ?? 0}</Tag>
          <Tag color="cyan">running {totals.get('running') ?? 0}</Tag>
          <Tag color="green">completed {totals.get('completed') ?? 0}</Tag>
          <Tag color="orange">failed {totals.get('failed') ?? 0}</Tag>
          <Tag color="red">dead {totals.get('dead') ?? 0}</Tag>
          <Select
            value={status}
            style={{ width: 140 }}
            onChange={(next) => setStatus(next)}
            options={[
              { value: 'all', label: '全部' },
              { value: 'pending', label: 'pending' },
              { value: 'running', label: 'running' },
              { value: 'completed', label: 'completed' },
              { value: 'failed', label: 'failed' },
              { value: 'dead', label: 'dead' },
            ]}
          />
          <Button onClick={() => void list(status === 'all' ? {} : { status })} icon={<ReloadOutlined />}>刷新</Button>
        </Space>
      }
    >
      <Table<any>
        size="small"
        rowKey={(r: any) => r.id ?? r.job_id ?? r.trace_id ?? String(Math.random())}
        columns={cols as any}
        dataSource={(data?.items ?? []) as any[]}
        pagination={{
          current: data?.page ?? 1,
          pageSize: data?.pageSize ?? 20,
          total: data?.total ?? 0,
          showSizeChanger: true,
          onChange: (page, pageSize) => void list({ page, pageSize, status: status === 'all' ? undefined : status }),
        }}
      />
    </PageShell>
  );
}
