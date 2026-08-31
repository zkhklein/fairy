/**
 * Error Calendar page — query error logs by severity + date range + mark resolved.
 * Four states via PageShell.
 */
import { Button, DatePicker, Select, Space, Table, Tag, Switch, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import dayjs, { Dayjs } from 'dayjs';
import PageShell from '../components/PageShell';
import { useErrorStore } from '../stores';

const SEVERITY_COLOR: Record<string, string> = {
  error: 'red',
  warn: 'orange',
  info: 'blue',
  debug: 'default',
};

export default function ErrorCalendar(): JSX.Element {
  const { loading, error, data, list, resolve } = useErrorStore();
  const [severity, setSeverity] = useState<'all' | 'error' | 'warn' | 'info'>('all');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const params = useMemo(() => {
    const p: Parameters<typeof list>[0] = {};
    if (severity !== 'all') p.severity = severity;
    if (range && range[0] && range[1]) {
      p.startTs = range[0].valueOf();
      p.endTs = range[1].valueOf();
    }
    return p;
  }, [severity, range]);

  useEffect(() => { void list(params); }, [list, params]);

  const perSeverity = useMemo(() => {
    const m = new Map<string, number>();
    (data?.items ?? []).forEach((row: any) => {
      const key: string = row.severity ?? row.level ?? 'unknown';
      m.set(key, (m.get(key) ?? 0) + 1);
    });
    return m;
  }, [data]);

  const cols = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 80 },
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (v: number) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '严重度',
      dataIndex: 'level',
      key: 'level',
      width: 100,
      render: (v: string) => <Tag color={SEVERITY_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    { title: '来源', dataIndex: 'source', key: 'source', width: 140 },
    { title: '消息', dataIndex: 'message', key: 'message', ellipsis: true },
    {
      title: '已解决',
      dataIndex: 'resolved',
      key: 'resolved',
      width: 110,
      render: (v: 0 | 1, row: { id: number }) => (
        <Switch
          checked={v === 1}
          onChange={async (next) => {
            try {
              await resolve(row.id, next);
              message.success(next ? '已标记解决' : '已取消解决标记');
            } catch (e) {
              message.error((e as { message?: string }).message ?? '操作失败');
            }
          }}
        />
      ),
    },
  ];

  return (
    <PageShell
      loading={loading && !data}
      error={error}
      empty={!!data && data.total === 0}
      emptyDescription="好消息：当前查询范围内没有错误日志。🎉"
      title="错误日历"
      extra={
        <Space wrap>
          <Tag color="red">error {perSeverity.get('error') ?? 0}</Tag>
          <Tag color="orange">warn {perSeverity.get('warn') ?? 0}</Tag>
          <Tag color="blue">info {perSeverity.get('info') ?? 0}</Tag>
          <Select
            value={severity}
            style={{ width: 140 }}
            onChange={(next) => setSeverity(next)}
            options={[
              { value: 'all', label: '全部严重度' },
              { value: 'error', label: 'error' },
              { value: 'warn', label: 'warn' },
              { value: 'info', label: 'info' },
            ]}
          />
          <DatePicker.RangePicker
            value={range as unknown as [Dayjs, Dayjs] | null}
            onChange={(v) => setRange(v as unknown as [Dayjs | null, Dayjs | null] | null)}
          />
          <Button onClick={() => void list(params)} icon={<ReloadOutlined />}>刷新</Button>
        </Space>
      }
    >
      <Table<any>
        size="small"
        rowKey={(r: any) => r.id ?? r.created_at ?? r.trace_id ?? String(Math.random())}
        columns={cols as any}
        dataSource={(data?.items ?? []) as any[]}
        pagination={{
          current: data?.page ?? 1,
          pageSize: data?.pageSize ?? 20,
          total: data?.total ?? 0,
          showSizeChanger: true,
          onChange: (page, pageSize) => void list({ ...params, page, pageSize }),
        }}
      />
    </PageShell>
  );
}
