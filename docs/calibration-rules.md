# House Rules: Per-League Model Calibration & Go-Live Validation

Purpose: produce ROI figures that are actually true, so real-money decisions
can be made as fast as possible without repeating the SPL false-positive
(where base rates and homeAdvBaseWeight were fit on the same 995 fixtures
used to report +5.91% ROI, with zero genuine holdout).

## 1. Train/test split is mandatory before any tuning begins, for every league.
Time-based split (not random shuffle), applied before touching base rates,
weights, or any parameter. No exceptions, including "just a quick check."

**This governs deliberate, human-triggered tuning — not the core GBDT's ongoing weekly retrain.** Base-rate fits, weight sweeps, and any correction layer (rule 13) are each a deliberate decision, triggered once, evaluated against a held-out slice under rules 1-3. The GBDT model's own weekly retrain is different: since the "train/test merge decision" (`docs/model-versioning.md`), it trains on the entire available population every week by design, with no held-out portion reserved — governed instead by `model-versioning.md`'s own quality gates and improvement gate. Read literally, "no exceptions" above could look like it forbids the weekly retrain; it doesn't — the weekly retrain isn't the kind of tuning this rule is about. Deciding whether a base rate, weight, or correction parameter should change: rules 1-3 apply in full. Deciding whether this week's retrained GBDT weights should replace the deployed ones: that's `model-versioning.md`'s gates, not this rule.

**"For every league" describes two different mechanisms, not one.** The GBDT model's own internal split (`gbdt-train.js`'s `splitData()`) is a single pooled, chronological, cross-league split — every league's fixtures sorted together by date, first 80% train, last 20% test — not done per league. Per-league base-rate fits genuinely are done per league, each with its own documented boundary (rule 9). "For every league" means every league's base-rate/weight/correction tuning gets this discipline individually — not that the core model is retrained separately per league. The same distinction applies to any *calibration factor* shared across leagues — see rule 17.

## 2. Tuning only ever touches the train portion.
Grid searches, base-rate fits, weight sweeps, feature changes — all evaluated
against train only. The test set does not exist yet as far as the tuning
process is concerned.

## 3. The test set gets looked at once, at the end, per tuning cycle.
Not iterated against. If test-set ROI disappoints, that's a real result to
act on (improve the model on train, then re-run a fresh split) — not a
target to nudge parameters against directly. Re-peeking at the same test
slice repeatedly turns it into training data by another name.

## 4. "Improving the model" means real improvements, not parameter search against the eval metric.
Legitimate: better features, more signal sources, fixing real bugs (e.g. the
BTTS key, the closing-odds endpoint path), cross-league structural
improvements. Not legitimate: sweeping a parameter until train-set ROI turns
positive with no underlying football reason to believe that value is
correct. If a change can't be explained in football terms ("this corrects
known home-advantage miscalibration"), be suspicious of it even if it
improves the number.

A correction that legitimately varies in direction and magnitude across
leagues or tiers is not, by itself, the kind of unexplained parameter-chasing
this rule warns against. Addendum 23 found genuine, evidenced,
opposite-direction miscalibration — the original leagues underconfident in
the 45-70% band, League One/Two overconfident from 50%+ — so a single fixed
correction cannot be football-justified for both at once, and a varying one
can be. This is conditional, not a blanket exemption: each piece of a
varying correction must still independently clear rule 13's own train/test
discipline. "It varies by league" is the reason the correction is *allowed*
to vary — it is not, by itself, justification for skipping proof of any
individual piece on its own held-out evidence.

## 5. Every reported ROI figure includes n, posEdgeN, and a 95% CI — never a bare percentage.

## 6. Minimum sample-size bar before a backtest ROI is treated as meaningful.
Treat anything under ~300-400 posEdge bets as indicative only, not
decision-grade (SPL's CI still spanned zero at ~100-190 posEdge bets per
chunk). Flag explicitly when a league is below this bar rather than
presenting the number at face value.

## 7. Live dashboard numbers carry a `calibrationReliable` flag.
`true` only if the league has passed a clean train/test split with zero
fixture overlap between tuning and test populations. `false` triggers a
visible caveat in the UI, not just an internal note.

## 8. Backtest confidence is a pre-filter, not a replacement for the live paper-trade gate.
Even a league that clears clean backtest validation still needs to satisfy
MIN_LIVE_PAPER_TRADES before real money. A good backtest earns the right to
*start* paper trading with confidence — it doesn't skip live validation.

## 9. Every tuning commit documents its train/test boundary.
Commit message states the split date/method used, so it's auditable later.

## 10. A newly added league or competition's historical backfill is a future clean-test opportunity — don't spend it early.
The moment a new league's fixture history gets ingested, it's still unseen
by the live model (same status the 2010-2019 expansion fixtures had before
the big retrain). Preserve that: no calibration fit, base-rate tuning, or
ROI read against it until a deliberate, documented baseline pass is run —
the same shape as the retrain brief's Phase 1 (a genuine held-out read
before anything touches training). Folding it into calibration piecemeal,
or reading ROI off it "just to see," burns the one chance to test the
current model against real unseen data for that competition. Concretely,
for any newly added `LEAGUE_CONFIG` entry: leave `avgHomeWinRate`/
`avgDrawRate`/`avgAwayWinRate`/`avgGoalsPerGame` out entirely rather than
filling them with a plausible-sounding guess — those four feed a real
30%-live-blend in `applyLeagueBiasCorrection()` and a goals-market
baseline, not inert metadata, so an invented number is fabricated
calibration exactly as much as fitting one on contaminated data would be.
`marketEfficiency`/`drawBaseWeight`/`homeAdvBaseWeight` default to `1.0`
(a genuine no-op) until real evidence exists. First applied 2026-08-10 for
the Carabao Cup, League One, and League Two additions.

Once real-money pressure or a similar practical need arises for a
permanently-excluded population, rule 12 describes how — and whether — to
convert whole-population exclusion into a date-split boundary without
losing the backtest already earned. Read it before assuming the exclusion
described here is necessarily permanent in every case.

## 11. If the question is "is the EV threshold itself well-calibrated" (not "is there an edge"), that's Continuous ROI, not Historical/Live.
Every other ROI reading in this document — Historical, Live, Combined — is
filtered to `posEdge ≥ 5%`, so none of them can tell you whether that
threshold is drawn in the right place: they only ever look at bets on one
side of it. **Continuous ROI** is the specific diagnostic for that
question — the same tier-binned ROI computed against the full matched-odds
population with no edge filter, so it can be split cleared-vs-blocked and
compared directly (see `docs/tier-calibration-analysis.md` Addendum 14
Part C and its Extension for the original worked example, the 40-45%
tier's cleared-vs-blocked finding). It is **not** part of the day-to-day
tier×league grid — it was removed there for being stale (frozen on
Addendum 14's proxy model and single 2024-08-07+ holdout, never extended
to competitions added since). Before relying on it for anything, refresh
it against the current model per `docs/continuous-roi-methodology.md`, the
same one-look discipline as everything else in this doc — don't treat a
2024-08-07 snapshot as still describing today's threshold. Consult (and
likely refresh) this specifically if the EV-threshold-calibration question
comes up again — e.g. during a future model-upgrade assessment, or before
raising/lowering the live threshold.

## 12. A permanently-excluded population (rule 10) can convert to a date-split boundary — but only as its own explicit, documented decision, never a default.

This is the natural next lifecycle stage for a rule-10 population, once it
has produced a genuine backtest and a practical reason exists to stop
reserving new data. Read rule 10 first if you haven't already — this rule
assumes that one-time baseline pass has already happened.

Once a held-out population has already produced a genuine backtest read that's
been published and acted on (e.g. Addendum 19's League One/League Two look,
the basis for real-money green-flagged cells), it doesn't have to stay
excluded forever to keep that backtest valid. It can split by fixture
**kickoff date** instead of by league:

- Everything with a kickoff strictly before the cutoff stays excluded from
  training forever — preserving exactly the population the backtest was
  computed against, permanently.
- Everything with a kickoff at or after the cutoff becomes training-eligible
  once it resolves, same as every other league on the weekly retrain cycle.

**The cutoff must be anchored to when the backtest was actually computed, not
to the date this rule is applied.** Verify against the reporting commit's
actual timestamp (not a round date), with a conservative margin past the
latest plausible query time, so no fixture that could have contributed to the
already-published number is later folded into training. Check the fixture
count in the gap window between the backtest's read date and the chosen
cutoff before finalizing — a nonzero gap is fine (those fixtures simply
weren't part of the reported population), but it must be checked, not
assumed.

**This is a training-pool-membership decision only.** It does not authorize
touching `avgHomeWinRate`/`avgDrawRate`/`avgAwayWinRate`/`avgGoalsPerGame`/
`marketEfficiency`/`drawBaseWeight`/`homeAdvBaseWeight` (rule 10) for the
affected league — those remain their own separate, still-unearned decision,
regardless of how much new data starts training the GBDT model.

**The population classification that produced the backtest must be decoupled
from the training filter, explicitly, in code — not just in intent.** A
league's `historicalSource: 'real-backtest'` classification (and whatever
constant drives it — `UNSEEN_POPULATION_LEAGUES` in server.js, as of this
writing) must NOT be derived from the same Set/flag as the training-inclusion
filter, and must NOT change when this split is applied. The backtest reading
stays permanently `real-backtest`, frozen, alongside a normal, ever-growing
`Live` reading from post-cutoff resolved bets (the same mechanism every other
league already uses) — this is arguably a *better* end state than an
in-sample league gets, since those only have a walk-forward *proxy*, never a
genuine backtest. Coupling these two concerns to the same on/off flag —
"training-excluded" silently also meaning "has a genuine backtest," or vice
versa — is exactly the mistake this rule exists to prevent, since fixing it
after the fact means either losing a permanent backtest reading or lying
about a league's evidentiary status.

**First applied 2026-08-15** for League One (41) / League Two (42): cutoff
`2026-08-11T09:00:00Z`, anchored to the commit timestamp of the temp
diagnostic endpoint that produced Addendum 19's matched-population read
(`2c0ed15`, 2026-08-11T08:13:41+01:00 = 07:13:41 UTC), rounded up to a clean
margin past the latest plausible query time that same morning. Carabao Cup
(48) was deliberately excluded from this split and remains under rule 10's
original permanent, whole-population exclusion — it's paper-only, so there's
no real-money pressure to fold new data in, and no reason to spend any part
of its own future clean-test opportunity early.

## 13. Any correction or adjustment layer applied on top of the core model gets its own train/test discipline — never inherited from an outer or inner layer's history.

The core GBDT model, per-league base rates (`avgHomeWinRate` etc.), and any
correction layer built on top of either (e.g., a per-league variable-strength
adjustment) are distinct tunable parameter sets. Each one's evidentiary
status is bounded strictly by what *that* layer's own parameters have
actually been fit against — not by what a different layer has or hasn't
seen.

Concretely: the core GBDT model has, by design, already trained on nearly
the entire available population for most leagues (see the amendment to rule
1 above). That does **not** disqualify a new correction layer built on top
of it from earning a genuine train/test split of its own — the correction's
parameters don't exist yet, so no population has been spent on them. Reserve
a slice, fit the correction on train only, look at test once, record the
result — rules 1-3, applied fresh to this layer specifically.

The reverse also holds: a population already spent as a genuine backtest for
the core model, or for base rates (rule 10), does not automatically confer
that same status on a new correction layer, and vice versa. Every layer's
claim to being "unseen" must be independently true and independently
checked, never assumed to transfer from a different layer.

This generalizes beyond whichever correction layer was under discussion when
this rule was written — it applies to any future layer of this kind.

## 14. Every distinct "what was genuinely held unseen" claim gets its own distinct, visibly-marked label — never reuse a stronger label for a weaker guarantee.

`historicalSource` is not a fixed two-value enum (`real-backtest` /
`walkforward-proxy`) — it's an open set that grows every time a genuinely
new evidentiary situation appears, including any new correction layer under
rule 13. Before reusing an existing label for a new situation, or
introducing a new one, check:

- What, precisely, was never touched during fitting — the whole pipeline, or
  only one specific layer sitting on an already-in-sample model?
- Does an existing label already make that exact claim, or would applying it
  here overstate what was actually tested?
- Is the distinction rendered visibly wherever the reading appears — not
  just in a tooltip, not just in a code comment — the same standard
  Addendum 21 set for ✓bt vs 🔬?

If the claim is new, the label is new too, with its own marker and its own
one-line description of exactly what was held out. A reading is only as
trustworthy as its label is honest about what it tested — conflating a
partial guarantee with a full one is the same mistake as fitting and testing
on the same data, just moved from the tuning step into the reporting step.

## 15. A rule-10 holdout is temporary by design — it exists only long enough to bank one genuine backtest, then converts immediately to a rule-12 date-split boundary. No new holdout is ever framed as open-ended or permanent.

Rule 10's original framing ("indefinitely," "permanent... exclusion")
described Carabao Cup and Championship more strongly than the underlying
reasoning actually supports. On reflection, a whole-population exclusion
only ever earns its keep for the time it takes to produce the one clean,
unspent read rule 10 exists to protect. Once that read is taken and banked,
continuing to withhold real, resolved fixtures from training has an ongoing
cost (a permanently slightly-duller model on that league, since the weekly
retrain can never see its new results) with no further benefit — the banked
backtest is immutable regardless of what trains afterward, and any future
testing need (a new correction layer, a model upgrade) is better served by
that league's fresh, ordinary, ongoing Live reading than by a standing
reserve nobody is still spending down.

**Practical consequence**: the moment a rule-10 holdout's one deliberate
look is computed and recorded, it converts immediately to rule 12's
date-split mechanism — cutoff anchored to that backtest's own compute date,
never to the date the conversion decision happens to be made. There is no
intermediate "stays permanently held" state to linger in; rule 10 and rule
12 are now understood as one continuous lifecycle, not two independent
choices. First applied 2026-08-24 to Championship (cutoff
2026-08-19T22:00:00Z, its backtest's own compute date — CALIBRATION_AUDIT[40])
and to Carabao Cup (cutoff 2026-08-24T16:00:00Z, anchored to its corrected
re-score's own compute date, following the domestic-blend over-broad-filter
fix documented in `docs/tier-calibration-analysis.md` Addendum 27 —
CALIBRATION_AUDIT[48]).

**A new rule-10 holdout going forward states its own eventual conversion up
front**, in the same commit that creates it — not as a future decision to
revisit, but as the expected, default lifecycle from day one. "Permanent"
or open-ended language should not appear in a new holdout's own
documentation; if a genuine reason exists to hold a specific population
longer than one backtest (real-money pressure absent, as with Carabao Cup
originally), say so as a scheduling reason, not a standing exemption from
this rule.

**This does not touch rule 13's own independent discipline.** A correction
layer's own reserved test population (e.g. the currently-active League Two
multiplier / League One walk-forward work, or H2H-shrinkage k-fitting) is a
separate holdout governed by rule 13, not this rule — it stays reserved for
exactly as long as its own train/test cycle requires. Converting the
underlying league's core-model training-eligibility under this rule has no
bearing on whether a correction layer already built on top of it still has
its own genuinely-unspent test slice; each layer's evidentiary status
remains independently checked per rule 13, regardless of what this rule
does to the layer beneath it.

**A banked reading can still be legitimately corrected for a genuine,
bounded data-quality bug — this is not the same thing as re-peeking because
a result was disappointing, and rule 3's discipline is not weakened by
allowing it.** Discovered 2026-08-24 (Addendum 27): League One's own banked
Addendum 19/24 figures moved (posEdgeN 2,231→2,227, ROI -3.9%→-2.36%) as an
incidental side effect of the Carabao Cup domestic-blend fix — not because
anyone went looking for a better number. A separate, unrelated change
(Championship joining `DOMESTIC_LEAGUE_IDS_FOR_BLEND` on 2026-08-19) meant
44 of 2,231 fixtures, all involving Championship-mainstay clubs, had been
silently resolving their own standings input off a multi-year-stale
fallback snapshot instead of Championship's current form — the same
underlying defect the Carabao Cup fix addressed, just affecting a 0.5%
corner of a different league's already-banked reading. The bar for
accepting a correction like this, rather than treating the original figure
as permanently frozen warts-and-all, is:

1. **A fixture-level trace**, not an aggregate before/after diff — name the
   specific fixtures affected and show their inputs changing for a
   documented reason (Cardiff's standing snapshot dated 2019-05-12 became
   2025-05-03, Birmingham's 2011-05-22 became 2024-05-04, etc.).
2. **A clear, external mechanism** — a specific commit, a specific league
   joining a specific pool, not "the numbers looked different so something
   must have happened."
3. **A bounded scope** — a small, identifiable subset of the population,
   not the whole reading moving in a direction that happens to look better
   (or worse) than before.

All three must hold together. A correction that only clears bar 1 without a
traceable mechanism, or that touches the whole population rather than a
named subset, does not qualify — that is ordinary re-peeking wearing a
correction's clothing, and rule 3 still forbids it. When a correction does
clear the bar, it is documented exactly like a bug fix (because it is one):
the original figure, the corrected figure, and the reason, all left
side by side in `CALIBRATION_AUDIT`'s note and in the addendum log — never
a silent overwrite.

## 16. A "held-out" figure is held out from the *scoring* model's trees, not just from the tuning split.

Every backtest figure in this project that is scored by the live weights is
scored by whatever `gbdt-weights.json` holds at that moment (`models/gbdt.js`
ignores the weights argument it is passed; there is no version archive). That
model built its trees on the earliest 80% of its training pool by date. A
fixture before that boundary is in-sample for the trees regardless of which
side of a league's `testFrom` it sits on.

So no figure may be labelled held-out, validated, test-only or unseen unless
every fixture in it is dated strictly after the scoring model's tree boundary
— read from the weights file's `treeBoundary.firstTestFixtureDate`
(persisted by `gbdt-train.js` from 2026-09-04) or, for the one older deployed
version, from `KNOWN_TREE_BOUNDARIES` in `server.js`. Boundary unknown means
the label cannot be used at all, not that it is assumed fine. Platt-scaling
exposure from the reserved 20% is a weaker, separate form of "seen" — name it
alongside the figure rather than glossing over it. Walk-forward proxy blocks
satisfy this rule by construction (each block's model trains strictly before
its own window). See `docs/model-versioning.md` "Tree boundary" and
Addendum 37 for the incident that produced this rule.

## 17. A pooled calibration factor shared across leagues is a starting default, not a settled fact.

Whenever one calibration figure — the domestic `calibrationFactor`, the
tournament constant, or any future equivalent — is applied to more than one
league, that is a known simplification, to be periodically re-examined, never
a permanent assumption.

This has now bitten twice. Addendum 23 found the original nine leagues and
League One/Two miscalibrated in opposite directions under one shared
treatment, which is what motivated the League Two correction layer. Addendum
39 found the pooled domestic factor of 1.02 was a compromise between two
populations pulling opposite ways: the top divisions' own Brier optimum is
1.06, and Championship, League One and League Two — treated as one group —
individually want 0.93, 0.96 and 0.91. Variation of that size inside a group
already assumed homogeneous should be expected as the norm, not the
exception.

What the rule requires:

- **Check individually once there is enough evidence.** As a league
  accumulates a usable population — a banked backtest or live accumulation
  past the rule-6 floor — its own calibration is compared against the pooled
  figure it currently inherits, using a calibration-accuracy metric (Brier,
  reliability tables), never ROI (rule 4). The check is cheap; it is the
  omission that is expensive.
- **Record the sharing explicitly.** Wherever a shared factor is applied, the
  code or the addendum that set it says which leagues share it and when each
  was last checked individually. "We use one factor for these leagues" must
  be readable as a decision with a date, not discoverable only by tracing.
- **Granularity is a case-by-case decision, not a mandate.** Finding that a
  league's own optimum differs from the pooled figure does not by itself
  require a per-league factor. Whether to split is a cost/complexity/live-
  impact judgement — a factor change moves every Kelly stake and shifts every
  edge, so it re-expresses any edge-floor rule sitting on top of it (Addendum
  37 Part D2, Addendum 39 Part E). What the rule mandates is that the choice
  to keep sharing is made knowingly and revisited, not inherited silently.
- **Re-express thresholds when a factor changes.** Any edge floor selected
  under one factor is a different rule under another. A factor change and the
  rule that depends on it are decided together, in one documented step, with
  the floor restated on the new scale — never the factor first and the
  threshold "later".
- **Factors live in code, never in a runtime setting (2026-09-04).** Every
  league's factor is a named constant resolved by `getCalFactorForLeague()`
  (`RULE12_CALIBRATION_FACTOR`, `TOP_DIVISION_CALIBRATION_FACTOR`,
  `TOURNAMENT_CALIBRATION_FACTOR`, with `UNCLASSIFIED_CALIBRATION_FACTOR` as
  the fallback for a league not yet placed in a cohort). The old editable
  `settings.calibrationFactor` — the Settings-tab input and the Model-tab
  "Apply suggested factor" button — is gone by design: `PUT /api/settings`
  rejects the key with a 400, a stale value left in `settings.json` is ignored,
  and the Settings tab shows each cohort's factor, floor, stake status and
  member leagues read-only from `/api/admin/calibration-factors`. The only
  way to change a factor is a reviewed commit that changes the constant and
  restates the dependent edge floor together (previous bullet). This closes
  the remaining route by which a live edit could silently override a
  cohort factor, now or as further leagues are added.

Related: rule 1's note on the two meanings of "for every league"; rule 13
(correction layers get their own discipline); rule 16 (which model scored
the figure). See `docs/tier-calibration-analysis.md` Addenda 23 and 39, and
`getCalFactorForLeague()` in `server.js` for where the sharing currently
lives.
