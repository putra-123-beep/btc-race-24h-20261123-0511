// Dip-buy mean-reversion bot for the make.fun 24h cbBTC race.
// Protocol: agent-fun/bars-replay/v1 (newline-delimited JSON over stdin/stdout).
//
// Input:  one JSON object per line, one 1-minute cbBTC bar per line.
//         The bar may arrive as { "bar": {...} } or as a flat object, with
//         OHLC under o/h/l/c, open/high/low/close, or close-only fields.
//         A batch/sequence id, when present (batch_id / id / seq), is echoed
//         back in the reply. Non-bar lines are answered with empty orders.
// Output: one JSON object per input line:
//         {"type":"reply","batch_id":<echoed id>,"orders":[...]}.
//         Each order: {"side":"buy"|"sell","symbol":"cbBTC/USDC",
//                      "type":"market","amount":"ALL","max_slippage_bps":100}.
//         "ALL" buys with all available cash / sells the whole position.
//         Empty orders array means "hold / do nothing this minute".
//
// Strategy (long-only, one position at a time, fully deterministic):
//   - Warm up 60 bars to build SMA60; SMA240 is used as a trend context
//     once 240 bars exist.
//   - BUY (all cash) when price has dipped at least 60 bps below its
//     60-bar mean AND the latest bar closed up (a bounce, so we do not
//     catch a knife mid-fall) AND the 60-bar mean is not in a clear
//     downtrend vs the 240-bar mean, AND at least 15 bars have passed
//     since the last exit (cooldown against whipsaw re-entries).
//   - SELL (whole position) at +100 bps take-profit, -100 bps stop-loss,
//     when price recovers to 30 bps above its 60-bar mean (mean-reversion
//     exit), or after 180 bars held (time stop).
//   - Round-trip cost in the replay is ~12 bps (4 bps fee + 2 bps
//     slippage, each side) plus price impact, so the 100 bps targets
//     leave room for a positive expectancy when mean reversion holds.
//
// Determinism: no clock, no randomness, no network, no file access.
// Only Node's standard library is used. No dependencies.

import * as readline from "node:readline";

const SYMBOL = "cbBTC/USDC";
const MAX_SLIPPAGE_BPS = 100;

// --- Strategy parameters (basis points unless noted) ---
const SMA_FAST = 60; // bars for the mean we fade back toward
const SMA_SLOW = 240; // bars for the trend context
const DIP_BPS = 60; // buy only this far below SMA_FAST (60 bps = 0.60%)
const BOUNCE_REQUIRED = true; // latest bar must close above the prior close
const TREND_TOLERANCE_BPS = 10; // SMA_FAST may sit at most 10 bps below SMA_SLOW
const COOLDOWN_BARS = 15; // bars to wait after an exit before re-entering
const TAKE_PROFIT_BPS = 100; // +1.00% from entry
const STOP_LOSS_BPS = 100; // -1.00% from entry
const MEAN_EXIT_BPS = 30; // sell when close is 30 bps above SMA_FAST
const TIME_STOP_BARS = 180; // max bars to hold one position

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Order {
  side: "buy" | "sell";
  symbol: string;
  type: "market";
  amount: "ALL";
  max_slippage_bps: number;
}

type Position = { entry: number; entryBar: number } | null;

const closes: number[] = [];
let prevClose: number | null = null;
let position: Position = null;
let lastExitBar = -COOLDOWN_BARS - 1;
let barIndex = 0;

function sumWindow(n: number): number {
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s;
}

function sma(n: number): number | null {
  if (closes.length < n) return null;
  return sumWindow(n) / n;
}

/** Pull a usable bar out of whatever shape the harness sends. */
function parseBar(value: unknown): Bar | null {
  if (Array.isArray(value)) {
    // [t, o, h, l, c, (v)] positional form.
    if (value.length >= 5 && value.slice(1, 5).every((x) => typeof x === "number")) {
      return { open: value[1], high: value[2], low: value[3], close: value[4] };
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const inner = obj.bar;
  const src: Record<string, unknown> =
    typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : obj;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const close = num(src.close) ?? num(src.c);
  if (close === null) return null;
  const open = num(src.open) ?? num(src.o) ?? close;
  const high = num(src.high) ?? num(src.h) ?? Math.max(open, close);
  const low = num(src.low) ?? num(src.l) ?? Math.min(open, close);
  return { open, high, low, close };
}

function batchIdOf(value: unknown): number {
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of ["batch_id", "id", "seq", "sequence"]) {
      const v = obj[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    const inner = obj.bar;
    if (typeof inner === "object" && inner !== null) {
      const b = inner as Record<string, unknown>;
      for (const key of ["batch_id", "id", "seq", "sequence"]) {
        const v = b[key];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
    }
  }
  return barIndex;
}

function decide(bar: Bar): Order[] {
  closes.push(bar.close);
  const idx = barIndex;
  barIndex += 1;

  const fast = sma(SMA_FAST);
  const slow = sma(SMA_SLOW);
  const bounced = !BOUNCE_REQUIRED || prevClose === null || bar.close > prevClose;
  prevClose = bar.close;

  if (position === null) {
    if (fast === null) return [];
    if (idx - lastExitBar < COOLDOWN_BARS) return [];
    // No clear downtrend: fast mean may dip at most 10 bps under slow mean.
    if (slow !== null && fast < slow * (1 - TREND_TOLERANCE_BPS / 10000)) return [];
    if (bar.close <= fast * (1 - DIP_BPS / 10000) && bounced) {
      position = { entry: bar.close, entryBar: idx };
      return [
        { side: "buy", symbol: SYMBOL, type: "market", amount: "ALL", max_slippage_bps: MAX_SLIPPAGE_BPS },
      ];
    }
    return [];
  }

  // In a position: exits.
  const held = idx - position.entryBar;
  const tp = position.entry * (1 + TAKE_PROFIT_BPS / 10000);
  const sl = position.entry * (1 - STOP_LOSS_BPS / 10000);
  const meanExit = fast !== null && bar.close >= fast * (1 + MEAN_EXIT_BPS / 10000);
  if (bar.close >= tp || bar.close <= sl || meanExit || held >= TIME_STOP_BARS) {
    position = null;
    lastExitBar = idx;
    return [
      { side: "sell", symbol: SYMBOL, type: "market", amount: "ALL", max_slippage_bps: MAX_SLIPPAGE_BPS },
    ];
  }
  return [];
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }
  const bar = parsed === null ? null : parseBar(parsed);
  const orders: Order[] = bar === null ? [] : decide(bar);
  const reply = { type: "reply", batch_id: batchIdOf(parsed), orders };
  process.stdout.write(JSON.stringify(reply) + "\n");
});
