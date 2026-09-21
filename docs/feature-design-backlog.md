# Feature-design backlog

Standalone model-design items: things the model needs to *learn* differently,
as opposed to pipeline/timing problems (which live in Addendum 45's inventory)
and pocket discovery (Addendum 47 onward). Each item states the demonstrated
evidence, what a fix has to include, and the rule-13 discipline it owes.

## FD-1 — The model never picks a draw; draw propensity is a real, unmodelled trait

**Evidence (demonstrated, 2026-09-06).** Per-team draw rate correlates 0.445
between odd and even seasons across 279 well-sampled domestic teams
(Addendum 46) — a stable trait, of the same order as league-level draw rates
(21% in the UEFA cups to 32% in Serie B) that the model also cannot see because
it has no league identity input. In League Two the model's top pick was a draw
in 0 of 3,338 matched fixtures while the actual draw rate was 26.7% and the
market made the draw favourite in 48 (Addendum 47). The draw ensemble exists
(one-vs-rest, Platt-scaled) but its output is renormalised against two
outcome ensembles that carry all the discriminating features; nothing in the
24 inputs tells it which teams or leagues draw.

**What a fix must include.**
1. Inputs the draw ensemble can use: team draw propensity (shrunk toward the
   league rate, fitted on train only) and league identity or league draw
   rate.
2. A pick rule that can select the draw when it is the best price-adjusted
   outcome, not only the most probable one — the current "highest
   probability" pick structurally excludes draws in any league where home
   wins exceed ~35%.
3. Its own rule-13 train/test cycle on the draw market specifically, with
   beyond-market residual as the metric (Addendum 46 framing), and expected
   annual volume reported beside it.

**Category:** model gap (architecture/feature), not pipeline.
**Status:** logged 2026-09-06; not scheduled. Independent of the League Two
pocket work and of the reserved test set — it must not be developed on that
reserved population.

## FD-2 — Home-advantage input cannot react to a regime shift the market reacts to (2026-09-17, Addendum 57)

Closed-doors 2020-21: Pinnacle priced League One home wins at 40.3% (actual 40.2%); the model expected 43.5% because its home-advantage factor is built from historical home records. League One picks (three-quarters home) lost −9% ROI at the close over 555 fixtures; League Two's model overshot by only 1pp and was unhurt. Model finding, not pipeline. Any future regime shift (rule changes, neutral venues, schedule compression) will reproduce it. Candidate fix for a standalone model: a rolling-window or market-anchored home-advantage feature; pre-registered, forward-validated.

**Status 2026-09-20: built and under pre-registered test (Addendum 63).** `regime.js` supplies `closedDoors` (hand-dated per-league table — no source carries attendance) and `leagueHomeRate` (rolling 100-fixture league home-win share, strictly-before-day) as GBDT features 24–25 via `homeFactors.regime`, attached on every path by the shared builder. Trainer knobs `REGIME_FEATURES`, `TRAIN_SEED`. **Result 2026-09-21: not adopted on either model** (Addendum 63 Part 2). The gap is confirmed on the pool (45.1% expected vs 41.0% actual on 6,308 closed-doors fixtures) but a depth-3 greedy GBDT never splits on a 4pp/10%-of-rows binary, and a rolling league rate trained on normal seasons carries too little weight to move under a regime change. Features remain computed and stored; trainer default stays `none`. Open proposal: an additive regime offset on the log-odds after the trees (with the bias correction), fitted on flagged rows — a probability-chain change under rule 13, not built.
