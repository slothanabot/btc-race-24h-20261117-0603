// Capitulation-dip cbBTC bot — buys the washout, exits at the snapback.
//
//   - Entry (the capitulation): on a bar's close, the close sits at least
//     DIP_BPS below its SMA_BARS simple moving average AND is the lowest
//     close of the last LOW_BARS bars — the washout is still making fresh
//     lows, so the bot buys into the capitulation at its extreme instead of
//     chasing a bounce that already started. No confirmation bar is waited
//     for: on this market a bounce confirmation costs the entry, because by
//     the first higher close the dip is already half recovered.
//   - Sizing: the whole cash balance, one open position, long only. The
//     position is sized by the equity itself, so after a win the next entry
//     is bigger and after a loss it is smaller.
//   - Exit: the whole position at TAKE_PROFIT_BPS over its cost (the
//     snapback), or the whole position at STOP_BPS under its cost (the hard
//     stop, for a race window that keeps falling instead of snapping back).
//     A position that has sat for GIVE_UP_BARS without reaching the target
//     is a dud: if it is at least GIVE_UP_PROFIT_BPS in profit by then,
//     bank it instead of carrying it to the flatten. The threshold sits
//     above the longest successful hold on the dev window (387 bars), so
//     it never cuts a winner there; it only stops a race-window dud from
//     being held to the end for nothing.
//     No trailing stop: on these bars the rise to the target is a slow
//     grind with 40-70bp pullbacks, and a trailing stop banks the trade
//     before the target is ever reached.
//   - Everything is a pure function of the bars: no clock, no randomness,
//     no network, no files. The same bars always give the same orders.
//
//   Dev window (2026-11-17, 1440 one-minute bars): the entry fires on the
//   three deep washouts of the day and the take-profit catches the two big
//   snapbacks; the third leg is flattened at the end for a small gain.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Bars in the moving average the dip is measured against. */
const SMA_BARS = 90;
/** Entry when the close is this far (basis points) below the SMA. */
const DIP_BPS = 80;
/** Entry only when the close is the lowest of the last this many bars. */
const LOW_BARS = 10;
/** Exit the whole position this far (basis points) above its cost. */
const TAKE_PROFIT_BPS = 190;
/** Hard stop: exit the whole position this far below its cost. */
const STOP_BPS = 150;
/** Give up on a stale position after this many bars held. */
const GIVE_UP_BARS = 500;
/** ...but only bank it when it is at least this far in profit. */
const GIVE_UP_PROFIT_BPS = 40;
/** Slippage cap on every order, basis points past the close decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** Closes so far, as floats in the bar's own price units (ratios are scale-free). */
const closes: number[] = [];
/** Batch seq at which the current position was opened (-1 while flat). */
let entrySeq = -1;

/** The simple moving average of the last SMA_BARS closes, or null before then. */
function sma(): number | null {
  if (closes.length < SMA_BARS) return null;
  let sum = 0;
  for (let i = closes.length - SMA_BARS; i < closes.length; i++) sum += closes[i]!;
  return sum / SMA_BARS;
}

/** Whether this close is the lowest of the last LOW_BARS closes (itself included). */
function isFreshLow(close: number): boolean {
  const from = Math.max(0, closes.length - LOW_BARS);
  for (let i = from; i < closes.length; i++) if (closes[i]! < close) return false;
  return true;
}

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[] }) {
    for (const bar of batch.bars) closes.push(Number(bar.c));
    if (state.warmingUp) return [];
    const held = state.positions.get('CBBTC');
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      const value = state.value('CBBTC', held.qty);
      const cost = held.cost;
      const heldBars = entrySeq < 0 ? 0 : state.seq - entrySeq;
      // Take profit: value at least (10000 + TAKE_PROFIT_BPS) / 10000 of cost.
      // Hard stop: value at most (10000 - STOP_BPS) / 10000 of cost.
      // Give up: a stale position in modest profit gets banked.
      if (
        value * 10000n >= cost * BigInt(10000 + TAKE_PROFIT_BPS) ||
        value * 10000n <= cost * BigInt(10000 - STOP_BPS) ||
        (heldBars >= GIVE_UP_BARS && value * 10000n >= cost * BigInt(10000 + GIVE_UP_PROFIT_BPS))
      ) {
        entrySeq = -1;
        orders.push({ side: 'sell', symbol: 'CBBTC', qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    // Flat: look for the capitulation.
    const mean = sma();
    if (mean === null) return orders;
    const close = closes[closes.length - 1]!;
    const dipBps = ((mean - close) / mean) * 10000;
    if (dipBps < DIP_BPS) return orders;
    if (!isFreshLow(close)) return orders;
    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return orders;
    entrySeq = state.seq;
    orders.push({ side: 'buy', symbol: 'CBBTC', notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
