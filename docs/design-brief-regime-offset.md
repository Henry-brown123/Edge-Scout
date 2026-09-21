# Design brief R — Additive regime offset on the log-odds (2026-09-21)

Status: **built 2026-09-21 (Addendum 64), shipped in shadow.** Originally: Follows Addenda 57, 62 and 63: the
closed-doors gap is real (pool: 45.1% expected vs 41.0% actual home wins on
6,308 flagged fixtures), and neither age-based weighting nor a learned tree
feature can close it with this trainer. This brief scopes the one mechanism
those results point to, states honestly what it can and cannot deliver, and
pre-registers how it would be validated. Nothing here changes the chain.

## 1. What the evidence says the mechanism must be

- The effect is a **shift in the base rate**, not a change in how team
  strength maps to outcomes: under closed doors every league's home rate
  fell 2–8pp while strength features kept their ordering.
- Depth-3 greedy trees will not learn a 4pp shift on 10% of rows (Addendum
  63), and a per-league rolling rate trained on normal seasons has no weight
  to move under a regime change.
- So the correction has to be **additive, after the trees**, on the
  outcome log-odds — the same place the league bias correction sits — with
  its own fitted coefficients and its own validation (rule 13).

## 2. Where it goes in the chain

`scoreProbabilities` today: trees + Platt → league bias correction (a 30%
blend toward static league rates; **not applied** to League One, League Two
or the Championship, which carry no rates) → correction layer (League Two
only) → rank anchor (when dataConf < 1) → modifiers (off) → calibration
factor at the pocket rule.

Proposed: a new stage **`applyRegimeOffset(probs, leagueId, regime)`
immediately after the correction layer and before the rank anchor**,
switchable per league, recorded in shadow first. Reasons:

- After the bias correction, because the bias correction pulls *toward* the
  static rates — under closed doors it makes the miss worse — and the
  offset must be the last word on the base rate.
- After the correction layer, so the League Two layer's validated input is
  untouched; the offset then changes the layer's *output*, which the pocket
  re-measurement (§6) covers.
- Before the rank anchor and modifiers, so those keep operating on a
  probability that already carries the regime.

Form (per fixture): with `l = log(p_home / p_away)` and `d = log(p_draw /
p_away)`,

    l' = l + δ_home,   d' = d + δ_draw,   renormalise
    δ_home = β_cd · closedDoors + β_rate · g(regimeIndex)
    δ_draw = γ_cd · closedDoors + γ_rate · g(regimeIndex)

Two outcomes are shifted because closed doors also moved draws in several
leagues (recorded in `diag-regime`); whether γ is needed is a fitting
question, answered on flagged rows, not assumed.

### 2a. Architecture note (added 2026-09-21, after the chain refactor)

The stage is **not** pooled-specific. `scoreProbabilities` now runs every
model — pooled and each standalone — through one chain selected by
`modelKey`, with per-kind templates (`MODEL_CHAIN_TEMPLATES` in
`sharedScorer.js`). `regimeOffset` is already a slot in both templates
(`'off'`). Building this brief means: implement `applyRegimeOffset`, fit the
coefficients, and flip the slot to `'shadow'` in **both** templates. League
Two's standalone, League One's if it gets one, and any future pocket model
inherit it without per-model wiring; a model that must differ gets an
evidence-gated entry in `MODEL_CHAIN_OVERRIDES`, never an inline path.

## 3. The two terms are different animals — scope them separately

**Term A — dated regime (`closedDoors`).** Exact where the dating is exact,
fires on day one of a known regime, and is **dormant today**: no fixture is
flagged now, so the live chain is unchanged the day it ships and stays
unchanged until a comparable regime is declared and dated. Its value is
insurance plus the ability to score the 2020–21 rows correctly for
diagnostics. Size of the coefficient the data implies (pool, trees never
saw closed doors): logit(0.410) − logit(0.451) ≈ **−0.17** on the home
log-odds, with league spread from ≈ −0.05 (Segunda) to ≈ −0.32 (Ligue 1).
One pooled β_cd with per-league shrinkage toward it is the right shape at
240–660 flagged rows per league.

**Term B — rolling regime (`g(regimeIndex)`).** The only term that would be
*live-active*, and the one with real risk. Two facts constrain it:

1. **A per-league 100-fixture window cannot see closed doors.** SE of a
   100-fixture home rate is ≈ 0.05; the closed-doors deviation was 0.02–0.08
   — one standard error. A per-league rolling term is noise-driven by
   construction, which is exactly what Addendum 63 measured.
2. **The anomaly was global.** All fourteen leagues moved the same way at
   the same time. A **cross-league index** — the mean deviation of each
   league's rolling rate from its own long-run rate, over the last ~1,400
   completed fixtures across the pool — has SE ≈ 0.013, so closed doors
   would have read at 3–5 SE within about six weeks of the restart. That is
   the only rolling construction with any power, and it is what `g` should
   be: `g = clamp(globalDeviation / 0.013, ±4)`, dead-zoned at |g| < 2 so
   it is exactly zero in normal seasons.

Term B is therefore proposed as a **global, dead-zoned** term. It does
nothing in a normal season (the dead zone), reacts within weeks to a
cross-league shift, and cannot react to a single-league anomaly (a stadium
ban, one league's rule change) — for those the dated Term A is the tool.
This is stated as a limit, not hidden.

## 4. What it does not do

- Does not touch the eight factor scores, the trees, the trainer, or the
  Platt fit.
- Does not re-fit the League Two correction layer or the calibration
  factor; both are re-measured under §6, not re-selected.
- Does not act on international or tournament rows (retired).
- Does not change any pocket rule, edge or probability floor.

## 5. Fitting plan (pre-registered; rule 18 applies)

- **Data for Term A:** the 6,308 flagged pool rows *and their pre-closed-
  doors counterpart model* — the `rgp-wf2020-none` archive (trees < 2020-06,
  never saw the regime). Residual log-odds `logit(actual) − logit(model)`
  on flagged rows gives β_cd, γ_cd directly (pooled, then shrunk per
  league). Split: fit on 2020-06-17 → 2021-01-01 (3,060 rows), one test
  look on 2021-01-01 → 2021-08-01 (3,248 rows), against the same model with
  no offset. League Two and League One rows are inside this population;
  they are used for *fitting a chain parameter*, which rule 18 permits for
  train-only work, and their pocket cells are never a selection input.
- **Data for Term B:** the same window is the only regime in the pool, so
  β_rate cannot be fitted independently of β_cd on closed doors. Proposal:
  fix β_rate := β_cd / g_peak, where g_peak is the index's reading at the
  height of closed doors — i.e. Term B is *scaled to reproduce Term A* when
  the index reads what it read then, and is otherwise off (dead zone). No
  free parameter is fitted to normal seasons, because there is nothing there
  to fit; that is the honest statement of what the data supports.
- **Fitting is on the pooled model only.** The League Two standalone gets
  the same β values (its own flagged rows are 559 — too few to fit and its
  gap is ~2pp), with the standalone's re-measurement under §6.

## 6. Validation and activation (pre-registered)

1. **Retrospective, one look (Term A):** paired log-loss on the test half of
   closed doors, offset vs none, plus expected-vs-actual home rate on those
   rows. Adopt Term A only if better at z ≤ −1.645 there **and** exactly
   unchanged on every unflagged row (it is additive on a flag, so this is a
   code assertion, not a statistic).
2. **Pocket re-measurement, not re-selection:** with the offset in the
   chain, re-run the fixed cells (League Two 9/40 and its 7/35 paper track;
   League One 12/50, Jan–May 5/45, 6/45 paper) on their reserved
   populations and report the change. In a normal season the change must be
   **zero** for Term A (no flagged rows since 2021-05) and zero for Term B
   (dead zone). A non-zero reading is a bug, not a finding.
3. **Forward shadow:** the stage ships switched off and *recorded* on every
   lock (`regimeOffsetShadow: { g, δ_home, δ_draw, probsWithOffset }`),
   like `modifierShadow`. Activation of Term B needs a cross-league reading
   |g| ≥ 2 to have occurred — which may never happen — and, if it does, a
   pre-registered read after 300 post-trigger locks before anything but the
   shadow changes. Term A activates by declaring and dating a regime, which
   is a human decision recorded in `regime.js` with the date and source.
4. **Kill rule:** if any live reading of Term B sits outside the dead zone
   for more than 14 days without a matching move in Pinnacle's implied home
   rate across the same leagues (the market is the reference under
   Addendum 46), the term is switched off and the index inspected.

## 7. Honest expected value

- **Today:** none. No regime is active; the offset would be exactly zero on
  every lock the day it ships. Every current pocket is unaffected.
- **Under a future global shift:** a correction of the size that would have
  removed a 4pp base-rate miss across the pool and a 3–5pp miss on League
  One picks (Addendum 57's −9% closing ROI season), starting within weeks
  instead of never.
- **Under a future single-league regime:** only if someone dates it.
- **What it costs:** one chain stage (~80 lines), one fitting script, one
  diagnostic, the shadow field on the lock record, and one retrospective
  validation run. About one day. The main risk is not the code but the
  temptation to tune β_rate on normal-season noise; §5 forbids it.

## 8. Decision points for the user

1. Build at all, given the value is insurance rather than current P&L.
2. Global dead-zoned Term B as specified, or Term A only (simplest; zero
   live risk; no automatic reaction).
3. Whether the League Two standalone shares the pooled β or is left without
   the stage until it has its own evidence (recommended: share, re-measure).

Tagging: **model** (probability chain), not pipeline. Depends on nothing
outstanding; the regime fields it consumes are already stored on every
record and lock (Addendum 63).
