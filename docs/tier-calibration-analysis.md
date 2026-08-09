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

**A reliability-aware second version of this table is in the Addendum below**
— the raw ranking above mixes validated and tainted-calibration leagues in a
way that's easy to misread at a glance; the addendum makes that distinction
impossible to skip past.

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

## Addendum — test-only recheck and reliability-aware ranking

Follow-up to judgment calls #2 and #6 above. Zero new Odds API calls here
either — same two data files, confirmed via `apiQuotaUsedToday` unchanged
across the run.

### Part A: does the underconfidence finding survive on test-only data?

Judgment call #2 used mixed (train+test) data for Phase 1's calibration
table, on the reasoning that nothing was being tuned so train/test purity
didn't bind. The concern worth re-checking directly: tuning the four
validated leagues' base rates *on train* to match observed outcomes could, in
principle, make train-slice calibration look artificially good, flattering
the mixed-population numbers and *understating* the true underconfidence
gap. This section re-runs Phase 1's exact tier bucketing restricted to each
league's held-out test fixtures only (`VALIDATED_SPLITS[leagueId].testFrom`
onward), and compares directly against the original mixed-population figures.

**Pooled across all four validated leagues, mixed vs. test-only (`*` = n<30, small-sample):**

| Tier | Mixed n | Mixed calib. error | Test-only n | Test-only calib. error |
|---|---|---|---|---|
| 35-40% | 1,066 | −0.2pp | 232 | +1.8pp |
| 40-45% | 1,813 | −0.9pp | 501 | +0.2pp |
| 45-50% | 1,626 | −5.0pp | 417 | **−10.5pp** |
| 50-55% | 1,004 | −3.6pp | 272 | −5.1pp |
| 55-60% | 662 | −8.4pp | 172 | −9.5pp |
| 60-65% | 398 | −13.5pp | 113 | −11.3pp |
| 65-70% | 44 | −27.2pp | 14* | −26.7pp |

**Verdict: the underconfidence pattern is robust on genuinely out-of-sample
data — it does not weaken, and at the highest-volume mid-tier (45-50%,
n=417 test-only, comfortably above any small-sample threshold) it's
*substantially stronger* on test-only data than on mixed** (−10.5pp vs
−4.98pp originally). 50-55% and 55-60% also come out slightly more
underconfident test-only. 60-65% and 65-70% land within a couple points of
the original mixed figures, same direction, same rough magnitude. Only the
two lowest tiers (35-40%, 40-45%) flip from slightly-underconfident to
slightly-overconfident on test-only — both are small flips (≤1.8pp) inside
what the original report already called "roughly well-calibrated" territory,
not a reversal of the finding.

The practical read: judgment call #2's choice to use mixed data was *not*
flattering the calibration numbers in the direction feared — if anything the
opposite, since the biggest, most trustworthy test-only cell (45-50%) shows a
bigger gap than the mixed figure did. The original headline finding stands
on its own without needing the mixed-population caveat to prop it up.

Per-league detail (all four leagues, all tiers, with small-sample flags) is
in the endpoint output this addendum was generated from; the pattern above
holds individually for Champions League, Ligue 1, and Serie A as well as
pooled — Premier League is the only one of the four where a couple of
mid-tiers (50-55%, 55-60%, 60-65%) actually show *less* underconfidence
test-only, though still in the same direction and comfortably within
plausible sampling noise at n=47-96 per cell.

### Part B: reliability-aware second ranking

**Chosen approach: filter, not down-weight.** A visible penalty term would
need its own magnitude to be chosen and defended (how much should
`calibrationReliable: false` cost a league?) — another arbitrary constant on
top of the three already in the formula. A filter needs no new parameter,
can't be second-guessed on magnitude, and answers the exact question this
follow-up asked ("how does the ranking look once tainted leagues are properly
discounted") directly: it removes them rather than approximating their
absence. The composite scores below are **identical** to the raw table above
— filtering, not recomputing — so the two tables are directly comparable.

| Rank | League | Composite | calibScore | roiScore | tradeScore |
|---|---|---|---|---|---|
| 1 | Champions League | 0.819 | 0.938 | 1.000 | 0.00 |
| 2 | Ligue 1 | 0.655 | 0.909 | 0.573 | 0.00 |
| 3 | Serie A | 0.555 | 0.819 | 0.415 | 0.00 |
| 4 | Premier League | 0.536 | 0.726 | 0.494 | 0.00 |

Side by side with the raw table: Scottish Premiership (1st raw), Primeira
Liga (3rd raw), and Bundesliga (5th raw) — three of the raw top five — drop
out entirely once restricted to validated calibration. Champions League was
already 2nd raw and becomes 1st; the other three validated leagues keep their
relative order (Ligue 1 > Serie A > Premier League) in both tables, since
filtering doesn't touch their scores or each other's relative position. The
practical takeaway: **among leagues whose calibration numbers can actually be
trusted today, Champions League and Ligue 1 lead — but both do so on
calibration quality (calibScore 0.94 and 0.91) while sitting near or below
average on ROI (1.00 driven by a shrunk ROI that's statistically
indistinguishable from zero per Phase 2, and 0.57 respectively), so "leads
the validated set" here means "least unproven," not "confirmed profitable."**
That distinction matters more than the rank order itself.

## Addendum 2 — Platt-scaling recalibration test: is the underconfidence exploitable?

Follow-up to the Addendum's Part A finding (underconfidence in the 45-70%
band holds and strengthens on test-only data) and to
[`confidence-ceiling-diagnostic.md`](confidence-ceiling-diagnostic.md)'s own
recommended next step ("characterize the Platt-scaling step directly... as
its own calibration cycle... single test look"). This is that cycle, run
under full `calibration-rules.md` discipline (rules 1-3, 5, 6, 9). Zero new
Odds API calls — confirmed via unchanged `apiQuotaUsedToday`.

**Scope:** the four leagues with a genuine `VALIDATED_SPLITS` boundary only —
Premier League (testFrom 2023-12-30), Ligue 1 (2023-11-03), Champions League
(2024-03-12), Serie A (2024-09-16) — same boundaries the base-rate tuning
cycle used, unchanged here. The correction is fit and applied only within
45-70% predicted probability (where the finding was established); outside
that band, nothing changes.

### Part A: the fit (train data only)

Platt scaling: `corrected = sigmoid(B + A * logit(raw))`, a 2-parameter
logistic regression with `y = 1{top pick correct}` and `x = logit(raw
probability)`, fit via Newton-Raphson on each league's train-portion fixtures
restricted to the 45-70% band (780/650/534/782 fixtures for PL/Ligue
1/CL/Serie A respectively — Champions League's 534 is the thinnest, expected
given its structurally smaller volume all week).

**Pooled vs. per-league, decided on train only:** compared via an internal
80/20 chronological split *within* train (never touches test) — fit each
candidate on the first 80%, score both on the same held-back 20% (n=550,
pooled across leagues) using log-loss.

| Candidate | Check-set log-loss |
|---|---|
| Pooled (one transform, all 4 leagues) | 0.6554 |
| Per-league (4 separate transforms) | 0.6561 |

Pooled wins, narrowly. The per-league fits (A: 1.55-2.07, B: 0.04-0.22
individually) aren't wildly different from each other either, which is the
football-side reason to trust pooling here as much as the log-loss margin: if
the four leagues needed meaningfully different corrections, per-league would
have won by more than a rounding difference, and Champions League's
particularly thin 534-fixture band population would be the most likely to
suffer from being forced into someone else's curve — it isn't. **Pooled was
chosen** and refit on the full train band (all 2,746 fixtures, no further
test peeking) for Part B:

```
corrected = sigmoid(0.1585 + 1.8313 * logit(raw))
```

| Raw | Corrected |
|---|---|
| 45% | ~44.8% (roughly unchanged) |
| 50% | ~54.0% (+4.0pp) |
| 55% | ~62.9% (+7.9pp) |
| 60% | ~71.1% (+11.1pp) |
| 65% | ~78.4% (+13.4pp) |
| 70% (edge) | ~84.7% (+14.7pp) |

**Flagged directly:** the band's population is heavily front-loaded (most
fixtures sit in 45-55%; the pooled test-band breakdown below shows n=417 at
45-50% vs. n=14 at 65-70%), so the curve is well-evidenced in the lower half
of the band and increasingly extrapolative toward 70% — the +14.7pp
correction at the top edge rests on far less data than the +4-8pp corrections
in the middle, and briefly pushes corrected probabilities above the model's
own ~79% structural ceiling from `confidence-ceiling-diagnostic.md`, which
that raw ceiling was never designed to produce. Worth remembering when
reading the 65-70% row below.

### Part B: single test-set look — calibration

Same tiers, test-portion fixtures only, before (raw) vs. after (corrected):

| Tier | n | Before error | After error |
|---|---|---|---|
| 45-50% | 417 | −10.5pp | −8.6pp |
| 50-55% | 272 | −5.1pp | **+0.7pp** |
| 55-60% | 172 | −9.5pp | **+0.0pp** |
| 60-65% | 113 | −11.3pp | **+0.9pp** |
| 65-70% | 14 | −26.7pp | −12.9pp |

**Calibration improves substantially and consistently.** The middle of the
band (50-65%, n=113-272 per tier) goes from meaningfully underconfident to
essentially perfectly calibrated. The two edges improve but don't fully
close — 45-50% roughly halves its error (−10.5pp → −8.6pp), 65-70% also
roughly halves (−26.7pp → −12.9pp, though n=14 keeps this reading noisy
regardless). This is exactly what a global logistic fit predicts: best in
the densely-populated middle, weakest at the sparser edges, consistent with
the extrapolation caveat above rather than a flaw specific to this fit.

### Part B: single test-set look — EV-backtest ROI, same fixtures

| League | Before: n / posEdgeN / ROI / 95% CI | After: n / posEdgeN / ROI / 95% CI |
|---|---|---|
| Premier League | 356 / 69 / +21.3% / [−28.0%, +70.6%] | 356 / 108 / +2.7% / [−30.6%, +36.1%] |
| Ligue 1 | 282 / 58 / +11.3% / [−20.0%, +42.7%] | 282 / 89 / +12.2% / [−10.8%, +35.1%] |
| Champions League | 124 / 38 / +16.6% / [−29.5%, +62.7%] | 124 / 54 / +17.0% / [−17.4%, +51.4%] |
| Serie A | 167 / 38 / +21.8% / [−15.9%, +59.6%] | 167 / 61 / +11.5% / [−15.5%, +38.5%] |
| **POOLED** | 929 / 203 / +17.7% / [−4.2%, +39.6%] | 929 / **312** / **+9.6%** / [−5.8%, +25.0%] |

All posEdgeN figures are below the ~300-400 decision-grade floor (rule 6)
**except the pooled after-correction figure, which crosses it for the first
time (312)** — and its CI still spans zero. Every other cell, before and
after, is indicative-only by rule 6's own bar; none of the before/after
comparisons above should be read as more than directional.

**Mechanism, stated plainly:** correcting the probabilities upward doesn't
just re-price the *same* bets — it pulls new fixtures over the 5%-edge
threshold that didn't qualify before (pooled posEdgeN rises from 203 to 312,
a +54% increase in bet volume). The realized ROI drop (pooled +17.7% →
+9.6%, Premier League +21.3% → +2.7%, Serie A +21.8% → +11.5%) is consistent
with those newly-included bets performing worse on average than the original
set — plausible given they're drawn from exactly the part of the probability
range (nearer the edges of the band) where the correction is least
well-evidenced. Ligue 1 and Champions League are roughly flat either way.

### Verdict

**The underconfidence is real and correctable — calibration error in the
50-65% core of the band goes from meaningfully wrong to essentially exact.
But correcting it does not translate into improved, or even confirmed,
betting performance.** Pooled ROI drops by nearly half once the correction
is applied, and even the enlarged, now-decision-grade-by-volume sample still
produces a confidence interval that spans zero. Two of four leagues (Premier
League, Serie A) show a clear ROI decline; the other two (Ligue 1, Champions
League) are roughly neutral. Nowhere does correcting this improve ROI with
anything resembling statistical confidence. This is the "observable but not
exploitable" outcome flagged as a live possibility going in — confirmed here,
not assumed.

**Per rule 3, this is the single test-set look for this cycle. No refitting
was done in response to these numbers** — a disappointing Part B result is
reported as the finding, not treated as a cue to adjust the band, the
pooled/per-league choice, or the fit method and re-run.

### Decision flagged

The 45-70% band and 5pp calibration tiers were carried over unchanged from
the existing addendum rather than re-optimised for this exercise, so results
here are directly comparable to it. Whether a narrower band (e.g. 50-65%,
where the fit is best-evidenced and calibration ends up near-perfect) would
change the ROI verdict was not tested — doing so now would be a second look
at test data under a changed definition, which rule 3 rules out for this
cycle. If this is worth pursuing, it needs a fresh train/test cycle with the
narrower band decided in advance, not a re-slice of today's test result.

### Extension: is the ROI drag spread evenly, or concentrated?

**This is not a new rule-3 test-set look.** It reuses the exact
already-chosen pooled parameters above (`A=1.83126, B=0.15854`, decided and
fixed in Part A) against the identical test-set population from Part B —
just disaggregated by tier instead of pooled, plus a split of which bets
were already positive-edge before correction vs. newly pulled over the
threshold by it. No refitting, no new correction, nothing that could count as
a second look informing a new decision. Confirmed the underlying per-bet
results didn't need to come from a stored artifact — they're fully
reproducible on demand from the same deterministic inputs (same fixtures,
same fixed parameters), so no new fitting was at risk here either way. Pooled
totals below sum exactly to Part B's reported figures (before posEdgeN
111+55+31+5+1=203, after 125+92+63+31+1=312), confirming this is the same
result, just split finer.

| Tier | Total matched | Before posEdgeN / ROI / 95% CI | After posEdgeN / ROI / 95% CI | Newly-qualified n / ROI |
|---|---|---|---|---|
| 45-50% | 386 | 111 / **+30.2%** / [+1.5%, +58.9%] | 125 / +27.3% / [+1.1%, +53.5%] | 14 / +4.2% |
| 50-55% | 259 | 55* / −24.1% / [−55.2%, +7.0%] | 92 / −15.9% / [−38.2%, +6.4%] | 37 / −3.7% |
| 55-60% | 165 | 31* / +63.6% / [−15.2%, +142.5%] | 63* / +26.8% / [−15.6%, +69.1%] | 32 / **−9.0%** |
| 60-65% | 105 | 5* / −100%† | 31* / −23.5% / [−50.1%, +3.1%] | 26 / **−8.8%** |
| 65-70% | 14 | 1* / +88%† | 1* / +88%† | 0 / — |

`*` below the proportional decision-grade floor (rule 6's ~300-400 whole-cycle
bar, scaled to ~60 per tier for five tiers — indicative only, not a
confirmed result). `†` n≤5, a coin-flip-sized sample; the "CI" collapses to a
point because every bet in it happened to land the same way, not because the
result is precise. **droppedOutN is 0 in every tier** — a direct structural
consequence of `A>1, B>0`: correction only ever raises probability inside
this band, so it can add bets to the positive-edge set but never remove one
already there. That means "after" ROI in every tier is exactly the volume-
weighted blend of "before" ROI (on the unchanged original bets) and
"newly-qualified" ROI (on the new ones) — nothing is being replaced, only
added.

**The drag is concentrated, not spread evenly, and it's concentrated exactly
where Part B's mechanism hypothesis predicted.** The newly-qualified cohort
loses money or is roughly break-even in every tier that has one (+4.2%,
−3.7%, **−9.0%**, **−8.8%**), while 45-50% — the tier with by far the
most volume (111-125 posEdge, the only cells anywhere in this exercise, before
or after, whose CI excludes zero) — is barely touched by the correction at
all (+30.2% → +27.3%, still solidly positive both ways). The pooled
after-figure's drop from +17.7% to +9.6% isn't a uniform erosion of a real
edge; it's the 45-50% tier's genuine, well-evidenced edge getting diluted by
three tiers of newly-added bets (50-65%) that individually never manage a
positive newly-qualified return. 55-60% and 60-65% additionally show their
*already-qualified* bets doing well too (+63.6%, though n=31) or terribly
(−100%, n=5) — both too thin to trust either way — but the newly-qualified
numbers next to them are the most consistent finding on this page: three
independent tiers, all negative or flat, all pointing the same direction.

**Practical read:** if this correction were ever revisited, 45-50% is the
one part of the band where the underlying evidence (both calibration and
ROI) is strong and consistent enough to take seriously on its own — and it's
exactly the tier the Platt correction changes least. The 50-70% range is
where the correction does its work on calibration (Part B) and where it also
adds all of its unprofitable new exposure — the two effects living in the
same place is the clearest single reason the pooled ROI result came out
negative-to-flat rather than positive.

## Addendum 3 — What "Score" is (and isn't), and live tier-tracking in the bet log

Triggered by a legitimate reconciliation question: the bet log's "Score"
field (e.g. Celtic vs Dundee: 87, France vs England: 57) doesn't obviously
match raw predicted probability, and an 87 looked hard to square with this
whole document's confirmed ~79% ceiling on raw model output. This addendum
answers that plainly and adds the tier-tracking this document's findings need
to actually be usable against live bets. No scoring logic, EV calculation, or
bet-triggering threshold was touched — display/reporting only. Zero new Odds
API calls.

### Part A: what Score actually is

**Score is not a probability, and was never meant to be one.** It's a
composite 0-99 "success score," `computeSuccessScore()` in
[`scoring.js:422`](../scoring.js), built from three weighted components:

```
winComp        = calibratedProb × 35                              (max 35)
valueComp      = min(edge / 0.20, 1) × 45                          (max 45)
confidenceComp = min(formFixtureCount / 50, 1) × 19                (max 19)
raw            = min(99, round(winComp + valueComp + confidenceComp))
base           = round(raw × (0.4 + dataConf × 0.6))
score          = base, then a league-specific edge cap (halved if
                 edge≥20pp and not Premier League), then — for
                 international fixtures only — a divergence penalty
                 (up to −75% if model and market disagree by 20pp+)
                 then × weather modifier × (1/market efficiency), rounded
```

Three things worth being explicit about:
- **`calibratedProb` is not `modelProb`.** Before Score is computed, the raw
  model probability is scaled by `settings.calibrationFactor` (currently
  ~1.11, capped at 0.97) — a pre-existing, simpler cousin of exactly the
  underconfidence correction this document's Addendum 2 tested far more
  rigorously via Platt scaling. `modelProb`, as stored on every bet, is the
  **un**calibrated raw value — that's the one this document's tier work is
  built on.
- **`edge` inside Score is edge against the single displayed book's own
  odds** (`calibratedProb − 1/bookOdds`), not the Pinnacle-margin-stripped
  edge shown as the bet's `edge` field (that one benchmarks against a
  de-vigged sharper price, so it reads differently — the two are related but
  not interchangeable).
- **Market efficiency and weather push Score well outside probability
  range.** Scottish Premiership's `marketEfficiency: 0.78` means every
  Scottish Prem score gets multiplied by `1/0.78 ≈ 1.28×` at the end — a
  meaningful reason Score can land well above what raw probability alone
  would suggest.

**Confirmed: Score is a composite, not a probability or a transform of one
value.** It mixes probability, edge size, sample confidence, league-specific
market-efficiency assumptions, and (for internationals) a divergence
penalty — five inputs, not one.

### Reconciling the two examples

| | Celtic vs Dundee | France vs England |
|---|---|---|
| `modelProb` (raw, stored) | 83.6% | 35.8% |
| `calibratedProb` (×1.11, derived) | 92.8% | 39.8% (edge derivation) |
| `bookOdds` | 1.17 | 4.20 |
| Internal edge (vs 1/bookOdds) | 7.3pp | 15.9pp |
| League | Scottish Prem (efficiency 0.78 → ×1.28) | World Cup (efficiency 0.94 → ×1.06, **and** international divergence penalty band) |
| **Reproduced Score** (formCount=50, dataConf=1) | **87 — exact match** | 37-39 (formula logic checks out; can't recompute the historical dataConf/formFixtureCount/formula-version exactly — see below) |
| **Actual stored Score** | 87 | 57 |

Celtic reproduces exactly once the formula is run with plausible inputs —
confirms the mechanism completely: a modest 7.3pp edge plus Scottish
Premiership's large 1.28× market-efficiency multiplier is enough to turn an
83.6% raw probability into an 87 score, no contradiction with the ~79%
ceiling anywhere (Score was never bound by it). France vs England's
mechanism also checks out directionally (a near-cap 15.9pp edge drives most
of the score) but doesn't reproduce to the exact stored 57 — the most likely
reason is that `computeSuccessScore`'s edge-cap and international-divergence
penalty (both cite specific findings in their own code comments, i.e. added
*after* observing results) may not have existed yet when this bet locked on
2026-07-18, and `dataConf`/`formFixtureCount`/the exact `calibrationFactor`
at lock time aren't persisted per bet, so a historical Score can't always be
recomputed byte-for-byte from today's code. **This is not a bug** — every
component traces to real, identifiable formula logic; the gap is a formula
version/missing-historical-input limitation, not an unexplained number.

**One genuine, separate finding surfaced by this reconciliation, flagged
directly:** Celtic's raw `modelProb` (83.6%) exceeds this document's
confirmed ~79% ceiling on raw GBDT+bias-correction output. Reason: live bets
run through `applyTeamProfileModifiers()` (team-profile, weather, WOWY,
transfer adjustments) *after* the GBDT+bias-correction step that every tier
figure in this document is measured on — the historical backfill population
this whole analysis uses does not include those live-only modifiers. So
`modelProb` on a live bet and the "raw predicted probability" this document's
tiers are built from are the *same underlying concept* but not always the
exact *same computation* — live modelProb can occasionally sit slightly
outside the population this document characterized. Worth knowing when
reading tier badges on live bets; not worth re-deriving the whole analysis
over, since the gap is a handful of extra live-only adjustment factors, not a
different model.

**Does "Score" need renaming?** Not urgently — nothing here is broken, and
the field has a real, defensible purpose (a single at-a-glance number
blending probability, edge, and confidence for bet-log scanning). But calling
it just "Score" next to a raw probability invites exactly the confusion that
prompted this task. Cheapest fix, applied now: the column header reads
"Score / Prob / Tier" and the cell shows the raw probability directly beneath
the Score badge, so the two numbers are never mistaken for each other again.
Renaming the underlying field/variable throughout the codebase is a larger,
lower-value change — flagged for later, not done here.

### Part B: tier badge, live in the bet log

Added to all three bet-log tables (paper, real, combined) in
[`public/index.html`](../public/index.html):
- The raw `modelProb` (already stored on every bet — no backend or data
  schema change needed) now displays as a percentage directly under the
  Score badge.
- A tier badge (e.g. `45-50%`) sits next to it, computed client-side by
  `tierOfProb()` using the exact same 5pp edges as this document
  (`[0.35, 0.40, ..., 0.80]`, with `<35%` and `80%+` catch-alls).
- CSV export (`exportCSV()`) gained `ModelProb%` and `Tier` columns
  alongside the existing `Score` column.

**Applies automatically going forward** — `tierOfProb()` runs at render time
against whatever `modelProb` is already on the bet object, so every new
paper/real bet gets a tier badge with no extra logging step.

**Backfill: not needed, because it already works.** Every bet already
carries `modelProb` from lock time (`bet.modelProb: best.modelProb` in
`server.js`'s bet-creation code) — confirmed directly against both example
bets pulled from production (`/api/bets`). Since tier is computed at
render/export time from that already-stored value rather than written once
and cached, every existing resolved bet gets a correct tier label immediately
on next page load, with zero migration script or one-time backfill job
required.

**Verification note:** the rendering logic (`tierOfProb`/`tierBadge`) was
unit-verified against both real production values (Celtic 83.6% → `80%+`,
France v England 35.8% → `35-40%`, both correct) and the full inline script
block parses cleanly with no syntax errors. Full interactive browser
verification (logging into the actual dashboard and visually confirming the
rendered row) was **not completed** — the local dev server requires
`APP_PASSWORD`, which isn't available in this environment, and the sandboxed
preview browser couldn't authenticate to the deployed instance either
(session-cookie login, distinct from the `x-api-key` used for this week's
API-only diagnostic work). Recommend a quick visual check on the live
dashboard after deploy.

## Addendum 4 — Live-vs-historical tier tracker, shipped in the UI

This document's per-tier ROI findings are now wired into the product itself,
not just this file. Display/reporting only — no scoring, EV, or
bet-triggering logic changed; no gating added. Zero new Odds API calls.

**Performance tab:** a new "Calibration Tier Performance" table (all three
views — paper, real, combined) shows, per tier, the historical baseline next
to live ROI computed in real time from resolved bets. The historical column
is Addendum 2's raw/uncorrected "Before" figures — not the Platt-corrected
"After" ones, since that correction was never deployed live and every bet is
still scored on raw `modelProb`. Both columns are restricted to the four
validated leagues (PL, Ligue 1, Champions League, Serie A); other leagues'
tier activity is listed separately underneath, never blended in. Status per
row is descriptive only — Tracking (live n below 10, the same
`MIN_LIVE_PAPER_TRADES` threshold the codebase already uses elsewhere for
"enough live evidence"), Consistent (live ROI same sign as historical),
Diverging (opposite sign), or No baseline (tier outside the 45-70% range
Addendum 2 covers). Updates automatically on every Performance-tab refresh —
no manual step.

**Scout page:** every recommended and watching bet now shows its tier badge
plus a compact reference line (e.g. "Historical: +30.2% (n=111) · Live:
+27.3% (n=125, thin)") at the point a bet is presented — informational only,
visible before any placement decision, filtering nothing. For non-validated
leagues or out-of-range tiers, the line says so explicitly ("no historical
baseline...") rather than showing a blank or borrowing a number from an
unrelated league.

**Where a bet genuinely has no historical reference, by design:**
- Any bet in a league outside {PL, Ligue 1, Champions League, Serie A} — no
  train/test split exists yet for those leagues' base rates, so no baseline
  is claimed for them at all.
- Any bet in one of those four leagues but outside the 45-70% tier range
  (e.g. Celtic vs Dundee's 83.6% modelProb, France vs England's 35.8% —
  both from the previous task's reconciliation, both outside this range) —
  Addendum 2 only ever tested that band.
Both cases render a clear "no baseline" message rather than silently
omitting context or fabricating one.

**Verification:** the tier-grouping and verdict logic was unit-tested
locally against synthetic bet data (including the real Celtic vs
Dundee/France vs England records) before deploy — correctly routes
non-validated-league bets to the separate "other leagues" line, correctly
flags thin cells, correctly computes stake-weighted live ROI. Full
interactive browser verification carries the same limitation noted in
Addendum 3 (no `APP_PASSWORD` available in this environment) — recommend a
visual check on the live dashboard after deploy.

## Addendum 5 — Five more leagues validated, tier baseline widened to the full range

Triggered by the tier tracker (Addendum 4) reporting zero populated
comparisons — every live bet fell in a league without a validated split, or
a tier outside Addendum 2's 45-70% scope. This addendum closes both gaps:
new train/test cycles for the remaining active leagues, and a widened tier
baseline covering the full observed probability range. Follows
`calibration-rules.md` rules 1-3, 5, 6, 9 throughout — same discipline as
the original four leagues, no shortcuts. Zero new Odds API calls (confirmed
via unchanged `apiQuotaUsedToday` across the whole cycle).

### Part A: five new validated leagues

Chronological 70/30 split by fixture count (consistent, mechanical rule
applied identically to all five — no per-league judgment calls that could
smuggle in test-set peeking). Base-rate correction decided from **train data
only**, before any test-set look: for each of home/draw/away rate, if the
train-observed frequency differs from the current config by ≥2pp (the same
magnitude of correction PL and Ligue 1 got earlier this week), the config is
updated to match train reality. This is a mechanical, pre-committed rule, not
chosen after seeing results.

| League | Train n / Test n | Split date | Adjustment | Test ROI (posEdgeN) | 95% CI | Decision-grade? |
|---|---|---|---|---|---|---|
| Scottish Premiership | 820 / 352 | 2024-01-02 | Home −3.05pp, Draw +2.28pp | −0.5% (126) | [−23.5%, +22.5%] | No |
| Bundesliga | 1,077 / 462 | 2024-01-20 | None (train matched config within 2pp) | −20.2% (138) | [−41.3%, +1.0%] | No — closest of any league to excluding zero |
| La Liga | 1,330 / 570 | 2024-01-12 | None | −9.6% (196) | [−30.8%, +11.6%] | No |
| Eredivisie | 1,115 / 478 | 2024-01-21 | Away +2.54pp | −17.9% (115) | [−43.3%, +7.6%] | No |
| Primeira Liga | 1,077 / 462 | 2024-01-18 | Away +5.77pp (largest correction this cycle) | +5.5% (143) | [−34.9%, +46.0%] | No |

**All five are now `calibrationReliable: true`, `status: 'validated'`** in
`CALIBRATION_AUDIT` (commit `ee97ca6`). None show a decision-grade or
statistically confirmed edge — same honest pattern as PL/Ligue 1/Champions
League: genuine validation resolves the *methodology* question, it doesn't
manufacture an edge that isn't there. Scottish Premiership's split is the one
that specifically resolves this week's earlier-confirmed circularity
finding (base rates had been fit against the exact population used to report
ROI) — it's now a clean, held-out result.

**Decision flagged:** `homeAdvBaseWeight` for Bundesliga and La Liga (both
previously tuned against the full population — the exact overfitting pattern
this whole week's work exists to close) was deliberately left untouched this
cycle. This cycle's mechanical rule only ever corrects the three win/draw/
away rate fields; touching a differently-shaped parameter like
`homeAdvBaseWeight` under the same 2pp-style rule would need its own
football-reasoned methodology, not a rushed extension of this one. Both
leagues are marked `validated` for their base rates specifically, with the
`homeAdvBaseWeight` caveat spelled out in their `CALIBRATION_AUDIT` note —
flagged for a dedicated follow-up cycle, not silently left inconsistent.

**World Cup: deliberately not attempted.** Confirmed in this document's own
Scope section — zero pure-calibration population (every WC scored record is
missing the fields needed to run the live pipeline against it) — and the
tournament has concluded, so no further data will ever accumulate. Leaving
it untested is the documented, correct decision, not an oversight.

### Part B: tier baseline widened to the full range

Same methodology as Addendum 2's "Before" (raw, uncorrected) figures, now
pooled across **all nine** validated leagues, test-only fixtures per each
league's own boundary above, across the **full** observed range rather than
just 45-70%.

**Calibration (pooled, test-only, 9 leagues):**

| Tier | n | Mean predicted | Hit rate | Calibration error |
|---|---|---|---|---|
| 35-40% | 589 | 38.5% | 33.1% | +5.4pp |
| 40-45% | 1,141 | 42.5% | 41.1% | +1.4pp |
| 45-50% | 956 | 47.5% | 54.2% | −6.7pp |
| 50-55% | 611 | 52.2% | 59.4% | −7.2pp |
| 55-60% | 380 | 57.4% | 64.5% | −7.1pp |
| 60-65% | 279 | 62.3% | 74.9% | −12.6pp |
| 65-70% | 93 | 66.4% | 87.1% | −20.7pp |

No test-only fixture across any of the nine validated leagues reaches 70%
raw probability — 70-75%/75-80%/80%+ are all empty here (they had a handful
of entries in the original *mixed* population from Phase 1, but none survive
once restricted to test-only). The underconfidence pattern from the
Addendum's Part A holds up again, now on a larger, cleaner, fully
out-of-sample population spanning nine leagues instead of four — if
anything this is the most credible version of the finding produced all
week.

**ROI (pooled, test-only, 9 leagues, posEdge ≥5%):**

| Tier | n | ROI | 95% CI | Decision-grade? |
|---|---|---|---|---|
| <35% | 1 | +261% | — | No (n=1, meaningless) |
| 35-40% | 249 | −13.4% | [−33.6%, +6.8%] | No |
| **40-45%** | **430** | **−21.5%** | **[−34.4%, −8.6%]** | **Yes — CI excludes zero** |
| 45-50% | 269 | +4.4% | [−12.8%, +21.5%] | No |
| 50-55% | 155 | +1.8% | [−17.3%, +20.9%] | No |
| 55-60% | 72 | +28.6% | [−10.5%, +67.7%] | No |
| 60-65% | 26 | +151% | [−40.0%, +342%] | No — extreme outlier, n=26 |
| 65-70% | 4 | +81.8% | [+73.4%, +90.1%] | No (n=4) |

**This is the single most important number produced by any tier-calibration
work this week: the 40-45% tier is the first result all week to be both
decision-grade by volume (n=430, comfortably above rule 6's ~300-400 floor)
and statistically confirmed (95% CI entirely below zero).** Pooled across
nine leagues and a genuinely held-out test period, bets in this specific
raw-probability tier have reliably lost money. This is a real, actionable
finding — the honest reading is "avoid this tier," not "wait for more data."
Every other tier remains indicative-only (below the decision-grade floor) or
is an obvious small-sample artifact (60-65%'s +151% on n=26 should not be
read as signal).

This table is now the live baseline behind `/api/tier-performance`'s
`HISTORICAL_TIER_BASELINE` — see Addendum 4 for the endpoint and UI this
feeds.

### Part C: tracker re-verified against real production data

`TIER_PERF_VALIDATED_LEAGUES` in `/api/tier-performance` was updated from
the original four league IDs to all nine. Spot-checked against the live
endpoint post-deploy (same approach as Addendum 4's verification): all eight
populated historical tiers render correctly, and the endpoint's
`otherLeagueActivity` list correctly still isolates any bet in a
non-validated league. As of this check, real production bet volume remains
too low to populate the *live* side of the comparison yet — see "Still
outstanding" below.

### Still outstanding

- **`homeAdvBaseWeight` for Bundesliga and La Liga** remains tuned against
  the full population with no holdout — flagged above, needs its own
  dedicated cycle with a football-reasoned methodology, not a rushed
  extension of this week's rate-only rule.
- **Live-side population is still empty.** All nine leagues and the full
  tier range now have a historical baseline, but as of this check none of
  the real bets logged so far land in a validated league within a populated
  tier — the tracker's live column will start filling in as paper/real
  trading continues, not from anything left undone here.
- **The 40-45% decision-grade negative finding has not been acted on
  anywhere.** No config, gating, or bet-triggering change was made in
  response to it — per this task's constraints, this stays analysis and
  display infrastructure. Surfacing it clearly (here, and in the tracker's
  baseline) is the deliverable; deciding what to do about it is a separate,
  explicit decision for later.
- **Scottish Premiership, Bundesliga, La Liga, Eredivisie, and Primeira
  Liga's ROI results are all indicative-only** (below the rule-6 floor) —
  none should be read as confirmed edges in either direction, same caveat
  as the original four leagues carried all week.

## Addendum 6 — League × tier matrix: is the 40-45% finding broad or concentrated?

A complementary view to Addendum 4's live-vs-historical tracker: instead of
one pooled figure per tier, this crosses every validated league against
every tier so a pattern that's broad (a whole tier bad everywhere) or
narrow (one league dragging a pooled average) is visible directly, rather
than needing to be inferred. **Explicitly a reference/diagnostic table, not
a gate** — same principle as everything else built this week.

**No fresh backtest computation was needed for the underlying population** —
same test-only, posEdge≥5%, 5pp-tier methodology as Addenda 2 and 5, just
aggregated per (league, tier) instead of pooled. Zero new Odds API calls
(confirmed via unchanged `apiQuotaUsedToday`).

### The grid (raw ROI% (n), thin cells marked *)

| League | 35-40% | 40-45% | 45-50% | 50-55% | 55-60% | 60-65% |
|---|---|---|---|---|---|---|
| Champions League | +134%(7)* | +37%(27)* | +22%(15)* | +27%(13)* | +35%(7)* | −100%(3)* |
| Premier League | −65%(22)* | −8%(59) | +33%(41) | −51%(18)* | +129%(8)* | −100%(1)* |
| Ligue 1 | +15%(44) | −28%(56) | +35%(37) | −79%(10)* | +15%(11)* | — |
| Bundesliga | −33%(26)* | **−36%(51)** | −17%(39) | +45%(14)* | −10%(7)* | +76%(2)* |
| Eredivisie | +12%(19)* | −34%(45) | +14%(31) | −71%(15)* | −21%(5)* | — |
| Primeira Liga | +3%(36) | −30%(52) | −72%(27)* | +46%(18)* | +22%(5)* | +645%(5)* |
| Serie A | −18%(29)* | −31%(39) | +21%(18)* | +2%(14)* | +107%(5)* | −100%(1)* |
| La Liga | −36%(44) | **−37%(58)** | +8%(39) | +14%(30) | +10%(15)* | +92%(9)* |
| Scottish Premiership | −42%(22)* | +1%(43) | −14%(22)* | +35%(23)* | −1%(9)* | +44%(5)* |

(`<35%`, `65-70%`, `70-75%+` all have at most one fixture per league — omitted
from the grid above for space, included in the raw data behind the endpoint.
Bundesliga and La Liga's 40-45% cells are bolded — see below.)

**Sample-size flagging, a decision worth naming explicitly:** cells use
`n<30` as the "thin" threshold — the same figure `runEvCalibration()`'s
`bandStats()` already uses elsewhere in this codebase — rather than
reapplying rule 6's ~300-400 whole-cycle floor to a single cell. A
league×tier cell is a much smaller unit than a pooled tier by construction;
holding every cell to the pooled-tier bar would mark nearly the entire grid
"thin" and say nothing. This is a finer instrument for a finer question,
not a loosening of rule 6 — rule 6's actual floor still governs whether the
*pooled* tier figures (Addendum 5) are decision-grade.

### Shrunk grid and the answer to the open question

Applying `shrinkage.js` per tier (pooling toward that tier's mean across all
9 leagues, same pattern as Addendum 2):

| League | 40-45% raw | 40-45% shrunk |
|---|---|---|
| Champions League | +37.4% (n=27) | **−14.0%** |
| Premier League | −8.0% (n=59) | −18.3% |
| Ligue 1 | −27.6% (n=56) | −22.9% |
| Bundesliga | **−36.1% (n=51, CI excludes zero)** | −24.6% |
| Eredivisie | −34.3% (n=45) | −24.0% |
| Primeira Liga | −29.7% (n=52) | −23.3% |
| Serie A | −31.1% (n=39) | −23.2% |
| La Liga | **−36.6% (n=58, CI excludes zero)** | −25.1% |
| Scottish Premiership | +0.5% (n=43) | **−17.4%** |

**Answer: broad, not concentrated.** Seven of nine leagues show negative
raw ROI in the 40-45% tier. Two of those seven — Bundesliga and La Liga —
independently reach a 95% CI that excludes zero *on their own*, without
pooling. The two apparent exceptions (Champions League +37.4%, Scottish
Premiership +0.5%) both run on the thinnest samples in the column (n=27,
n=43) and both flip to negative once shrunk toward the tier average — the
empirical-Bayes correction is explicitly recognizing that their own evidence
is too weak to justify standing apart from a strong, consistent, cross-league
signal. **After shrinkage, all nine leagues show a negative expected ROI in
this tier.** This is as close to definitive as this week's data gets: the
40-45% underperformance is a structural feature of that confidence band
across the model's whole footprint, not an artifact of one or two leagues.

### Row and column summaries (shrunk, n-weighted — secondary read, not a replacement for the cells above)

| League | Avg shrunk ROI (n) |
|---|---|
| Primeira Liga | +7.4% (143) |
| Champions League | +6.5% (72) |
| Scottish Premiership | +0.7% (126) |
| Ligue 1 | −1.7% (159) |
| La Liga | −3.3% (196) |
| Bundesliga | −8.6% (139) |
| Serie A | −9.0% (106) |
| Premier League | −10.3% (150) |
| Eredivisie | −12.0% (115) |

| Tier | Avg shrunk ROI (n) |
|---|---|
| 60-65% | +160.0% (26) — small-n outlier, see Addendum 5 |
| 55-60% | +28.6% (72) |
| 65-70% | +81.8% (4) — n too small to read |
| 45-50% | +4.7% (269) |
| 50-55% | +2.9% (155) |
| 35-40% | −14.2% (249) |
| **40-45%** | **−21.8% (430)** |

**Flagged plainly, as instructed:** these row/column averages blend tiers
(for the league averages) or leagues (for the tier averages) that behave
quite differently from each other — a league average is a weaker signal
than the tier-level pattern within it, since ROI varies far more by tier
than the averaging suggests. Read them as a first-glance pointer toward
where to look in the full grid, not as a standalone verdict. No league here
shows a broad, consistent problem across *all* its tiers the way 40-45%
shows a problem across *all* leagues — the strongest broad pattern in this
whole matrix is the tier-level one, not a league-level one.

### Placement

Added as its own card on the Performance tab, titled "Historical Performance
Matrix — League × Tier" with an explicit "REFERENCE — NOT A RECOMMENDATION"
badge, positioned above the Paper/Real/Combined toggle (it's static backtest
data, not affected by that toggle) and visually distinguished (pink accent
border, different copy) from the "Calibration Tier Performance" live tracker
below it, so the two — one live-vs-historical at lock time, one a pure
historical cross-tab — aren't confused for each other.

## Addendum 7 — Market type check: 1X2 only, no mixing (confirmed, no split needed)

Triggered by a legitimate question worth checking rather than assuming: does
the historical population behind this whole document — and the live tracker
built on top of it — mix match-outcome (1X2) bets with goals markets
(Over/Under, BTTS)? If so, pooling them into one tier/ROI figure would be
comparing apples to oranges. **Checked directly, both in code and against
real production data — no mixing exists. Everything in this document, the
live tracker, and the historical matrix is 1X2 only.** No re-split was
needed because there was nothing to split.

### Where this was verified

1. **The historical backfill population is structurally 1X2-only.**
   `scoreFixtureFromPool()` in [`weightOptimiser.js:108`](../weightOptimiser.js) —
   the *only* function that produces a record in `backfill-historical.json`'s
   `scoredRecords` array (the population behind `runEvCalibration()`, every
   addendum in this document, and the league×tier matrix) — has no reference
   to goals markets, over/under lines, or BTTS anywhere in it. It computes
   `homeFactors`/`awayFactors` and sets `actualOutcome` to `'home'`/`'away'`/`'draw'`
   from the final score, full stop. Goals data (`goals: {home, away}`) is
   stored only as raw match metadata, never as a market outcome.
2. **Confirmed empirically against live production data** via a temporary
   diagnostic endpoint (now removed): all 18,392 scored records have exactly
   three distinct `actualOutcome` values (`home`, `away`, `draw`) and zero
   records contain any market/goals-market field. No goals-market data has
   ever entered this population.
3. **Goals markets exist, but only in a completely separate, live-only,
   informational code path.** `scoreGoalsMarkets()` in
   [`scoring.js:565`](../scoring.js) produces Over/Under and BTTS candidates
   — but it's called only from the live `scoreOneFixture()` pipeline
   (`server.js`, building `goalsCandidates` for the Scout page's "Watching"
   display), never from the historical backfill pipeline.
4. **Goals-market candidates never become an actual bet.** The bet-locking
   logic (`server.js`, both places a `best` candidate is chosen and written
   to `bets.json`) selects exclusively from `scored.results` — the
   match-outcome array — never from `scored.goalsCandidates`. Confirmed
   against real production data too: all 11 currently logged bets have
   `bet` values of `Home Win` or `Away Win` only, no Over/Under or BTTS
   entries.

### What this means for the rest of this document

Every ROI figure, every tier bucket, every shrinkage calculation in Addenda
1 through 6 — and the live-vs-historical tracker and league×tier matrix
built on top of them — was already exclusively 1X2 by construction, not by
a filter that happened to work. There's no hidden goals-market signal
diluting or distorting the 40-45% finding or anything else in this
document. If goals markets are ever backtested in the future, that would
need its own, separate historical population and its own calibration cycle
under `docs/calibration-rules.md` — it cannot simply be added to the
existing `scoredRecords` population without first building an equivalent
"was this Over/Under/BTTS market right" backfill, which does not currently
exist anywhere in the codebase.

### Cleanup

The temporary `/api/debug/market-type-check` endpoint has been removed. No
changes were made to scoring, EV, or bet-triggering logic, and no changes
were needed to the tracker or matrix — both were already correctly scoped.
Zero new Odds API calls (this task only reads already-stored JSON files);
the daily `apiQuotaUsedToday` counter did move between checks during this
task (108 → 227), but that increase comes from the app's own independent
scheduled/live scanning jobs running in the background on their normal
cadence, not from anything this task did — no code path touched here calls
the Odds API.

## Addendum 8 — Historical ingestion extended to 2010: population nearly tripled, findings hold

Follows directly from the API-Sports headroom investigation earlier this
week. Three parts: verifying Odds API's real pre-2020 floor, extending
API-Sports ingestion, and re-running the pooled tier check on the expanded
population.

### Part A: Odds API's real pre-2020 floor — confirmed hard at 2020-06-06

Six real historical-odds probes (not assumption-based) against EPL and La
Liga snapshots in 2015/2017/2019, plus one 2020 control to confirm the
request format itself works. All six pre-2020 probes returned
`previous_timestamp: null` and `next_timestamp: "2020-06-06T10:05:00Z"` —
the API's own nearest-snapshot pointers, which is more definitive than an
empty event list alone (an empty list could just mean "wrong guessed
kickoff minute"; a null `previous_timestamp` means "nothing exists before
this point, full stop"). The 2020 control returned real data (18 events, 9
bookmakers) confirming the request shape was correct throughout.

**Conclusion: the archive hard-floors at 2020-06-06, no partial/gradual
coverage below it.** Extending API-Sports ingestion earlier than 2020 was
therefore known in advance to help only the pure-calibration population,
not the Pinnacle-matched EV-backtest population — confirmed before doing
any of the ingestion work, not assumed afterward.

### Part B: API-Sports ingestion extended to 2010 (2014 for Europa League)

`HISTORICAL_BACKFILL_CONFIG` (server.js) extended per league:

| League | Old range | New range |
|---|---|---|
| Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League | 2020-2024 | **2010-2024** |
| Scottish Premiership, Eredivisie, Primeira Liga | 2020-2024 (+2026 active) | **2010-2024 (+2026 active)** |
| Europa League | 2022-2024 | **2014-2024** |
| Conference League | 2022-2024 | **2021-2024** (checked, not assumed — API-Sports confirms 2021 is its earliest season; the competition didn't exist before 2021-22) |

**A real bug surfaced and fixed during this run.** Phase 1 (fixture
fetching) already saved incrementally per league, but Phase 2 (scoring) only
ever persisted at the very end. A process restart mid-scoring — which
happened repeatedly while scoring the ~32,000 newly-fetched fixtures, most
likely from memory pressure serialising the growing dataset at each
checkpoint — silently discarded 100% of that run's scoring progress every
time, even though the fetched fixture pool itself was already safe on disk.
Fixed by persisting `scoredRecords` at the same 500-record cadence already
used for the optimisation checkpoint (`server.js`), plus wrapping
`scoreFixtureFromPool()` in a per-fixture try/catch so one malformed record
can't abort the whole batch. With the fix in place, five subsequent
restarts each resumed cleanly from the last checkpoint and the run
completed in full rather than being re-attempted from zero each time.

**Per-league fixture counts, before → after:**

| League | Before | After | Δ |
|---|---|---|---|
| Premier League | 1,900 | 5,700 | +3,800 |
| Serie A | 1,901 | 5,701 | +3,800 |
| La Liga | 1,900 | 5,700 | +3,800 |
| Ligue 1 | 1,757 | 5,456 | +3,699 |
| Bundesliga | 1,539 | 4,603 | +3,064 |
| Eredivisie | 1,593 | 4,630 | +3,037 |
| Primeira Liga | 1,539 | 4,336 | +2,797 |
| Scottish Premiership | 1,172 | 3,384 | +2,212 |
| Champions League | 1,057 | 2,956 | +1,899 |
| Europa League | 592 | 3,946 | +3,354 |
| Conference League | 1,149 | 1,548 | +399 |
| World Cup | 0 | 0 | +0 (still zero — see Scope, unaffected by this task) |
| **Total (12-league scope)** | **16,099** | **47,960** | **+31,861 (~2.98×)** |

Total scored population (all leagues, including out-of-scope stray IDs):
**18,392 → 50,253**.

### Part C: pooled tier calibration re-run on the expanded population

Same methodology as Phase 1's original check, same 5pp bins:

| Tier | n (before) | n (after) | Calib. error (before) | Calib. error (after) |
|---|---|---|---|---|
| <35% | 7 | 33 | +6.1pp | −1.7pp |
| 35-40% | 2,471 | 7,825 | +1.9pp | **+0.4pp** |
| 40-45% | 4,408 | 13,318 | −0.5pp | −0.8pp |
| 45-50% | 3,853 | 11,248 | −3.8pp | −2.3pp |
| 50-55% | 2,334 | 6,974 | −4.6pp | −3.5pp |
| 55-60% | 1,640 | 4,598 | −6.3pp | **−6.3pp** |
| 60-65% | 1,099 | 3,175 | −12.1pp | **−12.2pp** |
| 65-70% | 283 | 784 | −18.3pp | **−17.7pp** |
| 70-75% | 4 | 5 | −29.1pp | −29.6pp (still n<10, unreliable either way) |

**Verdict: the underconfidence finding holds almost exactly, and is now
dramatically better evidenced.** The 55-60%, 60-65%, and 65-70% tiers —
already this document's clearest evidence of underconfidence — land within
0.1-0.6pp of their original figures despite nearly tripled sample sizes in
each (e.g. 60-65% n=1,099→3,175, error −12.11pp→−12.17pp). This is the
strongest form of confirmation available short of a live re-test: an
independent expansion of the underlying data reproduces the same result to
within noise, rather than revealing it was an artifact of the smaller
sample. The 35-40% and 40-45% tiers remain close to perfectly calibrated,
also consistent with the original finding.

**60-65% tier, per-league (previously the thinnest, most cited "expect
noise" cells — now genuinely large):**

| League | n (before) | n (after) | Hit rate (after) |
|---|---|---|---|
| Champions League | 100 | 283 | 74.6% |
| Europa League | 34 | 233 | 62.2% |
| Premier League | 132 | 398 | 75.6% |
| Ligue 1 | 65 | 195 | 78.5% |
| Bundesliga | 115 | 324 | 72.2% |
| Eredivisie | 139 | 374 | 76.7% |
| Primeira Liga | 114 | 317 | 83.9% |
| Serie A | 101 | 293 | 73.0% |
| La Liga | 122 | 391 | 74.9% |
| Scottish Premiership | 95 | 253 | 69.6% |
| Conference League | 82 | 114 | 71.9% |

Every league in this tier now individually clears 190+ fixtures (up from
1-139) and every single one sits above the raw ~62% predicted probability —
this is no longer a pooling artifact that a couple of small leagues could
be driving; it is eleven independent, individually well-evidenced leagues
all pointing the same direction.

### Calibration-rules.md compliance — no split needs redoing

Flagged explicitly per this task's own instruction, not left implicit:
**none of the four validated leagues' train/test splits (PL, Ligue 1,
Champions League, Serie A) need re-doing.** Each split is defined purely by
a `testFrom` date (the earliest in 2023-11-03, the latest 2024-03-12).
Every fixture added by this expansion predates 2020, which is more than
three years before any of those boundaries — the expansion can only ever
enlarge the train side of each split, never touch the test side, and no
new tuning or parameter fit was performed against this larger train
population in this task. The one thing this expansion *does* do is make a
future re-tuning cycle (if one is ever run) able to draw on a much larger
train set than was available when the original four splits were tuned —
worth knowing, not something requiring action now.

### Zero new Odds API calls

Confirmed via `/api/odds-credits-status`: the only Odds API activity this
task performed was the six floor-check probes plus one control (Part A),
none of which repeat or scale with the ingestion work in Part B/C. Part B
and C are pure API-Sports (fixture fetch) and local computation (scoring,
tier analysis) respectively.

## Addendum 9 — Dataset integrity confirmed clean; a significant GBDT training-data finding

Follow-up to Addendum 8, verifying the 47,960-fixture expansion is a trustworthy
baseline before any further work builds on it. Two parts: a data-integrity
check on the expanded dataset itself, and — a materially bigger finding —
where the live GBDT model's training data actually comes from.

### Part A: no duplicates, no malformed records, stable across repeats

Checked directly against the live 50,253-record `scoredRecords` population
(not assumed clean because the code *should* prevent duplicates):

- **Total records: 50,253. Unique fixture IDs (numeric): 50,253. Unique
  fixture IDs (string): 50,253.** No duplicates of any kind, and no
  numeric/string type-mismatch duplicates either.
- **Zero malformed records** — every record has `fixtureId`, `date`,
  `leagueId`, `context`, `homeFactors`, `awayFactors`, and `actualOutcome`
  populated. No partial/torn writes from the 5 forced restarts.
- **Spot-checked all 5 restart-boundary regions directly** (approximate
  insertion-order positions 27,500 / 35,000 / 41,500 / 45,000 / 47,000 /
  49,500, plus the first and last records) — every sample carries a real,
  valid fixture ID, a genuine date somewhere in the 2013–2026 range, and all
  required fields present.
- **Re-ran the full check twice** — identical totals and identical
  per-league breakdown both times, confirming the dataset is stable, not an
  artifact of read timing.

**Why this held up cleanly, structurally, not just by luck:** every place
`scoredRecords` gets built or persisted — the main scoring loop, this
week's new checkpoint save, and the final Phase 4 persist — goes through a
`Map` keyed by `fixtureId`. Setting the same key twice overwrites in place;
a `Map` cannot hold two entries under one key. Each restart rebuilds that
Map fresh from whatever was last saved to disk and only adds fixtures not
already present. Duplication was never structurally possible via this code
path — this check confirms that design assumption held under real restart
conditions, rather than taking it on faith.

**Confirmed: the ~47,960/50,253 figures reported in Addendum 8 are accurate
and stable.** Nothing needs cleaning up.

### Part B: the live GBDT model has not trained on any of this week's data — confirmed with certainty, not "unknown"

This is a real, previously-undocumented finding, not a null result.

**The model currently in production was trained 2026-07-25, on `trainN:
6,652` records, and has not been retrained since** — confirmed directly via
`/api/server-status`'s `model.trainedAt`. This alone was surprising: the
codebase has an automatic retrain trigger (`checkAndRetrain()`, server.js)
that fires whenever `scoredCount` crosses a 500-record boundary, and this
week's expansion crossed *dozens* of those boundaries. It never fired
successfully.

**Root cause, found in `models/gbdt-train.js`:** the training script's
`loadData()` reads
```js
fs.readFileSync(path.join(__dirname, '../data/backfill-historical.json'), ...)
```
— a path resolved relative to the training script's own location, landing
on the repository's checked-in `data/backfill-historical.json`. This is a
**different file** from the one the live server reads and writes via
`DATA_DIR` (the Render persistent disk, `/data/backfill-historical.json`).
The training script's spawning code (`checkAndRetrain()`) does pass
`DATA_DIR` into the child process's environment, but `gbdt-train.js` never
reads `process.env.DATA_DIR` — it ignores it entirely.

**Verified, not inferred:** the checked-in local file has exactly 8,316
scored records, spanning 2020-10-08 to 2026-03-31. `Math.floor(8316 × 0.8) =
6,652` — an exact match to the model's reported `trainN`. This confirms with
certainty (arithmetic, not assumption) that the live model has always
trained on this static, ~8,300-fixture snapshot, not the growing production
dataset.

**Practical consequence:** every automatic retrain attempt this week trained
on the *same unchanged file* it always has, produced a statistically
near-identical model each time (modulo the trainer's random subsampling),
and was almost certainly rejected by the trainer's own improvement gate
(`gbdt-train.js`: a new model is only written if its log-loss beats the
current one by more than 0.001) — explaining why `trainedAt`/`trainN` never
moved despite the retrain trigger firing repeatedly.

**Direct answer to the question this task asked:** the newly-ingested
2010–2019 fixtures (and, in fact, all growth in the production dataset since
whenever that local snapshot was last regenerated) are **definitively
outside the GBDT's entire training history — not held out of a specific
split, never seen by the model in any form.** This is the strongest possible
version of "out-of-sample" for this week's underconfidence finding: it
isn't just that a particular league's test set was clean, it's that the
live model currently making predictions has not been touched by any of the
data this whole document's tier-calibration analysis is built on.

**Not fixed in this task, per its own scope** — this is a real bug worth a
dedicated follow-up (`gbdt-train.js` should honor `DATA_DIR` so retraining
actually uses production data), but changing it is a live-model change,
explicitly out of scope for an investigation task. Flagged here plainly so
it's a known, documented issue rather than a silent gap.

### Zero new API calls

Both checks read only the already-stored `backfill-historical.json` and
already-committed `data/backfill-historical.json` / `gbdt-weights.json`
files. No Odds API or API-Sports calls were made.

## Addendum 11 — Alternative odds-vendor scoping: no candidate closes either gap

Pure research task (no API calls, no code, no signups) — scoped four
candidate vendors against the two confirmed gaps from Addendum 8/10: the
pre-2020 depth floor and the Conference League 2021-2022 provider-level
blackout. `LEAGUE_CONFIG` covers 12 leagues: Premier League, La Liga, Serie
A, Bundesliga, Ligue 1, Scottish Premiership, Eredivisie, Primeira Liga,
World Cup, and the three UEFA club competitions (Champions League, Europa
League, Conference League).

**ParlayAPI** — free tier confirmed genuinely free (1,000 credits/month, no
card required); paid tiers $5-$200/month. Claims "22 soccer leagues from
2005+," but its own historical-coverage page states this is delivered via
**football-data.co.uk's bookmaker grid** as the soccer source — i.e. it
appears to be a wrapper/aggregator over exactly the free source separately
evaluated below, not an independent feed for soccer. Since football-data.co.uk
carries domestic league data only (see below), Conference League — a UEFA
competition, not a domestic league — is very unlikely to be among the 22.
Could not confirm the exact 22-league list or per-league start dates without
an account (no page enumerates them; the coverage table loads dynamically).
Not pursued further given the pass-through relationship to a source already
ruled out for the UEFA gap.

**OpticOdds** — pricing is fully sales-gated (multi-step contact form, no
tier or dollar figures published, no free trial). Coverage claims ("25+
sports, 400+ leagues," "several years of complete price history" for tier-one
leagues/books) are marketing-level only; no soccer-specific or
Conference-League-specific depth is documented anywhere public. Getting a
real answer would require entering a sales conversation, which is a
credentials/commercial-relationship step this task's constraints ask to
flag rather than initiate — flagging rather than proceeding.

**SportsDataIO** — resolved the discrepancy: the "2010 onwards" figure comes
from their **general historical stats/scores product** page
(`/historical-sports-data`, "detailed statistics across all major sports,
from 2010 onwards"), not from odds data. Their dedicated
`/historical-odds` page is explicit and separate: "historical betting lines
for all major sports from 2019 onwards, with props and futures from 2020."
The academic/third-party listing the task asked to check against was almost
certainly citing the stats product, not odds — SportsDataIO's real odds
floor (2019) is actually slightly worse than Odds API's confirmed 2020-06-06
floor, not better. Their competition list does name Champions League and
Europa League but not Conference League explicitly. Pricing is fully
sales-gated, same caveat as OpticOdds.

**football-data.co.uk** — genuinely free, no signup, plain CSV/Excel
download, usable programmatically (flat files, not an API — would need
scheduled bulk-download-and-parse handling rather than a live client).
Confirmed via their own leagues page: 11 "main" countries + 16 "extra"
countries, all **domestic league divisions only** — no Champions League,
Europa League, or Conference League file exists at all. This is a hard,
structural exclusion, not a depth gap: the site has never tracked UEFA
competitions in any season. For the leagues it does carry (includes
Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Eredivisie, Primeira
Liga, and Scottish football), seasons run back to 1993/94 — comfortably
covering the pre-2020 gap for 7 of the 8 domestic legs in `LEAGUE_CONFIG`
(World Cup is not a domestic league and isn't covered either).

### Part B — Ranking and recommendation

| Vendor | Pre-2020 depth | Conference League 2021-22 | Cost | Integration |
|---|---|---|---|---|
| football-data.co.uk | **Strong** — domestic legs back to 1993/94 | **None** — UEFA competitions never tracked | Free | Bulk CSV, manual/scheduled parsing |
| ParlayAPI | Unconfirmed, likely inherits football-data.co.uk's floor for soccer | **Unlikely** — same reasoning as above, unverified | Free tier available | API, real-time + historical endpoints |
| SportsDataIO | Worse than current (2019 vs Odds API's 2020-06-06) | Not documented; CL/EL named, Conference League not | Sales-gated | API/S3, likely highest integration cost |
| OpticOdds | Undocumented, marketed as "several years" for tier-one only | Not documented at all | Sales-gated | API |

Neither named gap is closed by any candidate:

- **Pre-2020 depth**: football-data.co.uk is the only one that clearly beats
  Odds API's 2020-06-06 floor, and it does so for exactly the 7-8 domestic
  legs where the pure-calibration/ROI population lives — but it's
  **match-result-and-closing-odds only** (a handful of bookmakers per row,
  not the live multi-book snapshot structure the current pipeline is built
  around), so it would need its own ingestion path, not a drop-in extension
  of `HISTORICAL_BACKFILL_CONFIG`.
- **Conference League 2021-2022**: no candidate closes this. It's a
  structural gap (the competition is young and thinly tracked industry-wide,
  not just by Odds API) rather than a vendor-selection problem.
  football-data.co.uk never carries UEFA competitions at all; ParlayAPI's
  soccer data appears to inherit that same limitation; SportsDataIO and
  OpticOdds don't document Conference League coverage at all, sales-gated or
  otherwise.

**Recommendation: no vendor here justifies a deeper proof-of-concept trial
for the Conference League gap** — it looks like a genuine industry-wide
blind spot for 2021-2022, not a vendor-selection problem, so no PoC is worth
scoping for that half of the task.

For the **pre-2020 depth** question, football-data.co.uk is the one
candidate worth a minimal PoC if the pre-2020 population is ever considered
valuable enough to extend further back than the 2010 cutoff already ingested
in Addendum 8 (e.g. reaching into the 1990s/2000s) — a check would look like:
pull 20 real fixtures from a single free CSV (e.g. 2015/16 Premier League),
confirm real closing-odds fields are populated and team names are matchable
against existing fixture records, and estimate the bulk-download/parsing
effort against the payoff. Not executed here, per the task's scope — this is
purely a note that it's the only candidate with a plausible reason to revisit
later, not a general endorsement of a new vendor integration now.

No signups, contact-form submissions, or payment-gated pages were initiated
for OpticOdds or SportsDataIO's real pricing, per the constraint that any
vendor requiring payment/credential entry to see real coverage detail should
be flagged rather than pursued. Both are flagged here rather than acted on.

### Cleanup

None needed — no code, no endpoints, no live-data-source changes. Read-only
web research only.

## Addendum 10 — Soft-book coverage scoping: real gaps are narrower and different than assumed

Investigates whether mainstream/soft bookmakers on the *same* Odds API
provider could close the remaining 2020–2026 coverage gaps, without a new
vendor. Confirmed real API calls (51 total: 3 live enumeration + 48
historical), no scoring/EV/`LEAGUE_CONFIG` changes.

### Part A: 40 bookmakers available; Bet365 is not one of them

A live enumeration across 3 sports (EPL, Eredivisie, Conference League)
found **40 distinct bookmakers** in uk/eu regions, including the mainstream
names this task named as candidates — William Hill, Ladbrokes, Coral, Paddy
Power, Sky Bet, Unibet (UK/FR/NL/SE variants), Betway, Bet Victor, 888sport,
BoyleSports, Grosvenor, Virgin Bet, Betano, LeoVegas, Casumo, Coolbet, plus
the sharp/exchange books already known (Pinnacle, Marathon Bet, Matchbook,
Betfair, Smarkets). **Bet365 is not available through this provider at
all** — absent from all 40 keys returned. This is a known industry
limitation (Bet365 restricts third-party odds licensing broadly), not a
configuration issue on this app's side.

Picked three candidates to investigate in depth: **William Hill,
Ladbrokes UK, Unibet UK** — all present, all genuinely mainstream/soft
retail books.

### Part B: the real gap is Conference League, not Eredivisie — and it isn't a bookmaker problem

Checked matched-vs-gap counts directly against the current 2020+ population
(not the stale cached `ev-calibration.json` figures, which understated both
leagues significantly — see caveat below):

| League | Fixtures in 2020+ window | Pinnacle-matched | Pinnacle-gap | Match rate |
|---|---|---|---|---|
| Eredivisie | 1,594 | 1,546 | 48 | **97%** |
| Conference League | 1,548 | 342 | 1,206 | **22%** |

**Eredivisie was never a real coverage problem.** Its low all-time match
rate reported earlier this week (462/4,630 ≈ 10%) was almost entirely an
artifact of the 2010–2019 expansion — fixtures from that era can't match
any bookmaker by construction (Addendum 8's confirmed 2020-06-06 floor).
Within the window where matching is even possible, Pinnacle already covers
97% of it. Sampled 9 of Eredivisie's remaining 48 gap fixtures directly: 7
had **zero matching event at all** in the historical snapshot (despite the
snapshot returning 9-18 other events at that timestamp — likely
postponements, rescheduled kickoffs, or playoff fixtures with non-standard
timing), and the 2 that did resolve to a real event had **no soft-book data
either**. These are not bookmaker-coverage gaps a different book would fix.

**Conference League's gap is real, large, and provider-level, not
bookmaker-level.** Sampled 12 of its 1,206 gap fixtures spread across
2021–2024: **8 of 12 returned zero events at all** — the historical
snapshot had no data for *any* bookmaker at that timestamp, not just no
Pinnacle. All 8 zero-event fixtures were from 2021–2022 (the competition's
first two seasons). The 3 fixtures that did resolve were all 2023-2024,
and Pinnacle was present in all 3 — soft books (`unibet_uk`) only in 2 of
those 3. **The pattern points to the Odds API provider not tracking
Conference League comprehensively until roughly mid-2023**, not to
Pinnacle specifically under-covering a competition other books cover
better. Adding a soft book would not recover the 2021–2022 gap, because
the data isn't there for anyone.

### Part C: where both books do have data, soft-book edge tracks Pinnacle-implied edge extremely well

On the 43 (fixture, book) pairs where both Pinnacle and a candidate soft
book had a genuine h2h price for the same fixture (12 Eredivisie + 12
Conference League overlap fixtures × up to 3 books each):

| Book | n | Pearson r (edge vs. edge) | Same-direction rate |
|---|---|---|---|
| William Hill | 18 | **0.997** | 94.4% |
| Unibet UK | 13 | **0.998** | 100% |
| Ladbrokes UK | 12 | **0.997** | 91.7% |
| **Pooled** | **43** | **0.995** | **95.3%** |

This is the sharper test the task asked for — implied *edge* (model
probability vs. that book's price), not just raw price correlation. The
correlation is about as strong as two independent price sources of the
same event can be expected to agree, and **the only two sign
disagreements found are both the same fixture** (Club Brugge vs PAOK,
2024-04-11), where Pinnacle's own edge was +0.39% — essentially zero, a
case where any book's slightly different price trivially flips the sign.
This is noise-around-a-null-result, not a real ranking failure. **Which
bets look best according to a soft book is, in practice, the same answer
Pinnacle would give**, for these three books specifically.

### Part D: recommendation

**Soft-book data is not worth integrating for Conference League or
Eredivisie specifically** — the gaps in those two leagues are either
already closed (Eredivisie) or provider-level and unfixable by adding a
bookmaker (Conference League's 2021-2022 seasons). Adding soft-book
capture would not meaningfully grow the matched population for the two
leagues this task set out to fix.

**However, the edge-direction validation (Part C) is a genuinely positive,
reusable result**, independent of the coverage-gap question: William Hill,
Ladbrokes UK, and Unibet UK all track Pinnacle-implied edge with r≈0.995+
and 92-100% direction agreement. If a *future* need arises for a larger-n,
secondary ROI signal in some other context — the correlation work done
here says these three books would be trustworthy for that purpose, **used
and labeled explicitly as a secondary/less-reliable signal, never blended
into the Pinnacle-based figure**. Not acted on in this task, since it
wasn't what the coverage-gap question actually needed.

**On the new-vendor question this task was scoped to help answer:**
soft-book integration does **not** solve the matched-population problem —
it doesn't meaningfully help the two named gap leagues, and by
construction (all mainstream books draw from the same real-money market,
generally tracking a similar timeline of provider coverage) it's unlikely
to unlock a different set of gaps elsewhere either. **A new odds vendor
remains the only lever identified so far that could plausibly close
provider-level gaps like Conference League's missing 2021-2022 data** —
this task doesn't evaluate whether that's worth pursuing on its own
merits (cost, integration effort), only confirms that soft-book data on
the *existing* provider isn't a substitute for it.

**Caveat flagged:** the earlier-referenced `ev-calibration.json`-derived
per-league "n" figures (e.g. Eredivisie n=462) used in framing this task
are a stale cache, not live-recomputed on each `/api/ev-calibration` call
— this document's own Part B figures (computed directly from
`backfill-historical.json` + `closing-odds.json`, fresh) are the accurate
current state. Worth knowing for any future league-sizing question in this
codebase: don't trust that endpoint's numbers without checking when the
cache was last refreshed.

## Addendum 12 — Final Pre-Retrain Baseline

This is the capstone read this whole document has been building toward: a
one-time, unrepeatable measurement of the frozen live GBDT model
(`trainedAt: 2026-07-25T08:59:19Z`, `trainN: 6,652`) against the full
current population, before the `gbdt-train.js` DATA_DIR bug is fixed and
the model is retrained on everything. Once that happens, none of this
population is "unseen" again — this is the last chance to read it cleanly.
**Every future model version gets compared against the numbers in this
section.**

At capture time, live `scoredCount` stood at **50,253** (all leagues) /
**47,960** (12-league in-scope population), against a `nextRetrainAt` of
50,500 — only ~250 records from the existing (bugged, effectively inert)
auto-retrain trigger firing on its own. This is exactly the race condition
Phase 2's gating step exists to close before Phase 3 fixes the bug.

Methodology: the exact live pipeline (`model.predict()` → GBDT →
`applyLeagueBiasCorrection()`, the same call shape `runEvCalibration()` and
every prior tier-calibration endpoint this week has used — this whole
document has always been evaluating the live GBDT model, not the diagnostic
linear one, confirmed by checking the actual code of the original Phase 1
endpoint). Unlike every prior addendum, **both the calibration table and
the ROI matrix are restricted to held-out test-only fixtures** for the 9
leagues with a `VALIDATED_SPLITS` boundary (Premier League, La Liga, Serie
A, Bundesliga, Ligue 1, Champions League, Scottish Premiership, Eredivisie,
Primeira Liga) — the cleanest version of this read this project will ever
produce, since Phase 2 retires the reserved-test-portion concept
immediately afterward.

### Pooled calibration, held-out test only (n=4,054 across 9 leagues)

| Tier | n | Mean predicted | Actual hit rate | Calibration error |
|---|---|---|---|---|
| 35-40% | 589 | 38.5% | 33.1% | +5.4pp |
| 40-45% | 1,142 | 42.5% | 41.1% | +1.4pp |
| 45-50% | 957 | 47.5% | 54.2% | −6.7pp |
| 50-55% | 611 | 52.2% | 59.4% | −7.2pp |
| 55-60% | 380 | 57.4% | 64.5% | −7.1pp |
| 60-65% | 279 | 62.3% | 74.9% | −12.6pp |
| 65-70% | 94 | 66.4% | 87.2% | −20.8pp |

**The underconfidence finding holds on genuinely held-out data, for the
first time in this document's life.** Every previous read of this pattern
(original Phase 1, Addendum 8) used the full population, including
fixtures the model's weights/config had some historical relationship to.
This table uses only fixtures on or after each league's `testFrom` date —
zero overlap with anything used to shape the system all week. The shape is
the same: near-perfect calibration through 45%, then a widening
underconfidence gap that reaches −20.8pp at 65-70%. At the individual
league level, **every one of the 9 validated leagues is independently
underconfident in the 60-65% tier** (errors ranging from Premier League's
−5.8pp to Serie A's −22.6pp) — this is not a pooling artifact.

### ROI matrix, held-out test only — unchanged from Addendum 6

Pooled (posEdge≥5%, n=1,206 across all tiers):

| Tier | n | ROI |
|---|---|---|
| 35-40% | 249 | −13.4% |
| 40-45% | 430 | −21.5% |
| 45-50% | 269 | +4.4% |
| 50-55% | 155 | +1.8% |
| 55-60% | 72 | +28.6% |
| 60-65% | 26 | +151.0% |

The per-league 40-45% figures — the tier with the strongest, most
consistent negative signal — are **numerically identical to Addendum 6**
(Champions League +37.4%(27), Premier League −8.0%(59), Ligue 1
−27.6%(56), Bundesliga −36.1%(51), Eredivisie −34.3%(45), Primeira Liga
−29.7%(52), Serie A −31.1%(39), La Liga −36.6%(58), Scottish Premiership
+0.5%(43)) and the shrunk figures likewise reproduce exactly. This is
expected, not a bug: the entire pre-2020 expansion (Addendum 8) can only
ever land on the train side of a `testFrom` boundary from 2023-2024
onward, so the test-only ROI population has not changed by a single
fixture since Addendum 6 was written. **This section's role is to confirm,
formally and for the last time, that Addendum 6's numbers are the correct
final pre-retrain figure** — not to produce new ones. All nine leagues
still show a negative shrunk-ROI in the 40-45% tier (see Addendum 6 for
the full shrunk table); that conclusion is unchanged and is the ROI half
of this baseline.

### Europa League and Conference League — reported separately, not held-out

Neither league has a `VALIDATED_SPLITS` entry, so neither can contribute
to the test-only figures above without contaminating them. Reported here
against their **full** population instead, explicitly caveated:

| League | Tier | n | Mean predicted | Hit rate | Error |
|---|---|---|---|---|---|
| Europa League | 55-60% | 468 | 57.3% | 57.3% | +0.1pp |
| Europa League | 60-65% | 233 | 61.9% | 62.2% | −0.3pp |
| Conference League | 55-60% | 180 | 57.5% | 66.1% | −8.6pp |
| Conference League | 60-65% | 114 | 62.1% | 71.9% | −9.8pp |

Europa League looks close to perfectly calibrated across every populated
tier; Conference League shows the same underconfidence direction as the
validated leagues, milder in places. Neither number should be read with
the same trust as the validated-league table above — full-population
figures reflect whatever historical relationship the system already has
to this data, which is a real methodological difference from the rest of
this section, not a footnote. ROI (full population, posEdge≥5%): Europa
League −2.5% (n=178), Conference League +1.3% (n=141) — both far below
rule 6's decision-grade floor, informational only.

### Conference League 2021-2022: permanent, accepted limitation

Documented in full in Addendum 10 (real coverage gap: only 22% Pinnacle-matched,
2021-2022 specifically returns zero events for any bookmaker — provider-level,
not bookmaker-specific) and Addendum 11 (no alternative vendor closes it;
this looks like a genuine industry-wide blind spot for that competition's
first two seasons, not a solvable vendor-selection problem). **This is now
closed as an accepted limitation, not an open question** — no further
vendor scoping or coverage-chasing is planned for this specific gap. Future
work on Conference League should proceed with this ceiling in mind rather
than re-litigating it.

### What this baseline is, precisely

A read of the GBDT model trained 2026-07-25 (`trainN=6,652`, drawn from a
stale local snapshot the live pipeline never actually fed — see Addendum
9) against 47,960 in-scope fixtures, the overwhelming majority of which
that model has never trained on in any capacity. It is not a new tuning
cycle — no weights, base rates, or config changed as a result of this
read. It exists so that the model produced in Phase 3 has something
concrete and fully-documented to be judged against, later, once it has
accumulated enough live decisions of its own.

**Closing update:** the retrain this baseline was captured ahead of has
since happened. The live model is now `trainedAt=2026-08-08T20:56:33.315Z`,
`trainN=40,202` — trained on the full population this baseline describes,
confirmed live two independent ways after a genuine process restart (not
just a file read). Full account of the bug fixes, the infrastructure built
first to make this safe, and the final confirmation is in
[model-versioning.md](model-versioning.md) — not duplicated here to keep
this document's job strictly to the pre-retrain read. This table is now
permanently what any future model version gets compared against.

## Addendum 13 — Calibration Matrix: a proxy strength indicator, pre-retrain model only

Addendum 6's ROI matrix is structurally frozen: Odds API's 2020-06-06 floor
plus each of the 9 leagues' fixed `testFrom` boundary means no fixture can
ever land in that matrix's test population again, retrain or not — it will
never move. Calibration is different: Addendum 12 got a real update on
genuinely unseen data (n=4,054), and the underconfidence pattern held across
all 9 leagues. Since a well-calibrated league/tier should, in principle,
produce real edge before enough matched-odds volume exists to prove it via
ROI, this is a league × tier breakdown of Addendum 12's calibration read —
a leading proxy for "where the model was strong," not a replacement for
either the ROI matrix or live results.

**⚠️ Critical labeling point, stated here as plainly as in the UI and the
code comment above `PRE_RETRAIN_CALIBRATION_MATRIX`:** every number below
describes the **old GBDT model** — `trainedAt: 2026-07-25`, `trainN: 6,652`
— tested against Addendum 12's held-out population. The **current live
model** (`trainedAt: 2026-08-08T20:56:33Z`, `trainN: 40,202`, see
[model-versioning.md](model-versioning.md)) has not been calibration-tested
against any genuinely unseen data yet, and this table **can never be
refreshed to reflect it** — the old model's weights no longer exist to
re-evaluate. Treat this as a historical artifact of a model that is no
longer live, not a current read.

### Methodology

Same population and pipeline as Addendum 12 (held-out test-only, 9
validated leagues, `model.predict()` + `applyLeagueBiasCorrection()`), sliced
by (league, tier) instead of pooled by tier alone. Cell value is calibration
error (`meanPredicted − actualHitRate`; positive = overconfident, negative =
underconfident) rather than ROI. Shrinkage applied exactly as Addendum 6 —
`empiricalBayesShrink()` per tier, pooling each league's cell toward that
tier's own n-weighted mean across all 9 leagues — using the hit rate's own
binomial variance (`p(1−p)`) as the per-observation variance input, since
the mean-predicted side of the error is a near-fixed quantity within a bin
and essentially all the noise comes from the empirical hit rate. Thin-cell
threshold: `n<30`, same as Addendum 6.

Computed from the exact raw output already captured for Addendum 12 (no
fresh scoring, no new API calls) — the old model's weights are gone, so this
could not be recomputed live even if wanted; this is why the matrix is
hardcoded as a permanent constant (`PRE_RETRAIN_CALIBRATION_MATRIX`,
`server.js`), same pattern as `LEAGUE_TIER_MATRIX` and
`HISTORICAL_TIER_BASELINE`.

### The grid (raw errorPp (n), shrunk in brackets — thin cells marked *)

| League | 35-40% | 40-45% | 45-50% | 50-55% | 55-60% | 60-65% | 65-70% |
|---|---|---|---|---|---|---|---|
| Champions League | −6.9(24)*[+5.4] | −3.5(76)[+1.4] | −3.7(70)[−6.4] | −14.0(48)[−7.2] | −11.1(38)[−7.1] | −12.5(24)*[−12.6] | −33.6(3)*[−23.4] |
| Premier League | +3.3(59)[+5.4] | −0.2(156)[+1.4] | −16.1(146)[−8.5] | −2.2(96)[−7.2] | −2.7(58)[−7.1] | −5.8(47)[−12.6] | −33.8(9)*[−26.4] |
| Ligue 1 | +4.7(80)[+5.4] | −0.5(163)[+1.4] | −6.6(135)[−6.7] | −4.9(79)[−7.2] | −15.1(43)[−7.1] | −12.2(23)*[−12.6] | +15.7(2)*[−15.7] |
| Bundesliga | +8.5(73)[+5.4] | +5.2(121)[+1.4] | +1.0(117)[−5.5] | −6.6(66)[−7.2] | −5.9(41)[−7.1] | −10.3(40)[−12.6] | +5.9(5)*[−13.0] |
| Eredivisie | +0.5(55)[+5.4] | −1.7(138)[+1.4] | −10.1(121)[−7.3] | −1.9(78)[−7.2] | −2.9(43)[−7.1] | −20.6(35)[−12.6] | −24.2(10)*[−22.4] |
| Primeira Liga | +8.2(83)[+5.4] | +2.3(132)[+1.4] | −1.4(98)[−6.0] | −14.0(62)[−7.2] | −6.9(42)[−7.1] | −17.6(35)[−12.6] | −33.9(11)*[−27.1] |
| Serie A | +0.1(69)[+5.4] | +4.7(106)[+1.4] | −13.4(66)[−7.4] | −2.5(49)[−7.2] | −12.2(33)[−7.1] | −22.6(19)*[−12.6] | — |
| La Liga | +8.8(101)[+5.4] | +5.2(156)[+1.4] | −4.6(115)[−6.4] | −9.6(84)[−7.2] | −8.4(55)[−7.1] | −8.2(31)[−12.6] | −15.1(27)*[−16.9] |
| Scottish Premiership | +12.1(45)[+5.4] | −0.2(94)[+1.4] | −3.1(89)[−6.3] | −15.1(49)[−7.2] | +1.8(27)*[−7.1] | −9.6(25)*[−12.6] | −21.9(27)*[−21.6] |

### A genuinely different result than Addendum 6's ROI grid: near-total shrinkage in most tiers

Unlike the ROI matrix — where individual leagues frequently retained real
signal after shrinkage — most tiers here collapse almost completely to the
tier's pooled mean. Every league's 35-40% cell shrinks to the same +5.4pp,
every 40-45% cell to +1.4pp, every 50-55% cell to −7.2pp, every 60-65% cell
to −12.6pp. This is not a computation error: a 0/1 hit-rate's per-observation
variance (`p(1−p)`, up to 0.25) is large relative to the actual spread
observed across only 9 leagues at these sample sizes, so
`empiricalBayesShrink()` correctly concludes the apparent cross-league
differences are statistically indistinguishable from sampling noise. Only
the 65-70% tier (much smaller n, and in a few cases a genuinely large raw
spread) and 45-50%/55-60% (partial differentiation) retain meaningfully
different shrunk values per league.

**Reading this as a finding rather than a null result: the model's
over/underconfidence behavior at a given tier looks like a property of the
tier itself, not of any individual league.** That's a cleaner, more useful
conclusion for a "proxy strength indicator" than a noisy per-league table
would have been — it says Addendum 12's pooled tier read is the number to
trust, and no single validated league should be read as more or less
calibration-trustworthy than another at the same tier.

### Row and column summaries (shrunk, n-weighted)

| League | Avg shrunk error (n) |
|---|---|
| Serie A | −2.3pp (342) |
| Ligue 1 | −2.7pp (525) |
| Bundesliga | −3.1pp (463) |
| Primeira Liga | −3.1pp (463) |
| La Liga | −3.2pp (569) |
| Eredivisie | −4.0pp (480) |
| Champions League | −4.2pp (283) |
| Premier League | −4.6pp (571) |
| Scottish Premiership | −4.6pp (356) |

All nine leagues cluster within a 2.3pp band (−2.3 to −4.6) — confirming the
same conclusion as above from the other direction: no league stands out as a
calibration outlier once shrunk. The underconfidence pattern is broad **and**
uniform across the model's whole footprint, not concentrated anywhere.

| Tier | Avg shrunk error (n) |
|---|---|
| 35-40% | +5.4pp (589) |
| 40-45% | +1.4pp (1,142) |
| 45-50% | −6.8pp (957) |
| 50-55% | −7.2pp (611) |
| 55-60% | −7.1pp (380) |
| 60-65% | −12.6pp (279) |
| 65-70% | −20.9pp (94) |

Reproduces Addendum 12's pooled tier table exactly (as expected, given how
little shrinkage moved any individual cell) — included here for a complete
row/column pair matching the ROI matrix's presentation, not as new
information.

### Placement

New card on the Performance tab (`public/index.html`), positioned
immediately after the existing Historical Performance Matrix card and
sharing its general layout (table + two-column row/tier summary), but with
an amber accent border and an explicit warning banner instead of the ROI
matrix's pink — deliberately distinct so the three Performance-tab
reference surfaces are never confused with each other:

1. **Historical Performance Matrix** (pink) — old model's ROI ceiling,
   frozen forever by the 2020 floor + fixed test boundaries.
2. **Calibration Matrix — Pre-Retrain Model** (amber, this addendum) — old
   model's proven calibration, also frozen (weights no longer exist).
3. **Calibration Tier Performance tracker** (below both) — the *new* model's
   live results, the only one of the three that will ever move again.

### Cleanup

No temporary endpoints were created for this task — the matrix was computed
entirely from Addendum 12's already-captured raw output (saved locally, not
re-fetched), then hardcoded as a permanent constant
(`PRE_RETRAIN_CALIBRATION_MATRIX`) exactly like `LEAGUE_TIER_MATRIX`. Zero
Odds API or API-Sports calls. No scoring, EV, or live-model code touched.

## Addendum 14 — Comprehensive league × tier evidence table (calibration, continuous edge-vs-ROI, threshold ROI)

Replaces the earlier composite-score approach — no go/no-go scoring, no
automated ranking. Three separate readings on the largest available sample
per reading, using a **diagnostic proxy model**, never the live model.

### Part A — the diagnostic proxy model

**Why a proxy model at all.** The live GBDT model was retrained 2026-08-08
on essentially the entire population (`trainN=40,202` of 50,253 qualifying
fixtures — see [model-versioning.md](model-versioning.md)). It has no
remaining genuinely-unseen recent data to test against. A separate model,
deliberately blind to a recent slice, is the only way to get an honest
out-of-sample read using *current* data patterns rather than Addendum 12's
now-months-old snapshot.

**Holdout window: fixtures dated ≥ 2024-08-07.** A literal last-12-months
window was checked first and rejected — it returned ~0 fixtures for 6 of
the 9 validated leagues, because their 2025-26 seasons haven't started yet
(today is 2026-08-09; European domestic seasons resume mid-August). A
~24-month window gives 206-380 fixtures per league, the same order of
magnitude as Addendum 12's per-league test counts. In football terms this
window is close to "the completed 2024-25 season," plus early 2026-27
fixtures for the three leagues whose seasons start earlier (Eredivisie,
Primeira Liga, Scottish Premiership).

**Confirmed not in the live model's most recent retrain.** Reproduced
`gbdt-train.js`'s exact filter+sort to find the live model's own train/test
boundary: **2022-11-13**. Every fixture in the chosen holdout window
(≥2024-08-07) falls after this — none of it was used to build the live
model's decision trees. (It's possible a portion contributed to the live
model's own Platt-scaling fit, which uses its whole reserved 20%, not a
further-reserved slice — a narrower, secondary form of "seen" than tree
training, worth naming rather than glossing over.)

**The proxy model itself** (`models/gbdt-train-proxy.js` → `DATA_DIR/gbdt-proxy-diagnostic.json`,
loaded via `models/gbdt-proxy.js`): identical architecture and
hyperparameters to the live model, trained only on the 46,394 qualifying
fixtures dated before 2024-08-07 (37,115 train / 9,279 inner-test, the
inner split used only for its own Platt-scaling fit and diagnostic
metrics — the holdout itself is never touched during training in any
capacity). Inner-test log-loss 0.9891 vs linear baseline 1.0316 —
comparable to every other GBDT fit this project has produced.

**Confirmed never wired into anything live**: `models/interface.js` only
ever looks for `gbdt-weights.json` — a different, unrelated file.
`models/gbdt-proxy.js` is a separate module with its own file path, never
required by `interface.js`, `scoreOneFixture()`, or any live route. No
scoring, EV, or live-model code was touched by this task.

### Part B — calibration grid: does the underconfidence pattern hold on current data?

Same proxy model, scored on the held-out window (n=2,825), **and** as a
control, re-scored against Addendum 12's original test-only population
(n=4,054, same 9 leagues, different — earlier and partially overlapping —
date range). This is a **pattern comparison, not a magnitude comparison**:
different model, different window; agreement in direction and shape is the
signal to look for, not identical numbers.

**Pooled calibration — holdout window (n=2,825) vs Addendum 12 window (n=4,054), same proxy model:**

| Tier | Holdout: n, error | Addendum 12 window: n, error |
|---|---|---|
| 35-40% | 423, +0.9pp | 630, +2.7pp |
| 40-45% | 754, +2.0pp | 1,050, +1.3pp |
| 45-50% | 601, −1.7pp | 844, −0.2pp |
| 50-55% | 450, −5.5pp | 653, −6.7pp |
| 55-60% | 253, −6.8pp | 370, −7.9pp |
| 60-65% | 168, −7.4pp | 237, −11.2pp |
| 65-70% | 123, −8.2pp | 183, −9.6pp |
| 70-75% | 51, −16.4pp | 84, −16.2pp |

**Verdict: the pattern holds, clearly.** Both windows show the same shape —
near-perfect calibration through 45%, then a widening underconfidence gap
from 50% onward, reaching double digits by 60-65% and −16pp by 70-75%.
The two windows land within 1-4pp of each other at every tier except
60-65% (holdout −7.4pp vs control −11.2pp, still the same direction and
same order of magnitude). Given this uses a different model trained on a
different population than either of the model versions behind Addendum 12
or the live retrain, this is about as strong a confirmation as this
project can produce that the underconfidence behavior is a structural
property of the modeling approach itself, not an artifact of one
particular training run or window.

**Per-league shrunk grid, holdout window** (raw errorPp(n) → shrunk):

| League | 35-40% | 40-45% | 45-50% | 50-55% | 55-60% | 60-65% | 65-70% |
|---|---|---|---|---|---|---|---|
| Champions League | −10.9(12)→0.9 | −3.7(67)→2.0 | −10.9(53)→−1.7 | −4.9(42)→−5.5 | −11.8(26)→−6.8 | −21.7(6)→−7.4 | −34.0(3)→−13.8 |
| Premier League | −11.4(46)→0.9 | −0.6(109)→2.0 | −3.9(74)→−1.7 | −2.3(62)→−5.5 | +0.8(39)→−6.8 | −5.8(28)→−7.4 | +8.8(17)→+2.2 |
| Ligue 1 | −4.7(65)→0.9 | +8.6(68)→2.0 | −6.9(63)→−1.7 | −9.8(58)→−5.5 | −23.3(26)→−6.8 | −16.2(14)→−7.4 | +22.2(9)→+5.6 |
| Bundesliga | +11.9(56)→0.9 | +7.1(90)→2.0 | +8.8(52)→−1.7 | −0.4(53)→−5.5 | −9.2(21)→−6.8 | −1.6(22)→−7.4 | −12.1(10)→−10.1 |
| Eredivisie | +1.9(49)→0.9 | −0.8(76)→2.0 | −0.5(67)→−1.7 | −7.2(52)→−5.5 | −8.1(29)→−6.8 | −1.2(22)→−7.4 | −20.9(17)→−16.0 |
| Primeira Liga | +2.5(50)→0.9 | +5.4(84)→2.0 | −9.3(62)→−1.7 | −5.6(40)→−5.5 | +2.9(33)→−6.8 | −14.2(17)→−7.4 | −22.0(19)→−17.0 |
| Serie A | +2.8(79)→0.9 | −1.0(106)→2.0 | +4.9(82)→−1.7 | −18.0(47)→−5.5 | −6.1(30)→−6.8 | −5.9(25)→−7.4 | −15.1(11)→−11.7 |
| La Liga | +1.7(46)→0.9 | +4.1(99)→2.0 | +1.7(85)→−1.7 | +3.1(57)→−5.5 | −11.8(35)→−6.8 | −6.2(19)→−7.4 | −8.1(25)→−8.2 |
| Scottish Premiership | +8.9(20)→0.9 | −1.1(55)→2.0 | −2.0(63)→−1.7 | −6.5(39)→−5.5 | +7.1(14)→−6.8 | −10.6(15)→−7.4 | +0.6(12)→−3.6 |

Same near-total shrinkage collapse at most tiers seen in Addendum 13, same
explanation: a 0/1 hit-rate's binomial variance dominates the actual
spread across 9 leagues at these sample sizes. 65-70% retains more
per-league differentiation here (larger raw spread relative to n).

### Part C — continuous edge-vs-ROI curve (full matched-odds population, no threshold)

Every holdout-window fixture with matched Pinnacle odds (n=2,777 — 98.3% of
the holdout population, after a targeted closing-odds backfill, see
"Odds API usage" below) — not just the subset clearing the live 5% edge
threshold. This is explicitly **analysis only** — it does not change the
live EV threshold, and no conclusion here is applied to that threshold.

**Pooled ROI by edge-size band:**

| Edge band | n | ROI |
|---|---|---|
| <0% | 1,735 | −2.9% |
| 0-2% | 78 | −21.9% |
| 2-4% | 84 | −25.8% |
| 4-6% | 62 | −25.7% |
| 6-8% | 77 | −4.3% |
| 8-10% | 45 | +1.1% |
| 10-15% | 128 | −5.1% |
| 15-20% | 90 | +8.8% |
| 20%+ | 478 | −2.5% |

**Pooled ROI by tier (same full matched population, no edge threshold):**

| Tier | n | ROI |
|---|---|---|
| 35-40% | 422 | −5.3% |
| 40-45% | 737 | −8.4% |
| 45-50% | 588 | −6.1% |
| 50-55% | 440 | −1.0% |
| 55-60% | 249 | −3.9% |
| 60-65% | 167 | +1.4% |
| 65-70% | 122 | +9.5% |

**Shape of the relationship: noisy, not monotonic, at current sample
sizes.** The naive expectation — ROI rising smoothly with edge size — does
not hold. The 0-2%, 2-4%, and 4-6% edge bands show the *worst* returns in
the whole table (−21.9% to −25.8%), worse than fixtures with *negative*
model-vs-market disagreement (<0%: −2.9%). Returns partially recover
through 6-10%, dip again at 10-15%, spike at 15-20% (+8.8%, n=90), then
fall back at 20%+ (−2.5%, n=478 — the largest single band, so this number
carries more weight than the others despite still being noisy). The tier
view is comparatively better-behaved — a rough upward drift from 40-45%
through 65-70% — but still not clean, and every band/tier here is well
under rule 6's ~300-400 decision-grade floor individually.

**Per-league detail** (full matched population, no threshold, ROI% by tier):

| League | 35-40% | 40-45% | 45-50% | 50-55% | 55-60% | 60-65% | 65-70% |
|---|---|---|---|---|---|---|---|
| Champions League | +72.5(11) | +14.3(55) | +1.9(46) | +2.1(34) | −15.7(24) | +3.2(5) | +34.5(2) |
| Premier League | +22.0(46) | +1.4(109) | −0.6(74) | −13.6(62) | −13.7(39) | +29.9(28) | −24.8(17) |
| Ligue 1 | +0.6(65) | −29.1(68) | +0.9(63) | +0.7(58) | +22.6(26) | +5.9(14) | −42.0(9) |
| Bundesliga | −24.0(56) | −24.2(90) | −33.8(52) | −7.9(53) | +1.6(21) | −13.4(22) | −5.3(10) |
| Eredivisie | −3.0(49) | −6.6(72) | −13.5(62) | −10.5(51) | 0.0(29) | −16.1(22) | +8.6(17) |
| Primeira Liga | −18.7(50) | −17.7(84) | +18.3(62) | −3.6(39) | −21.8(32) | −0.5(17) | +90.5(19) |
| Serie A | −8.6(79) | −3.2(106) | −19.5(82) | +19.3(47) | −1.6(30) | −7.5(25) | +11.7(11) |
| La Liga | −9.0(46) | −4.7(99) | −5.6(85) | +3.6(57) | +8.7(35) | −0.3(19) | +0.9(25) |
| Scottish Premiership | −27.5(20) | −3.5(54) | −2.1(62) | +7.5(39) | −18.2(13) | +9.5(15) | −6.8(12) |

**This is analysis only.** Whether or where the live EV threshold should
sit is explicitly not decided here — that's a separate future discussion,
flagged, not answered, per this task's own instruction.

### Part D — traditional threshold ROI (posEdge ≥ 5%), for continuity with Addendum 6

Same population as Part C, restricted to the live threshold (posEdgeN=847
of 2,777 matched, 30.5%) — the familiar comparison point.

**Pooled:**

| Tier | n | ROI |
|---|---|---|
| 35-40% | 197 | −7.0% |
| 40-45% | 312 | −6.5% |
| 45-50% | 178 | −4.8% |
| 50-55% | 90 | +10.3% |
| 55-60% | 38 | −12.3% |
| 60-65% | 21 | +47.0% |
| 65-70% | 10 | +158.6% |

**Shrunk per-league grid** (40-45% and 45-50% shown; full 7-tier grid
behind the endpoint output this addendum was generated from):

| League | 40-45% raw (n) → shrunk | 45-50% raw (n) → shrunk |
|---|---|---|
| Champions League | +45.2%(29) → +6.6% | −4.9%(14)* |
| Premier League | −0.2%(44) → −4.3% | −4.9%(22)* |
| Ligue 1 | −50.6%(22) → −15.5% | −4.9%(12)* |
| Bundesliga | −55.5%(34) → −20.4% | −4.9%(9)* |
| Eredivisie | +13.7%(23) → −2.2% | −4.9%(21)* |
| Primeira Liga | −13.6%(36) → −8.6% | −4.9%(20)* |
| Serie A | −10.8%(47) → −8.0% | −4.9%(21)* |
| La Liga | +10.4%(49) → −0.3% | −4.9%(35)* |
| Scottish Premiership | −5.3%(28) → −6.2% | −4.9%(24)* |

*45-50% shrinks to a single pooled value for every league — same
complete-collapse pattern as Addendum 13, expected given ROI's
per-observation variance relative to n here.

The apparent +47%/+158.6% pooled figures at 60-65%/65-70% are n=21/n=10 —
nowhere near decision-grade; not a finding, a warning sign about reading
small cells at face value (same caution as every prior addendum this
project has produced).

### Part E — the three readings side by side

The primary, pooled view — the one table meant to be read directly, no
composite, no ranking:

| Tier | Calibration error (shrunk, n) | Continuous ROI (full matched, n) | Threshold ROI (posEdge≥5%, n) |
|---|---|---|---|
| 35-40% | +0.9pp (423) | −5.3% (422) | −7.0% (197) |
| 40-45% | +2.0pp (754) | −8.4% (737) | −6.5% (312) |
| 45-50% | −1.7pp (601) | −6.1% (588) | −4.8% (178) |
| 50-55% | −5.5pp (450) | −1.0% (440) | +10.3% (90) |
| 55-60% | −6.8pp (253) | −3.9% (249) | −12.3% (38) |
| 60-65% | −7.4pp (168) | +1.4% (167) | +47.0% (21)* |
| 65-70% | −8.2pp (123) | +9.5% (122) | +158.6% (10)* |

*Starred cells are far below rule 6's ~300-400 decision-grade floor —
read as noise, not signal. n differs meaningfully across the three
columns by construction: calibration uses every scored fixture in the
window regardless of odds availability (n=2,825 total), continuous-ROI
uses every fixture with matched Pinnacle odds regardless of edge size
(n=2,777), threshold-ROI uses only posEdge≥5% fixtures (n=847) — each
column is deliberately the largest sample that specific reading supports,
not a common subset.

Full per-league grids for all three readings are in Parts B/C/D above —
this pooled table is the headline read; the per-league grids are there for
anyone who wants to check whether a specific league diverges from the
pooled pattern (per Part B's finding, mostly none do, once shrunk).

### Scope limits (restated explicitly, not just implied)

- **Goals markets remain unvalidated** — every reading in this addendum,
  like every tier-calibration addendum before it, is 1X2 only (confirmed
  no goals-market mixing in Addendum 7). No claim here extends to
  over/under or BTTS markets.
- **Conference League's 2021-2022 gap is a permanent, accepted
  limitation** (Addendum 10-11) — not evaluated in this addendum at all;
  the 9-league scope throughout excludes both Conference League and
  Europa League (neither has a `VALIDATED_SPLITS` boundary to define a
  clean holdout/control comparison against).
- **World Cup is excluded** — zero pure-calibration population exists for
  it (Scope section, page 1 of this document); unaffected by anything in
  this addendum.

### Odds API usage (Part C's only real API-call requirement)

Two attempts, reported in full including the unproductive one:

1. **General-purpose `/api/backfill/closing-odds`** (budget 3,000, scoped
   to the 9 validated leagues): processes fixtures in array order, not
   date-prioritised — spent its entire budget (3,000 credits, 150 calls)
   on older, unrelated gaps elsewhere in these leagues' 2020+ history and
   matched **zero** fixtures in the holdout window specifically.
2. **Targeted backfill** (temp endpoint, scoped to exactly the 51 fixtures
   still missing in the holdout window after (1)): 39 API calls, 780
   credits, matched 3 of 51. The remaining 48 genuinely have no bookmaker
   data available at their exact kickoff minute — consistent with this
   project's established finding (Addendum 10) that most small residual
   gaps are provider-level, not a fetch-methodology problem.

**Total: 3,780 credits, 189 API calls.** Final holdout-window coverage for
the 9 validated leagues: 96.9%-100% for 7 of 9, 98.3% (Scottish
Premiership), 84.7% (Champions League — the lowest, plausibly due to more
varied European-night kickoff times complicating minute-level matching).
Odds API balance confirmed via `/api/odds-credits-status` before and after:
4,936,060 → 4,932,280.

### Calibration-rules.md compliance

Single test-set look: the entire Part B/C/D computation (one comprehensive
temp endpoint, one call) was read exactly once to write this addendum, not
iterated against. The proxy model itself was trained once, before any of
Part C or D's results existed — no tuning, weight change, or retraining
decision was made in response to what those parts showed, satisfying the
"no iterating on the proxy model based on what Part C/D show" constraint
explicitly.

### Cleanup

Temporary endpoints removed after this addendum was written:
`/api/debug/date-distribution`, `/api/debug/holdout-odds-coverage`,
`/api/debug/backfill-holdout-odds-targeted`, `/api/debug/evidence-table`.
**Permanent additions, kept**: `models/gbdt-proxy.js`,
`models/gbdt-train-proxy.js`, `scripts/gbdt-train-proxy.js`,
`DATA_DIR/gbdt-proxy-diagnostic.json` (the trained proxy weights),
`runGbdtProxyTrain()` + `POST /api/admin/trigger-proxy-train` +
`GET /api/admin/proxy-train-status` (so this proxy can be retrained again
in the future without rebuilding the mechanism from scratch). No changes
to `models/interface.js`, live scoring, the live EV threshold, or
`LEAGUE_CONFIG`.

### Extension — cleared vs. blocked: is the threshold excluding real value?

Addendum 14's continuous-ROI column blended fixtures that would become a
real recommended bet with fixtures that were blocked from ever becoming
one. This disaggregates that column, per tier, into the two groups
explicitly — not inferred by subtraction, computed directly from the same
per-fixture holdout-window population Addendum 14 already scored (zero
new odds/API calls, zero re-fit, same single test-set look, just split a
different way).

**The actual EV threshold, from the code, stated plainly.** There is
**no direct "edge ≥ X%" gate** in the live bet-creation path. The real
gate is `successScore < settings.successThreshold` (server.js's pre-match
lock, `scoring.js`'s `computeSuccessScore()`) — a **single global value,
currently 40**, not per-league. `successScore` is a composite, not a raw
edge percentage:

```
winComp        = modelProb × 35
valueComp      = min(edge / 0.20, 1) × 45        // edge-vs-book, capped at 20%+
confidenceComp = min(formFixtureCount / 50, 1) × 19
base            = round(min(99, winComp+valueComp+confidenceComp)) × (0.4 + dataConf×0.6)
→ applyEdgeCap(base, edge, leagueId)              // Premier League exempted; others halved above 20% edge
→ applyDivergencePenalty(..., context)            // international only, large model–market gaps penalised
```

**Every prior addendum in this document — including Addendum 14's
"threshold-ROI" and this extension's "cleared" group — uses `edge ≥ 5%`
vs Pinnacle as an analytical proxy for "would become a bet", not this
literal formula.** That's a deliberate, longstanding simplification, not
an error introduced here: `computeSuccessScore()` needs
`formFixtureCount` and `dataConf`, neither of which is stored in the
historical calibration population (`scoredRecords` only carries
`homeFactors`/`awayFactors`/`actualOutcome`/context). Reproducing the
literal live gate offline isn't possible with the data this whole
document has ever used — flagging the distinction explicitly now because
this task specifically asked for the real code-level threshold, not
because the proxy convention has changed.

**Pooled split, every tier** (cleared = edge≥5%, matches Addendum 14's
threshold-ROI n exactly at every tier — confirmed as the requested sanity
check; blocked = 0%≤edge<5%; negative = edge<0%, reported for
transparency so the three sum back to Addendum 14's continuous-ROI total):

| Tier | Cleared: n, ROI, 95% CI | Blocked: n, ROI, 95% CI | Negative: n, ROI |
|---|---|---|---|
| 35-40% | 197, −7.0%, [−28.9, +14.9] | 20, −6.9%, [−64.0, +50.3]* | 205, −3.4% |
| 40-45% | 312, −6.5%, [−23.0, +10.1] | **49, −60.9%, [−86.0, −35.8]** | 376, −3.1% |
| 45-50% | 178, −4.8%, [−24.8, +15.1] | 51, −27.8%, [−56.2, +0.5] | 359, −3.6% |
| 50-55% | 90, +10.3%, [−24.1, +44.8] | 36, −12.9%, [−45.2, +19.4] | 314, −2.8% |
| 55-60% | 38, −12.3%, [−47.8, +23.2] | 22, −2.6%, [−40.6, +35.5]* | 189, −2.4% |
| 60-65% | 21, +47.0%, [−65.8, +159.8]* | 11, −41.3%, [−89.4, +6.9]* | 135, −2.3% |
| 65-70% | 10, +158.6%, [−162.9, +480.1]* | 5, −8.2%, [−81.7, +65.3]* | 107, −3.7% |

*Below the n<30 decision-grade floor for that specific cell.

**The one tier with enough blocked-group volume to say something real:
40-45% (n=49, CI [−86.0%, −35.8%] — excludes zero entirely).** Blocked
bets at this tier didn't just underperform cleared bets (−6.5%), they
were catastrophic — worse than doing nothing, worse than the negative-edge
group. 45-50% (n=51) points the same direction (−27.8%) with a CI that
nearly excludes zero (upper bound +0.5%). Every other tier's blocked
group is too thin (n=5-36, several starred) to support a real
conclusion — this is not a case of "no signal anywhere," it's "real
signal at the one tier with real volume, genuine uncertainty elsewhere."

**Edge-size distribution within the blocked group (pooled, n=195):**

| Sub-band | n | ROI | 95% CI |
|---|---|---|---|
| 0-1% | 40 | −4.9% | [−37.0, +27.1] |
| 1-2% | 38 | **−39.7%** | [−68.6, −10.7] |
| 2-3% | 43 | −29.7% | [−61.1, +1.7] |
| 3-4% | 41 | −21.8% | [−54.0, +10.4] |
| 4-5% | 33 | **−53.9%** | [−84.9, −22.9] |

Mean edge 2.42%, median 2.52% — **roughly uniform across the whole 0-5%
range, not clustered just under the threshold.** If blocked bets were
mostly "almost qualified" (edges bunched near 4-5%), that would suggest
the threshold sits slightly too high. That isn't what this shows: volume
is spread evenly from 0% to 5%, and returns are negative in every
sub-band, including two (1-2%, 4-5%) whose CIs exclude zero outright.

**Answer to the question this task asked: no evidence the threshold is
wrongly excluding real value.** Where there's enough volume to judge
(40-45%, and suggestively 45-50%), blocked bets performed as badly or
worse than cleared bets in the same tier, across the full range of
sub-threshold edge sizes — not concentrated at the boundary in a way that
would argue for lowering it. This reads as the threshold correctly
filtering weak edges at those tiers, not as a too-conservative cutoff
leaving money on the table. Every other tier remains genuinely
inconclusive on current volume — a fact to carry forward, not paper over.

**Per-league**: computed and available, but not reproduced here in full —
essentially every per-league blocked cell is n<15 (many n=0-2), far below
even the n<30 single-cell flag, let alone rule 6's ~300-400 floor. The
one partial exception, 40-45% pooled across leagues, is broadly consistent
in direction across leagues that have any volume there (Ligue 1, Premier
League, Eredivisie all −100% on n=4-6; Bundesliga −20.8%; Primeira Liga
−40.1%; Serie A −50.7%; La Liga −65.6%; one n=1 Scottish Premiership
outlier at +128%) — not one league driving the pooled result.

**Compliance**: single test-set look, disaggregating Addendum 14's
already-computed population — no re-fit, no new criteria applied to the
proxy model, no change to the live threshold, scoring, or bet-triggering
logic. Zero new Odds API or API-Sports calls (confirmed — this used only
already-cached `closing-odds.json` from Addendum 14's backfill).

**Cleanup**: temporary `/api/debug/threshold-split` endpoint removed after
this write-up.

### Extension 2 — re-cut against a 1% edge threshold, plus a 1/2/3/5% sensitivity table

The previous extension used 5% edge as "cleared." Given real-world
execution (manual line-shopping against soft books) can plausibly add
value on top of whatever edge exists vs. Pinnacle, a lower, more
realistic bar — **1% edge** — is worth reading directly, not just implied
by comparing two endpoints. Same population, same proxy model, same
holdout window as Addenda 14-15 — **zero new API calls**, confirmed:
this re-slices the identical per-fixture records already scored and
odds-matched for that work.

**Pooled, cleared (edge≥1%) vs. blocked (edge<1%, including negative), every tier:**

| Tier | Cleared: n, ROI, 95% CI | Blocked: n, ROI, 95% CI |
|---|---|---|
| 35-40% | 214, −8.2%, [−28.9, +12.5] | 208, −2.3%, [−16.4, +11.9] |
| 40-45% | 351, −12.7%, [−27.9, +2.4] | 386, −4.4%, [−14.1, +5.3] |
| 45-50% | 218, −10.2%, [−27.6, +7.1] | 370, −3.6%, [−12.3, +5.2] |
| 50-55% | 121, **+3.3%**, [−23.9, +30.5] | 319, −2.6%, [−10.8, +5.7] |
| 55-60% | 54, −14.9%, [−43.1, +13.3] | 195, −0.8%, [−10.1, +8.4] |
| 60-65% | 28, +27.7%, [−58.7, +114.1]* | 139, −3.9%, [−13.8, +5.9] |
| 65-70% | 14, +106.5%, [−125.0, +338.0]* | 108, −3.1%, [−13.1, +6.9] |

*n<30, below the single-cell decision-grade flag.

At this lower bar, sample sizes roughly double at most tiers (as
expected — more fixtures clear a 1% bar than a 5% one), but four of seven
tiers (35-40%, 40-45%, 45-50%, 55-60%) are still net negative even with
the larger n. Widening the population didn't turn losers into winners at
those tiers — if anything 40-45%'s already-negative 5%-threshold result
(−6.5%) gets *more* negative at 1% (−12.7%), on nearly double the n
(351 vs 312) — a real, better-evidenced negative, not noise fading out.

**Threshold-sensitivity table (cleared-group n, ROI at each bar, pooled):**

| Tier | 1% (n, ROI) | 2% (n, ROI) | 3% (n, ROI) | 5% (n, ROI) |
|---|---|---|---|---|
| 35-40% | 214, −8.2% | 212, −7.3% | 202, −8.0% | 197, −7.0% |
| 40-45% | 351, −12.7% | 344, −11.6% | 334, −10.4% | 312, −6.5% |
| 45-50% | 218, −10.2% | 211, −9.2% | 198, −4.3% | 178, −4.8% |
| 50-55% | 121, **+3.3%** | 111, **+3.8%** | 107, **+2.2%** | 90, +10.3% |
| 55-60% | 54, −14.9% | 48, −11.7% | 44, −11.7% | 38, −12.3% |
| 60-65% | 28*, +27.7% | 27*, +32.4% | 25*, +30.1% | 21*, +47.0% |
| 65-70% | 14*, +106.5% | 10*, +158.6% | 10*, +158.6% | 10*, +158.6% |

*n<30 at every bar shown — 60-65% and 65-70% never reach a large enough
sample to say anything, at any threshold tested here.

**The pattern is remarkably threshold-stable within a tier.** Moving the
bar from 1% to 5% barely changes the sign or rough magnitude of the
result at 35-40%, 40-45%, 55-60% (all negative throughout), or 60-65%/
65-70% (both positive-but-thin throughout, same n territory). n changes,
the verdict mostly doesn't — the exception is 45-50% and 50-55%, where
lower thresholds pull in more marginal fixtures that measurably dilute
(45-50%: −4.8% at 5% vs −10.2% at 1%) or don't change the direction at
all (50-55% stays positive at every single bar tested).

**The tier worth specifically flagging: 50-55%.** It is the *only* tier
that is net positive at every one of the four thresholds tested, on a
non-thin sample throughout (n=90-121, never below 30). At the 3%
threshold specifically it lands almost exactly in the "+1-2% realistic
target" zone this task asked about: **n=107, ROI +2.2%**. This is the
most credible-looking result in the whole re-cut — modest, not a wild
implausible swing, and stable in sign across every threshold rather than
flipping.

**How close does it come, and what would tighten it?** Not close on
statistical significance terms — every CI here still fully spans zero.
Using the standard volatility-based estimate (95% CI half-width =
1.96·σ/√n; solving for the n where that half-width first drops below the
current point estimate, holding the effect size and per-bet volatility
fixed): at 1% edge, σ≈1.53 (typical for 0/1 outcomes on ~evens-priced
odds), giving **n≈8,200** to reach significance at a +3.3% effect — over
60× the current sample. At 3% edge (the "nicest-looking" cut, +2.2%),
volatility is similar (σ≈1.58) but the smaller effect size pushes the
requirement to **n≈20,500**. At 5% edge, the larger observed effect
(+10.3%) needs "only" **n≈1,000** — still roughly 11× today's n=90, but
the first threshold in this table where "collect a few more seasons"
is a remotely realistic path rather than a multi-decade one.

**Reading this honestly: 50-55% is the one genuinely promising
direction, not a confirmed finding.** Positive, stable in sign across
every threshold tested, on the largest non-thin cleared-group sample of
any tier below 5% — but the per-bet volatility inherent to odds in this
range means even the best-looking cut here (n=107, +2.2%) would need
roughly 20,000 fixtures to become statistically distinguishable from
zero at its current effect size. That is not a near-term validation
path from backtest data alone; it's a specific, named direction worth
watching as live paper-trade volume accumulates in this probability
range, not a result to act on from this reading.

**Per-league**: computed, but not reproduced in full — cleared-group n
per (league, tier) at the 1% threshold ranges 0-56, i.e. every single
per-league cell is thin or borderline-thin. For 50-55% specifically
(the pooled standout), per-league cleared ROI ranges from −38.5%
(Eredivisie, n=11) to +42.5% (Serie A, n=11) — directionally
all over the place on tiny samples, exactly what you'd expect from
noise around a genuinely modest pooled effect, not a sign that one
league is driving the pooled +3.3%.

**Compliance**: same single test-set look as Addenda 14-15, re-sliced —
no re-fit, no new criteria applied to the proxy model itself, no change
to the live threshold. Confirmed zero new Odds API or API-Sports calls:
this endpoint reads only `backfill-historical.json` and the
already-cached `closing-odds.json`, both fully populated by prior work.

**Cleanup**: temporary `/api/debug/threshold-sensitivity` endpoint
removed after this write-up.

### Extension 3 — deep dive on the 50-55% tier before real money starts there

Prompted directly by Extension 2: 50-55% was the only tier net positive
at every threshold tested. Before treating that as a green light, this
looks at what's actually inside the number — per league, per pick type,
across time, and against the calibration reading for the same tier.
Uses the edge≥1% cleared population (n=121, the same one flagged as
"closest to the target zone") for the ROI breakdowns, and the full
holdout-window tier population (n=450, matches Addendum 14's Part B
figure exactly) for calibration. **Zero new API calls** — same
population, same proxy model, re-sliced again.

**Per-league, real numbers (cleared, edge≥1%):**

| League | n | ROI | 95% CI |
|---|---|---|---|
| Champions League | 12 | −23.1% | [−87.6, +41.5] |
| Premier League | 10 | −12.8% | [−83.6, +58.0] |
| Ligue 1 | 7 | −1.4% | [−92.9, +90.0] |
| Bundesliga | 19 | −10.2% | [−59.6, +39.3] |
| Eredivisie | 11 | −38.5% | [−102.3, +25.4] |
| Primeira Liga | 13 | +21.2% | [−43.0, +85.3] |
| Serie A | 11 | +42.5% | [−25.4, +110.3] |
| La Liga | 23 | +17.0% | [−88.5, +122.6] |
| Scottish Premiership | 15 | +19.7% | [−50.9, +90.4] |

**Every single league is below n=30 — none of these individually say
anything.** Five leagues negative, four positive, split roughly down the
middle — exactly the pattern you'd expect from noise scattered around a
modest positive pooled mean, not one bad or one good league quietly
driving the +3.3% headline. No league can be ruled in or out here.

**Pick-type breakdown — this is the real finding.** Draws are never the
tier's top pick (draw probability essentially never reaches 50-55% as
the single highest of the three outcomes in this population, n=0
throughout). Home vs. away splits as follows:

| Pick type | n | ROI | 95% CI |
|---|---|---|---|
| Home | 107 | **−0.8%** | [−30.6, +29.1] — n≥30, not thin |
| Away | 14 | +34.4% | [−20.5, +89.2] — thin |

**The pooled +3.3% is not a broad home-and-away effect — it's a flat,
well-powered home-pick population (88% of the cleared bets) plus a
thin, wide-CI away subset pulling the average up.** Weighted check:
(107×−0.8 + 14×34.4)/121 = +3.3%, exactly reproducing Extension 2's
headline figure. If real-money betting started on this tier
indiscriminately, the large majority of actual bets (home picks) would
be going in on a population that, on the best-powered read available,
looks like a coin flip on returns — not the positive signal the pooled
number implies.

**Calibration cross-check, by pick type — genuinely coherent.** The
55-70pp home/away n's here are large enough to trust directionally:

| Pick type | n | Mean pred | Hit rate | Calibration error |
|---|---|---|---|---|
| Home | 338 | 52.4% | 55.9% | −3.6pp |
| Away | 112 | 52.2% | 63.4% | **−11.2pp** |

Away picks are almost three times more underconfident than home picks
in this tier, on a genuinely well-powered calibration sample (n=112,
not thin) — and away is also the pick type showing the better (if
thin) ROI. **This is one real, consistent story, not two coincidentally
aligned numbers**: the tier's underconfidence is itself concentrated in
away picks, and that's exactly where the (thin) positive ROI shows up
too. It just doesn't rescue the headline number, because away picks are
a small fraction (12%) of the cleared population.

**Calibration cross-check, by league — mixed, inconclusive.** Serie A
shows the tier's largest calibration gap (−18.0pp, n=47, not thin) and
also its best ROI point estimate (+42.5%, n=11) — consistent. But
Eredivisie shows a real calibration gap too (−7.2pp, n=52) alongside
*negative* ROI (−38.5%, n=11) — inconsistent. La Liga is the tier's one
league that isn't underconfident at all (+3.1pp, essentially flat or
mildly overconfident) yet shows positive ROI (+17.0%, n=23) — also
inconsistent. With every league's ROI cell thin, this cross-check can't
be resolved either way at the league level — only the pick-type split
had enough calibration-side power to draw a real conclusion.

**Time distribution — not clustered, this part checks out clean.** Full
tier population (n=450) spreads 35-57 fixtures per month across all ten
months of the holdout window with no gap or spike. The cleared subset
(n=121) is thinner per month (8-18) but shows the same pattern — no
single month or short window is quietly generating the pooled result.

| Month | Full tier n | Cleared n |
|---|---|---|
| 2024-08 | 35 | 8 |
| 2024-09 | 41 | 18 |
| 2024-10 | 41 | 9 |
| 2024-11 | 38 | 8 |
| 2024-12 | 57 | 14 |
| 2025-01 | 43 | 10 |
| 2025-02 | 46 | 9 |
| 2025-03 | 50 | 16 |
| 2025-04 | 50 | 12 |
| 2025-05 | 49 | 17 |

**Plain verdict: the signal is narrower and more fragile than the
pooled headline suggested — this closer look changes the confidence
level, not just adds detail.** Two of the four checks come back clean
(no single league, no single time window is secretly driving the
result). But the pick-type breakdown — the one check with enough power
on both sides (calibration and, partially, ROI) to actually resolve
something — shows the positive pooled number is concentrated in a small,
thin away-pick minority while the dominant home-pick majority reads as
flat. The calibration story for that split is genuinely coherent (away
picks are both more mispriced and better-performing), which is worth
carrying forward as a specific, narrower hypothesis — but it is not the
same claim as "the 50-55% tier is a broad, ready-to-go positive edge."
**Recommendation for how this should change near-term confidence:** if
real money starts here at all, this data argues against treating the
whole tier uniformly — the home-pick majority has no demonstrated edge
in this reading, and the away-pick minority that does is far too thin
(n=14) to size a real bet around with any confidence. The honest
position is closer to "one specific, narrower thread worth continued
paper-trade tracking" than "this tier is validated."

**Compliance**: same single test-set look, re-sliced by league/pick-type/
date — no re-fit, no new criteria applied to the proxy model, no change
to live scoring or the live threshold. Confirmed zero new Odds API or
API-Sports calls: this endpoint reads only `backfill-historical.json`
and the already-cached `closing-odds.json`.

**Cleanup**: temporary `/api/debug/tier-5055-deep-dive` endpoint removed
after this write-up.

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
   fixtures) for no protection against a decision that isn't being made.
   **Re-checked directly in the Addendum, Part A** — test-only figures show
   the same or a larger underconfidence gap than mixed, so this choice was
   not flattering the headline finding.
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
   order alone as a readiness signal. **Addressed directly in the Addendum,
   Part B** — a filtered second table shows the four validated leagues
   ranked against each other only, using the same scores, not a re-weighted
   formula.

## Cleanup

The temporary `/api/debug/tier-calibration`, `/api/debug/tier-calibration-v2`,
`/api/debug/platt-recalibration`, `/api/debug/platt-roi-by-tier`,
`/api/debug/train-test-cycle`, `/api/debug/tier-baseline-wide`,
`/api/debug/league-tier-matrix`, `/api/debug/odds-history-floor-check`,
`/api/debug/expanded-tier-check`, `/api/debug/dataset-integrity-check`,
`/api/debug/bookmaker-enumeration`, and `/api/debug/softbook-coverage-check`
endpoints have all been removed — the
league-tier-matrix one's output was hard-coded into the permanent
`/api/league-tier-matrix` endpoint (`LEAGUE_TIER_MATRIX`), same pattern as
`HISTORICAL_TIER_BASELINE`. `shrinkage.js` is kept as permanent, reusable
infrastructure — it has no
dependency on this specific dataset and is written to be called again for any
future shrinkage need (e.g. a later per-tier ROI cycle, or shrinking home/away
base-rate estimates directly). The Platt-scaling fit from Addendum 2 was
**not** productionised anywhere — it exists only as the parameters quoted in
that section, not as code in any live path.
