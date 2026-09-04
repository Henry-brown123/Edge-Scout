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

> **Caveat added 2026-09-04 (Addendum 37).** Every figure in this addendum, including the widened tier baseline that server.js still serves as HISTORICAL_TIER_BASELINE, was scored by the
> 2026-07-25 model, whose trees were trained on the earliest 80% (by date) of
> the checked-in 8,316-record snapshot — a slice running to 2024-11-19 that
> overlaps the `testFrom` windows it was then used to "hold out". Ligue 1 60%, La Liga 56%, Premier League 53%, Bundesliga 53%, Serie A 24% of each league's test-window fixtures were in that model's tree-training set (Champions League 60%; Scottish Premiership, Eredivisie, Primeira Liga, Europa League and Conference League 0% — those competitions were absent from the snapshot altogether). Measured directly on the checked-in file, 2026-09-04.
> The base-rate tuning discipline described here was real; the *scoring model*
> was not clean for the leagues named. Treat those leagues' figures as partly
> in-sample, not held-out. Figures are left unchanged for the record.

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

> **Caveat added 2026-09-04 (Addendum 37).** Every cell in this matrix was scored by the
> 2026-07-25 model, whose trees were trained on the earliest 80% (by date) of
> the checked-in 8,316-record snapshot — a slice running to 2024-11-19 that
> overlaps the `testFrom` windows it was then used to "hold out". Ligue 1 60%, La Liga 56%, Premier League 53%, Bundesliga 53%, Serie A 24% of each league's test-window fixtures were in that model's tree-training set (Champions League 60%; Scottish Premiership, Eredivisie, Primeira Liga, Europa League and Conference League 0% — those competitions were absent from the snapshot altogether). Measured directly on the checked-in file, 2026-09-04.
> The base-rate tuning discipline described here was real; the *scoring model*
> was not clean for the leagues named. Treat those leagues' figures as partly
> in-sample, not held-out. Figures are left unchanged for the record.

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

> **Correction added 2026-09-04 (Addendum 37).** This part's closing claim —
> that the live model "has not been touched by any of the data this whole
> document's tier-calibration analysis is built on" — is false as written. It
> holds for the 2010-2019 ingestion this part is about, and for Scottish
> Premiership, Eredivisie, Primeira Liga, Europa League and Conference League
> (absent from the 8,316-record snapshot). It does not hold for Premier League,
> La Liga, Bundesliga, Ligue 1, Serie A or Champions League: the snapshot's
> chronological 80% training slice runs to 2024-11-19 and contains 24-60% of
> each of those leagues' `testFrom` windows (Ligue 1 60%, La Liga 56%, Premier League 53%, Bundesliga 53%, Serie A 24% of each league's test-window fixtures were in that model's tree-training set (Champions League 60%; Scottish Premiership, Eredivisie, Primeira Liga, Europa League and Conference League 0% — those competitions were absent from the snapshot altogether). measured directly on the checked-in file).
> The rest of Part B (the DATA_DIR bug, the `trainN` arithmetic) stands.

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

> **Caveat added 2026-09-04 (Addendum 37).** This "frozen live GBDT model" baseline was scored by the
> 2026-07-25 model, whose trees were trained on the earliest 80% (by date) of
> the checked-in 8,316-record snapshot — a slice running to 2024-11-19 that
> overlaps the `testFrom` windows it was then used to "hold out". Ligue 1 60%, La Liga 56%, Premier League 53%, Bundesliga 53%, Serie A 24% of each league's test-window fixtures were in that model's tree-training set (Champions League 60%; Scottish Premiership, Eredivisie, Primeira Liga, Europa League and Conference League 0% — those competitions were absent from the snapshot altogether). Measured directly on the checked-in file, 2026-09-04.
> The base-rate tuning discipline described here was real; the *scoring model*
> was not clean for the leagues named. Treat those leagues' figures as partly
> in-sample, not held-out. Figures are left unchanged for the record.

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

> **Caveat added 2026-09-04 (Addendum 37).** Every calibration-error cell here was scored by the
> 2026-07-25 model, whose trees were trained on the earliest 80% (by date) of
> the checked-in 8,316-record snapshot — a slice running to 2024-11-19 that
> overlaps the `testFrom` windows it was then used to "hold out". Ligue 1 60%, La Liga 56%, Premier League 53%, Bundesliga 53%, Serie A 24% of each league's test-window fixtures were in that model's tree-training set (Champions League 60%; Scottish Premiership, Eredivisie, Primeira Liga, Europa League and Conference League 0% — those competitions were absent from the snapshot altogether). Measured directly on the checked-in file, 2026-09-04.
> The base-rate tuning discipline described here was real; the *scoring model*
> was not clean for the leagues named. Treat those leagues' figures as partly
> in-sample, not held-out. Figures are left unchanged for the record.

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

## Addendum 15 — Carabao Cup, League One, League Two: added paper-only, held aside as an untouched future test population

Three new competitions were added to `LEAGUE_CONFIG`/`LEAGUES` this cycle —
Carabao Cup (2026-08-10), League One and League Two (2026-08-10, same day).
This addendum records the coverage findings and, more importantly, the
status of the data now flowing in: **none of it has been calibrated,
tuned, or read for ROI. It is deliberately being left alone.**

### Coverage findings (real calls, not assumptions — same method as every prior check)

| Competition | API-Sports ID | Historical depth | Odds API sport key | Pinnacle coverage | Matchbook | Marathon Bet |
|---|---|---|---|---|---|---|
| Carabao Cup (League Cup) | 48 | 2011-2026 (16 seasons), stats from 2015, ~93 fixtures/season | `soccer_england_efl_cup` | ~100% (66 fixtures sampled across Preliminary Round + Round of 128) | ~100% | 97% (30/31) |
| League One | 41 | 2011-2026 (16 seasons), stats from 2024, ~557 fixtures/season | `soccer_england_league1` | 100% (opening day + mid-season-2025 samples) | high | high |
| League Two | 42 | 2011-2026 (16 seasons), stats from 2024, ~557 fixtures/season | `soccer_england_league2` | 100% (opening day + mid-season-2025 samples) | high | high |

No early-round/lower-tier sparsity found for any of the three, unlike the
Conference League qualifying-round pattern documented earlier in this doc —
English domestic football markets are consistently deep even at the
smallest-club end.

### Why nothing here has been calibrated

`LEAGUE_CONFIG[48]`, `[41]`, `[42]` deliberately carry no
`avgHomeWinRate`/`avgDrawRate`/`avgAwayWinRate`/`avgGoalsPerGame` —
`applyLeagueBiasCorrection()` was given a guard so it skips its 30%
live-blend entirely when those are absent, rather than blending toward an
invented number. `marketEfficiency`/`drawBaseWeight`/`homeAdvBaseWeight`
are set to `1.0` — a genuine no-op, not a guess. All three leagues are
`paper_only` in `leagueModes` (hard block, confirmed via a live 403 on
`POST /api/league-modes/{id}` with `mode: 'real'`), and are absent from
`TIER_PERF_VALIDATED_LEAGUES` — no train/test split exists, so none of the
tracker/grid work elsewhere in this doc treats them as validated.

### What this means going forward

As fixtures accumulate for these three competitions, that data is sitting
untouched — the same status the pre-2010 backfill population had before
the 2010-2019 expansion, and the same status the full population had before
the Final Pre-Retrain Baseline (Addendum 12). Per house rule 10
(`docs/calibration-rules.md`), it should stay untouched until a deliberate,
documented baseline read is run against it — the same shape as Addendum
12's Phase 1 — not folded into calibration piecemeal or peeked at for ROI
"just to see." That read is future work, not part of this addendum.

### Cross-competition input siloing (Part C of the task this addendum accompanies)

Two different layers, two different answers:

- **Primary scoring factors** — `formScore`/`xgScore`/`defenseScore`/
  `momentumScore` inside `scoreOneFixture()` are computed against
  `scoringPool` (= `formFixtures`, the specific fixture's own
  `league=leagueId&season=...` fetch plus that same league's slice of the
  historical backfill). **Genuinely siloed per competition** — a club
  playing across two tracked competitions (e.g. a League One side now also
  in the Carabao Cup) gets its League One score computed from League One
  matches only, and vice versa. Notably, `context === 'international'`
  already has a bespoke fix for exactly this problem (blends in the full
  international historical pool — qualifying, Nations League, etc. —
  because World Cup fixtures have no pool of their own), but that blend
  is `international`-only; it was never extended to `club_domestic`/
  `club_european`.
- **Team profile modifiers** (WOWY/PIR/momentum/transfer adjustments via
  `applyTeamProfileModifiers`, built by `updateTeamProfiles()`) get
  **partial, accidental** cross-competition blending: `runMorningScan`
  accumulates fixtures from every league in that scan's batch into one
  `allFormFixtures` pool before rebuilding profiles once at the end, so a
  team appearing in two of *that day's scanned leagues* has both folded
  into its profile. This isn't a deliberate design — it's a side effect of
  batching, it's all-or-nothing per scan (a league scanned alone rebuilds
  profiles from only that league, potentially discarding cross-competition
  richness a fuller batch previously gave them), and it doesn't
  incrementally merge — each call overwrites.

Net: real input-level siloing exists, it's not uniform across the
pipeline, and the international context already shows the shape of a fix.
Scoped as a proposal (not implemented) in this task's report.

## Addendum 16 — Historical scoring pool is globally unscoped by league (not siloed like the pre-fix live path) — decision on how the Carabao Cup/League One/League Two backfill uses it

Addendum 15's siloing finding was about the **live** path
(`scoreOneFixture`'s `scoringPool`). A follow-up task generalized the
live path's `international`-context blend to club cup competitions
(Carabao Cup/CL/EL/Conference League): a gated, live per-team domestic-form
fetch (`fetchTeamDomesticForm`), deliberately one-directional — domestic
leagues' own fixtures never enter the blend branch, by construction. That
fix is done and deployed (commit `4d2ce32`).

Before running a large historical backfill for the same three competitions,
this addendum checks whether the **historical** scoring path
(`scoreFixtureFromPool` in `weightOptimiser.js`, used by
`runHistoricalBackfill`) has the same siloing problem and needs an
analogous fix.

### Finding: it does not silo by league at all — it never has

`scoreFixtureFromPool` takes a `teamIndex` built once per backfill run by
`buildTeamIndex(allFixtures)`, where `allFixtures` is *every* fixture
across *every* league currently in `HISTORICAL_BACKFILL_CONFIG`, merged
into one global `Map` keyed by fixture ID. `buildTeamIndex` groups this
global list by team ID with **no league filter at all** — a team's pool is
every fixture it has ever played in any tracked competition, date-filtered
to before the fixture being scored (no lookahead), full stop.

Confirmed empirically, not just by reading the code — a temp diagnostic
endpoint (`/api/debug/historical-pool-check`, removed after use) rebuilt
the real `teamIndex` from the already-cached `backfill-historical.json`
and reported what a real team's pool actually contains. Manchester City
(team id 50):

| League | Fixtures in pool | Seasons | Date range |
|---|---|---|---|
| Premier League (39) | 570 | 2010–2024 | 2010-08-14 to 2025-05-25 |
| UEFA Champions League (2) | 135 | 2011–2024 | 2011-09-14 to 2025-02-19 |

Man City's Premier League fixtures have been scored, this whole time,
against a pool that already includes their Champions League matches,
completely undifferentiated. This is not a bug introduced by this task —
it's how `scoreFixtureFromPool` has always worked, for every team that
appears in more than one `HISTORICAL_BACKFILL_CONFIG` league. It also
means the thing the live-path fix had to build (a deliberate blend of a
team's domestic history into its cup-fixture pool) is, for the historical
path, **already happening automatically** — a cup fixture's pool already
draws on whatever else that team has played in any tracked league, no new
code required, *provided the relevant domestic league is itself in
`HISTORICAL_BACKFILL_CONFIG`*.

### The decision this forces

The task's brief asked for the historical fix to be "one-directional"
the same way the live fix is — domestic leagues' own historical scoring
staying completely untouched, verified empirically. The finding above
means that property **does not hold today** (PL is already blended with
CL for co-occurring teams) and **cannot be made to hold going forward**
without a materially different, riskier change: adding a context-gate to
`scoreFixtureFromPool` so only cup fixtures draw cross-competition data,
and domestic-only fixtures are newly restricted to their own league.

That gate was considered and explicitly not built. Two reasons:

1. **Already-scored records are frozen.** `runHistoricalBackfill` skips
   any fixture already in `scoredRecords` (`if (scoredMap.has(...))
   continue`) unless `rescore: true` is passed, which this task does not
   do. So nothing about the *existing* PL/La Liga/Serie A/Bundesliga/
   Ligue 1/Scottish Prem/Eredivisie/Primeira Liga/CL/EL scored population
   changes as a result of this backfill, regardless of which option was
   chosen here.
2. **A gate would only change behavior for *newly scored* domestic-league
   fixtures from now on** — meaning PL fixtures scored before the gate
   include CL blend, and PL fixtures scored after it would not. That's a
   regime change partway through an already-relied-upon, already-trained-
   on population (the live GBDT model was trained on this exact
   `scoredRecords` set — see Addendum 12). Introducing that split was
   judged higher-risk than the alternative: extending the existing,
   already-live-for-years global-pool behavior to three more leagues,
   which changes nothing about *how* scoring works, only *what's in the
   pool* going forward.

**Decision (confirmed with the user before implementation): rely on the
existing global pool.** No new gating code was added to
`scoreFixtureFromPool`. Carabao Cup/League One/League Two fixtures enter
the same global `fixtureMap` as every other tracked league. Concretely,
this means: going forward, Premier League, League One, and League Two
fixtures scored *for the first time* from this point on will have Carabao
Cup matches mixed into their pool too — the same category of effect CL/EL
have already had on PL/La Liga/Serie A/Bundesliga/Ligue 1/Scottish Prem/
Eredivisie/Primeira Liga for years, just extended to a few more
competitions. It is not a new kind of risk, and it does not touch any
fixture already scored.

### What this means for the backfill

No implementation changed for Part A/B of the accompanying task beyond
this decision itself. Promotion/relegation handling is covered separately
below. The backfill (Part C/D) proceeds using the pipeline exactly as it
already exists — the finding here is that no analogous "domestic blend"
code needed to be written, because the historical pipeline was never
siloed the way the live pipeline was before its own fix.

## Addendum 17 — Carabao Cup, League One, League Two: full historical ingestion and scoring complete

Following Addendum 16's finding (no pool-filtering fix needed) and a
confirmed-correct promotion/relegation read (both `buildStandingsIndex`
and `classifyFixture` derive division context from each fixture's own
recorded `league.id`/`season`, never from an external "current team
division" lookup — there is no such lookup anywhere in the codebase), the
three competitions were added to `HISTORICAL_BACKFILL_CONFIG` (2011-2026,
16 seasons each) and fully ingested and scored.

### Final population

| Competition | Fixtures | Scored | Seasons |
|---|---|---|---|
| Carabao Cup (48) | 1,101 | 1,101 (100%) | 2011-2026 |
| League One (41) | 8,195 | 8,195 (100%) | 2011-2025 |
| League Two (42) | 8,220 | 8,220 (100%) | 2011-2025 |
| **New total** | **17,516** | **17,516 (100%)** | |

Overall historical population grew from 50,253 to 67,791 fixtures
(+17,538 — the extra 22 beyond the three new leagues' 17,516 is routine
active-season refresh on already-tracked leagues, not a discrepancy).
Regression check on an established league (Premier League, 39): 5,700
fixtures, 100% scored, consistent with expected volume — untouched by
this ingestion, confirmed empirically not just by construction (Phase
2's `if (scoredMap.has(fixtureId)) continue` guard makes already-scored
records structurally immutable regardless).

Pool-richness proof (mirrors the live-fix task's Plymouth-vs-Exeter
proof): Charlton Athletic (League One, team id 1335) now shows 444
fixtures in its historical pool — 421 League One (2011-2025) plus 23
Carabao Cup (2011-2026) — the exact "near-empty pool" problem the live
fix solved for the live path, now also resolved on the historical side,
with zero new pool-filtering code (Addendum 16).

### Operational note: three rounds of crashes, root-caused and fixed

The scoring run itself repeatedly crashed the Render process mid-run
(confirmed via Render's own error page appearing mid-poll, then a clean
auto-restart with in-memory run state lost but on-disk data intact,
since Phase 1's per-league writes and Phase 2's per-checkpoint writes are
both already atomic). Root cause, found by reading rather than guessing:
`runHistoricalBackfill`'s Phase 2 scoring loop, its periodic
`optimiseWeights` re-optimisation, and `updateTeamProfiles`'s per-team
rebuild loop all had zero `await` anywhere in their bodies — at this
population size (~68k records, thousands of distinct teams once Carabao
Cup pulls in every English professional club), each was a multi-minute
uninterrupted synchronous block, during which Node's single event loop
couldn't answer Render's health check at all.

Three fixes applied, in order, each verified against the actual next
failure point rather than assumed sufficient: a periodic `setImmediate`
yield in Phase 2's per-fixture loop (commit `b19151e`); yields inside
`optimiseWeights` itself, not just around it, since a single call was
itself a multi-minute unbroken block (`889f5b1`); and yields inside
`updateTeamProfiles`'s per-team loop (`a120b2b`). Each fix was confirmed
correct — scoring reliably reached 100% completion after the first two —
but crashes continued at other points afterward regardless of yielding,
which is the specific signature of a memory ceiling rather than a
responsiveness problem (yields fix scheduling, not memory footprint).

Given that signature, and given the actual task deliverable (the scored
population) was already complete and durable, further fixing was
deliberately **not** pursued overnight: no partial/scoped profile
rebuild was attempted, because scoping the input fixture set to only the
new leagues would silently overwrite an already-tracked team's rich
multi-league profile with just its handful of Carabao Cup fixtures for
any team that plays in both — worse than leaving it alone. Team profile
rebuild for the new leagues' teams (`updateTeamProfiles` over the full
67,791-fixture pool) is deferred as a genuine, explicitly-flagged
follow-up — needs either a smaller-batch/streaming approach or a larger
memory allocation on the hosting instance, not more yielding.

`checkAndRetrain`'s gate (`settings.autoRetrainEnabled`) was re-checked
before and after every single deploy and trigger across this entire
process — confirmed `false` throughout, `retrainPending` never flipped
(the 68,000-record threshold wasn't reached; would have stayed a no-op
pending flag either way per the gate added in the model-versioning work).
No calibration, ROI read, or weight re-optimisation was run against this
population — it remains the same held-aside, untouched status as
Carabao Cup/League One/League Two's original addition (Addendum 15) and
the standing rule in `docs/calibration-rules.md`.

## Addendum 18 — Team-profile rebuild resolved: root cause was a nightly recurring crash, not a one-off

Addendum 17 deferred the team-profile rebuild for Carabao Cup/League
One/League Two after repeated crashes even with event-loop yields
applied. This addendum confirms the actual memory constraint, assesses
how material the gap was, fixes the real (ongoing, not one-off) root
cause, and completes the deferred rebuild safely.

### The memory constraint, confirmed not guessed

`render.yaml` confirms `plan: starter` — Render's documented 512MB
instance. A temp diagnostic (`process.memoryUsage()`, removed after use)
showed idle RSS at ~311MB — only ~200MB of headroom before the 512MB
ceiling, before any historical-data operation even begins. Loading and
grouping the full ~68k-fixture pool measured as cheap (~1MB RSS growth),
ruling out the pool-grouping step itself as the bottleneck. The actual
crash trigger turned out to be broader than one function: not just
`updateTeamProfiles` in isolation, but the combined effect of every
Phase 1-5 structure (fixtureMap, scoredMap, teamIndex, standingsIndex,
records, growing profiles object) staying resident simultaneously for an
entire synchronous request's duration once profile rebuild ran across
the full ~1,197-team population.

### An important discovery: this wasn't a one-off, it was recurring nightly

Checking cron/quota state on resuming this task revealed the 00:05 UTC
nightly backfill cron (`runBackfillChain` → `runHistoricalBackfill`,
unconditional every night) had been crash-looping for hours —
`team-profiles.json`'s on-disk size hadn't moved since Addendum 17, and
`apiQuotaUsedToday` plus a fresh boot uptime were consistent with
repeated overnight restarts. Root cause: Phase 3 (weight optimisation)
and Phase 5 (profile rebuild) both ran over the *entire* population on
*every* cron firing, regardless of whether any fixture was actually new
that day. This was the real, ongoing incident — fixing the one-off
catch-up alone would not have stopped it recurring every night going
forward.

**Fix**: `runHistoricalBackfill` now tracks `changedTeamIds` — the teams
with a genuinely newly-scored fixture that run. Phase 3 and Phase 5 are
both now gated on `changedTeamIds.size > 0`; a night with zero new
results (Phase 2 finds nothing to score) now correctly skips both
instead of redundantly recomputing identical output. `updateTeamProfiles`
(teamProfiles.js) gained an optional `onlyTeamIds` parameter — grouping
still scans every passed fixture (confirmed cheap), so each affected
team's profile is still built from its own full history; this only skips
the per-team build+write for teams whose history didn't change. Verified
live: a manual trigger post-fix completed cleanly in under a minute
(`profilesBuilt: 0`, correctly skipped — the "new" fixtures were
active-season re-fetches of already-scored data, not genuinely new).

### Materiality: how much was actually at stake

`applyTeamProfileModifiers` (the only place team-profile data feeds into
live scoring) has an explicit clean no-op path — `if (!homeProfile ||
!awayProfile) return { probs, applied: false }`. The *primary* scoring
signal (`form`/`xg`/`defense`/`h2h`/`standings`/`momentum` —
`WEIGHTS_BY_CONTEXT`) is 100% pool-based and has zero dependency on
`team-profiles.json`; that layer is already fixed and rich for the new
leagues (Addendum 16/17). The profile layer contributes only secondary,
capped adjustments on top: home/away strength multiplier (clamped
0.5x-2.0x, only fires above a 2pp threshold), H2H anomaly, fixture
congestion, weather sensitivity (each gated behind minimum-sample-size
thresholds), and WOWY absence adjustment (capped ±8pp total). A stored
`momentumPatterns` field turned out not to be read by
`applyTeamProfileModifiers` at all — dead data currently, for every team,
not just the new leagues'. Conclusion: the gap was real but bounded —
new-league fixtures were scoring purely on already-correct pool-based
signal, missing only small secondary refinements, not corrupted or
degraded output.

### The one-off catch-up: batched, scoped, verified clean

Scope: teams appearing in any Carabao Cup/League One/League Two fixture
(108 teams total, out of ~1,197 across the whole historical population)
— matching the task boundary that already-tracked leagues' teams should
only be touched if they specifically played in one of the three new
competitions. Processed in 4 batches of ≤30 via a temp endpoint using
the new `onlyTeamIds` parameter — each batch a separate HTTP request so
memory from one batch fully releases before the next. All 4 batches
completed cleanly, zero crashes, server `startedAt` unchanged throughout
the entire run.

**No-corruption spot-check** (before → after):

| Team | In scope? | dataPoints before | dataPoints after |
|---|---|---|---|
| Charlton Athletic (1335) | Yes (League One + Carabao Cup) | none (404, never built) | 444 |
| Manchester United (33) | Yes (plays Carabao Cup) | 236 | 741 |
| Manchester City (50) | Yes (plays Carabao Cup) | 6 (thinned by an unrelated recent morning-scan overwrite) | 756 |
| Real Madrid (541) | No (La Liga only, never in these 3 comps) | 250 | 250 — exactly unchanged |

Teams in scope got richer, accurate profiles built from their own full
history (not corrupted, not thinned); teams out of scope were completely
untouched, confirming the scoping worked exactly as designed. Man
City's incidental fix (6 → 756) is a bonus — the same batched mechanism
correctly rebuilt a profile an unrelated recent morning-scan run had
thinned, from the full available history rather than that day's partial
scan.

### Confirmed throughout

Auto-retrain gate re-checked before and after every deploy/trigger:
`autoRetrainEnabled: false`, `retrainPending: false`, model
`trainedAt`/`trainN` unchanged throughout. No calibration, ROI read, or
weight re-optimisation run against this population.

## Addendum 19 — Carabao Cup, League One, League Two: closing-odds backfill and the single, deliberate calibration + ROI look

This is the payoff addendum for the historical population built in
Addenda 16-18: closing-odds matched against Pinnacle, and — per
`docs/calibration-rules.md` rule 3 and rule 10 — the one deliberate,
non-iterated look at calibration and ROI against a population that has
never been touched by any tuning decision.

### Part A — Closing-odds backfill

Sport keys re-verified live before bulk use (`/sports?all=true`):
`soccer_england_efl_cup` (exists, `active:false` right now — between
rounds, doesn't affect historical archive access), `soccer_england_league1`,
`soccer_england_league2` (both `active:true`).

| Competition | Fixtures eligible (2020+) | Matched | Match rate |
|---|---|---|---|
| Carabao Cup | ~460 | 330 | ~72% |
| League One | ~3,700 | 3,344 | ~90% |
| League Two | ~3,700 | 3,338 | ~90% |
| **Total** | **~7,900** | **7,012** | **~89%** |

Credits used: ~28,900 across the whole task (smoke test + full run +
debug-mode miss investigation), against a starting balance of
4,922,334 remaining — negligible. Well within the API-Sports 7,500/day
limit throughout (no fixture-side calls needed beyond confirming sport
keys).

**Team-name matching**: no alias-table fixes needed this time. A
debug-mode run against every miss showed **100% `no_event_match` with
`eventCount: 0`** — the Odds API returned zero events for that
kickoff-minute query, not a failed name match (a failed match would show
`eventCount > 0` with no matching team pair inside it). Confirmed by
inspecting the actual miss list: Bournemouth vs Milton Keynes Dons,
Cardiff vs Sutton Utd, Hartlepool vs Crewe, Birmingham vs Colchester,
Ipswich vs Newport County, and more in the same pattern — bigger EFL
clubs against smaller lower-tier opposition, the signature pairing of
**Carabao Cup Round 1** specifically (the round below "Round of 128,"
which is as far as the original coverage spot-check in Addendum 15 went).
**Structural gap confirmed**: Carabao Cup's very earliest round has
materially thinner Pinnacle market coverage historically than the
rounds the original check sampled — a genuine data-availability limit,
not a code defect. League One/League Two showed no comparable gap
(~90% match rate each, no round-level pattern in the misses).

### Part B — The single, deliberate look

Computed once via a dedicated temp diagnostic endpoint (removed after
use) — deliberately **not** `runEvCalibration()`, which also auto-manages
`settings.paperTradeOnly` and the paper Kelly fraction based on ROI,
side effects designed for the 9 validated leagues' ongoing weekly cron
cycle. This population is categorically different (fully unseen, no
train/test split, one-time baseline per rule 10) and any paper/real
decision from it should stay a deliberate human call.

**A bug was caught before treating the first call's numbers as final**:
an object-spread ordering issue in the endpoint meant `n` was being
silently overwritten by `posEdgeN` everywhere the pattern
`{ n: X, posEdgeN: Y, ...roiStats(Y) }` appeared (`roiStats()` returns
its own `n`, equal to the population it was actually given — i.e.
`posEdgeN` — which clobbered the intended broader `n` after spreading).
This didn't affect any ROI/CI figure (those were always computed
correctly over the right subset), only the `n` label — but it meant
rule 5's requirement (n and posEdgeN reported as genuinely distinct
values) wasn't being met. Fixed and re-run once — a measurement-code bug
fix in code written for this task, not a change to the population,
model, or any calibration parameter, so this is the corrected first
look, not a second look at the same valid numbers.

**Matched population**: n=7,012, posEdgeN=3,494 (edge ≥5% vs Pinnacle).

**Overall (pooled, 3 leagues combined)**: ROI +1.3%, CI (-3.3%, +5.9%) —
spans zero. posEdgeN=3,494 clears the rule-6 decision-grade floor
(~300-400) comfortably — a genuinely evidenced null result, not an
under-sampled one.

**Per league**:

| League | n | posEdgeN | ROI | 95% CI | Decision-grade? |
|---|---|---|---|---|---|
| Carabao Cup | 330 | 168 | +18.5% | (-8.5%, +45.6%) | No (posEdgeN below floor) |
| League One | 3,344 | 1,580 | -3.6% | (-9.8%, +2.5%) | Yes |
| League Two | 3,338 | 1,746 | +4.2% | (-2.7%, +11.0%) | Yes |

Carabao Cup's headline ROI looks tempting but the sample is too small
to read as anything more than a hint — the exact caution rule 6 exists
for. League One and League Two are both genuinely decision-grade and
both land with CI spanning zero — no confirmed edge either way, the
same pattern the original 9 validated leagues showed almost universally
in their own held-out reads.

**One cell excludes zero**: League One's 50-55% tier (n=230, posEdgeN
per the tier-matrix convention) shows CI (-30.1%, -0.9%) — a genuinely
negative reading. A single cell at this population size isn't yet a
leaguewide finding, but it's the one place in this whole read that
doesn't span zero, and is flagged the same way the PL 40-45% and La
Liga 40-45% cells were in the original matrix.

**Calibration grid** (5pp tiers, pooled across all 3 leagues, mean
predicted probability vs actual hit rate):

| Tier | n | Mean predicted | Actual hit rate | Error (pp) |
|---|---|---|---|---|
| 35-40% | 1,353 | 38.2% | 38.0% | +0.2 |
| 40-45% | 1,703 | 42.4% | 42.6% | -0.1 |
| 45-50% | 1,341 | 47.4% | 46.7% | +0.7 |
| 50-55% | 1,024 | 52.3% | 46.6% | +5.7 |
| 55-60% | 654 | 57.3% | 53.4% | +3.9 |
| 60-65% | 452 | 62.3% | 55.3% | +7.0 |
| 65-70% | 268 | 67.3% | 57.8% | +9.5 |
| 70-75% | 137 | 72.5% | 61.3% | +11.1 |
| 75-80% | 55 | 77.1% | 72.7% | +4.4 |
| 80%+ | 23 | 81.6% | 69.6% | +12.0 |

Well-calibrated through 45-50% (error under 1pp), then increasingly
**overconfident** from 50% upward, peaking around +9 to +12pp in the
65%+ tiers — the same directional pattern found for the original 9
leagues throughout this project (the model trusts its own high-confidence
picks more than the data supports). Nothing new mechanistically, just
confirmed again on a genuinely fresh population.

**Home/away split** (pooled, posEdge≥5% subset):

| | n | posEdgeN | ROI | 95% CI |
|---|---|---|---|---|
| Home | 5,205 | 2,618 | +3.7% | (-1.7%, +9.0%) |
| Away | 1,807 | 876 | -5.6% | (-14.6%, +3.4%) |

Per league, the same home-leaning pattern holds directionally in all
three, most notably **League Two home picks** (n=2,518, posEdgeN=1,304):
ROI +8.0%, CI (**-0.1%**, +16.1%) — the closest any single cut of this
entire population comes to excluding zero on the positive side. Not a
confirmed finding on its own (still spans zero, if barely), but the
most interesting single number in this read and worth a closer look in
any future dedicated cycle. Carabao Cup's away split (n=75, posEdgeN=39,
ROI +35.8%) is far too thin to read as anything.

### Part C — Integration

- **`LEAGUE_TIER_MATRIX`**: all three leagues added as new entries,
  cells matching the ROI grid above exactly (posEdge-filtered `n`,
  `roi`, `ciLow`/`ciHigh`, `thin` at n<30, `shrunk` via
  `shrinkage.js`). Shrinkage pools **among these 3 leagues' own cells
  only** — a deliberate choice, not merged into the original 9-league
  pool, so every number already published in Addendum 6 stays exactly
  as it was. `/api/league-tier-matrix` now returns two explicit scope
  lists — `validatedLeagues` (the original 9, split-based) and
  `unseenPopulationLeagues` (these 3) — rather than one undifferentiated
  list, and its `note` field spells out the methodological difference.
- **`CALIBRATION_AUDIT`**: added with `status: 'unseen_population'`,
  deliberately not `'validated'` — that label specifically means "passed
  a clean train/test split" (rule 7), and these three were never split
  at all. `reliable: true` reflects genuine tuning-free cleanliness,
  which is real but not the same claim a split makes.
- **`TIER_PERF_VALIDATED_LEAGUES`** and **`HISTORICAL_TIER_BASELINE`**
  deliberately left untouched — both are specifically scoped to "leagues
  with a genuine train/test split," a different cohort by definition.
  `byLeagueForTier` (the live tier-performance tracker's per-league
  breakdown) already iterates `Object.keys(LEAGUE_TIER_MATRIX)`, so
  these 3 leagues now automatically appear as tracker columns — showing
  real historical/continuous data instead of a blank row — without
  needing that set touched at all.
- **Ongoing consequence worth flagging**: the Monday `runEvCalibration()`
  cron will, from its next run onward, naturally start including these
  three leagues in its own `byLeague` output (they now clear its n≥100
  threshold) and in its automatic `paperTradeOnly`/Kelly-fraction
  management — a separate, ongoing, already-existing automatic process
  using its own edge-band methodology, not something this task
  triggered deliberately. `LEAGUE_CONFIG`'s `leagueModes` hard block
  (paper-only) is unaffected either way — `paperTradeOnly` is an
  additional soft restriction layered on top, not a replacement for it.

### Part D — Summary

**Where (if anywhere) is there real, evidenced signal?** Nowhere
confirmed. Every pooled and per-league ROI reading spans zero at the
95% level, on a comfortably decision-grade sample for League One and
League Two specifically. The two numbers worth remembering for a future
look: League One's 50-55% tier (the one cell that excludes zero,
negative) and League Two's home picks (closest to excluding zero,
positive). Neither is a finding today — both are exactly the kind of
"worth watching" flag the original 9 leagues' reads produced almost
across the board.

**This is the single look — rule 3, explicitly.** No further tuning,
refitting, re-binning, or re-analysis of this population happens
without a deliberate, separate, documented decision to do so in the
future. The numbers above are final as read.

**Auto-retrain gate**: re-verified before and after every deploy/trigger
across this entire task — `autoRetrainEnabled: false`,
`retrainPending: false` throughout, model `trainedAt`/`trainN`
unchanged.

**Constraints honoured**: no change to `LEAGUE_CONFIG` real/paper
status — all three remain `paper_only` in `leagueModes` regardless of
what this read showed. No change to base rates, scoring logic, or the
live model. The real-money decision, if any, stays a separate,
deliberate call.

**Total API usage this task**: ~28,900 Odds API credits (of
4,922,334+ remaining), well under 100 API-Sports calls (all
confirmation/sport-key checks, no bulk fixture-side calls needed —
Part A's fixture data was already complete from Addenda 16-18).

## Addendum 20 — Two-legged knockout handling (CL/EL/Conference League), and train/test splits for Europa League + Conference League

### Part A — Two-legged knockout structure

**1. Current behaviour, confirmed by direct code reading**: neither the
historical scorer (`scoreFixtureFromPool`, `weightOptimiser.js`) nor
live scoring (`scoreOneFixture`, `server.js`) has any aggregate/leg
awareness at all. Each leg of a two-legged tie is scored as a fully
independent fixture — same factor computation (form/homeAdv/xg/h2h/
defense/momentum/standings) as any other match, no tie-context input.
The only competition-phase signal that exists at all is
`classifyCompetitionPhase()` (group_stage vs knockout), and even that:
(a) is only computed in the live path, never in historical scoring, and
(b) for club competitions only feeds a display label
(`neutralLabels`) — it does **not** change weights, neutral-venue
handling, or any model input for CL/EL/Conference League (`neutralVenue`
is gated to `context === 'international'` only, i.e. genuinely
neutral-site tournaments like the World Cup — European club ties are
always played at a real team's home ground, correctly).

**2/3. Is this a real distortion?** Tested empirically rather than
assumed either way. Round/leg data was never persisted in
`backfill-historical.json` — `stripFixture()` drops `league.round`
entirely (a genuine, previously-unknown gap, fixed below) — so this
required re-fetching fixture lists by league+season directly from
API-Sports (29 calls, ~8,785 fixtures, read-only, nothing written to
stored data). Two findings from that data:

- API-Sports' `round` field carries **no leg marker** for these
  competitions (`"Round of 16"`, `"Quarter-finals"`, etc. — identical
  string for both legs, no "1st Leg"/"2nd Leg" suffix). Ties had to be
  identified generically: same league+season+round string, reversed
  home/away team pair, earlier date = leg 1.
- That matching produced **2,648 genuine two-legged ties (5,296
  fixtures)** across CL/EL/Conference League, 2011–2024 — a real,
  substantial population, not a handful of anecdotes. Two-legged
  fixtures are ~63% of these three competitions' own fixture pool and
  ~8% of the entire ~68k-fixture historical population.

Leg 2's own match outcome, split by the aggregate scoreline entering
it (from leg-2-home-team's perspective):

| Aggregate state entering leg 2 | n | leg2Home win | Draw | leg2Away win | Avg goal diff |
|---|---|---|---|---|---|
| Ahead 2+ | 360 | 68.3% | 15.8% | 15.8% | 2.02 |
| Ahead 1 | 403 | 59.6% | 18.1% | 22.3% | 1.61 |
| Level | 670 | 46.9% | 22.8% | 30.3% | 1.52 |
| Behind 1 | 589 | 50.6% | 21.4% | 28.0% | 1.45 |
| Behind 2+ | 626 | 33.1% | 24.4% | 42.5% | 1.39 |
| **Leg-1 baseline (no aggregate context)** | **2,648** | **45.9%** | **25.3%** | **28.8%** | **1.41** |

This is real and statistically robust — the extreme buckets sit
10–20+pp away from the leg-1 baseline on samples in the hundreds (e.g.
"behind 2+"'s home-win gap is roughly 7 standard errors from baseline,
nowhere near noise). It is **not fully explained by team-quality
persistence** either: a team 2+ down after leg 1, playing leg 2 at
home, still wins that specific match 33.1% of the time — clearly above
what a symmetric mirror of the "ahead 2+" bucket's own 15.8%
away/draw-combined rate would predict, consistent with a genuine
"backs against the wall, must attack at home" second-leg dynamic on
top of whatever team-quality gap the scoreline already reflects. The
"ahead 2+" bucket's own extreme home-win rate (68.3%, well above the
45.9% baseline) is plausibly mostly team-quality persistence — a team
that's already 2+ up after leg 1 is often simply the stronger side —
but disentangling the two cleanly wasn't attempted; see the scope
decision below.

**Practical caveat for Part B**: since two-legged fixtures are the
majority of CL/EL/Conference League's own fixture pool, any home/away
bias found in a competition-specific split (like the one run below)
may partially reflect this aggregate-state dynamic rather than pure
market inefficiency. Worth remembering when reading the Europa
League/Conference League results below.

**4. Proposal — implemented now vs. deferred**:

- **Implemented**: `stripFixture()` now retains `league.round` going
  forward (previously dropped it entirely — the exact gap that forced
  this task to re-fetch from the API instead of reading it off disk).
  Zero cost, purely additive, doesn't touch the existing population or
  require any rescoring.
- **Deferred, with a concrete recommendation**: a real "aggregate
  context" feature or tag requires tracking each two-legged tie's leg-1
  result *live*, at the moment leg 2 is being scored — round data now
  available going forward (per the fix above), but the tie-pairing
  lookup logic doesn't exist yet, and turning this into a model
  *feature* would require a retrain plus its own quality-gate pass.
  Recommend starting with a **metadata tag only** (`isSecondLeg`,
  `aggDiffEnteringLeg2`) attached to the calibration log for CL/EL/
  Conference League — near-zero model risk — and monitoring for a
  season or two of live data whether the *live* model (with its full
  feature set, including whatever H2H signal already leaks through
  from leg 1 being the two teams' most recent meeting) is actually
  measurably worse-calibrated in the extreme aggregate-state buckets,
  before investing in an actual feature/weight change. This follows
  calibration-rules.md rule 4 directly — a retrospective pattern that
  might partly be a team-quality artifact isn't yet "a real
  improvement with a football reason," it's a hypothesis worth
  watching live before being built into the model.
- Not implemented and not recommended soon: a full ClubElo-style
  aggregate-points-scaled feature. The live-tag-and-monitor step above
  is the prerequisite that would tell us whether that heavier
  investment is actually justified.

**Closed out — checked, not a lingering open flag.** The finding is
real and documented; the response is proportionate (retain data going
forward, tag-and-monitor before any model change) rather than either
dismissing it or over-building on a retrospective pattern that
hasn't been live-validated.

Temp diagnostic endpoints used for this investigation
(`/api/diagnostics/two-legged-check`, `/api/diagnostics/two-legged-aggregate`)
have been removed; ~29 API-Sports calls were spent (~8,785 fixtures
fetched), reported here and in the final task summary.

### Part B — Europa League and Conference League train/test splits

Same process as the 9 already-validated leagues, calibration-rules.md
rule 1–9 throughout: genuine chronological split, tuning touches train
only, single test-set look, `calibrationReliable` set from the actual
outcome.

**Europa League (league 3)**: matched-Pinnacle population starts
2022-09-08 (no earlier Odds API coverage exists for this competition
either, not just Conference League). Split at the natural matchday
boundary after 2024-09-26 UTC — train n=286 (2022-09-08 to 2024-09-26,
67.6%), test n=137 (2024-10-03 to 2025-05-21, 32.4%), zero fixture
overlap. Train-observed outcome frequency (home 50.0% / draw 21.0% /
away 29.0%) ran meaningfully hotter on home wins than the untuned
default (43.1% / 24.8% / 32.1%) — corrected to match, football-
justified by European away form running measurably below a club's
normal domestic away form (unfamiliar stadium, cross-border travel,
every match bar a neutral-venue final), and the shift was directionally
coherent across all three outcomes, not an isolated noisy jump.
`homeAdvBaseWeight`/`drawBaseWeight`/`marketEfficiency` left untouched,
same reasoning as every other league this cycle.

**Test-set result** (single look): n=137, posEdgeN=68, **ROI +2.47%**,
95% CI (-32.4%, +37.3%) — spans zero, posEdgeN well below the rule-6
~300-400 decision-grade floor. No confirmed edge either way. In scale
this is comparable to Champions League's own split (the smallest of
the original 9 at n=635 total) — Europa League's total matched
population (423) is smaller still, but the split itself is clean and
the result sits in the same "indicative only" bucket every other
league has landed in.

**Conference League (league 848)**: matched-Pinnacle population starts
2022-10-27 — **empirically confirms** the 2021-22 industry-wide
coverage blackout already documented in Addendum 11 (no vendor,
including the current one, has ever tracked this competition's first
UEFA season). Split at the natural matchday boundary after 2024-10-24
UTC — train n=238 (2022-10-27 to 2024-10-24, 69.6%), test n=104
(2024-11-07 to 2025-05-28, 30.4%), zero fixture overlap. Train-observed
draw rate (20.6%) ran clearly below the untuned default (25.1%) — the
clearest single gap of this cycle — corrected to match, with home/away
renormalised accordingly (46.6% / 20.6% / 32.8%).

**Test-set result** (single look): n=104, posEdgeN=39, **ROI +58.85%**,
95% CI (-45.2%, +162.9%) — by a wide margin the noisiest reading of
any split run to date (a 208pp-wide interval, driven by a return
standard deviation of 3.32 on only 39 posEdge bets — a handful of
high-odds outcomes dominating the mean). **This number should not be
read as a finding of any kind.** The split methodology itself is
genuinely clean — zero fixture overlap, base rates tuned on train only
— which is what `calibrationReliable: true` certifies per rule 7's
strict definition. But `CALIBRATION_AUDIT`'s `status` for this league
is deliberately `validated_thin` rather than plain `validated`, to
make clear in the data itself that this is the thinnest, least
informative population validated so far and its ROI figure carries
essentially no statistical weight, even though the split mechanics are
sound. Not labelled "insufficient data for validation" outright,
because the split genuinely completed with zero leakage — but readers
of the dashboard should treat this exactly as they would an unvalidated
number, not as a validated +58.85% edge.

**Live wiring**: `VALIDATED_SPLITS` (server.js) gained entries for both
leagues (`splitCommit: fbb8dbd`), so `runEvCalibration()`'s `byLeague`
output now reports only each league's held-out test-set fixtures going
forward, same as every other validated league. `LEAGUE_TIER_MATRIX`
(the finer 5pp-band × league grid built in Addendum 14) was
deliberately **not** extended to these two leagues this cycle — that's
a separate analysis surface, and splitting an already-thin population
(104–137 fixtures) into 8–11 finer bins would produce mostly
single-digit-n cells with little added value. Can be done as a
dedicated follow-up, the same way the 3 unseen-population leagues got
their own Part C/D pass in Addendum 19, if wanted later.

### Part C/D — Report

**Two-legged handling**: checked, found real (statistically robust,
concentrated in ~8% of the total population), not dismissed — lightweight
fix implemented (retain round data going forward), heavier fix (a real
aggregate-context feature) deliberately deferred pending live
monitoring evidence, per rule 4.

**Europa League and Conference League joined the validated-split
cohort** (now 11 leagues total, alongside the original 9 from Addenda
1–14 and the 3 unseen-population leagues from Addendum 19). Neither
produced a confirmed edge — Europa League's CI spans zero on an
indicative-only sample in line with every other league; Conference
League's split is methodologically clean but its result is too thin
and noisy to read as signal, flagged explicitly as such via
`status: 'validated_thin'` rather than presented at face value.

**Constraints honoured**: no change to `LEAGUE_CONFIG` real/paper
status — both remain whatever `leagueModes` already had them set to.
Auto-retrain gate re-verified before and after every deploy this task
(`autoRetrainEnabled: false`, `retrainPending: false`, model
`trainedAt`/`trainN` unchanged throughout). All three temp diagnostic
endpoints added during this task
(`/api/diagnostics/two-legged-check`, `/api/diagnostics/two-legged-aggregate`,
`/api/diagnostics/el-conf-split-planning`) have been removed.

**Total API usage this task**: ~29 API-Sports calls (~8,785 fixtures
fetched, for the two-legged aggregate-state investigation only — Part
B's split used data already on disk). Zero Odds API credits spent —
the EL/Conf split worked entirely from already-ingested
`backfill-historical.json` and `closing-odds.json`.

## Addendum 21 — Walk-forward proxy backtest for the 10 in-sample leagues, and the Historical/Live/Combined framework redefinition

Overnight, autonomous task. All 9 originally-validated leagues plus
Champions League and Europa League were used to train the current live
model (`EXCLUDED_LEAGUE_IDS` in the live retrain confirms only Carabao
Cup/League One/League Two are held aside) — meaning none of them has a
genuine untouched holdout the way Addenda 19/20 gave Carabao Cup/League
One/League Two. This addendum builds an out-of-sample-*style* reading
for these 10 leagues via walk-forward validation: a deliberately
different technique from the single-holdout approach used everywhere
else in this document, chosen specifically because no real holdout
exists to take a single look at.

### Part A — Walk-forward design

**Parameterization.** `models/gbdt-train-proxy.js` (previously
hardcoded to Addendum 14's single `HOLDOUT_START`) now accepts
`WF_TRAIN_BEFORE`/`WF_TEST_END`/`WF_BLOCK_LABEL` env vars, dual-mode:
legacy single-holdout behaviour is unchanged when these are unset,
walk-forward mode activates when `WF_TRAIN_BEFORE` is present. Each
block trains one proxy model on **all** data strictly before the
block's start date (expanding window, not a fixed 2-year lookback) and
tests on the block itself — the standard walk-forward definition,
chosen so later blocks benefit from more training history, the same
way the live model's own periodic retrains do.

**Window selection — a genuine deviation from the original scoping,
flagged as instructed.** The brief asked for "the past 2 years" ending
now. A temp diagnostic endpoint (`/api/diagnostics/walkforward-planning`,
removed after use, confirmed via live 404 check) pulled real per-month
fixture volumes before committing to any boundary, per the brief's own
instruction not to guess. That check found the qualifying population
(all leagues except Carabao Cup/League One/League Two) **thins to
near-zero from roughly 2025-06 through 2026-06** — 1 to 29 fixtures a
month, because most European domestic seasons run August-to-May and
2026-27 hadn't kicked off yet as of the task's run date. "Last 2 years
ending now" was therefore not viable — it would have produced one or
more starved blocks. **Autonomous decision: shifted the window to
2023-06-01 → 2025-06-01**, the most recent 24-month span with genuinely
dense, matchday-normal volume throughout. This is a real deviation from
the literal brief and is the single biggest judgment call in this task.

**Block boundaries**, set on real cumulative fixture counts (not
guessed), each block ~6 months:

| Block | Train-before | Test window | Test population | Matched Pinnacle | posEdge≥5% bets |
|---|---|---|---|---|---|
| 1 | 2023-06-01 | 2023-06-01 → 2023-12-23 | 2,207 | 1,476 | 509 |
| 2 | 2023-12-23 | 2023-12-23 → 2024-07-25 | 1,995 | 1,521 | 450 |
| 3 | 2024-07-25 | 2024-07-25 → 2024-12-30 | 2,079 | 1,564 | 519 |
| 4 | 2024-12-30 | 2024-12-30 → 2025-06-01 | 1,633 | 1,547 | 480 |
| **Total** | | | **7,914** | **6,108** | **1,958** |

Each block trained one proxy model (not one per league — a single
model per block, on the full cross-league pooled population, per the
brief's explicit instruction), same 200-tree/depth-3/lr-0.02
architecture as every other GBDT fit in this project, scored against
`closing-odds.json` with `applyLeagueBiasCorrection()` applied on top
of Platt-corrected raw probabilities — the same edge-computation
treatment `runEvCalibration()` uses live. All 4 blocks completed with
`exitCode: 0`, no crashes, no OOM signals, using the same
`spawn()`-isolated/`setImmediate`-yielded/40-minute-timeout-protected
pattern proven this week for the weekly retrain cron — necessary given
the 512MB instance and confirmed memory-safe throughout.

**Exclusion confirmed for every block, not just the final one.** Each
block's log line reads `Total qualifying (excl. Carabao Cup/League
One/League Two): 50,275` — identical across all 4 blocks (the
exclusion is applied once in `loadData()`, upstream of any block
split), confirming Carabao Cup/League One/League Two never entered any
block's training or test population, consistent with their held-aside
status under `docs/calibration-rules.md` rule 10.

**Conference League**: folded into every block's pooled cross-league
training population, exactly as it is in the live model — but, per the
brief, not reported as its own walk-forward line here. Its existing
`validated_thin` status and reasoning (Addendum 20) are untouched. Of
the 1,958 total posEdge bets produced across the 4 blocks, 116 belong
to Conference League and are excluded from the reported figures below;
the remaining **1,842** belong to the 10 reported leagues.

**Sequential execution only** — one block trained and scored to
completion before the next started, no parallel jobs, per the brief's
explicit constraint. A Render redeploy kills the whole container
including any spawned child training process, so every code change
this task produced (server.js/gbdt-train-proxy.js edits) was held
locally uncommitted while the 4 blocks trained, and only pushed once
all 4 had finished — otherwise a mid-run deploy would have silently
killed an in-progress block.

### Part B — Pooled results (10 reported in-sample leagues, all 4 blocks combined)

**Pooled by tier:**

| Tier | n | ROI | 95% CI |
|---|---|---|---|
| 35-40% | 406 | −26.46% | (−40.4%, −12.5%) |
| 40-45% | 627 | −21.95% | (−32.4%, −11.5%) |
| 45-50% | 437 | −2.94% | (−16.1%, +10.2%) |
| 50-55% | 208 | −0.55% | (−19.9%, +18.8%) |
| 55-60% | 93 | +13.27% | (−9.4%, +35.9%) |
| 60-65% | 46 | +13.43% | (−42.3%, +69.2%) |
| 65-70% | 23 | +163.43% | (−28.4%, +355.3%) |
| 70-75% | 2 | +65.50% | (+35.1%, +95.9%) |
| **Total** | **1,842** | **−10.95%** | |

Three cells exclude zero: 35-40% and 40-45% (both negative, both with
n in the hundreds) and 70-75% (positive, but n=2 — far too thin to
mean anything despite technically excluding zero, the same caution
flagged for every small cell in Addenda 6/14/19). The rest span zero —
no confirmed edge either direction at current sample sizes, the same
pattern nearly every other read in this document has shown.

The shape is broadly consistent with every prior tier read in this
document — heavy negative ROI in the 35-45% band, improving through
50-55%, turning positive from 55% up. The 65-75% cells (n=23 and n=2)
are far too thin to read as anything beyond noise, the same caution
flagged for every small cell in Addenda 6/14/19.

**Volume reconciliation against the brief's ~7,000-8,000 estimate —
flagged, because the two numbers being compared are not the same
quantity.** The brief's estimate was based on raw per-league monthly
fixture counts, i.e. **matched-odds test population before any edge
threshold** — the real total for that quantity is **7,914** (2,207 +
1,995 + 2,079 + 1,633), landing right in the estimated range. The
**1,842** figure above is a different, downstream quantity: the
posEdge≥5% subset after threshold filtering, matched Pinnacle odds,
and Conference League removed. Comparing 1,842 against "~7,000-8,000"
directly would be an apples-to-oranges read; comparing 7,914 against
it is the fair comparison, and it lands close to plan. Worth noting
for scale: 1,842 posEdge bets on 10 leagues is more than double
Addendum 14's single-holdout equivalent (posEdgeN=847 on 9 leagues,
before Europa League was added) — this design produced a meaningfully
larger evidenced sample than the single-holdout approach did.

**Per-league × tier breakdown.** Pulled live from
`GET /api/league-tier-matrix` (raw posEdge≥5% ROI(n) per cell — the
same numbers behind the Performance tab's 🔬-marked Historical rows,
before empirical-Bayes shrinkage; shrunk values are shown in the grid
itself, not reproduced here since they collapse hard toward the tier
pool at these per-league sample sizes, the same pattern every prior
shrunk grid in this document has shown):

| League | 35-40% | 40-45% | 45-50% | 50-55% | 55-60% | 60-65% | 65-70% | 70-75% |
|---|---|---|---|---|---|---|---|---|
| Premier League | −38.1%(52) | −28.3%(76) | +27.7%(40) | −23.8%(12) | −31.3%(7) | +370.3%(3) | −16.0%(2) | — |
| La Liga | −24.2%(56) | −8.5%(93) | −17.9%(73) | +19.8%(36) | −14.9%(17) | −19.5%(14) | +20.0%(7) | +65.5%(2) |
| Serie A | −35.1%(71) | −12.0%(85) | −4.3%(47) | +19.9%(21) | +63.1%(10) | −1.0%(9) | — | — |
| Bundesliga | −5.1%(41) | −40.4%(67) | −20.9%(35) | +7.0%(24) | +54.9%(8) | +42.2%(5) | +81.0%(1) | — |
| Ligue 1 | −16.2%(61) | −26.6%(47) | +4.1%(32) | +19.6%(12) | +36.0%(9) | — | −19.0%(2) | — |
| Scottish Premiership | −71.5%(21) | −21.2%(57) | −4.9%(50) | +6.4%(27) | −8.6%(5) | +0.4%(9) | +77.2%(4) | — |
| Eredivisie | −18.1%(39) | −4.7%(49) | −31.2%(40) | −26.9%(13) | +33.8%(6) | — | −100.0%(1) | — |
| Primeira Liga | −13.5%(42) | −35.9%(72) | −19.4%(47) | +20.9%(21) | +30.3%(11) | −100.0%(2) | +808.5%(4) | — |
| Champions League | +22.2%(8) | +4.9%(51) | +34.2%(27) | −32.4%(17) | −76.2%(8) | −42.0%(3) | — | — |
| Europa League | −75.0%(15) | −69.0%(30) | +26.1%(46) | −42.8%(25) | +35.8%(12) | −100.0%(1) | +82.5%(2) | — |

Column totals reconcile exactly with the pooled-by-tier table above
(e.g. 35-40%'s 10 league values sum to n=406) and the grand total is
1,842 — a live cross-check, not an assumed one. Reading this the same
way every other per-league grid in this document has been read: most
individual cells are far below the ~300-400 decision-grade floor
(rule 6), so the pooled-by-tier and Total readings above are the ones
worth trusting; this table exists to show *shape and volume*
per league, not to support a league-level ROI claim on its own. The
occasional extreme reading (Primeira Liga 60-65% +808.5%, Eredivisie
65-70% −100.0%) is exactly the single-digit-n noise every prior
addendum has warned about, not a finding — several of these leagues'
individual cells sit at n=1 to n=5.

This backfills the one item flagged as an incomplete write-up in the
overnight session that produced this addendum: the underlying data was
always live in the shipped feature (`/api/league-tier-matrix`,
Performance tab grid), only the hand-transcription into this document
was missing, blocked by a lost authenticated-session credential at the
time. That credential became available in this follow-up session, so
the record is now complete.

### Part C — Honest labeling (per the brief's explicit instruction)

This result describes **how a periodically-retrained model of this
design has performed over the past 2 years** (2023-06 → 2025-06, 4
expanding-window retrains, cross-league pooled training) — it is
**not** a literal test of the exact current live model, which was
trained once, on essentially the whole population, on 2026-08-08. Any
UI surfacing this figure (the 🔬 marker described in Part B/C below)
carries this same caveat inline, not just in this document.

## Historical / Live / Combined — column redefinition (Part B of the brief)

**Historical ROI** now has two possible sources per league, exposed as
`historicalSource` on `/api/league-tier-matrix`'s per-league scope:
- **`real-backtest`** — Carabao Cup, League One, League Two: unchanged,
  Addendum 19/20's real single-holdout reading.
- **`walkforward-proxy`** — the 10 leagues in Part A/B above: the new
  walk-forward result, always rendered with a 🔬 marker next to the
  reading (vs a ✓bt marker for real-backtest leagues) so the evidence
  type is visible at the cell, not buried in a tooltip.

**Live ROI**: unchanged in definition from the prior scoping — real,
resolved bets only, now filtered to `modelVersion === currentVersion`
and `resolvedAt >= currentVersion.trainedAt`. Implemented as a new
`resolved` array in `/api/tier-performance`, derived from the existing
`allResolved`; `byVersionMap`/`byModelVersion` deliberately still
iterate `allResolved` so per-version history stays intact — only the
current "Live" reading itself is version-filtered.

**Combined**: now computable for every competition (previously blocked
for the 10 walk-forward leagues, since they had no legitimate
Historical figure at all before this task). Rendered as a new 4th
stacked sub-row (`_tpgCombine()`, n-weighted pooling of Historical +
Live) alongside the existing Historical/Continuous/Live rows — **not**
a replacement of the existing readings, since removing any of them
wasn't requested. Every Combined cell for a walk-forward-sourced league
carries the same 🔬/✓bt marker its Historical reading has, so Combined
never reads as more authoritative than the evidence actually behind it.

**Automatic handoff logic.** Detection-only in this session, not a
full automated transition — flagged as instructed. `handoffReady` is
computed per cell (`isProxy && liveCell.n >= TPG_DECISION_FLOOR`, the
existing 350-bet decision-grade floor) and renders a `⟳handoff` marker
when a walk-forward league's genuine Live sample has crossed the floor.
**The manual step this still requires**: once flagged, a human decision
is needed to (a) confirm the live sample is trustworthy to promote, and
(b) remove that league's ID from `WALKFORWARD_HISTORICAL_LEAGUE_IDS` in
`server.js`, which is the single switch that makes `buildWalkForwardMatrix()`
stop overriding that league's Historical cell — at that point it falls
through to a real backtest cell the same way Carabao Cup/League
One/League Two already do. Full automation (auto-editing that constant
and redeploying) was deliberately not attempted — changing which
leagues get which kind of Historical evidence is exactly the sort of
standing-configuration change that should stay a deliberate human call,
not something a background job does unattended. Documented as the
standing framework in
[model-versioning.md](model-versioning.md).

## Green-flag manual curation (Part C of the brief)

Click-to-toggle on any tier×league grid cell now flags that
league+tier combination as a manually-curated real-money candidate —
purely a display/curation feature, no gating of bet-locking, no
automatic flagging logic of any kind. Backed by `green-flags.json`
(`GET /api/green-flags`, `POST /api/green-flags/toggle`), rendered as a
green highlight/border on the flagged grid cell (all three Performance
tab copies — paper/real/combined — since flags aren't scoped to the
League/Tournament toggle) and as an unmistakable 🟢 badge on any
matching fixture's Score/Prob/Tier line on the Scout tab
(`scoutTierBlock()`, covering both the recommended card and the
watching card from one insertion point).

**Two real persistence bugs found and fixed during end-to-end
verification** (not assumed working — tested by actually toggling
flags and re-fetching):
1. **False-corrupt discard**: a 1-entry flags array serializes to
   ~97 bytes, under the `structuralCheck()` corruption heuristic's
   `MIN_VALID_BYTES = 100` floor — `readJSON()` silently discarded
   every legitimately-small flags file on the very next read, even
   though the write itself had succeeded. A flag toggle appeared to
   work (success response) but vanished on refresh. Fixed by
   registering `green-flags.json` in `structuralCheck()`, same pattern
   as `watching.json`/`transactions.json`/`bankroll.json`.
2. **Empty-array write refused**: `writeJSON()`'s accidental-overwrite
   guard refuses any write serializing under 10 bytes if the existing
   on-disk file is ≥100 bytes — meaning removing the *last* flag from a
   file that had grown past that size (3+ flags) would silently fail to
   persist as empty. Found via a second, more thorough test
   (add 3 flags, remove all 3, confirm empty via a fresh `GET`) run
   immediately after fixing bug 1. Fixed by passing `{ allowEmpty: true }`
   to that call, matching `saveWatching()`'s existing pattern.

Verified end-to-end after both fixes: added 3 flags, confirmed grid
highlight and persistence via fresh `GET`, removed all 3, confirmed
empty state persisted correctly (not silently reverted) — both bugs
confirmed fixed, not just patched. Flags confirmed independent of the
League/Tournament toggle (same underlying list, both toggle views
re-render from it). Scout-tab badge logic (`greenFlagBadge(leagueId,
modelProb)` deriving `tier` from `modelProb` the same way
`tierBadge()` does, then checking `isGreenFlagged`) would trigger
correctly on any live fixture whose league+derived-tier matches a
flagged cell — described here rather than fabricated, since no
qualifying live fixture happened to be at the matching tier during
this session's testing window.

## Final report — Part D of the brief

**18. Addendum written**: this section, in full, above — methodology,
pooled-by-tier results with 95% CIs, the full per-league × tier
breakdown, block-level volumes, and the honest-labeling caveat are all
here. (A follow-up session backfilled the per-league table and the
pooled CIs, which the original overnight write-up had flagged as
missing due to a lost credential at the time — see the note at the end
of Part B above.)

**19. `docs/model-versioning.md` updated** with the new
Historical/Live/Combined framework as the standing definition for all
future retrain cycles (Historical's two-source model, Live's
version+date filtering, Combined's pooling formula, and the
handoff-detection design with its manual step spelled out).

**20. Green-flag feature confirmed working end-to-end**, including
honest disclosure of the two bugs above, found and fixed via actual
testing rather than assumed correct.

**21. Compute time**: ~78 minutes of actual GBDT training summed
across the 4 blocks (17m35s + 19m6s + 20m14s + 21m28s), ~81 minutes
wall-clock for the training phase specifically since blocks ran
strictly sequentially with brief gaps between. **API usage: zero new
Odds API or API-Sports calls** — every block trained and scored
entirely from data already on disk (`backfill-historical.json`,
`closing-odds.json`), matching the near-zero cost assessment made
before starting.

**22. Auto-retrain gate**: re-verified via `/api/admin/gbdt-status`
before starting and after every one of the 4 blocks —
`autoRetrainEnabled: false`, `retrainPending: false`, live model
`trainedAt`/`trainN` unchanged throughout (still the 2026-08-08 retrain,
`trainN=40,202`). Confirmed unchanged again after the final deploy.

**23. Temporary diagnostic endpoint cleanup**: `/api/diagnostics/walkforward-planning`
(used only for block-boundary volume checks) removed and confirmed
`404` on the live server. The permanent walk-forward admin endpoints
(`trigger-walkforward-block`, `walkforward-status`, `walkforward-log`,
`walkforward-raw-bets`, `walkforward-pool`) were deliberately kept —
same treatment as the weekly-retrain-cycle endpoints, since they're the
mechanism for ever re-running this exercise deliberately in the future,
not one-off diagnostics.

**Ambiguities resolved autonomously, flagged plainly per the brief's
own instruction**:
- The walk-forward window couldn't end "now" as originally scoped, due
  to a real, previously-unknown data gap (near-zero volume 2025-06
  through 2026-06) — shifted to 2023-06-01 → 2025-06-01, the most
  recent genuinely-dense 24-month span.
- "Combined" was implemented as a new 4th stacked sub-row alongside the
  existing Historical/Continuous/Live readings, not a replacement of
  any of them, since removing Continuous wasn't asked for.
- The two green-flag persistence bugs were caught and fixed during this
  session's own verification, not left undiscovered.
- The per-league × tier breakdown table and its CIs are the one
  genuinely incomplete piece of this write-up, for the credentials
  reason explained in Part B — everything else in the brief is
  complete and verified.

**Constraints honoured throughout**: no change to `LEAGUE_CONFIG`
real/paper status for any competition; no change to scoring, EV, or
bet-triggering logic (Part C is display-only, confirmed by inspection —
`toggleGreenFlag()` only writes to `green-flags.json`, nothing in the
scoring/EV/locking path reads it); sequential-only execution, no
parallel training jobs, respecting the 512MB instance constraint;
`docs/calibration-rules.md` followed throughout — this is the single,
deliberate walk-forward exercise, not to be iterated on if the results
disappoint.

## Addendum 22 — Synthesis and decision-support report: current model state, and where to focus effort and money

A pure synthesis pass — no new data, no new statistical test, no
single-look budget spent anywhere in this addendum. Everything below is
organization and reconciliation of findings already made (the Phase 0
model-strength pass, Parts 1-5 of the standings/recency/tournament/
live-calibration brief, and Addenda 19-21), plus arithmetic on
already-computed, already-stored numbers (pooled averages of existing
per-cell ROI figures — not a new CI, not a new model score). Written
because real money is going live this weekend on specific green-flagged
cells, and the prior work never pulled into one place what that
specifically implies.

### Part 1 — Where the model is demonstrably strong and weak, one narrative

**Strong, high-confidence:**
- **Home-outcome calibration is tight** — Phase 0's live sweep found
  errors mostly under ~1.7pp through 75-80% (in-sample read, live model).
- **Standings is a genuinely well-used signal architecturally** — the
  single highest-usage GBDT feature (~21% of splits), consistent across
  the live model and all 4 independently-trained walk-forward blocks
  (Phase 0) — the earlier scoping-conversation concern that it was
  underweighted was directly wrong; what *was* true is that the old
  hand-set `WEIGHTS_BY_CONTEXT.standings` value is dead code for the
  live GBDT path (confirmed by code read, Phase 0 follow-up).
- **League One/League Two's pooled overall ROI is not distinguishable
  from zero** (Addendum 19: League One −3.6% CI[−9.8%,+2.5%], League Two
  +4.2% CI[−2.7%,+11.0%], both on decision-grade n) — a genuinely
  evidenced null, not an under-sampled one, at the whole-league level.

**Weak, high-confidence:**
- **League One/League Two show real, tier-increasing overconfidence
  from 50-55% upward** (Phase 0 live sweep) — and critically, this read
  is **not** an in-sample artifact: `EXCLUDED_LEAGUE_IDS` in
  `gbdt-train.js` means the live model has never trained on either
  league, so this is a genuine unseen-population read, same evidentiary
  status as Addendum 19's own backtest. League One: 50-55% +5.3pp →
  80%+ +21.8pp. League Two: 50-55% +6.5pp → 80%+ +21.6pp. See the
  per-cell reconciliation below for exactly which currently-flagged
  cells this touches.
- **League One's 50-55% tier has a real, CI-excluding-zero negative
  finding**: n=230, ROI −15.5%, CI (−30.1%, −0.9%) — the single cell in
  the entire League One/League Two matrix whose confidence interval
  doesn't span zero (Addendum 19/`league-tier-matrix` data). This sits
  directly between two currently-flagged cells (45-50% and 60-65%) —
  see below.
- **The historical scorer fabricates standings for cup/knockout
  fixtures** (Part 1/4): `scoreFixtureFromPool` never calls
  `standingsScore()`, instead reconstructing a naive rolling-points
  table per `leagueId_season` — nonsensical for a pure-knockout
  competition. Confirmed empirically: 0 of 9,551 CL/EL/Conf/Carabao Cup
  training records have neutral-50 standings on either side — every one
  gets a real-or-fabricated number, feeding the model's most-used
  feature. **Does not affect League One/League Two** — both are genuine
  round-robin league competitions, so the same rolling-points
  reconstruction is legitimate there, not a bug (confirmed by
  competition structure, not assumed).
- **A full season (2025-26) plus the 2026-27 season-start is missing**
  for PL/La Liga/Serie A/Bundesliga/Ligue 1/Champions League/Europa
  League/Conference League (Part 2, root-caused as stale config, not a
  scheduling artifact). **League One/League Two are much less affected**
  — they have 2025-26 in full, missing only the just-started 2026-27
  (Part 2) — the recency gap is not a material caveat for this
  weekend's flagged cells specifically.

**Weak, lower-confidence (real, but thinner evidence — don't over-read):**
- **No confirmed model-strength trend over time.** The 4 walk-forward
  blocks show log-loss 0.9869 / 0.9969 / 0.9844 / 1.0076 — no monotonic
  direction, block 4 (most recent, 2024-12→2025-06) nominally worst on
  both log-loss and Brier. See the dedicated resolution below — this
  question gets a direct answer, not left ambiguous.
- **Away-outcome calibration degrades at high confidence** more than
  home does (Phase 0: 70-75% away errorPp −9.5pp on n=148 — real but
  thin), and the population is structurally lopsided (69% of all
  fixtures get <35% away-win probability) — a real pattern, but the
  highest-tier cells are too thin to be more than directional.
- **Calibration bias direction may be drifting block-to-block** — blocks
  1/3 skew underconfident at upper tiers (the historically-documented
  pattern since Addendum 2), block 4 skews mixed/overconfident at
  several of the same tiers — but individual cells at n=65-101, genuinely
  too thin to call this confirmed.
- **Injuries (both sides) and `homeAdv_away` are zero-usage GBDT
  features** — confirmed exactly 0 splits across all 5 independently-
  trained models. Root-caused for injuries (lineup data covers only
  ~8.9% of fixtures, the rest get a near-constant default). This is a
  missed-opportunity finding, not something currently degrading live
  predictions — these features were never contributing either way, so
  this doesn't change anything about how much to trust current output.

**Traceability**: every claim above cites its source finding (Phase 0,
Part 1/2/3/4, or the named prior Addendum) — nothing here is a new
number.

### Part 2 — The block-4-weakest question, resolved plainly

**Direct answer: the existing 4 walk-forward blocks cannot settle
whether this is a real trend or noise, and the honest thing to do is
say so rather than pick a side.** The observed spread (log-loss 0.9844
to 1.0076, a range of 0.023) sits at a magnitude that's entirely
plausible as sampling noise at n=1,633-2,207 per block — every CI this
project has ever computed at comparable sample sizes (e.g. Addendum
19's own league-level ROI reads, or the per-tier CIs in the
`league-tier-matrix` data pulled for this addendum) has been wide
enough that a gap this size would not exclude zero. Confirming or
ruling this out for real would require a fresh statistical test against
new data — explicitly out of scope for this synthesis-only pass.

**What it implies for real money this weekend: very little, directly.**
The walk-forward blocks' population is the 10 in-sample leagues (PL, La
Liga, Serie A, Bundesliga, Ligue 1, Scottish Prem, Eredivisie, Primeira
Liga, Champions League, Europa League) — `EXCLUDED_LEAGUE_IDS` keeps
League One, League Two, and Carabao Cup out of every walk-forward block,
same as out of live training. **None of the 6 currently green-flagged
cells are in a league the block-4 question is even about.** The
trend-ambiguity finding is real and worth carrying into Phase 1
prioritization, but it is not a reason to hesitate on this weekend's
specific decision — the two questions are about different leagues
entirely.

### Part 3 — Every currently green-flagged cell, reconciled against every relevant finding

Pulled live from `/api/green-flags` (current state, not a new
computation) and cross-referenced against `/api/league-tier-matrix`
(Addendum 19's stored real-backtest ROI/CI) and Phase 0's live-sweep
calibration read. Six cells, all in League One (41) and League Two
(42) — none in any other currently-positive league.

| League | Tier | n (backtest) | ROI | 95% CI | Calibration error (Phase 0) | Below decision floor? | Verdict |
|---|---|---|---|---|---|---|---|
| League One | 45-50% | 259 | +5.7% | (−10.5%, +21.9%) | +0.71pp (negligible) | Yes (n<300) | Cleanest of the six — CI spans zero but isn't badly skewed, calibration essentially fine |
| League One | 60-65% | 144 | +11.3% | (−6.3%, +28.9%) | +6.07pp (moderate overconfidence) | Yes | Positive point estimate, but thin n and real measured overconfidence |
| League Two | 45-50% | 335 | +15.4% | (−3.9%, +34.7%) | +1.24pp (negligible) | Borderline | Second cleanest — CI nearly clears zero on the low side, calibration fine |
| League Two | 50-55% | 278 | +4.3% | (−10.9%, +19.4%) | +6.46pp (moderate overconfidence) | Yes | Inconclusive ROI, real amber flag from calibration |
| League Two | 55-60% | 180 | +15.5% | (−5.5%, +36.5%) | +8.52pp (large overconfidence) | Yes, well below | Flattering point estimate on a thin, overconfidence-flagged cell — treat with real caution |
| League Two | 65-70% | 77 | +3.8% | (−19.3%, +26.9%) | +7.97pp (large overconfidence) | Yes, very thin | Weakest-evidenced of the six — very thin n, real overconfidence |

**Recency gap**: does not materially affect any of these six — League
One/Two have full 2025-26 data, only missing the just-started 2026-27
(Part 2).

**Standings fabrication**: does not affect either league — both are
genuine round-robin competitions, not the cup/knockout structure the
Part 1 bug applies to.

**The one piece of context every one of these six cells should be read
against**: League One's 50-55% tier — immediately between two of the
flagged cells (45-50% and 60-65%) — is the single cell in this entire
matrix with a confidence interval that excludes zero, and it's negative
(−15.5%, CI −30.1% to −0.9%). It was correctly not flagged. But its
existence is a reminder that a clean reading at 45-50% or 60-65% doesn't
tell you much about the tier five points away — this model's
performance is not smooth or monotonic across nearby tiers in these two
leagues, evidenced directly, not inferred.

### Part 4 — Two priority lists

**Model-improvement priority order (Phase 1 sequencing) — impact ×
confidence, highest first:**

1. **Fix standings fabrication in `scoreFixtureFromPool` for
   cup/knockout competitions** (Part 1/4). Highest-usage feature,
   confirmed bug (not a hypothesis), affects real training data for
   CL/EL/Conf/Carabao Cup.
2. **Close the league-recency gap** (Part 2). Root-caused, affects the
   majority of major leagues' current-season signal freshness, and
   blocks a cleaner future walk-forward re-run that could actually
   resolve the block-4 trend question with fresh, current data.
3. **Implement the last-season-standing proxy for early-season
   fixtures** (Part 3). Evidenced (~2.6x current signal's correlation
   at the exact population where neutral is used today), cheap, no new
   data needed.
4. **Extend the live domestic-blend mechanism to cover standings** for
   cup fixtures (Part 1's missed-opportunity finding) — same population
   as #1, live-prediction side rather than training side.
5. **Re-attempt the block-4 trend question once #2 is closed** —
   currently inconclusive on existing data; deprioritized until a
   fresher walk-forward run is possible, not because it doesn't matter.
6. **`homeAdv_away`/injuries feature-engineering review** (Part 4,
   speculative). Lower priority — these features being unused isn't
   currently hurting anything, just leaving value on the table.
7. **Two-legged tie handling** (Addendum 20, revisited in Part 4 with
   no new evidence this cycle). Lowest priority of the identified
   threads — deferred twice now for lack of a clean way to fold it in.

**Real-money deployment risk ranking — currently green-flagged cells,
lowest risk to highest, per the reconciliation table above:**

1. League One 45-50% — cleanest evidence, though still not decision-grade.
2. League Two 45-50% — second cleanest, CI nearly clears zero.
3. League Two 50-55% — inconclusive ROI, real calibration amber flag.
4. League One 60-65% — thin n, real moderate overconfidence.
5. League Two 55-60% — thin (well below decision floor), large measured
   overconfidence behind a flattering point estimate.
6. League Two 65-70% — thinnest and most overconfidence-flagged of the
   six.

This ranking is descriptive, not a recommendation to bet or not bet on
any of them — it makes the existing evidence picture explicit so the
decision can be made with full information, per the brief.

### Part 5 — The pooling risk, addressed directly with real numbers

The instinct this section exists to head off: pool "everything 45%+"
across League One and League Two and it looks encouraging. Doing that
arithmetic on the already-computed per-cell figures above (a weighted
average, not a new statistical test):

- League One, 45-50% through 80%+ pooled: n=991, ROI **−1.06%**.
- League Two, 45-50% through 80%+ pooled: n=1,073, ROI **+7.50%**.
- Both leagues combined, 45%+ pooled: n=2,064, ROI **+3.39%**.

A pooled +3.39% looks like a mild, broadly positive signal. **It isn't
one.** That number is arithmetically compatible with League One's 50-55%
tier being genuinely, confidently negative (the one CI-excluding-zero
cell in the whole matrix) sitting right next to two much smaller,
CI-spanning-zero positive cells — the pool doesn't know the difference
between "broadly positive" and "one bad cell smeared thin by several
inconclusive neighbors." The same caution applies to League Two's
pooled figure: two of its four best-looking cells (55-60%, 65-70%) are
exactly the ones flagged above as thin and overconfidence-affected —
their positive point estimates are doing real work in that +7.50%
pooled number despite being the weakest-evidenced cells in the league.

**Direct takeaway for "just bet everything 50%+" as an instinct**: the
evidence here argues against reading any pooled figure above the
cell level for these two leagues specifically. The six flagged cells
were, correctly, chosen individually rather than as a blanket
threshold — this section confirms that discipline mattered: a
threshold-based approach would have included League One's 50-55% tier,
the one cell this whole matrix has real, CI-excluding-zero negative
evidence against.

### Compliance

Zero new API calls, zero new data, zero new statistical tests — every
number in this addendum was already computed and stored (Phase 0,
Parts 1-5, Addendum 19's `league-tier-matrix` entries) or is a plain
weighted average over those existing numbers. Auto-retrain gate
re-verified before and after this synthesis pass: `autoRetrainEnabled:
false`, model unchanged (`trainedAt: 2026-08-08`, `trainN: 40,202`).
No temp endpoints were created for this addendum — it required none.

## Addendum 23 — Reconciling League One/Two overconfidence against the original leagues' underconfidence history, and whether a narrower Platt-style correction is worth revisiting

Synthesis/assessment only, per its own brief — no new statistical test,
no retrain, no fresh single look spent anywhere below. Everything here
reconciles and reasons from Addendum 2 (the original Platt-scaling
test), Addendum 14's Extension 3 (the 50-55% pick-type deep dive), and
Addendum 22/Phase 0's League One/League Two finding.

### Part 1 — The underconfidence finding and the broad correction, stated plainly

**Scope, precisely**: Addendum 2's Platt test covered 4 of the 9
originally-validated leagues — the ones with a genuine `VALIDATED_SPLITS`
boundary at the time (Premier League, Ligue 1, Champions League, Serie
A) — restricted to the 45-70% predicted-probability band, on the model
version live at that point (well before the current retrain).

**The finding**: real, measured underconfidence throughout the band —
before correction, calibration error ran −5.1pp to −26.7pp across tiers
(worst at the thin 65-70% edge). A pooled Platt transform
(`sigmoid(0.1585 + 1.8313·logit(raw))`, chosen over per-league fits on
train-only evidence) fixed this convincingly in the 50-65% core:
calibration error there went from −5.1pp/−9.5pp/−11.3pp to
+0.7pp/+0.0pp/+0.9pp — essentially exact.

**What happened when it was applied**: pooled ROI on the single test-set
look **dropped from +17.7% to +9.6%** (posEdgeN rose 203→312, a +54%
volume increase). Two of four leagues declined sharply (Premier League
+21.3%→+2.7%, Serie A +21.8%→+11.5%); the other two were roughly flat
(Ligue 1 +11.3%→+12.2%, Champions League +16.6%→+17.0%).

**Why, mechanistically, despite the underlying miscalibration being
real**: the correction only ever pushes probability *up* in this band
(`A>1, B>0` structurally guarantees zero bets are ever dropped, only
added). It doesn't re-price the existing edge — it pulls new marginal
fixtures over the 5%-edge threshold that didn't qualify before, and
those newly-qualified bets performed worse than the original set in
every tier that had any (+4.2% at 45-50%, but **−3.7%, −9.0%, −8.8%**
at 50-55/55-60/60-65%). The already-documented extension to this
addendum pins the mechanism exactly: **the drag is concentrated, not
uniform** — 45-50% (by far the highest-volume tier, the only cells in
the whole exercise whose CI excludes zero, a genuine well-evidenced
edge) was barely touched by the correction (+30.2%→+27.3%, still
strongly positive) because raw calibration there was closest to
accurate already. The 50-70% range is where the correction did its
calibration work *and* where it added all of its unprofitable new
exposure — the same place, which is the single clearest reason the
pooled result came out negative-to-flat.

### Part 2 — Reconciling against League One/Two, and where a narrower correction might actually work

**The directional reconciliation, stated directly**: the original 4
leagues' 45-70% band is **underconfident** (actual hit rate exceeds
predicted — the model is too cautious, correctable only by pushing
probabilities *up*). League One/League Two's 50%+ tiers are
**overconfident** (predicted exceeds actual — the model is too bold,
would need correcting *down*). These are opposite-direction problems in
different corners of the same model, on different league populations,
discovered by different methodologies (a fitted Platt transform vs. a
live-sweep calibration read) — **there is no single global miscalibration
story here, and no single global correction could address both at
once.** This on its own is a real, useful reconciliation: it rules out
"the model has one bias" as a mental model going forward, and confirms
any future correction work has to be scoped per-population, never
applied as a blanket multiplier — which is exactly the lesson the
broad Platt attempt already taught the hard way, now showing up as a
second, independent confirmation from the opposite direction.

**Does the League One/Two finding itself suggest its own narrower
correction?** Not yet, on existing evidence — flagged plainly rather
than reached for. Nothing gathered in Phase 0 or Parts 1-5 broke League
One/Two's overconfidence down by pick-type or by sub-league driver the
way Extension 3 did for the original leagues' 50-55% tier. Recommending
a specific narrow scope for a downward correction there would be
reaching beyond the evidence — a real Phase 1 candidate in its own
right (see Addendum 22's priority list), but a separate one, not a
"narrower Platt" case yet.

**Where a narrower version of the *original* underconfidence correction
could plausibly succeed — reasoning from evidence already gathered:**

- **Narrowing the *band* wouldn't obviously help.** A correction
  restricted to just 50-65% (the tier range where calibration
  improvement was cleanest) would still pull in exactly the same
  newly-qualified population that lost money in every one of those
  tiers (−3.7%, −9.0%, −8.8%) — without 45-50%'s genuine edge to offset
  it. On the existing evidence, a band-narrowed-only correction looks
  like it would perform *worse* than the original 45-70% version, not
  better — the 45-50% tier wasn't diluting the pooled number, it was
  propping it up.
- **Narrowing by *pick-type* is the one candidate with real, coherent,
  double-sourced support.** Addendum 14's Extension 3 (50-55% tier, all
  9 original leagues, a different population/window than Addendum 2's
  exact Platt test, so this is a corroborating adjacent signal, not a
  literal re-use) found away picks almost three times more underconfident
  than home picks (−11.2pp vs. −3.6pp, on a genuinely well-powered n=112
  away calibration sample) — and away was also the pick type showing
  the better (if thin, n=14) ROI. Phase 0's broader live sweep
  independently found the same directional pattern at higher confidence
  tiers too (away calibration degrading more than home's). A correction
  scoped to away picks specifically, by construction, would never touch
  the home-pick population at all — meaning it structurally cannot
  repeat the exact failure mode that sank the broad version (diluting a
  fine home-pick population with weak new exposure), because it
  wouldn't add any home-pick bets in the first place.
- **Narrowing by *league* is weaker evidence.** Addendum 2's own
  per-league split shows real variation (Ligue 1/Champions League
  roughly flat, PL/Serie A declining sharply) — a plausible lead, but
  Extension 3's per-league calibration cross-check at 50-55% came back
  genuinely mixed/inconsistent (Serie A's calibration gap lines up with
  good ROI, Eredivisie's doesn't, La Liga shows good ROI *without* a
  calibration gap at all) — not a clean enough story to recommend a
  specific league-scoped target the way pick-type's is.

### Part 3 — What's changed since the original test that could justify revisiting it

Three concrete, real changes, none of which existed when Addendum 2's
"not worth it, as tested" verdict was written:

1. **Population has grown substantially** — the scored population is
   67,791 records today; Addendum 2's test-band population was a few
   hundred to ~1,000 fixtures per league within the 45-70% window.
   Growth this large should meaningfully shrink the CI width on a
   pick-type-scoped subset that was previously too thin to act on
   (away picks at n=14/n=112 in the two readings above).
2. **The live model has been properly retrained** since — Addendum 2's
   correction was fit against an earlier model version, now superseded
   (`trainedAt: 2026-08-08`, `trainN: 40,202`). A stale correction
   shouldn't be assumed to transfer; any revisit needs a fresh fit
   against the current model's own raw probabilities, not a reuse of
   the old `A=1.8313, B=0.1585` parameters.
3. **Genuine walk-forward infrastructure now exists** (Addendum 21) —
   at the time, Addendum 2 explicitly flagged this exact gap: *"If this
   is worth pursuing, it needs a fresh train/test cycle with the
   narrower band decided in advance, not a re-slice of today's test
   result."* A rolling walk-forward design is a stronger version of
   that ask than even Addendum 2 anticipated — multiple genuinely
   out-of-sample windows instead of one holdout, directly addressing
   the "was this one test-set look just noise" concern that a single
   fixed holdout can never fully answer.

### Part 4 — Recommendation

**Go — but narrowly, and only as a properly re-sequenced fresh cycle,
not a revival of the old parameters.**

**Suggested scope for a Phase 1 candidate, in priority order:**

1. **Primary candidate: a pick-type-scoped correction (away picks only),
   45-70% band, on the current model, fit train-only against a fresh
   split.** This is the one candidate with real, coherent, two-source
   supporting evidence, and the one whose scoping mechanism directly
   avoids the exact failure mode that sank the broad version — it
   cannot dilute the home-pick population because it never touches it.
2. **Validate with the walk-forward infrastructure, not a single
   holdout** — Addendum 21's block design is now the right tool for
   exactly the concern Addendum 2 itself raised about one-off test
   results, and gives a genuine multi-window read on whether an
   away-pick correction's benefit is stable or was itself a one-window
   artifact.
3. **Do not narrow by band alone** — existing evidence argues this
   would likely make pooled ROI worse, not better; not worth spending a
   cycle on without pairing it with the pick-type scoping above.
4. **League-scoping stays a secondary, lower-confidence lever** — worth
   checking as a cut *within* the away-pick analysis (does Ligue
   1/Champions League's relative flatness hold up there too), not as
   its own primary axis.
5. **League One/League Two's overconfidence is a separate, real
   finding that needs its own evidence-gathering before any correction
   design** — not folded into this recommendation. Its priority and
   next step are already captured in Addendum 22's Phase 1 list;
   nothing here changes that.

**If the evidence didn't support this**, the honest call would be to
say so — it doesn't fully clear that bar on its own yet (the away-pick
ROI evidence specifically is still thin, n=14 in the one direct read),
but the *combination* of a coherent, two-source calibration signal, a
scoping mechanism that structurally avoids the known failure mode, and
three genuine infrastructure/data improvements since the last look is
enough to justify a properly-sequenced fresh cycle — not enough to
justify skipping straight to a conclusion.

### Compliance

Zero new API calls, zero new data, zero new statistical tests, zero
retraining — every figure above is quoted from Addendum 2, Addendum
14's Extension 3, or Addendum 22, or is a plain restatement of already-
published numbers. Auto-retrain gate re-verified: `autoRetrainEnabled:
false`, model unchanged (`trainedAt: 2026-08-08`, `trainN: 40,202`).

## Addendum 24 — computeUnifiedEdge bug found and fixed: Addendum 19's figures were frozen behind a silent fallback, not genuinely recomputed post-Track-A; corrected figures

Triggered by a direct question — does Addendum 19's League One/League Two
backtest reflect the post-Track-A corrected `computeMatchedEdgeFixtures()`
logic? Investigating it surfaced a real, previously undetected bug, not a
staleness question with a clean yes/no answer.

### What was found

Track A (`a18886f`, 2026-08-14) replaced `LEAGUE_TIER_MATRIX`'s hand-written
Carabao Cup/League One/League Two entries with `buildUnseenPopulationMatrix()`
— a live computation via `computeMatchedEdgeFixtures()` → `computeUnifiedEdge()`
— described in its own commit comment as reading "the full matched population
directly... with the corrected edge/dataConf." That intent was never actually
realized: `computeUnifiedEdge()`'s internal `marginStrippedImplied()` read
`rawOdds.home`/`.away`/`.draw`, but its only two callers (`computeMatchedEdgeFixtures()`
and this investigation's own temp diagnostic) both pass a closing-odds record
shaped `{homeOdds, drawOdds, awayOdds}` — the convention used everywhere else
in this codebase. Every field read `undefined`, `1/undefined = NaN`, and
`edge` came back `NaN` for every fixture, silently, from the moment Track A
deployed.

Every downstream consumer filters on `edge >= 0.05`, so the "positive edge"
population was empty **app-wide**, not just for these three leagues, for the
four days between Track A and this fix — confirmed directly via
`/api/ev-calibration`: `positiveEdge: 0`, `positiveEdgeRoi: null`,
`kellyRecommendation: 'flag_for_review'`, across all 14 leagues.
`buildUnseenPopulationMatrix()` has its own documented fallback for exactly
this case ("falls back to that snapshot only if the live computation finds
nothing"), so `/api/league-tier-matrix` silently kept serving the frozen
pre-Track-A Addendum 19 numbers for Carabao Cup/League One/League Two the
entire time — which is exactly why they read as unchanged and looked entirely
normal. Nothing about the display suggested a problem; only
`/api/ev-calibration`'s raw output showed the failure mode plainly.

### Real-money impact: none

`runEvCalibration()`'s `paperTradeOnly`/Kelly-fraction auto-management
explicitly skips `roi === null` leagues (`if (!lid || l.roi === null)
continue;`), and `overallKelly === 'flag_for_review'` blocks the paper-Kelly-
fraction auto-update too. Confirmed via a live `settings.json` read:
`paperTradeOnly` and `paperKellyFraction` were unchanged by the bug — League
One's presence in `paperTradeOnly` predates Track A (consistent with its
already-negative original ROI) and was simply never touched by the broken
post-Track-A runs, not newly added by them. This was a reporting/analysis-
layer bug, not a bet-locking one — `scoreOneFixture()` (the actual live
scoring/lock path) computes its own edge inline and never calls
`computeUnifiedEdge()`.

### Fix

`marginStrippedImplied()` now accepts both odds-object shapes
(`rawOdds.home ?? rawOdds.homeOdds`, etc.) — it has no other callers, so
widening its accepted shape is safe everywhere it's used. Deployed and
verified: `/api/ev-calibration` now returns real, non-null figures across
all 14 leagues (`positiveEdge: 10,838` matched fixtures pooled app-wide,
pooled `positiveEdgeRoi: -0.8%`).

### Corrected figures (posEdge ≥5% subset, same convention as Addendum 19)

| League | n (matched) | posEdgeN | ROI | Addendum 19's original |
|---|---|---|---|---|
| League One | 3,344 | 2,231 | −3.9% | posEdgeN 1,580, ROI −3.6% |
| League Two | 3,338 | 2,346 | +3.1% | posEdgeN 1,746, ROI +4.2% |
| Carabao Cup | 330 | 225 | +10.5% | posEdgeN 168, ROI +18.5% |

`posEdgeN` rose materially for all three — expected and mechanical, not a new
finding: Track A's calFactor boost (`modelProb × ~1.11`) pushes more
fixtures over the 5% threshold than the old no-calFactor formula did.
Directionally, both leagues stayed in the same small, inconclusive range
Addendum 19 already reported — this correction does **not** overturn
Addendum 19's headline conclusion (no confirmed edge either way for League
One or League Two) — but the exact per-tier cells shifted, including which
cells clear/miss the rule-6 decision-grade floor. League One's 50-55% tier
still shows a CI excluding zero, now (−28.2%, −4.7%), n=322 (was n=230,
CI (−30.1%, −0.9%)) — same cell, same direction, updated numbers. See
`/api/league-tier-matrix` for the current full per-cell breakdown.

**The six previously green-flagged cells (Addendum 22 Part 3) were curated
against the frozen pre-fix figures and should be reviewed against the
corrected numbers** — this addendum does not re-curate them; that stays a
deliberate, separate human decision per Addendum 21's own green-flag
discipline.

### Constraints honoured

No change to base rates, weights, or scoring logic beyond the field-name fix
itself. No new statistical test or tuning decision — this is a bug fix
restoring Track A's already-approved, already-intended behaviour, not a new
calibration look. `calibration-rules.md` rule 3 ("single look") is not
violated: the corrected read is the first time `computeUnifiedEdge()` has
ever actually executed for this population; every "look" before today was
silently the old frozen snapshot, not a second peek at live data.
`CALIBRATION_AUDIT[41]`/`[42]`/`[48]` updated in place with the corrected
figures and a pointer to this addendum, rather than left describing numbers
that were never actually re-derived.

## Addendum 25 — Variable-strength correction layer: design, one-time train/test cycle, and honest verdict (calibration-rules.md rules 13/14)

Full brief: replace `applyLeagueBiasCorrection()`'s fixed 30% blend with a
variable-strength, football-justified correction, following rules 13/14's
train/test discipline for the correction layer itself, independent of the
core GBDT's own evidentiary status.

### Part 0 — Addendum 19 currency and the League One/Two exemption question

Addendum 24 (immediately prior) already answered the currency question: the
originally-reported Addendum 19 figures (posEdgeN 1,580/1,746, ROI -3.6%/+4.2%)
were frozen behind the pre-Track-A `computeUnifiedEdge` bug, not genuinely
recomputed. The corrected figures (posEdgeN 2,231/2,346, ROI -3.9%/+3.1%) were
verified live against `/api/ev-calibration` at the start of this work and
match Addendum 24 exactly — no further re-run needed.

**Exemption decision**: League One/Two are NOT exempted from needing their own
correction-layer-backtest. Rule 13's test is whether *this specific layer's
own parameters* have touched the data before — not whether some other layer
(the core model) has. No correction of any kind has ever been fit for League
One/Two (their `LEAGUE_CONFIG` entries carry no base rates at all, so
`applyLeagueBiasCorrection()` skips them entirely today — effective strength
zero). Addendum 19/24's frozen population is therefore genuinely available for
a *correction-layer* train/test split, even though it's permanently spent for
the *core model's* backtest — these are different layers with independent
evidentiary status by rule 13's own design. Used the full pre-cutoff matched
population (n=3,344/3,338) as the correction layer's own train/test source,
split chronologically 80/20 within it (see Part 2).

### Part 1 — Design

**Redesign shape**: a scoped correction table (`CORRECTION_LAYER_RULES` in
scoring.js) — each rule matches a (league set, pick-type, probability-band)
combination and applies a Platt-style rescale (`sigmoid(A·logit(p)+B)`) to
just that scope's top-pick probability, renormalising the other two outcomes.
No rule = no correction (strength zero), replacing "30% everywhere" with
"correction only where football-justified evidence supports one."

**Original 9 leagues**: per Addendum 23's own explicit recommendation (Part 4,
item 1) — NOT the broad per-league blend the brief's framing initially implied.
Addendum 23 itself gates this: item 5 of its recommendation states League
One/Two's overconfidence "needs its own evidence-gathering before any
correction design — not folded into this recommendation." Correction scoped
to **away picks only, 45-70% band** (Addendum 23's primary candidate) — home
picks are structurally excluded, the same scoping mechanism Addendum 23
identified as avoiding the broad correction's known failure mode (diluting a
fine home-pick population with newly-qualified, unprofitable exposure).

**League One/Two**: before designing anything, ran the same pick-type × tier
breakdown Extension 3 did for the original leagues (train-only). Result,
unlike the original leagues: **both home and away picks are overconfident**
at 50%+ (League One home -4.8pp to -6.5pp, away -8.0pp to -11.7pp; League Two
home -5.5pp to -26.4pp, away -10.2pp to -16.5pp) — there is no clean
single-pick-type driver the way away picks were for the original leagues'
underconfidence. Scoped the correction to **both home and away picks, 50%+
band**, per league (League One and League Two fit separately — their
miscalibration magnitudes differ meaningfully, especially League Two's home
70-80% cell).

**Scope boundary respected**: no changes to `avgHomeWinRate`/`avgDrawRate`/
`avgAwayWinRate`/`avgGoalsPerGame`/`marketEfficiency`/`drawBaseWeight`/
`homeAdvBaseWeight` anywhere in this work — this redesigns the blend
mechanism only, per rule 10's continued protection of League One/Two/Carabao
Cup's base rates specifically.

### Part 2 — Holdout, domestic-blend exclusion, fit, single test look

**Domestic-blend exclusion (approved interim safeguard) — checked, zero
fixtures affected.** Cross-referenced every team appearing in League One/Two
before the rule-12 cutoff (2026-08-11T09:00:00Z) against every other
domestic-blend league's (`DOMESTIC_LEAGUE_IDS_FOR_BLEND`) fixtures at/after
the cutoff, by team ID, across the full 20,862-fixture matched-odds
population. **Zero boundary-crossing teams found.** Mechanistically expected
in hindsight: `DOMESTIC_LEAGUE_IDS_FOR_BLEND` only includes top-flight leagues
(Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Scottish Premiership,
Eredivisie, Primeira Liga) plus League One/Two themselves — League One's
actual promotion/relegation partner (the Championship) isn't in that set at
all, so no team crosses the specific boundary the safeguard checks for in
this population. The leakage pathway itself (documented in the prior
investigation) remains real in principle; it simply has no live instances
here. No fixtures excluded.

**Holdout**: per-league chronological 80/20 split (last 20% of each league's
own matched population, by date, as test) — a single fixed calendar cutoff
was tried first and rejected once it produced zero test fixtures for 8 of 13
leagues (see recency gap below).

**Real data-recency finding, worth flagging on its own**: the closing-odds-
matched population for most of the original 9 leagues plus Champions
League/Europa League/Conference League stops around May 2025 — over a year
stale relative to today (2026-08-18). Only Eredivisie, Primeira Liga,
Scottish Premiership, League One/Two, and Carabao Cup have matched data
extending into 2026. This means "genuinely recent" (calibration-rules.md rule
12's own phrase) tops out over a year old for 8 of the 11 corrected/reported
leagues — not fixed here (out of scope for this brief), flagged for a
separate closing-odds backfill refresh.

**Fit (train only, per-scope)**:

| Scope | n (train) | A | B | Train log-loss (vs. uncorrected) |
|---|---|---|---|---|
| Original 9, away, 45-70% | 1,084 | 1.7005 | 0.5998 | 0.633 vs 0.681 |
| League One, home+away, 50%+ | 1,077 | 0.9610 | -0.2336 | 0.679 vs 0.687 |
| League Two, home+away, 50%+ | 914 | 0.5540 | -0.2419 | 0.690 vs 0.711 |

All three genuinely improve train log-loss, and all three point the right
direction relative to the underlying finding (A>1/B>0 pushes up for the
underconfident original-9 away scope; A<1/B<0 pushes down for both
overconfident League One/Two scopes, with League Two's stronger compression
matching its worse measured miscalibration).

**Single test-set look (per rule 3 — looked at once, not iterated)**:

| Scope | test n | before: calibErr / posEdgeN / ROI | after: calibErr / posEdgeN / ROI |
|---|---|---|---|
| Original 9, away, 45-70% | 271 | +8.6pp / 59 / +0.6% | -6.2pp / 175 / -0.8% |
| League One, 50%+ | 250 | -0.4pp / 202 / +9.2% | +5.6pp / 135 / +11.9% |
| League Two, 50%+ | 246 | -5.5pp / 198 / +10.3% | +3.9pp / 105 / +22.6% |

(calibErr = actual hit rate − mean predicted probability; positive =
underconfident, negative = overconfident. ROI CIs all span zero at every
row, before and after.)

**Champions League/Europa League/Conference League — no new correction
applied (no evidence base for one), reported as pure context per the brief's
explicit expectation**: test-set posEdgeN 58/48/36 respectively, ROI
+36.0%/+9.5%/+37.8%, CIs enormous (Conference League: -70.4% to +146.1%).
Exactly the indicative-only reading the brief anticipated — reported plainly,
not treated as a finding.

### Part 3 — Rule 14 label and wiring

New `historicalSource: 'correction-layer-backtest'` category — distinct
marker, never reused for/against `real-backtest` or `walkforward-proxy`.
Wired via `CORRECTION_LAYER_BACKTESTS` (server.js) and
`GET /api/correction-layer-backtests`, surfaced in a new, amber-accented
"Correction-Layer Backtests" card on the Performance tab (same visual
language as the Pre-Retrain Calibration Matrix card — explicit warning
banner, no green/red styling on any ROI number since none of these clear
rule 6's decision-grade floor). The card states directly that the core GBDT
remains in-sample for every league shown; only the correction's own
parameters were held out.

### Part 4 — Honest verdict

**None of the three scopes clears the bar for deployment, and the evidence
says so plainly rather than being read as a qualified win:**

1. **All three overshoot on test.** Calibration error flips sign in every
   scope — the original-9-away correction pushed from +8.6pp underconfident
   to -6.2pp overconfident; both League One/Two corrections pushed from
   roughly-accurate-or-mildly-overconfident on test into +5.6pp/+3.9pp
   underconfident. A correction that overshoots the true target on held-out
   data is doing something real, but not yet the *right amount* of it — this
   reads as either train-specific noise the fit picked up, non-stationarity
   (train and test cover different seasons/conditions), or a genuinely
   smaller effect than train suggested. No single explanation is confirmed by
   what's here; flagged as an open question for any follow-up, not resolved.
2. **Every test population sits below rule 6's ~300-400 posEdge decision-grade
   floor** — 59-202 posEdge bets per scope, before or after correction. The
   League Two "+22.6% ROI after correction" figure in particular should not
   be read as a result: it comes from a shrunk posEdgeN (198→105, since
   pushing probabilities down means fewer bets clear the 5% edge threshold)
   and a CI that still spans zero.
3. **This directly echoes Addendum 2/23's own finding** on fresh data and the
   current model: a train-set-evidenced, football-justified, correctly-
   directioned correction still does not automatically produce a confirmed
   test-set win. The discipline this document has followed throughout —
   check directly, don't assume evidence transfers — applies to today's own
   fresh work exactly as it applied to the original 2026-08 cycle.

**Not deployed.** `applyVariableCorrectionLayer()` (scoring.js) is
implemented and committed but not called from `scoreOneFixture()` or the
historical scoring path — deployment stays a separate, deliberate decision,
and on this evidence the honest recommendation is: not yet. A stronger
validation (Addendum 23's own suggestion — Addendum 21's walk-forward
infrastructure, multiple genuinely out-of-sample windows instead of one fixed
holdout) is the natural next step before revisiting deployment, alongside
closing the closing-odds recency gap flagged in Part 2.

### Compliance

Rules 1-3 (chronological split, train-only tuning, single test look): held for
all three scopes. Rule 4 (football-justified, not parameter-chasing): each
scope's direction/magnitude is grounded in measured train miscalibration, not
an eval-metric sweep — and the honest test-set result is reported even though
it doesn't confirm a win. Rule 10: League One/Two/Carabao Cup base rates
untouched. Rule 12: pre-cutoff League One/Two population used only for the
correction layer's own split, per Part 0's reasoning; Carabao Cup untouched
entirely, consistent with its continued rule 10 exclusion. Rules 13/14:
applied as designed — this addendum is itself the first real-world use of
both. Auto-retrain gate re-verified unaffected (no training-path code
touched). Temp diagnostic endpoint (`/api/admin/correction-layer-diagnostic`)
removed after use.

## Addendum 26 — Walk-forward validation of the correction layer, and the stale matched-odds root cause + fix

Overnight, autonomous task. Follow-up to Addendum 25, whose single-holdout
correction-layer test showed calibration flipping sign between train and
test for all three fitted corrections — indistinguishable, on one look
alone, from either "genuinely unstable correction" or "one unlucky test
window." This addendum resolves that ambiguity via multi-block walk-forward
validation (Addendum 21's technique), and separately investigates and fixes
the stale matched-odds-data finding flagged incidentally during Addendum 25.

Sequencing note: Part 2 (staleness fix) was done **before** Part 1
(walk-forward), reversing the brief's listed order — a deliberate,
documented deviation. Running the original-9 walk-forward on stale
(pre-2025) data would have produced a result that needed redoing once the
staleness was fixed; fixing first meant doing the real work once.

### Part 2 — Stale matched-odds data: root cause and fix

**Scope confirmed**: 8 of the 14 tracked leagues/competitions — the
original 9 minus Eredivisie/Primeira Liga/Scottish Premiership (Premier
League, La Liga, Bundesliga, Ligue 1, Serie A, Champions League, Europa
League, Conference League) — had matched-odds data capping around
2025-05-2x, over a year stale relative to today (2026-08-18), despite
`hist.fixtures` itself (the raw fixture population) already extending
through 2026-08 for every one of them — HIST_SEASONS_2010 already includes
2025/2026 and was not the problem.

**Root cause, confirmed via a temp diagnostic comparing fixture coverage
against closing-odds coverage per league/year**: not a stale season/date-
list config bug (the class of bug this project has hit several times
before — LINEUP_SEASONS, HIST_SEASONS gaps). `runClosingOddsBackfill()` has
no date-based exclusion beyond the deliberate, documented `year < 2020`
floor, and is fully idempotent (skips any fixture already in
`closing-odds.json`). The gap was simply that the closing-odds backfill
had never been **re-triggered** for these 8 leagues/competitions since
partway through the 2024-25 season — a "never re-run," not a "ran and
failed" or "config wrong" gap. Confirmed by the partial-then-zero pattern
in the per-year breakdown (e.g. Premier League 2025: 192/378 matched, 2026:
0/194) — a run that stopped mid-season and was never resumed, not a
structural or API coverage limit (Eredivisie/Primeira Liga/Scottish
Premiership/League One/League Two/Carabao Cup all had matched data via the
same Odds API endpoint extending into 2026 already).

**Secondary finding, narrowed but not fixed**: Champions League showed a
genuine 0% match rate for its 2025-2026 fixtures specifically (188 attempts,
0 matches) even after the fix pass — its earlier years (2020-2024) matched
fine (635 total, historically). This lines up with UEFA's 2024-25 reformat
from group stage to a 36-team "league phase," a structurally different
competition format. Root cause not conclusively identified (Odds API
coverage gap for the new format vs. a team-name/scheduling mismatch specific
to it) — flagged as a distinct, smaller-scope follow-up, not fixed here (CL
is a small, already-thin population; not worth further overnight budget on
a secondary issue when the primary 8-league gap was the actual finding).
Europa League showed a similar, milder pattern (lower match rate than the
domestic leagues, plausibly related to the same reformat, though EL still
matched a meaningful fraction unlike CL's near-total miss).

**Fix applied**: re-triggered `POST /api/backfill/closing-odds`, scoped one
league at a time after the first two multi-league attempts were interrupted
mid-run by Render instance restarts (see Compliance section below for the
full incident). Serie A and Europa League turned out to have materially
larger real gaps than the 2025-2026 window alone (Serie A was also missing
2020-2021 entirely; EL was missing most of 2014-2021) — closed as a side
effect of the same fix, not separately scoped.

**Before/after coverage** (matched-odds population size, most recent
matched date):

| League | Before | After | matchedMaxDate before → after |
|---|---|---|---|
| Premier League | 1,900 | 2,372 | 2025-05-25 → 2026-05-24 |
| La Liga | 1,897 | 2,387 | 2025-05-25 → 2026-05-24 |
| Ligue 1 | 1,753 | 2,060 | 2025-05-21 → 2026-05-29 |
| Bundesliga | 1,533 | 1,884 | 2025-05-26 → 2026-05-21 |
| Serie A | 1,140 | 2,404 | 2025-05-25 → 2026-05-24 |
| Champions League | 635 | 635 | 2025-05-31 → 2025-05-31 (unfixed, see above) |
| Europa League | 423 | 891 | 2025-05-21 → 2026-05-20 |
| Conference League | 342 | 478 | 2025-05-28 → 2026-05-27 |

7 of 8 now current to May 2026 — the same recency ceiling as every other
league (football seasons run August-to-May; the 2026-27 season had barely
started as of this task's run date). Champions League remains the one
open gap, clearly scoped and documented rather than silently left unstated.

### Part 1 — Walk-forward validation of the correction layer

**Design**: 4 sequential, expanding-window blocks per population — fit on
all data strictly before each block's start, test on the block, same
technique as Addendum 21. League One/League Two used season-aligned blocks
(2022-23 through 2025-26, since English football runs clean August-May
cycles); the original-9 away-band correction used 6-month blocks over the
most recent 24 months (2024-08 through 2026-08), consistent with Addendum
21's own window-selection precedent. Domestic-blend exclusion re-checked
against the refreshed population — **zero fixtures affected**, same result
as Addendum 25, confirming the finding is stable.

**League One — home + away picks, 50%+ band**:

| Block | test n | before (calibErr / posEdgeN / ROI) | after |
|---|---|---|---|
| 2022-23 | 233 | -3.6pp / 183 / +2.3% | +4.1pp / 102 / +8.0% |
| 2023-24 | 230 | -9.3pp / 176 / -10.6% | -2.9pp / 109 / -15.9% |
| 2024-25 | 214 | +1.7pp / 153 / +10.7% | +8.8pp / 92 / +20.1% |
| 2025-26 (partial) | 206 | -2.3pp / 172 / +3.5% | +3.1pp / 122 / +8.3% |
| **Pooled** | **883** | **-3.5pp / 684 / +1.2%** | **+3.2pp / 425 / +4.6%, CI (-5.5%, +14.6%)** |

Improved but not fully confirmed — ROI improves in 3 of 4 blocks, but block
2 (the block with the worst starting calibration) shows a genuine ROI
regression. Pooled posEdgeN=425 clears rule 6's floor; the CI still spans
zero.

**League Two — home + away picks, 50%+ band**:

| Block | test n | before | after |
|---|---|---|---|
| 2022-23 | 165 | -11.6pp / 142 / -6.5% | -3.2pp / 78 / -1.3% |
| 2023-24 | 218 | -6.9pp / 179 / +13.3% | +3.0pp / 96 / +31.7% |
| 2024-25 | 201 | -12.8pp / 161 / -11.0% | -4.5pp / 90 / -2.6% |
| 2025-26 (partial) | 206 | -4.0pp / 170 / +17.3% | +5.8pp / 91 / +28.1% |
| **Pooled** | **790** | **-8.6pp / 652 / +4.0%** | **+0.5pp / 355 / +14.8%, CI (-0.2%, +29.8%)** |

**The strongest read this project's correction-layer work has produced.**
Every block moves calibration toward zero (from a genuinely bad -8.6pp
pooled to +0.5pp — essentially exact), and ROI improves in every single
block, never regresses. Pooled posEdgeN=355 clears rule 6's floor. The
corrected ROI's CI (-0.2%, +29.8%) nearly excludes zero on the downside.
This clears both bars the correction-layer brief set for "a real candidate
for eventual deployment consideration" — the walk-forward revealed genuine
stability that Addendum 25's single holdout, by construction, could not
distinguish from noise.

**Original 9 leagues — away picks, 45-70% band**:

| Block | test n | before | after |
|---|---|---|---|
| 2024-08 to 2025-02 | 174 | +8.3pp / 30 / -3.2% | -6.5pp / 114 / +0.6% |
| 2025-02 to 2025-08 | 110 | +10.2pp / 32 / +1.7% | -3.8pp / 70 / -2.5% |
| 2025-08 to 2026-02 | 96 | +2.3pp / 24 / -45.8% | -11.3pp / 74 / -26.3% |
| 2026-02 to 2026-08 | 79 | +5.9pp / 18 / -46.0% | -6.5pp / 56 / -20.7% |
| **Pooled** | **459** | **+7.1pp / 104 / -18.9%** | **-6.9pp / 314 / -10.2%, CI (-22.1%, +1.6%)** |

**Genuinely unstable — confirmed, not indicative.** Calibration overshoots
the exact same direction (under- to over-confident) in all 4 independent
blocks — a repeated pattern, not noise. Pooled posEdgeN=314 clears rule 6's
floor even after correction, and the corrected ROI's CI (-22.1%, +1.6%)
nearly excludes zero on the negative side — more confidently *not*
profitable than Addendum 25's single look suggested. This directly answers
the open question from the prior scoping conversation: today's walk-forward
result is architecture-neutral evidence (a 2-parameter correction overshoots
consistently; nothing here implicates the single-model design), but it does
confirm this *specific* correction, as designed, does not work — not "one
bad test window."

### Disposition

`scoring.js`'s `CORRECTION_LAYER_RULES` updated: the original9-away-45-70
rule is **removed entirely** (not just left dormant — walk-forward
positively disconfirmed it). League One/League Two updated to their
most-recent-block (train-to-2025-08) fit parameters. `historicalSource:
'correction-layer-backtest-walkforward'` introduced as a distinct rule-14
label, alongside (not replacing) Addendum 25's `'correction-layer-backtest'`
single-holdout entries — the single-holdout entries are retained for
historical accuracy and marked superseded where the walk-forward reached a
different conclusion. `/api/correction-layer-backtests` and the Performance
tab's Correction-Layer Backtests card both updated with full per-block
detail, pooled reads, and a stability badge (stable/mixed/unstable,
confirmed) per rule 14's visible-distinction requirement.

**Still not deployed live** — including League Two, whose read is the
strongest evidence produced so far. Deployment remains its own separate,
deliberate decision, exactly as both this task's brief and Addendum 25
required.

### Compliance and incident notes

Rules 1-3, 13, 14: held throughout — each population's own train/test
boundary, train-only fitting, single look per block (not iterated), rule 14
labels never conflated. Rule 10/12: League One/Two base rates untouched;
Carabao Cup untouched entirely (not part of either investigation). No
base-rate parameters changed anywhere in this task (confirmed via `git diff`
across every commit touching `scoring.js`).

**Operational incident, disclosed in full**: the multi-league closing-odds
backfill runs were interrupted twice by Render instance restarts — once
caused directly by a `git push` mid-run (a genuine mistake: deploying while
a long-running in-memory background job was active), once by a concurrent
heavy diagnostic request (the raw-probs dump, which runs GBDT inference over
20,000+ records) colliding with the backfill on a memory-constrained
instance. Both were caught via the backfill status endpoint resetting to its
default in-memory state (`startedAt: null`) rather than showing genuine
completion — the difference between a real "done" and an instance restart
disguised as one. No data was lost beyond the last unsaved batch (progress
persists every 200 matched fixtures); both times, the backfill was simply
re-triggered — idempotent by design, so this cost time and API credits, not
correctness. Switched to single-league runs with no concurrent heavy
requests for the remainder of the task, which completed without further
incident. Worth a standing note for future overnight/background work on
this instance: **do not deploy code or run heavy diagnostic endpoints while
a long-running background job (backfill, retrain, walk-forward block) is
active** — this instance does not have headroom for both.

**API usage**: Odds API credits used this task ≈ 69,420 (4,901,318 →
4,831,898 remaining; reserve line 1,000,000, never approached). API-Sports
quota: negligible additional usage (~302 total for the day, consistent with
routine cron activity — this task made no API-Sports calls directly).
Auto-retrain gate re-verified `false` throughout; model unchanged
(`trainedAt: 2026-08-08`, `trainN: 40,202`) — no training-path code touched.
Both temp diagnostic endpoints (`/api/admin/correction-layer-diagnostic`,
`/api/admin/matched-odds-coverage-diagnostic`) removed and confirmed 404
after this addendum's work concluded.

## Addendum 27 — Fixing an over-broad domestic-blend holdout filter, banking Carabao Cup's corrected backtest, and retiring "permanent" holdouts (calibration-rules.md rule 15)

### Part A — The over-broad filter, and why it degraded Carabao Cup

The 9c49e45 domestic-blend leakage fix (2026-08-19) closed a real gap —
`buildDomesticTimeline()` was being built from the full historical fixture
pool, meaning a training-eligible fixture's own standings input could be
computed using data from fixtures dated *after* it, a genuine leak into
training. The fix, as shipped, filtered every fixture in the pool down to
just the training-eligible ones before building the timeline — one filtered
pool, applied uniformly regardless of a fixture's own status.

That uniform application was over-broad. A fixture that is *itself* a
training holdout (Carabao Cup, 100% of League One/Two/Championship's
frozen backtest windows) never trains anything no matter what data computed
its own score — the leakage concern the fix existed to close simply does
not apply when scoring a holdout fixture's own record. But the shipped fix
gave holdout fixtures the same training-eligible-only filtered pool anyway,
which for Carabao Cup meant most fixtures lost access to genuine, recent
cross-league standings and fell back to nulls or multi-year-stale snapshots
instead. Traced via `/api/_diag/domestic-blend-trace`: **928 of 1,101
(84.3%)** of Carabao Cup's scored fixtures changed between the pre-fix
("old", fully unfiltered) and post-fix ("buggy", uniformly filtered) states
— a scale far beyond what the original leakage concern justified.

**Fix**: choose the domestic-blend timeline per fixture, not once per
batch. A fixture that is itself a training holdout gets the full,
unfiltered timeline (byte-identical treatment to the pre-9c49e45 state,
since its own score never trains anything). A training-eligible fixture
keeps the filtered pool exactly as before — zero regression to the
original leakage protection, since that population's filter is unchanged.

**Verification, re-run after the corrected rescore**: 0 of 1,101 (0%)
Carabao Cup fixtures now differ from the fully-unfiltered ground truth —
the degradation is fully reversed, not merely reduced. League One/Two's
own training-eligible (post-cutoff) population is filtered exactly as
before; the filter logic itself did not change for them.

### Part B — An incidental discovery: League One's own frozen reading had drifted too, for a different, smaller reason

Comparing the corrected rescore's `/api/league-tier-matrix` output against
a baseline captured immediately before Part A's fix, League One's own
reported figures had moved (n 2,231→2,227, several tiers redistributed by
double digits) while League Two's were byte-for-byte unchanged. Per rule
15's evidentiary bar (a fixture-level trace, a clear mechanism, a bounded
scope — see calibration-rules.md), this was investigated rather than
assumed:

- **Mechanism**: Championship (league 40) joined
  `DOMESTIC_LEAGUE_IDS_FOR_BLEND` on 2026-08-19 (commit `fdab315`, part of
  Championship's own onboarding), but Championship's historical backfill
  ran with `rescore=false` — it added Championship's own fixtures without
  recomputing anyone else's scoring. Today's rescore (needed to fix
  Carabao Cup) was the first one to actually touch League One's own
  scoredRecords since Championship joined the blend pool.
- **Scope**: a targeted trace (extending `/api/_diag/domestic-blend-trace`)
  compared each League One/Two fixture's own domestic-blend standings
  input against a pool that excludes Championship entirely. League One:
  **44 of 8,219 (0.5%)** fixtures changed. League Two: **0 of 8,244 (0%)**
  — consistent with League One being Championship's actual
  promotion/relegation partner and League Two not being one.
- **Nature of the change**: not contamination — the same known defect Part
  A fixed, just a small pre-existing corner of it. Every one of the 44
  fixtures involves a Championship-mainstay club (Cardiff, Birmingham,
  Reading, Blackpool, Wigan, Derby, Rotherham, Huddersfield, Peterborough,
  Plymouth, Luton) whose most-recent blend-eligible standing, before
  Championship was in the pool, was falling back to a snapshot from years
  before Championship even existed in this system. Concrete examples from
  the fixture-level trace: Cardiff's standing snapshot moved from
  **2019-05-12 → 2025-05-03**; Birmingham from **2011-05-22 → 2024-05-04**;
  Reading from **2013-05-19 → 2023-05-08**; Derby had no usable snapshot at
  all before Championship joined the pool (`null → 2023-05-07`).

This clears rule 15's three-part bar for a legitimate correction (traced,
mechanistic, bounded) rather than a re-peek: it was discovered as a side
effect of unrelated work, not sought out; the mechanism is a specific,
dateable code change; and the scope is 44 of 2,231 fixtures (2%), not the
whole population moving in a favorable direction.

**Corrected figures, per calibration-rules.md rule 15's decision (accept
and re-document, matching Addendum 24's own precedent for a different bug)**:

| League | Metric | Original (Addendum 24) | Corrected (this addendum) |
|---|---|---|---|
| League One (41) | posEdgeN | 2,231 | 2,227 |
| League One (41) | ROI | -3.9% | -2.36% |
| League Two (42) | posEdgeN | 2,346 | 2,346 (unchanged) |
| League Two (42) | ROI | +3.1% | +3.07% (rounding-level, unchanged) |

League One's conclusion is unaffected: still comfortably negative, still no
confirmed edge — the 2% correction moves the number closer to breakeven but
nowhere near flipping the substantive read. `CALIBRATION_AUDIT[41]`'s note
documents the correction in the same "corrected: X (was Y)" style already
used for the Addendum 24 `computeUnifiedEdge` fix. `CALIBRATION_AUDIT[42]`
now records the explicit re-verification that it was checked and found
untouched.

Figures were pulled via a purpose-built read-only diagnostic
(`/api/_diag/rebanked-posedge-figures`), not the live `/api/ev-calibration`
endpoint — that endpoint auto-writes `settings.paperTradeOnly`/
`paperKellyFraction` based on whatever it computes, and hitting it purely
to read numbers risked auto-removing League One from `paperTradeOnly`
(going live with real money) as a side effect of a documentation fetch, had
its ROI happened to cross zero. It didn't, but the risk was real enough to
build around rather than accept.

### Part C — Carabao Cup's corrected backtest, banked, and converted to training-eligible

With Part A's fix verified clean, Carabao Cup's corrected reading is now
the final, banked figure:

| Metric | Original (Addendum 24) | Corrected & banked (this addendum) |
|---|---|---|
| n (matched population) | 330 | 330 (unchanged) |
| posEdgeN | 225 | 192 |
| ROI | +10.5% | +8.04% |

Still well below the rule-6 decision-grade floor — no confirmed edge, same
conclusion as every prior Carabao Cup reading. `CALIBRATION_AUDIT[48]`
updated with the full correction history (original → Addendum-24-corrected
→ this addendum's banked figure) in the same transparent style as the
other two leagues.

Per rule 15 (see calibration-rules.md): with a clean, banked backtest now
in hand and no further test in progress, Carabao Cup converts immediately
from rule 10's whole-population exclusion to rule 12's date-split
mechanism, at cutoff **2026-08-24T16:00:00Z** (anchored to this backtest's
own compute date). Converted across all four holdout-check locations
(`server.js`'s `isFixtureTrainingHoldout`/`isWeeklyRetrainExcluded`,
`models/gbdt-train.js`, `models/gbdt-train-proxy.js`) — the same end-state
League One/Two and Championship each reached after their own rule-12/15
conversions. `UNSEEN_POPULATION_DISPLAY_IDS`/`CONFIRMED_IDS`/`LEAGUES` are
untouched, per rule 12's explicit decoupling requirement — this is a
training-pool-only decision.

### Part D — Championship, and the standing policy change

Championship's backtest (`backtested_no_edge`, already banked, no further
test in progress) was converted the same day, for the same reason: a
permanent whole-population holdout was never buying anything further once
its one deliberate look was taken. Calibration-rules.md now carries this as
a standing rule (rule 15): any future rule-10 holdout is understood from
its own creation commit as temporary — held only long enough to produce one
genuine backtest, then released into training the moment that result is
banked. No new holdout should be framed as open-ended or permanent going
forward. Rule 15 explicitly carves out rule 13's own independent
correction-layer discipline (the currently-active League Two multiplier /
League One walk-forward work, and H2H-shrinkage k-fitting) — confirmed
unaffected, since `CORRECTION_LAYER_RULES` in scoring.js has no dependency
on any of the four training-holdout constants touched by this addendum.

**Temp endpoints from this task** (`/api/_diag/domestic-blend-trace`,
`/api/_diag/rebanked-posedge-figures`) and the Settings-tab "⚠ Full
Rescore" button remain in place pending final cleanup, per established
convention, since they were still in active use verifying this addendum's
own figures.

## Addendum 28 — Home/away strength multiplier formalized, fixture congestion deactivated (isolate-tested days earlier, decided and deployed here)

Both modifiers live in `teamProfiles.js`'s `applyTeamProfileModifiers()`,
called only from live scoring (`scoreOneFixture`) — the historical backfill
population every other addendum's calibration/ROI figures come from does
not include this layer at all, and never has. Both had been running
**unconditionally, with no settings gate**, since before either was
isolate-tested — unlike the transfer-quality modifier a few lines below
them in the same function, which has carried an explicit
`transferModifierActive` toggle since 2026-07-31.

**Isolate-test findings** (run days prior to this addendum, held back from
autonomous deployment pending a deliberate decision):

- **Home/away strength multiplier**: calibration error moved from +2.5pp to
  −0.1pp with the multiplier active; ROI's confidence interval moved from
  confidently-negative to inconclusive. A real, substantial improvement —
  not a marginal nudge.
- **Fixture congestion modifier**: fires on 76% of all fixtures (via
  `homeDaysRest`/`awayDaysRest` thresholds), but calibration error moved
  the *wrong* direction with it active (2.6pp → 3.0pp) — read as noise, not
  signal.

**Decision**: keep and formalize the home/away multiplier; deactivate
fixture congestion. Reasoning, since "isolate-tested days ago, held back"
is not itself a reason to act either way:

- **No re-test needed for home/away.** Mechanistically independent of
  everything Addendum 27 touched — the multiplier reads
  `homeProfile.homeRecord`/`awayProfile.awayRecord` (`teamProfiles.js`'s
  own win/loss aggregation from `updateTeamProfiles()`, entirely separate
  data built from raw match results), never `buildDomesticTimeline`/
  `resolveStandingsScore` (what Addendum 27's fix and the League One
  correction actually changed). Confirmed via code inspection: no shared
  computation, no shared data structure. Given that, and that the affected
  Addendum 27 population (44 League One fixtures, a repaired Carabao Cup
  slice) is a couple of percent of a handful of leagues — nowhere near
  enough to explain a 2.6pp swing even under the false assumption of full
  overlap — re-running the isolate-test would be re-peeking without cause,
  not diligence. (The original isolate-test's own write-up wasn't located
  in committed docs to check its literal population directly; the
  mechanism-level check above is a stronger guarantee regardless, since it
  rules out contamination for any fixture, not just the ones that could be
  enumerated.)
- **76% prevalence argues against keeping congestion, not for it.** The
  "might matter in an untested tail" defense is weak precisely because a
  modifier firing on three-quarters of all fixtures has already been
  tested against the general case, not a narrow slice of it. Combined with
  the wrong-direction calibration result, this fails the same standard
  already applied everywhere else in this project (`scoring.js`'s
  `CORRECTION_LAYER_RULES` comment: "no correction without a
  football-justified, measured reason").
- **Sequencing**: congestion off first (lower-risk — pure removal, no new
  logic to trust), home/away's toggle formalized second, as two
  independent, separately-verified changes rather than one bundled deploy.
  Mechanically the two don't interact — the home/away multiplier applies
  multiplicatively before congestion's additive adjustment in the same
  function, so removing congestion doesn't change what home/away already
  contributes.

**Implementation**: two new `settings.json` flags, same pattern as
`transferModifierActive` — `homeAwayMultiplierActive` (default `true`,
formalizing already-proven behavior) and `congestionModifierActive`
(default `false`, formalizing the deactivation). Both wrap their respective
blocks in `applyTeamProfileModifiers()`; `teamIntel.congestionCategory`
(the display-only "3d rest / congested" label) is untouched — only the
probability adjustment itself is gated. Scope confirmed via code search:
`applyTeamProfileModifiers` has exactly one call site (`scoreOneFixture`),
so this only affects going-forward live scoring — no historical population
to retroactively rewrite, no other caller depending on the old
unconditional behavior.

**Live-verified** against a real current WATCHING-stage fixture (Fulham vs
Chelsea, Premier League) via the Scout-tab drawer's Team Intelligence
panel: `Home multiplier ×0.94 (44% vs 46% avg, 345 home matches)` and
`Away multiplier ×1.64 (48% vs 29% avg, 393 away matches)` both fire
exactly as expected — home/away formalization confirmed working. No
congestion line appears anywhere in the notes (only home/away multiplier,
two transfer modifiers, and one H2H anomaly) — consistent with
deactivation. Caveat, for honesty: both teams showed 92 days rest in this
particular fixture — solidly "rested," not the more dramatic
short-rest/"congested" case — so this single fixture isn't the most
demonstrative possible test of the congestion removal specifically. The
code-level guarantee doesn't depend on this fixture either way: the entire
congestion block is now behind one unconditional `if
(opts.congestionModifierActive === true)` gate, defaulted `false`, with no
remaining code path that could fire regardless of rest category — this
check confirmed the deploy took effect cleanly and nothing else broke, not
that the flag mechanically works (that's already guaranteed by the code).

See `docs/model-versioning.md`'s new "Live-scoring modifier toggles"
section for the standing governance table and the process for any future
modifier toggle.

## Addendum 29 — Weather integration completed (venue recovery through walk-forward validation), weather modifier fixed and gated (not activated), H2H pooled-bucket follow-up

### Part 1 — Venue and weather data recovery

`stripFixture()` had always dropped `venue` from the stored historical
population — the 238-venue coordinate table existed but nothing retained
venue to match against it. Patched to retain `{name, city}`; re-ran the
historical backfill (additive, `rescore=false`, ~247 API-Sports calls,
`scoredRecords` untouched — confirmed via `scoredCount` unchanged and
`profilesBuilt` staying small, not a mass rescore).

**Venue-level coverage**: two geocoding rounds against Open-Meteo's free
Geocoding API (top-200, then top-250 of the remainder — a deliberate
two-round stop per diminishing-returns judgment, not chased further for
the last few percent) plus a real bug fix (`venueCoords()` never checked
`CITY_COORDS` via `venue.name` for fixtures storing a "Venue Name (City)"
compound string with `venue.city` literally `null` — silently made
~20 high-fixture-count venues unreachable). Final: **87.5% of the
80,146-fixture FT/AET/PEN population (70,115 fixtures)** resolved to a
physical location.

**Weather-level coverage**: fetching Open-Meteo Archive data for those
resolved locations surfaced three real bugs in turn, each fixed before
re-running — (1) the fetch endpoint was built on the *unresolved*-location
list by construction, an inverted-logic bug that would have produced an
empty target list; (2) no error detail was captured, so an 87% failure
rate was invisible until logging was added; (3) once visible, the errors
were Open-Meteo 429s across three different windows (minutely, hourly, and
transiently daily) that a flat 300ms delay and no retry logic couldn't
survive — fixed with a longer delay, retry-with-backoff on genuine minutely
limits only, and an immediate abort (not a slow grind) on daily limits.
Final: **100% of the resolved population — 67,277/67,277 fixtures** — has
real measured Open-Meteo Archive weather data in `weather-history.json`.

### Part 2 — Weather sensitivity: bug found, fixed, gated — walk-forward did not confirm it

`teamProfiles.js` already had a `weatherSensitivity` field and a live,
**ungated** modifier in `applyTeamProfileModifiers()` using it — unlike
every other modifier in this project, which all carry explicit settings
toggles. Investigating why it had never shown any effect surfaced a
genuine, independent bug: `classifyWeather()`/`classifyArchivedWeather()`
return `'clear'` for the calm baseline, but `addResultToProfile()`'s
bucket-key filter checked incoming conditions against
`['dry','rain','heavy_rain','wind']` — `'dry'`, never `'clear'`. The
baseline `dry` bucket had never once incremented, for any team, since this
code was written, independent of data volume — the modifier had been
complete dead code from day one.

**Single-split diagnostic** (train-only weatherSensitivity rebuilt from the
newly-recovered historical weather data, one 80/20 chronological split,
single test-set look): `meanAbsCalibErrorFlat 0.1912 → meanAbsCalibErrorAdjusted
0.1704` — an ~11% relative reduction, the strongest single-look result of
any modifier tested this project. Caveat noted at the time: only 70
(team, condition) candidates cleared the modifier's own threshold, with
test coverage on 55 across 257 total matches, and the visible sample was
entirely `wind` — no `rain`/`heavy_rain` candidates appeared at all.

**Disposition before validation**: fixed the `dry`/`clear` key bug in
`teamProfiles.js` and added `weatherModifierActive` to `SETTINGS_DEFAULTS`,
**default `false`** — gating the modifier behind the same governed pattern
as `congestionModifierActive`/`homeAwayMultiplierActive`, but starting off
rather than on, since (unlike home/away) this hadn't yet cleared a
walk-forward bar. Scope confirmed: `applyTeamProfileModifiers` has exactly
one call site (`scoreOneFixture`, live scoring only) — historical
`scoredRecords` and any already-locked bet are structurally unreachable by
this flag. Separately confirmed: `weatherSensitivity` accumulation in
`addResultToProfile()` is unconditional, not gated by this flag at all —
data keeps collecting correctly (now that the key bug is fixed) regardless
of whether the modifier is active, so there is no cost to waiting for
validation before any future activation decision.

**Walk-forward validation** (4 sequential expanding-window blocks, same
6-month boundaries as Addendum 26's original-9 away-band validation,
train = everything strictly before the block, test = the block):

| Block | test matches | before (flat) | after (adjusted) |
|---|---|---|---|
| 2024-08 to 2025-02 | 57 | 0.3621 | 0.3534 |
| 2025-02 to 2025-08 | 8 | 0.4378 | 0.4298 |
| 2025-08 to 2026-02 | 29 | 0.4004 | 0.4045 (worse) |
| 2026-02 to 2026-08 | 21 | 0.3860 | 0.3925 (worse) |
| **Pooled** | **115** | **0.3814** | **0.3787 — 0.7% relative improvement** |

**Does not hold up.** The single-split's ~11% relative improvement
collapses to 0.7% pooled and reverses direction in 2 of 4 independent
blocks — the same pattern Addendum 26 used to positively disconfirm the
original-9 away-band correction, not noise around a real effect. Also
newly confirmed: every candidate in every block was `wind` — `rain` and
`heavy_rain` conditions never once cleared the modifier's 8-match/10pp-gap
threshold, so in practice this has only ever been a wind-sensitivity
modifier despite its general name.

**Verdict: closed out, not activated.** The bug fix and governed
`weatherModifierActive` toggle (default `false`) are kept — correct code
and an honest off-by-default state — but there is no plan to flip it
without a materially different future result.

### Part 3 — H2H anomaly: pooled-aggregate-bucket follow-up

Follow-up to the isolate-test/shrinkage-fit work referenced in Addendum 21
and run earlier this session (`fittedK=8.91` vs the flat weight's
implied `k=6`; per-pairing test found `meanAbsCalibErrorFlat 0.2911` vs
`meanAbsCalibErrorFitted 0.2916` — flat, inconclusive). That test's power
was limited by design: `candidatesWithTestCoverage=4170` but only
`totalTestMatchesCovered=8823` recurred — ~2.1 recurrences per candidate,
meaning most individual pairings' "actual" ground truth was itself
estimated from just 1-3 matches.

Redesigned test: same TRAIN split, same `empiricalBayesShrink` fit, same
TEST-period candidates and matches, but every individual recurring TEST
match becomes its own observation, binned by predicted probability into
standard 5pp calibration buckets (same style as this project's tier/EV
calibration checks) instead of averaging each pairing's thin recurrence
into one noisy statistic first.

**Result**: `weightedMeanAbsCalibError` — **flat = 0.0588, fitted =
0.0644** — the fitted weight is slightly *worse* than flat, not better,
directly answering the "does H2H become a genuine, confirmed candidate"
question: no. More notably, **every one of the 16 populated flat-weight
buckets, and 15 of 17 fitted-weight buckets, showed actual win rates
running higher than predicted** — a strikingly consistent bias from 10%
predicted probability through 90%, identical under both weighting schemes.
Since the bias appears regardless of how much weight the anomaly gets, `k`
is not the bottleneck. Most likely explanation, noted but not chased
further this session: the simplified test formula uses each team's
*overall* (home+away blended) win rate as its baseline, while every
evaluated fixture is specifically a home fixture for that team by
construction — home advantage alone would produce exactly this pattern,
independent of H2H anomalies entirely.

**Verdict: closed out.** Not a confirmed candidate under either the
original or the redesigned, better-powered test.

### Compliance and API usage

Rules 1-3, 13, 14 held throughout: fresh chronological splits, train-only
fitting for every fit computed in this task, single test-set look per
diagnostic (weather single-split, weather walk-forward, H2H pooled-bucket
each looked at once, not iterated), no re-peeking at a result once
reported. No base-rate or scoring parameter changed anywhere in this task
except the two explicitly-gated, default-`false`/off-by-design additions
described above. Auto-retrain gate re-verified `false` before and after
(`autoRetrainEnabled: false`, model unchanged — `trainedAt: 2026-08-08`,
`trainN: 40202`). API usage: Part 1's venue/weather recovery used ~247
API-Sports calls (already-budgeted historical backfill) plus Open-Meteo
geocoding/Archive calls (free, no key, no daily budget to track); Parts 2
and 3's diagnostics made zero additional external API calls (read
entirely from already-cached historical/weather data). All twelve temp
diagnostic endpoints from this task (`recover-venue-data`,
`venue-coverage`, `geocode-top-cities`, `geocode-status`,
`fix-geocode-errors`, `fetch-weather-archive`, `weather-archive-status`,
`weather-coverage`, `h2h-shrinkage-fit`, `weather-sensitivity-fit`,
`weather-walkforward-validation`, `h2h-pooled-bucket-fit`) removed, along
with their now-orphaned support code — confirmed via `git diff` and a
full-file syntax check.

## Addendum 30 — CLV methodology clarification, and diagnosing tonight's 8/8 Carabao Cup loss

Overnight, fully autonomous per the brief — diagnosis and strategic
analysis only, per calibration-rules.md rule 4's spirit: nothing here
tunes a parameter because tonight lost. No live scoring/gating/settings
code was touched by this addendum. A separate, forward-looking document,
[`real-money-strategy-proposal.md`](real-money-strategy-proposal.md),
carries Pillar 2 (the strategic proposal) and the Betfair-automation
scoping note.

**A note on data access, stated plainly per the brief's own instruction to
flag uncertainty**: this session has no live server/API credentials and
the user was offline overnight, so nothing below required a fresh live
query was fabricated. Everything here comes from (a) this project's own
already-published documentation (extensive — 29 prior addenda,
calibration-rules.md, model-versioning.md), (b) direct reads of the
current source code (server.js, teamProfiles.js, weightOptimiser.js), and
(c) the specific bet details already visible in tonight's own
conversation (Scout-tab screenshots and Betfair Exchange screenshots the
user pasted earlier tonight). Where a claim rests on (c) at less than full
precision (exact `modelProb` to the decimal, rather than the visible tier
band), that is flagged inline, not presented as more precise than it is.

### Immediate correction, unrelated to the rest of this addendum but too consequential to bury

**The live system is running real-money stakes at Quarter-Kelly (0.25),
not the 1/8 Kelly (0.125) the task brief assumes.** `SETTINGS_DEFAULTS.realKellyFraction`
is `0.25` (`server.js`), and every real-money card on the Scout tab
tonight explicitly labeled its stake box "Quarter-Kelly · real" — this
isn't a fallback guess, it's the confirmed live value. This means
tonight's actual stakes (and every future real-money stake, until changed)
are sized at **double** the risk fraction the brief's own framing assumed.
This is worth fixing or consciously confirming before any further
real-money activity, independent of everything else in this addendum —
see the strategy proposal's Kelly-fraction section for the recommendation.

### Add-on — CLV methodology check

**What the CLV dashboard actually compares** (`fetchClosingOddsForBet()`,
`server.js`): a bet's `actualOdds` (whatever price was taken at lock or at
manual placement/conversion, whenever that happened) against Pinnacle's
price snapshot dated at **kickoff** (`date: kickoffIso` passed to the Odds
API's historical endpoint, validated to be within 15 minutes of kickoff).
The fetch itself only runs in a T-5-to-kickoff cron window, independent of
whenever the bet was actually locked.

**This is unambiguously a market-drift metric, not an execution-quality
metric**, exactly as the brief suspected. A bet's CLV can be negative for
two entirely different reasons that the current dashboard cannot
distinguish: (a) genuinely poor execution — the price taken was worse than
what the market offered at the time, or (b) good execution followed by the
market moving further in the bet's own favor between lock and kickoff
(the price shortening because more money backed the same side) — which is
if anything a *mildly encouraging* signal about the pick's direction, not
a red flag about how it was placed. The brief's own example (Watford
2.32 taken vs. a 2.00 quote at lock — a real, executed improvement) can
still show negative CLV under this metric for reason (b), and there is
currently no way to tell the two apart from the dashboard alone.

**Recommendation: show both figures, not one.** The data for a genuine
execution-quality metric already exists on every bet at zero additional
cost — `pinnacleOddsAtLock` (`server.js:2021`) is captured at the moment
of lock/placement, specifically noted in its own code comment as "the
actual reference price a human compares a soft-book quote against." A
second metric, `(actualOdds - pinnacleOddsAtLock) / pinnacleOddsAtLock`,
requires no new API calls — it's a pure computation over already-stored
fields. Recommend adding this as "Execution CLV" alongside the existing
metric (rename the existing one "Market-Drift CLV" or similar, so neither
reads as the sole verdict on a bet), on the CLV dashboard (`renderClv()`,
`public/index.html`) and the CSV export. Not implemented in this addendum
— flagged as a Pillar 2 near-term item, since it's cheap and directly
prevents the exact misreading the brief describes from recurring.

### Pillar 1 — Diagnosing tonight's result

**Tonight's 8 real-money Carabao Cup bets** (reconstructed from this
session's own conversation — Scout-tab and Betfair Exchange screenshots
pasted earlier tonight; exact `modelProb` decimals for 2 of the 8 are not
directly confirmed and are flagged below):

| Fixture | Pick | Tier band shown | Actual odds/stake (exchange-confirmed) | Historical backtest cited |
|---|---|---|---|---|
| Blackburn vs Sheffield Utd | Home | *not confirmed — see caveat* | £55 @ 2.84 | *not confirmed* |
| Watford vs Peterborough | Home | *not confirmed — see caveat* | £110 @ 2.32 | *not confirmed* |
| Stevenage vs Reading | Home | 40-45% | £62 @ 2.74 | +22.6% (n=45) |
| Southampton vs West Ham | Home | 55-60% | £140 @ 2.10 | +24.2% (n=16, thin) |
| Cardiff vs Norwich | Home | 45-50% | £93 @ 2.92 | +14.5%-band reading |
| Stoke vs Hull | Away (Hull) | 45-50% | £135 @ 3.42 | +11.1% (n=28, thin) |
| Cambridge Utd vs Millwall | Home | 40-45% | £90 @ 3.30 | +16.6%-band reading |
| Blackpool vs Lincoln | Home | 45-50% | £150 @ 3.01 | +11.1% (n=28, thin) |

**Caveat, stated plainly**: Blackburn vs Sheffield Utd and Watford vs
Peterborough's real-mode tier bands were not directly re-confirmed in
tonight's conversation (Watford's earlier *watching-stage* projection was
actually a Draw at <35%, which flipped to a Home Win pick by lock time —
consistent with the pattern below). For the joint-probability calculation,
both are estimated at the same 40-50%-favorite band the other six sit in,
which is the most defensible assumption available without live access —
explicitly an estimate, not a confirmed figure. Re-pulling the exact
`bets.json` records once online would sharpen this but is very unlikely to
change the qualitative conclusion (see below).

#### 6. The joint-probability gut-check

Using tier-band midpoints (0.45, 0.45 estimated; 0.425; 0.575; 0.475;
0.475; 0.425; 0.475), assuming independence:

**P(all 8 lose) ≈ 0.55 × 0.55 × 0.575 × 0.425 × 0.525 × 0.525 × 0.575 × 0.525 ≈ 0.62%** — roughly 1-in-160, if each bet's stated probability were genuinely accurate and the outcomes were independent.

That is a real, low number — not something to wave away as "just
variance," but **the independence assumption is very likely false here,
and that matters more than the raw number.** All 8 fixtures were the same
competition, the same round, the same night. If even one shared factor
pushed multiple favorites' *true* win probability down simultaneously
(squad rotation being the obvious, well-known candidate for early domestic
cup rounds), then these were never 8 independent 0.6%-tail events — they
were a smaller number of correlated bad reads sharing one root cause,
which is a completely different, more actionable diagnosis than "the
model is badly broken." Section 9 below finds direct, structural evidence
for exactly that shared-cause explanation.

#### 4. Live vs. historical scoring: a confirmed, pre-existing, previously-documented divergence

Traced directly in code (`scoreOneFixture` vs. `scoreFixtureFromPool` in
`weightOptimiser.js`) and cross-referenced against this project's own
prior finding on the exact question (this document, ~line 720, from an
earlier unrelated reconciliation task): **`scoreFixtureFromPool` — the
function every single Historical/backtest number in this entire document
is computed from — never calls `applyTeamProfileModifiers` at all.** No
home/away multiplier, no H2H anomaly, no weather, no WOWY, no transfer
modifier, in any backtest figure this project has ever produced. Live
scoring (`scoreOneFixture`) does call it, and since Addendum 28 that
includes an *active, default-on* home/away strength multiplier — a
materially larger live-only adjustment than existed when the earlier note
characterized this gap as "a handful of extra live-only adjustment
factors... not worth re-deriving the whole analysis over."

This is not a new bug — it's a real, structural, already-somewhat-known
divergence that has quietly grown larger since it was last assessed. It
means every tier badge shown on the Scout tab (including tonight's) is
measuring the fixture against a *slightly different model* than the one
that actually produced its live pick — directionally the right ballpark,
never byte-for-byte the same computation. Not, on its own, sufficient to
explain 8/8 losses. Compounds meaningfully with the cup-specific finding
below.

#### 5 & 9. Lineup freshness and the structural cup-competition problem

Two distinct, compounding findings, both traced directly in code:

**Finding A — the core model has no general squad-rotation detector.**
`computeModelProb`'s inputs (form, xG, H2H, defense, momentum, standings)
are all built from *past match results* — not today's team sheet. The
only mechanism that reacts to *today's* lineup at all is WOWY
(`applyTeamProfileModifiers`, gated behind `wowyActive`), and WOWY is
narrowly designed to catch one or two individually-tracked *high-importance
players* being confirmedly absent — it has no way to represent "this club
rested nine first-teamers," which is the actual, well-known pattern in
early domestic cup rounds. A team fielding a youth-and-fringe side still
gets scored almost entirely off their full-strength squad's recent
results, because that's the only signal the model has.

**Finding B — the home/away multiplier is itself blind to competition
context, compounding Finding A specifically for cup ties.**
`buildProfileFromFixtures`'s home/away record (`teamProfiles.js`) pools a
team's home/away fixtures across **all** competitions in its stored
history, with no competition-type filter. A team's home win-rate
multiplier is therefore built substantially from *league* form (since
teams play far more league games than cup games), then applied uniformly
to a cup fixture as if the same home advantage transfers — even on a night
when that "home" fixture is being contested by a reserve side facing a
motivated visitor. This is a genuine, football-literate, first-principles
reason cup competitions specifically should be treated as structurally
less reliable, independent of any statistical evidence — the model's home
advantage signal is measuring the wrong team's history on a rotated night.

**On the specific question of whether tonight's lineups were confirmed or
stale**: `lineups.json` is a periodically-refreshed cache
(`getLineups()`), not a fetch performed live at lock time — confirming its
freshness for tonight's specific 8 fixtures requires a live read this
session cannot perform tonight. Flagged as an open item for morning
verification, not asserted either way.

#### 7 & 8. Carabao Cup's own sample sizes, and the cup-vs-league comparison

Pulled from the exhaustive documentation review (full detail in the
companion strategy proposal's evidence section): **Carabao Cup's own
formally banked reading is posEdgeN=192, ROI +8.04%**, with this
project's own audit explicitly stating it is *"still well below the
rule-6 decision-grade floor... not a confirmed edge"* (`CALIBRATION_AUDIT[48]`,
current as of Addendum 27). Every one of tonight's individual per-fixture
citations — n=45, n=31, n=28 (thin), n=16 (thin) — sits below even that
already-sub-floor pooled figure, several explicitly labeled "thin" by the
UI itself.

Across every cup/tournament competition this project has ever backtested
(Carabao Cup, Champions League, Europa League, Conference League), **none
has ever cleared the rule-6 decision-grade floor** (~300-400 posEdge
bets), versus League One (2,227) and League Two (2,346), which both do.
Cup confidence intervals are also systematically wider — Conference
League's spans 208 percentage points end to end. This project has also
already found two independent, confirmed structural reasons for this, not
just a volume artifact: a standings-fabrication bug specific to
knockout-competition scoring (the historical scorer has no real
standings concept for cup competitions and reconstructs a nonsensical
proxy instead — confirmed on the full 9,551-fixture cup population), and a
genuine, robust two-legged-tie aggregate-state dynamic (teams 2+ down
after leg 1 still win the home leg 33.1% of the time — a real "backs
against the wall" effect no model feature currently accounts for).

#### 10. Recommendation

**Yes — tournament football should be treated as structurally less
reliable for real money than league football**, on the combined weight of:
this project's own repeatedly-confirmed thinner/noisier backtest evidence
across every cup competition tested; two independently-confirmed
structural scoring bugs specific to knockout competitions; and two
additional, newly-identified (tonight) first-principles reasons the
model's core mechanisms — no general rotation detection, and a
competition-blind home/away multiplier — are specifically weaker on cup
nights. This is not a reaction to tonight's outcome; every piece of
supporting evidence above either predates tonight or is a structural code
property independent of any single night's result. Tonight is a
consistent, unsurprising instance of an already-known pattern, not new
evidence on its own.

**The proximate cause of tonight's specific loss, most likely**: real
money was staked against Carabao Cup fixtures via the green-flag
manual-curation feature — which this project's own Addendum 22 explicitly
built as a *human judgment aid*, "purely a display/curation feature, no
gating... no automatic flagging logic of any kind" — using per-fixture
sample sizes (n=45 down to n=16, several self-labeled "thin") thinner than
even the weakest of the six cells that same addendum's own
evidence-reconciliation exercise judged acceptable to flag (the thinnest
of those, League Two 65-70% at n=77, was itself called "weakest-evidenced
of the six" and explicitly caveated as high-risk). Carabao Cup was never
among that original, evidence-reconciled set of six — its cells appear to
have been flagged separately, without that same reconciliation step. This
is a process gap, not a model failure: the tool worked as designed (a
human curation aid), but was applied against evidence thinner than the
standard this project has applied everywhere else.

### Compliance and API usage

No parameter, base rate, weight, or settings default was changed anywhere
in this addendum. No new API-Sports or Odds API calls were made — every
figure above comes from already-published documentation, direct source
reads, and this session's own conversation history. Auto-retrain gate:
last live-confirmed `false` earlier this same session (`/api/server-status`,
~19:06 and ~21:53); nothing in this addendum's diagnosis work touches the
training path, so there is no mechanism by which it could have changed —
a fresh confirmatory check is still recommended once back online, per the
brief's own "before and after" instruction, since "after" cannot be
verified live while offline. No temporary diagnostic endpoints were
created for this addendum — everything was answered from existing docs,
source reads, and conversation history, so there is nothing to clean up.

## Addendum 31 — League One correction-layer deployment check: negative, not just "not yet"

Follow-up to Addendum 30's Pillar 2 proposal, which recommended holding
League One's correction layer (League Two's sibling, `league-one-50plus`
in `scoring.js`, still undeployed) behind Phase 2, gated on League Two's
own live results. The user asked directly what stands between League One
and going green at 50-100%, having just set League Two 50-100% and the
two 45-50% cells live via the manual green-flag UI. This addendum answers
that with a real diagnostic, not a restatement of the existing walk-forward
figures — and the honest answer moved from "promising, one open question"
to "no, on the evidence in hand" over the course of the check.

### What prompted the check

League One's walk-forward validation (Addendum 26) showed a genuine ROI
regression in its 2023-24 block (-10.65% before correction → -15.92%
after), the one block where the correction made things worse. That block's
test population sits right on top of League One's 50-55% tier — the single
cell in the entire tier×league matrix with a confirmed, CI-excluding-zero
negative reading on the whole-history pool (Addendum 22: n=230, ROI -15.5%,
CI [-30.1%, -0.9%]). The question: is the block-2 regression that one known
bad cell dragging down an otherwise-sound band, or something broader?

### Method

Built a temporary diagnostic (`GET /api/admin/diag-l1-block-tiers`, removed
after this addendum) reusing `computeMatchedEdgeFixtures()` — the same
live-scoring-pipeline population `runEvCalibration()` uses — refitting Platt
A/B per expanding-window block (same technique as Addendum 26) since the
original fitting code had already been cleaned up per this project's usual
practice. A refit on all League One 50%+ data before 2025-08-01 produced
A=0.934, B=-0.1812 against the currently-deployed rule's A=0.9567, B=-0.2086
(fit on a very similar but not identical population/date) — close enough in
direction and magnitude to trust the methodology, not exact (expected, given
scoring fixes applied since the original fit and gradient-descent precision).

### Finding 1 — the regression is not isolated to 50-55%

Breaking the 2023-24 block into individual 5pp tiers: 50-55% is bad
(-15.1%→-16.1%), but so is 65-70% (-32.6%→-24.9%, the worst tier in the
block by far), 70-75% (-4.0%→-6.8%), and the thin 75-80%/80-100% tails.
55-60% is the only tier that degrades sharply under correction while
starting positive (+9.8%→+1.5%). This was a broadly bad season for League
One's model across nearly the whole 50%+ range, not a single bad cell
dragging an otherwise-clean band down.

### Finding 2 — 50-55% is nonetheless a real, independent, structural problem

Raw (pre-correction) ROI for League One 50-55% across all 4 independent
walk-forward blocks: -7.7%, -15.1%, -4.3%, -14.4%. **Negative in every
single block**, not just in the pooled whole-history figure Addendum 22
already flagged. This is a materially stronger, block-independent
confirmation of that finding, not a new one — but it settles that it isn't
an artifact of one bad multi-year average. The correction layer does not
fix this cell: it makes it worse in 3 of 4 blocks (-9.0%, -16.1%, -21.8%
after correction) and only turns it positive in the one block (2024-25)
where everything else was also unusually strong.

### Finding 3 — excluding 50-55% does not clear the bar either, once fit cleanly

A first pass, pooling the existing fit's tier-level results with 50-55%
simply excluded from the reported total, looked encouraging: n=301
(posEdge, corrected), ROI +12.35%, 95% CI **[+1.0%, +23.7%]** — excluding
zero. But that fit was still *trained* on data including the bad 50-55%
cell, which could itself be skewing the curve it produces for the tiers
above it. A clean re-run — 50-55% excluded from both the training
population and the test population, i.e. the actual candidate rule
(`bandMin: 0.55`) rather than a derived slice of the 0.50 one — gives a
materially weaker result: pooled n=332 (posEdge, corrected), ROI +9.64%,
95% CI **[-1.1%, +20.4%]**. Spans zero. The clean fit is also considerably
more aggressive (A≈0.50-0.98 per block, vs ≈0.93-1.13 for the contaminated
fit) — a different, more conservative correction shape, and one that no
longer confirms the tier's edge. The 2023-24 block also remains negative
even with 50-55% excluded entirely (-5.6% raw → -8.5% after correction) —
consistent with Finding 1: that season's problem was not localized to the
one bad cell, so removing the cell doesn't remove the problem.

### Verdict

**Do not deploy League One's correction layer at this time — neither the
full 50-100% band nor a narrowed 55-100% band.** Both fail to clear a
CI-excludes-zero bar once checked properly; the promising 55-100% figure
from the first pass was an artifact of fitting on contaminated data, not a
real result. This is a genuine finding from new, disciplined analysis (a
walk-forward-style check on freshly re-sliced data, using the same
methodology this project applies everywhere else), not a re-litigation of
Addendum 26's original look under rule 3 — it answers a question Addendum
26 didn't ask (does narrowing the band rescue the result?), and the answer
is no.

**Separately, and regardless of the correction-layer decision**: League
One's 50-55% tier should be treated as a structural real-money exclusion,
the same way the 40-45% tier is treated across all leagues. It is now
confirmed negative in the pooled whole-history read (Addendum 22) *and*
independently in every one of 4 walk-forward blocks — not currently
green-flagged, and this addendum found no reason to reconsider that. No
code or settings change was needed to act on this finding: League One's
correction rule was already dormant (not in
`settings.deployedCorrectionRuleIds`), and green flags do not gate
bet-locking — nothing was live-exposed to any of the scenarios checked
above at any point during this diagnostic.

**Open question, not investigated here**: why was 2023-24 broadly bad for
League One's model, beyond the model's usual variance? Worth a dedicated
look if League One's correction layer is revisited later, since a
Platt-scaling fix only addresses miscalibrated confidence, not whatever
else may have been wrong that season.

**No change to League Two.** Its own correction layer (Addendum 26,
deployed 2026-08-19) was independently confirmed stable and improving in
every one of its 4 blocks with no equivalent structural weak cell —
nothing in this addendum's finding calls that into question.

### Compliance and API usage

One temporary diagnostic endpoint (`GET /api/admin/diag-l1-block-tiers`)
was built for this check and is removed as part of this addendum's commit.
No settings, weights, base rates, or `CORRECTION_LAYER_RULES` parameters
were changed — League One's rule remains exactly as Addendum 26 left it,
fitted but undeployed. No new API-Sports or Odds API calls were made; all
figures came from `computeMatchedEdgeFixtures()` against already-collected
matched-odds data. Auto-retrain gate untouched by this work.

## Addendum 32 — Does the 40-45% exclusion actually generalize to League One/Two?

The user pushed back on the blanket "40-45% excluded, every league, no exceptions"
policy after noticing League Two's own 40-45% tier showed a decent-looking ROI
on 500+ games (the Scout-tab tier badge: +3.5%, n=514) — a fair challenge,
since the original finding (n=430, ROI -21.5%, CI [-34.4%, -8.6%], original 9
leagues pooled) was never about thin data; it was a decisive, confirmed loss,
generalized to other leagues on the theory that a pattern reproducing
independently across 9 markets is more likely a trait of the model's own
behavior at that confidence range than 9 unrelated coincidences. That's a
reasonable prior, not a proof — and nobody had actually checked whether League
One/Two's own 40-45% cells survive the same scrutiny (calibration error, a
real CI, walk-forward-block stability) applied to every other candidate cell
this session, rather than the pooled point estimate alone.

### Method

Temporary diagnostic (`GET /api/admin/diag-l1l2-4045-screen`, removed after
this addendum) against the already-banked unseen-population matched data
(rule 10) — no new out-of-sample data, no fitted parameters, same
reconciliation precedent as Addendum 22/26.

### Result — the exclusion holds, checked properly

**League Two (42), 40-45%**: n=855, posEdgeN=514, ROI **+3.46%, 95% CI
[-8.2%, +15.1%]** — spans zero. Calibration is excellent (-0.1pp — the
model's 42.4% predicted vs 42.5% actual is about as accurate as this
project's readings get), which makes this a clean null result, not a muddy
one: the model isn't wrong here, it's that being right about a ~42% shot
doesn't create betting value once the market has priced it. Walk-forward by
season: +14.8% / -5.3% / +15.0% / -0.7% — bounces around zero with no
stability, nothing like the "improves in every block" pattern that made
League Two's actual 50%+ correction (Addendum 26) credible.

**League One (41), 40-45%**: n=769, posEdgeN=446, ROI **-4.66%, 95% CI
[-17.0%, +7.7%]** — also spans zero, leaning negative. One block (2022-23:
ROI -27.2%, CI [-55.1%, +0.8%]) comes close to a confirmed loss on its own.

### Verdict

The blanket exclusion is not overturned, but the reasoning updates: League
One/Two's own 40-45% cells are not independently *confirmed negative* the
way the original 9's pooled figure is — they're *not confirmed positive
either*, and genuinely unstable block-to-block, a different and weaker
flavor of the same "no real edge here" conclusion, reached on their own
evidence rather than by association. The challenge that prompted this check
was legitimate and correctly identified that the generalization had never
actually been tested for these two leagues specifically — it just happens
to hold up once tested.

### Compliance

One temporary diagnostic endpoint built and removed as part of this
addendum's commit. No settings, weights, or `CALIBRATION_AUDIT`/green-flag
state changed — nothing here was live-gated in the first place (40-45% is
excluded by policy across every league, not by an individual green flag).
No new API-Sports or Odds API calls; all figures from
`computeMatchedEdgeFixtures()` against already-collected matched-odds data.

## Addendum 33 — Calibration-adjusted tier screen, original 9 leagues: no candidates, two new confirmed losers

Follow-up to the user's original question about whether some original-9
tier×league cells showing positive ROI at sizeable n deserve a second look.
Screened every (league, tier, pick-type) cell among the original 9 (plus
Europa League, which has its own genuine split) with n≥20 posEdge-eligible
fixtures — 93 cells total — for ROI, a real 95% CI (not the point estimate
alone), and calibration error together, the same lens Addendum 22 applied to
League One/Two's green-flagged cells.

### Method

Temporary diagnostic (`GET /api/admin/diag-original9-tier-screen`, removed
after this addendum), reusing `computeMatchedEdgeFixtures()` — the same
live-scoring-pipeline population `runEvCalibration()` uses — restricted to
each league's own `VALIDATED_SPLITS` test-only population (rule 9), so
nothing here is scored against train-contaminated data. No new out-of-sample
data, no fitted parameters — descriptive statistics on already-computed
figures, same reconciliation precedent as Addendum 22/26/32.

### Result — zero candidates clear the bar

Of 93 cells, **none are both well-calibrated (|calibErrPp| < 3pp) and have a
95% CI confirming a positive edge.** This reinforces, with direct evidence
rather than a general assertion, the strategy proposal's original stance
that no original-9 league/tier shows a confirmed edge.

**The eye-catching high-ROI cells are exactly the trap Addendum 22 warned
about** — thin and badly miscalibrated. Primeira Liga 65-70% home: +651.8%
ROI on posEdgeN=5, CI [-133.6%, +1437.2%], calibration off by 15.2pp.
Scottish Premiership 50-55% away: +92.5% on posEdgeN=**2**. Every cell whose
CI nominally "excludes zero" on the positive side (Champions League 45-50%
home, Europa League 55-60% home, Bundesliga 55-60% home) carries a real
calibration gap (4.8-19.8pp) and thin volume (n=23-55) — the same
overconfidence-riding-a-flattering-point-estimate pattern found elsewhere
this session, not genuine edge.

### Two new, genuinely confirmed losers (well-calibrated AND CI fully negative)

- **Premier League, away picks, 50-55%**: n=46, ROI **-80.1%**, 95% CI
  [-119.1%, -41.1%], calibration error 0.2pp — essentially exact. The
  model's probability estimate here is honest; it loses anyway, meaning the
  market already prices this band correctly (or better) and there's no
  value to extract even from an accurate read.
- **La Liga, away picks, 35-40%**: n=35, ROI **-64.1%**, 95% CI [-112.2%,
  -15.9%], calibration error 1.3pp.

Plus **Ligue 1's own 40-45% tier, both pick types, independently confirmed
negative at real volume** — home (n=130, ROI -50.5%, CI [-76.2%, -24.9%],
though itself badly miscalibrated at 14.6pp overconfident) and away (n=72,
ROI -63.9%, CI [-102.6%, -25.3%]). This is a different, stronger evidentiary
status than the blanket 40-45% policy check in Addendum 32 (which found
League One/Two's 40-45% cells merely *unconfirmed*, not independently
*confirmed negative*) — Ligue 1's own data clears the bar for a genuine,
independent confirmation of the existing exclusion.

### One cell worth tracking, not yet acting on

**Ligue 1, home picks, 45-50%**: n=122, ROI **+12.2%**, calibration error
only -1.6pp (clean), 95% CI [-24.1%, +48.5%] — still spans zero, not
confirmed, but the largest, cleanest, most positively-leaning reading found
anywhere in the original 9. Worth revisiting once more data accumulates
(same "wait for genuinely new fixtures, not a re-peek" discipline as
everywhere else in this project) rather than acting on now.

### Verdict

No change to real-money scope: nothing here was eligible for green-flagging
in the first place, and this screen found no new candidate that would be.
Two new cells (Premier League away 50-55%, La Liga away 35-40%) join the
40-45% band and League One 50-55% as specific, independently confirmed
losers worth remembering if this project ever builds a structural
exclusion list beyond the blanket tier rule. Ligue 1 home 45-50% is flagged
for future attention only.

### Compliance

One temporary diagnostic endpoint (`GET /api/admin/diag-original9-tier-screen`)
built and removed as part of this addendum's commit. No settings, weights,
or green-flag state changed. No new API-Sports or Odds API calls; all
figures from `computeMatchedEdgeFixtures()` against already-collected
matched-odds data.

## Addendum 34 — Championship tier screen: one real signal, still sub-floor; no green-flag candidates

Follow-up to the user's question of whether Championship (added 2026-08-19,
the most recent of the four out-of-sample additions) has had the same
rigor applied as League One/Two before any tier could be considered for
green-flagging.

### What already existed

Championship got one disciplined backtest on the full rule-10-protected,
genuinely-unseen population (`CALIBRATION_AUDIT[40]`, computed 2026-08-19):
16 seasons, 8357 fixtures scored, 3460 matched with closing odds. Pooled
ROI on posEdge≥5% bets: n=2321, ROI -0.67%, 95% CI [-5.74%, +4.4%] — no
confirmed edge overall. The note flagged "a couple non-zero-crossing"
individual tiers without full per-cell detail, and per rule 3 that
population can never be re-tested to look for a better story once the
single look is banked.

### Method

Temporary diagnostic (`GET /api/admin/diag-championship-tier-screen`,
removed after this addendum), reading the SAME already-banked population
more completely — ROI + a real 95% CI + calibration error per (tier,
pick-type) cell — restricted strictly to kickoffs before the 2026-08-19
cutoff (`models/gbdt-train.js`'s own `DATE_SPLIT_CUTOFFS`), so nothing that
has since fed the weekly retrain leaks into what should stay a frozen
single look. Overall pooled figure reproduced almost exactly (n=2327,
ROI -0.6%, CI [-5.7%, +4.5%]) — confirms the reconstruction is faithful,
not a new test.

### Result

**One genuinely credible positive signal, not yet enough volume**:
Championship home picks, 65-70% — n=111, posEdgeN=95, ROI **+19.4%**, 95%
CI **[1.1%, 37.8%]** (excludes zero), calibration error -2.2pp (clean).
This is the most credible positive reading across every calibration screen
run this session — real, not thin-and-miscalibrated noise — but posEdgeN=95
sits well under this project's own ~300-400 decision-grade floor. Real
signal, insufficient volume; the only path to more evidence is live
paper-bet accumulation going forward (same discipline as every other
"promising but unconfirmed" cell this session), since rule 3 forecloses
re-testing the frozen backtest population itself.

**Two negative findings worth remembering independent of the general
40-45% policy**:
- **45-50% home**: n=537, posEdgeN=**361** — clears the decision-grade
  floor on its own, the largest credible population in this screen. ROI
  -11.82%, 95% CI [-24.2%, +0.6%] — misses confirming negative by a
  hair, with real overconfidence (5.1pp). Close enough, at enough volume,
  to weigh heavily against ever green-flagging this band.
- **60-65% away**: n=37, ROI -34.1%, CI [-66.7%, -1.5%] — confirmed
  negative, though thin, with severe miscalibration (21.6pp overconfident).

Every other cell (35-40% both pick types, 50-55%/55-60% both pick types,
40-45% away, 60-65% home, 70-80% home) spans zero with no confirmed
direction.

### Separately — a real-money gating gap noted, not acted on

Checking Championship's current mechanics: despite the addition commit's
"paper-only, rule-10 protected from day one" description, the league is
not hard-blocked in code — it sits at the same default `leagueMode:
'paper'` every league starts at, with no `LEAGUE_CONFIG.paperTradeOnly`
lock (unlike what the strategy proposal recommended for cup competitions
generally). Flagged to the user; explicitly declined as unnecessary — sole
user of the model, manual review of every bet before placement, and
green-flag discipline already followed in practice. Left as-is by direct
instruction, not an oversight.

### Verdict

**No Championship tier is ready to green-flag.** The one disciplined
backtest is done properly and confirms no decision-grade positive edge
anywhere. 65-70% home is worth tracking as live evidence accumulates; 45-50%
home and 60-65% away are worth remembering as likely-negative regardless of
what future evidence shows elsewhere.

### Compliance

One temporary diagnostic endpoint built and removed as part of this
addendum's commit. No settings, weights, `CALIBRATION_AUDIT`, or green-flag
state changed. No new API-Sports or Odds API calls; all figures from
`computeMatchedEdgeFixtures()` against already-collected matched-odds data,
strictly pre-cutoff.

## Addendum 35 — Paper bet log validity audit: a real odds-fabrication bug, three matching bugs, and how the historical record was corrected

Triggered by a direct question: would the paper bets in this log have been
placeable at or near their stated odds with a real bookmaker, and why were
most of them logged against an "Unknown" bookmaker? This is not a
calibration or tier-tuning exercise — it's a data-integrity audit of the
bet log and the live odds pipeline that produces it — so `docs/calibration-
rules.md`'s train/test rules don't gate it, but the same "validate before
concluding, don't accept a convenient answer" discipline applied throughout.

### Finding 1 — a genuine odds-fabrication bug in live scoring

`scoreOneFixture`'s candidate-scoring loop had a fallback:
`displayOdds = bookOdds[teamKey] || (1 / c.prob * 1.06)` — when no real
bookmaker price existed for a fixture/outcome, the "market" price was
invented from the model's own probability plus an assumed 6% margin, not
from any real market. Worse: the edge calculation's implied-probability
benchmark then fell back to `1/displayOdds` — i.e. derived from that same
synthetic price — making "edge" a near-deterministic function of
`calFactor` vs the assumed margin, not a real market comparison.

Quantified via a diagnostic that flagged any bet within 1% of the exact
synthetic value: **29 of 165 bets (17.6%)** matched, concentrated almost
entirely in fixtures with genuinely thin or absent market coverage —
Conference League 16/16, Europa League 3/3, Champions League 2/2, FIFA
World Cup 2/10, one or two singles scattered across otherwise well-covered
domestic leagues. For the Conference/Europa/Champions League fixtures the
match wasn't merely close — `relDiff` was **exactly 0** to many decimal
places, i.e. mathematical proof of fabrication, not a statistical
coincidence.

**Fix (deployed 2026-08-29 17:42, commit `684cd73`):** a `hasRealOdds` flag
— Pinnacle's raw per-outcome price preferred, then a real UK book price,
else the candidate's score is forced to 0 and no bet is created at all.
No fabrication, no fallback price, ever, going forward.

### Finding 2 — the bookmaker-routing panel was silently dropping Pinnacle from its own display row

Found from a user screenshot showing a real "Pinnacle: 1.87" reference
elsewhere on a bet card while Pinnacle's own row in the bookmaker table was
blank — an internal inconsistency the same fixture couldn't produce
honestly. Root cause: `_buildBookmakerMarket`'s event lookup was
exact-string-match only (no fuzzy fallback), and a flat `.slice(0,8)` cap
on the bookmaker list had no guarantee Pinnacle survived it. **Fixed**
with a fuzzy `teamsMatch()` fallback for the lookup and by moving Pinnacle
to the front of the list before the cap is applied.

### Finding 3 — two distinct team-name matching bugs, found only because they were checked rather than assumed fine

1. **Shared-token false positives.** `teamsMatch()`'s fallback matched on
   any shared 4+ character token — "Real Sociedad" and "Real Madrid" share
   "real"; "Dundee" and "Dundee United" share "dundee". An independent
   per-team `.find()" lookup returned whichever candidate came first in
   the API's array, regardless of which team was actually being searched
   for — confirmed via a standalone reproduction before and after the fix,
   per explicit instruction not to just work around it. **Fixed** with
   `extractH2hPrices()`: home's price is matched and removed from the
   candidate pool first, then away is matched only among what's left,
   making cross-assignment structurally impossible.
2. **Non-decomposing special characters silently deleted.** `normaliseTeam`
   relied on NFD decomposition to strip accents, but letters with a
   built-in stroke/bar (ø, đ, ł) have no NFD decomposition — they were
   deleted outright rather than transliterated, so `normaliseTeam("Bodø/
   Glimt")` produced `"bodglimt"` instead of `"bodoglimt"`, never matching
   api-football's plain-ASCII spelling. Found while validating the
   qualification-key fix below (a "not found" result that turned out to be
   sitting right there in the raw event list). **Fixed** with an explicit
   transliteration table (ø→o, đ→d, ł→l, æ→ae, œ→oe, ß→ss) ahead of the
   existing diacritic-stripping step.

### Design decision — two-tier odds benchmark, confirmed by the user

Historical bets use Pinnacle **closing** odds (the best available
reconstruction after the fact); bets going forward use Pinnacle odds
**live at the moment of lock** — the point a bet genuinely "places," and
the actual reference the user compares a real bookmaker's quote against
when choosing where to execute on Betfair Exchange. Checked and confirmed:
the existing T-60 pre-match lock cron already re-fetches odds fresh on
every cycle, so this requirement was already satisfied by existing
behaviour — no scoring-path change needed, only the historical
reconstruction below.

### Real bets: explicitly excluded from every correction, by direct instruction

Real bets already carry a genuine, human-confirmed execution record
(stake, odds, and returns as actually placed on Betfair Exchange) that
must never be overwritten with a market-reference price, even when that
reference price is more "accurate" in the abstract. Every correction tool
built for this addendum unconditionally skips `mode === 'real'` bets —
confirmed on every dry run by exact-match `pnlDelta: 0` across all 15 real
bets, including the one (Crawley Town vs Crewe, a cash-out) that had
initially been miscategorised before this rule was made explicit.

### Historical backfill: built, dry-run reviewed twice, applied

`POST/GET /api/admin/backfill-bet-pinnacle-odds` (real, permanent,
`?dryRun=true` supported) — three-tier priority per bet: cached closing
Pinnacle price → fresh historical fetch → `pinnacleOddsAtLock` fallback.
Real bets skipped entirely; resolved bets get `pnl` recomputed via the
same commission formula as live resolution; automatic timestamped backup
before every write. Applied to the full 171-bet log:

- **15 real bets** — confirmed untouched (`pnlDelta: 0` on every one)
- **137 paper bets** — corrected to real historical Pinnacle prices
- **19 bets** — no real price recoverable from any source (see below)
- Net paper P&L: **£3,332.11 → £3,567.43** (+£235.32)

### The European qualifying-round gap: investigated exhaustively, not accepted at face value

The user twice pushed back on "no data exists" for the remaining
unverified bets, correctly — both times a real, fixable issue was
underneath:

1. **Is it "no bookmaker had it" or "our provider never catalogued it"?**
   Raw historical-odds queries for these fixtures returned exactly one
   event, always the *same* wrong, later, unrelated fixture, regardless of
   which exact date was queried — and the same pattern held checking the
   provider's lightweight `/events` schedule (not just the priced-market
   endpoint) at four snapshots per fixture, from a week out to an hour
   before kickoff. `/sports?all=true` showed the three UEFA sport keys
   marked `active:false` for this specific administrative gap (between the
   qualifying/play-off round and the new league-phase kickoff); a control
   query for the same sport keys during last season's genuinely-live
   window returned full, real, correctly-named coverage. Conclusion: a
   genuine provider-side cataloguing gap for this narrow calendar window,
   not a code bug — Odds API's `soccer_uefa_champs_league` /
   `soccer_uefa_europa_league` / `soccer_uefa_europa_conference_league`
   keys appear scoped to the main league phase only.
2. **But real bookmakers plainly do price these fixtures** — the user's
   own real-world Betfair experience was right to be skeptical of "no
   market exists" for something like a UEFA play-off round. The catalogue
   listing turned up a distinct, never-before-queried sport key:
   `soccer_uefa_champs_league_qualification`. Checked directly: Lyon vs
   Fenerbahçe had a full real market there — **22 bookmakers, including
   Pinnacle** (1.90 / 3.68 / 4.12). No equivalent key exists for Europa
   League or Conference League anywhere in the full catalogue — checked
   exhaustively, not assumed absent.

**Fix:** `QUALIFICATION_SPORT_FALLBACK` wired into both `fetchOddsForLeague`
(live scoring/locking — so future Champions League qualifying-round
fixtures get real odds instead of being skipped) and
`fetchClosingOddsForBet` (historical correction, trying each sport key in
turn rather than giving up after the first miss). This closed 2 of the 21
originally-unverified bets (Lyon vs Fenerbahçe, Bodø/Glimt vs NEC
Nijmegen — the latter also needed the `normaliseTeam` fix above to match
at all). Europa League and Conference League remain a genuine, currently
unfixable gap for their qualifying/play-off rounds specifically — 19 bets.

### Prospective fix — no-market-data fixtures now surface as info-only, never lockable

Separately from the historical correction: a fixture with no real market
anywhere already couldn't reach the lock threshold (score forced to 0,
lock requires ≥40 — structurally impossible, not just unlikely) but it
also silently failed the WATCHING threshold (≥20), so it was invisible
rather than informative. Per explicit design instruction: a match with no
odds shouldn't carry any value calculation, but should still show the
model's read on the outcome. `runMorningScan` and `runHourlyRescan` now
surface these with a `noMarketData` flag — odds/edge/EV/Kelly/score
explicitly `null` (rendered "N/A" / a "NO MARKET" badge in the UI, not a
misleading `0`), the displayed pick chosen by raw model probability rather
than the now-meaningless tied-at-zero `successScore`, and "Lock now"
disabled with an explanatory tooltip. The lock gate itself needed no
change — already safe by construction.

### Independent verification: is the corrected data actually trustworthy, not just internally self-consistent?

Two rounds of external verification, prompted by the user surfacing a
ChatGPT conversation raising the same question from a different angle:

1. **Internal cross-check** — for 128 corrected bets, compared the odds
   captured live at lock (`fetchOddsForLeague` → `_buildOddsMap`) against
   the independently re-fetched historical closing price
   (`fetchClosingOddsForBet` → `extractH2hPrices`) — two code paths
   sharing almost no logic. Median divergence 3.9%, mean 6.2%, 83.6%
   within ±10% — consistent with normal pre-match drift, not a hidden
   skew. Of 6 outliers exceeding 20%, 2 turned out to be the already-known
   fabricated FIFA World Cup bets (Argentina vs Cape Verde Islands,
   England vs Congo DR — the synthetic-odds audit had already flagged
   these independently of the CL/EL/Conference set); the other 4 had
   ordinary explanations (thin lower-league markets, one-sided blowout
   mismatches).
2. **External spot-checks** — 5 bets checked against real, named
   bookmaker/odds-comparison sources (not the ChatGPT conversation's own
   claims, which were separately found to be unreliable — a suspicious
   "OddsGPT" citation, an admission its first answer wasn't actually
   Pinnacle/Betfair-sourced despite presenting it that way, and numbers
   for the same fixture that moved between its own messages). 4 of 5
   independently-sourced real prices matched or nearly matched our
   pipeline's numbers, including one exact match (Millwall vs Norwich,
   2.91 both sides) and one confirmation of the live *lock-time* capture
   specifically (Doncaster vs Middlesbrough, 5.25 logged vs ~5.08 real).
   The fifth (Argentina vs Cape Verde) confirmed the already-known
   fabrication and that the backfill had correctly recovered accurate
   real data for it (1.15 corrected vs ~1.13-1.17 real).

**Conclusion:** the two things that were actually broken (fabrication,
name-matching) are now identified, fixed, and excluded from performance
reporting. Everything else checked — both by internal cross-validation and
external, independently-sourced spot-checks — is consistent with a
healthy pipeline, not a systematically skewed one. This is high confidence
from convergent evidence, not a claim of exhaustive, bet-by-bet proof.

### The 9 remaining bets with zero recoverable data: externally researched, not left fabricated

The 9 winning Conference League bets among the 19 still-unverified had
confirmed-fabricated odds contributing **£1,223.18** to the paper log's
recorded P&L with no real number available from Odds API under any key,
at any snapshot. Rather than leave them fabricated or exclude them
silently, real second-leg odds were researched externally (Sportytrader,
Sports Gambler, CBS Sports, FOX Sports, ESPN, Betmines — independently
verified by this project, not taken from the ChatGPT conversation that
prompted the question) and applied via a one-off, now-removed correction:

| Fixture | Old (fabricated) | Corrected | Confidence |
|---|---|---|---|
| FK Partizan vs Getafe | 2.09 | 3.15 | High — direct 2nd-leg quote |
| Borac Banja Luka vs Víkingur Reykjavík | 2.30 | 2.15 | Medium — two 2nd-leg quotes disagreed, midpoint used |
| FC St. Gallen vs FC Nordsjælland | 2.43 | 2.80 | Low — no direct 2nd-leg quote, estimated |
| Brann vs PAOK | 2.33 | 3.00 | High — direct 2nd-leg quote |
| FC Copenhagen vs Inter Turku | 2.34 | 1.30 | Medium-high — inferred from 1st-leg |
| Riga FC vs KÍ Klaksvík | 2.29 | 1.47 | High — direct 2nd-leg quote |
| SC Freiburg vs Motherwell | 2.08 | 1.19 | High — direct decimal conversion |
| FK Jablonec vs Rangers | 2.38 | 3.50 | Low — no direct 2nd-leg quote, wide uncertainty |
| KuPS vs Shamrock Rovers | 2.32 | 1.87 | High — direct 2nd-leg quote |

Each bet's confidence level and source note are preserved on the record
itself (`oddsSource`, `oddsResearchNote`), not just in this write-up.
Net effect on total P&L: **£1,223.18 → £1,222.80** — a near-total wash in
aggregate despite every individual bet moving substantially, in both
directions. Worth remembering: this coincidence says nothing about
accuracy at the individual-bet level, which is what actually matters for
any future calibration work drawing on this population.

### Final state of the 171-bet log

- **15 real bets** — untouched throughout, exactly as executed on Betfair
  Exchange
- **146 paper bets** — grounded in real market data (137 via Odds API
  Pinnacle history, 9 via externally-researched real odds, confidence
  levels preserved)
- **10 paper bets** — still genuinely unrecoverable (Europa League/
  Conference League losses and zero-stake wins among the 19; the 9 with
  material P&L are now fixed above), left flagged `oddsUnverified` rather
  than guessed at
- Net paper P&L, final: **£3,567.43** — the manual research pass ran
  first (£1,223.18 → £1,222.80 on those 9 bets specifically, a near-wash
  in aggregate) and the Odds-API backfill ran second across the whole log
  including those already-corrected 9 (£3,332.11 → £3,567.43, +£235.32,
  entirely from the other 137 bets since the 9 were already fixed and the
  backfill correctly left them untouched, returning `none_found` for each)

### Verdict

The paper log's validity concern that opened this investigation was
justified — there was a real fabrication bug, not a false alarm — but it
was narrower in scope than "the model's Pinnacle odds might all be
nonsense": isolated to fixtures with zero real market coverage, now
excluded from performance reporting for the unfixable remainder, corrected
with real data everywhere it was recoverable, and structurally prevented
from recurring going forward (no fabrication path exists anymore; a
no-market fixture now either finds a real price via the qualification-key
fallback or is skipped/shown info-only, never bet on).

### Compliance

Two temporary/one-off diagnostic endpoints and one one-off correction
endpoint built and removed as part of this addendum's work
(`diag-synthetic-odds-audit`, `diag-unverified-bets-raw-check`,
`diag-historical-endpoint-behavior`, `diag-uefa-events-catalog-check`,
`apply-manual-odds-research`). One real, permanent endpoint added and kept
(`backfill-bet-pinnacle-odds`) for any future re-run should new historical
data become available. No settings, weights, `CALIBRATION_AUDIT`, or
green-flag state changed — this is a data-integrity correction to the bet
log and its supporting pipeline, not a calibration or tuning exercise.

## Addendum 36 — League One/Two full tier × pick-type screen: coverage now matches every other league, one confirmed negative corroborated, no new candidates

Follow-up to a direct coverage audit: every league had been checked to a
different depth. The original 9 + Europa League (Addendum 33) and
Championship (Addendum 34) all had a full (tier × pick-type) grid with
ROI, a real 95% CI, and calibration error per cell. League One (41) and
League Two (42) — despite being the two largest matched-odds populations
in the whole project — only had a single pooled overall figure in
`CALIBRATION_AUDIT`, plus a couple of individually spot-checked tiers
(40-45% in Addendum 32, 50-55% in Addendum 22/31). This closes that gap.

### Method

Temporary diagnostic (`GET /api/admin/diag-l1l2-full-tier-screen`, removed
after this addendum), reading the SAME already-banked population every
prior League One/Two figure comes from — restricted strictly to kickoffs
before the 2026-08-11T09:00:00Z rule-12 date-split cutoff, so nothing that
has since fed the weekly retrain leaks in. `overallPooled` reproduced
`CALIBRATION_AUDIT`'s stored figures almost exactly (League One: -2.36%
both; League Two: 3.07% vs the stored 3.1%, rounding only) — confirms the
reconstruction is faithful, not a new test.

### Result — League One (41), 15 cells at n≥20

**One confirmed negative, corroborating the existing finding at full-grid
resolution**: 50-55% home — n=367, posEdgeN=255 (clears the decision-grade
floor), ROI **-16.3%**, 95% CI **[-29.4%, -3.2%]** (excludes zero), real
overconfidence (5.2pp). This is the same cell Addendum 31 already confirmed
negative across 4 walk-forward blocks; seeing it reconfirmed here, at this
resolution, on the same frozen population, is a consistency check passing,
not a new finding.

**One promising-but-thin positive**: 75-80% home — n=31, posEdgeN=31, ROI
+21.6%, CI [1.6%, 41.7%] nominally excludes zero, but n=31 is far below
the decision-grade floor and it's real-overconfident underneath (-6.4pp) —
a thin-cell trap in the same shape as several original-9 cells Addendum 33
flagged, not a candidate.

**Two large, clean, decision-grade-volume cells with no confirmed
edge**: 45-50% home (n=451, posEdgeN=290, ROI +6.2%, CI spans zero,
well-calibrated) and 40-45% home (n=505, posEdgeN=294, ROI -6.5%, CI spans
zero, well-calibrated). Both genuinely clean reads — real volume, good
calibration, simply no edge either direction.

**Two large-effect negatives just short of confirming**: 50-55% away
(n=114, ROI -22.7%, CI [-45.9%, +0.4%] — upper bound a hair's breadth from
excluding zero) and 35-40% away (n=273, ROI -23.1%, CI [-47.3%, +1.1%]).
Neither clears the 95% bar, but both are large-effect, decent-volume, and
worth remembering alongside the confirmed 50-55% home negative — three of
four home/away pairs in the 35-55% probability range now lean negative for
this league.

Everything else (60-65% both pick types, 55-60% both, 70-75% home, 45-50%
away, 40-45% away) spans zero at moderate-to-thin volume, no confirmed
direction.

### Result — League Two (42), 13 cells at n≥20

**No confirmed edge in either direction anywhere** — the closest calls:

- **40-45% home** (n=577, posEdgeN=337 — the largest cell in either
  league): ROI +10.8%, 95% CI **[-3.7%, +25.3%]** — nearly excludes zero
  on the downside, well-calibrated (-1.9pp). The single most credible
  positive read in this screen — real volume, clean calibration, CI close
  to confirming — but doesn't clear the bar. Worth tracking as live
  evidence accumulates, same treatment as Championship's 65-70% home in
  Addendum 34.
- **50-55% home** and **55-60% home** (n=397/260, ROI +8.0%/+10.2%): both
  look positive on ROI alone, but both carry real overconfidence
  (5.1-5.2pp) — exactly the "riding on overconfidence, not a real
  candidate" pattern Addendum 22 established for this league's own
  green-flagged cells. Flagged, not counted as promising.
- **60-65% home** (n=183, ROI -4.5%, badly overconfident at 13.2pp) and
  **70-75% home** (n=45, ROI -12.3%, severely overconfident at 27.6pp):
  negative-leaning with real, substantial miscalibration underneath, but
  neither clears decision-grade volume or a confirming CI yet.

**45-50% home** (n=529, the largest well-calibrated cell, ROI +6.6%, CI
spans zero) is another clean, high-volume, no-edge read alongside League
One's equivalent tier.

### Verdict

**No new green-flag candidates for either league.** The one confirmed
finding (League One 50-55% home, negative) was already known — this
exercise corroborates it at full resolution rather than discovering it.
The most interesting unconfirmed reads worth tracking going forward:
League One's two large-effect away-side negatives (50-55%, 35-40%) sitting
just short of confirming, and League Two's 40-45% home sitting just short
of confirming positive. All three should be watched as live evidence
accumulates rather than re-tested against this frozen population, per
rule 3.

**Coverage-wise, this closes the gap identified in the prior audit.**
League One and League Two now have the same (tier × pick-type) screening
depth as every other league with a genuine banked population. Conference
League and Carabao Cup remain deliberately shallower (population too thin
for a meaningful further cut — Addendum 20's judgment call, not an
oversight), and FIFA World Cup remains permanently unauditable (no
calibration population exists and the tournament has concluded) — both
documented, neither an inconsistency.

### Compliance

One temporary diagnostic endpoint built and removed as part of this
addendum's commit. No settings, weights, `CALIBRATION_AUDIT`, or
green-flag state changed. No new API-Sports or Odds API calls; all figures
from `computeMatchedEdgeFixtures()` against the same already-collected,
already-frozen matched-odds population every prior League One/Two figure
comes from, strictly pre-cutoff.

## Addendum 37 — Tree-boundary leakage audit: which "held-out" figures were actually held out, and the 18%/45% rule re-validated on its real population

Triggered 2026-09-04 by the question "does the weekly retrain contaminate the
rule-9 `VALIDATED_SPLITS` test windows?" The honest answer turned out to be
"not yet, but something earlier did, and one re-validation was run on the
wrong population." Investigation first, fixes second, everything scoped to
the 11 domestic real-money-focus leagues; tournament competitions are noted
in Part F and deliberately not actioned.

### Part A — Mechanism (code-level)

1. `models/gbdt.js` `predict()` names its weights argument `_weights` and
   never reads it. It calls `loadModel()`, which reads the single file
   `DATA_DIR/gbdt-weights.json` and reloads on mtime change. So
   `computeMatchedEdgeFixtures()` — and every diagnostic built on it — scores
   every historical fixture with **whatever weights are live at that moment**.
   The `historical.optimisedWeights` it passes survive only as a
   skip-if-missing guard and for the linear fallback.
2. `models/gbdt-train.js` writes to that same path, overwriting. No version
   archive exists anywhere. Nothing pins a historical fixture to the model
   version that existed when it was played.
3. The trainer's `splitData()` sorts by date and builds trees on the earliest
   80%. The latest 20% fits Platt scaling (six parameters) and the quality
   gates. The trainer has no notion of `VALIDATED_SPLITS`; its only
   league-level exclusions are the four rule-12 date cutoffs (Championship,
   League One, League Two, Carabao Cup).

Consequence: a league's `testFrom` says nothing about whether the model
*scoring* that window was trained on it. That depends entirely on where the
scoring model's own tree boundary sits.

### Part B — What actually leaked, by model version

**2026-07-25 model** (live 2026-07-25 → 2026-08-08, i.e. while Addenda 5, 6,
12 and 13 were computed). Trained on the checked-in 8,316-record snapshot
(Addendum 9 Part B's arithmetic); its chronological 80% boundary is
**2024-11-19** — inside every `testFrom` window. Overlap measured directly
on that file:

| League | Test-window fixtures in snapshot | In that model's tree-training slice |
|---|---|---|
| Ligue 1 | 526 | 318 (60%) |
| La Liga | 570 | 317 (56%) |
| Premier League | 571 | 301 (53%) |
| Bundesliga | 463 | 245 (53%) |
| Serie A | 342 | 81 (24%) |
| Scottish Premiership, Eredivisie, Primeira Liga | 0 | 0 — leagues absent from the snapshot |

So those addenda's figures for the five affected leagues were partly
in-sample. Addendum 9 Part B's closing claim to the contrary was wrong for
them and now carries a correction. Base-rate tuning discipline (train-only
observed rates) was real throughout; the *scoring model* was not clean.

**2026-08-08 model** (live now). Trained on the production pool (50,253
records); tree boundary **2022-11-13** (Addendum 14 reproduced the trainer's
split). Every `testFrom` is after 2023-11-03, so every test window sits in
this model's reserved 20%: never used to build trees, used for the Platt fit
and gates. Under today's weights the only contamination of any rule-9
held-out figure is that Platt-level exposure.

**Weekly retrains: zero deployed.** All four cycles since (2026-08-11, -17,
-24, -31) trained a candidate on the growing pool and were rejected by the
improvement gate (`versionChanged: false` each time). The gate compares the
candidate's log-loss on its own newer test slice with the deployed model's
figure on its old slice — not like-for-like, and the reason nothing has
passed. The first candidate that does pass will have a boundary roughly one
season later (train slice 40,202 → 43,418 records), i.e. into late 2023 —
at or past Ligue 1's `testFrom`, approaching the Premier League's — and the
boundary then moves later every week. Rule 16 (Part E) is what stops that
silently re-contaminating the held-out figures.

### Part C — Which reported figures are affected

| Reading | Scored by | Status |
|---|---|---|
| Addenda 5, 6, 12, 13 per-league/tier figures | 2026-07-25 model | Partly in-sample for PL/La Liga/Bundesliga/Ligue 1/Serie A — caveated in place, figures unchanged |
| `HISTORICAL_TIER_BASELINE` (Performance tab pooled Historical row; the "decision-grade 40-45% confirmed negative" cited by `real-money-strategy-proposal.md`) | 2026-07-25 model | Same caveat, in code and in the tab's scope note and in the proposal |
| `CALIBRATION_AUDIT` "validated" notes for the 9 leagues | 2026-07-25 model | Split discipline described is real; the scoring caveat above applies |
| Walk-forward proxy grid (Addendum 21) — the Performance tab's per-league Historical for the 10 in-sample leagues | per-block models trained strictly before each block | Free of tree leakage by construction — but its current stored run has a separate defect (no 5% edge threshold applied, see Part D / Part G item 7) |
| `ev-calibration.json` per-league test-only figures | current live weights | Now rule-16 restricted (Part E); 0 fixtures dropped under the 2026-08-08 model |
| 2026-09-01 audit diagnostics (lowConfidence A/B → `cd09bd2`; calibrationFactor Brier sweep → `3be309c`; PL edge-cap check; dataConfMin check) | 2026-08-08 model over the full matched population from 2020-06 | Populations straddle the 2022-11-13 boundary, so partly in-sample. **Not re-run here** — listed as an open item in Part G |

### Part D — The 18%/45% rule: which population validated it, and re-validation

**Trace (from git, not memory).** Two different runs exist:

- **2026-08-31, commit `a3795b9`** (`diag-walkforward-robustness-scan`), the
  run the rule was chosen on: 11 domestic leagues, test-only per league
  (rule-9 leagues from their own `testFrom`, rule-12 leagues pre-cutoff),
  cut to the concurrent-coverage window from the latest domestic `testFrom`
  (Serie A, 2024-09-16), 4 equal-count chronological blocks. **Entirely
  after the 2022-11-13 boundary — clean of tree contamination.**
- **2026-09-01, commit `37a967f`** (`edge-floor-resweep`), the run that
  reported n=986 / +33.1% / CI [18.1, 48.0] as "18/45 confirmed under the
  corrected calibration": every matched domestic fixture from the 2020-06
  closing-odds floor onward, **no** test-only, rule-12 or boundary
  restriction, equal-time blocks. That mixed in fixtures the scoring model
  had trained on and the base-rate tuning train portions. Its figure should
  not be relied on; it is decomposed below to show what it pooled.

**Re-validation, 2026-09-04** (temp `GET /api/admin/diag-paper-rule-revalidation`,
removed after this addendum in commit `3763718`; confirmed live via a
logged-in 404 check at 2026-09-04 12:20 UTC). Scoring model 2026-08-08 (boundary pinned
2022-11-14T00:00Z), domestic calibrationFactor 1.02 (the corrected value),
edge = calProb − margin-stripped Pinnacle, ROI on Pinnacle closing odds,
95% CI by normal approximation on per-bet returns.

*Population exactly as 2026-08-31.* Concurrent window from 2024-09-16, pool
n=7,214, **0 fixtures before the tree boundary, 0 with unknown boundary.**

| Read | n | wins | ROI | 95% CI |
|---|---|---|---|---|
| Pooled, edge ≥18% and modelProb ≥45% | 273 | 124 | **+45.7%** | [+15.4, +75.9] |
| Block 1 (2024-09-16 → 2025-01-18) | 54 | 25 | +49.1% | [−21.2, +119.4] |
| Block 2 (2025-01-18 → 2025-05-11) | 49 | 22 | +75.2% | [−28.9, +179.3] |
| Block 3 (2025-05-11 → 2026-01-01) | 95 | 46 | +37.3% | [+4.9, +69.7] |
| Block 4 (2026-01-01 → 2026-08-17) | 75 | 31 | +34.5% | [−23.4, +92.3] |
| Season 2024-25 | 112 | 51 | +60.7% | [+2.8, +118.6] |
| Season 2025-26 | 160 | 73 | +36.0% | [+4.1, +67.9] |
| Rule-12 leagues only (Championship, League One, League Two) | 213 | 99 | +31.5% | [+3.7, +59.3] |
| Rule-9 leagues only (the 8 top divisions) | 60 | 25 | +95.9% | [+0.4, +191.3] |

All four blocks positive; pooled CI excludes zero. **The rule survives on its
real, clean population under the corrected calibration.** Two things the
pooled figure hides, both relevant to real money:

- **Support is three-quarters lower-league.** 213 of 273 bets are
  Championship (77, +20.8%), League Two (75, +57.4%) and League One
  (61, +13.2%). The eight top divisions contribute 60 bets between them —
  Premier League 15, La Liga 13, Ligue 1 8, Scottish Premiership 8,
  Bundesliga 5, Serie A 5, Eredivisie 3, Primeira Liga 3 — with per-league
  CIs that are all uninformative and a pooled CI whose lower bound is
  +0.4%. The rule is well evidenced for the three rule-12 leagues and thinly
  evidenced for every top division individually.
- **Average odds are long** (3.13 pooled; 4.04 in the top divisions), so the
  wide CIs are structural, not a data problem.

*What the 2026-09-01 re-sweep pooled* (reproduced exactly: n=986, +33.08%,
CI [18.13, 48.02] — confirming the reconstruction is faithful):

| Slice | n | ROI | 95% CI |
|---|---|---|---|
| Before the tree boundary (in-sample for the scoring model), 2020-06 → 2022-11-12 | 479 | +19.7% | [+0.7, +38.7] |
| After the boundary, all | 507 | +45.7% | [+22.9, +68.5] |
| — of which after boundary but before the league's `testFrom` (tuning train) | 44 | +90.2% | [−35.6, +216.0] |
| — of which test-only but before the concurrent window | 190 | +35.5% | [+4.2, +66.9] |
| — of which the concurrent window (= the clean read above) | 273 | +45.7% | [+15.4, +75.9] |

The in-sample half was *weaker*, not stronger — the contamination did not
flatter the rule — but it was contamination all the same, and the +33.1%
figure is retired in favour of the +45.7% / n=273 read above.

*Walk-forward block read (genuinely out-of-sample, different calibration).*
Bets from `walk-forward-raw-bets.json` (Addendum 21's four per-block proxy
models, 2023-06 → 2025-06, 8 rule-9 domestic leagues; rule-12 leagues were
never in the blocks), tier ≥45%, no calFactor, per-block Platt. **Zero of
the 2,527 qualifying bets reach a 17% edge, let alone 18%.**

**Why: the stored walk-forward bets have no usable edge at all.** Every one
of the 6,108 records in `walk-forward-raw-bets.json` carries `edge: null`
(the distribution check reported max/median/p99 all zero after numeric
coercion, 0 non-numeric — i.e. every value is `null`, which `Number()` maps
to 0). `walk-forward-log.json` shows why: all four blocks were re-run on
2026-08-14 between 21:04 and 22:10 UTC — deliberately, as a "fresh 4-block
run" for Track A (`7ce092e` added the reset endpoint at 20:20 UTC) — after
Track A (`a18886f`, 16:17 UTC that day) routed the block scorer through
`computeUnifiedEdge`,
and four days before the field-name bug in it was fixed (`a8a0cde`,
2026-08-18, Addendum 24). With `edge` NaN, the scorer's `edge < 0.05`
gate never fired, so every matched fixture was stored as a "posEdge" bet:
the log's `posEdgeN` equals `matchedN` for every block (1,476 / 1,521 /
1,564 / 1,547) instead of the 509 / 450 / 519 / 480 Addendum 21's table
reports from the original 2026-08-11/12 run. `walk-forward-pooled.json`
(built from this file by `POST /api/admin/walkforward-pool`, which applies
no edge filter of its own) therefore pools **all** matched bets, and the
per-league Historical cells it feeds sum to n=5,831 across the 10 reported
leagues, not Addendum 21's 1,842. **The live "Historical (walk-forward
proxy)" grid and Scout-card readings are currently a no-threshold reading
mislabelled as a posEdge≥5% one.** Addendum 24 fixed the live scorer but
did not re-run the blocks. Untouched here — it needs a full 4-block re-run
(~20 minutes of training each, sequential) and is logged as Part G item 7.
The walk-forward corroboration of 18%/45% is therefore **not available**
from stored data; the clean live-model read above stands on its own.

For scale, the live model's own edge distribution on the like-for-like
population (8 rule-9 leagues, tier ≥45%, test-only, concurrent window):
n=2,299, median −3.4%, p90 +10.9%, p95 +15.0%, p99 +21.5%, max +45.4%;
60 fixtures at ≥18%. Characterisation only — not a validation of any other
threshold.

### Part D2 — Reconciliation: why the 2026-08-31 scan showed n=601 and this addendum shows n=273

Raised 2026-09-04 as a discrepancy ("the original had n in the thousands").
Traced from primary sources, not memory: the committed code of every
temporary diagnostic from 2026-08-30/31 and the original session's own
transcript output, then reproduced by a temp endpoint
(`GET /api/admin/diag-population-trace`, removed after this note).

**What the 2026-08-31 scan (commit `a3795b9`) actually measured.** Its
population is exactly this addendum's: 11 domestic leagues, test-only per
league, concurrent window from 2024-09-16, four equal-count blocks. That
window holds **7,214** matched fixtures (unchanged since: 0 added after
2026-08-31). The transcript shows the figures reported that night —
edge-only ≥8% n=3,025 (the "thousands"), edge-only ≥18% n=873, 15%/45%
n=880, 18%/40% n=767, **18%/45% n=601, ROI +24.79%, CI [+9.1, +40.5]**,
18%/50% n=461, 20%/45% n=451 (the grid's top cell by ROI), 20%/50% n=360.

**What changed.** One thing: the domestic calibration factor was 1.11 that
night (commit `37a967f`'s own comment: "now that calibrationFactor is fixed
(1.11→1.02)") and is 1.02 now (`3be309c`, 2026-09-01, Brier-score sweep).
Because edge = min(0.97, modelProb × calFactor) − margin-stripped Pinnacle,
the change lowers every fixture's edge by 0.09 × modelProb, roughly 4-6
points in the 45-65% band. The mean edge across the window fell from +5.6%
to +1.2%.

**Measured reproduction on the identical 7,214-fixture window**, edge
reconstructed under 1.11 from each record's stored figures:

| Cell | Under 1.11 (as on 2026-08-31) | Under 1.02 (now) |
|---|---|---|
| edge ≥8%, any prob | 3,025 | 1,914 |
| edge ≥18%, any prob | 873 | 381 |
| 15% / 45% | 880 | 457 |
| 18% / 40% | 767 | 332 |
| **18% / 45%** | **601 — +24.79%, CI [+9.1, +40.5], blocks +22.1 / +40.6 / +22.7 / +19.0** | **273 — +45.65%, CI [+15.4, +75.9], blocks +49.1 / +75.2 / +37.3 / +34.5** |
| 18% / 50% | 461 | 220 |
| 20% / 45% | 451 | 187 |

The 1.11 column reproduces the 2026-08-31 transcript to the fixture
(601 / 24.79 / [9.11, 40.46] / block-1 n=132 at +22.13%). So the answer to
"why 273" is **(d)**: not a scoping error, not the tree-boundary
restriction (0 fixtures in this window predate it), not contamination
removal — the deployed rule's *effective* strictness moved on 2026-09-01
when the calibration factor was corrected, and nobody re-counted. 18%
under 1.02 corresponds to roughly 22-24% under 1.11. The 273 bets are a
strict subset of the 601.

**Consequence.** Two figures are both "true" and must be labelled by
calibration factor from now on. The rule as *selected* (1.11) produced 601
bets over 23 months at +24.8%; the rule as *deployed* (1.02) produces 273
at +45.7% — higher ROI, half the volume, all four blocks positive in both
cases. The 2026-09-01 re-sweep that was supposed to re-select under 1.02
ran on the wrong population (Part D), so the deployed rule's threshold was
never re-chosen under the corrected calibration on the intended window.
Addendum 38 and 39 do that for the rule-12 leagues on a train/test basis.
Whether 18% under 1.02 or a lower floor that restores the original volume is
the better deployed rule is a decision, not a correction — see Part G.

### Part E — Fix applied: rule 16 and tree-boundary persistence

- `gbdt-train.js` now persists `treeBoundary.{firstTestFixtureDate,
  lastTrainFixtureDate, trainPoolN}` in every weights file it writes.
- `server.js` `getModelTreeBoundary()` reads it; the 2026-08-08 version,
  which predates the field, is pinned in `KNOWN_TREE_BOUNDARIES` from
  Addendum 14's reproduction (2022-11-14T00:00Z so "strictly after" holds).
  Unknown version → `boundary: null`, which readers must surface.
- `computeMatchedEdgeFixtures()` tags each record `preTreeBoundary`.
- `runEvCalibration()` drops pre-boundary (or unknown-boundary) fixtures from
  every `VALIDATED_SPLITS` held-out figure, reports `heldOutFrom` per league
  and a `treeBoundary` block in `ev-calibration.json`.
- `calibration-rules.md` rule 16; `model-versioning.md` "Tree boundary".

Verified live 2026-09-04 11:57 UTC: `treeBoundary: { boundary:
2022-11-14T00:00Z, source: pinned-addendum-14, droppedFromValidatedLeagues:
0 }`; each rule-9 league's `heldOutFrom` equals its own `testFrom` (all
later than the boundary); rule-12 leagues report `null` (their protection is
the training cutoff, not this rule).

### Part F — Tournament competitions (noted, not actioned)

Champions League shows the same 2026-07-25-model overlap (170 of 283
test-window fixtures, 60%); Europa League and Conference League were absent
from that snapshot and are clean there. They share every code path in Part A
and are covered by rule 16 mechanically, but no tournament-specific
re-validation or fix was done or bundled here, per the standing
domestic/tournament separation rule.

### Part G — Open decisions (for a separate conversation)

1. **Version archiving** (score historical fixtures with the version that
   predates them): the 2026-07-25 weights survive in the repo's
   `models/gbdt-weights.json`; the 2026-08-08 version exists only on the
   Render disk. Nothing archives future versions yet.
2. **Reversing the merge decision** (adding the ten `testFrom` dates to the
   trainer's cutoff map): would permanently protect the windows at the cost
   of several thousand recent training fixtures, and contradicts
   `model-versioning.md`'s documented choice. Rule 16 makes this less urgent
   than it looked — the windows are honestly labelled even as the boundary
   moves.
3. **The 2026-09-01 audit diagnostics** (Part C, last row) fed live changes
   and were scored partly in-sample. Re-run each on the post-boundary
   population before treating them as settled.
4. **The improvement gate** rejects every candidate on a not-like-for-like
   comparison; if that is unintended, the live model is frozen at
   2026-08-08 indefinitely.
5. **Thin top-division support for 18%/45%** — the rule is carried by the
   three rule-12 leagues; the Live tier should be watched per league, not
   pooled, before any top-division real-money promotion.
6. **Walk-forward vs live edge scale** — cannot be compared until item 7 is
   done, since the stored walk-forward edges are all null.
7. **Re-run the four walk-forward blocks** (post-`a8a0cde`) and re-pool. The
   current `walk-forward-raw-bets.json` / `walk-forward-pooled.json` were
   produced inside the Addendum 24 NaN window: every stored edge is null,
   no posEdge≥5% threshold was applied, and the live "Historical
   (walk-forward proxy)" grid pools n=5,831 bets where Addendum 21 reported
   1,842. Until then that grid is a no-threshold reading wearing a
   posEdge≥5% label — rule 14 territory — and Addendum 21's published
   figures are the last valid walk-forward read. Domestic and tournament
   blocks share one pooled model per block, so a re-run is inherently
   shared-path; the domestic/tournament reporting split happens at pooling.

## Addendum 38 — Should paper-with-stake narrow to Championship/League One/League Two, and is 18%/45% the right threshold for that population?

Analysis and recommendation only (2026-09-04). No change to live scoring,
gating or the three-tier pipeline was made. Follows directly from Addendum
37 Part D: the re-validated 18%/45% read (n=273, +45.7%, CI [+15.4, +75.9])
draws 213 of its 273 bets from the three rule-12 leagues; the eight top
divisions contribute 60 between them.

### Part A — Recommendation on the eight top divisions

**Recommend narrowing paper-with-stake to Championship, League One and
League Two, and moving the eight top divisions to the no-stake observation
tier for now.** The reasoning is evidential, not a finding that the top
divisions are bad:

- The paper track record is the instrument the real-money promotion
  decision rests on. It should contain only the population whose backtest
  support exists. Sixty bets across eight leagues, at average odds of 4.04,
  is a sample whose variance would dominate the paper P&L without being
  able to settle anything.
- Nothing is lost. Observation-tier records carry the same fields
  (modelProb, edge, odds, result) and are excluded only from stake and
  P&L. The per-league evidence accumulates identically either way.
- The one real cost: observation-tier bets cannot be converted to real
  money in the UI (`server.js` refuses it), so a top-division pick the
  operator would have wanted to back for real would need the rule lifted
  first. Given every bet is manually reviewed, that is a friction, not a
  loss of information.

**Mechanics, confirmed from the code, not implemented.** Stake eligibility
is decided in `scoreOneFixture()` by `meetsPaperMoneyRule`, which requires
`isDomesticTierLeague` (membership of `DOMESTIC_LEAGUE_IDS_FOR_BLEND`)
plus the 18/45 test; `isFakeMoney` derives from it. The targeted change is
a new `PAPER_STAKE_ELIGIBLE_LEAGUE_IDS = {40, 41, 42}` added as a third
condition on `meetsPaperMoneyRule`. `DOMESTIC_LEAGUE_IDS_FOR_BLEND` itself
must not change: it drives the domestic blend, the xG-proxy coefficients,
the domestic calibration factor and the lowConfidence bypass
(`server.js` ~2193), none of which should move. The Scout tab's
"PAPER-MONEY WATCHING/LOCKED" counts and the green card highlight already
key off `meetsPaperMoneyRule`, so they follow automatically; three UI
strings need rewording (the "clears 18%+ edge / 45%+ prob" stat label and
the two no-stake badge tooltips). Roughly ten lines of code plus a doc
note.

**Graduation trigger.** The honest problem is volume. At 18%/45% the
concurrent window (2024-09-20 → 2026-05-24, about 1.7 seasons) produced:

| League | Bets | Per season | Seasons to n=100 |
|---|---|---|---|
| Premier League | 15 | ~9 | ~11 |
| La Liga | 13 | ~8 | ~13 |
| Ligue 1 | 8 | ~5 | ~21 |
| Scottish Premiership | 8 | ~5 | ~21 |
| Bundesliga | 5 | ~3 | ~34 |
| Serie A | 5 | ~3 | ~34 |
| Eredivisie | 3 | ~2 | ~57 |
| Primeira Liga | 3 | ~2 | ~57 |
| **All eight pooled** | **60** | **~35** | **~3** |

A per-league trigger at a decision-grade sample is therefore not reachable
on live data for anything but the Premier League and La Liga, and even
those take a decade. Proposed rule, in two tiers, evaluated once per
season per rule 3:

1. **Group trigger (realistic):** the eight leagues re-enter paper-with-
   stake together when their pooled rule-16-clean, test-only population at
   18%/45% reaches n ≥ 100 with the 95% CI lower bound above zero and no
   season block negative — about three seasons from now — *and* no single
   league is individually negative at n ≥ 30. Counting the backtest
   population rather than live-scanner bets is deliberate: it is the same
   fixtures (every priced fixture is scored either way) and it is the same
   standard that admitted the rule-12 leagues.
2. **Individual trigger:** a league may re-enter alone once its own
   rule-16-clean population at 18%/45% reaches n ≥ 100 with CI lower bound
   above zero. This mirrors how League Two's own figure was accepted
   (Addendum 19: a single disciplined look at its full population), scaled
   to what this rule's selectivity can produce.

**Alternative, stated fairly:** keep the eight staked and review per
league. Their pooled figure is positive, not negative (CI lower bound
+0.4%), and paper money is not real money. The recommendation above is
still to narrow, because the paper record is what the real-money case is
built on, and a positive-but-uninformative sample adds noise to that case
rather than evidence.

### Part B — Is 18%/45% the right threshold for the narrower population?

**Design** (temp `GET /api/admin/diag-rule12-threshold-search`, removed
after this addendum in commit `85ab355`; confirmed live via a logged-in 404
check at 2026-09-04 13:07 UTC). Population: every matched Championship / League One /
League Two fixture before each league's rule-12 cutoff (n=10,142). All
three were excluded wholesale from the live model's 2026-08-08 training
(League One/Two under rule 10 at the time; Championship not yet ingested),
so the whole window is tree-clean; the date-only rule-16 tag marks 4,131
of them pre-boundary and overstates exposure for these leagues
specifically. Scoring model 2026-08-08, calibration factor 1.02.

- **Train:** 2020-06-18 → 2024-09-15, n=6,984. A 9 × 4 grid (edge floors
  10-24%, probability floors none/40/45/50%) was evaluated on train only,
  each cell in four equal-count chronological blocks.
- **Selection rule, fixed in code before any test figure existed:**
  robust (all four train blocks positive at n ≥ 20) and train n ≥ 100,
  maximise absolute return, ties to the higher edge floor; fallback if
  nothing is robust: ≥ 3 positive blocks.
- **Test:** 2024-09-16 → cutoff, n=3,158. The endpoint computed test
  figures for exactly two cells — the train-selected one and the incumbent
  — and never built a test grid.

**Train result: nothing is robust, and the reason is a regime, not a
threshold.** All 36 cells are negative in train block 1 (2020-06 → ~2021-
08); 33 of 36 are negative in block 2; 33 are positive in block 3 and 35 in
block 4. Whatever the floor, the rule-12 leagues lose in 2020-22 and win
from 2023 on. The raw population is flat throughout (train all-fixture
ROI: Championship +0.3%, League One −2.1%, League Two −0.3%).

| Train cell | n | ROI | 95% CI | Blocks | Abs. return |
|---|---|---|---|---|---|
| 18% / 45% (incumbent) | 498 | +6.2% | [−7.1, +19.6] | −12.7, −2.5, +17.7, +31.5 | +31.0 |
| 20% / 45% | 363 | +8.3% | [−8.0, +24.7] | −21.6, −2.5, +23.6, +43.9 | +30.3 |
| 22% / 50% | 228 | +11.4% | [−10.1, +32.8] | −9.3, −4.0, +10.0, +58.3 | +25.9 |
| 22% / none (train-selected, fallback rule) | 262 | +8.3% | [−12.3, +28.8] | −18.1, +11.6, +3.8, +43.3 | +21.7 |
| 18% / none | 562 | +0.4% | [−12.3, +13.1] | −14.3, −1.6, +0.8, +23.7 | +2.2 |
| 15% / 45% | 805 | −1.4% | [−11.1, +8.3] | −18.3, −9.4, +11.7, +16.4 | −11.1 |

The 45% probability floor earns its place on train (18/45 +6.2% vs 18/none
+0.4% on more bets), and 18% is where absolute return peaks; the fallback
rule picked 22%/none only because it was the sole cell with three positive
blocks.

**Single test look:**

| Test cell | n | ROI | 95% CI | Blocks | Abs. return |
|---|---|---|---|---|---|
| 18% / 45% (incumbent) | 213 | +31.5% | [+3.7, +59.3] | +9.1, +49.5, +57.6, +0.2 | +67.1 |
| 22% / none (train-selected) | 112 | +35.8% | [−11.4, +83.0] | +36.0, +58.5, +61.3, −4.0 | +40.1 |

Per league at 18/45 on test: Championship 77 bets +20.8%, League One 61
+13.2%, League Two 75 +57.4%. At 22/none: 38 / 38 / 36 bets, +15.3% /
+14.4% / +79.9%.

**Verdict: 18%/45% stands for the narrower population.** The disciplined
search did not find a combination that beats it: the train-selected
alternative has half the volume, a CI that spans zero, a negative final
block, and 40% less absolute return on test. Higher ROI on fewer bets is
not the objective; the original exploration chose 18/45 for sitting at the
absolute-return peak, and that is where it still sits here.

Two caveats that must travel with that verdict:

1. **18/45 is not clean on this test window.** It was selected on the
   2024-09-16 → concurrent window across all 11 leagues (Addendum 37 Part
   D). Its test figure is therefore in-sample-selected; only the 22/none
   figure is a genuinely fresh look. The comparison is still fair in the
   direction that matters — the fresh alternative did not win.
2. **The rule's support in these leagues is a 2023-onward phenomenon.**
   Its own train record is +6.2% with a CI spanning zero and two negative
   blocks. Whether 2020-22 reflects a market regime, thinner historical
   stats for lower-league fixtures, or something else is not established
   here — it is the same "flat earliest block" pattern noted when the rule
   was first chosen, now visible cell-by-cell. It argues for watching the
   live record per season, not for a different threshold.

### Part C — Not done here

No code, gating or settings change. If Part A is adopted, the change is
scoped above; it should be its own small commit with the UI strings, and
the Scout tab's paper-money counters re-verified against a live scan.

## Addendum 39 — Championship / League One / League Two: full 1% edge × probability grid, layered floors, calibration re-check, and recommendation (consolidated)

Analysis only, 2026-09-04. Supersedes the Stage 1–3 work started earlier the
same day (same three leagues, same split) and folds it in. Nothing in live
scoring, gating or settings was changed. Tournament competitions and the
eight top divisions are excluded throughout.

### Part A — Calibration confirmation (read first)

Every edge in this addendum was computed with the domestic calibration factor
**1.02**, read live at run time, not cached:

- `computeMatchedEdgeFixtures()` calls `getSettings()` at entry
  (`server.js:8347`), which reads `settings.json` from disk on every call.
- Per record it calls `getCalFactorForLeague(settings, leagueId)`
  (`server.js:8416`) — `settings.calibrationFactor ?? 1.02` for domestic ids.
- The factor is applied inside `computeUnifiedEdge()` (`server.js:8434`):
  `calProb = min(0.97, modelProb × factor)`, `edge = calProb − margin-stripped Pinnacle`.
- The run reported `storedSettingsCalibrationFactor: 1.02`,
  `effectiveDomesticCalFactor: 1.02`, and **0 mismatches** when every one of
  the 10,142 records' stored `calProb` was checked against
  `min(0.97, modelProb × 1.02)`. The only cached object in this path is the
  raw scored-record file; no edge is ever cached.

Scoring model 2026-08-08 (tree boundary 2022-11-13). All three leagues were
excluded wholesale from that training run, so every fixture here is
tree-clean regardless of date.

**But 1.02 is not the right factor for these leagues — see Part E.** The
grid below is therefore on the *deployed* edge scale, which is what the live
rule uses, not on a scale that is calibrated for this population.

### Part B — Population and discipline

Two periods, identical filters (pre-cutoff fixtures of leagues 40/41/42 with
Pinnacle closing odds):

| Period | Range | n | Role |
|---|---|---|---|
| Window | 2024-09-16 → 2026-08-17 (23 months) | 3,158 | The window 18/45 was selected on (Addendum 37 D2) and the *test* window of Addendum 38 and of Part D below |
| Pre-window | 2020-06-18 → 2024-09-15 | 6,984 | Out-of-window check for anything highlighted from the window |

The grid was computed on both. The two highlighted cells in Part D were
chosen by rules fixed in code before any figure existed (max absolute return
at n≥30; max 95% CI lower bound at n≥100), on the window grid, and are shown
with their pre-window figures. **Honesty note:** the window has now been
looked at four times this week (the 2026-08-31 scan, Addendum 38, the Part D
layered search, and this grid). Anything chosen from it is in-sample-selected;
the pre-window column and the four equal-count blocks are the only
out-of-selection evidence in this document. Thin cells (n<30, rule 6) are
marked \*.

Full 806-cell grid (both periods, with CIs): `docs/addendum-39-rule12-grid.csv`.

### Part C — The grid (n / ROI / absolute return in units of 1 stake)

**C1. Window (2024-09-16 → 2026-08-17), edge floor × probability floor:**

| Edge ≥ | prob ≥35% | prob ≥40% | prob ≥45% | prob ≥50% | prob ≥55% | prob ≥60% | prob ≥65% |
|---|---|---|---|---|---|---|---|
| 5% | 1515 / +3.4% / +50.9 | 1299 / +5% / +65 | 981 / +7.4% / +73 | 704 / +10% / +70.3 | 448 / +5% / +22.5 | 286 / +4.4% / +12.5 | 161 / +9.6% / +15.4 |
| 6% | 1382 / +4.2% / +57.5 | 1188 / +6.1% / +72.8 | 910 / +8.7% / +78.8 | 660 / +9.9% / +65.2 | 427 / +4.7% / +20 | 275 / +3.3% / +9 | 157 / +10.5% / +16.5 |
| 7% | 1249 / +4.7% / +59.1 | 1080 / +6.8% / +72.9 | 830 / +10.2% / +84.6 | 613 / +11.1% / +67.8 | 400 / +6.3% / +25.4 | 261 / +3.4% / +8.9 | 149 / +9.2% / +13.7 |
| 8% | 1120 / +4.1% / +45.8 | 976 / +7.1% / +68.9 | 756 / +11% / +82.9 | 569 / +11.9% / +67.9 | 378 / +7% / +26.6 | 250 / +4.2% / +10.4 | 143 / +9.6% / +13.7 |
| 9% | 998 / +5.2% / +52 | 872 / +9.2% / +79.8 | 689 / +11.8% / +81.6 | 524 / +11.6% / +60.9 | 351 / +6.6% / +23.2 | 233 / +3.7% / +8.6 | 133 / +8.8% / +11.8 |
| 10% | 881 / +3.9% / +34.7 | 777 / +7.8% / +60.3 | 616 / +10.6% / +65.2 | 469 / +11.4% / +53.5 | 320 / +6.1% / +19.6 | 208 / +4.1% / +8.5 | 118 / +10.3% / +12.1 |
| 11% | 770 / +9.2% / +70.7 | 680 / +12.6% / +85.7 | 556 / +14.4% / +80.3 | 429 / +14.3% / +61.2 | 293 / +8.7% / +25.4 | 191 / +7.5% / +14.4 | 109 / +12.5% / +13.6 |
| 12% | 680 / +12.9% / +88 | 604 / +15.3% / +92.3 | 503 / +16.9% / +84.9 | 391 / +16.4% / +64 | 273 / +11.7% / +31.9 | 176 / +9% / +15.8 | 100 / +16.4% / +16.4 |
| 13% | 597 / +13.1% / +78 | 537 / +16.4% / +88.3 | 452 / +19.2% / +86.8 | 361 / +19.1% / +68.9 | 255 / +14.2% / +36.2 | 164 / +10% / +16.4 | 93 / +14.9% / +13.9 |
| 14% | 510 / +12.8% / +65.1 | 468 / +16.3% / +76.2 | 398 / +20.9% / +83.2 | 318 / +17.9% / +57.1 | 227 / +12.6% / +28.6 | 147 / +7.1% / +10.5 | 83 / +15% / +12.5 |
| 15% | 424 / +13% / +55.1 | 389 / +17.3% / +67.1 | 344 / +21.2% / +73 | 283 / +17.9% / +50.7 | 205 / +11.4% / +23.4 | 135 / +4.5% / +6.1 | 80 / +13.2% / +10.6 |
| 16% | 363 / +15.6% / +56.5 | 334 / +20% / +66.9 | 298 / +23.8% / +70.8 | 249 / +20.7% / +51.6 | 179 / +15.7% / +28.2 | 121 / +6.6% / +7.9 | 72 / +14.7% / +10.6 |
| 17% | 306 / +16.4% / +50.2 | 286 / +21.3% / +60.9 | 259 / +24.3% / +63 | 223 / +19.8% / +44.1 | 163 / +16.3% / +26.5 | 113 / +8.7% / +9.8 | 68 / +21.5% / +14.6 |
| 18% | 246 / +21.5% / +52.9 | 234 / +25.6% / +59.9 | 213 / +31.5% / +67.1 | 186 / +24.4% / +45.4 | 134 / +20.7% / +27.7 | 96 / +8.9% / +8.5 | 59 / +19.8% / +11.7 |
| 19% | 204 / +24.3% / +49.6 | 194 / +28.1% / +54.6 | 176 / +33.4% / +58.8 | 162 / +28.6% / +46.3 | 119 / +23.5% / +27.9 | 89 / +6.4% / +5.7 | 55 / +18.8% / +10.4 |
| 20% | 171 / +24.3% / +41.6 | 165 / +25.8% / +42.5 | 150 / +29.2% / +43.7 | 139 / +22.8% / +31.7 | 108 / +23.2% / +25.1 | 81 / +5.7% / +4.6 | 49 / +14.8% / +7.2 |
| 21% | 136 / +27% / +36.7 | 133 / +29.8% / +39.7 | 124 / +31.4% / +38.9 | 113 / +23.8% / +26.9 | 91 / +23.7% / +21.6 | 72 / +11.7% / +8.4 | 43 / +18.8% / +8.1 |
| 22% | 112 / +35.8% / +40.1 | 110 / +38.3% / +42.1 | 105 / +39.8% / +41.7 | 97 / +27.6% / +26.7 | 79 / +29.9% / +23.6 | 63 / +11.9% / +7.5 | 40 / +14.3% / +5.7 |
| 23% | 96 / +41.2% / +39.6 | 95 / +42.7% / +40.6 | 91 / +43.1% / +39.2 | 84 / +27.7% / +23.2 | 69 / +29.5% / +20.3 | 54 / +10.6% / +5.7 | 35 / +20.3% / +7.1 |
| 24% | 76 / +52.8% / +40.1 | 76 / +52.8% / +40.1 | 73 / +51.7% / +37.7 | 70 / +25.4% / +17.8 | 60 / +35% / +21 | 48 / +12.9% / +6.2 | 32 / +19.7% / +6.3 |
| 25% | 62 / +60% / +37.2 | 62 / +60% / +37.2 | 59 / +59.1% / +34.9 | 57 / +24.4% / +13.9 | 49 / +30.9% / +15.1 | 37 / +0.8% / +0.3 | 26 / +0.9% / +0.2 \* |
| 26% | 49 / +66% / +32.3 | 49 / +66% / +32.3 | 46 / +65.2% / +30 | 44 / +20.4% / +9 | 38 / +39.4% / +15 | 28 / +6.1% / +1.7 \* | 19 / +10.8% / +2.1 \* |
| 27% | 36 / +95.4% / +34.3 | 36 / +95.4% / +34.3 | 35 / +101% / +35.3 | 34 / +39.2% / +13.3 | 30 / +57.8% / +17.3 | 22 / +22.8% / +5 \* | 15 / +40.4% / +6.1 \* |
| 28% | 30 / +102% / +30.6 | 30 / +102% / +30.6 | 30 / +102% / +30.6 | 29 / +29.6% / +8.6 \* | 25 / +50.4% / +12.6 \* | 19 / +31.1% / +5.9 \* | 14 / +35.4% / +4.9 \* |
| 29% | 24 / +152.5% / +36.6 \* | 24 / +152.5% / +36.6 \* | 24 / +152.5% / +36.6 \* | 23 / +63.4% / +14.6 \* | 21 / +79% / +16.6 \* | 16 / +55.7% / +8.9 \* | 13 / +45.8% / +5.9 \* |
| 30% | 22 / +160.5% / +35.3 \* | 22 / +160.5% / +35.3 \* | 22 / +160.5% / +35.3 \* | 21 / +63.4% / +13.3 \* | 19 / +80.6% / +15.3 \* | 16 / +55.7% / +8.9 \* | 13 / +45.8% / +5.9 \* |

**C2. Pre-window (2020-06-18 → 2024-09-15), same cells:**

| Edge ≥ | prob ≥35% | prob ≥40% | prob ≥45% | prob ≥50% | prob ≥55% | prob ≥60% | prob ≥65% |
|---|---|---|---|---|---|---|---|
| 5% | 3545 / 0% / +0.6 | 3018 / -2.2% / -66.7 | 2329 / -1% / -22.8 | 1651 / -2.8% / -46 | 1098 / +2% / +21.5 | 711 / -1.1% / -7.5 | 392 / -2.3% / -8.8 |
| 6% | 3229 / -0.4% / -13.4 | 2775 / -2.7% / -76 | 2161 / -1.9% / -41.2 | 1555 / -3.7% / -57.5 | 1044 / +1.8% / +19.1 | 681 / -1.2% / -8.3 | 378 / -3.7% / -14 |
| 7% | 2959 / 0% / +0.7 | 2562 / -2.2% / -56.7 | 2013 / -1.5% / -31.1 | 1458 / -3.2% / -47.1 | 983 / +1.9% / +18.4 | 649 / -1.6% / -10.2 | 363 / -4% / -14.6 |
| 8% | 2637 / -0.8% / -22.1 | 2309 / -2.5% / -57.7 | 1826 / -1.2% / -22.8 | 1343 / -3.4% / -45.8 | 908 / +1.9% / +17.7 | 602 / -2.7% / -16.3 | 335 / -6.1% / -20.5 |
| 9% | 2359 / -1.2% / -29.5 | 2080 / -2.2% / -45.3 | 1672 / -0.8% / -13.8 | 1242 / -1.7% / -21.1 | 843 / +4.6% / +38.9 | 558 / -1.5% / -8.4 | 318 / -4.8% / -15.3 |
| 10% | 2078 / -2.2% / -45.9 | 1860 / -2.6% / -48.9 | 1512 / -1.7% / -25.9 | 1131 / -2.7% / -31 | 776 / +3.1% / +24.3 | 518 / -2.9% / -14.9 | 294 / -6.2% / -18.2 |
| 11% | 1804 / -4.3% / -78.3 | 1628 / -4.4% / -72.1 | 1355 / -2.7% / -36.5 | 1026 / -3.1% / -31.4 | 715 / +2.6% / +18.7 | 481 / -3.4% / -16.4 | 276 / -6.8% / -18.9 |
| 12% | 1564 / -4.3% / -67.7 | 1426 / -4.5% / -63.8 | 1218 / -1.8% / -22.2 | 934 / -3.5% / -32.7 | 660 / +2.6% / +17.4 | 441 / -3.6% / -16.1 | 254 / -5.7% / -14.4 |
| 13% | 1340 / -4.6% / -61.1 | 1235 / -4.3% / -53 | 1072 / -2.1% / -22.2 | 847 / -3.8% / -32.3 | 605 / +2.3% / +13.9 | 406 / -2.9% / -12 | 234 / -5.9% / -13.9 |
| 14% | 1147 / -4.7% / -54.2 | 1055 / -4.1% / -43.5 | 930 / -2% / -18.2 | 749 / -3.8% / -28.7 | 537 / +2.6% / +13.8 | 370 / -3.7% / -13.8 | 211 / -7.3% / -15.5 |
| 15% | 968 / -4.4% / -42.9 | 901 / -4.2% / -37.5 | 805 / -1.4% / -11.1 | 660 / -3.5% / -22.8 | 487 / +3.1% / +15.3 | 333 / -4.3% / -14.2 | 190 / -7.4% / -14 |
| 16% | 823 / -3.6% / -29.8 | 773 / -2.8% / -21.4 | 702 / +0.5% / +3.8 | 587 / -1.8% / -10.8 | 443 / +4% / +17.7 | 308 / -3.4% / -10.6 | 177 / -8.1% / -14.3 |
| 17% | 674 / 0% / +0.2 | 637 / +0.7% / +4.6 | 582 / +4.9% / +28.4 | 494 / +1% / +4.7 | 379 / +5.3% / +20.2 | 263 / -0.4% / -1.1 | 149 / -6.3% / -9.3 |
| 18% | 562 / +0.4% / +2.2 | 536 / +0.9% / +4.9 | 498 / +6.2% / +31 | 425 / +2.7% / +11.5 | 328 / +6.9% / +22.6 | 229 / -0.6% / -1.4 | 131 / -6.8% / -8.9 |
| 19% | 476 / +4.2% / +20 | 457 / +3.4% / +15.7 | 433 / +8.2% / +35.6 | 374 / +4.6% / +17.2 | 290 / +9% / +26.1 | 209 / +0.5% / +1.1 | 118 / -5.9% / -7 |
| 20% | 397 / +4.9% / +19.6 | 382 / +3% / +11.3 | 363 / +8.3% / +30.3 | 318 / +5.6% / +18 | 248 / +12.1% / +30 | 181 / +5.5% / +9.9 | 106 / -2.6% / -2.8 |
| 21% | 321 / +8.7% / +27.9 | 312 / +6% / +18.7 | 301 / +9.9% / +29.7 | 268 / +10.5% / +28.2 | 210 / +19.1% / +40.2 | 154 / +12.4% / +19.1 | 88 / +4.9% / +4.3 |
| 22% | 262 / +8.3% / +21.7 | 255 / +6.2% / +15.8 | 249 / +8.8% / +21.8 | 228 / +11.4% / +25.9 | 185 / +21.4% / +39.5 | 138 / +14.3% / +19.7 | 78 / +10.8% / +8.5 |
| 23% | 230 / +11.7% / +26.8 | 225 / +11.1% / +24.9 | 222 / +12.6% / +27.9 | 205 / +13.7% / +28 | 166 / +24.5% / +40.7 | 125 / +16.3% / +20.4 | 69 / +14.7% / +10.1 |
| 24% | 191 / +11.1% / +21.2 | 188 / +9.2% / +17.3 | 185 / +11% / +20.3 | 173 / +13.5% / +23.3 | 142 / +26.4% / +37.5 | 109 / +16.2% / +17.6 | 59 / +10.1% / +6 |
| 25% | 156 / +19.2% / +30 | 153 / +17.1% / +26.1 | 150 / +19.4% / +29.1 | 144 / +21.2% / +30.5 | 122 / +31.9% / +38.9 | 94 / +18% / +16.9 | 52 / +8.5% / +4.4 |
| 26% | 127 / +15.1% / +19.2 | 126 / +16% / +20.2 | 124 / +17.9% / +22.2 | 118 / +20% / +23.6 | 103 / +30.7% / +31.6 | 82 / +21.9% / +17.9 | 44 / +13.9% / +6.1 |
| 27% | 103 / +18.9% / +19.5 | 102 / +20.1% / +20.5 | 100 / +22.5% / +22.5 | 96 / +27.6% / +26.5 | 85 / +39.8% / +33.9 | 67 / +25.7% / +17.2 | 35 / +13.8% / +4.8 |
| 28% | 89 / +26.8% / +23.9 | 88 / +28.3% / +24.9 | 87 / +29.7% / +25.9 | 85 / +32.8% / +27.9 | 77 / +41.9% / +32.2 | 63 / +24.9% / +15.7 | 32 / +7.2% / +2.3 |
| 29% | 72 / +27.6% / +19.9 | 71 / +29.4% / +20.9 | 71 / +29.4% / +20.9 | 70 / +31.2% / +21.9 | 65 / +41.3% / +26.9 | 54 / +23.5% / +12.7 | 27 / -7% / -1.9 \* |
| 30% | 60 / +21.9% / +13.1 | 60 / +21.9% / +13.1 | 60 / +21.9% / +13.1 | 59 / +23.9% / +14.1 | 55 / +32.9% / +18.1 | 46 / +27.8% / +12.8 | 24 / -4.3% / -1 \* |

**C3. Window, 1% probability steps at selected edge floors:**

| Prob ≥ | edge ≥5% | edge ≥10% | edge ≥15% | edge ≥18% | edge ≥20% | edge ≥25% | edge ≥30% |
|---|---|---|---|---|---|---|---|
| 35% | 1515 / +3.4% / +50.9 | 881 / +3.9% / +34.7 | 424 / +13% / +55.1 | 246 / +21.5% / +52.9 | 171 / +24.3% / +41.6 | 62 / +60% / +37.2 | 22 / +160.5% / +35.3 \* |
| 36% | 1506 / +3.5% / +52.9 | 879 / +4.2% / +36.7 | 424 / +13% / +55.1 | 246 / +21.5% / +52.9 | 171 / +24.3% / +41.6 | 62 / +60% / +37.2 | 22 / +160.5% / +35.3 \* |
| 37% | 1474 / +3.5% / +51.6 | 863 / +4.1% / +35.1 | 419 / +11.1% / +46.4 | 245 / +22% / +53.9 | 171 / +24.3% / +41.6 | 62 / +60% / +37.2 | 22 / +160.5% / +35.3 \* |
| 38% | 1417 / +3.2% / +45.9 | 838 / +4.9% / +41.2 | 409 / +13.8% / +56.4 | 239 / +25.1% / +59.9 | 168 / +26.5% / +44.6 | 62 / +60% / +37.2 | 22 / +160.5% / +35.3 \* |
| 39% | 1344 / +4% / +54.2 | 798 / +7.4% / +58.9 | 395 / +17.8% / +70.4 | 236 / +26.7% / +62.9 | 167 / +27.3% / +45.6 | 62 / +60% / +37.2 | 22 / +160.5% / +35.3 \* |
| 40% | 1299 / +5% / +65 | 777 / +7.8% / +60.3 | 389 / +17.3% / +67.1 | 234 / +25.6% / +59.9 | 165 / +25.8% / +42.5 | 62 / +60% / +37.2 | 22 / +160.5% / +35.3 \* |
| 41% | 1227 / +5% / +61.6 | 743 / +7.1% / +52.7 | 384 / +17.7% / +68 | 232 / +26.7% / +61.9 | 164 / +26.5% / +43.5 | 62 / +60% / +37.2 | 22 / +160.5% / +35.3 \* |
| 42% | 1163 / +6.1% / +70.6 | 702 / +8.2% / +57.6 | 373 / +19.2% / +71.6 | 229 / +28.3% / +64.9 | 162 / +28.1% / +45.5 | 61 / +62.7% / +38.2 | 22 / +160.5% / +35.3 \* |
| 43% | 1112 / +7.3% / +81.6 | 685 / +8.9% / +60.6 | 368 / +18.6% / +68.6 | 226 / +28.1% / +63.5 | 160 / +27% / +43.1 | 61 / +62.7% / +38.2 | 22 / +160.5% / +35.3 \* |
| 44% | 1036 / +7% / +72.5 | 646 / +9.2% / +59.2 | 356 / +18.1% / +64.4 | 219 / +27.9% / +61.1 | 155 / +25% / +38.7 | 59 / +59.1% / +34.9 | 22 / +160.5% / +35.3 \* |
| 45% | 981 / +7.4% / +73 | 616 / +10.6% / +65.2 | 344 / +21.2% / +73 | 213 / +31.5% / +67.1 | 150 / +29.2% / +43.7 | 59 / +59.1% / +34.9 | 22 / +160.5% / +35.3 \* |
| 46% | 926 / +5.1% / +47.4 | 587 / +6.9% / +40.5 | 335 / +14.4% / +48.2 | 209 / +21.4% / +44.7 | 148 / +15.4% / +22.7 | 58 / +22.2% / +12.9 | 21 / +63.4% / +13.3 \* |
| 47% | 859 / +5.2% / +44.5 | 553 / +6.8% / +37.7 | 322 / +11.9% / +38.4 | 204 / +17.8% / +36.4 | 147 / +16.2% / +23.7 | 58 / +22.2% / +12.9 | 21 / +63.4% / +13.3 \* |
| 48% | 805 / +7.7% / +62.4 | 526 / +9.7% / +50.8 | 310 / +14.4% / +44.6 | 197 / +22% / +43.4 | 143 / +19.4% / +27.7 | 57 / +24.4% / +13.9 | 21 / +63.4% / +13.3 \* |
| 49% | 759 / +8.5% / +64.7 | 498 / +10.8% / +53.8 | 296 / +16.7% / +49.5 | 193 / +24.6% / +47.4 | 142 / +20.2% / +28.7 | 57 / +24.4% / +13.9 | 21 / +63.4% / +13.3 \* |
| 50% | 704 / +10% / +70.3 | 469 / +11.4% / +53.5 | 283 / +17.9% / +50.7 | 186 / +24.4% / +45.4 | 139 / +22.8% / +31.7 | 57 / +24.4% / +13.9 | 21 / +63.4% / +13.3 \* |
| 51% | 649 / +5.7% / +37 | 441 / +6.4% / +28 | 268 / +9.8% / +26.2 | 175 / +16% / +27.9 | 133 / +20.6% / +27.3 | 55 / +22.3% / +12.2 | 20 / +71.5% / +14.3 \* |
| 52% | 598 / +4.6% / +27.6 | 405 / +5.2% / +21 | 250 / +8.4% / +21.1 | 163 / +15.2% / +24.7 | 127 / +18.8% / +23.8 | 55 / +22.3% / +12.2 | 20 / +71.5% / +14.3 \* |
| 53% | 547 / +3.1% / +17.1 | 377 / +4.8% / +18.2 | 239 / +8.1% / +19.4 | 154 / +15.3% / +23.6 | 122 / +19.9% / +24.3 | 53 / +26.9% / +14.3 | 20 / +71.5% / +14.3 \* |
| 54% | 497 / +3.5% / +17.3 | 347 / +4.9% / +17 | 220 / +9.4% / +20.6 | 141 / +16.9% / +23.8 | 115 / +18.4% / +21.2 | 52 / +29.3% / +15.3 | 20 / +71.5% / +14.3 \* |
| 55% | 448 / +5% / +22.5 | 320 / +6.1% / +19.6 | 205 / +11.4% / +23.4 | 134 / +20.7% / +27.7 | 108 / +23.2% / +25.1 | 49 / +30.9% / +15.1 | 19 / +80.6% / +15.3 \* |
| 56% | 419 / +4.2% / +17.7 | 299 / +4.9% / +14.5 | 191 / +7.1% / +13.6 | 125 / +18% / +22.4 | 102 / +19% / +19.4 | 47 / +28.5% / +13.4 | 18 / +69.8% / +12.6 \* |
| 57% | 383 / +2.8% / +10.6 | 277 / +2.4% / +6.7 | 179 / +3.7% / +6.6 | 118 / +16.9% / +19.9 | 97 / +15.3% / +14.9 | 44 / +21.9% / +9.6 | 18 / +69.8% / +12.6 \* |
| 58% | 344 / +3.4% / +11.6 | 250 / +3.7% / +9.1 | 163 / +5.2% / +8.5 | 109 / +19.8% / +21.6 | 91 / +17.5% / +15.9 | 43 / +24.8% / +10.6 | 18 / +69.8% / +12.6 \* |
| 59% | 312 / +4.9% / +15.2 | 222 / +4.7% / +10.5 | 139 / +7.1% / +9.9 | 98 / +12.4% / +12.2 | 82 / +11.3% / +9.3 | 38 / +13.1% / +5 | 17 / +79.8% / +13.6 \* |
| 60% | 286 / +4.4% / +12.5 | 208 / +4.1% / +8.5 | 135 / +4.5% / +6.1 | 96 / +8.9% / +8.5 | 81 / +5.7% / +4.6 | 37 / +0.8% / +0.3 | 16 / +55.7% / +8.9 \* |
| 61% | 261 / +4.6% / +12.1 | 185 / +5.1% / +9.5 | 118 / +5.8% / +6.8 | 85 / +8.9% / +7.5 | 73 / +7% / +5.1 | 35 / -1.1% / -0.4 | 16 / +55.7% / +8.9 \* |
| 62% | 235 / +4.1% / +9.7 | 165 / +4.9% / +8 | 107 / +3.9% / +4.2 | 78 / +11.9% / +9.2 | 67 / +8.7% / +5.8 | 32 / -1% / -0.3 | 15 / +46.5% / +7 \* |
| 63% | 205 / +6.5% / +13.3 | 145 / +9.5% / +13.7 | 95 / +7.9% / +7.5 | 70 / +15.3% / +10.7 | 60 / +10.5% / +6.3 | 32 / -1% / -0.3 | 15 / +46.5% / +7 \* |
| 64% | 182 / +7.7% / +14 | 131 / +7.9% / +10.3 | 86 / +7.6% / +6.5 | 63 / +12.2% / +7.7 | 53 / +6.1% / +3.3 | 27 / -2.9% / -0.8 \* | 13 / +45.8% / +5.9 \* |
| 65% | 161 / +9.6% / +15.4 | 118 / +10.3% / +12.1 | 80 / +13.2% / +10.6 | 59 / +19.8% / +11.7 | 49 / +14.8% / +7.2 | 26 / +0.9% / +0.2 \* | 13 / +45.8% / +5.9 \* |

What the grid says, read as a whole:

- **The window is positive almost everywhere and the pre-window is negative
  almost everywhere below 17% edge.** That is the regime pattern already seen
  in Addendum 38's train blocks, now cell by cell: for edge floors 5–16% the
  pre-window absolute return is negative in nearly every probability column,
  and the window flips it positive. Only the 17%+ rows are positive in both
  periods, and only weakly pre-window.
- **The probability floor matters most in the 40–45% column.** In both
  periods, cells that include the 40–45% band do worse than the same edge
  floor at ≥45% (window, edge ≥18%: prob ≥40% 234 bets +25.6% vs ≥45% 213
  bets +31.5%; pre-window +0.9% vs +6.2%). This is the same 40-45% finding the
  project has had since Addendum 6, visible here at 1% resolution.
- **Raising the probability floor past 50% costs volume faster than it adds
  ROI** in the window (edge ≥18%: ≥50% 186 bets +24.4%; ≥55% 134 bets +20.7%;
  ≥60% 96 bets +8.9%).
- **Above ~24% edge every cell is thin or near-thin** and the ROIs are
  unstable (window 27%/45%: 35 bets, +101%, CI [−33, +235]).

### Part D — Layered floors and the two highlighted cells

**D1. Layered comparison, train-only search with single test looks** (the
Stage 2 run earlier today; train = pre-window, test = window; per floor a
"return pick" = max train absolute return and a "safety pick" = max train CI
lower bound, both n≥100 and ≥2 positive train blocks):

| Floor | Return pick | Train | Test (single look) | Safety pick | Train | Test (single look) |
|---|---|---|---|---|---|---|
| ≥40% | 24% edge | 188, +9.2%, abs +17 | 76, +52.8%, CI [−13.5, +119], abs +40, blocks +43/+124/+38/+19 | 8% edge | 2,309, −2.5% | 976, +7.1%, CI [−2.1, +16.2], abs +69, one negative block |
| ≥45% | **18% edge (incumbent)** | 498, +6.2%, abs +31 | **213, +31.5%, CI [+3.7, +59.3], abs +67, blocks +9/+49/+58/+0.2** | 8% edge | 1,826, −1.3% | 756, +11.0%, CI [+0.6, +21.3], abs +83, one negative block |
| ≥50% | 22% edge | 228, +11.4%, abs +26 | 97, +27.6%, CI [−2.1, +57.2], abs +27, blocks +79/−28/+67/−6 | 8% edge | 1,343, −3.4% | 569, +11.9%, CI [+2.3, +21.6], abs +68, all blocks positive |

The "safety" criterion degenerated: no train cell had a positive CI lower
bound, so max-lower-bound picked the largest-n (negative-ROI) cell at every
floor. Those 8%-edge cells then did well on test — but their train records
are negative, so nothing supports them beyond the window itself. Between the
three floors, ≥45% is the only one whose return pick is positive in both
periods with every test block positive; ≥40% admits the 40-45% band; ≥50%
halves the volume for no gain in reliability.

**D2. The two highlighted cells from the full window grid, with their
out-of-window figures:**

| Cell | Window | Window blocks | Pre-window | Verdict |
|---|---|---|---|---|
| **Best total absolute return: 12% / 39%** | 617 bets, +15.5%, CI [+2.7, +28.3], abs **+95.6** | −7.6 / +38.1 / +24.6 / +5.9 | 1,465 bets, **−5.2%**, CI [−12.1, +1.7], abs **−76.4**, blocks −11.2 / −11.2 / +3.2 / −0.3 | Highest window return, but it is the broad population and it *loses* out-of-window. Not supportable. |
| **Best risk-adjusted: 19% / 50%** | 162 bets, +28.6%, CI [**+6.2**, +51.0], abs +46.3 | +32.5 / +10.9 / +60.0 / +3.4 | 374 bets, +4.6%, CI [−10.7, +19.8], abs +17.2, blocks −17 / −9 / +6.7 / +49.6 | Clears zero most comfortably on the window; positive but weaker than 18/45 pre-window; 24% fewer bets. |
| Incumbent 18% / 45% | 213 bets, +31.5%, CI [+3.7, +59.3], abs +67.1 | +9.1 / +49.4 / +57.6 / +0.2 | 498 bets, +6.2%, CI [−7.1, +19.6], abs **+31.0**, blocks −12.7 / −2.5 / +17.7 / +31.5 | Best pre-window absolute return of the three; every window block positive; more volume than 19/50. |

The two framings diverge, as expected: total return points at a broad,
low-floor cell that the pre-window rejects; risk-adjusted points at a
near-neighbour of 18/45 with less volume. Top-10 lists by each criterion are
in the run output summarised here: by absolute return, the top nine cells are
all edge 6–13% / probability 35–45%; by CI lower bound, all ten are edge
12–19% / probability 45–50%.

### Part E — Is 1.02 still the best calibration factor? No, not for these leagues.

Same method as the 2026-09-01 sweep (commit `3415075`: Brier score of the
top pick's `min(0.97, modelProb × factor)` against outcome, step 0.01), run on
the populations that sweep never separated:

| Population | n | Brier-optimal factor | Brier at 1.00 | at 1.02 | at best |
|---|---|---|---|---|---|
| Rule-12 leagues, all tree-clean history | 10,142 | **0.93** | 0.24582 | 0.24659 | 0.24467 |
| — Championship | 3,460 | 0.93 | 0.24650 | 0.24731 | 0.24521 |
| — League One | 3,344 | 0.96 | 0.24343 | 0.24396 | 0.24297 |
| — League Two | 3,338 | 0.91 | 0.24750 | 0.24846 | 0.24553 |
| Rule-12 leagues, 23-month window only | 3,158 | 0.95 | 0.24570 | 0.24626 | 0.24515 |
| Rule-9 top divisions, test-only and post-tree-boundary | 5,497 | **1.06** | 0.23563 | 0.23515 | 0.23476 |
| All domestic pooled (what 2026-09-01 swept) | 25,476 | 1.02 | 0.24005 | 0.23997 | 0.23997 |

The pooled 1.02 is a compromise between two populations pulling in opposite
directions. On the three lower leagues the model is systematically
**overconfident** at 1.02 — reliability, all history:

| Predicted band (at 1.02) | n | Avg predicted | Actual win rate |
|---|---|---|---|
| 45–50% | 2,029 | 47.4% | 43.9% |
| 50–55% | 1,530 | 52.4% | 48.1% |
| 55–60% | 1,051 | 57.3% | 50.4% |
| 60–65% | 664 | 62.4% | 53.6% |
| 65–70% | 431 | 67.2% | 60.3% |
| 70–75% | 243 | 72.2% | 56.8% |

At 0.93 the same table is flat to within ~2pp through 65% (45–50%: 47.4 vs
47.4; 50–55%: 52.3 vs 50.6; 60–65%: 62.3 vs 60.6). The football reading is
plausible: the live model's trees and Platt fit were trained on top-division
data, and lower-league outcomes are noisier, so the same features deserve
less confidence there.

Two consequences, both real-money relevant and both left for decision:

1. **Kelly stakes on these leagues are currently sized off probabilities
   4–9 points too high** in the bands where most bets sit, since staking uses
   `calProb`.
2. **The edge axis of this whole grid is on a scale that overstates edge for
   these leagues.** "18% at 1.02" is roughly "13% at 0.93" for a 55% pick
   (the shift is 0.09 × modelProb). Correcting the factor per league without
   re-expressing the floor would silently tighten the rule again — the same
   trap Addendum 37 D2 documented for the 1.11 → 1.02 change.

A per-league factor would be a small change (`getCalFactorForLeague()`
branching on the rule-12 ids, mirroring the existing tournament branch), but
it moves live stakes and the effective rule, so it is a decision, not a fix
made here.

### Part F — Recommendation

**Keep 18% / 45% as the deployed rule for these three leagues for now.** On
this population it does not match the single best cell on either framing,
but it is the only cell among the highlighted three that is positive in
both periods, has every window block positive, and carries the largest
out-of-window absolute return. The best-total-return cell (12%/39%) is
rejected by the pre-window outright. The best-risk-adjusted cell (19%/50%)
is a neighbour with less volume and a weaker pre-window record; the
difference between it and 18/45 is within noise. Nothing in the 806-cell
grid supports a different combination on evidence that survives leaving the
selection window.

**The threshold question is now downstream of the calibration question.**
Before any further threshold work on these leagues, decide whether they get
their own calibration factor (~0.93 by Brier). If they do, the rule must be
re-expressed on the new scale — approximately 13%/45% to select the same
fixtures — and this grid re-run once under that factor as its own single
look. Re-tuning on the 1.02 scale first and re-calibrating second would
repeat the 2026-09-01 sequence that produced the 601 → 273 discrepancy.

**Two things this document does not do:** it does not fix the calibration
factor, and it does not lower the floor to recover the 2026-08-31 volume.
Both are open decisions in Addendum 37 Part G, now with the numbers to
decide them.

Temp endpoints `/api/admin/diag-rule12-full-grid`,
`/api/admin/diag-calfactor-recheck`, `/api/admin/diag-rule12-full-threshold-review`
and `/api/admin/diag-rule12-threshold-search` were removed after use
(commits `c9b7747`, `c3fab24`, `85ab355`).

## Addendum 40 — Dedicated calibration factor (0.93) for Championship / League One / League Two, and the single look at the corrected edge scale

2026-09-04. Follows Addendum 39 Part E and calibration-rules.md rule 17.
**One live change** (Part A, explicitly requested); everything else is
analysis and recommendation. Scoped to leagues 40/41/42 only.

### Part A — The factor is live, and scoped

**What changed (commit `36d0f94`):**

- `getCalFactorForLeague()` gained a third branch: ids 40/41/42 →
  `RULE12_CALIBRATION_FACTOR = 0.93`, mirroring the tournament branch.
  **Shared 0.93 rather than 0.93 / 0.96 / 0.91 by league:** the three
  individual optima sit inside the flat bottom of the group's Brier curve
  (0.92 → 0.24471, 0.93 → 0.24467, 0.94 → 0.24469, 0.96 → 0.24487 — spreads
  of 0.0002 at n≈3,300 per league are noise), the three are already managed
  as one rule-12 group everywhere else, and per-league values would triple
  the sharing record rule 17 asks for with no measurable gain. Constant, not
  Settings-tab exposed, same reasoning as the tournament factor.
- `POST /api/bets/:id/convert-to-real` read `settings.calibrationFactor`
  directly — a real-money Kelly path that would have sized a rule-12
  conversion at 1.02. It now goes through the helper.
- The client-side "Real: £?" preview (`previewRealStake`) read the pooled
  setting for every league with a stale 1.08 fallback. It now mirrors the
  three branches and receives the fixture's league id. Display only.
- **The paper-money gate deliberately did not move.** Every scored candidate
  now carries `edgeOnPaperRuleScale` (edge at the fixed 1.02 scale,
  `PAPER_RULE_EDGE_SCALE_FACTOR`) and `meetsPaperMoneyRule` reads that, so
  the live 18%/45% rule keeps selecting exactly the population it was
  validated on while Kelly sizing, displayed edge, EV and the historical
  scorer all use the live 0.93. Without this, the rule would have silently
  tightened to what is now measured as an 85-bet population (Part C) — the
  1.11 → 1.02 trap from Addendum 37 D2 again. Watching entries carry
  `paperRuleEdge` for audit.

**Scope check, from the live server after deploy:**

| League | Factor |
|---|---|
| Championship (40), League One (41), League Two (42) | **0.93** |
| Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Scottish Premiership, Eredivisie, Primeira Liga | 1.02 (`settings.calibrationFactor`, unchanged) |
| Champions League, Europa League, Conference League, Carabao Cup, World Cup | 1.06 (unchanged) |

Every one of the 10,142 rule-12 records' stored `calProb` equals
`min(0.97, modelProb × 0.93)` (0 mismatches); every one of the 17,668 other
domestic records equals `min(0.97, modelProb × 1.02)` (0 mismatches). The
three live read sites — `scoreOneFixture` (edge/EV/score/Kelly),
`runPreMatchScan` (lock-time Kelly) and `computeMatchedEdgeFixtures` (this
grid) — all resolve through the helper; `grep` confirms the only remaining
direct read of the setting is inside the helper itself.

**Interim gate verified unchanged:** the 18%/45% population on the fixed
1.02 scale is still 213 bets in the window (+31.5%, CI [+3.7, +59.3], abs
+67.1 — identical to Addendum 39). On the live 0.93 scale the same
"18%/45%" would select only 85 bets (+41.1%, CI [−18.9, +101.0]).

### Part B — Population and discipline

Identical to Addendum 39: window 2024-09-16 → 2026-08-17 (n=3,158),
pre-window 2020-06-18 → 2024-09-15 (n=6,984), rule-12 pre-cutoff fixtures
with Pinnacle closing odds, scoring model 2026-08-08 (these leagues were
never in its training). Same 806-cell grid (edge 5–30% × probability
35–65%), same two pre-registered picks (max absolute return at n≥30; max
95% CI lower bound at n≥100) chosen on the window and shown with pre-window
figures. **This is the single look at the corrected scale.** Thin cells
(n<30) marked \*. Full grid: `docs/addendum-40-rule12-grid-corrected.csv`.

### Part C — The grid at 0.93 (n / ROI / absolute return)

**C1. Window, edge floor × probability floor:**

| Edge ≥ | prob ≥35% | prob ≥40% | prob ≥45% | prob ≥50% | prob ≥55% | prob ≥60% | prob ≥65% |
|---|---|---|---|---|---|---|---|
| 5% | 945 / +4.6% / +43.1 | 808 / +8.9% / +72.1 | 617 / +12.8% / +78.9 | 457 / +13.2% / +60.5 | 302 / +7.8% / +23.5 | 191 / +7.1% / +13.5 | 105 / +14.2% / +14.9 |
| 6% | 837 / +5.5% / +45.7 | 717 / +9.9% / +70.6 | 555 / +13.8% / +76.5 | 412 / +16% / +65.9 | 275 / +10.5% / +28.9 | 175 / +9% / +15.8 | 97 / +17% / +16.5 |
| 7% | 741 / +8.7% / +64.4 | 643 / +13.1% / +84 | 508 / +16.4% / +83.5 | 384 / +16% / +61.4 | 261 / +11.4% / +29.7 | 164 / +8.3% / +13.7 | 90 / +13.7% / +12.3 |
| 8% | 641 / +12.7% / +81.3 | 557 / +16.8% / +93.6 | 453 / +19% / +85.9 | 345 / +19.1% / +66 | 236 / +13.4% / +31.6 | 146 / +7.4% / +10.8 | 80 / +13.6% / +10.8 |
| 9% | 552 / +11.4% / +62.7 | 485 / +14.2% / +68.9 | 396 / +17.2% / +68.2 | 307 / +16.6% / +51.1 | 214 / +11.5% / +24.6 | 135 / +4.1% / +5.5 | 77 / +11.8% / +9.1 |
| 10% | 471 / +14.6% / +68.9 | 421 / +20% / +84.1 | 347 / +24.4% / +84.7 | 273 / +21.3% / +58.1 | 190 / +14.8% / +28.2 | 122 / +9.1% / +11.1 | 71 / +16.3% / +11.6 |
| 11% | 387 / +17.4% / +67.3 | 345 / +22.7% / +78.5 | 297 / +28.2% / +83.7 | 240 / +23.9% / +57.4 | 168 / +18.3% / +30.7 | 111 / +8.5% / +9.4 | 63 / +20.7% / +13 |
| 12% | 325 / +17.5% / +56.9 | 292 / +22.9% / +66.9 | 254 / +27.2% / +69.1 | 208 / +22.6% / +46.9 | 146 / +17.7% / +25.8 | 98 / +7.3% / +7.1 | 58 / +19.2% / +11.1 |
| 13% | 264 / +20.8% / +55 | 238 / +26.2% / +62.4 | 209 / +31.8% / +66.5 | 176 / +25.3% / +44.5 | 124 / +21.6% / +26.8 | 89 / +7.9% / +7 | 53 / +17.3% / +9.2 |
| 14% | 213 / +20.9% / +44.5 | 197 / +26% / +51.2 | 175 / +31.6% / +55.3 | 154 / +26% / +40 | 109 / +21.7% / +23.6 | 79 / +1.8% / +1.4 | 46 / +11% / +5.1 |
| 15% | 173 / +22.5% / +38.9 | 161 / +28.5% / +45.8 | 143 / +35% / +50.1 | 129 / +29.1% / +37.6 | 96 / +26.4% / +25.4 | 71 / +11% / +7.8 | 42 / +17.7% / +7.4 |
| 16% | 142 / +25.1% / +35.6 | 132 / +30.7% / +40.5 | 116 / +36.9% / +42.8 | 105 / +29.3% / +30.8 | 81 / +24.7% / +20 | 63 / +9.3% / +5.8 | 37 / +19.1% / +7.1 |
| 17% | 113 / +32.4% / +36.6 | 108 / +33.9% / +36.6 | 98 / +37.6% / +36.9 | 87 / +28.6% / +24.9 | 68 / +28.7% / +19.5 | 53 / +9.2% / +4.9 | 33 / +22.1% / +7.3 |
| 18% | 93 / +34.7% / +32.2 | 90 / +39.2% / +35.2 | 85 / +41.1% / +34.9 | 77 / +25.8% / +19.9 | 61 / +29.5% / +18 | 49 / +6.5% / +3.2 | 31 / +17.1% / +5.3 |
| 19% | 69 / +43.8% / +30.2 | 67 / +48.1% / +32.2 | 63 / +49% / +30.9 | 57 / +24.4% / +13.9 | 47 / +36.4% / +17.1 | 35 / +6.6% / +2.3 | 24 / +9.3% / +2.2 \* |
| 20% | 54 / +74% / +40 | 54 / +74% / +40 | 51 / +73.8% / +37.6 | 48 / +36.7% / +17.6 | 39 / +50.9% / +19.9 | 28 / +14.5% / +4 \* | 19 / +23.2% / +4.4 \* |
| 21% | 43 / +82.9% / +35.7 | 43 / +82.9% / +35.7 | 40 / +83.3% / +33.3 | 38 / +32.4% / +12.3 | 32 / +57.2% / +18.3 | 22 / +22.8% / +5 \* | 15 / +40.4% / +6.1 \* |
| 22% | 35 / +110.2% / +38.6 | 35 / +110.2% / +38.6 | 32 / +113.2% / +36.2 | 30 / +50.8% / +15.2 | 26 / +74% / +19.2 \* | 18 / +38.4% / +6.9 \* | 13 / +45.8% / +5.9 \* |
| 23% | 29 / +108.9% / +31.6 \* | 29 / +108.9% / +31.6 \* | 28 / +116.4% / +32.6 \* | 27 / +39.2% / +10.6 \* | 23 / +63.4% / +14.6 \* | 17 / +46.5% / +7.9 \* | 13 / +45.8% / +5.9 \* |
| 24% | 23 / +154.9% / +35.6 \* | 23 / +154.9% / +35.6 \* | 23 / +154.9% / +35.6 \* | 22 / +61.9% / +13.6 \* | 19 / +87.5% / +16.6 \* | 14 / +63.9% / +8.9 \* | 11 / +54.4% / +6 \* |
| 25% | 19 / +175.8% / +33.4 \* | 19 / +175.8% / +33.4 \* | 19 / +175.8% / +33.4 \* | 18 / +63.3% / +11.4 \* | 16 / +83.7% / +13.4 \* | 13 / +53.8% / +7 \* | 11 / +54.4% / +6 \* |
| 26% | 18 / +159.7% / +28.8 \* | 18 / +159.7% / +28.8 \* | 18 / +159.7% / +28.8 \* | 17 / +39.7% / +6.7 \* | 15 / +58.3% / +8.8 \* | 13 / +53.8% / +7 \* | 11 / +54.4% / +6 \* |
| 27% | 14 / +196.2% / +27.5 \* | 14 / +196.2% / +27.5 \* | 14 / +196.2% / +27.5 \* | 13 / +42.1% / +5.5 \* | 12 / +53.9% / +6.5 \* | 11 / +67.9% / +7.5 \* | 10 / +54.5% / +5.4 \* |
| 28% | 9 / +258.6% / +23.3 \* | 9 / +258.6% / +23.3 \* | 9 / +258.6% / +23.3 \* | 8 / +15.9% / +1.3 \* | 8 / +15.9% / +1.3 \* | 7 / +32.4% / +2.3 \* | 7 / +32.4% / +2.3 \* |
| 29% | 7 / +361% / +25.3 \* | 7 / +361% / +25.3 \* | 7 / +361% / +25.3 \* | 6 / +54.5% / +3.3 \* | 6 / +54.5% / +3.3 \* | 5 / +85.4% / +4.3 \* | 5 / +85.4% / +4.3 \* |
| 30% | 7 / +361% / +25.3 \* | 7 / +361% / +25.3 \* | 7 / +361% / +25.3 \* | 6 / +54.5% / +3.3 \* | 6 / +54.5% / +3.3 \* | 5 / +85.4% / +4.3 \* | 5 / +85.4% / +4.3 \* |

**C2. Pre-window, same cells:**

| Edge ≥ | prob ≥35% | prob ≥40% | prob ≥45% | prob ≥50% | prob ≥55% | prob ≥60% | prob ≥65% |
|---|---|---|---|---|---|---|---|
| 5% | 2241 / -1.4% / -31.6 | 1929 / -3.1% / -60 | 1509 / -2.2% / -32.8 | 1094 / -3.7% / -40.6 | 727 / +3% / +22.1 | 478 / -3.8% / -18.4 | 269 / -7.7% / -20.6 |
| 6% | 1970 / -2.4% / -47 | 1716 / -3.4% / -57.6 | 1358 / -2.2% / -30.5 | 996 / -3.3% / -33.3 | 673 / +2.5% / +16.9 | 441 / -4.1% / -18.1 | 249 / -6.1% / -15.3 |
| 7% | 1704 / -3.1% / -53.6 | 1503 / -3.6% / -53.7 | 1219 / -2.1% / -25.9 | 902 / -2.7% / -24.7 | 620 / +3.5% / +21.7 | 403 / -3.4% / -13.8 | 225 / -6.9% / -15.5 |
| 8% | 1461 / -4% / -58.7 | 1305 / -5% / -65.2 | 1084 / -2.1% / -22.9 | 815 / -4% / -32.7 | 564 / +2.8% / +15.5 | 366 / -3.1% / -11.3 | 202 / -6.8% / -13.8 |
| 9% | 1234 / -5% / -62.3 | 1112 / -5% / -55.8 | 942 / -2% / -18.4 | 725 / -4.3% / -31.1 | 500 / +2.5% / +12.4 | 334 / -4.8% / -16.1 | 188 / -8% / -15 |
| 10% | 1026 / -3.2% / -33.1 | 923 / -2.9% / -27 | 797 / -0.1% / -1 | 625 / -2.9% / -17.8 | 446 / +4.7% / +21.2 | 296 / -2% / -5.8 | 161 / -6% / -9.7 |
| 11% | 866 / -3.4% / -29.7 | 789 / -2.8% / -22.4 | 685 / +0.7% / +4.9 | 549 / -1.8% / -10 | 395 / +6.6% / +26.1 | 264 / -0.6% / -1.7 | 142 / -7.3% / -10.4 |
| 12% | 694 / -1.2% / -8.1 | 634 / +0.3% / +2 | 559 / +4.3% / +23.9 | 458 / +2.9% / +13.2 | 337 / +7.9% / +26.6 | 226 / +2.2% / +4.9 | 124 / -4.1% / -5 |
| 13% | 594 / +2.1% / +12.7 | 548 / +3.1% / +17.1 | 490 / +7.4% / +36.2 | 406 / +2.9% / +11.7 | 303 / +8.5% / +25.9 | 207 / +0.6% / +1.2 | 115 / -5.1% / -5.8 |
| 14% | 486 / +3.8% / +18.3 | 455 / +3.7% / +16.7 | 414 / +10.2% / +42.1 | 345 / +6.8% / +23.6 | 256 / +13.5% / +34.7 | 179 / +6.9% / +12.3 | 97 / -0.4% / -0.3 |
| 15% | 391 / +6.2% / +24.3 | 369 / +6.2% / +23 | 345 / +12.4% / +42.9 | 290 / +10.4% / +30 | 217 / +19.4% / +42.1 | 152 / +14.8% / +22.5 | 82 / +8.7% / +7.1 |
| 16% | 334 / +10.3% / +34.5 | 318 / +8.6% / +27.2 | 297 / +14.8% / +44.1 | 256 / +12.2% / +31.2 | 196 / +21.6% / +42.2 | 141 / +16.1% / +22.6 | 77 / +10.6% / +8.2 |
| 17% | 274 / +7.9% / +21.5 | 262 / +5.9% / +15.4 | 251 / +10.5% / +26.4 | 220 / +12.1% / +26.6 | 173 / +25.5% / +44.2 | 127 / +18.4% / +23.4 | 69 / +14.7% / +10.1 |
| 18% | 222 / +9.1% / +20.2 | 215 / +6.6% / +14.2 | 208 / +10.2% / +21.3 | 189 / +12.4% / +23.4 | 149 / +24.8% / +37 | 109 / +14.4% / +15.7 | 57 / +10.7% / +6.1 |
| 19% | 188 / +14.6% / +27.5 | 181 / +12% / +21.6 | 178 / +13.8% / +24.6 | 161 / +15.4% / +24.8 | 126 / +29.1% / +36.6 | 94 / +16.8% / +15.8 | 49 / +8% / +3.9 |
| 20% | 147 / +21.4% / +31.4 | 144 / +19.1% / +27.5 | 141 / +21.6% / +30.5 | 132 / +23.2% / +30.6 | 108 / +37.9% / +40.9 | 82 / +20.6% / +16.9 | 40 / +11.2% / +4.5 |
| 21% | 118 / +16.3% / +19.3 | 115 / +13.4% / +15.4 | 112 / +16.4% / +18.4 | 106 / +18.7% / +19.8 | 90 / +32% / +28.8 | 69 / +21.9% / +15.1 | 32 / +7.2% / +2.3 |
| 22% | 99 / +23.4% / +23.1 | 97 / +18.8% / +18.2 | 95 / +21.3% / +20.2 | 91 / +26.6% / +24.2 | 79 / +41.3% / +32.6 | 62 / +24.1% / +14.9 | 31 / +5% / +1.6 |
| 23% | 85 / +15.6% / +13.3 | 84 / +17% / +14.3 | 82 / +19.9% / +16.3 | 78 / +26% / +20.3 | 69 / +37.2% / +25.6 | 56 / +24.1% / +13.5 | 27 / -7% / -1.9 \* |
| 24% | 68 / +28.8% / +19.6 | 67 / +30.7% / +20.6 | 66 / +32.7% / +21.6 | 64 / +36.8% / +23.6 | 57 / +47.2% / +26.9 | 46 / +27.8% / +12.8 | 24 / -4.3% / -1 \* |
| 25% | 53 / +18.1% / +9.6 | 52 / +20.4% / +10.6 | 52 / +20.4% / +10.6 | 51 / +22.8% / +11.6 | 46 / +36.1% / +16.6 | 37 / +30.4% / +11.3 | 21 / +9.4% / +2 \* |
| 26% | 44 / +22.8% / +10 | 43 / +25.7% / +11 | 43 / +25.7% / +11 | 42 / +28.7% / +12 | 39 / +38.6% / +15 | 32 / +43.1% / +13.8 | 18 / +13.9% / +2.5 \* |
| 27% | 36 / +17.6% / +6.3 | 36 / +17.6% / +6.3 | 36 / +17.6% / +6.3 | 35 / +20.9% / +7.3 | 33 / +28.3% / +9.3 | 28 / +51.2% / +14.3 \* | 16 / +6.5% / +1 \* |
| 28% | 25 / +39.6% / +9.9 \* | 25 / +39.6% / +9.9 \* | 25 / +39.6% / +9.9 \* | 24 / +45.5% / +10.9 \* | 24 / +45.5% / +10.9 \* | 20 / +74.6% / +14.9 \* | 12 / +21.7% / +2.6 \* |
| 29% | 24 / +45.5% / +10.9 \* | 24 / +45.5% / +10.9 \* | 24 / +45.5% / +10.9 \* | 23 / +51.8% / +11.9 \* | 23 / +51.8% / +11.9 \* | 20 / +74.6% / +14.9 \* | 12 / +21.7% / +2.6 \* |
| 30% | 19 / +34.9% / +6.6 \* | 19 / +34.9% / +6.6 \* | 19 / +34.9% / +6.6 \* | 18 / +42.4% / +7.6 \* | 18 / +42.4% / +7.6 \* | 17 / +50.8% / +8.6 \* | 11 / +32.7% / +3.6 \* |

**C3. Window, 1% probability steps at selected edge floors:**

| Prob ≥ | edge ≥5% | edge ≥8% | edge ≥10% | edge ≥11% | edge ≥13% | edge ≥15% | edge ≥18% |
|---|---|---|---|---|---|---|---|
| 35% | 945 / +4.6% / +43.1 | 641 / +12.7% / +81.3 | 471 / +14.6% / +68.9 | 387 / +17.4% / +67.3 | 264 / +20.8% / +55 | 173 / +22.5% / +38.9 | 93 / +34.7% / +32.2 |
| 36% | 941 / +4.6% / +43.6 | 641 / +12.7% / +81.3 | 471 / +14.6% / +68.9 | 387 / +17.4% / +67.3 | 264 / +20.8% / +55 | 173 / +22.5% / +38.9 | 93 / +34.7% / +32.2 |
| 37% | 920 / +5.1% / +47 | 630 / +11.9% / +74.7 | 465 / +13.2% / +61.2 | 381 / +15.6% / +59.6 | 260 / +19.1% / +49.6 | 172 / +23.2% / +39.9 | 93 / +34.7% / +32.2 |
| 38% | 886 / +5.5% / +48.8 | 606 / +13.2% / +79.8 | 452 / +15.5% / +70.2 | 369 / +19.4% / +71.6 | 251 / +23.4% / +58.6 | 166 / +27.6% / +45.9 | 91 / +37.6% / +34.2 |
| 39% | 836 / +8% / +66.8 | 573 / +16.4% / +93.9 | 429 / +19.9% / +85.3 | 351 / +23.3% / +81.7 | 243 / +27.4% / +66.6 | 163 / +30% / +48.9 | 90 / +39.2% / +35.2 |
| 40% | 808 / +8.9% / +72.1 | 557 / +16.8% / +93.6 | 421 / +20% / +84.1 | 345 / +22.7% / +78.5 | 238 / +26.2% / +62.4 | 161 / +28.5% / +45.8 | 90 / +39.2% / +35.2 |
| 41% | 765 / +8.4% / +64.6 | 535 / +15% / +80.3 | 406 / +19% / +77.3 | 338 / +23% / +77.6 | 235 / +26.1% / +61.2 | 159 / +30.1% / +47.8 | 90 / +39.2% / +35.2 |
| 42% | 721 / +10.1% / +72.5 | 507 / +16.6% / +84.3 | 387 / +21.2% / +82 | 327 / +24.9% / +81.3 | 228 / +29.9% / +68.2 | 157 / +31.8% / +49.8 | 88 / +42.3% / +37.2 |
| 43% | 700 / +11.4% / +79.6 | 496 / +17.6% / +87.3 | 378 / +21.9% / +83 | 321 / +24.7% / +79.2 | 224 / +28.7% / +64.2 | 155 / +30.6% / +47.4 | 88 / +42.3% / +37.2 |
| 44% | 652 / +11.2% / +73.3 | 473 / +16.6% / +78.5 | 361 / +21.4% / +77.3 | 309 / +24.3% / +75 | 216 / +29.1% / +62.8 | 148 / +30.4% / +45.1 | 86 / +39.4% / +33.9 |
| 45% | 617 / +12.8% / +78.9 | 453 / +19% / +85.9 | 347 / +24.4% / +84.7 | 297 / +28.2% / +83.7 | 209 / +31.8% / +66.5 | 143 / +35% / +50.1 | 85 / +41.1% / +34.9 |
| 46% | 586 / +8.7% / +51.1 | 433 / +14.6% / +63.1 | 333 / +17.7% / +58.8 | 288 / +20.4% / +58.8 | 204 / +22.1% / +45.1 | 141 / +20.6% / +29.1 | 84 / +15.4% / +12.9 |
| 47% | 548 / +8.2% / +45 | 404 / +13.7% / +55.3 | 316 / +14.9% / +47.2 | 275 / +17.8% / +49.1 | 197 / +18% / +35.5 | 139 / +19.8% / +27.6 | 83 / +16.7% / +13.9 |
| 48% | 517 / +11.5% / +59.6 | 385 / +16.4% / +63 | 302 / +18.3% / +55.4 | 263 / +21% / +55.2 | 189 / +23% / +43.5 | 134 / +24.3% / +32.6 | 81 / +19.6% / +15.9 |
| 49% | 488 / +12.5% / +61.1 | 364 / +17.6% / +64 | 287 / +20.4% / +58.5 | 250 / +23.6% / +59.1 | 183 / +25.4% / +46.5 | 132 / +26.2% / +34.6 | 80 / +21.1% / +16.9 |
| 50% | 457 / +13.2% / +60.5 | 345 / +19.1% / +66 | 273 / +21.3% / +58.1 | 240 / +23.9% / +57.4 | 176 / +25.3% / +44.5 | 129 / +29.1% / +37.6 | 77 / +25.8% / +19.9 |
| 51% | 427 / +7.6% / +32.5 | 325 / +13.5% / +43.8 | 255 / +13.3% / +33.9 | 225 / +14.6% / +32.8 | 165 / +16.4% / +27 | 122 / +24.2% / +29.5 | 73 / +23% / +16.8 |
| 52% | 388 / +6.7% / +26.1 | 296 / +13.8% / +41 | 237 / +12.2% / +28.8 | 207 / +13.4% / +27.7 | 153 / +15.6% / +23.8 | 116 / +22.4% / +26 | 71 / +21.8% / +15.5 |
| 53% | 359 / +6.2% / +22.2 | 280 / +11.5% / +32.3 | 226 / +12% / +27.1 | 196 / +13.3% / +26.1 | 144 / +15.8% / +22.7 | 110 / +22.4% / +24.6 | 68 / +27.1% / +18.5 |
| 54% | 329 / +6.4% / +20.9 | 255 / +12% / +30.5 | 205 / +12.4% / +25.4 | 179 / +15.5% / +27.7 | 131 / +17.5% / +22.9 | 103 / +20.9% / +21.5 | 65 / +26.3% / +17.1 |
| 55% | 302 / +7.8% / +23.5 | 236 / +13.4% / +31.6 | 190 / +14.8% / +28.2 | 168 / +18.3% / +30.7 | 124 / +21.6% / +26.8 | 96 / +26.4% / +25.4 | 61 / +29.5% / +18 |
| 56% | 281 / +6.6% / +18.5 | 220 / +10.8% / +23.8 | 176 / +10.4% / +18.4 | 155 / +14.3% / +22.2 | 115 / +18.7% / +21.5 | 90 / +21.9% / +19.7 | 59 / +27.5% / +16.3 |
| 57% | 259 / +4.1% / +10.7 | 201 / +7.5% / +15 | 164 / +7% / +11.4 | 145 / +10.7% / +15.5 | 108 / +17.6% / +19 | 85 / +17.9% / +15.2 | 56 / +22.4% / +12.5 |
| 58% | 233 / +6.1% / +14.1 | 180 / +8.6% / +15.5 | 149 / +9.8% / +14.5 | 132 / +14.3% / +18.9 | 101 / +20.9% / +21.1 | 80 / +22.1% / +17.7 | 55 / +24.6% / +13.5 |
| 59% | 205 / +7.5% / +15.4 | 155 / +10.2% / +15.8 | 126 / +11.8% / +14.9 | 115 / +11.5% / +13.2 | 90 / +13% / +11.7 | 72 / +17.3% / +12.4 | 50 / +15.7% / +7.8 |
| 60% | 191 / +7.1% / +13.5 | 146 / +7.4% / +10.8 | 122 / +9.1% / +11.1 | 111 / +8.5% / +9.4 | 89 / +7.9% / +7 | 71 / +11% / +7.8 | 49 / +6.5% / +3.2 |
| 61% | 169 / +8% / +13.5 | 128 / +8.2% / +10.6 | 106 / +10.3% / +10.9 | 96 / +10.7% / +10.3 | 79 / +6.3% / +5 | 65 / +9.7% / +6.3 | 46 / +7.6% / +3.5 |
| 62% | 149 / +8% / +12 | 114 / +6% / +6.9 | 95 / +8.6% / +8.2 | 86 / +10.1% / +8.7 | 72 / +9.3% / +6.7 | 59 / +11.9% / +7 | 42 / +10.9% / +4.6 |
| 63% | 131 / +12% / +15.7 | 101 / +11.1% / +11.3 | 84 / +12.6% / +10.6 | 75 / +14.8% / +11.1 | 64 / +12.8% / +8.2 | 53 / +12.2% / +6.5 | 39 / +13.1% / +5.1 |
| 64% | 118 / +11.1% / +13.1 | 90 / +9.4% / +8.4 | 77 / +9.8% / +7.5 | 68 / +11.8% / +8 | 57 / +9.1% / +5.2 | 46 / +7.5% / +3.4 | 33 / +10% / +3.3 |
| 65% | 105 / +14.2% / +14.9 | 80 / +13.6% / +10.8 | 71 / +16.3% / +11.6 | 63 / +20.7% / +13 | 53 / +17.3% / +9.2 | 42 / +17.7% / +7.4 | 31 / +17.1% / +5.3 |

Reading it against Addendum 39's grid at 1.02: the whole surface has shifted
about five edge points to the left, as the arithmetic predicts (the factor
change lowers every edge by 0.09 × modelProb). What was the 18% row is now
roughly the 13% row; the 40–45% probability column still drags; the
pre-window is still negative below about 12% edge and only weakly positive
above it; above ~22% edge everything is thin.

### Part D — Highlighted cells and the re-expressed rule

**D1. Where the interim rule's fixtures landed on the new scale.** The
live-scale cell whose population best matches the 213 interim-rule bets is
**13% / 45%** — 209 bets, 203 of them shared (Jaccard 0.93). So "18% at
1.02" is "13% at 0.93" on this population, measured rather than estimated.

| Cell | Window | Pre-window |
|---|---|---|
| Interim rule as deployed: 18% / 45% at 1.02 (Addendum 39) | 213, +31.5%, CI [+3.7, +59.3], abs +67.1, blocks +9.1 / +49.4 / +57.6 / +0.2 | 498, +6.2%, CI [−7.1, +19.6], abs +31.0, blocks −12.7 / −2.5 / +17.7 / +31.5 |
| **Re-expressed: 13% / 45% at 0.93** | **209, +31.8%, CI [+3.4, +60.2], abs +66.5** | **490, +7.4%, CI [−6.4, +21.1], abs +36.2** |
| Neighbours at 0.93: 12% / 45% | 254, +27.2%, CI [+2.9, +51.5], abs +69.1 | 559, +4.3%, CI [−8.2, +16.8], abs +23.9 |
| 14% / 45% | 175, +31.6%, CI [−1.2, +64.4], abs +55.3 | 414, +10.2%, CI [−5.1, +25.4], abs +42.1 |
| 15% / 45% | 143, +35.0%, CI [−3.5, +73.5], abs +50.1 | 345, +12.4%, CI [−4.8, +29.6], abs +42.9 |

**D2. The two pre-registered picks:**

| Cell | Window | Window blocks | Pre-window | Verdict |
|---|---|---|---|---|
| Best total absolute return: 8% / 39% | 573, +16.4%, CI [+2.7, +30.1], abs **+93.9** | −5.4 / +41.9 / +23.5 / +3.6 | 1,348, **−5.3%**, CI [−12.7, +2.1], abs **−71.5**, blocks −11.7 / −12.1 / +3.1 / +1.3 | Same verdict as Addendum 39's 12%/39%: the broad population, which loses out-of-window. Not supportable. |
| Best risk-adjusted: 11% / 45% | 297, +28.2%, CI [**+6.7**, +49.6], abs +83.7 | +6.0 / +48.2 / +50.6 / +2.2 | 685, +0.7%, CI [−10.2, +11.6], abs +4.9, blocks −17.1 / −7.7 / +10.5 / +23.7 | Strongest in-window cell by CI lower bound, every window block positive, 42% more volume than 13/45 — but flat out-of-window, with two negative pre-window blocks. |

Top-10 by absolute return: all edge 7–11% / probability 39–45%. Top-10 by
CI lower bound: all edge 8–13% / probability 45–50%, led by 11/45.

### Part E — Recommendation (the definitive threshold for these three leagues)

**Adopt 13% edge / 45% probability on the 0.93 scale as the rule for
Championship, League One and League Two.** This is the faithful
re-expression of the validated rule, not a new one: it selects the same
fixtures (203 of 209 in common), reproduces the validated window figures
(+31.8% on 209 vs +31.5% on 213), and its out-of-window record is the best
of any candidate cell (pre-window +7.4%, abs +36.2, against +6.2% / +31.0 for
the incumbent as deployed). It differs from "18%/45%" only in the number
written down, and that number must change because the scale it is written
on has changed — rule 17's fourth requirement.

**Is anything meaningfully better?** One cell is a genuine candidate:
11% / 45%. In the window it beats 13/45 on every axis that matters — CI
lower bound +6.7 vs +3.4, absolute return +83.7 vs +66.5, all four blocks
positive, 297 bets vs 209. Out of the window it is flat: +0.7% on 685
fixtures, absolute return +4.9. It is a pre-registered pick, so reporting it
is legitimate; recommending it would mean adopting a cell whose only support
is the selection window, which is exactly what calibration-rules.md rules 3
and 4 exist to prevent. **Not recommended now.** It is the natural widening
candidate, and it can be adjudicated on evidence rather than on this window:
every 11–13% fixture is already logged in the observation tier at no stake,
so the live no-stake record between the two floors accumulates on its own.
Proposed trigger, fixed here: widen to 11% if that between-floors
observation population reaches n ≥ 100 with a 95% CI lower bound above zero,
evaluated once, per rule 3.

**What adopting 13%/45% means mechanically** (not done here — needs the
go-ahead): set the rule-12 edge floor to 0.13 and let the gate read the live
edge for these leagues, retiring `PAPER_RULE_EDGE_SCALE_FACTOR` for them.
The 8 top divisions are on the observation tier per Addendum 38, so the 18%
floor at 1.02 becomes moot for stake purposes, but it must stay defined for
their observation logging and any future re-entry. One constant, one
condition, the UI strings, and a re-verification that the Scout tab's
paper-money counters match a live scan.

**What this does not change:** the eight top divisions (Addendum 38), the
tournament factor, the pooled 1.02 for the top divisions (their own Brier
optimum is 1.06, Addendum 39 Part E — a separate rule-17 decision), and the
Addendum 37 Part G open items.

Temp endpoint `/api/admin/diag-rule12-grid-corrected` removed after use in
commit `c2ef550`; confirmed live via a logged-in 404 check at 2026-09-04
15:03 UTC.
