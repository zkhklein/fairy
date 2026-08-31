/**
 * Four-state page shell.
 *
 * Every page in T10 composes this instead of re-implementing
 * Skeleton / Empty / Result error boilerplate.
 *
 * States:
 *   - `loading`  → AntD `Skeleton` (rounded, paragraph rows)
 *   - `error`    → AntD `Result` (status="error") with the error message
 *   - `empty`    → AntD `Empty` (no data yet)
 *   - default    → renders `children` as the "success" state
 */
import { Empty, Result, Skeleton } from 'antd';
import type { ReactNode } from 'react';

export interface PageShellProps {
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyDescription?: string;
  children: ReactNode;
  title?: ReactNode;
  extra?: ReactNode;
}

export default function PageShell({
  loading,
  error,
  empty,
  emptyDescription,
  children,
  title,
  extra,
}: PageShellProps): JSX.Element {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      {(title || extra) && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          {title && (
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{title}</h2>
          )}
          {extra && <div>{extra}</div>}
        </div>
      )}

      {loading ? (
        <Skeleton active paragraph={{ rows: 8 }} round />
      ) : error ? (
        <Result status="error" title="加载失败" subTitle={error} />
      ) : empty ? (
        <Empty description={emptyDescription ?? '暂无数据'} />
      ) : (
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
      )}
    </div>
  );
}
