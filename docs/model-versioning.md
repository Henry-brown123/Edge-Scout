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
demand. This is the only way a retrain runs today. It's **asynchronous**:
the endpoint returns immediately once the training process has started
(`{ success: true, started: true }`); poll **`GET /api/admin/retrain-status`**
for `running` / `success` / `failed` plus the trained model's
`trainedAt`/`trainN`/`testN`/`metrics` and a tail of the training script's
output. It was originally synchronous (`execSync`), which turned out to be a
real problem at this population's size — see "What actually happened running
this for the first time" below.

`/api/server-status`'s `model` block now surfaces `autoRetrainEnabled`,
`retrainPending`, and `retrainPendingSince` so this state is visible without
reading raw files.

**Automating this safely (e.g. auto-retrain with its own quality gates and
rollback) is explicitly future work** — manual control was the priority for
this task, per its own instructions.

## What actually happened running this for the first time

The DATA_DIR fix (`models/gbdt-train.js` reading production data instead of a
stale local snapshot) was necessary but turned out not to be sufficient on
its own — getting a real retrain genuinely live surfaced three more bugs,
each only visible once actual production-scale data and a real deploy cycle
were involved. Recorded in full because each is the kind of thing that looks
fine in isolation and only breaks under real conditions:

1. **`execSync` couldn't handle real data volume.** The first trigger used
   `execSync` with a 5-minute timeout sized for the old 8,316-record file.
   Training on the real ~50,000-record population takes over 20 minutes, and
   `execSync` blocks Node's entire event loop for its whole duration —
   meaning every other live request (scoring, bet placement, dashboard
   reads) would have frozen for that window too, on every future retrain,
   auto-triggered or not. Fixed by switching to `spawn()`
   (non-blocking, `retrain-status.json` for progress/result, polled via
   `GET /api/admin/retrain-status`) with a 40-minute external safety kill.

2. **Require-cache clearing never actually hot-reloaded anything.**
   `checkAndRetrain()`'s original `delete require.cache[...]` after a
   successful retrain did nothing useful: `server.js` holds a permanent
   `const model = require('./models/interface')` reference bound once at
   process startup, and clearing the cache only affects *future* `require()`
   calls, not that existing binding. Every prior retrain could have written
   good weights to disk while the live process kept serving predictions from
   whatever was cached in `models/gbdt.js`'s `_model` variable, until the
   process happened to restart for an unrelated reason. Fixed by having
   `loadModel()` stat the weights file's mtime on every call and reload when
   it changes — no restart dependency.

3. **`gbdt-weights.json` was git-tracked — the critical one.** The first
   successful retrain (confirmed live and correct at the time) was silently
   erased by the very next deploy. Root cause: the weights file lived in
   `models/` — part of the git-tracked code checkout, not `DATA_DIR` (the
   persistent disk) — so every Render deploy re-checked-out the repo and
   overwrote the freshly-trained file with whatever stale version was last
   committed to git. Fixed by moving the file to `DATA_DIR` in all three
   places that touch it (`gbdt-train.js`'s output path, `gbdt.js` and
   `interface.js`'s read paths) and removing it from git entirely (`.gitignore`
   + `git rm --cached`). Bug #2's mtime fix was necessary but not sufficient
   here either — it correctly reloads whenever the file changes, but the
   file itself was getting stomped back to a stale committed version
   independent of that.

4. **`interface.js` routed gbdt-vs-linear only once, at require time —
   found while re-verifying bug #3's fix.** Even after moving the weights
   file to `DATA_DIR`, a process that happened to start before any weights
   file existed there (e.g. the process that started right after bug #3's
   deploy, before a retrain had run again) stayed on the linear fallback
   **forever**, because `interface.js`'s `if (fs.existsSync(weightsPath))`
   check ran exactly once at module load and its result was baked into
   `module.exports`. A retrain finishing later and writing a perfectly good
   file changed nothing for that already-running process. Same class of bug
   as #2, one layer up — fixing #2 alone wasn't enough because the routing
   decision above it was still cached. Fixed the same way: `interface.js`
   now checks file existence fresh on every `predict()`/`getVersion()` call
   instead of caching the routing decision. Also fixed two remaining stale
   `__dirname`-based weights paths (`/api/model-info`, `/api/server-status`)
   that would have kept silently under-reporting the active model even after
   the routing itself was correct.

**Net effect of all four fixes together: the model-loading path is now fully
self-healing on every single call**, with no dependency on restart timing,
require-cache tricks, or remembering to redeploy after a retrain. A retrain
finishing at any point is picked up by the very next prediction anywhere in
the process, and survives deploys because the file lives on the persistent
disk.

**Confirmed final state**, verified two independent ways after all four
fixes were deployed and the process had genuinely restarted (not just a file
read — the actual `model.getVersion()` call from the live prediction path):

```
GET /api/server-status  → model.trainedAt = 2026-08-08T20:56:33.315Z, trainN = 40202
GET /api/debug/model-version-check → liveModelVersion = 2026-08-08T20:56:33.315Z
GET /api/model-info → active: "gbdt", trainN: 40202, testPredict sums to ~1.0
```

All three agree. `trainN=40202` (vs the frozen model's `trainN=6,652`) is the
real, durable result of the first controlled retrain on production data. A
later retrain attempt (log-loss 0.9857) correctly declined to overwrite this
one (log-loss 0.9861) — the improvement-gate in `gbdt-train.js` working
exactly as designed, not a bug: a 0.0004 difference is below its 0.001
meaningful-improvement threshold, so it kept the existing weights rather than
churning for a statistically insignificant change.

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
