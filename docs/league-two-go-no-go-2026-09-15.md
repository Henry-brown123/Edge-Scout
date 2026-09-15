# League Two — go/no-go review for real money (2026-09-15)

Written against the rule the disciplined search confirmed, not the pre-fix
13%/45% reading. Companion to Addenda 51–53 in `tier-calibration-analysis.md`.

## The rule under review

**League Two, pick = the model's favourite by probability, edge ≥ 9% and
probability ≥ 40%, calibration factor 0.93, on the corrected live chain**
(model 2026-09-15 → league bias correction → `league-two-50plus` correction
layer; team-profile modifiers off and recorded in shadow). Live from
2026-09-15T19:15Z. Stake tier today: paper-with-stake; this review is about
whether real money should join it.

## How this rule was found — stated plainly

This is **not an untouched, first-and-only look.** The population it was
found on (3,330 League Two fixtures with Pinnacle closing, 2020-06 →
2026-08-11) has now been examined in three successive searches:

1. Addendum 47 (2026-09-06): full grid, split 2024-09-16, one test look.
2. Addendum 52 (2026-09-15): re-measurement after unification, descriptive
   neighbourhood grid on the whole population.
3. Addendum 53 (2026-09-15): full grid on the corrected chain, train-only
   selection, one test look for a pre-registered shortlist — and then an
   **expanded shortlist**, which read the test slice a second time for cells
   the rule had not picked. 9%/40% came from that expanded read.

The train/test split therefore guards against fitting the *selection* to the
whole population; it does not make the test rows unseen. The pre-cutoff
population is closed for selection from today (calibration-rules.md rule
18). This is the strongest, most disciplined answer available from
everything tested so far, and every future decision about League Two is to
be made knowing exactly that.

## Evidence

**Backtest, corrected chain (Addendum 53 Part 2).** Six seasons.

| | n | Bets/season | ROI at close [95% CI] | Beyond market ± SE | z |
|---|---|---|---|---|---|
| Whole population | 211 | 35 | +42.6% [+16.6, +68.7] | +8.3 ± 3.4 | 2.49 |
| Train (< 2024-09-16) | 156 | 26 | +40.2% [+9.6, +70.9] | +7.3 ± 3.9 | 1.88 |
| Test (≥ 2024-09-16, second read) | 55 | 27 | +49.5% [0.0, +98.9] | +11.2 ± 6.6 | 1.70 |
| Block 1 (2020-06 → 2021-11) | 54 | | +45.5% | +14.8 | |
| Block 2 (→ 2023-09) | 58 | | +21.4% | +1.1 | |
| Block 3 (→ 2025-03) | 56 | | +31.2% | +0.4 | |
| Block 4 (→ 2026-05) | 43 | | +82.5% | +20.3 | |

All four blocks positive on both measures; the two middle blocks are only
marginally positive on the residual, so the edge is not evenly spread across
time. Beyond-market is the market-relative measure (Addendum 46): the picks
win 8.3 points more often than Pinnacle's closing price implies.

**Live record for this exact rule: none yet.** The cell has been live since
19:15 UTC today. The previous League Two rule (13%/45%) produced 3 staked
locks since 11 August, 0 wins — too few to read. Bets locked under the old
chain cannot be re-labelled under the new one honestly, so the forward tally
starts at zero.

**Pipeline checks (all verified live 2026-09-15).** Scorer path shared, the
legacy path in rollback only; League Two scored through the corrected chain
with modifiers off; validated and live probabilities are one calculation;
closing-odds capture nightly with 60/60 coverage on the reserved set;
Pinnacle lock-to-close drift zero on 322 bets (Addendum 49), so the T-60
lock costs nothing against the close; tournament and international rows out
of the model; pocket-aware retrain gate live and passed its first run
(log-loss z −1.25 on 8,292 League Two records, pocket residual +13.1 vs
+12.6 points).

**Volume and return.** About 35 bets a season, roughly three a month, at
flat stakes ~15 units a season at the closing price. A soft-book price that
beats Pinnacle adds to that; a worse price subtracts (Addendum 49's
execution CLV).

## Execution rules if real money goes live

1. Stake only when the soft-book price is at or above Pinnacle's price at
   lock (the existing "beats Pinnacle" reference on every bet card).
2. Sizing: a genuinely small fixed fraction — quarter-Kelly on the
   calibrated probability, capped at 1% of the real bankroll per bet — is
   what the evidence supports. The user sizes; this is the ceiling the
   evidence justifies, not a floor.
3. Pre-registered stop rule (forward data only): pause real money if, after
   40 resolved real bets, the beyond-market residual is below −5 points
   (z ≤ −1.5), or at any time if closing-odds coverage on resolved League
   Two bets falls below 90% over 14 days or the pocket-aware gate rejects a
   candidate on the pocket test. Reads happen any time; the pause decision
   uses this rule, not the first bad week.
4. Model updates continue weekly through the paired gate plus the pocket
   gate; a version change does not by itself change the rule.

## The honest limits

- z 2.49 on a population searched three times is weaker than z 2.49 on a
  clean one. The test look for this cell is a second read at z 1.70.
- 35 bets a season means the first forward read with any power (≈ 100 bets)
  is about three seasons away; 40 bets, the stop-rule floor, is more than a
  season away. Real money on this rule is a decision to bet on the
  historical evidence and let the forward record accumulate, not a decision
  that can be re-checked quickly.
- Nothing about League Two is learned by the model: pre-cutoff rows never
  train (post-cutoff rows now do, weekly, through the gates).

## Decision

**GO for paper-with-stake, immediately and automatically** — that is the
tier the rule sits in from today.

**Real money: GO at small stakes is defensible on this evidence; it is the
user's risk call.** The case for: a market-relative edge that survives its
own split and all four blocks, a pipeline that now measures what it bets,
and a forward record that starts clean. The case against: a mined
population, a modest out-of-sample z, and a volume too low to re-check
within a season. If real money goes live it should be sized as in the
execution rules above and stopped by the pre-registered rule, never by
feel.

From here, League Two is validated forward only (rule 18). The next
pre-registered items are already in place: the 7%/35% paper track (high
volume) and the season-end model-candidate look on the reserved population.
