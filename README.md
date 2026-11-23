# BTC Race Bot — Dip-Buy Mean Reversion (cbBTC, 1-minute bars)

Entry for make.fun **"Race a BTC trading bot live for 24 hours"**
(`btc-race-24h-20261123-0511`, $50 pool, 1st $12).

## What it is

`main.ts` — a single-file, dependency-free Node 22 bot (erasable
TypeScript, standard library only). It reads one JSON line per minute
(a 1-minute cbBTC bar) on stdin and answers each line with one JSON
reply on stdout, following the `agent-fun/bars-replay/v1` bars-replay
protocol:

```json
{"type": "reply", "batch_id": 1042, "orders": [
  {"side": "buy", "symbol": "cbBTC/USDC", "type": "market",
   "amount": "ALL", "max_slippage_bps": 100}
]}
```

- `batch_id` from the incoming line is echoed back (`batch_id` / `id` /
  `seq` accepted; otherwise the bot's own bar counter is used).
- An empty `orders` array means "hold / do nothing this minute".
- `"amount": "ALL"` buys with all available cash / sells the whole
  position.
- Input shapes tolerated: `{"bar": {...}}` or a flat bar object, OHLC
  under `o/h/l/c` or `open/high/low/close`, close-only bars, and
  positional `[t, o, h, l, c]` arrays. Non-bar lines (e.g. a hello /
  config message) are answered with empty orders. Malformed lines never
  crash the bot.

## Strategy (long-only, one position at a time, deterministic)

- **Warm-up:** 60 bars to build SMA60; SMA240 is a trend context once
  240 bars exist.
- **BUY (all cash)** when the close is at least **60 bps below SMA60**,
  the latest bar closed **up** (a bounce — no knife-catching), SMA60 is
  not in a clear downtrend vs SMA240 (at most 10 bps below it), and at
  least **15 bars** have passed since the last exit.
- **SELL (whole position)** at **+100 bps take-profit**, **−100 bps
  stop-loss**, when the close recovers to **30 bps above SMA60**
  (mean-reversion exit), or after **180 bars** held (time stop).
- Replay costs are ~12 bps per round trip (4 bps fee + 2 bps slippage
  per fill, plus price impact), so the 100 bps targets leave room for a
  positive expectancy when mean reversion holds.

## Determinism

No clock, no randomness, no network, no file access. Two runs on the
same bars produce the same orders.

## Local test

A smoke/backtest harness (synthetic 1-minute bars, fills at the next
bar's open with the 4 bps fee + 2 bps slippage from the brief) was run
during development against four regimes (choppy / uptrend / downtrend /
crash-recovery, 3 seeds each) plus a pure random walk: the bot never
crashed, always answered one valid JSON reply per input line, and was
net-positive in 13 of 15 runs (median +0.31% per 24 h window, worst
−3.03%, max drawdown ≈1.4%). The harness itself is not part of this
repository.

## License

MIT — see `LICENSE`.
