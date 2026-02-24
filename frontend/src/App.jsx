/**
 * XAUUSD Signal Analyzer – App.jsx
 *
 * Main React component.  Fetches ICT analysis data from the FastAPI backend,
 * renders a trading terminal UI with:
 *   • Live XAUUSD price ticker
 *   • BUY / SELL / NEUTRAL signal card with entry, SL, TP levels
 *   • Tabbed ICT panel: Order Blocks and Signal Details
 *
 * Auto-refreshes every 60 seconds.
 */

import { useState, useEffect, useCallback, useRef } from 'react'

// ── API base URL (proxied via vite to http://localhost:8000) ──────────────
const API = '/api/v1'

// ── Small utility: format number with commas ─────────────────────────────
const fmt = (n) =>
  n != null ? Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'

const fmtTime = (iso) => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

// ── Generic fetch with error handling ───────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(API + path)
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${res.statusText}`)
  return res.json()
}

// ============================================================================
// Sub-components
// ============================================================================

// ── Order Blocks tab ─────────────────────────────────────────────────────
function OrderBlocksTab({ data, loading, error }) {
  if (loading) return <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>Loading…</div>
  if (error)   return <div style={{ padding: '2rem', color: 'var(--red)' }}>⚠ {error}</div>
  if (!data?.length) return <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>No active Order Blocks detected.</div>

  return (
    <div className="ob-list">
      {data.map((ob) => (
        <div key={ob.id} className={`ob-item ${ob.type === 'bullish' ? 'ob-bullish' : 'ob-bearish'}`}>
          <div className="ob-type">{ob.type} Order Block</div>
          <div className="ob-zone">{fmt(ob.price_low)} – {fmt(ob.price_high)}</div>
          <div className="ob-strength">Strength: {ob.strength}</div>
          {ob.tested && <div className="ob-time">Status: Tested</div>}
        </div>
      ))}
    </div>
  )
}

// ── Signal Details tab ───────────────────────────────────────────────────
function SignalDetailsTab({ signal, confluence, loading, error }) {
  if (loading) return <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
  if (error)   return <div style={{ padding: '1rem', color: 'var(--red)' }}>⚠ {error}</div>
  if (!signal) return <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>No signal data available.</div>

  return (
    <div className="signal-details">
      {confluence && (
        <div className="detail-section">
          <h4>Confluence Score</h4>
          <p>
            Total: <strong>{confluence.total} / {confluence.max_score}</strong>
            &nbsp;— <strong>{confluence.rating}</strong>
          </p>
          {confluence.breakdown && (
            <ul>
              {Object.entries(confluence.breakdown).map(([key, pts]) => (
                <li key={key}>{key.replace(/_/g, ' ')}: <strong>{pts}</strong></li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="detail-section">
        <h4>Trade Levels</h4>
        <ul>
          <li>Entry: <strong>{fmt(signal.entry)}</strong></li>
          <li>Stop Loss: <strong>{fmt(signal.stop_loss)}</strong></li>
          <li>Take Profit 1: <strong>{fmt(signal.take_profit_1)}</strong></li>
          <li>Take Profit 2: <strong>{fmt(signal.take_profit_2)}</strong></li>
          <li>Risk:Reward: <strong>1 : {signal.risk_reward}</strong></li>
        </ul>
      </div>
      {signal.reasoning?.length > 0 && (
        <div className="detail-section">
          <h4>Analysis</h4>
          <ul>
            {signal.reasoning.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── ICT Panel ────────────────────────────────────────────────────────────
const TABS = ['Order Blocks', 'Signal Details']

function ICTPanel({ orderBlocks, signal, confluence, loading, errors }) {
  const [active, setActive] = useState(0)

  return (
    <div className="ict-panel">
      <div className="tab-header">
        {TABS.map((t, i) => (
          <button
            key={t}
            className={`tab${active === i ? ' active' : ''}`}
            onClick={() => setActive(i)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="tab-content">
        {active === 0 && (
          <>
            <h3>Order Blocks</h3>
            <OrderBlocksTab data={orderBlocks} loading={loading.orderBlocks} error={errors.orderBlocks} />
          </>
        )}
        {active === 1 && (
          <>
            <h3>Signal Details</h3>
            <SignalDetailsTab
              signal={signal}
              confluence={confluence}
              loading={loading.signal || loading.confluence}
              error={errors.signal || errors.confluence}
            />
          </>
        )}
      </div>
    </div>
  )
}

// ── Signal Card ──────────────────────────────────────────────────────────
function SignalCard({ signal, loading, error }) {
  if (loading) return (
    <div className="signal-card signal-neutral">
      <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
        Analyzing market…
      </div>
    </div>
  )
  if (error) return (
    <div className="signal-card signal-neutral">
      <div style={{ color: 'var(--red)', padding: '1rem' }}>⚠ {error}</div>
    </div>
  )
  if (!signal) return null

  const dir = signal.signal?.toLowerCase() || 'neutral'
  const directionMap = {
    buy:     { cardClass: 'signal-long',    badgeClass: 'long',    badgeLabel: 'LONG'    },
    sell:    { cardClass: 'signal-short',   badgeClass: 'short',   badgeLabel: 'SHORT'   },
    neutral: { cardClass: 'signal-neutral', badgeClass: 'neutral', badgeLabel: 'NEUTRAL' },
  }
  const { cardClass, badgeClass, badgeLabel } = directionMap[dir] ?? directionMap.neutral

  return (
    <div className={`signal-card ${cardClass}`}>
      <div className="signal-header">
        <h2>XAUUSD Signal</h2>
        <div className="confidence-score">
          <span className="score-label">Confluence</span>
          <span className="score-value">{signal.confluence_score}/10</span>
        </div>
      </div>

      <div className="signal-direction">
        <span className={`direction-badge ${badgeClass}`}>{badgeLabel}</span>
      </div>

      <div className="trade-details">
        <div className="trade-row highlight">
          <span className="trade-label">Entry</span>
          <span className="trade-value">{fmt(signal.entry)}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Stop Loss</span>
          <span className="trade-value">{fmt(signal.stop_loss)}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Take Profit 1</span>
          <span className="trade-value">{fmt(signal.take_profit_1)}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Take Profit 2</span>
          <span className="trade-value">{fmt(signal.take_profit_2)}</span>
        </div>
        <div className="trade-row">
          <span className="trade-label">Risk:Reward</span>
          <span className="trade-value">1 : {signal.risk_reward}</span>
        </div>
      </div>

      {signal.reasoning?.length > 0 && (
        <div className="signal-reasons">
          <h3>Signal Reasoning</h3>
          <ul>
            {signal.reasoning.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      <div className="signal-footer">
        <span className="timestamp">Updated: {fmtTime(signal.timestamp)}</span>
      </div>
    </div>
  )
}

// ============================================================================
// Main App
// ============================================================================

export default function App() {
  // ── State ─────────────────────────────────────────────────────────────
  const [price,      setPrice]      = useState(null)
  const [session,    setSession]    = useState(null)
  const [signal,     setSignal]     = useState(null)
  const [confluence, setConfluence] = useState(null)
  const [orderBlocks, setOrderBlocks] = useState(null)

  const [loading, setLoading] = useState({
    price: true, signal: true, confluence: true, orderBlocks: true
  })

  const [errors, setErrors] = useState({
    price: null, signal: null, confluence: null, orderBlocks: null
  })

  const [initialLoad, setInitialLoad] = useState(true)
  const intervalRef = useRef(null)

  // ── Fetch helpers ──────────────────────────────────────────────────────
  const setL = (key, val) => setLoading(prev => ({ ...prev, [key]: val }))
  const setE = (key, val) => setErrors(prev  => ({ ...prev, [key]: val }))

  const fetchPrice = useCallback(async () => {
    setL('price', true)
    try {
      const data = await apiFetch('/market/price')
      setPrice(data)
      setE('price', null)
    } catch (e) {
      setE('price', e.message)
    } finally {
      setL('price', false)
    }
  }, [])

  const fetchSession = useCallback(async () => {
    try {
      const data = await apiFetch('/market/session')
      setSession(data)
    } catch { /* session is non-critical */ }
  }, [])

  const fetchSignal = useCallback(async () => {
    setL('signal', true)
    try {
      const data = await apiFetch('/signals/current')
      setSignal(data)
      setE('signal', null)
    } catch (e) {
      setE('signal', e.message)
    } finally {
      setL('signal', false)
    }
  }, [])

  const fetchConfluence = useCallback(async () => {
    setL('confluence', true)
    try {
      const data = await apiFetch('/analysis/confluence-score')
      setConfluence(data)
      setE('confluence', null)
    } catch (e) {
      setE('confluence', e.message)
    } finally {
      setL('confluence', false)
    }
  }, [])

  const fetchOrderBlocks = useCallback(async () => {
    setL('orderBlocks', true)
    try {
      const data = await apiFetch('/ict/order-blocks')
      setOrderBlocks(data)
      setE('orderBlocks', null)
    } catch (e) {
      setE('orderBlocks', e.message)
    } finally {
      setL('orderBlocks', false)
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await Promise.allSettled([
      fetchPrice(), fetchSession(), fetchSignal(), fetchConfluence(), fetchOrderBlocks()
    ])
    setInitialLoad(false)
  }, [fetchPrice, fetchSession, fetchSignal, fetchConfluence, fetchOrderBlocks])

  // ── Initial load + auto-refresh every 60s ─────────────────────────────
  useEffect(() => {
    refreshAll()
    intervalRef.current = setInterval(refreshAll, 60_000)
    return () => clearInterval(intervalRef.current)
  }, [refreshAll])

  // ── Full-page loading on first load ────────────────────────────────────
  if (initialLoad && (loading.price || loading.signal)) {
    return <div className="loading">⚡ Loading XAUUSD Analyzer…</div>
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const changeVal = price?.change ?? 0
  const changeClass = changeVal >= 0 ? 'positive' : 'negative'
  const changeSign  = changeVal >= 0 ? '+' : ''

  return (
    <div className="app">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-content">
          <h1>⚡ PipNexus</h1>
          <p className="header-subtitle">XAUUSD ICT Signal Analyzer · Auto-refresh every 60s</p>
        </div>
      </header>

      {/* ── Price Ticker ────────────────────────────────────────────── */}
      <div className="price-ticker">
        <div className="ticker-item">
          <span className="ticker-label">XAUUSD</span>
          <span className="ticker-price">
            {loading.price ? '…' : errors.price ? 'N/A' : fmt(price?.price)}
          </span>
        </div>

        {!loading.price && !errors.price && price && (
          <div className="ticker-item">
            <span className="ticker-label">Change</span>
            <span className={`ticker-change ${changeClass}`}>
              {changeSign}{fmt(changeVal)} ({changeSign}{price?.change_pct?.toFixed(2) ?? '0.00'}%)
            </span>
          </div>
        )}

        {session && (
          <div className="ticker-session">
            <span className="session-dot" />
            {session.current_session}
            {session.in_kill_zone && (
              <span className="kill-zone-badge">⚡ {session.kill_zone_name}</span>
            )}
          </div>
        )}
      </div>

      {/* ── Main Content ────────────────────────────────────────────── */}
      <main className="main-content">
        <SignalCard signal={signal} loading={loading.signal} error={errors.signal} />

        <ICTPanel
          orderBlocks={orderBlocks}
          signal={signal}
          confluence={confluence}
          loading={loading}
          errors={errors}
        />
      </main>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="footer">
        <p>PipNexus XAUUSD Signal Analyzer</p>
        <p>For educational purposes only. Not financial advice. Always manage risk.</p>
      </footer>
    </div>
  )
}
