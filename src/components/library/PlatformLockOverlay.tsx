interface PlatformLockOverlayProps {
  priceCents: number | null;
  onClick: () => void;
}

export function PlatformLockOverlay({ priceCents, onClick }: PlatformLockOverlayProps) {
  const priceLabel = priceCents ? `$${(priceCents / 100).toFixed(2)}` : "Paid";

  return (
    <div className="platform-lock-overlay" onClick={onClick}>
      <div className="platform-lock-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
      <span className="platform-lock-price">{priceLabel}</span>
    </div>
  );
}
