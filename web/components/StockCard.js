'use client';

import Link from 'next/link';

function formatPrice(price) {
  if (price >= 1000000) return (price / 1000000).toFixed(1) + 'M';
  if (price >= 1000) return (price / 1000).toFixed(1) + 'K';
  return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function StockCard({ userId, displayName, avatarUrl, currentPrice, previousClose, sharesOutstanding }) {
  const cp = currentPrice ?? 5000;
  const pc = previousClose ?? 5000;
  const change = cp - pc;
  const changePercent = pc > 0 ? (change / pc) * 100 : 0;
  const isGain = change >= 0;

  return (
    <Link href={`/stock/${userId}`} style={{ textDecoration: 'none' }}>
      <div className={`glass-card stock-card ${isGain ? 'gain' : 'loss'}`}>
        <div className="stock-card-header">
          <div className="stock-card-avatar">
            {avatarUrl ? (
              <img src={avatarUrl} alt={displayName || userId} />
            ) : (
              <div style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--bg-tertiary)',
                color: 'var(--text-muted)',
                fontWeight: 700,
                fontSize: 'var(--text-lg)',
              }}>
                {(displayName || '?')[0].toUpperCase()}
              </div>
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="stock-card-name">{displayName || userId}</div>
            <div className="stock-card-ticker">{userId.slice(0, 8)}</div>
          </div>
        </div>

        <div className="stock-card-price" style={{ color: isGain ? 'var(--accent-green)' : 'var(--accent-red)' }}>
          {formatPrice(cp)}
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginLeft: '4px' }}>coins</span>
        </div>

        <span className={`stock-card-change ${isGain ? 'gain' : 'loss'}`}>
          {isGain ? '▲' : '▼'} {Math.abs(changePercent).toFixed(2)}%
        </span>

        <div className="stock-card-footer">
          <span>Shares: {sharesOutstanding?.toLocaleString() ?? '—'}</span>
          <span>{isGain ? '+' : ''}{change.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
      </div>
    </Link>
  );
}
