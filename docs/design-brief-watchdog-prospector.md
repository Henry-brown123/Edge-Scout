# Design brief C — Watchdog and Prospector (2026-09-09)

Status: **design only**. The builds wait on item L (Pinnacle-to-Pinnacle CLV
and per-bet beyond-market residual), because both systems measure against the
market and today no per-bet market-relative quantity exists on the bet record.
Nothing here changes stakes, thresholds or the scorer.

Governing principles (standing, see `calibration-rules.md` and the pocket-based
direction of 2026-09-06): pockets are the unit, not leagues; every pocket is
reported with expected annual volume beside its edge and confidence; a
population is spent by looking at it, so any out-of-sample read is
pre-registered and happens once; findings are tagged model-vs-pipeline.

## 1. Watchdog — is each live pocket still real?

**Unit of monitoring.** One entry per live pocket. Today that is exactly one
staked pocket (League Two, edge ≥13% at 0.93 and prob ≥45%) plus the
observation cohorts. When item B lands, the registry it defines becomes the
watchdog's input; until then, `RESERVED_TEST_SETS` plus the live rule
constants in `server.js` are the list.

**Signal.** Per resolved bet, the beyond-market residual
`r = outcome − p_market`, where `p_market` is Pinnacle's margin-stripped
closing probability for the pick (item L supplies `pinnacleClosingProb` and
`clvPinnacle` on each bet). Closing ROI at the Pinnacle price is reported
beside it. Short-term ROI at the soft-book price is *not* a watchdog input:
it mixes execution, price shopping and variance.

**Decay test, pre-registered.** For each pocket, the banked estimate is the
mean residual from its validation window (League Two cell: +5.9pp, per-bet sd
≈ 0.48). The watchdog maintains a one-sided CUSUM on the residual stream
against the null "mean residual = banked estimate" with the alternative "mean
residual ≤ 0", using a fixed reference value k = banked/2 and decision
interval h chosen for a false-alarm rate of about one per 1,000 bets. It also
reports the plain running mean with its standard error. Both are computed
nightly and summarised weekly; nothing else is read.

**What it can and cannot detect.** Honest power arithmetic: detecting a fall
from +5.9pp to 0 with 80% power at one-sided 5% needs roughly 520 bets, which
at the League Two cell's ~77 bets a season is several seasons. A statistical
watchdog therefore cannot call decay inside one season at current volume. Its
realistic roles are: (a) catching catastrophic breaks quickly, which show up
as many-sigma residual runs (a pipeline change, an odds-source change, a
mis-keyed calibration factor); (b) accumulating the evidence that the
season-end look is defined on; (c) making the per-pocket volume visible so
thin pockets are known to be thin. It never adjusts stakes; it flags.

**Process checks (the fast part).** Alongside the statistical stream, nightly
assertions that fail loudly: closing-odds coverage on resolved bets ≥ 90% for
the last 14 days; `scorerShadowMaxDiff` = 0 while the shadow period runs;
every bet carries `modelVersion`, `scorerVersion`, `pinnacleOddsAtLock`;
the live rule constants match the registry entry that justified them; the
weekly retrain gate wrote a result. These are pipeline failures, not model
findings, and are tagged as such.

**Mechanism.** A scheduled job inside the existing nightly chain, after
Phase 1b (closing odds), writing `watchdog-state.json` and a weekly summary
to the retrain log's sibling file, exposed on a read-only admin route and a
Performance-tab panel. Not an autonomous agent: the job does the same fixed
computation every night and has no discretion to look anywhere else.

## 2. Prospector — where might the next pocket be?

**Search space.** Cells over league × pick side × Pinnacle-implied band ×
model-disagreement band × season phase, later × market type (totals, corners
if ever pooled). Each cell is evaluated on the beyond-market residual and
closing ROI, with its expected annual volume computed from the same window.

**Discipline.** The prospector only ever reads the *training* portion of a
league's population, i.e. fixtures before that league's date-split cutoff
(the same cutoffs the trainer uses), and never a reserved test set. Every
candidate it surfaces is written as a proposal with a pre-registered cell
definition; a human decides whether to register it in `RESERVED_TEST_SETS`,
and only then does a fresh, unread population start accumulating for it.
The prospector never scores a reserved set and has no code path to.

**Multiplicity.** A grid of a few thousand cells will produce dozens of
z ≥ 2 cells by chance. Proposals are ranked by Benjamini–Hochberg-adjusted
significance across the whole grid, require a minimum in-train n of 150 and
an expected annual volume of at least 30 bets, and are reported with both
"high confidence, low volume" and "lower confidence, high volume" framings
rather than collapsing to one score. The League Two grid in Addendum 47 is
the template: the +2–6pp surface across edge ≥10/prob ≥40 survived that
treatment; individual long-odds cells did not.

**Mechanism.** On-demand admin route plus an optional monthly run, output a
Markdown/CSV proposal file under `docs/prospector/` for review. Not an
agent, for the same reason as the watchdog: the constraint that matters is
"do not look", and an agent's value is precisely its freedom to look.

## 3. Dependencies and order

1. **L** — per-bet `pinnacleClosingProb`, `clvPinnacle`, residual. Blocks both.
2. **Watchdog process checks** — can be built the day L lands; the statistical
   stream starts accumulating from the same day.
3. **H cutover** — the prospector's cells are defined on validated
   probabilities; until live and validated probabilities are the same
   quantity, a proposed cell cannot be reproduced exactly at lock.
4. **B (registry)** — turns the watchdog's input from constants into data.
5. **Prospector** — after H and B; its first target is the market-residual
   model's own residual surface once V exists.

Rough size: watchdog ~1 day including the panel; prospector ~2 days plus the
review loop. Both are pipeline work, not model work.
