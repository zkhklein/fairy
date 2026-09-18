import React from 'react';

/**
 * Plugins page — Plugin list management.
 *
 * Features:
 *   - Table with columns: ID, Name, Type, Status (Switch), Version (Select for switch),
 *     Dependencies, Actions (open sub-page / uninstall)
 *   - Expandable rows showing manifest details
 *   - Version switching via usePluginStore.switchVersion()
 *   - "Open sub-page" button for type=app plugins → /app-plugins/:pluginId
 *   - Install via multi-select zip dialog → pre-checks → confirm & install
 */
import {
  Button, Space, Switch, Table, Tag, Popconfirm, Select, Tooltip, message,
  Modal, Checkbox, Alert, Badge, Empty, Input,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReloadOutlined, UploadOutlined, ExportOutlined, DeleteOutlined,
  CheckCircleFilled, CloseCircleFilled, WarningFilled, SearchOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import PageShell from '../components/PageShell';
import { usePluginStore } from '../stores';
import { fmbApi } from '../api/fmb';
import type { MainPluginPreInstallCheckResult, MainPluginListResult } from '@shared/ipc';

type PluginRow = MainPluginListResult['items'][number] & {
  author?: string;
  manifest?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  versions?: Array<{ version: string; installed_at: number }>;
  scheduleTemplates?: unknown;
};

export default function Plugins(): JSX.Element {
  const loading = usePluginStore((s) => s.loading);
  const error = usePluginStore((s) => s.error);
  const data = usePluginStore((s) => s.data);
  const list = usePluginStore((s) => s.list);
  const versions = usePluginStore((s) => s.versions);
  const versionsError = usePluginStore((s) => s.versionsError);
  const listVersions = usePluginStore((s) => s.listVersions);
  const switchVersion = usePluginStore((s) => s.switchVersion);
  const preChecks = usePluginStore((s) => s.preChecks);
  const preChecksLoading = usePluginStore((s) => s.preChecksLoading);
  const preInstallBatch = usePluginStore((s) => s.preInstallBatch);
  const installBatch = usePluginStore((s) => s.installBatch);
  const batchLoading = usePluginStore((s) => s.batchLoading);
  const batchResults = usePluginStore((s) => s.batchResults);

  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [autoEnable, setAutoEnable] = useState(true);
  const [installStage, setInstallStage] = useState<'pick' | 'precheck' | 'done'>('pick');
  // Bundled dependency overwrite choices: depId → overwrite? Only meaningful
  // for deps whose status is upgrade/downgrade (a different version is already
  // installed). new deps install automatically; same-version deps skip.
  const [depOverwrite, setDepOverwrite] = useState<Record<string, boolean>>({});
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState<undefined | 'atomic' | 'app' | 'extension'>(undefined);
  const [statusFilter, setStatusFilter] = useState<undefined | string>(undefined);
  const navigate = useNavigate();

  useEffect(() => { void list(); }, [list]);

  // Initialize default overwrite choices once prechecks arrive: deps whose
  // installed version does NOT satisfy the declared range default to checked.
  useEffect(() => {
    setDepOverwrite((prev) => {
      const next = { ...prev };
      for (const c of preChecks) {
        for (const d of c.bundledDeps ?? []) {
          if ((d.status === 'upgrade' || d.status === 'downgrade') && !(d.depId in next)) {
            next[d.depId] = !!d.requiredOverwrite;
          }
        }
      }
      return next;
    });
  }, [preChecks]);

  const filteredRows = useMemo(() => {
    const rows = (data?.items ?? []) as PluginRow[];
    const kw = keyword.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter && r.type !== typeFilter) return false;
      if (statusFilter && r.status !== statusFilter) return false;
      if (kw) {
        const hay = `${r.id} ${r.name} ${r.description ?? ''} ${r.current_version}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [data, keyword, typeFilter, statusFilter]);

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

  const onStartInstall = () => {
    setInstallStage('pick');
    setInstallOpen(true);
  };

  const onPickZips = async (): Promise<void> => {
    try {
      const r = await fmbApi.dialogShowOpen({
        title: '选择插件 zip 包（可多选）',
        multiSelections: true,
        openFile: true,
        filters: [{ name: 'FMB 插件 zip', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePaths || r.filePaths.length === 0) {
        message.info('未选择任何文件。');
        return;
      }
      const zipPaths = r.filePaths.filter((p) => p && p.toLowerCase().endsWith('.zip'));
      if (zipPaths.length === 0) {
        message.warning('仅支持 .zip 扩展的插件包。');
        return;
      }
      setInstallStage('precheck');
      await preInstallBatch(zipPaths);
    } catch (e) {
      message.error((e as { message?: string }).message ?? '选择文件失败');
    }
  };

  const willDowngrade = (c: MainPluginPreInstallCheckResult) => c.versionStatus === 'downgrade';

  const onConfirmInstall = async (): Promise<void> => {
    if (preChecks.length === 0) return;
    const allOk = preChecks.every((c) => c.ok && !willDowngrade(c));
    const someFatal = preChecks.some((c) => !c.ok);
    if (someFatal) {
      message.warning('部分 zip 无法安装（存在致命问题）。请先移除不合法的 zip 后重试。');
      return;
    }
    // Guard: a required dependency overwrite the user unchecked will fail the
    // install anyway — surface it early with a clear message.
    const missingRequired = preChecks.flatMap((c) =>
      (c.bundledDeps ?? []).filter((d) => d.requiredOverwrite && !depOverwrite[d.depId]),
    );
    if (missingRequired.length > 0) {
      message.warning(
        `依赖 ${missingRequired.map((d) => d.depId).join('、')} 的已装版本不满足要求，请勾选覆盖后再安装。`,
      );
      return;
    }
    if (!allOk) {
      const ok: boolean = await new Promise((resolve) => {
        Modal.confirm({
          title: '包含降级操作，确认继续？',
          content: '你选择的部分 zip 版本低于当前已安装版本，继续将执行降级。',
          okText: '继续安装（含降级）',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!ok) return;
    }
    const overwriteDeps = Object.entries(depOverwrite).filter(([, v]) => v).map(([k]) => k);
    await installBatch({ zipPaths: preChecks.map((c) => c.zipPath), autoEnable, overwriteDeps });
    setInstallStage('done');
    void list();
  };

  const onCloseInstall = (): void => {
    setInstallOpen(false);
    setTimeout(() => {
      setInstallStage('pick');
    }, 300);
  };

  const openAppPage = (id: string): void => {
    navigate(`/app-plugins/${encodeURIComponent(id)}`);
  };

  const cols: ColumnsType<PluginRow> = [
    {
      title: 'ID', dataIndex: 'id', key: 'id', width: 200, ellipsis: true,
      sorter: (a, b) => a.id.localeCompare(b.id),
    },
    { title: '名称', dataIndex: 'name', key: 'name', width: 160, sorter: (a, b) => a.name.localeCompare(b.name) },
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 90,
      filters: [
        { text: 'App', value: 'app' },
        { text: 'Atomic', value: 'atomic' },
        { text: 'Extension', value: 'extension' },
      ],
      onFilter: (v, row) => row.type === v,
      render: (v: string) => {
        const color = v === 'app' ? 'blue' : v === 'atomic' ? 'green' : 'orange';
        return <Tag color={color}>{v}</Tag>;
      },
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 110,
      filters: [
        { text: '已启用', value: 'enabled' },
        { text: '已安装未启用', value: 'installed' },
        { text: '已停用', value: 'disabled' },
        { text: '错误', value: 'error' },
      ],
      onFilter: (v, row) => row.status === v,
      render: (v: string, row) => (
        <Switch
          checked={v === 'enabled'}
          checkedChildren="启用"
          unCheckedChildren="停用"
          onChange={(next) => void onToggle(row.id, next)}
        />
      ),
    },
    {
      title: '版本', key: 'version', width: 170,
      render: (_, row) => {
        const rowVersions: Array<{ version: string; installed_at?: number }> =
          (row.versions && row.versions.length > 0) ? row.versions : [{ version: row.current_version, installed_at: 0 }];
        if (!rowVersions || rowVersions.length <= 1) {
          return <Tag>{row.current_version}</Tag>;
        }
        return (
          <Select
            size="small"
            defaultValue={row.current_version}
            style={{ width: 140 }}
            loading={switchingId === row.id}
            onChange={(v) => void onVersionChange(row.id, v)}
            onDropdownVisibleChange={async (open) => {
              if (open && (!versions || versions.pluginId !== row.id)) {
                await listVersions(row.id);
              }
            }}
            options={rowVersions.map((rv) => ({
              label: rv.version === row.current_version ? `${rv.version} (当前)` : rv.version,
              value: rv.version,
            }))}
          />
        );
      },
    },
    {
      title: '依赖', key: 'deps', width: 140, ellipsis: true,
      render: (_, row) => {
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
      title: '操作', key: 'op', width: 220,
      render: (_, row) => (
        <Space size={2}>
          {row.type === 'app' && (
            <Button size="small" type="link" icon={<ExportOutlined />} onClick={() => openAppPage(row.id)}>子页面</Button>
          )}
          <Popconfirm title="确定卸载？" onConfirm={() => void onUninstall(row.id)} okText="卸载" cancelText="取消">
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>卸载</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
    <PageShell
      loading={loading && !data}
      error={error}
      empty={!!data && data.total === 0}
      emptyDescription={
        <Empty description={<span>还没有安装任何插件。点击右上角 <Tag color="purple">安装插件 zip</Tag> 开始。</span>} />
      }
      title="插件管理"
      extra={
        <Space wrap>
          <Tag color="purple">{(data?.total ?? 0).toString()} 个插件</Tag>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="ID / 名称 / 描述"
            style={{ width: 220 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            allowClear
            placeholder="类型过滤"
            style={{ width: 120 }}
            value={typeFilter}
            onChange={setTypeFilter as any}
            options={[
              { label: 'App', value: 'app' },
              { label: 'Atomic', value: 'atomic' },
              { label: 'Extension', value: 'extension' },
            ]}
          />
          <Select
            allowClear
            placeholder="状态过滤"
            style={{ width: 140 }}
            value={statusFilter}
            onChange={setStatusFilter as any}
            options={[
              { label: '已启用', value: 'enabled' },
              { label: '已安装未启用', value: 'installed' },
              { label: '已停用', value: 'disabled' },
              { label: '错误', value: 'error' },
            ]}
          />
          <Button onClick={() => { void list(); }} icon={<ReloadOutlined />}>刷新</Button>
          <Button type="primary" onClick={onStartInstall} icon={<UploadOutlined />}>安装插件 zip</Button>
        </Space>
      }
    >
      <Table<PluginRow>
        size="small"
        rowKey={(r) => r.id}
        columns={cols}
        dataSource={filteredRows}
        pagination={{
          current: data?.page ?? 1,
          pageSize: data?.pageSize ?? 20,
          total: filteredRows.length,
          showSizeChanger: true,
          onChange: (page, pageSize) => void list({ page, pageSize }),
        }}
        expandable={{
          expandedRowRender: (row) => (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <div><strong>描述：</strong>{row.description ?? (row.manifest?.description as string) ?? '—'}</div>
              <div><strong>作者：</strong>{row.author ?? (row.manifest?.author as string) ?? '—'}</div>
              <div>
                <strong>权限：</strong>
                {Array.isArray(row.manifest?.permissions) && (row.manifest.permissions as unknown[]).length > 0
                  ? (row.manifest.permissions as string[]).map((p, i) => <Tag key={i}>{p}</Tag>)
                  : '无'}
              </div>
              <div>
                <strong>依赖详情：</strong>
                {Object.entries(row.dependencies ?? {}).length > 0
                  ? Object.entries(row.dependencies ?? {}).map(([k, v]) => (
                    <Tag key={k} color="blue">{k}@{String(v)}</Tag>
                  ))
                  : '无'}
              </div>
              {(function renderScheduleTemplates(): React.ReactNode {
                const raw = row.scheduleTemplates as unknown;
                if (!raw || !Array.isArray(raw) || raw.length === 0) return null;
                const arr = raw as Array<Record<string, unknown>>;
                return (
                  <div>
                    <strong>定时任务模板：</strong>
                    {arr.map((t, i) => (
                      <Tag
                        key={String(t.id ?? String(t.label) ?? String(i))}
                        color="geekblue"
                      >
                        {String(t.label ?? t.id ?? `template_${i}`)}
                      </Tag>
                    ))}
                  </div>
                );
              })()}
            </Space>
          ),
          rowExpandable: () => true,
        }}
      />
      {versionsError && <div style={{ color: 'red', marginTop: 8 }}>{versionsError}</div>}
    </PageShell>

    {/* ----------------------------- Install Modal ----------------------------- */}
    {/* Modal lives OUTSIDE PageShell: PageShell replaces children with the Empty
        state when the list is empty, which would unmount the modal exactly when
        a fresh install needs it. */}
    <Modal
        title="安装插件 zip"
        open={installOpen}
        onCancel={onCloseInstall}
        width={860}
        destroyOnClose
        footer={installStage === 'pick' ? (
          <Space>
            <Button onClick={onCloseInstall}>取消</Button>
            <Button type="primary" icon={<UploadOutlined />} onClick={() => void onPickZips()}>选择 zip（多选）</Button>
          </Space>
        ) : installStage === 'precheck' ? (
          <Space>
            <Button onClick={() => setInstallStage('pick')}>返回重新选择</Button>
            <Button onClick={onCloseInstall}>关闭</Button>
            <Checkbox checked={autoEnable} onChange={(e) => setAutoEnable(e.target.checked)}>
              安装完成后自动启用
            </Checkbox>
            <Button
              type="primary"
              loading={batchLoading}
              disabled={!preChecks.some((c) => c.ok) || preChecksLoading}
              onClick={() => void onConfirmInstall()}
            >
              确认安装
            </Button>
          </Space>
        ) : (
          <Space>
            <Button type="primary" onClick={onCloseInstall}>关闭</Button>
          </Space>
        )}
      >
        {installStage === 'pick' && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="请选择一个或多个 .zip 插件包"
              description="选择后将执行：zip 完整性校验 → manifest 合法性 → 版本比对 → 依赖检查 → 最终安装并自动启用（可取消）。"
            />
            <Empty description="点击右下角「选择 zip（多选）」继续。" />
          </Space>
        )}
        {installStage === 'precheck' && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Space>
                <Badge status="success" /> 全部通过 / 可直接安装
                <Badge status="warning" /> 警告（版本降级、依赖缺失）
                <Badge status="error" /> 致命错误（损坏 / manifest 无效）
              </Space>
            </div>
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {preChecksLoading ? (
                <Alert type="info" showIcon message="正在检查 zip 合法性与依赖..." />
              ) : (
                preChecks.map((c) => (
                  <PreCheckItem
                    key={c.zipPath}
                    check={c}
                    depOverwrite={depOverwrite}
                    onDepOverwriteChange={(depId, checked) =>
                      setDepOverwrite((prev) => ({ ...prev, [depId]: checked }))
                    }
                  />
                ))
              )}
            </div>
          </Space>
        )}
        {installStage === 'done' && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="success" showIcon message="安装完成！" description="表格已自动刷新，启用状态见插件列表。" />
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {(batchResults ?? []).map((r) => (
                <div key={r.zipPath} style={{ marginBottom: 8 }}>
                  {r.ok
                    ? <CheckCircleFilled style={{ color: '#52c41a' }} />
                    : <CloseCircleFilled style={{ color: '#ff4d4f' }} />}{' '}
                  {r.pluginId ?? r.zipPath.slice(r.zipPath.lastIndexOf('\\') + 1)} @ {r.version ?? '?'}
                  {' '}— {(r.errors && r.errors.length > 0 ? r.errors.map((e) => e.message).join('; ') : (r.ok ? '安装成功' : '安装失败'))}
                  {(r.installedDeps ?? []).length > 0 && (
                    <div style={{ marginLeft: 22, marginTop: 2, fontSize: 12, color: '#666' }}>
                      {(r.installedDeps ?? []).map((d) => (
                        <div key={d.pluginId}>
                          依赖 {d.pluginId}@{d.version}：
                          {d.action === 'installed' ? '已自动安装' : d.action === 'overwritten' ? '已覆盖安装' : '保留现有版本'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Space>
        )}
      </Modal>
    </>
  );
}

/**
 * Render a single pre-check result card. Translates the structured
 * `depCheck` + `versionStatus` to the UI's status badges, messages, and
 * the dependency list. App zips embedding `bundledDeps` additionally show
 * the dependency closure: new deps auto-install, same-version deps skip,
 * and different-version deps get an overwrite checkbox.
 */
function PreCheckItem({ check, depOverwrite, onDepOverwriteChange }: {
  check: MainPluginPreInstallCheckResult;
  depOverwrite: Record<string, boolean>;
  onDepOverwriteChange: (depId: string, checked: boolean) => void;
}): JSX.Element {
  const fatal = !check.ok;
  const hasCycles = (check.depCheck.cycles?.length ?? 0) > 0;
  const hasMissing = (check.depCheck.missing?.length ?? 0) > 0;
  const hasConflicts = (check.depCheck.conflicts?.length ?? 0) > 0;
  const down = check.versionStatus === 'downgrade';
  const warn = down || hasCycles || hasMissing || hasConflicts;
  const color = fatal ? '#ff4d4f' : warn ? '#faad14' : '#52c41a';
  const Icon = fatal ? CloseCircleFilled : warn ? WarningFilled : CheckCircleFilled;
  const name = check.zipPath.slice(check.zipPath.lastIndexOf('\\') + 1);
  const manifest = check.manifest;
  const pluginId = manifest?.id ?? name;
  const version = manifest?.version ?? '?';
  const actionLabel = check.versionStatus
    ? check.versionStatus === 'new' ? '全新安装'
      : check.versionStatus === 'upgrade' ? '升级'
        : check.versionStatus === 'downgrade' ? '降级'
          : '与当前相同'
    : undefined;

  return (
    <div
      style={{
        border: `1px solid ${color}33`,
        background: `${color}0d`,
        padding: 10,
        borderRadius: 8,
        marginBottom: 10,
      }}
    >
      <Space style={{ width: '100%' }} wrap>
        <Icon style={{ color }} />
        <strong>{pluginId}</strong>
        {version && <Tag color="purple">v{version}</Tag>}
        {check.installedVersion && <Tag color="default">已安装 v{check.installedVersion}</Tag>}
        {actionLabel && <Tag>{actionLabel}</Tag>}
      </Space>
      <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>{check.zipPath}</div>
      {!check.ok && (check.errors ?? []).length > 0 && (
        <div style={{ fontSize: 12, marginTop: 4 }}>
          {(check.errors ?? []).map((e, i) => (
            <div key={i} style={{ color }}>
              <Icon style={{ color, marginRight: 6 }} />
              {e.code ? `[${e.code}] ` : ''}{e.message}
            </div>
          ))}
        </div>
      )}
      {down && (
        <div style={{ color: '#d46b08', fontSize: 12, marginTop: 4 }}>
          ⚠ 将要降级（{check.installedVersion ?? 'installed'} → {version}）
        </div>
      )}
      {(check.bundledDeps ?? []).length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            内嵌依赖（随本包自动处理）：
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, listStyle: 'none' }}>
            {(check.bundledDeps ?? []).map((d) => {
              const label = `${d.name ? `${d.name}（${d.depId}）` : d.depId} @ v${d.version}`;
              if (d.status === 'new') {
                return (
                  <li key={d.depId} style={{ marginBottom: 4 }}>
                    <Tag color="blue">将自动安装</Tag>{label}
                  </li>
                );
              }
              if (d.status === 'same') {
                return (
                  <li key={d.depId} style={{ marginBottom: 4 }}>
                    <Tag color="default">已安装同版本 · 跳过</Tag>{label}
                  </li>
                );
              }
              // upgrade / downgrade: user chooses whether to overwrite.
              return (
                <li key={d.depId} style={{ marginBottom: 4 }}>
                  <Checkbox
                    checked={!!depOverwrite[d.depId]}
                    onChange={(e) => onDepOverwriteChange(d.depId, e.target.checked)}
                  >
                    覆盖安装
                  </Checkbox>
                  <Tag color={d.status === 'downgrade' ? 'orange' : 'geekblue'}>
                    {d.status === 'downgrade' ? '降级' : '升级'}
                  </Tag>
                  {label}
                  <span style={{ color: '#888' }}>（当前 v{d.installedVersion}）</span>
                  {d.requiredOverwrite && (
                    <Tag color="red" style={{ marginLeft: 4 }}>当前版本不满足依赖要求，需覆盖</Tag>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {(hasMissing || hasConflicts || hasCycles) && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>依赖问题：</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {(check.depCheck.missing ?? []).map((d, i) => (
              <li key={`m${i}`}>
                <Tag color="red">missing</Tag>
                {' '}{d.depId}@{d.requested} — {d.reason}
                {d.installed ? `  （当前 ${d.installed}）` : ''}
              </li>
            ))}
            {(check.depCheck.conflicts ?? []).map((d, i) => (
              <li key={`c${i}`}>
                <Tag color="orange">conflict</Tag>
                {' '}{d.depId}@{d.requested} — {d.reason}
                {d.installed ? `  （当前 ${d.installed}）` : ''}
              </li>
            ))}
            {(check.depCheck.cycles ?? []).map((cycle, i) => (
              <li key={`cy${i}`}>
                <Tag color="blue">cycle</Tag> {cycle.join(' → ')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
