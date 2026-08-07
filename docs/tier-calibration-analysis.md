# Pooled tier-level calibration, shrinkage, and a go-live readiness ranking

Status: **analysis and reusable infrastructure only. No `LEAGUE_CONFIG` values,
no real-money gating, and no live scoring logic were changed as part of this
document.**

## Zero Odds API credit spend — confirmed

Everything below is computed from data already on disk: `backfill-historical.json`
(the 18,392-fixture scored-fixture archive) and `closing-odds.json` (already-fetched
Pinnacle closing lines). No live Odds API call was made at any point in this task —
the diagnostic endpoint used to run the numbers (`/api/debug/tier-calibration`,
now removed) only ever called `readJSON()` against those two files, the same
pattern `runEvCalibration()` already uses for the weekly cron. Confirmed via
`/api/server-status`'s `apiQuotaUsedToday` figure, unchanged before and after
this work.

## Background

League-by-league backtesting keeps producing confidence intervals that span
zero — true even for the four leagues (Premier League, Ligue 1, Champions
League, Serie A) that now have a genuine, documented train/test split behind
them. The Pinnacle-matched population each league backtest depends on is just
too small (100-800 fixtures per league after odds-matching) to say much with
confidence.

The pure-calibration dataset — every scored fixture, matched-odds or not — is
16,099 fixtures across the 12 real leagues (18,392 total scored, minus 2,293
belonging to competitions outside `LEAGUE_CONFIG`, which are out of scope for
the same reason they've been excluded from every audit this week). It doesn't
need odds data, so it's far larger and lower-variance. It can't tell you ROI —
only whether the model's stated confidence matches reality — but that's a
real, usable signal on its own, and this task treats it as the primary one.

## Scope and exclusions

- **In scope:** the 12 leagues in `LEAGUE_CONFIG`, using every scored fixture
  in `backfill-historical.json` (not just Pinnacle-matched ones) for Phase 1's
  calibration tables.
- **World Cup (league 1) is excluded from every table below**, not just the
  ROI ones. It has **zero** fixtures anywhere in the pure-calibration
  population — every scored World Cup record is missing `homeFactors`/
  `awayFactors`/`actualOutcome` needed to run the live pipeline against it.
  This is a stronger version of the existing `CALIBRATION_AUDIT` note ("too
  few matched Pinnacle fixtures to compute a reportable ROI") — there isn't
  even a pure-calibration population to fall back on. Nothing to report; flagging
  it explicitly so its absence from every table isn't mistaken for an oversight.
- **The ~2,293 fixtures outside `LEAGUE_CONFIG`** (stray league IDs from
  earlier audits — 5, 10, 31, 32, 34, etc.) are excluded, matching the
  established pattern of only working with the 12 real leagues.

## Phase 1 — Pooled, tier-level calibration

### Decision flagged: bucket width and range

The task asked for 5pp-wide buckets from ~35% up to the observed ceiling,
"aligned" with `docs/confidence-ceiling-diagnostic.md`, which used 10pp bins
starting at 50% (50-60%, 60-70%, ...). Those two asks are slightly in tension
— 5pp bins starting at 35% aren't the same bins as 10pp starting at 50%. The
choice made here: **5pp bins at 35, 40, 45, 50, ..., 80%**, which are exact
halves of the diagnostic doc's 50/60/70/80/90 boundaries — add any two
adjacent 5pp bins from 50% up and you get back that doc's original 10pp bins
exactly, so the two are reconcilable by aggregation rather than identical
edges. The lower bound was extended to 35% (rather than 50%) because that's
where this task explicitly asked to start, and because a meaningful share of
fixtures live in 35-50% (most model outputs, in fact — see table below).

### Pooled tier table (all 12 leagues combined, full scored population)

| Tier | n | Mean predicted | Actual hit rate | Calibration error (pred − actual) |
|---|---|---|---|---|
| <35% | 7 | 34.6% | 28.6% | +6.1pp |
| 35-40% | 2,471 | 38.4% | 36.6% | +1.9pp |
| 40-45% | 4,408 | 42.4% | 42.9% | −0.5pp |
| 45-50% | 3,853 | 47.4% | 51.2% | −3.8pp |
| 50-55% | 2,334 | 52.3% | 56.9% | −4.6pp |
| 55-60% | 1,640 | 57.4% | 63.7% | −6.3pp |
| 60-65% | 1,099 | 62.2% | 74.3% | −12.1pp |
| 65-70% | 283 | 66.5% | 84.8% | −18.3pp |
| 70-75% | 4 | 70.9% | 100% | −29.1pp |
| 75-80%+ | 0 | — | — | — |

**Headline finding, worth calling out plainly: this is not the overconfidence
problem you'd normally expect from a probabilistic model.** It runs the other
way. Below ~45% the model is roughly well-calibrated (small, sub-2pp errors in
either direction). Above ~45% it becomes systematically *underconfident* —
the actual hit rate increasingly outruns the stated probability, and the gap
widens as confidence rises. At 60-65% (n=1,099, a genuinely large sample) the
model says 62% and reality delivers 74%. This dovetails with
`confidence-ceiling-diagnostic.md`'s finding that raw and bias-corrected
confidence both cap out near 79% — that ceiling means the model *structurally
cannot* express the confidence its 60-70%-band picks actually deserve. Above
65% sample sizes fall off a cliff (283, then 4), so treat that end of the
table as suggestive, not conclusive — but the 45-65% range has enough volume
(1,000-4,400 per tier) to trust the direction of this finding.

### Per-league-within-tier breakdown (raw, unshrunk)

Full per-cell data (11 leagues × 9 populated tiers, ~90 cells) is in the
endpoint output this doc was generated from; representative tiers below.
Deviation is each league's hit rate minus the pooled tier hit rate.

**35-40% tier (pooled hit rate 36.6%, pooled n=2,471):**

| League | n | Hit rate | Deviation |
|---|---|---|---|
| Premier League | 265 | 42.6% | +6.1pp |
| Ligue 1 | 319 | 39.5% | +2.9pp |
| Champions League | 68 | 35.3% | −1.3pp |
| Serie A | 414 | 35.8% | −0.8pp |
| La Liga | 323 | 30.7% | −5.9pp |
| Bundesliga | 211 | 34.1% | −2.5pp |
| Conference League | 118 | 33.1% | −3.5pp |
| (Eredivisie, Primeira Liga, Scottish Prem, Europa League — all within ±2pp) | | | |

**60-65% tier (pooled hit rate 74.3%, pooled n=1,099) — small per-league cells, exactly what Phase 2 addresses:**

| League | n | Hit rate | Deviation |
|---|---|---|---|
| Ligue 1 | 65 | 81.5% | +7.2pp |
| Primeira Liga | 114 | 80.7% | +6.4pp |
| Champions League | 100 | 76.0% | +1.7pp |
| Eredivisie | 139 | 77.0% | +2.6pp |
| Serie A | 101 | 72.3% | −2.1pp |
| Bundesliga | 115 | 72.2% | −2.2pp |
| La Liga | 122 | 73.0% | −1.4pp |
| Scottish Premiership | 95 | 69.5% | −4.9pp |
| Conference League | 82 | 69.5% | −4.8pp |
| Europa League | 34 | 64.7% | −9.6pp |

These per-league cells look like they're telling a story (Ligue 1 and Primeira
Liga "running hot," Europa League "running cold") but at n=34-139 per cell,
much of this spread is sampling noise rather than real per-league effects —
see the shrinkage results below for which of these deviations actually
survive.

### EV-backtest ROI, same tiers (secondary signal — smaller, noisier)

Pinnacle-matched fixtures only, restricted to positive-edge bets (≥5% edge,
same threshold `runEvCalibration()` uses), and — unlike Phase 1's calibration
table above — **restricted to test-only fixtures for the four leagues with a
validated split** (Premier League, Ligue 1, Champions League, Serie A), so no
ROI figure here is contaminated by tuning data. See "Decisions flagged" below
for why Phase 1's calibration table does *not* apply that same restriction.

| Tier | n | ROI |
|---|---|---|
| <35% | 4 | −9.8% |
| 35-40% | 680 | −14.9% |
| 40-45% | 1,139 | −5.9% |
| 45-50% | 841 | +5.8% |
| 50-55% | 484 | +3.6% |
| 55-60% | 280 | +16.4% |
| 60-65% | 113 | +46.2% |
| 65-70% | 11 | +16.8% |

Noisy, as expected, but the direction lines up with the calibration finding
above: ROI trends positive and rises through the higher-confidence tiers,
consistent with the model being underconfident there (a pick winning more
often than its stated probability implies is, by construction, a source of
positive edge against a market priced closer to the true rate). The 60-65%
tier's +46.2% is the most eye-catching number in this whole report and also
the one to trust least — n=113 pooled across leagues, no per-tier-per-league
breakdown of it survives contact with a reasonable sample-size bar.

## Phase 2 — Shrinkage utility

Implemented in [`shrinkage.js`](../shrinkage.js) as `empiricalBayesShrink()` —
a generic, reusable James-Stein-style estimator, not built specifically for
this task's data. Full derivation and reasoning is in that file's header
comment; short version:

```
shrunk_i = pooledMean + weight_i * (value_i - pooledMean)
weight_i = n_i / (n_i + k)
k = withinCellVariance / betweenCellVariance
```

`betweenCellVariance` is estimated from the cells themselves (method of
moments: observed spread of cell values, minus the sampling noise you'd see
even with zero real difference between cells), so `k` isn't hand-tuned per
tier or per dataset — it falls out of how noisy vs. genuinely-different that
specific group of cells turns out to be.

**Decision flagged:** `k` is computed independently *per tier* (and once more
for the league-level ROI figures), not pooled into one global constant across
the whole analysis. This means shrinkage strength varies tier to tier — see
below, `k` ranges from ~1.2 to ~9,195 across tiers in this data. That's the
intended behavior (each tier is arguably its own population of cells with its
own real vs. noise ratio) but it's worth naming as a choice rather than
letting it look accidental.

### Calibration deviations: raw vs. shrunk (selected tiers)

**55-60% tier (k=1,969 — between-league variance here is estimated as tiny, so shrinkage pulls hard):**

| League | n | Raw hit rate | Shrunk | Weight | Delta |
|---|---|---|---|---|---|
| Scottish Premiership | 97 | 52.6% | 63.2% | 0.047 | **+10.6pp** |
| Serie A | 182 | 68.1% | 64.1% | 0.085 | −4.0pp |
| Bundesliga | 166 | 67.5% | 64.0% | 0.078 | −3.5pp |
| La Liga | 201 | 59.2% | 63.3% | 0.093 | +4.1pp |
| (rest) | | | | 0.04-0.09 | within ±2.5pp |

At this tier almost every league gets pulled back to within a couple points
of the pooled 63.9% mean — the framework's read is that none of the apparent
per-league spread at 55-60% is trustworthy yet, including Scottish
Premiership's eye-catching 52.6% (which would otherwise look like a real,
concerning underperformance).

**65-70% tier (k=1.2 — between-league variance is estimated as large relative to noise, so real signal mostly survives):**

| League | n | Raw hit rate | Shrunk | Weight | Delta |
|---|---|---|---|---|---|
| Premier League | 22 | 90.9% | 90.6% | 0.949 | −0.3pp |
| Primeira Liga | 43 | 90.7% | 90.5% | 0.973 | −0.2pp |
| Scottish Premiership | 76 | 86.8% | 86.8% | 0.985 | ~0pp |
| Bundesliga | 21 | 66.7% | 67.6% | 0.946 | +1.0pp |
| Europa League | 1 | 0% | 46.1% | 0.456 | +46.1pp |

Same shrinkage function, opposite behavior — at this tier the cells that have
any real sample size (20+) keep almost all of their own signal (weights
0.95-0.99), because the between-league spread here is large enough to look
real rather than noise. Only the n=1 Europa League cell (a single fixture,
observed as a loss) gets meaningfully pulled toward the pooled mean, exactly
as it should.

### League-level EV-ROI: raw vs. shrunk

This is the clearest single result in the report, and it directly validates a
caveat `CALIBRATION_AUDIT` already carried in prose form:

| League | n (posEdge) | Raw ROI | Shrunk ROI | Weight | Delta |
|---|---|---|---|---|---|
| Champions League | 72 | **+35.8%** | **+0.6%** | 0.020 | **−35.2pp** |
| Scottish Premiership | 463 | +6.1% | +0.6% | 0.116 | −5.5pp |
| Serie A | 106 | −8.4% | −0.3% | 0.029 | +8.1pp |
| Eredivisie | 437 | −8.5% | −1.0% | 0.110 | +7.5pp |
| Bundesliga | 535 | +3.1% | +0.3% | 0.132 | −2.8pp |
| Premier League | 150 | −2.8% | −0.2% | 0.041 | +2.6pp |
| Primeira Liga | 575 | +2.2% | +0.2% | 0.140 | −2.0pp |
| La Liga | 736 | −4.6% | −0.9% | 0.173 | +3.8pp |
| Ligue 1 | 159 | +0.4% | −0.1% | 0.043 | −0.4pp |
| Europa League | 178 | −2.5% | −0.2% | 0.048 | +2.3pp |
| Conference League | 141 | +1.3% | 0.0% | 0.038 | −1.3pp |

`k=3,526` here — between-league ROI variance is estimated as small relative
to how noisy a single bet's outcome is (binary win/loss on real odds has high
variance by nature), so every league gets pulled hard toward the pooled mean.
Champions League's own audit note already called its +35.8% test-set ROI "a
hint worth re-checking... not a confirmed edge" because posEdgeN=72 was so far
below the rule-6 decision-grade floor — shrinkage arrives at the same
conclusion independently and quantitatively: with n=72 and this much
between-league noise, essentially none of that headline number should be
trusted as league-specific signal. **No league's shrunk ROI is
distinguishable from zero.** That's the honest state of this signal today —
not a reason to panic, just a reason not to rank leagues by raw ROI.

## Phase 3 — Combined go-live readiness ranking

**This is a reference table only. No gating logic reads from it, and it does
not change `paperTradeOnly`, Kelly fraction, or any other live setting.**

### Composite formula (fully shown, meant to be second-guessed)

```
composite = 0.50 × calibScore + 0.35 × roiScore + 0.15 × tradeScore
```

- **calibScore** (primary, large-sample signal): for each league, the
  n-weighted mean of `|shrunk calibration deviation|` across all its tiers,
  then min-max normalised across the 11 leagues so 1.0 = lowest deviation
  (best) and 0.0 = highest.
- **roiScore** (secondary, smaller-sample signal): each league's shrunk
  league-level ROI from the table above, min-max normalised across leagues so
  1.0 = highest shrunk ROI.
- **tradeScore** (mechanism only): `min(live paper-trade count, 20) / 20`.
  Paper trading has barely started, so this sits near zero everywhere today —
  it exists so the ranking naturally shifts as paper-trade evidence
  accumulates, not because it's discriminating between leagues yet.

Weights (0.50 / 0.35 / 0.15) are a judgment call, not derived from the data —
flagged below for review.

### Ranking

| Rank | League | Composite | calibScore | roiScore | tradeScore | Shrunk ROI | Paper trades | Calibration status |
|---|---|---|---|---|---|---|---|---|
| 1 | Scottish Premiership | 0.858 | 1.000 | 1.000 | 0.05 | +0.6% | 1 | tainted |
| 2 | Champions League | 0.819 | 0.938 | 1.000 | 0.00 | +0.6% | 0 | validated |
| 3 | Primeira Liga | 0.656 | 0.783 | 0.756 | 0.00 | +0.2% | 0 | tainted |
| 4 | Ligue 1 | 0.655 | 0.909 | 0.573 | 0.00 | −0.1% | 0 | validated |
| 5 | Bundesliga | 0.584 | 0.596 | 0.817 | 0.00 | +0.3% | 0 | tainted |
| 6 | Serie A | 0.555 | 0.819 | 0.415 | 0.00 | −0.3% | 0 | validated |
| 7 | Premier League | 0.536 | 0.726 | 0.494 | 0.00 | −0.2% | 0 | validated |
| 8 | Europa League | 0.514 | 0.686 | 0.488 | 0.00 | −0.2% | 0 | untested |
| 9 | La Liga | 0.346 | 0.631 | 0.085 | 0.00 | −0.9% | 0 | tainted |
| 10 | Eredivisie | 0.343 | 0.685 | 0.000 | 0.00 | −1.0% | 0 | tainted |
| 11 | Conference League | 0.207 | 0.000 | 0.591 | 0.00 | 0.0% | 0 | untested |

World Cup excluded (zero pure-calibration population — see Scope above).

**Read this table carefully, not literally.** Scottish Premiership and
Primeira Liga rank near the top on a *tainted* base-rate configuration
(fitted against the full population with no holdout) — their calibration
numbers could partly reflect overfitting to the exact data being measured
here, the same circularity the SPL case already confirmed once this week.
Champions League ranks #2 largely on calibScore despite the smallest,
least-tested backing (train posEdgeN=179, already below rule-6's floor) — its
shrunk ROI of +0.6% is genuinely uninformative (see Phase 2), it's just tied
with the pooled mean along with everyone else. The four *validated* leagues
(Ligue 1, Serie A, Premier League, Champions League) are the ones whose
calibration numbers can actually be trusted at face value; their composite
ranks (2nd, 4th, 6th, 7th) should be weighted more heavily than their
position alone suggests, precisely because they aren't inflated by
train/test circularity. This table intentionally doesn't correct for that —
doing so would mean quietly re-weighting by a `calibrationReliable` flag
inside "a simple, inspectable formula," which stops being simple. Flagged
here instead, for a human to weigh when reading the ranking rather than
baked into the score.

### Tier-level granularity: viable in 34 of ~90 cells

A (league, tier) cell was judged tier-level-viable at n≥200 (binomial standard
error ≤~3.5pp at p≈0.5 — tight enough to be informative). 34 cells clear that
bar, concentrated in the 35-55% tiers for the eight leagues with 1,500+ total
fixtures (Premier League, La Liga, Serie A, Ligue 1, Bundesliga, Eredivisie,
Primeira Liga, plus partial coverage for Champions League and Scottish
Premiership/Conference League in select tiers). Above 55% confidence, no
league has enough per-tier volume for tier-level granularity — every league
falls back to the league-level composite above for its higher-confidence
picks. This task did not build a full tier-level composite ranking on top of
the 34 viable cells (see decisions below) — the underlying shrunk figures are
in the endpoint output this doc was generated from, but turning them into a
second ranked table was judged to add more surface area than value tonight.

## Decisions made without asking — flagged for review

1. **Bucket width/range** (35-80% in 5pp steps, nesting inside the diagnostic
   doc's 10pp edges rather than matching them exactly) — see Phase 1 above.
2. **Phase 1's calibration population is NOT restricted to test-only
   fixtures** for the four validated leagues, unlike Phase 1.4/Phase 2/Phase
   3's ROI figures, which are. Reasoning: this is a descriptive read of
   current live calibration quality, not a new tuning cycle — nothing here is
   being fit or decided based on this data, so `calibration-rules.md`'s
   train/test-purity requirement (aimed at preventing tuning circularity)
   doesn't bind the same way. Restricting to test-only would have thrown away
   most of the data (e.g. Premier League would drop from 1,900 to ~570
   fixtures) for no protection against a decision that isn't being made. If
   this reasoning is wrong, the fix is mechanical — re-run with the same
   `VALIDATED_SPLITS` filter Phase 1.4 already uses.
3. **Tier-level viability threshold** (n≥200) is used only to flag which
   cells could support tier-level analysis, not built into a full nested
   composite ranking — see "Tier-level granularity" above.
4. **Composite weights** (0.50 calibration / 0.35 ROI / 0.15 paper-trade
   count) are a defensible-but-arbitrary starting point, not derived from the
   data. Easy to change — they're the three named constants in the endpoint
   code that generated this report (now removed; the same formula is
   documented above in full).
5. **Per-tier shrinkage constant** — `k` is estimated separately for each
   tier (and once more for league-level ROI) rather than pooled into one
   global value. See Phase 2.
6. **The "tainted calibration ranks well" tension in Phase 3** is surfaced in
   prose rather than corrected inside the composite formula, to keep the
   formula itself simple and inspectable. A human reading the ranking should
   apply the `calibrationReliable` flag as a mental filter, not treat rank
   order alone as a readiness signal.

## Cleanup

The temporary `/api/debug/tier-calibration` endpoint has been removed.
`shrinkage.js` is kept as permanent, reusable infrastructure — it has no
dependency on this specific dataset and is written to be called again for any
future shrinkage need (e.g. a later per-tier ROI cycle, or shrinking home/away
base-rate estimates directly).
