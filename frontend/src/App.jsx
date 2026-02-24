/**
 * XAUUSD Signal Analyzer – App.jsx
 *
 * Main React component.  Fetches ICT analysis data from the FastAPI backend,
 * renders a trading terminal UI with:
 *   • Live XAUUSD price header
 *   • BUY / SELL / NEUTRAL signal card with entry, SL, TP levels
 *   • Confluence score breakdown
 *   • Tabbed ICT panel: Order Blocks, FVG, Liquidity, Market Structure, MTF
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

// ── Session helper ───────────────────────────────────────────────────────
function sessionClass(name) {
  if (!name) return 'off'
  if (name.toLowerCase().includes('asia'))   return 'asia'
  if (name.toLowerCase().includes('london')) return 'london'
  if (name.toLowerCase().includes('york'))   return 'new-york'
  return 'off'
}

// ============================================================================
// Sub-components
// ============================================================================

/** Loading spinner */
function Spinner({ label = 'Loading…' }) {
  return (
    <div className="loading-container">
      <div className="spinner" />
      <span>{label}</span>
    </div>
  )
}

/** Inline error banner */
function ErrorBanner({ msg }) {
  return <div className="error-banner">⚠ {msg}</div>
}

// ── Score bar row ────────────────────────────────────────────────────────
function ScoreRow({ label, pts, max }) {
  const pct = max > 0 ? (pts / max) * 100 : 0
  const niceName = label.replace(/_/g, ' ')
  return (
    <div className="score-row">
      <span className="score-label">{niceName}</span>
      <div className="score-bar-bg">
        <div className="score-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="score-pts">{pts}/{max}</span>
    </div>
  )
}

// ── Order Blocks table ───────────────────────────────────────────────────
function OrderBlocksTab({ data, loading, error }) {
  if (loading) return <Spinner />
  if (error)   return <ErrorBanner msg={error} />
  if (!data?.length) return <div className="empty-state">No active Order Blocks detected.</div>

  return (
    <table className="ict-table">
      <thead>
        <tr>
          <th>Type</th><th>High</th><th>Mid</th><th>Low</th><th>Strength</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        {data.map((ob) => (
          <tr key={ob.id}>
            <td><span className={`tag ${ob.type === 'bullish' ? 'bull' : 'bear'}`}>{ob.type}</span></td>
            <td>{fmt(ob.price_high)}</td>
            <td>{fmt(ob.price_mid)}</td>
            <td>{fmt(ob.price_low)}</td>
            <td><span className={`tag ${ob.strength}`}>{ob.strength}</span></td>
            <td>{ob.tested ? <span className="tag">Tested</span> : <span style={{color:'var(--bull)',fontSize:11}}>Active</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── FVG table ────────────────────────────────────────────────────────────
function FVGTab({ data, loading, error }) {
  if (loading) return <Spinner />
  if (error)   return <ErrorBanner msg={error} />
  if (!data?.length) return <div className="empty-state">No Fair Value Gaps found.</div>

  return (
    <table className="ict-table">
      <thead>
        <tr>
          <th>Type</th><th>Top</th><th>Bottom</th><th>Gap</th><th>Gap %</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        {data.map((fvg) => (
          <tr key={fvg.id}>
            <td><span className={`tag ${fvg.type === 'bullish' ? 'bull' : 'bear'}`}>{fvg.type}</span></td>
            <td>{fmt(fvg.top)}</td>
            <td>{fmt(fvg.bottom)}</td>
            <td>{fmt(fvg.gap_size)}</td>
            <td>{fvg.gap_pct?.toFixed(3)}%</td>
            <td>{fvg.filled ? <span className="tag">Filled</span> : <span style={{color:'var(--gold)',fontSize:11}}>Open</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Liquidity table ──────────────────────────────────────────────────────
function LiquidityTab({ data, loading, error }) {
  if (loading) return <Spinner />
  if (error)   return <ErrorBanner msg={error} />
  if (!data?.length) return <div className="empty-state">No Liquidity Zones found.</div>

  return (
    <table className="ict-table">
      <thead>
        <tr><th>Type</th><th>Price</th><th>Strength</th><th>Status</th></tr>
      </thead>
      <tbody>
        {data.map((z) => (
          <tr key={z.id}>
            <td>
              <span className={`dot ${z.type === 'BSL' ? 'bsl' : 'ssl'}`} />
              <span className={`tag ${z.type === 'BSL' ? 'bsl' : 'ssl'}`}>{z.type}</span>
            </td>
            <td>{fmt(z.price)}</td>
            <td>{z.strength}</td>
            <td>{z.swept ? <span className="tag">Swept</span> : <span style={{color:'var(--gold)',fontSize:11}}>Active</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Market Structure tab ─────────────────────────────────────────────────
function MarketStructureTab({ data, loading, error }) {
  if (loading) return <Spinner />
  if (error)   return <ErrorBanner msg={error} />
  if (!data)   return <div className="empty-state">No market structure data.</div>

  const flags = [
    { label: 'HH', active: data.higher_high },
    { label: 'HL', active: data.higher_low  },
    { label: 'LH', active: data.lower_high  },
    { label: 'LL', active: data.lower_low   },
  ]

  return (
    <div>
      <div className="ms-header">
        <span className={`ms-trend ${data.trend}`}>{data.trend}</span>
        <span className={`ms-event-tag ${data.last_event}`}>{data.last_event}</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          @ {fmt(data.last_event_price)}
        </span>
      </div>
      <div className="ms-flags">
        {flags.map((f) => (
          <span key={f.label} className={`ms-flag ${f.active ? 'active' : 'inactive'}`}>{f.label}</span>
        ))}
      </div>
      <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div className="score-label" style={{ marginBottom: 8 }}>Swing Highs</div>
          {data.swing_highs?.map((h, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--bear)', fontVariantNumeric: 'tabular-nums', padding: '2px 0' }}>
              {fmt(h)}
            </div>
          ))}
        </div>
        <div>
          <div className="score-label" style={{ marginBottom: 8 }}>Swing Lows</div>
          {data.swing_lows?.map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--bull)', fontVariantNumeric: 'tabular-nums', padding: '2px 0' }}>
              {fmt(l)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Multi-Timeframe tab ──────────────────────────────────────────────────
function MTFTab({ data, loading, error }) {
  if (loading) return <Spinner />
  if (error)   return <ErrorBanner msg={error} />
  if (!data?.length) return <div className="empty-state">No MTF data available.</div>

  return (
    <div className="mtf-grid">
      {data.map((tf) => (
        <div key={tf.timeframe} className="mtf-card">
          <div className="mtf-tf">{tf.timeframe.toUpperCase()}</div>
          <div className={`mtf-bias ${tf.bias}`}>{tf.bias}</div>
          <div className="mtf-momentum">Momentum: {tf.momentum}</div>
          <div className="mtf-level">Key: {fmt(tf.key_level)}</div>
        </div>
      ))}
    </div>
  )
}

// ── Signal Card ──────────────────────────────────────────────────────────
function SignalCard({ signal, loading, error }) {
  if (loading) return <div className="signal-card neutral card"><Spinner label="Analyzing market…" /></div>
  if (error)   return <div className="signal-card neutral card"><ErrorBanner msg={error} /></div>
  if (!signal) return null

  const dir = signal.signal?.toLowerCase() || 'neutral'

  return (
    <div className={`signal-card ${dir}`}>
      <div className="signal-header">
        <div>
          <div className={`signal-direction ${dir}`}>{signal.signal}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            XAUUSD · {fmtTime(signal.timestamp)}
          </div>
        </div>
        <div className="confidence-ring">
          <div className="confidence-score">{signal.confluence_score}<span style={{fontSize:16}}>/10</span></div>
          <div className="confidence-label">Confluence</div>
        </div>
      </div>

      <div className="signal-levels">
        <div className="level-item">
          <div className="level-label">Entry</div>
          <div className="level-value entry">{fmt(signal.entry)}</div>
        </div>
        <div className="level-item">
          <div className="level-label">Stop Loss</div>
          <div className="level-value sl">{fmt(signal.stop_loss)}</div>
        </div>
        <div className="level-item">
          <div className="level-label">TP 1</div>
          <div className="level-value tp1">{fmt(signal.take_profit_1)}</div>
        </div>
        <div className="level-item">
          <div className="level-label">TP 2</div>
          <div className="level-value tp2">{fmt(signal.take_profit_2)}</div>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Risk:Reward&nbsp; <strong style={{ color: 'var(--gold)' }}>1 : {signal.risk_reward}</strong>
      </div>

      {signal.reasoning?.length > 0 && (
        <div className="signal-reasoning">
          <div className="reasoning-title">Reasoning</div>
          <ul className="reasoning-list">
            {signal.reasoning.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── Confluence Card ──────────────────────────────────────────────────────
const SCORE_MAX = {
  multi_timeframe: 3,
  order_block:     2,
  fair_value_gap:  2,
  liquidity_sweep: 2,
  kill_zone:       1,
}

function ConfluenceCard({ data, loading, error }) {
  if (loading) return <div className="confluence-card card"><Spinner /></div>
  if (error)   return <div className="confluence-card card"><ErrorBanner msg={error} /></div>
  if (!data)   return null

  return (
    <div className="confluence-card">
      <div className="confluence-header">
        <div>
          <span className="confluence-total">{data.total}</span>
          <span className="confluence-max"> / {data.max_score}</span>
        </div>
        <span className={`confluence-rating ${data.rating}`}>{data.rating}</span>
      </div>
      <div className="score-breakdown">
        {Object.entries(data.breakdown || {}).map(([key, pts]) => (
          <ScoreRow key={key} label={key} pts={pts} max={SCORE_MAX[key] ?? 2} />
        ))}
      </div>
    </div>
  )
}

// ── ICT Tabbed Panel ─────────────────────────────────────────────────────
const TABS = ['Order Blocks', 'FVG', 'Liquidity', 'Market Structure', 'Multi-Timeframe']

function ICTPanel({ ictData, loading, errors }) {
  const [active, setActive] = useState(0)

  return (
    <div className="tab-container">
      <div className="tab-header">
        {TABS.map((t, i) => (
          <button
            key={t}
            className={`tab-btn${active === i ? ' active' : ''}`}
            onClick={() => setActive(i)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {active === 0 && <OrderBlocksTab   data={ictData.orderBlocks}      loading={loading.orderBlocks}      error={errors.orderBlocks} />}
        {active === 1 && <FVGTab           data={ictData.fvg}              loading={loading.fvg}              error={errors.fvg} />}
        {active === 2 && <LiquidityTab     data={ictData.liquidity}        loading={loading.liquidity}        error={errors.liquidity} />}
        {active === 3 && <MarketStructureTab data={ictData.marketStructure} loading={loading.marketStructure}  error={errors.marketStructure} />}
        {active === 4 && <MTFTab           data={ictData.mtf}              loading={loading.mtf}              error={errors.mtf} />}
      </div>
    </div>
  )
}

// ============================================================================
// Main App
// ============================================================================

export default function App() {
  // ── State ─────────────────────────────────────────────────────────────
  const [price,   setPrice]   = useState(null)
  const [session, setSession] = useState(null)
  const [signal,  setSignal]  = useState(null)
  const [confluence, setConfluence] = useState(null)

  const [ictData, setIctData] = useState({
    orderBlocks: null, fvg: null, liquidity: null, marketStructure: null, mtf: null
  })

  const [loading, setLoading] = useState({
    price: true, signal: true, confluence: true,
    orderBlocks: true, fvg: true, liquidity: true, marketStructure: true, mtf: true
  })

  const [errors, setErrors] = useState({
    price: null, signal: null, confluence: null,
    orderBlocks: null, fvg: null, liquidity: null, marketStructure: null, mtf: null
  })

  const [lastUpdate, setLastUpdate] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
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

  const fetchICT = useCallback(async () => {
    const endpoints = [
      { key: 'orderBlocks',     path: '/ict/order-blocks' },
      { key: 'fvg',             path: '/ict/fvg' },
      { key: 'liquidity',       path: '/ict/liquidity' },
      { key: 'marketStructure', path: '/ict/market-structure' },
      { key: 'mtf',             path: '/analysis/multi-timeframe' },
    ]
    for (const { key, path } of endpoints) {
      setL(key, true)
      apiFetch(path)
        .then(data => {
          setIctData(prev => ({ ...prev, [key]: data }))
          setE(key, null)
        })
        .catch(e => setE(key, e.message))
        .finally(() => setL(key, false))
    }
  }, [])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    await Promise.allSettled([
      fetchPrice(), fetchSession(), fetchSignal(), fetchConfluence(), fetchICT()
    ])
    setLastUpdate(new Date())
    setRefreshing(false)
  }, [fetchPrice, fetchSession, fetchSignal, fetchConfluence, fetchICT])

  // ── Initial load + auto-refresh every 60s ─────────────────────────────
  useEffect(() => {
    refreshAll()
    intervalRef.current = setInterval(refreshAll, 60_000)
    return () => clearInterval(intervalRef.current)
  }, [refreshAll])

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">⚡</span>
            <div>
              <h1>PipNexus</h1>
              <span>XAUUSD Signal Analyzer</span>
            </div>
          </div>

          <div className="header-stats">
            {/* Price */}
            <div className="price-display">
              {loading.price ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 20 }}>Loading…</div>
              ) : errors.price ? (
                <div style={{ color: 'var(--bear)', fontSize: 14 }}>Price unavailable</div>
              ) : (
                <>
                  <div className="price-value">{fmt(price?.price)}</div>
                  <div className="price-label">XAUUSD (USD/oz)</div>
                </>
              )}
            </div>

            {/* Session */}
            {session && (
              <div className="session-badge">
                <span className={`session-name ${sessionClass(session.current_session)}`}>
                  {session.current_session}
                </span>
                {session.in_kill_zone && (
                  <span className="kill-zone-indicator">⚡ {session.kill_zone_name}</span>
                )}
              </div>
            )}

            {/* Last update + refresh */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <button className={`refresh-btn${refreshing ? ' spinning' : ''}`} onClick={refreshAll}>
                <span className="refresh-icon">↻</span> Refresh
              </button>
              {lastUpdate && (
                <div className="last-update">
                  Updated {lastUpdate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Main ────────────────────────────────────────────────────── */}
      <main className="main-content">
        <p className="section-title">Current Signal</p>

        <div className="dashboard-grid">
          {/* Signal card */}
          <SignalCard signal={signal} loading={loading.signal} error={errors.signal} />

          {/* Confluence score */}
          <div>
            <p className="section-title" style={{ marginTop: 0 }}>Confluence Score</p>
            <ConfluenceCard data={confluence} loading={loading.confluence} error={errors.confluence} />

            {/* Session info */}
            {session && (
              <div className="card" style={{ marginTop: 16 }}>
                <p className="section-title" style={{ marginTop: 0, marginBottom: 12 }}>Session Info</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    ['Session',    session.current_session],
                    ['UTC Hour',   session.utc_hour + ':00'],
                    ['Kill Zone',  session.in_kill_zone ? session.kill_zone_name : 'No'],
                    ['Market',     session.is_market_open ? 'Open' : 'Closed'],
                  ].map(([label, value]) => (
                    <div key={label} style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '10px 12px' }}>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ICT Panel */}
        <p className="section-title">ICT Analysis</p>
        <ICTPanel ictData={ictData} loading={loading} errors={errors} />
      </main>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="footer">
        <div>PipNexus XAUUSD Signal Analyzer · Auto-refresh every 60s</div>
        <div className="disclaimer">
          For educational purposes only. Not financial advice. Always manage risk.
        </div>
      </footer>
    </div>
  )
}
