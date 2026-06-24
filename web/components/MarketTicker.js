'use client';

import { useEffect, useState } from 'react';

export default function MarketTicker() {
  const [stocks, setStocks] = useState([]);

  useEffect(() => {
    async function fetchStocks() {
      try {
        const res = await fetch('/api/stocks');
        if (!res.ok) return;
        const data = await res.json();
        setStocks(Array.isArray(data) ? data : (data.stocks || []));
      } catch {
        // silently fail — ticker is non-critical
      }
    }
    fetchStocks();
  }, []);

  if (stocks.length === 0) return null;

  // Duplicate the list so the scroll appears seamless
  const items = [...stocks, ...stocks];

  return (
    <div className="ticker-wrap">
      <div className="ticker-track">
        {items.map((stock, i) => {
          const change = stock.currentPrice - stock.previousClose;
          const pct = stock.previousClose > 0 ? (change / stock.previousClose) * 100 : 0;
          const isGain = change >= 0;
          const colorVar = isGain ? 'var(--accent-green)' : 'var(--accent-red)';

          return (
            <span className="ticker-item" key={`${stock.userId}-${i}`}>
              <span>{stock.displayName || stock.userId.slice(0, 8)}</span>
              <span className="ticker-price" style={{ color: colorVar }}>
                {stock.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="ticker-change" style={{ color: colorVar }}>
                {isGain ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
