# July Model Upgrade Notes

## 1. Structural 50–60% calibration bias

**Finding date:** 2026-06-21  
**Status:** Known limitation, not yet addressed

### What we observed

After correcting all three frozen factors (momentum, standings, injuries) and re-scoring all 8,305 historical fixtures, the calibration bands are:

| Band | n | Avg pred | Actual | Bias |
|------|---|----------|--------|------|
| <40% | 2,811 | 37.6% | 42.7% | +5.1pp |
| 40–50% | 4,119 | 44.2% | 51.2% | +7.0pp |
| **50–60%** | **1,207** | **53.8%** | **66.0%** | **+12.1pp** |
| 60–70% | 168 | 63.0% | 72.0% | +9.0pp |

The calibration factor of 1.11 brings the <40%, 40–50%, and 60–70% bands to within ~1–2pp of actual. The 50–60% band retains ~6pp residual bias even after applying the factor.

### Why it persists

The 50–60% bias is **structural to the linear weighted-sum methodology**, not a data quality issue. Evidence:

- Bias was present before and after factor corrections (bands unchanged by rescore)
- Increasing the calibration factor to close the 50–60% gap (would need ~1.225) overcorrects all other bands
- The 50–60% band is where the model places moderate-favourite fixtures. These fixtures have more genuine signal than the model's linear combination captures — the model under-commits to favourites in this range

### Implication for July upgrade

This is the primary motivation for moving to a **non-linear model** (e.g. gradient-boosted scoring, logistic regression on factor outputs, or Platt scaling per band). A single multiplicative calibration factor cannot fix non-uniform bias across confidence bands.

**Recommended approach:** Platt scaling per probability band, or train a lightweight isotonic regression layer on top of the existing factor scores. This would be a post-scoring calibration step, not a replacement of the factor pipeline.

**Priority:** High. The 50–60% band covers 14.5% of all fixtures (1,207/8,305) and has the worst calibration. These are exactly the fixtures where edge detection matters most for betting — if the model says 55% and the true probability is 66%, we are systematically underestimating value on moderate favourites.

---

## 2. WOWY selection bias heuristic (implemented 2026-06-21)

Added `selectionBias` flag to `getWOWYDeltas()` in `teamProfiles.js`. Triggered when:
- `withoutRate > 85%` AND `woTotal < 15` AND delta is negative (player appears to hurt the team)

Rationale: players rested only in already-won or low-risk fixtures inflate the "without" win rate. Classic examples from WC 2026 squad analysis:

- **Rodri** (Man City): -22.9pp, withoutRate=100%/5 games — almost certainly rested in comfortable wins
- **K. Walker** (Man City): -35.9pp, withoutRate=92%/13 games — small sample, likely similar pattern

The flag is surfaced in `teamIntel.keyPlayers` display and gates the WOWY probability modifier — flagged players do not apply a negative dependency adjustment to live scoring.

---

## 3. WOWY modifier implementation status (as of 2026-06-22)

**Status: LIVE** — implemented in `applyTeamProfileModifiers()` in commit `99ad1eb`, shipped 2026-06-22.

The modifier fires when `wowyActive=true` (now the default) and confirmed lineups are available (T-60 or later). Logic:

1. For each team (home/away), fetch high-confidence WOWY deltas (`confidence='high'`, `!selectionBias`)
2. Cross-reference against `confirmedAbsent` on the profile (populated in `scoreOneFixture()` from `lineups.json`)
3. For each absent player with `|delta| >= 0.10`: apply `delta × 0.3`, capped at ±5pp per player
4. Total cap: ±8pp per team
5. Never fires on `selectionBias: true` players

**Corrected WC squad WOWY figures** (pending lineup rebuild — current API quota used 2026-06-22):
- Højbjerg (Denmark): predicted ~-21pp post-rebuild (was -50.8pp artifact from missing 2022/23 data)
- Rodri (Spain): -22.9pp flagged `selectionBias: true` — not a reliable signal
- Walker (England): -35.9pp flagged `selectionBias: true` — not a reliable signal
- Yıldız (Turkey): +52.6pp HIGH confidence — genuine signal, small club sample
- Alexander-Arnold (England): +45.7pp HIGH confidence — 53 with / 9 without, strongest large-sample signal
- Saka (England): +25.5pp HIGH confidence — 55 with / 5 without

---

## 4. International factor weight calibration (Option B — July upgrade)

**Finding date:** 2026-06-23  
**Status:** Known limitation, documented — not addressed in current codebase

### What was attempted

Four adjustments were implemented to reduce model–market gap on WC 2026 group stage fixtures:

1. `dataConf` cap at 0.70 for international context — anchor always contributes ≥30% weight  
2. `rankScale` raised from 0.010 → 0.018 in `CONTEXT_CONFIG.international`  
3. Neutral venue base probs lowered to 0.34/0.34 for `group_stage` and `knockout` (was 0.30/0.45)  
4. Host nation +8pp boost for USA/Canada/Mexico at WC 2026

### Results (diagnostic on 5 June 16-19 fixtures)

| Fixture | Gap before | Gap after |
|---|---|---|
| France vs Senegal | +15.7pp | +23.3pp ✗ |
| England vs Croatia | +9.7pp | +14.4pp ✗ |
| Ghana vs Panama | +9.5pp | +3.5pp ✓ |
| Scotland vs Morocco | +10.8pp | −6.1pp ✓ |
| USA vs Australia | +24.1pp | +17.4pp ✓ |
| **Average** | **14.0pp** | **12.9pp** |

### Root cause of residual gap

The international historical pool (Nations League, qualifying, continental tournaments) does not distinguish performance quality by opponent strength. Senegal (FIFA rank 18) scores form=85/def=84 in the pool due to dominance in AFCON and CONCACAF qualifiers against weaker opposition — this inflates their form signal relative to WC group stage relevance. At 70% form weight, the model underestimates strong European/South American sides against well-formed African/Asian opponents.

France vs Senegal: model outputs 48% vs 71.4% market implied. The model is reading real data (France's defense=48 from Nations League concessions is genuine), but that signal applies differently at WC group stage.

England vs Croatia: model 46.2% vs 60.6% implied. The 38-point form advantage (83 vs 45) doesn't translate to 60%+ under current international factor weights — those weights were designed for club football where a 38-point form gap is a much stronger predictor.

### What July needs

- **Calibrate international factor weights** against WC 2022 and Euros 2020/2024 results. Current weights (`WEIGHTS_BY_CONTEXT.international`) were inherited from club context and produce near-50/50 outputs even for large quality gaps at full data confidence.
- **Opponent-weighted form score** for international pool: discount form points earned against teams ranked > 60 by a factor proportional to opponent quality. This stops Senegal's AFCON record inflating their WC group stage form score.
- **Platt scaling per competition phase**: separate calibration factors for `group_stage` vs `league_mid` — the current 1.11 factor was derived from club league data and may not apply to tournament football.

The four structural fixes (dataConf cap, rankScale, neutral venue base, host boost) are implemented and directionally correct. The residual gap is not a bug in those fixes — it is the underlying weight calibration problem that requires tournament result training data to solve properly.

### Specific fix for France/England gap — confederation strength adjustment

Build an **opponent-quality-weighted form score** for the international pool:

- For each result in a team's form history, compute the FIFA ranking quality of the opponent (using `rankToQuality`)
- Scale the points contribution by `opponentQuality / 100` — so a win against a rank-1 team counts fully, a win against a rank-100 team counts at 5%
- Replace `formScore()` with `weightedFormScore()` for international context

This directly addresses the Senegal problem: Senegal's form=85 is built on AFCON qualifying wins against opponents ranked 60-120. Weighted by opponent quality, their score drops significantly. France's form=65 from Nations League A (vs Netherlands rank 8, Germany rank 10, Portugal rank 6) would barely change. The quality-weighted scores will reflect tournament-level form rather than confederation-level dominance.

Implementation: add `opponentQualityWeight` parameter to `formScore` in `scoring.js`, pass `true` when `context === 'international'`. Requires building a team-id → FIFA rank index from `FIFA_RANK_FALLBACK` during scoring.

---

## 5. Systematic underdog bias — WC 2026 knockout round (documented 2026-06-30)

**Finding date:** 2026-06-30  
**Status:** Documented. No code changes. Full investigation deferred to July upgrade.

### The Pattern

7 of 7 tracked WC 2026 fixtures had the model's top pick be the underdog (the side with lower market-implied probability). This is not noise.

| Fixture | Model top pick | Market implied | Gap | Actual result |
|---|---|---|---|---|
| Senegal vs Iraq | Iraq Win | 7.4% | +17.3pp | Home Win (Senegal) ✗ |
| Norway vs France | Norway Win | 20.0% | +10.8pp | Away Win (France) ✗ |
| Panama vs England | Panama Win | 6.7% | +18.0pp | Away Win (England) ✗ |
| Colombia vs Portugal | Colombia Win | 29.4% | +9.6pp | Draw ✗ |
| South Africa vs Canada | South Africa Win | 16.7% | +16.3pp | Away Win (Canada) ✗ |
| Brazil vs Japan | Japan Win | 20.0% | +11.1pp | Home Win (Brazil) ✗ |
| Germany vs Paraguay | Paraguay Win | 10.5% | +18.6pp | Draw ✗ |

Market correct in 4 of 6 resolved fixtures. 2 draws (neither model nor market correct). **Model accuracy on divergent fixtures: 0/6.**

### Data Sparsity Is Not the Sole Cause

The tiered fixture-count gate (deployed 2026-06-30) correctly blocks data-sparse calls (Iraq: 8 fixtures, South Africa: 13, Japan: 15). But the underdog bias persists in data-rich fixtures:

- Norway (37 backfill fixtures) vs France (40): model picked Norway at 30.8% vs market 20.0%
- Colombia (52) vs Portugal (36): model picked Colombia at 39.0% vs market 29.4%
- Germany (50) vs Paraguay (48): model picked Paraguay at 29.1% vs market 10.5%

These teams have genuine form data. The bias is in the model logic, not the data pool.

### Likely Culprits to Investigate in July

1. **FIFA ranking anchor (`rankScale=0.018`)** — the anchor blends model output with a FIFA-rank-based probability at `(1 - dataConf)` weight. At the international dataConf cap of 0.70, the anchor contributes 30% to all outputs regardless of form data quality. If the FIFA rank distribution is flatter than the market's actual pricing of quality gaps, this systematically pulls probabilities toward the weaker team and compresses the favourite's edge on every international fixture.

2. **Calibration factor (1.11) applied uniformly** — derived from the club domestic calibration dataset (see section 1 above). If tournament football has different probability distributions, applying the same 1.11 factor to international fixtures may over-inflate minority probabilities specifically in the ranges the market prices as <25%.

3. **Neutral venue base (0.34/0.34) interaction with ranking anchor** — at neutral venues, both teams start from equal base probabilities. The ranking anchor then pulls toward the FIFA-rank-implied split. If FIFA rankings systematically underestimate the true quality gap between strong and weak WC teams (a known issue — FIFA rankings are points-based not ELO), the anchor compounds the underdog bias: the model starts equal, then anchors to a flatter-than-reality distribution, then the calibration factor amplifies it.

### What to Do in July

- **Segment calibration data by "model favoured underdog vs model favoured favourite"** as a standalone diagnostic category, not just probability bands. This will show whether the directional bias is consistent across all confidence levels.
- **Backtest the ranking anchor in isolation**: compute what probabilities look like at `rankScale=0` for these 7 fixtures and compare to the market. If removing the anchor reduces the underdog bias, that is strong evidence the anchor is the root cause.
- **Check calibration factor derivation**: confirm whether 1.11 was computed on club or international data. If club, derive a separate `calibrationFactor` per context as part of the Platt scaling work (section 1).
- **Consider ELO or SPI ratings as an anchor replacement** for international context — club-level Elo (e.g. club Elo from clubelo.com) is known to better capture true team strength at international level than FIFA rankings.

### What Is Already Live

The tiered fixture-count gate (deployed 2026-06-30) correctly blocks the worst data-sparse cases and remains active for the rest of the tournament. It is a genuine improvement but does not address the directional bias.

**The underdog bias requires the full non-linear recalibration planned for July — not a parameter nudge now.** Do not touch `rankScale`, the calibration factor, or the neutral venue bases before that work is complete. A parameter nudge risks masking the structural problem rather than solving it.

### Addendum — 2026-07-01

**England vs Congo DR resolved correctly (England Win, 2-1).** Model 58.1% vs market 54.9% — gap 3.3pp, no `lowConfidence`, score 52. First WC fixture where the model closely agreed with the market and was correct.

**This refines the section 5 hypothesis significantly.** The underdog bias does not appear to be a global calibration error affecting all international fixtures. It specifically manifests when the model diverges from the market by more than ~10pp. Below that threshold the model performs correctly.

**The more precise finding:** the model's large divergences from the market on international fixtures are systematically wrong — the market is right in these cases. Small divergences (under ~10pp) appear reliable.

**July investigation priority update:** the primary focus should be understanding what causes large divergences specifically — why does the model produce 30% for Japan when the market says 20%, or 29% for Paraguay when the market says 10.5%? The answer likely lies in the FIFA ranking anchor being too weak to suppress these probability estimates when the form model produces high scores for teams from weaker confederations. A confederation strength adjustment applied to form scores (already proposed in section 4) would directly address this: if Senegal's form score is inflated by AFCON results against weak opposition, the ranking anchor at 30% weight is not strong enough to pull the final probability back to the market's assessment. The fix is to reduce the form signal going in, not to increase the anchor weight.

**Belgium vs Senegal (Jul 1, 17:00 UTC) — to track:** scored at 41 with Belgium 48.8% vs market 47.6%, gap 1.2pp, no `lowConfidence`. If Belgium win, this is another small-divergence correct call and further supports the threshold hypothesis. Currently in WATCHING.

---

## 6. International quality signal — three time horizons (July implementation)

**Finding date:** 2026-07-14  
**Status:** Interim fix live. Full implementation planned for July upgrade.

### Problem identified

`standingsScore()` in `scoring.js` computed: `(flat.length - entry.rank + 1) / flat.length × 100`. For WC group stage, `flat.length` is 4 (one group). This produced scores of 100/75/50/25 for group ranks 1–4 regardless of team quality — all qualifying nations scored 75–100 since most progress to or finish near the top of their group.

The divergence report confirmed the symptom: across 15 tracked WC fixtures, standings scores for both teams were uniformly 90–100 in factor breakdowns, providing no quality differentiation and contributing to the systematic underdog inflation documented in section 5.

### Interim fix (committed 2026-07-14)

`standingsScore()` now accepts a third `fixtureContext` argument. When `fixtureContext === 'international'`, it returns 50 (neutral) for both teams. This eliminates the artificial signal without introducing a replacement. The factor weight that was going to standings now distributes across the other factors via their relative weights.

This is a floor fix, not the solution. The correct fix is to replace the standings component with a purpose-built international quality signal.

### Planned replacement — three-component international quality score

The three components each measure team quality at a different time horizon. When they agree, confidence in the quality assessment increases. When they diverge — e.g. a low-seeded team outperforming in-tournament — the divergence itself is meaningful signal.

#### Component 1 — FIFA ranking score (long-term, 40% weight)

Already implemented as the ranking anchor (`rankToQuality`, `FIFA_RANK_FALLBACK`). Reflects accumulated quality over a 4-year window. Captures structural programme strength: squad depth, coaching, infrastructure.

This component is not new — it is the existing ranking anchor, renamed for clarity in the composite. No code change needed.

#### Component 2 — Tournament seeding score (medium-term, 25% weight)

Pre-tournament seedings capture squad fitness, recent form, and preparation factors at draw time — a snapshot of perceived quality at the point of most expert assessment, before in-tournament noise.

Formula: `seedingScore = Math.round((1 - (seed - 1) / (totalSeeds - 1)) * 100)` scaled to the seeding scale in use:
- Seeding 1 → 100
- Seeding 4 → 75
- Seeding 8 → 50
- Proportional for all intermediate positions

Storage: `data/tournament-seeds.json`, structure `{ "leagueId_season": { "teamId": seedNumber } }`. Example:

```json
{
  "1_2026": {
    "9": 1,
    "2": 2,
    "6": 3
  }
}
```

**Action required:** WC 2026 seedings should be manually entered into `data/tournament-seeds.json` now while the tournament is live. All 48 WC 2026 teams need seed numbers. This data will be used for July calibration analysis — without it we cannot backfill the component against QF/SF results.

#### Component 3 — Opponent-quality-adjusted standings (short-term, 35% weight)

In-tournament performance weighted by opponent strength. Distinguishes winning a group containing Spain from winning a group containing Panama. Captures momentum, tournament-specific form, and late fitness signals not visible in long-term rankings.

Formula:
```
adjustedStandings = (points / maxPoints) × avgOpponentFifaQuality × 2
```

Where `avgOpponentFifaQuality` is the mean `rankToQuality(rank)` across all group opponents faced so far. Capped at 100.

A team with 9/9 points against top-10 FIFA opponents scores ≈100. A team with 9/9 against rank-70 opponents scores ≈40–50.

#### Composite

```
internationalQuality = (0.40 × fifaScore) + (0.25 × seedingScore) + (0.35 × adjustedStandings)
```

This replaces the standings factor in `homeF` and `awayF` for international fixtures, replacing the current `standings: 50` placeholder.

#### Weight optimisation

The 0.40/0.25/0.35 split is a starting estimate. These weights should be optimised against WC 2026 calibration data in July once sufficient resolved fixtures are available:

1. For each resolved calibration entry with `context === 'international'`, compute the composite quality score under different weight combinations
2. Regress quality score differential against actual result (home win / draw / away win)
3. Select weights that minimise calibration error on the QF/SF/Final sample

**Minimum data required:** approximately 15–20 resolved knockout fixtures for reliable weight estimation. The group stage (48 fixtures) provides additional training data if seedings are available.

### Implementation order

1. **Now:** enter WC 2026 seedings into `data/tournament-seeds.json` (manual, required for backfill)
2. **Week 2:** implement `seedingScore()` and `adjustedStandings()` functions in `scoring.js`
3. **Week 2:** wire composite into `scoreOneFixture()` as the `standings` factor for international context
4. **Week 3:** backfill QF/SF/Final calibration data with the composite scores
5. **Week 3/4:** weight optimisation against resolved calibration entries

---

## 7. Pre-Pinnacle edge overstatement (documented 2026-07-07)

**Finding date:** 2026-07-07  
**Commit:** 6399dbe — "Use Pinnacle margin-stripped odds as edge benchmark"  
**Status:** Fixed going forward. Historical calibration data affected.

### What was wrong

Before commit 6399dbe, `fetchOddsForLeague` used `bookmakers[0]` — whichever bookmaker appeared first in The Odds API response — as the implied probability benchmark for edge calculation. This was typically a UK soft bookmaker (Betfred, Coral, Unibet UK) with an overround of 10–15%.

Using a soft book's raw implied probability (`1 / odds`) as the market benchmark overstated edge by approximately **8–10pp on every fixture**. A £1.70 outcome at a soft book implies 58.8%, but Pinnacle's margin-stripped true probability for the same outcome might be 54.1%. The model was reporting 4.7pp of "edge" that was entirely bookmaker margin, not genuine model advantage.

### What was fixed

`fetchOddsForLeague` now identifies Pinnacle specifically and strips its margin (~3–4% overround across home/draw/away) to produce near-true implied probabilities. These are used for `impliedProb`, `edge`, and `maxModelBookGap` (the `lowConfidence` gate). UK bookmaker odds are retained separately for displayed `bookOdds` and Kelly sizing.

### Impact on historical calibration data

All World Cup calibration entries collected before 2026-07-07 have `pinnacleAvailable: false` (or the field absent). Their `edge` and `impliedProb` values are inflated by ~8–10pp and should not be used to train the EV optimiser.

**Action required in July:**
- Segment all calibration data by `pinnacleAvailable: true/false`
- Only use `pinnacleAvailable: true` entries for EV optimiser training and edge distribution analysis
- The WC paper trading P&L (£1,310.24) is not affected — P&L is computed from actual odds and stake, not from the model's edge estimate
- The `lowConfidence` gate was also less accurate pre-fix: some bets that were blocked may have had genuine edge if Pinnacle agreed with the model; some placed bets may have had less edge than reported

---

## 9. Per-bookmaker bet breakdown and performance tracking (planned)

**Status:** Planned — Week 3 July upgrade (Aug 1–8)

### At bet lock — per-bookmaker breakdown table

When a bet locks, the routing card will display a full breakdown table across all eligible bookmakers, showing:

| Bookmaker | Tier | Odds | Edge at odds | Kelly stake | Display stake | % of total bets | Status |
|---|---|---|---|---|---|---|---|

- **Odds** — live odds for this outcome at each book (from `_buildBookmakerMarket` / The Odds API response)
- **Edge** — recalculated as `calProb − (1/odds)` at that book's specific price, not the generic implied prob
- **Kelly stake** — recomputed at those specific odds and current bankroll
- **Display stake** — `roundStake()` output for those specific odds
- **% of total bets** — `totalBets / sumAllBookmakerTotalBets × 100` across all accounts, recalculated live
- **Status indicator** — 🟢/🟡/🟠/🔴 per current account status

Sort order: exchanges first (tier 1), then by lowest `% of total bets` ascending within each tier. Any bookmaker at **≥15% of total bets** highlighted in red as a usage concentration warning.

### After bet confirmation

On `POST /api/bets/:id/confirm-placement`, update:
- `bm.totalBets`, `bm.lastUsed`, `bm.totalStaked` on the confirmed bookmaker (already implemented)
- Recalculate `usagePct` across all bookmakers and store as a derived field on `/api/bookmakers` response
- Bet record stores `bookmakerUsed`, `bookmakerId`, `actualOdds`, `actualStake` (already stored)

### Bookmaker Performance section — Performance tab

New section below the P&L curve showing per-bookmaker stats across all confirmed bets:

| Bookmaker | P&L | Staked | % of volume | Win rate | Days since used | Status |
|---|---|---|---|---|---|---|

- **P&L** — `totalReturned − totalStaked`, colour-coded green/red
- **% of volume** — `totalStaked / sumAllStaked × 100`
- **Win rate** — computed from `bets.json` entries filtered by `bookmakerId`
- **Days since used** — `Math.floor((now − new Date(lastUsed)) / 86400000)`
- **Status** — four-state indicator with tooltip showing latest restriction signal

Ordered by total staked descending. Bookmakers with zero bets shown collapsed at the bottom.

---

## 8. Model Probabilities display bug — display-only, data clean (fixed 2026-07-13)

**Finding date:** 2026-07-13  
**Commit:** 0a9ce0f — "Fix Model Probabilities display to use server-calibrated allCandidates probs"  
**Status:** Fixed. No data integrity impact.

### What was wrong

The fixture card drawer contained two probability displays:

1. **Model Probabilities** (top section) — called `computeProbs(homeF, awayF)`, a client-side re-approximation using a hardcoded `× 0.88` away multiplier (a crude home advantage proxy) and the current `WEIGHTS` setting. Applied **no calibration factor**, **no WOWY modifiers**, **no international context adjustments**.

2. **Value Analysis cards** (below) — read from `allCandidates[].modelProb`, the actual server-computed probabilities stored at scan time, which include all post-scoring adjustments.

Example discrepancy observed on Norway vs England: top section showed Norway 39% / England 35%, Value Analysis correctly showed Norway 30% / England 55%. The 20pp gap on England is explained by the calibration factor (×1.08) amplifying a stronger underlying model signal, combined with the 0.88 away multiplier artificially compressing away probability.

This affected every fixture card during the WC validation period.

### Data integrity

**Calibration data is clean.** The `calibration.json` entries store per-outcome probabilities in a `candidates[]` array (older schema name for `allCandidates`). These were written by the server at scan time and contain the correct calibrated `modelProb` values — they were never affected by the client-side display bug. The P&L, edge estimates, and all calibration metrics are computed from these server-side values.

### Fix

`openDrawer()` now reads probabilities from `allCandidates[].modelProb` (server-calibrated) when present, with `computeProbs` retained as a fallback for legacy entries that predate the `allCandidates` field being stored. Both the Model Probabilities section and the Value Analysis cards now show identical numbers.

---

## 10. La Liga home advantage calibration — systematic 7pp underestimation (documented 2026-07-23)

**Finding date:** 2026-07-23  
**Status:** Documented. La Liga locked to `paper_only` until resolved. Fix planned for Week 2.

### Finding

EV calibration across 524 La Liga historical fixtures reveals the model systematically underestimates home teams:

- **Model average home probability:** 38.51%
- **Actual home win rate:** 45.44%
- **Gap:** 7pp underestimation

This is not a draw rate problem. Predicted draw rate (26.18%) is within noise of actual (25.70%). The underestimation is almost entirely on the home side, displaced to away.

La Liga EV calibration is negative across all edge bands as a result — the model cannot reliably identify genuine home team value because its starting probability for home wins is structurally too low.

### Root cause

`homeAdvBaseWeight: 1.02` in `LEAGUE_CONFIG` for La Liga (league ID 140) is too low. La Liga has stronger home advantage than the 1.02 multiplier implies — this is consistent with La Liga's known stadium culture and tight pitches at grounds like Camp Nou, Mestalla, and San Mamés.

### Fix (Week 2)

After the non-linear model is deployed, increase La Liga `homeAdvBaseWeight` from 1.02 → 1.10 in `LEAGUE_CONFIG` in `scoring.js`:

```js
140: { name: 'La Liga', homeAdvBaseWeight: 1.10, ... }
```

Re-run EV calibration after the fix and confirm La Liga ROI improves. If still negative after the weight adjustment, investigate form and xG factor interactions specific to La Liga fixtures — the form signal may be over-weighting away teams that perform well in European competition but underperform domestically.

### Current status

La Liga is set to `paper_only` in `leagueModes` (settings.json). It will remain there until EV calibration shows positive ROI with the corrected weights. The `paper_only` lock is enforced server-side — the Go Live button in Settings is permanently disabled for La Liga regardless of the condition checklist state.

---

## 11. New League Onboarding Checklist

**Established:** 2026-07-26  
**First applied to:** Eredivisie (id:88), Primeira Liga (id:94)

This checklist applies to every league added to Edge Scout — Championship, Bundesliga 2, Belgian Pro League, Scottish Premiership, etc. A league must complete all 8 steps before receiving real-money recommendations.

### The 8 Steps

#### Step 1 — Historical fixture backfill (5 seasons minimum)
Add the league to `HISTORICAL_BACKFILL_CONFIG` and `BACKFILL_CONFIG` in `server.js` with seasons `[2024, 2023, 2022, 2021, 2020]`. Trigger `POST /api/backfill/historical`. Target: 500+ scored records minimum; below this the EV calibration has insufficient signal.

#### Step 2 — Historical Pinnacle closing odds fetch
Run `POST /api/backfill/closing-odds?leagues=<id>&budget=<n>`. Check whether The Odds API has Pinnacle historical coverage for the league — some leagues (e.g. Scottish Premiership) have zero coverage and can never be EV-calibrated via this source. If 0 matches returned: note in league status and skip Steps 3–5; the league remains paper-trade until an alternative odds source is found.

#### Step 3 — EV calibration — initial run
Run `GET /api/ev-calibration`. The league should now appear in `byLeague`. Record:
- Total matched fixtures (n)
- Overall ROI
- Band-level ROI breakdown (all 6 bands)
- Kelly recommendation

If n < 100: insufficient data — add more seasons (back to 2019 if available) and repeat Step 1.

#### Step 4 — Home/draw/away rate diagnostic
Run `GET /api/league/diagnostic?leagues=<id>`. Compare:

| Metric | Config value (`LEAGUE_CONFIG`) | Model average prediction | Actual rate (historical) |
|--------|-------------------------------|--------------------------|--------------------------|
| Home win rate | `avgHomeWinRate` | `modelAvg.home` | `actual.home` |
| Draw rate | `avgDrawRate` | `modelAvg.draw` | `actual.draw` |
| Away win rate | `avgAwayWinRate` | `modelAvg.away` | `actual.away` |

**Red flags:**
- Model avg home > actual home by >3pp → `homeAdvBaseWeight` is too high, reduce it
- Model avg home < actual home by >3pp → `homeAdvBaseWeight` too low, increase it
- Model avg draw > actual draw by >3pp → `drawBaseWeight` too high, reduce it
- EV band ROI worst at high-edge bands → systematic false positive generation; model miscalibrated for this league

#### Step 5 — LEAGUE_CONFIG calibration adjustments
Update `scoring.js` `LEAGUE_CONFIG[id]`:
- `avgHomeWinRate`, `avgDrawRate`, `avgAwayWinRate` → set to observed actual rates from Step 4
- `homeAdvBaseWeight` → adjust directionally based on delta (see Step 4 red flags)
- `drawBaseWeight` → adjust if draw rate is systematically off
- `marketEfficiency` → start at 0.80 for new leagues (less efficient than top-5); raise to 0.88+ only with evidence

#### Step 6 — Extended backfill rescore
After adjusting `LEAGUE_CONFIG`, trigger `POST /api/backfill/historical?rescore=true` to regenerate all scored records with the corrected parameters. Then re-run `/api/ev-calibration`.

#### Step 7 — Paper trade with monitoring (minimum 50 resolved bets)
Set league to `paper_trade_only` in `settings.paperTradeOnly`. Monitor:
- Live paper ROI after 20, 35, 50 resolved bets
- CLV (closing line value) per bet — positive CLV with negative ROI is variance; negative CLV means the model has no edge
- Flag any systematic bias (all losses on home favourites, all losses on draws, etc.)

#### Step 8 — Go Live decision
Requirements before enabling real-money recommendations:
1. ≥50 resolved paper bets
2. Paper ROI ≥ 0% (or CLV strongly positive with a clear variance explanation)
3. EV calibration ROI ≥ 0% (or at worst -5% with improving trend)
4. No systematic band failure (no single band with ROI < -30% and n > 20)
5. Explicit Go Live decision recorded in this doc with date and evidence

Never go live based on a small sample or model confidence alone. The EV calibration and paper trade period exist to catch model failures before real money is at risk.

### League Status Tracker

| League | id | Backfill | Closing Odds | EV Cal (ROI) | Diagnostic | Config Fixed | Paper Bets | Status |
|--------|-----|----------|-------------|--------------|------------|--------------|------------|--------|
| Premier League | 39 | ✅ 5 seasons | ✅ Pinnacle | +15.5% | ✅ | ✅ | — | **half_kelly** |
| La Liga | 140 | ✅ 5 seasons | ✅ Pinnacle | -7.8% | ✅ | ✅ partial | — | paper_only |
| Bundesliga | 78 | ✅ 5 seasons | ✅ Pinnacle | +1.5% | ✅ | ✅ | — | **quarter_kelly** |
| Serie A | 135 | ✅ 5 seasons | ✅ Pinnacle | -7.7% | ✅ | ✅ | — | paper_only |
| Ligue 1 | 61 | ✅ 5 seasons | ✅ Pinnacle | -6.6% | ✅ | ✅ | — | paper_only |
| Eredivisie | 88 | ⏳ 5 seasons (2020–21 pending) | ✅ 927 matched | -18.6% | ⏳ pending deploy | ⏳ pending | — | paper_only |
| Primeira Liga | 94 | ⏳ 5 seasons (2020–21 pending) | ✅ 106 matched | -38.9% | ⏳ pending deploy | ⏳ pending | — | paper_only |
| Scottish Prem | 179 | ✅ 3 seasons | ⏳ Backfill Aug 1 (key fixed) | N/A | — | — | — | paper_only |
| Champions League | 2 | ✅ 3 seasons | ✅ Pinnacle | — | — | — | — | paper_only |

### Notes on specific leagues

**Eredivisie (88):** Initial EV calibration shows -18.6% ROI. Band analysis shows systematic false positive generation — the model's highest-confidence calls (-54.8% at 5–10% edge band) are the worst performers. Root cause: model not calibrated for Dutch football's higher scoring rate (avg 3.12 goals/game vs 2.52 in Ligue 1). Config adjustment: increase `avgGoalsPerGame` impact, recalibrate home advantage. 2020–21 seasons added to increase signal.

**Primeira Liga (94):** Only 106 matched closing odds fixtures (partial backfill — budget ran out). -38.97% ROI but heavily driven by small samples (most positive-edge bands n<10). Inconclusive until more fixtures are matched. 2020–21 seasons added. Re-run closing odds backfill when 100K plan resets on August 1.

**Scottish Premiership (179):** Previous closing odds backfill returned 0 matches because the wrong sport key was used (`soccer_scotland_premiership` instead of `soccer_spl`). Fixed in commit `9a8d742`. The Odds API has full Pinnacle historical coverage for Scottish Prem under the correct key `soccer_spl` — confirmed live and historical data available. Closing odds backfill to run on August 1 when the 100K plan resets (key: [ODDS_API_KEY — stored in Render environment variables]): `POST /api/backfill/closing-odds?leagues=179&budget=50000`. EV calibration will be possible once the backfill completes.

---

## 12. Routing algorithm note — long-term exchange strategy (2026-07-30)

**Status:** Documented — reflects account additions in `data/bookmakers.json` (Orbit Exchange, Betconnect added Tier 1; Pinnacle direct account and SBOBet added/updated Tier 2).

Long-term exchange strategy — priority is building exchange and sharp-book volume over UK soft book volume. Every bet placed on an exchange or sharp book rather than a soft book extends operational longevity and removes the restriction ceiling on returns.

---

## 13. BTTS per-event odds — follow-up (2026-07-31)

**Status:** Deferred. Do not implement before August.

BTTS pricing requires the per-event odds endpoint (`/v4/sports/{sport}/events/{eventId}/odds?markets=btts`) rather than the bulk league endpoint — confirmed the bulk endpoint rejects `btts` (and `both_teams_to_score`, `soccer_btts`) with a 422 regardless of spelling, while the per-event endpoint returns real BTTS prices for the same market key. Restoring BTTS pricing means one extra API call per fixture per scan, not per league.

Credit cost approximately 1,720 per scan day across 12 leagues on a full matchweek.

Implement in August once the 100K credits reset and baseline scan credit consumption is established. Do not implement before then.

---

## 14. Transfer data integration (August backlog)

**Status:** Backlog. Priority: implement before August 2027 season start at the latest, ideally before the January 2027 transfer window closes.

API-Sports Pro plan includes a `/transfers` endpoint returning completed transfer data per team per season. Currently unused. Integrate before each season start:

1. Fetch completed transfers for all active league teams for the current season
2. For arriving players: look up their PIR from their previous club, apply as a positive squad quality signal
3. For departing players: flag their absence as a permanent WOWY-style negative modifier until new data accumulates
4. Store in `data/transfers.json` keyed by teamId and season
5. Apply a "transfer adjustment" modifier in `applyTeamProfileModifiers` for the first 10 matchdays of a season — reduces gradually as actual match data replaces the transfer-based estimate

This closes the biggest model/market gap at season start — the market prices in summer transfer activity, the model currently cannot.

---

## 15. Away team strength multiplier (priority fix — implement before August 22)

**Finding date:** 2026-07-31  
**Status:** Documented. Priority: implement before Premier League day 1 on August 22.

The team profile currently applies a home win rate multiplier only. There is no equivalent for away teams. `awayModifier` exists in `CONTEXT_THRESHOLDS` (`teamProfiles.js`) but is never referenced anywhere else in the codebase — a dead config value. This means an away team's historical strength (e.g. Rangers' 60% away win rate) has zero influence on the model probability beyond what shows up in form/xG/H2H factors.

This is the primary reason for the large model/market gap on Rangers vs Dundee United on opening day — Rangers' structural away strength is completely invisible to the model.

### Fix required

1. Implement `awayWinRateMultiplier` in `applyTeamProfileModifiers`, symmetric to the existing home multiplier — apply when the away team's away record meets the confidence threshold
2. Reduce the confidence threshold from 10 games to 5 games for all leagues at season start — with only 4 games in the current season pool, the multiplier never activates for any team in any league for the first few matchdays
3. Apply the away multiplier to reduce (or boost) the away team's probability contribution based on their historical away win rate vs league average

Priority: implement before Premier League day 1 on August 22. This affects every fixture where a strong away team plays a weaker home side.

---

## 16. Scottish Premiership (179) — home advantage calibration

**Finding date:** 2026-07-31  
**Status:** Partially fixed. Residual home gap flagged for architectural review.

Scottish Premiership (179) — home advantage miscalibration (8.63pp gap, larger than La Liga's 7pp). `homeAdvBaseWeight` lever reaches diminishing returns at 1.5 — home gap closes to 4.95pp at that value (draw −0.06pp ✅, away −4.89pp ✅). Full home gap closure not achievable via `homeAdvBaseWeight` alone — structural limitation of the linear factor model for SPL's larger-than-average home advantage. Residual home gap flagged for architectural review. Re-run EV calibration after August 1st closing odds backfill.

---

## 17. Critical architecture finding — GBDT ignores LEAGUE_CONFIG entirely

**Finding date:** 2026-07-31  
**Status:** Fixed via post-prediction bias correction.

The GBDT model (`models/gbdt.js`) accepts `leagueConfig` for interface compatibility but discards it — underscore-prefixed `_leagueConfig`. All `LEAGUE_CONFIG` calibration (`avgHomeWinRate`, `avgDrawRate`, `homeAdvBaseWeight` etc.) only reaches the linear model path (`computeModelProb`), which is used by diagnostics and the weight optimiser but NOT by live predictions. This means every per-league calibration effort to date — including sections 10 (La Liga) and 16 (Scottish Premiership) above — never actually affected a single live prediction; it only made the diagnostic tool self-consistent with a model path the live system doesn't run.

A post-prediction per-league bias correction (`applyLeagueBiasCorrection`) has been added to bridge this gap — blends GBDT output 70/30 toward league observed rates (`LEAGUE_CONFIG.avgHomeWinRate/avgDrawRate/avgAwayWinRate`), applied in `scoreOneFixture` immediately after `model.predict()` returns. This means LEAGUE_CONFIG calibration now genuinely affects live predictions for the first time.

Verified on Dundee Utd vs Rangers (SPL) and Villarreal vs Atletico Madrid (La Liga, historical) — both moved in the correct direction toward each league's observed base rates.

---

## 18. Minimum calibration dataset standard

**Established:** 2026-08-01

Every league must have **1,000+ matched Pinnacle closing odds fixtures** before EV calibration results are considered reliable. Leagues below this threshold should be treated as inconclusive regardless of ROI sign — a −53.6% ROI on 106 matched fixtures (Primeira Liga) is not evidence the league is unprofitable, it's evidence there isn't enough data yet to know either way.

Extending to 5+ historical seasons is always preferred over waiting for live data accumulation — it's a one-time API cost against already-supported backfill infrastructure, versus months of waiting for live fixtures to slowly build the same sample size.

Status as of 2026-08-01 (post 100K-plan closing odds backfill):

| League | Matched fixtures | Meets 1,000 threshold? |
|---|---|---|
| Serie A | 1,140 | ✅ |
| Premier League | 1,026 | ✅ |
| Eredivisie | 927 | ❌ |
| La Liga | 883 | ❌ |
| Bundesliga | 853 | ❌ |
| Ligue 1 | 614 | ❌ |
| Scottish Premiership | 573 | ❌ |
| Primeira Liga | 106 | ❌ |

Scottish Premiership's historical fixture backfill extended from 3 to 5 seasons (added 2021, 2020) to work toward this threshold. La Liga, Bundesliga, Ligue 1, and Primeira Liga already had 5 seasons configured in `HISTORICAL_BACKFILL_CONFIG` — their shortfall is in closing-odds matching against the existing fixture pool, not fixture backfill depth.

---

## 19. Scottish Premiership Pinnacle closing odds ceiling

**Finding date:** 2026-08-01

Scottish Premiership Pinnacle closing odds ceiling: 991 matched fixtures (9 short of the 1,000 standard). The 2020/2021 seasons were fetched and scored but The Odds API has no Pinnacle historical coverage for SPL pre-2022 — confirmed by 100% miss rate on 100 fresh fixture attempts. 991 is the practical ceiling under this data source. The +0.91% ROI on 991 fixtures is treated as directionally useful but borderline-inconclusive per the formal standard. SPL remains in paper mode with quarter_kelly recommendation pending 50 live paper trades.

---

## 20. Maintenance note — hardcoded season boundary in paperTradeOnly auto-management

**Finding date:** 2026-08-01

`getLivePaperTradeCount` in `server.js` (part of the `/api/ev-calibration` `paperTradeOnly` auto-management logic — see section 19's related fix) has a hardcoded season boundary date of `2026-08-01`. This must be updated at the start of each new season or the live paper trade count will be incorrectly calculated — bets from the previous season would continue to count toward the current season's live-trade threshold, allowing a league to clear the 10-live-trade gate on stale data.

Consider making this dynamic by reading from a `settings.currentSeasonStart` field — update that field once per season rather than hardcoding in the function.

### Pre-season checklist (started here — first entry)

- [ ] **August 2027:** Update the season boundary used by `getLivePaperTradeCount` (either the hardcoded date in `server.js` or `settings.currentSeasonStart`, whichever is in place by then) to `2027-08-01`.
