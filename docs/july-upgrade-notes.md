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
