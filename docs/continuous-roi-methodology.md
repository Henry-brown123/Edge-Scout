# Continuous ROI — methodology and current status

**Status: stale, not currently displayed.** Continuous ROI was removed
from the Performance tab's tier×league grid (previously the 4th "C" row
alongside Historical/Live/Combined) because it had gone stale and was no
longer a useful day-to-day reading — see "Why it was removed" below. The
underlying data and calculation logic are untouched: `CONTINUOUS_LEAGUE_TIER_MATRIX`
and `CONTINUOUS_TIER_POOLED` in `server.js` are unchanged, and
`GET /api/league-tier-matrix` still returns them in full
(`continuousMatrix`, `continuousTierTotals` fields), along with
`hasContinuousMatrix` per league in `scope.leagues`. Nothing about this
task touched scoring, EV, or bet-triggering logic — display-only.

This doc exists so the reasoning behind Continuous ROI, and how to bring
it back to life if it's ever needed again, isn't lost along with its grid
row.

## What Continuous ROI measures

Every other ROI reading in this project (Historical, Live, Combined) is
filtered to `posEdge ≥ 5%` — the analytical proxy this project has always
used for "would this fixture actually become a recommended bet"
(`docs/tier-calibration-analysis.md` Addendum 14's Extension section spells
out why this is a proxy rather than the literal live gate — the real gate
is `successScore < settings.successThreshold`, a composite score the
historical calibration population doesn't carry enough fields to
reproduce offline).

**Continuous ROI drops that filter.** It's the same tier-binned ROI
calculation, run against every fixture with matched Pinnacle odds in the
holdout population, regardless of edge size — fixtures the model liked a
lot, fixtures it barely favoured, and fixtures on the wrong side of the
market entirely are all included. "Continuous" refers to using the whole
edge spectrum continuously rather than thresholding it into a binary
in/out decision.

## What question it was built to answer

Continuous ROI was built for **Addendum 14** (`docs/tier-calibration-analysis.md`)
to answer one specific question: **does the live EV threshold correctly
separate good bets from bad ones, or is it either (a) letting weak bets
through that it shouldn't, or (b) wrongly blocking good bets that would
have been profitable?**

Addendum 14 Part C computed Continuous ROI pooled by tier over the full
matched-odds holdout population (n=2,777). A follow-up extension to that
addendum ("Extension — cleared vs. blocked: is the threshold excluding
real value?") then split that same population into the fixtures that
*would* clear the edge≥5% threshold ("cleared") versus the ones that
*wouldn't* ("blocked"), and compared their ROI directly — this
cleared-vs-blocked split is the concrete worked example of what
Continuous ROI is for.

**The worked example: the 40-45% tier.** This was the one tier with
enough blocked-group volume (n=49) to say something real:

| Tier | Cleared (edge≥5%): n, ROI, 95% CI | Blocked (0%≤edge<5%): n, ROI, 95% CI |
|---|---|---|
| 40-45% | 312, −6.5%, [−23.0%, +10.1%] | 49, **−60.9%**, [−86.0%, −35.8%] |

Blocked bets at this tier didn't just underperform cleared bets — they
were catastrophic, with a 95% CI that excludes zero entirely. The
45-50% tier pointed the same direction (blocked n=51, ROI −27.8%, CI
upper bound +0.5%, nearly excluding zero). A further check on the
edge-size distribution *within* the blocked group (0-1%, 1-2%, 2-3%,
3-4%, 4-5% sub-bands) found returns negative across every sub-band and
volume spread roughly evenly across the full 0-5% range — not
concentrated near the 5% boundary the way it would be if the threshold
were only slightly too strict.

**Conclusion at the time**: no evidence the threshold was wrongly
excluding real value. Where there was enough volume to judge, blocked
bets performed as badly or worse than cleared bets in the same tier —
consistent with the threshold correctly filtering weak edges, not with a
too-conservative cutoff leaving money on the table. This was an evidenced
answer to a specific, real question, not a permanent verdict — the model,
population, and threshold have all moved on since.

## Why it was removed from the day-to-day grid

Continuous ROI is a **snapshot from a single point in time**, not a
live-refreshed reading:

- It's frozen on **Addendum 14's diagnostic proxy model**
  (`models/gbdt-train-proxy.js` → `gbdt-proxy-diagnostic.json`), a
  deliberately-blind model trained only on data before the holdout
  window — never the live model, and never retrained since.
- It's frozen on a **single fixed holdout window**, fixtures dated
  `≥ 2024-08-07`, evaluated once and never re-run.
- It was **never extended to competitions added after that point**:
  Carabao Cup, League One, League Two (added Addendum 15+), Europa
  League and Conference League (train/test splits added Addendum 20)
  all show `hasContinuousMatrix: false` — a permanent `n/a` in the grid
  for 5 of the 15 competitions now tracked, not a bug, just a reading
  that was never computed for them.

By the time the tier×league grid grew to its current scope (Historical
now sourced from either a real backtest or the Addendum 21 walk-forward
proxy, Live filtered to the current model version, Combined pooling
both), Continuous had become the one row that was neither current nor
complete — clutter rather than signal in the everyday view. Historical
and Live together already cover the "is there a confirmed edge" question
for day-to-day use; Continuous answers a narrower, different question
(is the *threshold itself* well-calibrated) that doesn't need re-asking
on every page load.

## How to recompute/refresh it if the question comes up again

Continuous ROI is not automated and was never meant to be — it's a
deliberate, occasional diagnostic, not a monitored metric. To refresh it:

1. **Get (or build) a genuinely out-of-sample model to score against.**
   The live model is retrained on essentially the whole population
   (see `docs/model-versioning.md`), so it has no untouched recent data
   to test against — this is exactly why Addendum 14 built a separate
   blind proxy model in the first place. Either train a fresh proxy the
   same way (`models/gbdt-train-proxy.js`, single-holdout mode — see
   `docs/tier-calibration-analysis.md` Addendum 21 for the walk-forward
   variant of the same script, if an expanding-window read is preferred
   over a single holdout), or use whatever the most recent deliberate
   holdout/proxy exercise produced.
2. **Score every fixture in the holdout window against matched Pinnacle
   odds, with no edge threshold** — the same `applyLeagueBiasCorrection()`
   treatment every other ROI reading in this project uses, just without
   the `edge < 0.05` filter Historical/Live/Combined apply.
3. **Bin by tier (5pp bands, `TIER_LABELS_SHARED`/`TIER_EDGES_SHARED`
   convention) and compute ROI per cell**, same normal-approximation CI
   method used throughout (`ciLow`/`ciHigh` via `1.96 × SE`).
4. **If re-asking the cleared-vs-blocked question specifically**: split
   the same scored population by `edge ≥ 0.05` vs `0 ≤ edge < 0.05` and
   compare ROI + CI between the two groups per tier, the same shape as
   Addendum 14's Extension. Check whether the CI excludes zero and
   whether returns are concentrated near the threshold boundary (would
   suggest miscalibration) or spread evenly across the sub-threshold
   range (as they were in the 2024-08-07+ window — no threshold-adjustment
   signal).
5. **Populate `CONTINUOUS_LEAGUE_TIER_MATRIX` / `CONTINUOUS_TIER_POOLED`**
   in `server.js` (or extend them — the existing structure already
   supports being widened to competitions it currently lacks) and, if the
   grid row is wanted back, restore the `_tpgFmtSub('C', ...)` calls in
   `public/index.html`'s `renderTierPerf()` that were removed alongside
   this doc (`git log` on that function around the Continuous-removal
   commit shows exactly what was taken out).
6. Follow `docs/calibration-rules.md` throughout — this remains a
   deliberate, single-look diagnostic, not something to iterate against
   until it gives a preferred answer.

## Where the data still lives

- `server.js`: `CONTINUOUS_LEAGUE_TIER_MATRIX` (per-league, per-tier cells)
  and `CONTINUOUS_TIER_POOLED` (pooled-by-tier), both unchanged.
- `GET /api/league-tier-matrix`: still returns `continuousMatrix`,
  `continuousTierTotals`, and `hasContinuousMatrix` per league in
  `scope.leagues` — fully queryable, just no longer rendered in the
  Performance tab grid.
- `docs/tier-calibration-analysis.md` Addendum 14 (Parts B/C/D) and its
  "Extension — cleared vs. blocked" section: the full original
  methodology, per-league grids, and the worked 40-45% finding, in
  complete detail.
