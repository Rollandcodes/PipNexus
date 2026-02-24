# PipNexus – Quick Start Guide

This guide walks you through running both the backend and frontend locally from scratch.

---

## Prerequisites

| Tool | Minimum Version | Check |
|------|----------------|-------|
| Python | 3.10+ | `python --version` |
| pip | 22+ | `pip --version` |
| Node.js | 18+ | `node --version` |
| npm | 9+ | `npm --version` |

---

## 1. Clone the repository

```bash
git clone https://github.com/your-org/PipNexus.git
cd PipNexus
```

---

## 2. Start the Backend

```bash
cd backend

# (Optional but recommended) create a virtual environment
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start the API server (hot-reload enabled)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The API will be live at **http://localhost:8000**.  
Interactive Swagger docs: **http://localhost:8000/docs**

### Verify the backend

```bash
curl http://localhost:8000/
# {"status":"ok","service":"XAUUSD Signal Analyzer"}

curl http://localhost:8000/api/v1/market/session
# {"current_session":"...","in_kill_zone":false,...}
```

---

## 3. Start the Frontend

Open a **new terminal**, keep the backend running in the first one.

```bash
cd frontend

# Install Node packages
npm install

# Start the Vite dev server
npm run dev
```

Open **http://localhost:5173** in your browser.

The Vite proxy is configured to forward all `/api/*` requests to `http://localhost:8000`, so no CORS issues during development.

---

## 4. Production Build (optional)

```bash
cd frontend
npm run build        # outputs to frontend/dist/
npm run preview      # serve the production build locally
```

To serve the built frontend from FastAPI, copy `dist/` to the backend and mount it as a static directory.

---

## 5. Docker (optional)

### Backend only

```bash
cd backend
docker build -t pipnexus-backend .
docker run -p 8000:8000 pipnexus-backend
```

### Full stack with Docker Compose

Create a `docker-compose.yml` at the repo root:

```yaml
version: '3.9'
services:
  backend:
    build: ./backend
    ports:
      - "8000:8000"

  frontend:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./frontend:/app
    command: sh -c "npm install && npm run dev -- --host"
    ports:
      - "5173:5173"
    depends_on:
      - backend
    environment:
      - VITE_API_URL=http://backend:8000
```

```bash
docker compose up --build
```

---

## 6. Environment Variables

The backend reads an optional `.env` file via `python-dotenv`.  Create `backend/.env`:

```dotenv
# Not required for basic operation.
# Add custom settings here if needed, e.g.:
# LOG_LEVEL=DEBUG
```

---

## 7. Troubleshooting

| Problem | Fix |
|---------|-----|
| `yfinance` returns empty data | Markets may be closed (weekend/holiday). Try again during trading hours or check your internet connection. |
| Port 8000 already in use | Change port: `uvicorn app.main:app --port 8001` and update `vite.config.js` proxy target. |
| CORS errors in browser | Ensure backend is running and the Vite proxy (`/api → localhost:8000`) is active. |
| `npm install` fails | Ensure Node.js ≥ 18 is installed: `node --version`. |

---

## 8. API Reference Summary

```
GET /api/v1/market/price                    – Live XAUUSD price
GET /api/v1/market/ohlc?timeframe=1h        – OHLC data
GET /api/v1/market/session                  – Session & Kill Zone
GET /api/v1/signals/current                 – Latest signal
GET /api/v1/signals/history?limit=20        – Signal history
GET /api/v1/ict/order-blocks?timeframe=1h   – Order Blocks
GET /api/v1/ict/fvg?timeframe=1h            – Fair Value Gaps
GET /api/v1/ict/liquidity?timeframe=1h      – BSL/SSL zones
GET /api/v1/ict/market-structure?timeframe=1h – Structure events
GET /api/v1/analysis/multi-timeframe        – MTF analysis
GET /api/v1/analysis/confluence-score       – Confluence score
```

Full interactive docs at **http://localhost:8000/docs**.
