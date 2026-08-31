import React from 'react';

/**
 * Dashboard page (Task 11 / FR-1.2).
 *
 * Layout:
 *   - 4 Statistic cards: 运行中工作流 / 今日错误 / 待处理作业 / 已启用插件
 *   - 最近 24h 执行总数 (computed client-side from recent runs page)
 *   - Quick actions: 手动执行工作流 (select + run) / 新建定时任务 (link)
 *   - 最近执行 Table (recent workflow runs)
 *   - 系统信息 card
 *
 * Four states implemented via PageShell (loading / error / empty / success).
 * The system health + info drive the shell; the recent-runs / today-errors
 * panels render their own small skeleton while loading.
 */
import {
  Button, Card, Col, Row, Statistic, Tag, Table, Space, Select, Empty,
  Tooltip, message, Skeleton,
} from 'antd';
import {
  AppstoreOutlined,
  UnorderedListOutlined,
  ThunderboltOutlined,
  WarningOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import PageShell from '../components/PageShell';
import { useUiStore, useWorkflowStore } from '../stores';
import { fmbApi } from '../api/fmb';
import type { RunViewModel } from '@shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

const RUN_STATUS_COLOR: Record<string, string> = {
  success: 'green',
  failed: 'red',
  running: 'processing',
  pending: 'default',
  cancelled: 'orange',
};

export default function Dashboard(): JSX.Element {
  const sysLoading = useUiStore((s) => s.systemLoading);
  const sysError = useUiStore((s) => s.systemError);
  const sysInfo = useUiStore((s) => s.systemInfo);
  const health = useUiStore((s) => s.systemHealth);
  const loadSystem = useUiStore((s) => s.loadSystem);
  const refreshHealth = useUiStore((s) => s.refreshHealth);

  const wfList = useWorkflowStore((s) => s.data);
  const wfLoading = useWorkflowStore((s) => s.loading);
  const wfError = useWorkflowStore((s) => s.error);
  const listWorkflows = useWorkflowStore((s) => s.list);
  const runWorkflow = useWorkflowStore((s) => s.run);

  const navigate = useNavigate();

  const [todayErrors, setTodayErrors] = useState<number | null>(null);
  const [recentRuns, setRecentRuns] = useState<RunViewModel[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runWfId, setRunWfId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => { void loadSystem(); void listWorkflows({ page: 1, pageSize: 100 }); }, [loadSystem, listWorkflows]);

  // Today's errors count (00:00 local → now)
  const fetchTodayErrors = useCallback(async () => {
    const start = dayjs().startOf('day').valueOf();
    try {
      const r = await fmbApi.errorLogList({ from: start, to: Date.now(), page: 1, pageSize: 1 });
      setTodayErrors(r.total);
    } catch { setTodayErrors(null); }
  }, []);
  useEffect(() => { void fetchTodayErrors(); }, [fetchTodayErrors]);

  // Recent runs (page 1, 50)
  const fetchRecentRuns = useCallback(async () => {
    setRunsLoading(true); setRunsError(null);
    try {
      const r = await fmbApi.workflowRunList({ page: 1, pageSize: 50 });
      setRecentRuns((r.items ?? []) as RunViewModel[]);
    } catch (e) {
      setRunsError((e as { message?: string }).message ?? '加载最近执行失败');
    } finally { setRunsLoading(false); }
  }, []);
  useEffect(() => { void fetchRecentRuns(); }, [fetchRecentRuns]);

  const reloadAll = useCallback(() => {
    void loadSystem(); void listWorkflows({ page: 1, pageSize: 100 });
    void fetchTodayErrors(); void fetchRecentRuns();
  }, [loadSystem, listWorkflows, fetchTodayErrors, fetchRecentRuns]);

  const runs24h = recentRuns.filter((r) => (r.started_at ?? r.created_at) && (r.started_at ?? r.created_at)! >= Date.now() - DAY_MS).length;

  const empty = health
    ? health.enabledPlugins === 0 && health.pendingJobs === 0 && health.activeRuns === 0 && (recentRuns.length === 0)
    : false;

  const onRunWorkflow = async (): Promise<void> => {
    if (!runWfId) { message.warning('请先选择一个工作流'); return; }
    setRunning(true);
    try {
      const r = await runWorkflow({ id: runWfId, input: {} });
      message.success(`已触发执行：${r.id}`);
      void fetchRecentRuns();
      void refreshHealth();
    } catch (e) {
      message.error((e as { message?: string }).message ?? '触发失败');
    } finally { setRunning(false); }
  };

  const runCols = [
    {
      title: '工作流', dataIndex: 'workflow_id', key: 'workflow_id', width: 180, ellipsis: true,
      render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code>,
    },
    {
      title: '触发', dataIndex: 'trigger', key: 'trigger', width: 90,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (v: string) => <Tag color={RUN_STATUS_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: '开始时间', dataIndex: 'started_at', key: 'started_at', width: 170,
      render: (v: number | null) => v ? dayjs(v).format('MM-DD HH:mm:ss') : '—',
    },
    {
      title: '耗时', dataIndex: 'duration_ms', key: 'duration_ms', width: 90,
      render: (v: number | null) => fmtDuration(v),
    },
    {
      title: 'trace', dataIndex: 'trace_id', key: 'trace_id', ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}><span style={{ fontSize: 11, color: '#888' }}>{v.slice(0, 8)}</span></Tooltip>
      ),
    },
  ];

  return (
    <PageShell
      loading={sysLoading && !health}
      error={sysError}
      empty={empty}
      emptyDescription="系统已启动，但当前还没有数据。请先安装插件并运行工作流。"
      title="仪表盘"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void reloadAll()}>刷新</Button>
        </Space>
      }
    >
      {/* ---- Statistic cards ---- */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={12} md={6}>
          <Card>
            <Statistic
              title="运行中工作流"
              value={health?.activeRuns ?? 0}
              prefix={<ThunderboltOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card>
            <Statistic
              title="今日错误"
              value={todayErrors ?? 0}
              prefix={<WarningOutlined />}
              valueStyle={todayErrors ? { color: '#cf1322' } : undefined}
              loading={todayErrors === null}
            />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card>
            <Statistic
              title="待处理作业"
              value={health?.pendingJobs ?? 0}
              prefix={<UnorderedListOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card>
            <Statistic
              title="已启用插件"
              value={health?.enabledPlugins ?? 0}
              prefix={<AppstoreOutlined />}
            />
          </Card>
        </Col>
      </Row>

      {/* ---- Quick actions ---- */}
      <Card size="small" title="快捷操作" style={{ marginTop: 4 }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} md={14}>
            <Space.Compact style={{ width: '100%' }}>
              <Select
                placeholder="选择工作流手动执行"
                style={{ flex: 1, minWidth: 200 }}
                loading={wfLoading && !wfList}
                status={wfError ? 'error' : undefined}
                value={runWfId ?? undefined}
                onChange={(v) => setRunWfId(v)}
                options={(wfList?.items ?? []).map((w) => ({ label: `${w.name} (${w.id})`, value: w.id }))}
                notFoundContent={!wfList ? '加载中…' : '暂无工作流'}
              />
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={running}
                disabled={!runWfId}
                onClick={() => void onRunWorkflow()}
              >执行</Button>
            </Space.Compact>
          </Col>
          <Col xs={24} md={10}>
            <Space>
              <Button icon={<PlusOutlined />} onClick={() => navigate('/schedules')}>新建定时任务</Button>
              <Button type="link" onClick={() => navigate('/workflows')}>管理工作流</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* ---- Recent runs ---- */}
      <Card
        size="small"
        title={<span><ThunderboltOutlined /> 最近执行</span>}
        style={{ marginTop: 4 }}
        extra={<Tag color="blue">近 24h {runs24h} 次</Tag>}
      >
        {runsLoading ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : runsError ? (
          <Empty description={runsError} />
        ) : recentRuns.length === 0 ? (
          <Empty description="还没有工作流执行记录" />
        ) : (
          <Table<RunViewModel>
            size="small"
            rowKey={(r) => r.id}
            columns={runCols as any}
            dataSource={recentRuns}
            pagination={{ pageSize: 8, size: 'small', showSizeChanger: false }}
          />
        )}
      </Card>

      {/* ---- System info ---- */}
      <Card title="系统信息" size="small" style={{ marginTop: 4 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px,1fr))', gap: 12 }}>
          <div><strong>版本：</strong>{sysInfo?.version ?? '—'}</div>
          <div><strong>平台：</strong>{sysInfo?.platform ?? '—'} / {sysInfo?.arch ?? '—'}</div>
          <div><strong>DB：</strong>{sysInfo?.dbPath ?? '—'}</div>
          <div><strong>日志目录：</strong>{sysInfo?.logsDir ?? '—'}</div>
          <div><strong>插件目录：</strong>{sysInfo?.pluginsDir ?? '—'}</div>
          <div><strong>运行时长：</strong>{sysInfo ? `${Math.floor(sysInfo.uptimeMs / 1000)}s` : '—'}</div>
        </div>
      </Card>
    </PageShell>
  );
}
