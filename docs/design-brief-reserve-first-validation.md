# Design brief V — Reserve-first validation for new standalone models (2026-09-21)

Status: **proposal for discussion.** Nothing here is implemented. Written
alongside the overnight new-market search (Addendum 68), which is its first
worked application.

## 1. The problem, stated exactly

A pocket's cutover from the pooled chain to a league's standalone model
needs three things: (a) the standalone is at least as good as the pooled model
on fixtures neither trained on; (b) the pocket's cell is non-negative on the
standalone's outputs on such fixtures; (c) nothing about the rows used for (a)
and (b) was ever used to pick the cell. Today the two live standalones
(League Two V2, League One V2) meet (c) only by waiting: their histories were
mined for cell selection three times over, so their only clean read is
forward, and the rule asks for 300 forward fixtures.

How slow is that, honestly? Two different clocks:

| Clock | League Two today | Time to threshold |
|---|---|---|
| Model-level: 300 matched forward *fixtures* | 73 in six weeks (11 Aug → 21 Sep, one international break) | about 300 by late January 2027 — five months, not seasons |
| Cell-level: bets inside the pocket | 8–9 in six weeks (≈ 35–40 a season) | 100 cell bets ≈ 2.5 seasons; 40 ≈ one season |

The model-level clock is slow but tolerable. **The cell-level clock is the
real problem**, and it is the one the walk-forward twin exercise (Addendum
65) showed a historical holdout can shorten — *if* the holdout was reserved
before anyone selected on it. For League Two and League One that ship has
sailed. For every new market and every new league it has not.

## 2. What the twin exercise established

- A model-level historical read is clean whenever neither model trained on the
  rows (the twin vs pooled on 628 fixtures: log-loss equal, home-rate
  calibration better, top-pick residual −1.8 ± 1.3pp).
- A cell-level historical read is only as clean as the cell's provenance. The
  9/40 shape was chosen on those rows, so its twin reading (77 bets, −0.7pp)
  was descriptive, not evidence.
- The cost of holding out a recent block is small at these sizes. The trainer
  already fits Platt on the newest 20% and trees on the rest; reserving a
  further ~600 fixtures (7% of League Two's 8,200) moved the twin's log-loss
  by nothing measurable against the pooled model.
- The weekly retrain silently contaminated the forward read through Platt
  until the forward-window freeze (Addendum 65 follow-up). Any protocol has to
  freeze its holdout at the data source, not by convention.

## 3. Proposal: reserve first, train second, read once

For **any new standalone model** — a new market in a known league, or a new
league — the build order becomes:

1. **Reserve.** Before any training or any look at recent rows, register the
   holdout: the most recent `H` completed fixtures with a sharp-book close,
   where `H = max(one full season, 600 fixtures)`. The boundary date is
   written to the registry (a `holdoutFrom` per model key) and enforced by
   the trainer exactly as the forward freeze is today: rows on/after
   `holdoutFrom` never enter trees or Platt (`STANDALONE_TRAIN_ALL` stays
   unset). This is the walk-forward twin, made the default and done *before*
   the rows are interesting to anyone.
2. **Train** trees and Platt on rows before `holdoutFrom` (the trainer's
   existing 80/20 split applies inside that range, as now).
3. **Select train-only.** Cells are searched on the *training* rows only
   (rule 18 already allows train-only selection for a new model), by the
   Addendum 53 rule: n ≥ 60, z ≥ 1.5 on the beyond-market residual, ranked
   by units per season; the shortlist size is fixed in code before the look.
4. **One read on the holdout**, model-level and cell-level together: paired
   log-loss and top-pick residual against the reference (the pooled chain for
   a league, the market itself for a new market), plus every shortlisted
   cell's n / residual / z / ROI / units per season, with the rule-19 checks.
   The read is written to the addendum and the holdout is then closed (rule
   18 generalised: it has been read once).
5. **Go live in shadow** with the model retrained on all rows before the
   *registration date* (holdout included now, since it has been read and is
   no longer evidence), forward window frozen as today. The pocket and its
   counterpart tile are registered per rule 20.
6. **Cutover rule for a reserve-first model**: replace "300 forward fixtures,
   residual within 1pp, own cell non-negative" with a **consistency test**:
   ≥ 100 forward fixtures whose model-level residual does not contradict the
   holdout read (within 2 SE of it), and whose cell bets do not sit below
   −5pp. The holdout carried the evidential weight; forward data confirms the
   world has not changed. A model that fails consistency goes back to shadow
   and its holdout read is *not* re-run — a second look would be a second
   selection.

For the two existing standalones nothing changes: their histories are spent,
their 300-forward rule stands, and this brief does not shorten it. That is
the honest cost of the three earlier searches on those rows.

## 4. The trade-off, with numbers

| | Full-history training, forward-only validation (today) | Reserve-first (proposed) |
|---|---|---|
| Training rows | all | all minus H (≈ 7% for League Two, ≈ 10% for a 3-season league) |
| Model strength | marginally higher | the twin showed no measurable loss at H = 628 |
| Clean model-level read | after ~5 months forward | on day one, on H fixtures |
| Clean cell-level read | after 1–2.5 seasons | on day one, on H fixtures, for the pre-registered shortlist only |
| Contamination risk | Platt creep (now frozen) | selection creep — mitigated by writing the shortlist rule before the look and closing the holdout after it |
| Fails when | the world drifts during the long wait | H is too small for the cell (thin pockets: ~35 bets/season → H = one season gives ~35 cell bets, SE ≈ 8pp — still not decisive at cell level) |

The last row is the important caveat. A one-season holdout gives a decisive
*model-level* read and a *directional* cell-level read. For a cell with 35
bets a season, no historical scheme reaches statistical certainty; what the
holdout buys is the ability to reject a bad cell early (a −10pp reading on
35 bets is a real signal) and to promote a good one to shadow with evidence
rather than hope.

## 5. Sizing rule by data available

| Sharp-priced history for the league/market | Protocol |
|---|---|
| ≥ 4 seasons (≥ 2,200 fixtures) | Reserve-first with H = one season; consistency cutover at 100 forward |
| 2–4 seasons | Reserve-first with H = 600 fixtures; consistency cutover at 150 forward |
| 1–2 seasons | Hybrid: H = 300 fixtures as a model-level read only (no cell read); cell validated forward at 300 fixtures as now |
| < 1 season | Forward-only, as today; the model is shadow-only until a season exists |

Totals in League One/Two (Addendum 68) fall in the first band: Pinnacle
prices the main line on every fixture it prices from 2020-21.

## 6. What has to change in code to make this the default

- Registry: a per-model `holdoutFrom` beside the pocket entries; the trainer
  reads it exactly as it reads the forward-freeze cutoff (one map lookup).
- Trainer: no change to the recipe; `TRAIN_BEFORE` already does the cut and
  the archive already records it.
- Search tooling: the totals-search route built tonight is the template — a
  fixed shortlist rule, one test look, rule-19 checks in one call. It needs
  generalising from "market = totals" to "reference = pooled chain or market".
- Cutover diagnostic: add the consistency test beside the 300-fixture rule,
  keyed on whether the model was built reserve-first.
- calibration-rules.md: a rule 21 stating the protocol and the band table.

Rough size: one day, most of it the diagnostic.

## 7. Recommendation

**Adopt reserve-first as the standard for every new standalone model, sized by
the band table in §5, with the consistency cutover for models built that way.
Keep the 300-forward rule for the two existing standalones.** The cost is a
few percent of training rows and one deliberately spent holdout; the return is
a clean model-level answer on day one and a cell-level answer that is either
decisive-negative or credible-positive a season sooner than forward-only
validation can give it. It changes nothing about discipline: the holdout is
read once, the shortlist is fixed before the read, and the forward window
stays frozen.

Decision points for the user: the band thresholds in §5; whether the
consistency cutover's 100-fixture floor is acceptable; whether a reserve-first
model may go straight to paper stakes on its holdout read (recommended) or
must shadow first (safer, slower).
