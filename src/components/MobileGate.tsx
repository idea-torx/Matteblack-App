import { useIsMobile } from '../hooks/useIsMobile';

export function MobileGate({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();

  if (!isMobile) return <>{children}</>;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 99999,
      background: 'rgb(12, 12, 14)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px 24px',
      fontFamily: '"Satoshi", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      textAlign: 'center',
    }}>
      <svg
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#9a9aa6"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ marginBottom: 24 }}
      >
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>

      <h1 style={{
        fontSize: 22,
        fontWeight: 600,
        color: '#e8e8ed',
        margin: '0 0 12px 0',
        lineHeight: 1.3,
      }}>
        Fal Forge is designed for desktop
      </h1>

      <p style={{
        fontSize: 15,
        color: '#9a9aa6',
        margin: 0,
        maxWidth: 320,
        lineHeight: 1.5,
      }}>
        Please open this page on a desktop browser for the best experience.
      </p>
    </div>
  );
}
