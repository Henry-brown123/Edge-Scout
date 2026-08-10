# House Rules: Per-League Model Calibration & Go-Live Validation

Purpose: produce ROI figures that are actually true, so real-money decisions
can be made as fast as possible without repeating the SPL false-positive
(where base rates and homeAdvBaseWeight were fit on the same 995 fixtures
used to report +5.91% ROI, with zero genuine holdout).

## 1. Train/test split is mandatory before any tuning begins, for every league.
Time-based split (not random shuffle), applied before touching base rates,
weights, or any parameter. No exceptions, including "just a quick check."

## 2. Tuning only ever touches the train portion.
Grid searches, base-rate fits, weight sweeps, feature changes — all evaluated
against train only. The test set does not exist yet as far as the tuning
process is concerned.

## 3. The test set gets looked at once, at the end, per tuning cycle.
Not iterated against. If test-set ROI disappoints, that's a real result to
act on (improve the model on train, then re-run a fresh split) — not a
target to nudge parameters against directly. Re-peeking at the same test
slice repeatedly turns it into training data by another name.

## 4. "Improving the model" means real improvements, not parameter search against the eval metric.
Legitimate: better features, more signal sources, fixing real bugs (e.g. the
BTTS key, the closing-odds endpoint path), cross-league structural
improvements. Not legitimate: sweeping a parameter until train-set ROI turns
positive with no underlying football reason to believe that value is
correct. If a change can't be explained in football terms ("this corrects
known home-advantage miscalibration"), be suspicious of it even if it
improves the number.

## 5. Every reported ROI figure includes n, posEdgeN, and a 95% CI — never a bare percentage.

## 6. Minimum sample-size bar before a backtest ROI is treated as meaningful.
Treat anything under ~300-400 posEdge bets as indicative only, not
decision-grade (SPL's CI still spanned zero at ~100-190 posEdge bets per
chunk). Flag explicitly when a league is below this bar rather than
presenting the number at face value.

## 7. Live dashboard numbers carry a `calibrationReliable` flag.
`true` only if the league has passed a clean train/test split with zero
fixture overlap between tuning and test populations. `false` triggers a
visible caveat in the UI, not just an internal note.

## 8. Backtest confidence is a pre-filter, not a replacement for the live paper-trade gate.
Even a league that clears clean backtest validation still needs to satisfy
MIN_LIVE_PAPER_TRADES before real money. A good backtest earns the right to
*start* paper trading with confidence — it doesn't skip live validation.

## 9. Every tuning commit documents its train/test boundary.
Commit message states the split date/method used, so it's auditable later.

## 10. A newly added league or competition's historical backfill is a future clean-test opportunity — don't spend it early.
The moment a new league's fixture history gets ingested, it's still unseen
by the live model (same status the 2010-2019 expansion fixtures had before
the big retrain). Preserve that: no calibration fit, base-rate tuning, or
ROI read against it until a deliberate, documented baseline pass is run —
the same shape as the retrain brief's Phase 1 (a genuine held-out read
before anything touches training). Folding it into calibration piecemeal,
or reading ROI off it "just to see," burns the one chance to test the
current model against real unseen data for that competition. Concretely,
for any newly added `LEAGUE_CONFIG` entry: leave `avgHomeWinRate`/
`avgDrawRate`/`avgAwayWinRate`/`avgGoalsPerGame` out entirely rather than
filling them with a plausible-sounding guess — those four feed a real
30%-live-blend in `applyLeagueBiasCorrection()` and a goals-market
baseline, not inert metadata, so an invented number is fabricated
calibration exactly as much as fitting one on contaminated data would be.
`marketEfficiency`/`drawBaseWeight`/`homeAdvBaseWeight` default to `1.0`
(a genuine no-op) until real evidence exists. First applied 2026-08-10 for
the Carabao Cup, League One, and League Two additions.
