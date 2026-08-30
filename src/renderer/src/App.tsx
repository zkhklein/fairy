import { useEffect, useState } from 'react';

declare global {
  interface Window {
    fmb: {
      version: string;
      platform: string;
    };
  }
}

export default function App(): JSX.Element {
  const [platform, setPlatform] = useState<string>('');
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    if (typeof window.fmb !== 'undefined') {
      setVersion(window.fmb.version);
      setPlatform(window.fmb.platform);
    } else {
      setVersion('dev-browser');
      setPlatform('web');
    }
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4c1d95 100%)',
        color: '#ffffff',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: '48px', margin: 0, letterSpacing: '-0.5px' }}>Hello FMB</h1>
        <p style={{ fontSize: '18px', marginTop: '16px', opacity: 0.85 }}>
          Fairy Maid Brigade v{version || '0.1.0'} · Task 1 Scaffold · Running on{' '}
          <code style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 8px', borderRadius: 4 }}>
            {platform || 'unknown'}
          </code>
        </p>
        <p style={{ marginTop: '24px', opacity: 0.6, fontSize: '14px' }}>
          Electron + React + TypeScript · Next: Task 2 (SQLite / Kysely / Logging)
        </p>
      </div>
    </div>
  );
}
