// Dip-anchored mean reversion for cbBTC, long only, one position at a time.
//
// Idea: on a one-minute feed a full round trip costs roughly a quarter of a
// percent in fees, slippage and price impact, so the bot only trades moves
// that are several times that. It watches the trailing high of the last
// LOOKBACK closes; when the close sags DIP below that high it buys with the
// whole account (the harness caps a position at 100% of equity anyway), and
// it sells the whole position when the position is worth RISE more than its
// cost (the dip bounced) or STOP less than its cost (the dip was the start
// of a real fall, so cut it). After an exit it waits COOLDOWN bars before it
// may buy again, so a choppy slide cannot make it re-enter every few bars.
//
// Entry and exit tests are integer comparisons on the harness's own numbers
// (bar closes as integers, the position's value and cost in quote units), so
// two runs over the same bars send the same orders byte for byte. The exit
// test reads the position the account reports, so it tracks the price the
// buy actually filled at, impact included, not the close that decided it.

import { BPS, runBars, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Closes of history the trailing high is taken over (8 hours of 1m bars). */
const LOOKBACK = 480;
/** Buy when the close is this far under the trailing high: 8/1000 = 0.8%. */
const DIP_NUM = 992n;
const DIP_DEN = 1000n;
/** Sell when the position is worth this much over its cost: +0.8%. */
const RISE_NUM = 1008n;
/** Sell when the position is worth this much under its cost: -1.4%. */
const STOP_NUM = 986n;
const RATIO_DEN = 1000n;
/** Bars to sit out after an exit before another buy is allowed. */
const COOLDOWN = 30;
/** Slippage cap on every order, past the close it was decided on: 2%. */
const MAX_SLIPPAGE_BPS = 200;

const closes: bigint[] = [];
let barsSeen = 0;
let barsSinceExit = COOLDOWN;
let exitPending = false;

function trailingHigh(): bigint {
  let hi = 0n;
  const from = Math.max(0, closes.length - LOOKBACK);
  for (let i = from; i < closes.length; i++) {
    if (closes[i] > hi) hi = closes[i];
  }
  return hi;
}

await runBars({
  onBatch(state, batch) {
    let fresh: Bar | null = null;
    for (const bar of batch.bars) {
      closes.push(BigInt(bar.c));
      barsSeen++;
      fresh = bar;
    }
    if (state.warmingUp || fresh === null) return [];
    if (exitPending) {
      // The exit order was sent on the last batch; count from the fill,
      // which this batch's account already reflects if it landed.
      exitPending = false;
      barsSinceExit = 0;
    } else if (barsSinceExit < COOLDOWN) {
      barsSinceExit++;
    }

    const symbol = fresh.symbol;
    const held = state.positions.get(symbol);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      const value = state.value(symbol, held.qty);
      const cost = BigInt(held.cost);
      const takeProfit = value * RATIO_DEN >= cost * RISE_NUM;
      const stopLoss = value * RATIO_DEN <= cost * STOP_NUM;
      if (takeProfit || stopLoss) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        exitPending = true;
      }
      return orders;
    }

    if (barsSeen < LOOKBACK || barsSinceExit < COOLDOWN) return orders;
    const close = BigInt(fresh.c);
    const hi = trailingHigh();
    if (hi > 0n && close * DIP_DEN <= hi * DIP_NUM) {
      const { caps, fees } = state.hello;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let slice = state.cash < byWeight ? state.cash : byWeight;
      if (slice >= BigInt(fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    return orders;
  },
});
