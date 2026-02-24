"""
XAUUSD Signal Analyzer - FastAPI Backend
=========================================
Provides ICT (Inner Circle Trader) analysis for Gold (XAUUSD) using yfinance.
Endpoints cover price data, ICT concepts (OBs, FVGs, Liquidity, Market Structure)
and composite signal generation with confluence scoring.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FastAPI app + CORS
# ---------------------------------------------------------------------------
app = FastAPI(
    title="XAUUSD Signal Analyzer",
    description="ICT-based trading signal analyzer for Gold (XAUUSD)",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
TICKER = "GC=F"   # Gold futures on Yahoo Finance

# Session windows (UTC hours, inclusive start / exclusive end)
SESSIONS: dict[str, tuple[int, int]] = {
    "Asia":     (0,  5),
    "London":   (7, 12),
    "New York": (12, 17),
}

# Kill Zones are prime ICT entry windows inside sessions
KILL_ZONES: dict[str, tuple[int, int]] = {
    "London Open":   (7, 10),
    "New York Open": (12, 14),
}

# Timeframe map: label -> (yfinance period, yfinance interval)
TIMEFRAME_MAP: dict[str, tuple[str, str]] = {
    "1m":  ("1d",  "1m"),
    "5m":  ("5d",  "5m"),
    "15m": ("5d",  "15m"),
    "1h":  ("30d", "1h"),
    "4h":  ("60d", "1h"),   # yfinance has no 4h; we resample from 1h
    "1d":  ("1y",  "1d"),
}


# ---------------------------------------------------------------------------
# Pydantic response models
# ---------------------------------------------------------------------------
class PriceResponse(BaseModel):
    ticker: str
    price: float
    bid: Optional[float] = None
    ask: Optional[float] = None
    volume: Optional[float] = None
    timestamp: str


class OHLCBar(BaseModel):
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: float


class SessionResponse(BaseModel):
    current_session: str
    in_kill_zone: bool
    kill_zone_name: Optional[str]
    utc_hour: int
    is_market_open: bool


class OrderBlock(BaseModel):
    id: str
    type: str           # "bullish" | "bearish"
    price_high: float
    price_low: float
    price_mid: float
    strength: str       # "strong" | "moderate" | "weak"
    timestamp: str
    tested: bool        # has price revisited the OB?


class FVGZone(BaseModel):
    id: str
    type: str           # "bullish" | "bearish"
    top: float
    bottom: float
    gap_size: float
    gap_pct: float
    timestamp: str
    filled: bool        # has the gap been filled?


class LiquidityZone(BaseModel):
    id: str
    type: str           # "BSL" (buy-side) | "SSL" (sell-side)
    price: float
    timestamp: str
    swept: bool         # has the liquidity been taken?
    strength: int       # candle count that formed the level


class MarketStructure(BaseModel):
    trend: str                          # "bullish" | "bearish" | "ranging"
    last_event: str                     # "BOS" | "MSS" | "CHoCH"
    last_event_price: float
    last_event_timestamp: str
    swing_highs: list[float]
    swing_lows: list[float]
    higher_high: bool
    higher_low: bool
    lower_high: bool
    lower_low: bool


class SignalResponse(BaseModel):
    signal: str             # "BUY" | "SELL" | "NEUTRAL"
    confidence: int         # 0-10
    entry: float
    stop_loss: float
    take_profit_1: float
    take_profit_2: float
    risk_reward: float
    confluence_score: int
    reasoning: list[str]
    timestamp: str


class MTFAnalysis(BaseModel):
    timeframe: str
    trend: str
    bias: str               # "bullish" | "bearish" | "neutral"
    key_level: float
    momentum: str           # "strong" | "moderate" | "weak"


class ConfluenceScore(BaseModel):
    total: int
    max_score: int
    breakdown: dict[str, int]
    rating: str             # "Strong" | "Moderate" | "Weak" | "No Signal"


# ---------------------------------------------------------------------------
# Data fetching helpers
# ---------------------------------------------------------------------------

def fetch_ohlc(period: str = "5d", interval: str = "1h") -> pd.DataFrame:
    """
    Download OHLC data from Yahoo Finance for gold futures.
    Returns a clean DataFrame with columns: open, high, low, close, volume.
    Raises HTTPException on failure.
    """
    try:
        ticker = yf.Ticker(TICKER)
        df = ticker.history(period=period, interval=interval)
        if df.empty:
            raise ValueError("Empty dataframe returned from yfinance")

        # Normalise column names
        df.columns = [c.lower() for c in df.columns]
        df = df[["open", "high", "low", "close", "volume"]].dropna()

        # Ensure UTC-aware index
        if df.index.tz is None:
            df.index = df.index.tz_localize("UTC")
        else:
            df.index = df.index.tz_convert("UTC")

        return df

    except Exception as exc:
        logger.error("yfinance fetch failed: %s", exc)
        raise HTTPException(status_code=503, detail=f"Market data unavailable: {exc}")


def resample_4h(df: pd.DataFrame) -> pd.DataFrame:
    """Resample 1h data to 4h bars."""
    return df.resample("4h").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    ).dropna()


# ---------------------------------------------------------------------------
# ICT Analysis helpers
# ---------------------------------------------------------------------------

def detect_order_blocks(df: pd.DataFrame, lookback: int = 50) -> list[dict[str, Any]]:
    """
    Identify Order Blocks (OBs) in price data.

    Bullish OB  – the last *bearish* candle before a strong bullish impulse.
                  Price is expected to return to this zone and bounce up.
    Bearish OB  – the last *bullish* candle before a strong bearish impulse.
                  Price is expected to return to this zone and reject down.

    We use a simple 3-candle confirmation: after the candidate OB candle the
    next candle must close strongly in the impulse direction (>50 % of OB range).
    """
    obs: list[dict[str, Any]] = []
    recent = df.tail(lookback).reset_index()

    current_price = df["close"].iloc[-1]

    for i in range(2, len(recent) - 1):
        candle     = recent.iloc[i]
        prev       = recent.iloc[i - 1]
        next_c     = recent.iloc[i + 1]
        candle_range = candle["high"] - candle["low"]
        if candle_range == 0:
            continue

        # --- Bullish OB: bearish candle followed by strong bullish candle ---
        is_bearish_candle = candle["close"] < candle["open"]
        is_bullish_impulse = (
            next_c["close"] > next_c["open"]
            and (next_c["close"] - next_c["open"]) > 0.5 * candle_range
        )
        if is_bearish_candle and is_bullish_impulse:
            ob_high = max(candle["open"], candle["close"])
            ob_low  = min(candle["open"], candle["close"])
            tested  = current_price <= ob_high * 1.002  # price has come back near OB
            obs.append({
                "id":          f"bull_ob_{i}",
                "type":        "bullish",
                "price_high":  round(ob_high, 2),
                "price_low":   round(ob_low, 2),
                "price_mid":   round((ob_high + ob_low) / 2, 2),
                "strength":    "strong" if (next_c["close"] - next_c["open"]) > candle_range else "moderate",
                "timestamp":   str(candle["Datetime"] if "Datetime" in candle else candle.name),
                "tested":      tested,
            })

        # --- Bearish OB: bullish candle followed by strong bearish candle ---
        is_bullish_candle = candle["close"] > candle["open"]
        is_bearish_impulse = (
            next_c["close"] < next_c["open"]
            and (next_c["open"] - next_c["close"]) > 0.5 * candle_range
        )
        if is_bullish_candle and is_bearish_impulse:
            ob_high = max(candle["open"], candle["close"])
            ob_low  = min(candle["open"], candle["close"])
            tested  = current_price >= ob_low * 0.998
            obs.append({
                "id":          f"bear_ob_{i}",
                "type":        "bearish",
                "price_high":  round(ob_high, 2),
                "price_low":   round(ob_low, 2),
                "price_mid":   round((ob_high + ob_low) / 2, 2),
                "strength":    "strong" if (next_c["open"] - next_c["close"]) > candle_range else "moderate",
                "timestamp":   str(candle["Datetime"] if "Datetime" in candle else candle.name),
                "tested":      tested,
            })

    # Return the 5 most recent OBs
    return obs[-5:]


def detect_fvg(df: pd.DataFrame, lookback: int = 50) -> list[dict[str, Any]]:
    """
    Detect Fair Value Gaps (FVGs / Imbalances).

    Bullish FVG – Candle[i-1].high < Candle[i+1].low  (gap above candle i-1)
    Bearish FVG – Candle[i-1].low  > Candle[i+1].high (gap below candle i-1)

    The middle candle (i) is the momentum candle that creates the imbalance.
    """
    fvgs: list[dict[str, Any]] = []
    recent = df.tail(lookback).reset_index()
    current_price = df["close"].iloc[-1]

    for i in range(1, len(recent) - 1):
        c0 = recent.iloc[i - 1]   # candle before impulse
        c1 = recent.iloc[i]       # impulse candle
        c2 = recent.iloc[i + 1]   # candle after impulse

        ts = str(c1["Datetime"] if "Datetime" in c1 else c1.name)

        # Bullish FVG: gap between c0 high and c2 low
        if c0["high"] < c2["low"]:
            top    = c2["low"]
            bottom = c0["high"]
            gap    = top - bottom
            filled = current_price <= top and current_price >= bottom
            fvgs.append({
                "id":       f"bull_fvg_{i}",
                "type":     "bullish",
                "top":      round(top, 2),
                "bottom":   round(bottom, 2),
                "gap_size": round(gap, 2),
                "gap_pct":  round(gap / c1["close"] * 100, 4),
                "timestamp": ts,
                "filled":   filled,
            })

        # Bearish FVG: gap between c0 low and c2 high
        elif c0["low"] > c2["high"]:
            top    = c0["low"]
            bottom = c2["high"]
            gap    = top - bottom
            filled = current_price >= bottom and current_price <= top
            fvgs.append({
                "id":       f"bear_fvg_{i}",
                "type":     "bearish",
                "top":      round(top, 2),
                "bottom":   round(bottom, 2),
                "gap_size": round(gap, 2),
                "gap_pct":  round(gap / c1["close"] * 100, 4),
                "timestamp": ts,
                "filled":   filled,
            })

    return fvgs[-5:]


def detect_liquidity_zones(df: pd.DataFrame, lookback: int = 100, swing_period: int = 5) -> list[dict[str, Any]]:
    """
    Identify Buy-Side Liquidity (BSL) and Sell-Side Liquidity (SSL) zones.

    BSL sits above recent swing highs – equal highs where stops cluster.
    SSL sits below recent swing lows  – equal lows where stops cluster.

    A swing high is a candle whose high is the highest in ±swing_period bars.
    A swing low  is a candle whose low  is the lowest  in ±swing_period bars.
    """
    zones: list[dict[str, Any]] = []
    recent = df.tail(lookback).reset_index()
    current_price = df["close"].iloc[-1]

    highs: list[tuple[float, Any]] = []
    lows:  list[tuple[float, Any]] = []

    for i in range(swing_period, len(recent) - swing_period):
        window_high = recent["high"].iloc[i - swing_period : i + swing_period + 1]
        window_low  = recent["low"].iloc[i - swing_period : i + swing_period + 1]
        candle = recent.iloc[i]
        ts = str(candle["Datetime"] if "Datetime" in candle else candle.name)

        if candle["high"] == window_high.max():
            highs.append((candle["high"], ts))
        if candle["low"] == window_low.min():
            lows.append((candle["low"], ts))

    # Group equal highs (within 0.1 %) as BSL
    for idx, (price, ts) in enumerate(highs[-10:]):
        swept = current_price > price * 1.001
        zones.append({
            "id":       f"bsl_{idx}",
            "type":     "BSL",
            "price":    round(price, 2),
            "timestamp": ts,
            "swept":    swept,
            "strength": sum(1 for p, _ in highs if abs(p - price) / price < 0.001),
        })

    # Group equal lows as SSL
    for idx, (price, ts) in enumerate(lows[-10:]):
        swept = current_price < price * 0.999
        zones.append({
            "id":       f"ssl_{idx}",
            "type":     "SSL",
            "price":    round(price, 2),
            "timestamp": ts,
            "swept":    swept,
            "strength": sum(1 for p, _ in lows if abs(p - price) / price < 0.001),
        })

    return zones


def analyze_market_structure(df: pd.DataFrame) -> dict[str, Any]:
    """
    Determine market structure by tracking swing highs / lows.

    Bullish structure: series of Higher Highs (HH) + Higher Lows (HL)
    Bearish structure: series of Lower Highs (LH) + Lower Lows (LL)

    Break of Structure (BOS)  – price continues in existing trend direction.
    Market Structure Shift (MSS) / Change of Character (CHoCH) – trend reversal.
    """
    recent = df.tail(100)

    # Identify swing points with a 3-bar pivot
    swing_highs: list[float] = []
    swing_lows:  list[float] = []
    swing_high_times: list[str] = []
    swing_low_times:  list[str] = []

    for i in range(2, len(recent) - 2):
        bar = recent.iloc[i]
        if (recent["high"].iloc[i] > recent["high"].iloc[i - 1]
                and recent["high"].iloc[i] > recent["high"].iloc[i + 1]
                and recent["high"].iloc[i] > recent["high"].iloc[i - 2]
                and recent["high"].iloc[i] > recent["high"].iloc[i + 2]):
            swing_highs.append(round(bar["high"], 2))
            swing_high_times.append(str(recent.index[i]))

        if (recent["low"].iloc[i] < recent["low"].iloc[i - 1]
                and recent["low"].iloc[i] < recent["low"].iloc[i + 1]
                and recent["low"].iloc[i] < recent["low"].iloc[i - 2]
                and recent["low"].iloc[i] < recent["low"].iloc[i + 2]):
            swing_lows.append(round(bar["low"], 2))
            swing_low_times.append(str(recent.index[i]))

    # Determine structure flags from last 3 swings
    hh = hl = lh = ll = False
    if len(swing_highs) >= 2:
        hh = swing_highs[-1] > swing_highs[-2]
        lh = swing_highs[-1] < swing_highs[-2]
    if len(swing_lows) >= 2:
        hl = swing_lows[-1] > swing_lows[-2]
        ll = swing_lows[-1] < swing_lows[-2]

    if hh and hl:
        trend = "bullish"
    elif lh and ll:
        trend = "bearish"
    else:
        trend = "ranging"

    # Classify the most recent structural event
    last_event       = "BOS"
    last_event_price = df["close"].iloc[-1]
    last_event_ts    = str(df.index[-1])

    if swing_highs and swing_lows:
        # CHoCH: bearish trend breaks above last swing high (or vice-versa)
        if trend == "bullish" and ll:
            last_event = "CHoCH"
            last_event_price = swing_lows[-1] if swing_lows else last_event_price
        elif trend == "bearish" and hh:
            last_event = "CHoCH"
            last_event_price = swing_highs[-1] if swing_highs else last_event_price
        elif hh or ll:
            last_event = "BOS"
        else:
            last_event = "MSS"

    return {
        "trend":               trend,
        "last_event":          last_event,
        "last_event_price":    last_event_price,
        "last_event_timestamp": last_event_ts,
        "swing_highs":         swing_highs[-5:],
        "swing_lows":          swing_lows[-5:],
        "higher_high":         hh,
        "higher_low":          hl,
        "lower_high":          lh,
        "lower_low":           ll,
    }


def get_current_session() -> dict[str, Any]:
    """Return the active trading session and kill zone status based on UTC time."""
    now_utc = datetime.now(timezone.utc)
    hour    = now_utc.hour

    current_session = "Off-Hours"
    for name, (start, end) in SESSIONS.items():
        if start <= hour < end:
            current_session = name
            break

    in_kill_zone  = False
    kill_zone_name: Optional[str] = None
    for kz_name, (start, end) in KILL_ZONES.items():
        if start <= hour < end:
            in_kill_zone   = True
            kill_zone_name = kz_name
            break

    # Gold futures trade nearly 24/5; closed on weekends
    is_market_open = now_utc.weekday() < 5

    return {
        "current_session": current_session,
        "in_kill_zone":    in_kill_zone,
        "kill_zone_name":  kill_zone_name,
        "utc_hour":        hour,
        "is_market_open":  is_market_open,
    }


def compute_confluence_score(
    structure: dict,
    obs: list[dict],
    fvgs: list[dict],
    liquidity: list[dict],
    session: dict,
    mtf_trends: list[str],
) -> dict[str, Any]:
    """
    Calculate a 10-point confluence score.

    Breakdown:
      - Multi-timeframe alignment  : 0-3 pts  (how many TFs agree)
      - Order Block confluence     : 0-2 pts  (active untested OBs near price)
      - Fair Value Gap             : 0-2 pts  (unfilled FVG near price)
      - Liquidity sweep            : 0-2 pts  (recent liquidity taken)
      - Kill Zone timing           : 0-1 pt   (inside London/NY kill zone)

    Signal fires when total >= 7.
    """
    breakdown: dict[str, int] = {}

    # --- MTF alignment (max 3 pts) ---
    bull_count = mtf_trends.count("bullish")
    bear_count = mtf_trends.count("bearish")
    dominant   = max(bull_count, bear_count)
    mtf_score  = min(3, dominant)          # 3 of 3+ TFs aligned = 3 pts
    breakdown["multi_timeframe"] = mtf_score

    # --- Order Block near price (max 2 pts) ---
    active_obs = [ob for ob in obs if not ob["tested"]]
    ob_score   = min(2, len(active_obs))
    breakdown["order_block"] = ob_score

    # --- Unfilled FVG (max 2 pts) ---
    unfilled_fvgs = [f for f in fvgs if not f["filled"]]
    fvg_score     = min(2, len(unfilled_fvgs))
    breakdown["fair_value_gap"] = fvg_score

    # --- Liquidity swept (max 2 pts) ---
    swept_zones = [z for z in liquidity if z["swept"]]
    liq_score   = min(2, len(swept_zones))
    breakdown["liquidity_sweep"] = liq_score

    # --- Kill Zone (1 pt) ---
    kz_score = 1 if session["in_kill_zone"] else 0
    breakdown["kill_zone"] = kz_score

    total    = sum(breakdown.values())
    max_score = 10

    if total >= 8:
        rating = "Strong"
    elif total >= 6:
        rating = "Moderate"
    elif total >= 4:
        rating = "Weak"
    else:
        rating = "No Signal"

    return {
        "total":     total,
        "max_score": max_score,
        "breakdown": breakdown,
        "rating":    rating,
    }


def generate_signal(
    df: pd.DataFrame,
    structure: dict,
    obs: list[dict],
    fvgs: list[dict],
    liquidity: list[dict],
    confluence: dict,
    session: dict,
) -> dict[str, Any]:
    """
    Generate a trading signal (BUY / SELL / NEUTRAL) with entry, SL, and TP levels.

    Entry  – current price (market order model; practitioners refine to OB mid)
    SL     – below nearest bullish OB low (for BUY) or above bearish OB high (for SELL)
    TP1    – 1:1.5 R:R target
    TP2    – 1:3   R:R target
    """
    current_price = float(df["close"].iloc[-1])
    atr           = float(df["high"].sub(df["low"]).tail(14).mean())  # simple ATR proxy

    bull_obs  = [ob for ob in obs if ob["type"] == "bullish" and not ob["tested"]]
    bear_obs  = [ob for ob in obs if ob["type"] == "bearish" and not ob["tested"]]
    bull_fvgs = [f for f in fvgs if f["type"] == "bullish" and not f["filled"]]
    bear_fvgs = [f for f in fvgs if f["type"] == "bearish" and not f["filled"]]

    trend    = structure["trend"]
    score    = confluence["total"]
    reasons: list[str] = []

    # Determine directional bias
    bias = "neutral"
    if trend == "bullish":
        bias = "bullish"
        reasons.append(f"Market structure is bullish ({structure['last_event']})")
    elif trend == "bearish":
        bias = "bearish"
        reasons.append(f"Market structure is bearish ({structure['last_event']})")

    if session["in_kill_zone"]:
        reasons.append(f"Inside {session['kill_zone_name']} Kill Zone – optimal entry window")

    if bull_obs:
        reasons.append(f"{len(bull_obs)} active bullish Order Block(s) present")
    if bear_obs:
        reasons.append(f"{len(bear_obs)} active bearish Order Block(s) present")
    if bull_fvgs:
        reasons.append(f"{len(bull_fvgs)} unfilled bullish Fair Value Gap(s)")
    if bear_fvgs:
        reasons.append(f"{len(bear_fvgs)} unfilled bearish Fair Value Gap(s)")

    reasons.append(f"Confluence score: {score}/10 ({confluence['rating']})")

    # Only fire signal when score threshold is met
    if score < 7:
        return {
            "signal":          "NEUTRAL",
            "confidence":      score,
            "entry":           round(current_price, 2),
            "stop_loss":       round(current_price - atr, 2),
            "take_profit_1":   round(current_price + atr * 1.5, 2),
            "take_profit_2":   round(current_price + atr * 3, 2),
            "risk_reward":     1.5,
            "confluence_score": score,
            "reasoning":       reasons,
            "timestamp":       datetime.now(timezone.utc).isoformat(),
        }

    if bias == "bullish":
        sl_anchor = bull_obs[0]["price_low"] if bull_obs else current_price - atr
        stop_loss   = round(sl_anchor - atr * 0.25, 2)
        risk        = current_price - stop_loss
        tp1         = round(current_price + risk * 1.5, 2)
        tp2         = round(current_price + risk * 3.0, 2)
        rr          = round(risk * 1.5 / risk, 2) if risk else 1.5
        signal      = "BUY"
    elif bias == "bearish":
        sl_anchor  = bear_obs[0]["price_high"] if bear_obs else current_price + atr
        stop_loss  = round(sl_anchor + atr * 0.25, 2)
        risk       = stop_loss - current_price
        tp1        = round(current_price - risk * 1.5, 2)
        tp2        = round(current_price - risk * 3.0, 2)
        rr         = round(risk * 1.5 / risk, 2) if risk else 1.5
        signal     = "SELL"
    else:
        signal    = "NEUTRAL"
        stop_loss = round(current_price - atr, 2)
        tp1       = round(current_price + atr * 1.5, 2)
        tp2       = round(current_price + atr * 3, 2)
        rr        = 1.5

    return {
        "signal":          signal,
        "confidence":      score,
        "entry":           round(current_price, 2),
        "stop_loss":       round(stop_loss, 2),
        "take_profit_1":   tp1,
        "take_profit_2":   tp2,
        "risk_reward":     rr,
        "confluence_score": score,
        "reasoning":       reasons,
        "timestamp":       datetime.now(timezone.utc).isoformat(),
    }


def get_mtf_bias(df_map: dict[str, pd.DataFrame]) -> list[dict[str, Any]]:
    """
    Run a lightweight trend analysis on each timeframe DataFrame.
    Uses 20-period EMA vs 50-period EMA as a simple bias filter.
    """
    results: list[dict[str, Any]] = []
    for tf, df in df_map.items():
        if len(df) < 55:
            continue
        ema20 = df["close"].ewm(span=20, adjust=False).mean().iloc[-1]
        ema50 = df["close"].ewm(span=50, adjust=False).mean().iloc[-1]
        close = df["close"].iloc[-1]
        high  = df["high"].tail(20).max()
        low   = df["low"].tail(20).min()

        if ema20 > ema50:
            bias  = "bullish"
            trend = "bullish"
        elif ema20 < ema50:
            bias  = "bearish"
            trend = "bearish"
        else:
            bias  = "neutral"
            trend = "ranging"

        # Simple momentum: how far from midpoint of recent range
        mid = (high + low) / 2
        if abs(close - mid) / (high - low + 1e-9) > 0.3:
            momentum = "strong"
        elif abs(close - mid) / (high - low + 1e-9) > 0.15:
            momentum = "moderate"
        else:
            momentum = "weak"

        results.append({
            "timeframe": tf,
            "trend":     trend,
            "bias":      bias,
            "key_level": round((high + low) / 2, 2),
            "momentum":  momentum,
        })
    return results


# ---------------------------------------------------------------------------
# Signal history (simple in-memory store – reset on restart)
# ---------------------------------------------------------------------------
_signal_history: list[dict] = []


def _record_signal(sig: dict) -> None:
    _signal_history.append(sig)
    if len(_signal_history) > 200:
        _signal_history.pop(0)


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@app.get("/", tags=["Health"])
def root() -> dict:
    """Health check."""
    return {"status": "ok", "service": "XAUUSD Signal Analyzer"}


@app.get("/api/v1/market/price", response_model=PriceResponse, tags=["Market"])
def get_price() -> PriceResponse:
    """Return the latest XAUUSD (Gold Futures) price."""
    df = fetch_ohlc(period="1d", interval="1m")
    last = df.iloc[-1]
    return PriceResponse(
        ticker=TICKER,
        price=round(float(last["close"]), 2),
        bid=round(float(last["close"]) - 0.10, 2),
        ask=round(float(last["close"]) + 0.10, 2),
        volume=float(last["volume"]),
        timestamp=str(df.index[-1]),
    )


@app.get("/api/v1/market/ohlc", tags=["Market"])
def get_ohlc(
    timeframe: str = Query(default="1h", description="Timeframe: 1m,5m,15m,1h,4h,1d")
) -> list[OHLCBar]:
    """Return OHLC bars for the requested timeframe."""
    if timeframe not in TIMEFRAME_MAP:
        raise HTTPException(status_code=400, detail=f"Unknown timeframe: {timeframe}")
    period, interval = TIMEFRAME_MAP[timeframe]
    df = fetch_ohlc(period=period, interval=interval)
    if timeframe == "4h":
        df = resample_4h(df)
    # Return latest 100 bars
    df = df.tail(100)
    return [
        OHLCBar(
            timestamp=str(idx),
            open=round(float(row["open"]), 2),
            high=round(float(row["high"]), 2),
            low=round(float(row["low"]), 2),
            close=round(float(row["close"]), 2),
            volume=float(row["volume"]),
        )
        for idx, row in df.iterrows()
    ]


@app.get("/api/v1/market/session", response_model=SessionResponse, tags=["Market"])
def get_session() -> SessionResponse:
    """Return current trading session information."""
    return SessionResponse(**get_current_session())


@app.get("/api/v1/signals/current", response_model=SignalResponse, tags=["Signals"])
def get_current_signal() -> SignalResponse:
    """
    Generate and return the current trading signal with full ICT analysis.
    A signal fires only when the 10-point confluence score is >= 7.
    """
    # Use 1h for primary analysis
    df       = fetch_ohlc(period="30d", interval="1h")
    session  = get_current_session()
    obs      = detect_order_blocks(df)
    fvgs     = detect_fvg(df)
    liq      = detect_liquidity_zones(df)
    structure = analyze_market_structure(df)

    # Quick MTF bias from 1h and daily data
    df_daily = fetch_ohlc(period="1y", interval="1d")
    mtf_trends = [structure["trend"], analyze_market_structure(df_daily)["trend"]]

    confluence = compute_confluence_score(structure, obs, fvgs, liq, session, mtf_trends)
    signal     = generate_signal(df, structure, obs, fvgs, liq, confluence, session)

    _record_signal(signal)
    return SignalResponse(**signal)


@app.get("/api/v1/signals/history", tags=["Signals"])
def get_signal_history(limit: int = Query(default=20, ge=1, le=100)) -> list[dict]:
    """Return recent signal history (most recent first)."""
    return list(reversed(_signal_history[-limit:]))


@app.get("/api/v1/ict/order-blocks", tags=["ICT"])
def get_order_blocks(
    timeframe: str = Query(default="1h")
) -> list[OrderBlock]:
    """Return active Order Blocks for the given timeframe."""
    if timeframe not in TIMEFRAME_MAP:
        raise HTTPException(status_code=400, detail=f"Unknown timeframe: {timeframe}")
    period, interval = TIMEFRAME_MAP[timeframe]
    df  = fetch_ohlc(period=period, interval=interval)
    obs = detect_order_blocks(df)
    return [OrderBlock(**ob) for ob in obs]


@app.get("/api/v1/ict/fvg", tags=["ICT"])
def get_fvg(
    timeframe: str = Query(default="1h")
) -> list[FVGZone]:
    """Return Fair Value Gaps for the given timeframe."""
    if timeframe not in TIMEFRAME_MAP:
        raise HTTPException(status_code=400, detail=f"Unknown timeframe: {timeframe}")
    period, interval = TIMEFRAME_MAP[timeframe]
    df   = fetch_ohlc(period=period, interval=interval)
    fvgs = detect_fvg(df)
    return [FVGZone(**f) for f in fvgs]


@app.get("/api/v1/ict/liquidity", tags=["ICT"])
def get_liquidity(
    timeframe: str = Query(default="1h")
) -> list[LiquidityZone]:
    """Return Buy-Side and Sell-Side Liquidity zones."""
    if timeframe not in TIMEFRAME_MAP:
        raise HTTPException(status_code=400, detail=f"Unknown timeframe: {timeframe}")
    period, interval = TIMEFRAME_MAP[timeframe]
    df  = fetch_ohlc(period=period, interval=interval)
    liq = detect_liquidity_zones(df)
    return [LiquidityZone(**z) for z in liq]


@app.get("/api/v1/ict/market-structure", response_model=MarketStructure, tags=["ICT"])
def get_market_structure(
    timeframe: str = Query(default="1h")
) -> MarketStructure:
    """Return market structure analysis (HH/HL/LH/LL, BOS, MSS, CHoCH)."""
    if timeframe not in TIMEFRAME_MAP:
        raise HTTPException(status_code=400, detail=f"Unknown timeframe: {timeframe}")
    period, interval = TIMEFRAME_MAP[timeframe]
    df        = fetch_ohlc(period=period, interval=interval)
    structure = analyze_market_structure(df)
    return MarketStructure(**structure)


@app.get("/api/v1/analysis/multi-timeframe", tags=["Analysis"])
def get_mtf_analysis() -> list[MTFAnalysis]:
    """
    Return trend bias and momentum across multiple timeframes:
    15m, 1h, 4h, 1d.
    """
    df_map: dict[str, pd.DataFrame] = {}
    for tf in ["15m", "1h", "4h", "1d"]:
        period, interval = TIMEFRAME_MAP[tf]
        df = fetch_ohlc(period=period, interval=interval)
        if tf == "4h":
            df = resample_4h(df)
        df_map[tf] = df

    results = get_mtf_bias(df_map)
    return [MTFAnalysis(**r) for r in results]


@app.get("/api/v1/analysis/confluence-score", response_model=ConfluenceScore, tags=["Analysis"])
def get_confluence() -> ConfluenceScore:
    """Return the current 10-point confluence score breakdown."""
    df        = fetch_ohlc(period="30d", interval="1h")
    session   = get_current_session()
    obs       = detect_order_blocks(df)
    fvgs      = detect_fvg(df)
    liq       = detect_liquidity_zones(df)
    structure = analyze_market_structure(df)
    df_daily  = fetch_ohlc(period="1y", interval="1d")
    mtf_trends = [structure["trend"], analyze_market_structure(df_daily)["trend"]]
    confluence = compute_confluence_score(structure, obs, fvgs, liq, session, mtf_trends)
    return ConfluenceScore(**confluence)
