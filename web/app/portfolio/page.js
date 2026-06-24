'use client';

import { useEffect, useState } from 'react';
import { useSession, signIn } from 'next-auth/react';
import Link from 'next/link';

export default function PortfolioPage() {
  const { data: session, status } = useSession();
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState(null);

  useEffect(() => {
    if (status !== 'authenticated') return;

    async function fetchPortfolio() {
      try {
        const res = await fetch('/api/portfolio');
        if (!res.ok) throw new Error();
        const data = await res.json();
        setHoldings(data.holdings || []);
      } catch {
        setHoldings([]);
      } finally {
        setLoading(false);
      }
    }
    fetchPortfolio();
  }, [status]);

  useEffect(() => {
    if (status !== 'authenticated') return;

    async function fetchBalance() {
      try {
        const res = await fetch('/api/balance');
        if (!res.ok) return;
        const data = await res.json();
        setBalance(data.coins);
      } catch {
        // ignore
      }
    }
    fetchBalance();
  }, [status]);

  // Not logged in
  if (status === 'unauthenticated') {
    return (
      <div className="container">
        <div className="login-prompt animate-fade-in">
          <h2>Sign in to view your portfolio</h2>
          <p>Connect your Discord account to see your holdings, PNL, and trade history.</p>
          <button className="btn btn-primary btn-lg" onClick={() => signIn('discord')}>
            Sign in with Discord
          </button>
        </div>
      </div>
    );
  }

  // Loading auth or data
  if (status === 'loading' || loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
      </div>
    );
  }

  // Calculate totals
  const totalEquity = holdings.reduce((sum, h) => sum + h.shares * h.currentPrice, 0);
  const totalInvested = holdings.reduce((sum, h) => sum + h.totalInvested, 0);
  const totalPnl = totalEquity - totalInvested;
  const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const isPnlPositive = totalPnl >= 0;

  return (
    <div className="container">
      <section className="section animate-slide-up">
        <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, marginBottom: 'var(--space-xs)', letterSpacing: '-0.02em' }}>
          Your Pathetic Portfolio
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-xl)' }}>
          Try not to lose everything at once, idiot. &gt;///&lt;
        </p>

        {/* Summary Cards */}
        <div className="portfolio-summary">
          <div className="glass-card-static portfolio-metric">
            <div className="portfolio-metric-label">Current Value</div>
            <div className="portfolio-metric-value">
              {totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
          </div>

          <div className="glass-card-static portfolio-metric">
            <div className="portfolio-metric-label">Total Spent</div>
            <div className="portfolio-metric-value">
              {totalInvested.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
          </div>

          <div className="glass-card-static portfolio-metric">
            <div className="portfolio-metric-label">Net Profit</div>
            <div
              className="portfolio-metric-value"
              style={{ color: isPnlPositive ? 'var(--accent-green)' : 'var(--accent-red)' }}
            >
              {isPnlPositive ? '+' : ''}{totalPnl.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              <span style={{ fontSize: 'var(--text-lg)', marginLeft: '8px' }}>
                ({isPnlPositive ? '+' : ''}{totalPnlPercent.toFixed(2)}%)
              </span>
            </div>
          </div>

          {balance != null && (
            <div className="glass-card-static portfolio-metric">
              <div className="portfolio-metric-label">Your Balance</div>
              <div className="portfolio-metric-value">
                💰 {balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </div>
            </div>
          )}
        </div>

        {/* Holdings Table */}
        {holdings.length === 0 ? (
          <div className="empty-state">
            <p>You haven't invested in anyone! Are you poor or just a coward? (¬_¬)</p>
            <Link href="/" className="btn btn-primary" style={{ marginTop: 'var(--space-md)', display: 'inline-flex' }}>
              Browse the Market
            </Link>
          </div>
        ) : (
          <div className="glass-card-static" style={{ overflow: 'hidden' }}>
            <div className="table-responsive">
              <table className="stock-table">
                <thead>
                  <tr>
                    <th>Idiot</th>
                    <th>Shares</th>
                    <th>Avg Cost</th>
                    <th>Current Price</th>
                    <th>Scrap Value</th>
                    <th>Profit / Loss</th>
                  </tr>
                </thead>
              <tbody>
                {holdings.map((h) => {
                  const value = h.shares * h.currentPrice;
                  const avgPrice = h.shares > 0 ? h.totalInvested / h.shares : 0;
                  const pnl = value - h.totalInvested;
                  const pnlPct = h.totalInvested > 0 ? (pnl / h.totalInvested) * 100 : 0;
                  const isUp = pnl >= 0;

                  return (
                    <tr key={h.targetUserId} onClick={() => window.location.href = `/stock/${h.targetUserId}`}>
                      <td>
                        <span style={{ fontWeight: 600 }}>{h.displayName || h.targetUserId}</span>
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{h.shares}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {avgPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {h.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                        {value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td>
                        <span
                          className={`stock-card-change ${isUp ? 'gain' : 'loss'}`}
                          style={{ fontSize: 'var(--text-xs)' }}
                        >
                          {isUp ? '+' : ''}{pnl.toLocaleString(undefined, { minimumFractionDigits: 2 })} ({isUp ? '+' : ''}{pnlPct.toFixed(2)}%)
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
