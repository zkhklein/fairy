/**
 * App-plugin sub-page mount host (Task 12-A/B/C complete).
 *
 * Architecture:
 *   Layer 1 (T12-A): Routing — URL `/app-plugins/:pluginId` matches; redirects
 *     to 404 unless `pluginId` corresponds to an installed type=app plugin.
 *
 *   Layer 2 (T12-A): Shadow DOM isolation — CSS from the root document can't
 *     leak into the shadow root. Theme variables (--ant-*, --fmb-*) are copied
 *     forward via `host.style.setProperty`.
 *
 *   Layer 3 (T12-B): UMD bundle loading — the main process compiles the plugin's
 *     renderer entry to a self-contained CJS bundle (`renderer.umd.js`) via
 *     esbuild at install time. This page fetches the bundle code via IPC
 *     (`main:plugin.getRenderer`), evaluates it with `new Function` in a
 *     controlled scope, and provides React/ReactDOM/antd from the host via a
 *     `require` shim so plugins share the same React instance (hooks work).
 *
 *   Layer 4 (T12-C): HostUIApi — `callPluginMainAction` routes through IPC
 *     (`main:plugin.callAction`) to the sandboxed plugin main module, bridging
 *     the renderer → main → sandbox round-trip.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import React from 'react';
import ReactDOM from 'react-dom';
import * as antd from 'antd';
import { Result, Skeleton, Spin } from 'antd';
import { useNavigate, useParams, Link } from 'react-router-dom';
import PageShell from '../components/PageShell';
import { fmbApi } from '../api/fmb';
import type { FmbApi } from '../../preload';

/** Restricted, DOM-safe subset of the host API passed to plugins. */
export interface HostUIApi {
  /** Read plugin-scoped kv_store entries for this plugin. */
  readPluginState(): Promise<Record<string, unknown>>;
  /** Invoke `plugin.exports[action](payload)` via IPC → sandbox. */
  callPluginMainAction<A extends string>(action: A, payload?: unknown): Promise<unknown>;
  /** Navigate the top-level React Router host (not Shadow DOM internal routing). */
  navigate(to: string): void;
}

/** The shape a plugin renderer module must export. */
interface PluginRendererModule {
  mount(hostElement: HTMLElement, hostApi: HostUIApi): void | Promise<void>;
  unmount?(hostElement: HTMLElement): void;
}

function buildHostApi(pluginId: string, navigate: ReturnType<typeof useNavigate>): HostUIApi {
  return {
    readPluginState: async () => {
      // Plugin-scoped state is stored in kv_store via the plugin's main module.
      // For now, return empty; a dedicated IPC channel can be added if needed.
      return {};
    },
    callPluginMainAction: async (action, payload) => {
      if (!pluginId) return null;
      const r = await fmbApi.pluginCallAction({ pluginId, action, payload: payload ?? null });
      if (!r.ok) throw new Error(r.error ?? `action "${action}" failed`);
      return r.result ?? null;
    },
    navigate: (to) => navigate(to),
  };
}

/**
 * Evaluate a CJS-format renderer bundle in a controlled scope.
 * Returns the module.exports object.
 */
function evaluateRendererBundle(code: string): PluginRendererModule {
  const moduleObj = { exports: {} as Record<string, unknown> };
  // Provide React/ReactDOM/antd from the host so plugins share the same
  // React instance (critical for hooks to work correctly).
  const requireFn = (name: string): unknown => {
    if (name === 'react') return React;
    if (name === 'react-dom') return ReactDOM;
    if (name === 'react-dom/client') return ReactDOM;
    if (name === 'react/jsx-runtime') {
      // Minimal jsx-runtime shim for automatic runtime (children in props.children)
      return {
        jsx: (type: any, props: any) => React.createElement(type, props),
        jsxs: (type: any, props: any) => React.createElement(type, props),
        Fragment: React.Fragment,
      };
    }
    if (name === 'antd') return antd;
    throw new Error(`Plugin renderer cannot require "${name}" — only react, react-dom, antd are provided by host`);
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', code);
  fn(moduleObj, moduleObj.exports, requireFn);
  return moduleObj.exports as unknown as PluginRendererModule;
}

export default function AppPluginPage(): JSX.Element {
  const { pluginId } = useParams<{ pluginId: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const unmountRef = useRef<((host: HTMLElement) => void) | null>(null);
  const api = useMemo(() => buildHostApi(pluginId ?? '', navigate), [pluginId, navigate]);

  // ---- Layer 1: verify plugin exists and is type=app ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pluginId) { setNotFound(true); setLoading(false); return; }
      setLoading(true); setError(null); setBundleError(null);
      try {
        const p = await fmbApi.pluginGet({ id: pluginId });
        if (cancelled) return;
        if (!p) { setNotFound(true); return; }
        if (p.type !== 'app') {
          setError(`插件 ${p.name} 的类型是 ${p.type}，不是 app 类型，无子页面。请返回插件管理查看。`);
          return;
        }
        setName(p.name);
      } catch (e) {
        if (!cancelled) setError((e as { message?: string }).message ?? '加载插件元数据失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pluginId]);

  // ---- Layer 2+3: load UMD bundle, attach Shadow DOM, mount plugin ----
  useEffect(() => {
    if (loading || error || notFound || !pluginId || !hostRef.current) return;

    const host = hostRef.current;
    let cancelled = false;

    (async () => {
      setBundleLoading(true);
      setBundleError(null);
      try {
        const renderer = await fmbApi.pluginGetRenderer({ pluginId });
        if (cancelled) return;

        if (!renderer.code) {
          setBundleError(
            '该插件没有可用的渲染器 bundle（renderer.umd.js）。\n' +
            '可能是插件未声明 renderer 入口、编译失败、或打包版应用未内置 esbuild。\n' +
            '请确保插件 manifest 中 renderer 字段指向有效入口文件。',
          );
          return;
        }

        // Attach Shadow DOM (only if not already attached)
        const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

        // Copy AntD theme tokens from ConfigProvider CSS vars
        try {
          const styles = getComputedStyle(document.documentElement);
          const h = shadow.host as HTMLElement;
          for (let i = 0; i < styles.length; i++) {
            const prop = styles[i];
            if (prop.startsWith('--ant-') || prop.startsWith('--fmb-')) {
              h.style.setProperty(prop, styles.getPropertyValue(prop));
            }
          }
        } catch { /* noop */ }

        // Create a container element inside the shadow root for the plugin to mount into
        const container = document.createElement('div');
        container.id = 'plugin-root';
        container.style.padding = '8px';
        shadow.appendChild(container);

        // Evaluate the CJS bundle in a controlled scope
        const pluginModule = evaluateRendererBundle(renderer.code);

        if (typeof pluginModule.mount !== 'function') {
          setBundleError('插件渲染器缺少 mount(hostElement, hostUIApi) 导出函数。请检查插件 renderer 入口的默认导出。');
          return;
        }

        // Mount the plugin UI into the Shadow DOM container
        await pluginModule.mount(container, api);
        unmountRef.current = typeof pluginModule.unmount === 'function' ? pluginModule.unmount : null;
      } catch (e) {
        if (!cancelled) {
          const msg = (e as Error)?.message ?? String(e);
          setBundleError(`渲染器加载/挂载失败: ${msg}`);
        }
      } finally {
        if (!cancelled) setBundleLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // Clean up: unmount plugin, then clear Shadow DOM
      try { unmountRef.current?.(host); } catch { /* noop */ }
      unmountRef.current = null;
      if (host.shadowRoot) {
        while (host.shadowRoot.firstChild) host.shadowRoot.removeChild(host.shadowRoot.firstChild);
      }
    };
  }, [loading, error, notFound, pluginId, api]);

  if (notFound) {
    return (
      <div style={{ padding: 24 }}>
        <Result
          status="404"
          title="插件不存在或尚未安装"
          subTitle={`pluginId = ${pluginId ?? '—'}`}
          extra={<Link to="/plugins"><button>返回插件管理</button></Link>}
        />
      </div>
    );
  }

  return (
    <PageShell
      loading={loading}
      error={error ?? bundleError}
      empty={false}
      title={
        <span>
          插件子页面 · <code style={{ color: '#5b21b6' }}>{pluginId}</code>
          {name && <span style={{ color: '#888', marginLeft: 8, fontWeight: 400, fontSize: 14 }}>（{name}）</span>}
        </span>
      }
      extra={
        <Link to="/plugins" style={{ color: '#5b21b6' }}>← 返回插件管理</Link>
      }
    >
      <Spin spinning={(loading && !name) || bundleLoading} size="large">
        <div style={{ background: '#fff', border: '1px dashed #e0d7f0', borderRadius: 8, padding: 4 }}>
          {loading && !name
            ? <Skeleton active paragraph={{ rows: 4 }} round />
            : (
              <div
                ref={hostRef}
                id={`app-plugin-${pluginId}`}
                data-plugin-id={pluginId}
                style={{ minHeight: 280 }}
              />
            )}
        </div>
      </Spin>
    </PageShell>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertApiFromPreloadCovariant = FmbApi extends unknown ? 'ok' : never;
