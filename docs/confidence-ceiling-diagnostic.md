# Diagnostic: Why the model never predicts above ~79% confidence

Status: **diagnosis only, for review — no changes made to `applyLeagueBiasCorrection`
or any live scoring logic as part of this document.**

## Background

Part A of the sharp-books scoping investigation (2026-08-04) found that live
predictions never exceed roughly 73-79% confidence, across 18,392 scored fixtures.
The working hypothesis at the time was that `applyLeagueBiasCorrection`'s 30%
blend toward league-average base rates was mechanically compressing the raw
GBDT model's high-confidence output. A direct sensitivity check run today
(2026-08-05) shows that hypothesis was **only partially right** — the full
picture is more specific than "the blend does it."

## What `applyLeagueBiasCorrection` actually does

From `scoring.js`:

```js
function applyLeagueBiasCorrection(probs, leagueId, leagueConfig) {
  const config = leagueConfig[leagueId];
  if (!config) return probs;

  const rawHomeTarget = config.avgHomeWinRate * (config.homeAdvBaseWeight || 1.0);
  const drawTarget = config.avgDrawRate;
  const awayTarget = config.avgAwayWinRate;
  // ... renormalised to targetHome/targetDraw/targetAway summing to 1

  const blendFactor = 0.3; // 0 = pure GBDT, 1 = pure league average

  const correctedHome = home * (1 - blendFactor) + targetHome * blendFactor;
  const correctedDraw = draw * (1 - blendFactor) + targetDraw * blendFactor;
  const correctedAway = away * (1 - blendFactor) + targetAway * blendFactor;
  // ... renormalised to sum to 1
}
```

It's a linear blend: 70% raw GBDT output, 30% the league's long-run average
home/draw/away rate (itself now train-only calibrated for four leagues as of
today). Applied to every live prediction, unconditionally, regardless of how
confident the raw model was.

## Sensitivity check: raw GBDT vs bias-corrected, across all 18,392 scored fixtures

| | Raw GBDT | Bias-corrected (live) |
|---|---|---|
| Max confidence ever produced | 79.2% | 79.04% |
| Overall accuracy (top-pick correct) | 51.64% | 51.56% |
| Predictions in 50–60% band | 5,417 | 4,620 |
| Predictions in 60–70% band | 2,675 | 1,809 |
| Predictions in 70–80% band | 834 | 130 |
| Predictions above 80% | 0 | 0 |

**Correction to the earlier hypothesis:** the ~79% ceiling exists in the **raw
GBDT output already** — the bias-correction blend is not creating it. What the
blend *does* do is take a meaningful chunk of the model's 70-80%-confidence
calls (834 of them) and pull all but 130 of them down into the 50-70% range.
It reshapes the middle of the distribution; it doesn't lower the roof.
Overall accuracy is essentially unchanged (51.64% → 51.56%), so on this coarse
measure the blend isn't hurting or helping much in aggregate — its effect is
concentrated on exactly the highest-confidence, highest-edge-potential band.

## Why the raw model itself caps out near 79%

Not confirmed today, but the most likely explanation given the architecture
(GBDT + Platt scaling, per `docs/july-upgrade-notes.md`): Platt scaling is a
calibration step specifically designed to pull an ensemble's raw, often
overconfident probability outputs toward what the training data actually
supports. If the training set doesn't contain enough genuinely lopsided,
correctly-predicted fixtures, Platt scaling will suppress the model's ability
to output very high probabilities, regardless of what the underlying trees
"believe." This would need a dedicated look at the Platt calibration curve
itself to confirm — not done here, flagged as the natural next diagnostic step
if this is worth pursuing further.

## What adjusting the blend would plausibly do, and the tradeoffs

Lowering `blendFactor` (e.g. 0.3 → 0.15) would let more of the model's 70-80%
confidence calls survive into the live output, which — if those calls are
genuinely well-calibrated — could increase the number of high-edge bets
identified without necessarily hurting the already-thin overall accuracy
(51.6%, essentially flat between raw and corrected). But:

- **It wouldn't touch the real ceiling.** The 79% cap is upstream of the blend.
  Reducing or removing the blend only recovers band-shape, not headroom.
- **The blend may be doing real, load-bearing work for some leagues.** The
  30% pull toward league-average rates is exactly the mechanism used all
  session to correct real, confirmed miscalibration (Premier League's home/away
  rates, Ligue 1's, Champions League's, Serie A's — all now train-only
  validated). Turning the blend down turns down that correction too, for
  every league at once, not selectively.
- **This is a structural model change, not a data-completeness one.** Per
  `docs/calibration-rules.md`'s spirit, any change here should go through the
  same train/test discipline as base-rate tuning — pick a candidate
  `blendFactor` (or a smarter, per-league value) on train data only, justify
  it in modeling terms, and check it once on held-out test. That's a
  properly-scoped follow-up task, not a same-day parameter tweak riding along
  with today's backfill/calibration work.

## Recommendation

Don't change `blendFactor` or `applyLeagueBiasCorrection` today. If this is
worth pursuing:
1. First characterize the Platt-scaling step directly (is *it* the source of
   the 79% ceiling, or is there something upstream of that too) — that's a
   sharper, cheaper diagnostic than experimenting with the blend.
2. If the blend is still worth adjusting after that, treat it as its own
   calibration cycle under `docs/calibration-rules.md` — train-only tuning,
   single test look, per league or globally, reported the same way the
   base-rate work was today.
