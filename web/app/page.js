'use client';

import { useEffect, useState } from 'react';
import MarketTicker from '@/components/MarketTicker';
import StockCard from '@/components/StockCard';

function getChangePercent(stock) {
  return stock.previousClose > 0
    ? (stock.currentPrice - stock.previousClose) / stock.previousClose
    : 0;
}

export default function MarketPage() {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState(null); // 'price' | 'change' | 'volume'
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    async function fetchStocks() {
      try {
        const res = await fetch('/api/stocks');
        if (!res.ok) throw new Error();
        const data = await res.json();
        setStocks(Array.isArray(data) ? data : (data.stocks || []));
      } catch {
        setStocks([]);
      } finally {
        setLoading(false);
      }
    }
    fetchStocks();
  }, []);

  function handleSort(key) {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  // Filter by search
  const filtered = stocks.filter((s) =>
    (s.displayName || s.userId).toLowerCase().includes(search.toLowerCase())
  );

  // Apply custom sort or default (by change %)
  function applySortAndFilter(list) {
    const arr = [...list];
    if (sortKey === 'price') {
      arr.sort((a, b) => sortAsc ? a.currentPrice - b.currentPrice : b.currentPrice - a.currentPrice);
    } else if (sortKey === 'change') {
      arr.sort((a, b) => sortAsc ? getChangePercent(a) - getChangePercent(b) : getChangePercent(b) - getChangePercent(a));
    } else if (sortKey === 'volume') {
      arr.sort((a, b) => sortAsc ? (a.sharesOutstanding ?? 0) - (b.sharesOutstanding ?? 0) : (b.sharesOutstanding ?? 0) - (a.sharesOutstanding ?? 0));
    } else {
      arr.sort((a, b) => getChangePercent(b) - getChangePercent(a));
    }
    return arr;
  }

  const sorted = applySortAndFilter(filtered);
  const gainers = sorted.filter((s) => s.currentPrice >= s.previousClose).slice(0, 6);
  const losers = [...sorted].reverse().filter((s) => s.currentPrice < s.previousClose).slice(0, 6);

  return (
    <>
      <MarketTicker />

      <div className="container">
        {/* Hero */}
        <section className="hero">
          <div className="hero-content animate-fade-in">
            <h1>TsunStocks — The Baka Market</h1>
            <p>
              Invest in these losers if you want... It's not like I care if you make coins or lose it all! (¬_¬)
            </p>
          </div>
        </section>

        {/* Search & Sort */}
        <div style={{ marginBottom: 'var(--space-xl)', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <input
            className="search-bar"
            type="text"
            placeholder="Search for an idiot... (¬_¬)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="sort-controls">
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginRight: 'var(--space-xs)' }}>Sort:</span>
            {[
              { key: 'price', label: 'Price' },
              { key: 'change', label: 'Change %' },
              { key: 'volume', label: 'Volume' },
            ].map((s) => (
              <button
                key={s.key}
                className={`btn btn-ghost${sortKey === s.key ? ' active' : ''}`}
                onClick={() => handleSort(s.key)}
              >
                {s.label} {sortKey === s.key ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="loading-container">
            <div className="loading-spinner" />
          </div>
        ) : stocks.length === 0 ? (
          <div className="empty-state">
            <p>No stocks listed yet... pathetic.</p>
            <span style={{ color: 'var(--text-muted)' }}>Stocks appear once these idiots start talking</span>
          </div>
        ) : (
          <>
            {/* Top Gainers */}
            {gainers.length > 0 && (
              <section className="section">
                <div className="section-header">
                  <h2 className="section-title" style={{ color: 'var(--accent-green)' }}>
                    Top Gainers
                  </h2>
                </div>
                <div className="stock-grid">
                  {gainers.map((stock) => (
                    <StockCard
                      key={stock.userId}
                      userId={stock.userId}
                      displayName={stock.displayName}
                      avatarUrl={stock.avatarUrl}
                      currentPrice={stock.currentPrice}
                      previousClose={stock.previousClose}
                      sharesOutstanding={stock.sharesOutstanding}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Top Losers */}
            {losers.length > 0 && (
              <section className="section">
                <div className="section-header">
                  <h2 className="section-title" style={{ color: 'var(--accent-red)' }}>
                    Top Losers
                  </h2>
                </div>
                <div className="stock-grid">
                  {losers.map((stock) => (
                    <StockCard
                      key={stock.userId}
                      userId={stock.userId}
                      displayName={stock.displayName}
                      avatarUrl={stock.avatarUrl}
                      currentPrice={stock.currentPrice}
                      previousClose={stock.previousClose}
                      sharesOutstanding={stock.sharesOutstanding}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* All Stocks */}
            <section className="section">
              <div className="section-header">
                <h2 className="section-title">All Stocks</h2>
                <span className="text-muted" style={{ fontSize: 'var(--text-sm)' }}>
                  {filtered.length} listed
                </span>
              </div>
              <div className="stock-grid">
                {sorted.map((stock) => (
                  <StockCard
                    key={stock.userId}
                    userId={stock.userId}
                    displayName={stock.displayName}
                    avatarUrl={stock.avatarUrl}
                    currentPrice={stock.currentPrice}
                    previousClose={stock.previousClose}
                    sharesOutstanding={stock.sharesOutstanding}
                  />
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
