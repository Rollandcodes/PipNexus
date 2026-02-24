# ICT Concepts – Implementation Guide

> This document explains the Inner Circle Trader (ICT) methodology concepts used in **PipNexus** and how each one is implemented in the backend codebase.

---

## Table of Contents

1. [Order Blocks (OB)](#1-order-blocks-ob)
2. [Fair Value Gaps (FVG)](#2-fair-value-gaps-fvg)
3. [Liquidity Zones (BSL/SSL)](#3-liquidity-zones-bslssl)
4. [Market Structure (BOS / MSS / CHoCH)](#4-market-structure-bos--mss--choch)
5. [Kill Zones & Trading Sessions](#5-kill-zones--trading-sessions)
6. [SMT Divergence](#6-smt-divergence)
7. [Confluence Scoring](#7-confluence-scoring)

---

## 1. Order Blocks (OB)

### Concept

An **Order Block** is the last opposing candle before a significant impulse move.  ICT teaches that institutional order flow originates from these areas, and that price will often return to "fill" the imbalance at the OB before continuing in the original direction.

- **Bullish OB** – the last *bearish* candle before a strong bullish move.  
  When price pulls back into this zone, smart money is expected to absorb sell orders and push price higher.
- **Bearish OB** – the last *bullish* candle before a strong bearish move.  
  When price retraces into this zone, smart money is expected to distribute positions and push price lower.

### Implementation (`detect_order_blocks`)

```python
# Iterate over OHLC bars
for i in range(2, len(recent) - 1):
    candle = recent.iloc[i]
    next_c = recent.iloc[i + 1]
    
    # Bullish OB: bearish candle + next candle is strongly bullish (>50% of OB range)
    if is_bearish(candle) and is_strong_bullish_impulse(next_c, candle):
        record_bullish_ob(candle)
    
    # Bearish OB: bullish candle + next candle is strongly bearish
    if is_bullish(candle) and is_strong_bearish_impulse(next_c, candle):
        record_bearish_ob(candle)
```

**Strength classification:**
| Strength   | Condition |
|------------|-----------|
| `strong`   | Impulse candle body > OB range |
| `moderate` | Impulse candle body ≤ OB range |

**Tested flag:** set to `True` when current price has returned within 0.2% of the OB boundary.

---

## 2. Fair Value Gaps (FVG)

### Concept

A **Fair Value Gap** (also called an *imbalance* or *liquidity void*) is a 3-candle pattern where a middle impulse candle moves so aggressively that a price gap remains between candle 1's wick and candle 3's opposing wick.  Price tends to return to fill these gaps.

```
Bullish FVG:
  Candle[i-1].high  ──┐
                      │  GAP (price never traded here)
  Candle[i+1].low   ──┘

Bearish FVG:
  Candle[i+1].high  ──┐
                      │  GAP
  Candle[i-1].low   ──┘
```

### Implementation (`detect_fvg`)

```python
for i in range(1, len(recent) - 1):
    c0, c1, c2 = recent.iloc[i-1], recent.iloc[i], recent.iloc[i+1]
    
    # Bullish FVG: gap between c0 high and c2 low
    if c0["high"] < c2["low"]:
        record_bullish_fvg(top=c2["low"], bottom=c0["high"])
    
    # Bearish FVG: gap between c0 low and c2 high
    elif c0["low"] > c2["high"]:
        record_bearish_fvg(top=c0["low"], bottom=c2["high"])
```

`gap_pct` is the gap size as a percentage of the close price — useful for filtering insignificant imbalances.

---

## 3. Liquidity Zones (BSL/SSL)

### Concept

**Liquidity** in ICT terms refers to resting stop-loss orders that accumulate above swing highs and below swing lows.  Smart money *targets* these pools before reversing, a process called a **liquidity sweep** (or "stop hunt").

| Zone Type | Location | Stop orders resting there |
|-----------|----------|--------------------------|
| **Buy-Side Liquidity (BSL)** | Above swing highs / equal highs | Short sellers' stops |
| **Sell-Side Liquidity (SSL)** | Below swing lows / equal lows  | Long buyers' stops  |

### Implementation (`detect_liquidity_zones`)

Swing highs and lows are identified using a ±5-bar pivot:

```python
for i in range(swing_period, len(recent) - swing_period):
    window_high = recent["high"].iloc[i-5 : i+6]
    if candle["high"] == window_high.max():
        record_swing_high(candle)   # BSL zone
```

**Swept flag:** `True` when price has moved beyond the zone by more than 0.1%.  
**Strength:** the count of candles forming equal highs/lows at the same price level.

---

## 4. Market Structure (BOS / MSS / CHoCH)

### Concept

ICT's market structure tracks the sequence of swing highs and swing lows to determine trend bias and identify structural shifts.

| Term | Full Name | Meaning |
|------|-----------|---------|
| **HH** | Higher High | Bullish continuation |
| **HL** | Higher Low  | Bullish pullback held |
| **LH** | Lower High  | Bearish continuation |
| **LL** | Lower Low   | Bearish extension |
| **BOS** | Break of Structure | Price breaks a previous swing in the direction of the trend |
| **MSS** | Market Structure Shift | Internal shift without full trend reversal |
| **CHoCH** | Change of Character | Full trend reversal – bearish breaks last swing high, or bullish breaks last swing low |

### Implementation (`analyze_market_structure`)

```python
# 3-bar swing detection
for i in range(2, len(recent) - 2):
    if bar["high"] == max(highs[i-2 : i+3]):
        record_swing_high(bar)
    if bar["low"]  == min(lows[i-2  : i+3]):
        record_swing_low(bar)

# Structure flags
hh = swing_highs[-1] > swing_highs[-2]
hl = swing_lows[-1]  > swing_lows[-2]
lh = swing_highs[-1] < swing_highs[-2]
ll = swing_lows[-1]  < swing_lows[-2]

trend = "bullish" if (hh and hl) else "bearish" if (lh and ll) else "ranging"
```

CHoCH is flagged when the trend structure contradicts the prior swing sequence.

---

## 5. Kill Zones & Trading Sessions

### Concept

ICT identifies specific UTC time windows where institutional order flow is most active and signals are highest probability.

| Session | UTC Hours | Notes |
|---------|-----------|-------|
| Asia | 00:00 – 05:00 | Range-building; low volume |
| London | 07:00 – 12:00 | Highest volatility; major moves |
| New York | 12:00 – 17:00 | Second wave; NY open overlaps London close |

**Kill Zones** are the *opening 3-hour windows* inside London and New York sessions:

| Kill Zone | UTC Hours | Significance |
|-----------|-----------|--------------|
| London Open | 07:00 – 10:00 | Best BUY/SELL setups; London traders taking positions |
| NY Open | 12:00 – 14:00 | Major reversals; institutional re-positioning |

### Implementation (`get_current_session`)

```python
now_utc = datetime.now(timezone.utc)
hour    = now_utc.hour

for name, (start, end) in SESSIONS.items():
    if start <= hour < end:
        current_session = name
```

The Kill Zone check adds **+1 to the confluence score**, rewarding signals that fire during optimal entry windows.

---

## 6. SMT Divergence

### Concept

**Smart Money Technique (SMT) Divergence** occurs when two correlated instruments (e.g., Gold and Silver, or ES and NQ) fail to confirm each other's swing highs/lows.

- **Bullish SMT**: Instrument A makes a lower low while Instrument B holds a higher low → smart money is accumulating on A.
- **Bearish SMT**: Instrument A makes a higher high while Instrument B prints a lower high → distribution on A.

### Implementation Note

Full SMT analysis requires fetching a correlated asset (e.g., Silver: `SI=F`) in parallel with Gold and comparing pivot points.  The current version of PipNexus uses intra-market confluence scoring instead; SMT divergence is planned for a future enhancement.

---

## 7. Confluence Scoring

PipNexus uses a **10-point scoring system**.  A signal is only generated when the score is **≥ 7**.

| Factor | Max Points | Condition |
|--------|-----------|-----------|
| Multi-timeframe alignment | 3 | How many TFs (15m, 1h, 4h, 1d) share the same directional bias |
| Order Block confluence | 2 | Number of active, untested OBs near current price |
| Fair Value Gap | 2 | Number of unfilled FVGs near current price |
| Liquidity sweep | 2 | Number of recent liquidity zones that have been swept |
| Kill Zone timing | 1 | Price is within a London/NY Kill Zone window |

```python
# Score fires a signal at threshold 7
if score >= 7:
    signal = "BUY"  # or "SELL" based on market structure
```

This conservative threshold helps filter out low-probability setups and reduces false signals in choppy or ranging markets.
