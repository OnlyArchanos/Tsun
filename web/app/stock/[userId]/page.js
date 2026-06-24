'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import TradePanel from '@/components/TradePanel';

const PriceChart = dynamic(() => import('@/components/PriceChart'), { ssr: false });

const RANGES = [
  { label: '24H', value: '24h' },
  { label: '7D', value: '7d' },
  { label: '30D', value: '30d' },
];

export default function StockPage() {
  const params = useParams();
  const userId = params.userId;

  const [stock, setStock] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [range, setRange] = useState('24h');
  const [loading, setLoading] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Fetch stock details
  useEffect(() => {
    async function fetchStock() {
      try {
        const res = await fetch(`/api/stock/${userId}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        setStock(data);
      } catch {
        setStock(null);
      } finally {
        setLoading(false);
      }
    }
    fetchStock();
  }, [userId, refreshTrigger]);

  // Fetch price history
  useEffect(() => {
    async function fetchHistory() {
      try {
        const res = await fetch(`/api/stock/${userId}/history?range=${range}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        const historyArray = Array.isArray(data) ? data : (data.history || []);
        
        // Lightweight-charts requires strictly increasing timestamps.
        // We filter out duplicate timestamps within the same second.
        const formatted = [];
        let lastTime = 0;
        for (const h of historyArray) {
          if (!h.timestamp) continue;
          const t = Math.floor(new Date(h.timestamp).getTime() / 1000);
          if (isNaN(t)) continue;
          if (t > lastTime) {
            formatted.push({
              time: t,
              value: h.price ?? 5000,
            });
            lastTime = t;
          }
        }

        // If history is empty, generate a fallback chart with previousClose and currentPrice
        if (formatted.length === 0 && stock) {
          const nowSec = Math.floor(Date.now() / 1000);
          formatted.push({
            time: nowSec - 24 * 60 * 60, // 24 hours ago
            value: stock.previousClose ?? 5000,
          });
          formatted.push({
            time: nowSec,
            value: stock.currentPrice ?? 5000,
          });
        }

        setChartData(formatted);
      } catch {
        setChartData([]);
      }
    }
    fetchHistory();
  }, [userId, range, stock, refreshTrigger]);

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (!stock) {
    return (
      <div className="container">
        <div className="empty-state" style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
          <p>Who is this nobody? (Stock not found)</p>
          <span style={{ color: 'var(--text-muted)' }}>They don't even have a stock yet. Tell them to talk more! (¬_¬)</span>
        </div>
      </div>
    );
  }

  const cp = stock.currentPrice ?? 5000;
  const pc = stock.previousClose ?? 5000;
  const change = cp - pc;
  const changePercent = pc > 0 ? (change / pc) * 100 : 0;
  const isGain = change >= 0;
  const chartColor = isGain ? '#00d166' : '#ed4245';

  return (
    <div className="container">
      <section className="section animate-slide-up">
        {/* Stock Header */}
        <div style={{ marginBottom: 'var(--space-xl)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
            {stock.avatarUrl && (
              <div className="stock-card-avatar" style={{ width: 56, height: 56 }}>
                <img src={stock.avatarUrl} alt={stock.displayName || userId} />
              </div>
            )}
            <div>
              <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, letterSpacing: '-0.02em' }}>
                {stock.displayName || userId}
              </h1>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                {userId}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-md)' }}>
            <span style={{ fontSize: 'var(--text-4xl)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
              {cp.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>coins</span>
            <span className={`stock-card-change ${isGain ? 'gain' : 'loss'}`}>
              {isGain ? '▲' : '▼'} {Math.abs(changePercent).toFixed(2)}%
              <span style={{ marginLeft: '4px' }}>
                ({isGain ? '+' : ''}{change.toLocaleString(undefined, { minimumFractionDigits: 2 })})
              </span>
            </span>
          </div>
        </div>

        <div className="stock-page-layout">
          <div className="stock-page-main">
            {/* Time Range Selector */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div className="time-range">
                {RANGES.map((r) => (
                  <button
                    key={r.value}
                    className={`time-range-btn${range === r.value ? ' active' : ''}`}
                    onClick={() => setRange(r.value)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Chart */}
            <PriceChart data={chartData} color={chartColor} />

            {/* Stats Grid */}
            <div className="glass-card-static" style={{ padding: 'var(--space-lg)' }}>
              <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, marginBottom: 'var(--space-md)' }}>Nerd Stats</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <div className="stat-label">Current Price</div>
                  <div className="stat-value">{cp.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">24h Change</div>
                  <div className="stat-value" style={{ color: isGain ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                    {isGain ? '+' : ''}{changePercent.toFixed(2)}%
                  </div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">24h High</div>
                  <div className="stat-value">{(stock.dailyHigh ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">24h Low</div>
                  <div className="stat-value">{(stock.dailyLow ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">All-Time High</div>
                  <div className="stat-value">{(stock.allTimeHigh ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">Shares Outstanding</div>
                  <div className="stat-value">{(stock.sharesOutstanding ?? 0).toLocaleString()}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">24h Volume</div>
                  <div className="stat-value">{(stock.volume24h ?? 0).toLocaleString()}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">Previous Close</div>
                  <div className="stat-value">{(stock.previousClose ?? 5000).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                </div>
              </div>
            </div>

            {/* Top Holders */}
            {stock.topHolders && stock.topHolders.length > 0 && (
              <div className="glass-card-static" style={{ padding: 'var(--space-lg)' }}>
                <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, marginBottom: 'var(--space-md)' }}>Biggest Losers Holding This</h3>
                <ul className="holders-list">
                  {stock.topHolders.map((holder, i) => (
                    <li className="holder-row" key={holder.userId || i}>
                      <div className="holder-info">
                        <span className="holder-rank">#{i + 1}</span>
                        <span className="holder-name">{holder.displayName || holder.userId}</span>
                      </div>
                      <span className="holder-shares">{(holder.shares ?? 0).toLocaleString()} shares</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Sidebar — Trade Panel */}
          <div className="stock-page-sidebar">
            <TradePanel
              targetUserId={userId}
              currentPrice={cp}
              displayName={stock.displayName}
              onTradeSuccess={() => setRefreshTrigger((prev) => prev + 1)}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
