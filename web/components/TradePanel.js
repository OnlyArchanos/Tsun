'use client';

import { useState, useEffect } from 'react';

const BROKER_FEE_RATE = 0.05;

export default function TradePanel({ targetUserId, currentPrice = 0, displayName = '', onTradeSuccess }) {
  const [action, setAction] = useState('buy');
  const [shares, setShares] = useState('');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [balance, setBalance] = useState(null);

  useEffect(() => {
    async function fetchBalance() {
      try {
        const res = await fetch('/api/balance');
        if (!res.ok) return;
        const data = await res.json();
        setBalance(data.coins);
      } catch {
        // Not authenticated or network error — leave null
      }
    }
    fetchBalance();
  }, []);

  const shareCount = Math.max(0, parseInt(shares, 10) || 0);
  const subtotal = shareCount * currentPrice;
  const fee = subtotal * BROKER_FEE_RATE;
  const total = action === 'buy' ? subtotal + fee : subtotal - fee;

  const maxBuyable = currentPrice > 0 && balance != null
    ? Math.floor(balance / (currentPrice * (1 + BROKER_FEE_RATE)))
    : null;

  async function handleTrade() {
    if (shareCount <= 0) return;

    setLoading(true);
    setFeedback(null);

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, targetUserId, shares: shareCount }),
      });

      const data = await res.json();

      if (!res.ok) {
        setFeedback({ type: 'error', message: data.error || 'Trade failed' });
      } else {
        setFeedback({
          type: 'success',
          message: `${action === 'buy' ? 'Bought' : 'Sold'} ${shareCount} share${shareCount > 1 ? 's' : ''} of ${displayName || targetUserId}`,
        });
        setShares('');
        if (data.newBalance != null) setBalance(data.newBalance);
        onTradeSuccess?.();
      }
    } catch {
      setFeedback({ type: 'error', message: 'Network error — try again' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="glass-card-static trade-panel">
      {balance != null && (
        <div style={{ marginBottom: 'var(--space-md)', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <span className="balance-display">
            💰 {balance.toLocaleString()} coins
          </span>
        </div>
      )}

      <div className="trade-toggle">
        <button
          className={`trade-toggle-btn ${action === 'buy' ? 'active-buy' : ''}`}
          onClick={() => { setAction('buy'); setFeedback(null); }}
        >
          Buy (Idiot)
        </button>
        <button
          className={`trade-toggle-btn ${action === 'sell' ? 'active-sell' : ''}`}
          onClick={() => { setAction('sell'); setFeedback(null); }}
        >
          Sell (Paper Hands)
        </button>
      </div>

      <div className="trade-input-group">
        <label htmlFor="trade-shares">Shares</label>
        <input
          id="trade-shares"
          className="trade-input"
          type="number"
          min="1"
          step="1"
          placeholder="0"
          value={shares}
          onChange={(e) => setShares(e.target.value)}
        />
        {action === 'buy' && maxBuyable != null && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-xs)' }}>
            Max you can buy: {maxBuyable.toLocaleString()} shares
          </div>
        )}
      </div>

      {shareCount > 0 && (
        <div className="trade-preview animate-fade-in">
          <div className="trade-preview-row">
            <span>Price per share</span>
            <span>{currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="trade-preview-row">
            <span>Subtotal ({shareCount} share{shareCount > 1 ? 's' : ''})</span>
            <span>{subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="trade-preview-row">
            <span>Broker fee (5%)</span>
            <span>{fee.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="trade-preview-row trade-preview-total">
            <span>Total {action === 'buy' ? 'cost' : 'proceeds'}</span>
            <span>{total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
        </div>
      )}

      <button
        className={`btn btn-lg ${action === 'buy' ? 'btn-buy' : 'btn-sell'}`}
        style={{ width: '100%' }}
        disabled={shareCount <= 0 || loading}
        onClick={handleTrade}
      >
        {loading
          ? 'Processing...'
          : `${action === 'buy' ? 'Confirm Buy (Don\'t blame me!)' : 'Confirm Sell (Coward!)'}`
        }
      </button>

      {feedback && (
        <div className={`trade-feedback ${feedback.type}`}>
          {feedback.message}
        </div>
      )}
    </div>
  );
}
