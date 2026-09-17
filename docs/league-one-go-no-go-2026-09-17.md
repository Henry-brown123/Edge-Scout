# League One — go/no-go review for real money (2026-09-17)

Companion to Addenda 55–58. Two pockets, both fixed from go-live (rule 18).

## The pockets

| Pocket id | Rule | Basis |
|---|---|---|
| `l1-12-50` | edge ≥ 12% at 0.93, probability ≥ 50%, year-round | Addendum 56 C1 selected cell |
| `l1-jan-may-5-45` | edge ≥ 5% at 0.93, probability ≥ 45%, kickoff in January–May | Addendum 56 C3 selected cell |

Chain: pooled model (2026-09-15) → league bias correction. No correction
layer applies to League One; team-profile modifiers are off (unified league).
Single-bucket assignment: a fixture that qualifies for both is assigned to
`l1-12-50` (priority 1); the January–May pocket receives only fixtures the
year-round cell does not take. Verified on history in Addendum 58.

## How these were found — stated plainly

League One's test slice (2024-09-16 → 2026-08-11) was read in the pooled EFL
grids (Addenda 39/40), in its own permitted search (54), in the 6%/45%
stress-test (55), once per candidate in the pocket-space search (56), and in
the era deep-dive (57). The candidate list in 56 was fixed in code before
the test rows were read, and every figure since has been a re-measurement
of fixed cells, but this population is mined. Its history is closed.

## Evidence (matched pre-cutoff population, 3,284 fixtures, six seasons)

| | 12%/50% year-round | Jan–May 5%/45% (before assignment) |
|---|---|---|
| n / bets per season | 121 / 20 | 208 / 35 |
| ROI at close [95% CI] | +27.7% [+3.3, +52.0] | +22.4% [+5.7, +39.1] |
| Beyond market ± SE, z | +12.2 ± 4.4, 2.74 | +10.6 ± 3.4, 3.09 |
| Train / test (one look) | z 1.66 / 43 bets, +28%, z 2.39 | z 2.02 / 75 bets, +24%, z 2.47 |
| Sequential blocks positive (bm) | 4/4, incl. Jul 2020–Mar 2021 | 3/4; the negative block is spring 2021, closed doors (mechanism: Addendum 57) |
| Open-doors halves positive | 10/10 | 5/5 springs |
| Home / away | +13.5 (95) / +7.4 (26) | +11.8 (153) / +7.2 (55) |
| Recency-weighted (half-life 2 seasons) | +15.1 vs +12.2 unweighted | rising through 2026 |
| Total return per season, flat stakes | ~5.6 units | ~7.8 units |

Overlap: 52 shared fixtures (Jaccard 0.19) — additive. Post-assignment
figures for each pocket are in Addendum 58.

## Execution rules

1. Stake only when the soft-book price is at or above Pinnacle's price at
   lock.
2. Sizing: quarter-Kelly on the calibrated probability, capped at 1% of the
   real bankroll per bet — the ceiling the evidence justifies, not a floor.
3. Pre-registered stop rule, per pocket, forward data only: pause real money
   on a pocket if, after 40 resolved real bets in that pocket, its beyond-
   market residual is below −5 points (z ≤ −1.5); or at any time if
   closing-odds coverage on resolved League One bets falls below 90% over
   14 days or the pocket-aware gate rejects a candidate on either League One
   pocket test. Reads at any time; decisions by this rule.
4. Model updates continue weekly through the paired gate plus both pocket
   gates; a version change does not change the rules.

## Honest limits

- A mined population; the strongest disciplined answer available, not a
  first look.
- 12%/50% is thin (20 a season); the January–May pocket earns nothing until
  January 2027.
- FD-2 (Addendum 57): the model's home-advantage input does not react to
  regime shifts the market reacts to. Any future closed-doors-like event
  reproduces the 2020–21 loss; the stop rule is the guard.

## Decision

**GO at modest real stakes on both pockets**, from 2026-09-17T10:00Z, fixed.
Forward tracking is for maintenance and discovery, never re-optimisation.
