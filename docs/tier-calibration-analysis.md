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
`/api/debug/train-test-cycle`, `/api/debug/tier-baseline-wide`, and
`/api/debug/league-tier-matrix` endpoints have all been removed — the last
one's output was hard-coded into the permanent `/api/league-tier-matrix`
endpoint (`LEAGUE_TIER_MATRIX`), same pattern as `HISTORICAL_TIER_BASELINE`.
`shrinkage.js` is kept as permanent, reusable
infrastructure — it has no
dependency on this specific dataset and is written to be called again for any
future shrinkage need (e.g. a later per-tier ROI cycle, or shrinking home/away
base-rate estimates directly). The Platt-scaling fit from Addendum 2 was
**not** productionised anywhere — it exists only as the parameters quoted in
that section, not as code in any live path.
