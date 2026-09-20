'use strict';
// ─── Regime features (FD-2, 2026-09-20, Addendum 63) ─────────────────────────
// Two features that let a model see the crowd/home-advantage regime a fixture
// is played under, instead of carrying one static home-advantage assumption
// across every era (Addendum 57 found the model expected 43.5% home wins in
// League One's closed-doors season against 40.3% priced and 40.2% actual;
// Addendum 62 showed no age-based training weight can fix that).
//
//   closedDoors    0|1  — the fixture falls inside a dated no-crowd window for its
//                         league (table below). API-Sports fixture objects carry
//                         no attendance or crowd field, so this is dated by hand
//                         from the public record; it is exact for England, and
//                         approximate where a league ran capped/partial crowds.
//   leagueHomeRate 0..1 — share of home wins across the league's last
//                         LEAGUE_HOME_RATE_WINDOW completed fixtures played on
//                         calendar days strictly before the fixture's day (UTC).
//                         Fully data-derived, needs no dating, and moves for ANY
//                         future anomaly — with a lag of about the window.
//
// Both are computed by ONE function from ONE index and attached to
// homeFactors.regime, so every path that carries factors (live lock, nightly
// pool scoring, stored scoredRecords, trainer, gates, archived-model diagnostics)
// sees the same value by construction. Missing regime → the defaults below,
// which is what a pre-FD-2 model effectively assumed.

const LEAGUE_HOME_RATE_WINDOW = 100;
const LEAGUE_HOME_RATE_MIN_N  = 30;
const LEAGUE_HOME_RATE_DEFAULT = 0.44; // domestic club mean, used below MIN_N

// [from, to) as UTC calendar days. Sources: the leagues' own restart/return
// dates as publicly recorded. "Partial" notes flag where crowds were capped
// rather than absent; those windows are flagged closed because the caps were
// a small fraction of capacity. Regional, club-by-club variation (Germany
// Sept–Oct 2020, Netherlands Sept 2020) is NOT modelled — the flag is a
// league-level date, nothing finer exists in the data.
const CLOSED_DOORS_WINDOWS = {
  // England (Premier League, Championship, League One, League Two): Project
  // Restart 2020-06-17 → fans back at step 3, 2021-05-17. The 2020-12-02 →
  // 2021-01-05 tier pilot (≤2,000/4,000 at a minority of grounds) is kept
  // inside the window. EFL L1/L2 2019-20 was curtailed: only the play-offs
  // (June–July 2020) fall in the window.
  39: [['2020-06-17', '2021-05-17']],
  40: [['2020-06-17', '2021-05-17']],
  41: [['2020-06-17', '2021-05-17']],
  42: [['2020-06-17', '2021-05-17']],
  // Scotland: 2020-21 entirely closed (two 300-fan pilots in Sept 2020);
  // 500-cap from 2021-12-26 until 2022-01-17 (the league brought its winter
  // break forward to sit inside it).
  179: [['2020-08-01', '2021-05-17'], ['2021-12-26', '2022-01-18']],
  // Germany (Bundesliga, 2. Bundesliga): Geisterspiele restart 2020-05-16;
  // regional partial crowds (≤20%, several clubs at zero) 2020-09-18 →
  // 2020-11-01, then closed to season end; nationwide closed again
  // 2021-12-28 → 2022-02-04 (then 10,000 cap).
  78: [['2020-05-16', '2021-05-31'], ['2021-12-28', '2022-02-04']],
  79: [['2020-05-16', '2021-05-31'], ['2021-12-28', '2022-02-04']],
  // Spain (La Liga, Segunda): restart 2020-06-11; no crowds all of 2020-21.
  140: [['2020-06-11', '2021-05-31']],
  141: [['2020-06-11', '2021-05-31']],
  // Italy (Serie A, Serie B): restart 2020-06-20; 1,000-fan allowance
  // 2020-09-19 → 2020-10-24 kept inside the window; closed to season end.
  135: [['2020-06-20', '2021-05-31']],
  136: [['2020-06-20', '2021-05-31']],
  // France: 2019-20 cancelled; 2020-21 opened at a 5,000 cap (2020-08-21),
  // 1,000 from 2020-10-08, closed from 2020-10-30 to season end. Whole
  // season flagged (partial at the start).
  61: [['2020-08-21', '2021-05-31']],
  // Netherlands: 2020-21 opened at ~30% (2020-09-12), closed from 2020-10-04
  // to season end (partial at the start); closed again 2021-11-13 →
  // 2022-01-26 (evening lockdown), then capped.
  88: [['2020-09-12', '2021-05-31'], ['2021-11-13', '2022-01-26']],
  // Portugal: restart 2020-06-03; closed all of 2020-21.
  94: [['2020-06-03', '2021-05-31']],
};

function closedDoorsFlag(leagueId, dateIso) {
  const wins = CLOSED_DOORS_WINDOWS[parseInt(leagueId, 10)];
  if (!wins || !dateIso) return 0;
  const day = String(dateIso).slice(0, 10);
  return wins.some(([from, to]) => day >= from && day < to) ? 1 : 0;
}

const FINAL = new Set(['FT', 'AET', 'PEN']);

// Map<leagueId, [{ day, homeWon }]> sorted by day asc, completed fixtures only.
function buildLeagueHomeRateIndex(fixtures) {
  const byLeague = new Map();
  for (const f of (fixtures || [])) {
    const lid = parseInt(f.league?.id, 10);
    if (!Number.isFinite(lid)) continue;
    if (!FINAL.has(f.fixture?.status?.short)) continue;
    const hg = Number(f.goals?.home ?? f.score?.fulltime?.home), ag = Number(f.goals?.away ?? f.score?.fulltime?.away);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const day = String(f.fixture?.date || '').slice(0, 10);
    if (day.length !== 10) continue;
    if (!byLeague.has(lid)) byLeague.set(lid, []);
    byLeague.get(lid).push({ day, homeWon: hg > ag ? 1 : 0 });
  }
  for (const arr of byLeague.values()) arr.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return byLeague;
}

// Rolling home-win share over the league's last WINDOW completed fixtures on
// days strictly before the fixture's UTC day. Same-day earlier kick-offs are
// deliberately excluded so the live lock (which reads the nightly pool) and the
// historical pool compute the identical value.
function leagueHomeRate(index, leagueId, dateIso, window = LEAGUE_HOME_RATE_WINDOW) {
  const arr = index?.get?.(parseInt(leagueId, 10));
  const day = String(dateIso || '').slice(0, 10);
  if (!arr || !arr.length || day.length !== 10) return { rate: null, n: 0 };
  // first index with entry.day >= day
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].day < day) lo = mid + 1; else hi = mid; }
  const start = Math.max(0, lo - window);
  const n = lo - start;
  if (n < LEAGUE_HOME_RATE_MIN_N) return { rate: null, n };
  let wins = 0;
  for (let i = start; i < lo; i++) wins += arr[i].homeWon;
  return { rate: wins / n, n };
}

function regimeFor(leagueId, dateIso, index) {
  const { rate, n } = leagueHomeRate(index, leagueId, dateIso);
  return { closedDoors: closedDoorsFlag(leagueId, dateIso), leagueHomeRate: rate, leagueHomeN: n };
}

// Feature values as the model sees them (buildFeatures reads these).
function regimeFeatureValues(regime) {
  const r = regime || null;
  return [
    r?.closedDoors ? 1 : 0,
    Number.isFinite(r?.leagueHomeRate) ? r.leagueHomeRate : LEAGUE_HOME_RATE_DEFAULT,
  ];
}

// For records scored before FD-2 (no homeFactors.regime): attach from the
// fixture index so trainer/gates/diagnostics see the same values the nightly
// scorer now stores. Records that already carry it are left alone.
function attachRegime(records, index, { force = false } = {}) {
  let attached = 0;
  for (const r of (records || [])) {
    if (!r?.homeFactors) continue;
    if (r.homeFactors.regime && !force) continue;
    r.homeFactors.regime = regimeFor(r.leagueId, r.date, index);
    attached++;
  }
  return attached;
}

module.exports = {
  CLOSED_DOORS_WINDOWS, LEAGUE_HOME_RATE_WINDOW, LEAGUE_HOME_RATE_MIN_N, LEAGUE_HOME_RATE_DEFAULT,
  closedDoorsFlag, buildLeagueHomeRateIndex, leagueHomeRate, regimeFor, regimeFeatureValues, attachRegime,
};
