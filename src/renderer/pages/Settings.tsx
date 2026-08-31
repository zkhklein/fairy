import React from 'react';

/**
 * Settings page.
 *
 * Two panels:
 *   1. Global settings Form — bound to `useSettingsStore` (kv_store-backed)
 *      Fields: queue.concurrency, http.port, http.token, log.level,
 *             system.autoStart, system.closeBehavior, ui.compact, ui.collapsed
 *   2. System info + About
 *
 * Four states via PageShell.
 */
import {
  Button, Card, Col, Descriptions, Form, InputNumber, Radio, Row, Select,
  Space, Switch, Tag, message, Divider, Input, Tooltip, Tabs,
} from 'antd';
import {
  FolderOpenOutlined, ReloadOutlined, SaveOutlined, CopyOutlined,
  ThunderboltOutlined, KeyOutlined, SettingOutlined, CodeOutlined,
} from '@ant-design/icons';
import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import PageShell from '../components/PageShell';
import { useUiStore, useSettingsStore } from '../stores';
import type { MainSystemGetSettingsResult } from '@shared/ipc';
import AgentsMd from '../src/docs/AGENTS.md?raw';
import PluginDevMd from '../src/docs/plugin-dev.md?raw';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Markdown 渲染定制：深色 pre/code 块（代码块高亮）+ 合理的 h/href/table 样式。
 * 不引入 react-syntax-highlighter（省 bundle 体积）。
 */
const MD_COMPONENTS: Parameters<typeof ReactMarkdown>['0']['components'] = {
  code({ className, children, ...rest }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const isBlock = !!match || typeof children === 'string' && /\n/.test(String(children));
    if (isBlock) {
      return (
        <pre
          style={{
            background: '#1e1e1e',
            color: '#e6e6e6',
            padding: '10px 14px',
            borderRadius: 6,
            overflowX: 'auto',
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          <code className={className} {...rest} style={{ fontFamily: 'Consolas, Menlo, monospace' }}>
            {children}
          </code>
        </pre>
      );
    }
    return (
      <code
        {...rest}
        className={className}
        style={{
          background: 'rgba(125, 125, 125, 0.12)',
          padding: '1px 5px',
          borderRadius: 4,
          fontSize: 12,
          fontFamily: 'Consolas, Menlo, monospace',
        }}
      >
        {children}
      </code>
    );
  },
  pre({ children }: any) { return <>{children}</>; },
  h1({ children }: any) { return <h1 style={{ fontSize: 20, margin: '12px 0 8px', fontWeight: 700 }}>{children}</h1>; },
  h2({ children }: any) { return <h2 style={{ fontSize: 17, margin: '12px 0 6px', fontWeight: 700, borderBottom: '1px solid rgba(0,0,0,0.08)', paddingBottom: 4 }}>{children}</h2>; },
  h3({ children }: any) { return <h3 style={{ fontSize: 15, margin: '10px 0 4px', fontWeight: 600 }}>{children}</h3>; },
  h4({ children }: any) { return <h4 style={{ fontSize: 14, margin: '8px 0 4px', fontWeight: 600 }}>{children}</h4>; },
  p({ children }: any) { return <p style={{ margin: '6px 0' }}>{children}</p>; },
  a({ href, children }: any) {
    return (
      <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--ant-color-link, #1677ff)' }}>
        {children}
      </a>
    );
  },
  table({ children }: any) {
    return (
      <div style={{ overflowX: 'auto', margin: '8px 0' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>{children}</table>
      </div>
    );
  },
  th({ children }: any) { return <th style={{ border: '1px solid rgba(0,0,0,0.12)', padding: '6px 8px', textAlign: 'left', background: 'rgba(125,125,125,0.06)' }}>{children}</th>; },
  td({ children }: any) { return <td style={{ border: '1px solid rgba(0,0,0,0.12)', padding: '6px 8px' }}>{children}</td>; },
  ul({ children }: any) { return <ul style={{ paddingLeft: 22, margin: '6px 0' }}>{children}</ul>; },
  ol({ children }: any) { return <ol style={{ paddingLeft: 22, margin: '6px 0' }}>{children}</ol>; },
  blockquote({ children }: any) {
    return <blockquote style={{ margin: '8px 0', padding: '4px 12px', borderLeft: '3px solid var(--ant-color-primary, #1677ff)', color: 'rgba(0,0,0,0.7)' }}>{children}</blockquote>;
  },
};

export default function Settings(): JSX.Element {
  const { systemLoading, systemError, systemInfo, loadSystem, refreshHealth } = useUiStore();
  const settings = useSettingsStore((s) => s.data);
  const settingsLoading = useSettingsStore((s) => s.loading);
  const settingsError = useSettingsStore((s) => s.error);
  const loadSettings = useSettingsStore((s) => s.load);
  const patchSettings = useSettingsStore((s) => s.patch);
  const [form] = Form.useForm<MainSystemGetSettingsResult>();

  useEffect(() => { void loadSystem(); void loadSettings(); }, [loadSystem, loadSettings]);

  // Sync form when settings load
  useEffect(() => {
    if (settings) form.setFieldsValue(settings);
  }, [settings, form]);

  const copy = async (val: string, label: string): Promise<void> => {
    try { await navigator.clipboard.writeText(val); message.success(`已复制 ${label}`); }
    catch { message.warning('复制失败'); }
  };

  const openPath = (p: string, kind: string): void => {
    message.info(`【${kind}】路径：${p}`);
    void copy(p, kind);
  };

  const onSave = async (): Promise<void> => {
    try {
      const vals = await form.validateFields();
      const result = await patchSettings(vals);
      message.success('设置已保存');
      void refreshHealth();
      // If concurrency changed, job store auto-applies via IPC side-effect
      if (vals['queue.concurrency'] !== settings?.['queue.concurrency']) {
        message.info(`全局并发已设为 ${result['queue.concurrency']}`);
      }
    } catch (e) {
      if ((e as any).errorFields) return; // validation error, antd shows inline
      message.error((e as { message?: string }).message ?? '保存失败');
    }
  };

  const generateToken = (): void => {
    // Generate a 32-byte random hex token
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const token = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    form.setFieldValue('http.token', token);
    message.success('已生成新 Token，记得保存');
  };

  const loading = systemLoading || settingsLoading;
  const error = systemError ?? settingsError;

  return (
    <PageShell
      loading={loading && !systemInfo && !settings}
      error={error}
      empty={!systemInfo && !settings}
      emptyDescription="系统信息尚未加载，请重试。"
      title="设置"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => { void loadSystem(); void loadSettings(); }}>刷新</Button>
        </Space>
      }
    >
      <Row gutter={[16, 16]}>
        {/* ---- Settings Form ---- */}
        <Col xs={24} lg={14}>
          <Card
            title={<span><SettingOutlined /> 全局设置</span>}
            size="small"
            extra={<Button type="primary" icon={<SaveOutlined />} onClick={() => void onSave()}>保存</Button>}
          >
            <Form
              form={form}
              layout="vertical"
              initialValues={settings ?? undefined}
            >
              <Divider orientation="left" plain>队列</Divider>
              <Form.Item
                name="queue.concurrency"
                label="全局并发数"
                tooltip="工作队列同时执行的最大作业数（1-256）"
                rules={[{ required: true, type: 'number', min: 1, max: 256, message: '1-256 的整数' }]}
              >
                <InputNumber min={1} max={256} style={{ width: 200 }} />
              </Form.Item>

              <Divider orientation="left" plain>HTTP API</Divider>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item
                    name="http.port"
                    label="HTTP API 端口"
                    tooltip="localhost API 绑定端口（1024-65535）"
                    rules={[{ required: true, type: 'number', min: 1024, max: 65535, message: '1024-65535' }]}
                  >
                    <InputNumber min={1024} max={65535} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="http.token" label="Bearer Token" tooltip="API 鉴权令牌，留空则首次启动自动生成">
                    <Space.Compact style={{ width: '100%' }}>
                      <Input.Password name="http.token" placeholder="点击右侧生成" style={{ width: 'calc(100% - 90px)' }} />
                      <Button icon={<KeyOutlined />} onClick={generateToken} style={{ width: 90 }}>生成</Button>
                    </Space.Compact>
                  </Form.Item>
                </Col>
              </Row>

              <Divider orientation="left" plain>系统</Divider>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="log.level" label="日志级别" rules={[{ required: true }]}>
                    <Select options={LOG_LEVELS.map((l) => ({ label: l, value: l }))} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="system.closeBehavior" label="关闭窗口行为" tooltip="点击窗口 X 按钮时的行为">
                    <Radio.Group>
                      <Radio.Button value="tray">最小化到托盘</Radio.Button>
                      <Radio.Button value="quit">退出程序</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item name="system.autoStart" label="开机自启" valuePropName="checked">
                <Switch checkedChildren="开" unCheckedChildren="关" />
              </Form.Item>

              <Divider orientation="left" plain>界面</Divider>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="ui.compact" label="紧凑模式" valuePropName="checked">
                    <Switch checkedChildren="开" unCheckedChildren="关" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="ui.collapsed" label="侧边栏默认折叠" valuePropName="checked">
                    <Switch checkedChildren="开" unCheckedChildren="关" />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Card>
        </Col>

        {/* ---- System info + About ---- */}
        <Col xs={24} lg={10}>
          <Card title="系统信息" size="small" extra={<Tag color="geekblue">v{systemInfo?.version ?? '—'}</Tag>}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="版本">{systemInfo?.version ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="平台 / 架构">{systemInfo?.platform ?? '—'} / {systemInfo?.arch ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Node / Electron">{systemInfo?.nodeVersion ?? '—'} / {systemInfo?.electronVersion ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="DB 路径">
                <Space>
                  <code style={{ wordBreak: 'break-all', fontSize: 12 }}>{systemInfo?.dbPath ?? '—'}</code>
                  {systemInfo?.dbPath && <Button size="small" type="link" icon={<CopyOutlined />} onClick={() => void copy(systemInfo.dbPath, 'DB路径')} />}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="日志目录">
                <Space>
                  <code style={{ wordBreak: 'break-all', fontSize: 12 }}>{systemInfo?.logsDir ?? '—'}</code>
                  {systemInfo?.logsDir && (
                    <Tooltip title="打开目录"><Button size="small" type="link" icon={<FolderOpenOutlined />} onClick={() => openPath(systemInfo.logsDir, '日志目录')} /></Tooltip>
                  )}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="插件目录">
                <Space>
                  <code style={{ wordBreak: 'break-all', fontSize: 12 }}>{systemInfo?.pluginsDir ?? '—'}</code>
                  {systemInfo?.pluginsDir && (
                    <Tooltip title="打开目录"><Button size="small" type="link" icon={<FolderOpenOutlined />} onClick={() => openPath(systemInfo.pluginsDir, '插件目录')} /></Tooltip>
                  )}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="运行时长">
                {systemInfo ? `${Math.floor(systemInfo.uptimeMs / 60000)}m ${Math.floor((systemInfo.uptimeMs % 60000) / 1000)}s` : '—'}
              </Descriptions.Item>
            </Descriptions>
          </Card>
          <Divider />
          <Card title="关于" size="small">
            <p><strong>Fairy Maid Brigade</strong>（妖精女仆团）— 跨 PC 端、基于插件的软件间协作工作流编排平台。</p>
            <p style={{ color: '#8c8c8c', fontSize: 12 }}>© {new Date().getFullYear()} Fairy Maid Brigade</p>
          </Card>
          <Divider />
          <Tooltip title="为开发 Agent 与插件作者准备的内嵌文档。修改请编辑根目录 AGENTS.md 与 docs/plugin-dev.md 再同步到 src/renderer/src/docs/">
            <Card title={<span><CodeOutlined /> 开发者文档</span>} size="small">
              <Tabs
              defaultActiveKey="plugin"
              size="small"
              items={[
                {
                  key: 'plugin',
                  label: '插件 API 文档',
                  children: (
                    <div
                      style={{
                        maxHeight: 520,
                        overflowY: 'auto',
                        padding: '12px 16px',
                        border: '1px solid var(--ant-color-border, #f0f0f0)',
                        borderRadius: 8,
                        fontSize: 13,
                        lineHeight: 1.7,
                      }}
                    >
                      <ReactMarkdown components={MD_COMPONENTS}>{PluginDevMd}</ReactMarkdown>
                    </div>
                  ),
                },
                {
                  key: 'agents',
                  label: 'Agent 操作手册',
                  children: (
                    <div
                      style={{
                        maxHeight: 520,
                        overflowY: 'auto',
                        padding: '12px 16px',
                        border: '1px solid var(--ant-color-border, #f0f0f0)',
                        borderRadius: 8,
                        fontSize: 13,
                        lineHeight: 1.7,
                      }}
                    >
                      <ReactMarkdown components={MD_COMPONENTS}>{AgentsMd}</ReactMarkdown>
                    </div>
                  ),
                },
              ]}
            />
            </Card>
          </Tooltip>
        </Col>
      </Row>
    </PageShell>
  );
}
