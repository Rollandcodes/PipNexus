# PipNexus – XAUUSD Signal Analyzer

> **Real-time ICT (Inner Circle Trader) analysis engine for Gold (XAUUSD)**  
> Powered by FastAPI · yfinance · React · Vite

---

## Overview

PipNexus is an open-source trading signal analyzer for Gold (XAUUSD / GC=F).  
It applies core ICT methodology — Order Blocks, Fair Value Gaps, Liquidity sweeps and Market Structure analysis — across multiple timeframes to produce a 10-point confluence score and actionable BUY / SELL / NEUTRAL signals.

---

## Features

| Feature | Detail |
|---------|--------|
| **Live Price** | Real-time Gold Futures price via yfinance |
| **ICT Order Blocks** | Bullish & bearish OB detection with strength rating |
| **Fair Value Gaps** | 3-candle imbalance identification |
| **Liquidity Zones** | BSL/SSL swing-high/low clusters |
| **Market Structure** | HH/HL/LH/LL + BOS / MSS / CHoCH events |
| **Kill Zones** | London (07–10 UTC) and New York (12–14 UTC) detection |
| **Multi-Timeframe** | 15m · 1h · 4h · 1d bias alignment |
| **Confluence Score** | 10-point rating; signal fires at ≥ 7 |
| **Auto-Refresh** | Frontend refreshes every 60 seconds |

---

## Tech Stack

**Backend**
- Python 3.11
- FastAPI 0.104
- yfinance 0.2.33 (Gold Futures: `GC=F`)
- pandas · numpy · pydantic
- Uvicorn ASGI server

**Frontend**
- React 18 + Vite 5
- Plain CSS (dark terminal theme)
- Fetch API (proxied via Vite dev server)

---

## Project Structure

```
PipNexus/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   └── main.py          # FastAPI application + all ICT logic
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # Main React component
│   │   ├── App.css          # Dark theme styles
│   │   └── main.jsx
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── docs/
│   └── ICT_CONCEPTS.md      # Detailed ICT methodology guide
├── QUICKSTART.md
└── README.md
```

---

## API Endpoints

All endpoints are prefixed with `/api/v1/`.

### Market Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/market/price` | Current XAUUSD spot price |
| `GET` | `/market/ohlc?timeframe=1h` | OHLC bars (1m/5m/15m/1h/4h/1d) |
| `GET` | `/market/session` | Current session & Kill Zone status |

### Signals

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/signals/current` | Latest signal with entry, SL, TP, reasoning |
| `GET` | `/signals/history?limit=20` | Recent signal history |

### ICT Analysis

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/ict/order-blocks?timeframe=1h` | Active Order Blocks |
| `GET` | `/ict/fvg?timeframe=1h` | Fair Value Gaps |
| `GET` | `/ict/liquidity?timeframe=1h` | BSL / SSL liquidity zones |
| `GET` | `/ict/market-structure?timeframe=1h` | Market structure events |

### Analysis

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/analysis/multi-timeframe` | 15m/1h/4h/1d trend bias |
| `GET` | `/analysis/confluence-score` | 10-point confluence breakdown |

Interactive docs are available at `http://localhost:8000/docs` when the backend is running.

---

## Quick Start

See [QUICKSTART.md](./QUICKSTART.md) for step-by-step setup instructions.

**TL;DR:**

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## Confluence Scoring

| Factor | Max Points |
|--------|-----------|
| Multi-timeframe alignment | 3 |
| Order Block confluence | 2 |
| Fair Value Gap | 2 |
| Liquidity sweep | 2 |
| Kill Zone timing | 1 |
| **Total** | **10** |

Signal fires when score ≥ 7.

---

## ICT Concepts

See [docs/ICT_CONCEPTS.md](./docs/ICT_CONCEPTS.md) for a full explanation of Order Blocks, FVGs, Liquidity, Market Structure and Kill Zones as implemented in this project.

---

## Disclaimer

> **This software is for educational and research purposes only.**  
> It does not constitute financial advice. Always apply proper risk management and consult a licensed financial adviser before trading. Past signals do not guarantee future results.

---

## License

MIT © PipNexus Contributors