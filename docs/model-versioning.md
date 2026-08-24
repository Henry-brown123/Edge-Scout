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

## Weekly walk-forward retrain cycle

`checkAndRetrain()`'s every-500-record trigger (above) is now permanently
superseded as the live retrain path — `settings.autoRetrainEnabled` stays
`false` forever, and it exists today only as a dormant threshold-crossing log
(`retrain-pending.json`). The sanctioned, ongoing path is a **fixed weekly
cron**, not a record-count trigger: every fixture that resolves during the
week is scored under whatever model version is live at the time (permanent,
unaffected by the retrain that follows), then folded into the following
week's training pool once its result is final — so every fixture is genuine
out-of-sample evidence at the moment it resolves, and the model keeps
improving from real results without ever being tuned against fixtures it's
also being judged on.

**Schedule**: Mondays 05:15 UTC (`server.js`'s `setupScheduler()`), sequenced
after the nightly backfill's own 05:00 UTC cutoff — so the week's
newly-resolved fixtures are already scored and in `backfill-historical.json`
by the time the cycle runs — and before the 06:00 UTC EV-calibration refresh
and 07:00 UTC morning scan, so it never competes with either for the same
window. Chosen as a low-fixture time of day/week by design.

**What it does** (`runWeeklyRetrainCycle()`):
1. Computes an eligible-fixture snapshot from `backfill-historical.json`
   (`getEligibleTrainingSnapshot()`) — this mirrors `gbdt-train.js`'s own
   filtering for audit-log accuracy; the actual training-time exclusion is
   enforced independently inside `gbdt-train.js` itself (see below).
2. Checks `settings.weeklyRetrainPaused` — if `true`, skips the cycle
   entirely and logs `decision: 'skipped_paused'` with the accumulating
   eligible count carried forward for the next cycle's delta.
3. Otherwise calls `runGbdtRetrain()` — the same underlying training code the
   old manual `/api/admin/trigger-retrain` path uses — and appends a
   `weekly-retrain-log.json` entry once the child process exits.

**Held-aside population stays untouched.** `models/gbdt-train.js`'s
`loadData()` filters out `EXCLUDED_LEAGUE_IDS = new Set([48, 41, 42])`
(Carabao Cup / League One / League Two) before building the training pool.
This population (Addenda 16-19 in
[tier-calibration-analysis.md](tier-calibration-analysis.md),
`calibration-rules.md` rule 10) is deliberately held aside as a future clean
test opportunity — folding it into training must be its own explicit,
separate decision, not something the weekly cycle absorbs automatically.
Before this filter existed, `gbdt-train.js` had **no exclusion mechanism at
all** (see "the train/test merge decision" below) — it always drew from the
entirety of whatever `backfill-historical.json` it was pointed at, so without
this filter the very first weekly cycle would have silently violated rule 10.
Live-tested 2026-08-11: eligible population came in at exactly 50,275
(67,791 total scored fixtures minus 17,516 excluded), confirming the filter
works as intended.

**Memory-safety.** This instance is a 512MB Render `starter` plan with a
proven crash history under synchronous full-population passes (scoring loop,
weight optimiser, team-profile rebuild — all fixed earlier via periodic
`setImmediate` yields). `gbdt-train.js`'s `trainClassifier()` — 200
sequential tree-builds per class, times three classes, entirely synchronous
before this — got the same treatment: `await new Promise(r =>
setImmediate(r))` every 20 trees. This matters even though training runs in
a `spawn()`-ed child process (already isolated from the live server's event
loop) because the child is still a single Node process sharing the same
512MB container ceiling — an unyielding hot loop is the same risk shape, just
relocated. The training script's `main()` also now has a top-level
`.catch()` that logs a clear `FATAL` message and exits non-zero on any
unhandled failure, and `runGbdtRetrain()` distinguishes in its logging
between a clean non-zero exit, its own 40-minute safety-timeout kill, and an
*unexpected* SIGKILL (the OOM-kill signature) — rather than a bare exit code
that can't tell those apart.

Live-tested 2026-08-11 against the real ~50k eligible population (not a
synthetic/reduced test): completed successfully in ~30 minutes, no crash, all
three quality gates passed. The improvement gate correctly declined to
overwrite the deployed weights since log-loss was statistically unchanged
from the currently-deployed version (no new fixtures had accumulated between
the prior manual retrain and this same-day test) — expected behavior, not a
failure.

**Model versioning extends automatically.** Each weekly retrain that clears
the improvement gate produces a new `trainedAt` and gets picked up by the
existing self-healing model-loading path (see "what actually happened"
above) with no code change. The per-model-version sample floor
(`byModelVersion` in `/api/tier-performance`) groups resolved bets by
whatever `modelVersion` string is on each bet — there's no hardcoded list of
versions, so a new weekly version automatically gets its own row and its own
350-bet decision-grade floor the moment bets start resolving against it.

**Manual override.** `settings.weeklyRetrainPaused` (default `false`) is an
explicit, visible control — distinct from `autoRetrainEnabled` — for
skipping a cycle deliberately (e.g. a review in progress, or a week's data
looking anomalous) without touching the cron schedule itself:
- `PUT /api/admin/weekly-retrain-pause` `{ paused: true|false }` — toggle
- `GET /api/admin/weekly-retrain-log` — full audit trail plus current paused
  state and next scheduled run
- `POST /api/admin/trigger-weekly-retrain` — runs the cycle immediately
  (same code path the cron uses), for testing or forcing an off-schedule run

**Audit trail.** Every cycle — whether it retrains, fails, or is skipped —
appends one entry to `weekly-retrain-log.json`: new fixtures folded in since
the last cycle (total and per-league), the resulting `trainN`/`testN`,
whether the version actually changed, and a reference to the previous
version. This is the ongoing, automatic equivalent of what Addendum 12/19's
manual "final snapshot" reports did by hand.

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

## Historical / Live / Combined — the standing framework (Addendum 21)

Every model version, past and future, produces four readings per league × tier
cell on the Performance tab's Calibration Tier Performance grid. This section
is the standing definition — apply it to every future retrain cycle, not just
the one that motivated it.

**Historical** — the best available *out-of-sample-style* read for that
competition, sourced one of two ways depending on whether the competition's
full history was used to train the current live model:

- **Out-of-sample competitions** (never in the live model's training pool —
  Carabao Cup, League One, League Two as of this writing, per
  `EXCLUDED_LEAGUE_IDS` in `gbdt-train.js`): a **genuine backtest** — a real
  train/test split, or for these three specifically the full matched
  population read once as an unseen-population evidence (Addendum 19,
  `calibration-rules.md` rule 10). Marked `historicalSource: 'real-backtest'`
  in `/api/league-tier-matrix`'s `scope.leagues`, rendered with a ✓bt marker.
- **In-sample competitions** (used to train the live model — the 8 original
  domestic leagues plus Champions League and Europa League as of this
  writing): no genuine holdout exists, so Historical is a **walk-forward
  proxy estimate** (Addendum 21) — 4 sequential blocks, each trained on all
  data strictly before that block and tested on the block itself, pooled.
  This describes *how a periodically-retrained model of this design has
  performed*, not a literal test of the exact current live model's weights.
  Marked `historicalSource: 'walkforward-proxy'`, rendered with a 🔬 marker —
  **always visibly, wherever the reading is shown, never only in a tooltip.**
- Any competition with neither (e.g. Conference League, whose own history is
  too thin — Addendum 20 — to backtest on its own) shows `n/a`, not a dash,
  distinguishing "no backtest exists for this competition" from an ordinary
  empty cell within an audited one.

**Live** — real, resolved bets, filtered to `modelVersion === ` the current
live model's version and `resolvedAt >= ` that version's own `trainedAt`. For
GBDT, `getVersion()` *is* the `trainedAt` ISO string, so in practice these are
almost always the same check — both are applied explicitly rather than
assumed equivalent, since a bet resolved before its own model version existed
should never be possible but is worth defending against rather than trusting.
This was tightened by Addendum 21 — previously every resolved bet ever
counted toward "Live," including ones scored by since-superseded versions.
`byModelVersion` (above) is unaffected — it deliberately still spans every
version, that's its whole purpose.

**Combined** — an n-weighted pool of that cell's Historical and Live figures:
`n = H.n + L.n`, `roi = (H.n·H.roi + L.n·L.roi) / n`. The biggest single
sample available for a cell, now computable for every grid-eligible
competition since both out-of-sample and in-sample competitions have a
legitimate Historical figure to pool with. Purely a display-side combination
— touches neither underlying reading, gates nothing.

**Automatic handoff — detection only, action is manual.** When a walk-forward-
sourced competition's Live leg clears the 350-bet decision-grade floor (the
same threshold `byModelVersion` already uses), the grid marks that cell
`⟳handoff` — a visible signal that real live evidence has now accumulated to
where the proxy estimate could be replaced with a genuine backtest, or simply
retired in favour of Live+Combined alone. **This detection is automatic; the
transition itself is not, and should not be** — deciding how to re-validate a
competition is exactly the kind of deliberate, reviewed step
`calibration-rules.md` rules 1-3 require for every other split in this
project, not something safe to trigger from a script. The manual step: when
`⟳handoff` appears, run the same process used for every other league's split
(a genuine time-based train/test boundary, base rates tuned on train only,
single test-set look) and update `WALKFORWARD_HISTORICAL_LEAGUE_IDS` in
`server.js` to drop that league once it has one. The same applies if a future
retrain deliberately holds a competition's data out again (making it
genuinely out-of-sample once more) — that's also a manual decision to make,
not an automatic consequence of a retrain completing.

## Live-scoring modifier toggles (settings-gated, rollback-capable)

`applyTeamProfileModifiers()` (teamProfiles.js) applies several secondary
adjustments on top of the core pool-based model — home/away strength,
fixture congestion, H2H anomaly, weather sensitivity, a transfer-quality
modifier, each gated behind minimum-sample-size thresholds. This layer only
runs in live scoring (`scoreOneFixture`); the historical backfill population
used for every Historical/backtest reading in `docs/tier-calibration-analysis.md`
does not include it — those readings are directionally comparable to live,
not a perfect match, and always have been.

Each modifier that has actually been evaluated against evidence gets an
explicit `settings.json` toggle, so it can be independently rolled back
without a code change if a future look ever contradicts the evidence that
justified it — the same governance discipline `calibration-rules.md` rule 13
requires for the scoring-adjustment correction layer, applied here too:

| Toggle | Default | Evidence | Status |
|---|---|---|---|
| `transferModifierActive` | `true` | Reviewed 2026-07-31 (docs/july-upgrade-notes.md) | Active |
| `homeAwayMultiplierActive` | `true` | Isolate-test: calibration +2.5pp → −0.1pp, ROI CI confidently-negative → inconclusive (Addendum 28) | Active |
| `congestionModifierActive` | `false` | Isolate-test: calibration 2.6pp → 3.0pp (wrong direction), fires on 76% of fixtures, no evidenced benefit (Addendum 28) | Deactivated |

A modifier with **no** toggle here (H2H anomaly, weather sensitivity) is
still running unconditionally, ungoverned — exactly the state home/away
strength and fixture congestion were in before Addendum 28. That's not an
oversight to fix reflexively; it's a backlog item for whenever each gets its
own isolate-test evidence to act on, the same way these two did. Do not add
a toggle without evidence one way or the other — an ungoverned modifier with
no evidence is a known gap, not an urgent one.

**Adding or flipping a toggle**: follow the same sequence used for the
correction-layer deployment (`deployedCorrectionRuleIds` above) — verify
scope (does anything else depend on the current unconditional behavior?),
live-verify against a real current fixture (the Scout-tab drawer's
`modifierNotes` list is the direct surface for this — a deactivated
modifier's note should simply stop appearing, an activated one's note
should appear exactly as before), confirm no retroactive rewrite (this
layer only ever ran in live scoring, so there is no historical population
to worry about contaminating), then document the change in
`docs/tier-calibration-analysis.md`.
