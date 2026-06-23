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
