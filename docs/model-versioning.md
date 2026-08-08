# Model Versioning, Resolve-Before-Train, and Retrain Control

Written as part of "Final historical snapshot, permanent walk-forward
infrastructure, bug fix, and first controlled retrain" — the task that closed
out the `gbdt-train.js` DATA_DIR bug (see
[tier-calibration-analysis.md](tier-calibration-analysis.md) Addendum 9 for
how it was found, Addendum 12 for the final baseline captured before it was
fixed). This doc exists so the process below doesn't need re-explaining in a
future session.

## Why this exists

The live GBDT model was unknowingly frozen for weeks because nothing recorded
which model version produced a given prediction, nothing verified that only
finished fixtures ever entered a training run, and the retrain trigger could
fire automatically and silently the moment the underlying bug was fixed. This
doc + the infrastructure it describes closes all three gaps.

## Model versioning

Every model exposes a `getVersion()` alongside `predict()`
(`models/interface.js`'s contract):

- `models/gbdt.js` — returns the loaded model's `trainedAt` ISO timestamp.
  This is the model version identifier: unique per training run, already
  present in `gbdt-weights.json`, human-readable, sortable.
- `models/linear.js` — returns the fixed string `'linear-fallback'`. The
  linear model has no training run to version; this only ever activates if
  `gbdt-weights.json` is missing.

`scoreOneFixture()` (server.js) captures `model.getVersion()` once per
prediction, right after the `model.predict()` call, and threads it through:

- the bet object (`bets.json` / `real-bets.json`) as `modelVersion`
- the calibration-log entry (`calibration.json`) as `modelVersion`
- the CSV export (`public/index.html`'s `exportCSV()`) as a `ModelVersion`
  column

A bet's `modelVersion` is set once, at lock time, and never changes — it's a
permanent record of which model produced that specific recommendation,
independent of whatever model is live by the time the bet resolves.

## Resolve-before-train

The production training-data path was already safe: `runHistoricalBackfill()`
Phase 1 (server.js) requests `status: 'FT'` from the API and filters the
response to `['FT','AET','PEN']` before a fixture is ever stored or scored —
no provisional/in-progress result can reach `scoreFixtureFromPool()` through
that path.

What was missing was a defensive check inside `scoreFixtureFromPool()`
(`weightOptimiser.js`) itself — it derived `actualOutcome` from
`goals.home`/`goals.away` being finite numbers, with no check on
`fixture.status.short`. That's fine as long as every caller pre-filters
correctly, but the function had no way to protect itself if a future caller
didn't. Added `FINAL_RESULT_STATUSES = new Set(['FT', 'AET', 'PEN'])` and an
early return if the fixture's status isn't one of them — confirmed
non-breaking, since every fixture that ever reaches this function via the
real pipeline already carries one of those three statuses (verified via
`stripFixture()`, which preserves `fixture.status.short` on every persisted
record).

## Per-model-version sample floor

`/api/tier-performance` now returns a `byModelVersion` array alongside the
existing tier breakdown: `n`, `roi`, and `decisionGrade` per model version
that has resolved live bets. `decisionGrade` uses a **350-bet floor** — the
midpoint of house rule 6's ~300-400 posEdge range, applied as a single
threshold here because this is a whole-version count, not a per-tier cell
(the ~300-400 range itself already accounts for where a genuinely noisy
sample stops looking indicative and starts looking decision-grade).

The Performance tab (all three of paper/real/combined views) surfaces this
under the existing Calibration Tier Performance card, flagging any version
below the floor explicitly rather than showing early results with the same
visual confidence as an established version.

## Retrain control

`checkAndRetrain()` (server.js) still checks the same every-500-scored-record
threshold (`RETRAIN_THRESHOLD = 500`) it always has, but no longer retrains
automatically. It only proceeds if `settings.autoRetrainEnabled === true` —
unset or `false` by default. When the threshold is crossed with auto-retrain
off, it logs that a retrain is due and writes `retrain-pending.json`
(`{ pending: true, thresholdCrossedAt, previousCount, newCount }`) rather
than running anything.

**`POST /api/admin/trigger-retrain`** is the manual path — it runs the exact
same retrain code (`runGbdtRetrain()`, shared with the gated auto-trigger) on
demand and returns the new model's `trainedAt`/`trainN`/`testN`/`metrics` on
success. This is the only way a retrain runs today.

`/api/server-status`'s `model` block now surfaces `autoRetrainEnabled`,
`retrainPending`, and `retrainPendingSince` so this state is visible without
reading raw files.

**Automating this safely (e.g. auto-retrain with its own quality gates and
rollback) is explicitly future work** — manual control was the priority for
this task, per its own instructions.

## The train/test "merge" decision

Once [Addendum 12](tier-calibration-analysis.md)'s final pre-retrain baseline
was captured, the 9 leagues' `VALIDATED_SPLITS` test portions (reserved all
week for clean reporting) stop being treated as reserved — every scored
fixture becomes available for training going forward. This required **no
code change**: `gbdt-train.js` never referenced `VALIDATED_SPLITS` in the
first place — it always drew its own training pool from the entirety of
whatever `backfill-historical.json` it was pointed at, doing its own
internal time-stratified 80/20 split for its own quality-gating purposes
(Platt-scaling fit, log-loss/band-bias gates before writing new weights).
That internal split is a distinct, standard ML-training mechanism — not the
same "holdout" `calibration-rules.md` governs — and stays in place; removing
it would remove the model's only built-in check on whether a newly trained
model is even worth deploying. The concrete effect of "merging test back into
train" is therefore: once the DATA_DIR bug (below) is fixed, `gbdt-train.js`
naturally draws from the full ~48,000-fixture live population, with no
manual exclusion of the fixtures previously called "test" — those are simply
part of the pool it does its own split over now.
