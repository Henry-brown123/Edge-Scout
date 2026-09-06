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
