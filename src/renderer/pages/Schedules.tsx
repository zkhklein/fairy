import React, { useState, useMemo, useEffect } from 'react';

/**
 * Schedules page — list/create/toggle/delete Cron/one-shot schedules.
 * Four states via PageShell.
 *
 * The primary "add" button is **not** "创建示例". Instead:
 *   - App-type plugins that declare `scheduleTemplates[]` in their manifest
 *     are surfaced in a dropdown. The user picks a template, then the modal
 *     auto-renders a matching parameter form, default cron, default workflow
 *     etc. Submitting creates a schedule with the correct `owner_plugin_id`
 *     so the ownership contract is preserved.
 *   - If no templates exist, we still allow a generic schedule form
 *     (cron + workflow select) for debugging, with owner_plugin_id optional.
 */
import {
  Button, Space, Table, Tag, Switch, message, Popconfirm, Modal, Form,
  Input, InputNumber, Select, Checkbox, DatePicker, Collapse, Alert, Row, Col,
  Tooltip, Empty,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReloadOutlined, PlusOutlined, InfoCircleOutlined, ClockCircleOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageShell from '../components/PageShell';
import { useScheduleStore, useWorkflowStore, usePluginStore } from '../stores';
import type { ScheduleTemplateParam } from '@shared/types';

type ParamVal = string | number | boolean | unknown;

interface CreateValues {
  // Template / owner selection
  templateKey?: string;
  // Generic fields
  name?: string;
  cronExpr?: string;
  misfirePolicy?: 'run_now' | 'skip' | 'last_missed';
  timezone?: 'Asia/Shanghai' | 'UTC' | 'local';
  runOnceAt?: string | number | null;
  workflowId?: string;
  enabled?: boolean;
  params?: Record<string, ParamVal>;
}

const MISFIRE_OPTIONS: Array<{ label: string; value: 'run_now' | 'skip' | 'last_missed' }> = [
  { label: '跳过错过的触发（默认）', value: 'skip' },
  { label: '错过时立刻补一次', value: 'run_now' },
  { label: '使用最近一次错过的触发', value: 'last_missed' },
];

type ScheduleTemplatesResult = ReturnType<typeof usePluginStore.getState>['scheduleTemplates'];

export default function Schedules(): JSX.Element {
  const { loading, error, data, list, create, toggle, del } = useScheduleStore();
  const { data: workflows, list: loadWorkflows } = useWorkflowStore();
  const { scheduleTemplates, loadScheduleTemplates, scheduleTemplatesLoading } = usePluginStore();
  const [form] = Form.useForm<CreateValues>();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeTplKey, setActiveTplKey] = useState<string>('__generic__');

  useEffect(() => { void list(); void loadWorkflows({ pageSize: 500 }); void loadScheduleTemplates(); }, [list, loadWorkflows, loadScheduleTemplates]);

  // Flatten templates for dropdown: key = `${pluginId}::${tplId}`
  const templateList = useMemo(() => {
    const arr: Array<{
      key: string;
      pluginId: string;
      pluginName: string;
      templateId: string;
      label: string;
      description?: string;
      defaultCron?: string;
      targetWorkflowId?: string;
      paramsSchema: Record<string, ScheduleTemplateParam>;
    }> = [];
    if (!scheduleTemplates || !Array.isArray(scheduleTemplates)) return arr;
    const entriesArr = scheduleTemplates as unknown as any[];
    for (const entry of entriesArr) {
      const entryAny = entry as any;
      const templates: Array<{ id: string; label: string; description?: string; defaultCron?: string; targetWorkflowId?: string; paramsSchema: Record<string, ScheduleTemplateParam> }> =
        entryAny.templates ?? [];
      for (const tpl of templates) {
        arr.push({
          key: `${entryAny.pluginId}::${tpl.id}`,
          pluginId: entryAny.pluginId,
          pluginName: entryAny.pluginName ?? entryAny.pluginId,
          templateId: tpl.id,
          label: tpl.label,
          description: tpl.description,
          defaultCron: tpl.defaultCron,
          targetWorkflowId: tpl.targetWorkflowId,
          paramsSchema: tpl.paramsSchema ?? {},
        });
      }
    }
    return arr;
  }, [scheduleTemplates]);

  const activeTpl = useMemo(
    () => templateList.find((t) => t.key === activeTplKey) ?? null,
    [templateList, activeTplKey],
  );

  const workflowOptions = useMemo(
    () => (workflows?.items ?? []).map((w) => ({
      label: `${w.name}  (${w.id.slice(0, 8)})`,
      value: w.id,
    })),
    [workflows],
  );

  const onOpen = () => {
    setSubmitting(false);
    form.resetFields();
    form.setFieldsValue({
      templateKey: templateList[0]?.key ?? '__generic__',
      enabled: true,
      misfirePolicy: 'skip',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone as any,
      params: {},
    });
    setActiveTplKey(templateList[0]?.key ?? '__generic__');
    setOpen(true);
  };

  const onTemplateChange = (key: string) => {
    setActiveTplKey(key);
    const tpl = templateList.find((t) => t.key === key);
    if (tpl) {
      // Fill sensible defaults; keep user edits for `name` if any.
      form.setFieldsValue({
        cronExpr: tpl.defaultCron ?? '0 * * * *',
        workflowId: tpl.targetWorkflowId ?? undefined,
        params: {},
      });
    } else {
      form.setFieldsValue({
        cronExpr: '0 * * * *',
        workflowId: undefined,
        runOnceAt: null,
      });
    }
  };

  const onSubmit = async (): Promise<void> => {
    try {
      const vals = await form.validateFields();
      const isGeneric = vals.templateKey === '__generic__';
      const tpl = templateList.find((t) => t.key === vals.templateKey);
      setSubmitting(true);
      const hasOnce = !!vals.runOnceAt;
      const oneShotMs = hasOnce ? dayjs(vals.runOnceAt as any).valueOf() : undefined;
      if (isGeneric) {
        const hasCron = !!vals.cronExpr?.trim();
        if (!hasCron && !hasOnce) {
          message.warning('通用定时任务需要 cron 表达式或一次性运行时间。');
          return;
        }
        if (!vals.workflowId) {
          message.warning('通用定时任务需要选择一个关联工作流。');
          return;
        }
        await create({
          name: vals.name?.trim() || `通用任务 #${Date.now().toString(36)}`,
          cronExpr: hasCron ? vals.cronExpr!.trim() : undefined,
          oneShotAtMs: oneShotMs,
          workflowId: vals.workflowId,
          misfirePolicy: vals.misfirePolicy ?? 'skip',
          timezone: vals.timezone,
          enabled: vals.enabled ? 1 : 0,
        });
      } else if (tpl) {
        const hasCron = !!vals.cronExpr?.trim();
        if (!hasCron && !hasOnce) {
          message.warning('请填写 cron 或指定一次性运行时间。');
          return;
        }
        await create({
          name: vals.name?.trim() || `${tpl.label} #${Date.now().toString(36)}`,
          cronExpr: hasCron ? vals.cronExpr!.trim() : undefined,
          oneShotAtMs: oneShotMs,
          workflowId: vals.workflowId ?? tpl.targetWorkflowId ?? undefined,
          misfirePolicy: vals.misfirePolicy ?? 'skip',
          timezone: vals.timezone,
          enabled: vals.enabled ? 1 : 0,
          owner_plugin_id: tpl.pluginId,
          template_id: tpl.templateId,
          params: vals.params ?? {},
        });
      }
      message.success('定时任务已创建');
      setOpen(false);
    } catch (e) {
      if ((e as any).errorFields) return;
      message.error((e as { message?: string }).message ?? '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const cols: ColumnsType<any> = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 220 },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (v: string, row: { owner_plugin_id?: string }) => (
        <Space size={4}>
          <span>{v}</span>
          {row.owner_plugin_id && (
            <Tag color="geekblue" style={{ fontSize: 11 }}>
              owned by {row.owner_plugin_id}
            </Tag>
          )}
        </Space>
      ),
    },
    { title: 'Cron', dataIndex: 'cron_expr', key: 'cron', width: 160, render: (v: string | null) => v ?? <Tag color="gold">单次</Tag> },
    {
      title: '关联工作流',
      dataIndex: 'workflow_id',
      key: 'wf',
      width: 240,
      render: (v: string | null) => {
        if (!v) return <Tag color="default">无</Tag>;
        const wf = (workflows?.items ?? []).find((w) => w.id === v);
        return (
          <Space size={4}>
            <span style={{ color: '#555' }}>{wf?.name ?? v.slice(0, 10) + '…'}</span>
            <Tooltip title={v}><Tag color="blue">{v.slice(0, 8)}</Tag></Tooltip>
          </Space>
        );
      },
    },
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
      loading={(loading && !data) || scheduleTemplatesLoading}
      error={error}
      empty={!!data && data.total === 0}
      emptyDescription={
        <Empty
          description={
            <span>
              还没有定时任务。点击右上角 <Tag color="purple">添加定时任务</Tag>，
              从已声明模板的应用插件（或通用工作流）中选择并创建。
            </span>
          }
        />
      }
      title="定时任务"
      extra={
        <Space>
          <Tag color="purple">{(data?.total ?? 0).toString()} 个任务</Tag>
          <Button onClick={() => { void list(); void loadScheduleTemplates(); }} icon={<ReloadOutlined />}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={onOpen}>添加定时任务</Button>
        </Space>
      }
    >
      <Table
        size="small"
        rowKey="id"
        columns={cols}
        dataSource={data?.items ?? []}
        scroll={{ x: 1200 }}
        pagination={{
          current: data?.page ?? 1,
          pageSize: data?.pageSize ?? 20,
          total: data?.total ?? 0,
          showSizeChanger: true,
          onChange: (page, pageSize) => void list({ page, pageSize }),
        }}
      />

      <Modal
        title="添加定时任务"
        open={open}
        onCancel={() => setOpen(false)}
        destroyOnClose
        width={720}
        onOk={() => void onSubmit()}
        confirmLoading={submitting}
        okText="创建"
        cancelText="取消"
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{ templateKey: '__generic__', enabled: true, misfirePolicy: 'skip' }}
        >
          <Form.Item name="templateKey" label="选择创建来源">
            <Select
              onChange={(v) => onTemplateChange(v)}
              options={[
                ...templateList.map((t) => ({
                  label: `[${t.pluginName}] ${t.label}`,
                  value: t.key,
                  title: t.description,
                })),
                { label: '通用模式：指定 cron / 工作流（调试）', value: '__generic__' },
              ]}
            />
          </Form.Item>

          {activeTpl && activeTpl.description && (
            <Alert
              type="info"
              showIcon
              icon={<InfoCircleOutlined />}
              message={`${activeTpl.pluginName} · ${activeTpl.label}`}
              description={activeTpl.description}
              style={{ marginBottom: 12 }}
            />
          )}
          {!activeTpl && (
            <Alert
              type="warning"
              showIcon
              icon={<ExperimentOutlined />}
              message="通用模式（调试用）"
              description="只有当你清楚 cron + 工作流 ID 时才使用该模式。生产场景请由 App 插件声明模板。"
              style={{ marginBottom: 12 }}
            />
          )}

          <Form.Item name="name" label="任务名称" rules={[{ max: 120 }]}>
            <Input placeholder="可选，留空将自动生成" />
          </Form.Item>

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="cronExpr"
                label={<span><ClockCircleOutlined /> Cron 表达式</span>}
              >
                <Input placeholder="例：*/5 * * * *，留空则需指定『一次性运行』时间" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="runOnceAt" label="一次性运行（可选，优先级高于 cron）">
                <DatePicker showTime style={{ width: '100%' }} placeholder="不指定则走 cron" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="misfirePolicy" label="错过触发处理" rules={[{ required: true }]}>
                <Select options={MISFIRE_OPTIONS} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="timezone" label="时区">
                <Select
                  options={[
                    { label: 'Asia/Shanghai (UTC+8)', value: 'Asia/Shanghai' },
                    { label: 'UTC', value: 'UTC' },
                    { label: '本地', value: 'local' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="workflowId"
            label="关联工作流"
            rules={activeTpl?.targetWorkflowId ? [] : [{ required: true, message: '请选择一个工作流' }]}
          >
            <Select
              placeholder={activeTpl?.targetWorkflowId ? `模板指定工作流：${activeTpl.targetWorkflowId}` : '请选择'}
              showSearch
              optionFilterProp="label"
              options={workflowOptions}
              disabled={!!activeTpl?.targetWorkflowId}
            />
          </Form.Item>

          {activeTpl && Object.keys(activeTpl.paramsSchema).length > 0 && (
            <Collapse
              size="small"
              items={[
                {
                  key: 'params',
                  label: `${activeTpl.label} 参数（${Object.keys(activeTpl.paramsSchema).length}）`,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      {Object.entries(activeTpl.paramsSchema).map(([key, def]) => (
                        <ParamField key={key} name={key} def={def} form={form} />
                      ))}
                    </Space>
                  ),
                },
              ]}
              defaultActiveKey={['params']}
              style={{ marginBottom: 12 }}
            />
          )}

          <Form.Item name="enabled" label="创建后启用" valuePropName="checked">
            <Switch defaultChecked />
          </Form.Item>
        </Form>
      </Modal>
    </PageShell>
  );
}

/**
 * One dynamic field from the template's paramsSchema.
 * Writes to `form` field path `['params', key]`.
 */
function ParamField({
  name,
  def,
  form,
}: {
  name: string;
  def: ScheduleTemplateParam;
  form: any;
}): JSX.Element {
  const initialVal = useMemo(() => {
    if (def.defaultValue !== undefined) return def.defaultValue;
    if (def.type === 'boolean') return false;
    if (def.type === 'number') return 0;
    return '';
  }, [def]);
  // Seed on mount so user sees sensible defaults.
  useEffect(() => {
    const cur = (form.getFieldValue?.('params') ?? {}) as Record<string, ParamVal>;
    if (cur[name] === undefined) {
      form.setFieldsValue({ params: { ...cur, [name]: initialVal } });
    }
  }, [form, name, initialVal]);

  const required = !!def.required;

  if (def.type === 'select' && def.options) {
    return (
      <Form.Item
        label={def.label}
        name={['params', name]}
        rules={required ? [{ required: true, message: `${def.label} 为必填项` }] : undefined}
      >
        <Select
          options={def.options.map((o) => ({ label: String(o.label), value: o.value as any }))}
          placeholder={`请选择${def.label}`}
          style={{ width: '100%' }}
        />
      </Form.Item>
    );
  }
  if (def.type === 'boolean') {
    return (
      <Form.Item
        label={def.label}
        name={['params', name]}
        valuePropName="checked"
      >
        <Checkbox>{def.required ? '（必填，勾选后继续）' : '启用'}</Checkbox>
      </Form.Item>
    );
  }
  if (def.type === 'number') {
    return (
      <Form.Item
        label={def.label}
        name={['params', name]}
        rules={required ? [{ required: true, message: `${def.label} 为必填项` }] : undefined}
      >
        <InputNumber style={{ width: '100%' }} placeholder={`请输入${def.label}`} />
      </Form.Item>
    );
  }
  // string (default)
  return (
    <Form.Item
      label={def.label}
      name={['params', name]}
      rules={required ? [{ required: true, message: `${def.label} 为必填项` }] : undefined}
    >
      <Input placeholder={`请输入${def.label}`} />
    </Form.Item>
  );
}
