'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSession, signIn, signOut } from 'next-auth/react';
import { usePathname } from 'next/navigation';

export default function Navbar() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link href="/" className="navbar-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
            <polyline points="16 7 22 7 22 13" />
          </svg>
          TsunStocks
        </Link>

        <button
          className="navbar-hamburger"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          <span />
          <span />
          <span />
        </button>

        <div className={`navbar-links${menuOpen ? ' open' : ''}`}>
          <Link
            href="/"
            className={`navbar-link${pathname === '/' ? ' active' : ''}`}
            onClick={() => setMenuOpen(false)}
          >
            Market
          </Link>
          <Link
            href="/portfolio"
            className={`navbar-link${pathname === '/portfolio' ? ' active' : ''}`}
            onClick={() => setMenuOpen(false)}
          >
            Portfolio
          </Link>
        </div>

        <div className="navbar-actions">
          {session ? (
            <>
              <div className="navbar-avatar" onClick={() => signOut()} title="Sign out">
                {session.user?.image ? (
                  <img src={session.user.image} alt={session.user.name || 'User'} />
                ) : (
                  <div style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--accent-purple)',
                    color: '#fff',
                    fontSize: 'var(--text-sm)',
                    fontWeight: 700,
                  }}>
                    {(session.user?.name || '?')[0].toUpperCase()}
                  </div>
                )}
              </div>
            </>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => signIn('discord')}>
              Sign In
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
