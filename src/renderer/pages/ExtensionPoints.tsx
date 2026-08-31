import React from 'react';

/**
 * Extension Points page.
 *
 * This page is for listing all registered extension points and their listeners.
 * In T10 we render a static skeleton plus four states. The actual list comes
 * from the main process via the event bus; since the preload doesn't yet expose
 * a dedicated "list extension points" channel, we fetch it through system info
 * as a proxy (and show a friendly empty state). Once a dedicated IPC channel
 * is added, swap in the real store call — the page shell stays identical.
 */
import { Button, Card, List, Space, Tag, Badge, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useEffect } from 'react';
import PageShell from '../components/PageShell';
import { useExtensionPointsStore } from '../stores';

export default function ExtensionPoints(): JSX.Element {
  const loading = useExtensionPointsStore((s) => s.loading);
  const error = useExtensionPointsStore((s) => s.error);
  const data = useExtensionPointsStore((s) => s.data);
  const list = useExtensionPointsStore((s) => s.list);

  useEffect(() => { void list({ pageSize: 100 }); }, [list]);

  const totalBindings = (data?.items ?? []).reduce((sum, it) => sum + it.bindings.length, 0);
  const totalListeners = (data?.items ?? []).reduce((sum, it) => sum + it.listenerCount, 0);

  const echoBinding = async (pluginId: string, handlerName: string): Promise<void> => {
    // DX helper: 点击时提示，后续版本可跳转到插件详情
    message.info(`绑定详情：pluginId=${pluginId}，handlerName=${handlerName}`);
  };

  return (
    <PageShell
      loading={loading && !data}
      error={error}
      empty={!!data && data.total === 0}
      emptyDescription="当前没有注册任何扩展点（这是一个空基座的正常状态）。"
      title="扩展点"
      extra={
        <Space wrap>
          <Tag color="geekblue">{data?.total ?? 0} 个入口</Tag>
          <Tag color="purple">{totalBindings} 个绑定</Tag>
          <Tag color="blue">{totalListeners} 个监听</Tag>
          <Button icon={<ReloadOutlined />} onClick={() => void list({ pageSize: 100 })}>刷新</Button>
        </Space>
      }
    >
      <Card size="small">
        <List
          dataSource={data?.items ?? []}
          size="small"
          pagination={{
            current: data?.page ?? 1,
            pageSize: data?.pageSize ?? 20,
            total: data?.total ?? 0,
            showSizeChanger: true,
            onChange: (page, pageSize) => void list({ page, pageSize }),
          }}
          renderItem={(item) => (
            <List.Item
              key={item.name}
              actions={[
                <Badge
                  key="lc"
                  count={item.listenerCount}
                  showZero
                  {...({ numberStyle: { backgroundColor: item.listenerCount > 0 ? undefined : '#aaa', minWidth: 24 } } as any)}
                  title={`注册了 ${item.listenerCount} 个监听器`}
                />,
                ...item.bindings.slice(0, 5).map((b, i) => (
                  <Tag key={`${b.plugin_id}-${b.handler_name}-${i}`} color={b.enabled ? 'green' : 'default'}>
                    <a
                      onClick={(e) => { e.preventDefault(); void echoBinding(b.plugin_id, b.handler_name); }}
                      style={{ color: 'inherit', textDecoration: 'none' }}
                      title={`plugin=${b.plugin_id} handler=${b.handler_name}`}
                    >
                      {b.plugin_id}::{b.handler_name}
                    </a>
                  </Tag>
                )),
                item.bindings.length > 5 ? <Tag key="more">+{item.bindings.length - 5} more</Tag> : null,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <code>{item.name}</code>
                    {item.builtin ? <Tag color="blue">内置</Tag> : <Tag color="orange">自定义</Tag>}
                  </Space>
                }
                description={item.description || '（暂无描述）'}
              />
            </List.Item>
          )}
        />
      </Card>
    </PageShell>
  );
}
