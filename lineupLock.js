'use strict';
// Lineup-triggered lock (2026-09-17, Addendum 60). Pure decision logic, no I/O, so
// it can be unit-tested without starting the server.
//
// Timeline per fixture (minutes to kickoff):
//   > POLL_FROM           wait (the T-60±15 pass is the last watching refresh)
//   POLL_FROM .. fallback poll /fixtures/lineups once a minute; lock DELAY minutes
//                         after team sheets first appear (delay 0–3, seeded per fixture)
//   <= fallback           lock regardless ("fallback"; fallback = 25 ± 3, seeded)
// The seeded jitter keeps genuine timing variability: the lock minute depends on
// when the clubs publish (varies fixture to fixture), plus a per-fixture delay,
// and the fallback minute itself varies between T-22 and T-28.
const POLL_FROM_MIN = 40;
const FALLBACK_MIN  = 25;

function seedFor(w, today) {
  return (String(w.id || w.fixtureId || '') + today + 'lineup').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
}
function jitterFor(w, today = new Date().toISOString().slice(0, 10)) {
  const seed = seedFor(w, today);
  return { fallbackAt: FALLBACK_MIN + ((seed % 7) - 3), delayMin: (seed * 7 + Math.floor(seed / 13)) % 4 };
}
// minsTo: minutes to kickoff now; nowMs: epoch ms; lineupsPresent: this minute's poll result (or false if not polled)
function decide(w, minsTo, nowMs, lineupsPresent, today) {
  if (minsTo <= 0) return { action: 'expire' };
  if (minsTo > POLL_FROM_MIN) return { action: 'wait' };
  const j = jitterFor(w, today);
  const seenAt = w._lineupSeenAt ? new Date(w._lineupSeenAt).getTime() : (lineupsPresent ? nowMs : null);
  // Sheets known: lock after the per-fixture delay, or at the fallback minute if that comes first — either way trigger 'lineups'.
  if (seenAt != null && (nowMs >= seenAt + j.delayMin * 60000 || minsTo <= j.fallbackAt)) return { action: 'lock', trigger: 'lineups', seenAt, delayMin: j.delayMin };
  if (minsTo <= j.fallbackAt) return { action: 'lock', trigger: 'fallback', fallbackAt: j.fallbackAt };
  if (seenAt == null) return { action: 'poll', fallbackAt: j.fallbackAt };
  return { action: 'hold', seenAt, delayMin: j.delayMin, locksAt: seenAt + j.delayMin * 60000 };
}
function lineupsComplete(apiResponse) {
  const r = apiResponse?.response;
  return Array.isArray(r) && r.length >= 2 && r.every(t => Array.isArray(t.startXI) && t.startXI.length >= 11);
}
module.exports = { POLL_FROM_MIN, FALLBACK_MIN, jitterFor, decide, lineupsComplete };
