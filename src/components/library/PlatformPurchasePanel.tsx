import type { PlatformItem } from "../../types/platformLibrary";

interface PlatformPurchasePanelProps {
  item: PlatformItem;
  onClose: () => void;
  onPurchaseComplete: () => void;
}

export function PlatformPurchasePanel({ item, onClose, onPurchaseComplete: _onPurchaseComplete }: PlatformPurchasePanelProps) {
  const priceLabel = item.price_cents ? `$${(item.price_cents / 100).toFixed(2)}` : "Free";

  return (
    <div className="platform-purchase-panel">
      <div className="platform-purchase-header">
        <h3 className="platform-purchase-title">{item.name}</h3>
        <button type="button" className="platform-purchase-close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>

      {item.preview_urls && item.preview_urls.length > 0 && (
        <div className="platform-purchase-previews">
          {item.preview_urls.map((url, i) => (
            <img key={i} src={url} alt={`Preview ${i + 1}`} className="platform-purchase-preview-img" />
          ))}
        </div>
      )}

      {item.description && (
        <p className="platform-purchase-desc">{item.description}</p>
      )}

      <div className="platform-purchase-meta">
        <span className="platform-purchase-price">{priceLabel}</span>
        <span className="platform-purchase-count">{item.content_count} items</span>
      </div>

      {item.tags && item.tags.length > 0 && (
        <div className="platform-purchase-tags">
          {item.tags.map((tag) => (
            <span key={tag} className="platform-purchase-tag">{tag}</span>
          ))}
        </div>
      )}

      <div className="platform-purchase-actions">
        <button type="button" className="platform-purchase-btn platform-purchase-btn--primary" disabled>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Unlock for Me — {priceLabel}
        </button>
        <button type="button" className="platform-purchase-btn platform-purchase-btn--secondary" disabled>
          Unlock for Team — {priceLabel}
        </button>
        <span className="platform-purchase-note">Purchase integration coming soon</span>
      </div>
    </div>
  );
}
