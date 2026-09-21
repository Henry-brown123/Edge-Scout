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
  for (const arr of byLeague.values()) {
    arr.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    // prefix sums of home wins (cum[i] = wins in arr[0..i-1]) for O(log n) windows
    const cum = new Array(arr.length + 1); cum[0] = 0;
    for (let i = 0; i < arr.length; i++) cum[i + 1] = cum[i] + arr[i].homeWon;
    arr.cum = cum;
  }
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

// ─── Design brief R (2026-09-21): cross-league regime index ───────────────────
// A per-league 100-fixture window cannot see closed doors (its SE ≈ one
// closed-doors deviation). The anomaly was global, so the index pools every
// league's deviation from its OWN lagged baseline:
//   dev_l  = rolling home rate (last WINDOW fixtures before day) − baseline_l
//   baseline_l = the league's home rate over all its fixtures on days before
//                (day − 365), ≥ BASELINE_MIN_N fixtures (lagged a year so the
//                current regime never contaminates its own reference)
//   dev    = Σ n_l·dev_l / Σ n_l ;  se = sqrt(Σ n_l·b_l(1−b_l)) / Σ n_l
//   gRaw   = dev / se ;  g = 0 inside the dead zone (|gRaw| < DEAD_ZONE), else
//            gRaw clamped to ±G_CLAMP.
// g is exactly zero in a normal season by construction; it reads within weeks
// of a cross-league shift; it cannot see a single-league anomaly (Term A is for
// those).
const DEAD_ZONE = 2, G_CLAMP = 4, BASELINE_LAG_DAYS = 365, BASELINE_MIN_N = 300;
function _lowerBound(arr, day) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].day < day) lo = mid + 1; else hi = mid; } return lo; }
function _shiftDay(day, days) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function leagueBaselineRate(index, leagueId, day) {
  const arr = index?.get?.(parseInt(leagueId, 10));
  if (!arr || !arr.cum) return { rate: null, n: 0 };
  const end = _lowerBound(arr, _shiftDay(day, -BASELINE_LAG_DAYS));
  if (end < BASELINE_MIN_N) return { rate: null, n: end };
  return { rate: arr.cum[end] / end, n: end };
}
// Leagues the index pools: every DOMESTIC league in the pool. Tournament and
// international leagues (retired, Addendum 51) are excluded — kept in lockstep
// with scoring.js RETIRED_LEAGUE_IDS by hand (scoring.js is not required here to
// keep this module dependency-free).
const INDEX_EXCLUDED_LEAGUE_IDS = new Set([1, 2, 3, 48, 848, 4, 5, 6, 7, 8, 9, 10, 31, 32, 33, 34, 960]);
function globalRegime(index, dateIso, leagueIds = null) {
  const day = String(dateIso || '').slice(0, 10);
  if (!index || day.length !== 10) return { dev: null, se: null, gRaw: null, g: 0, n: 0, leagues: 0 };
  const ids = (leagueIds || [...index.keys()]).filter(l => !INDEX_EXCLUDED_LEAGUE_IDS.has(parseInt(l, 10)));
  let sumDev = 0, sumVar = 0, N = 0, leagues = 0;
  for (const lid of ids) {
    const arr = index.get(parseInt(lid, 10)); if (!arr || !arr.cum) continue;
    const lo = _lowerBound(arr, day), start = Math.max(0, lo - LEAGUE_HOME_RATE_WINDOW), n = lo - start;
    if (n < LEAGUE_HOME_RATE_MIN_N) continue;
    const base = leagueBaselineRate(index, lid, day); if (base.rate == null) continue;
    const rolling = (arr.cum[lo] - arr.cum[start]) / n;
    sumDev += n * (rolling - base.rate); sumVar += n * base.rate * (1 - base.rate); N += n; leagues++;
  }
  if (!N) return { dev: null, se: null, gRaw: null, g: 0, n: 0, leagues: 0 };
  const dev = sumDev / N, se = Math.sqrt(sumVar) / N, gRaw = dev / se;
  const g = Math.abs(gRaw) < DEAD_ZONE ? 0 : Math.max(-G_CLAMP, Math.min(G_CLAMP, gRaw));
  return { dev, se, gRaw, g, n: N, leagues };
}

function regimeFor(leagueId, dateIso, index) {
  const { rate, n } = leagueHomeRate(index, leagueId, dateIso);
  const G = globalRegime(index, dateIso);
  return { closedDoors: closedDoorsFlag(leagueId, dateIso), leagueHomeRate: rate, leagueHomeN: n,
    g: +G.g.toFixed(3), gRaw: G.gRaw != null ? +G.gRaw.toFixed(3) : null, globalDev: G.dev != null ? +G.dev.toFixed(4) : null, globalN: G.n };
}

// ─── Design brief R: the offset itself ────────────────────────────────────────
// Coefficients live in code (calibration-rules.md rule 17). null until the fit
// route has run and its result has been reviewed and committed here.
//   pooled:   { deltaHome, deltaDraw }  — MLE on flagged rows, fit window
//   byLeague: { <id>: { deltaHome, deltaDraw, n } } — per-league MLE shrunk
//             toward pooled with prior weight shrinkK
//   gPeak:    the index's SIGNED gRaw at its peak during the fitted regime (Term B scale)
// Term A: δ = coef(league) · closedDoors.
// Term B: δ = coef.pooled · min(1, |g|/|gPeak|) · sign(g)·sign(gPeak), zero in the dead zone.
// Fitted 2026-09-21 (Addendum 64) on rgp-wf2020-none (trees < 2020-06, never saw
// closed doors), bias-corrected probabilities, flagged rows 2020-06-17 → 2021-01-01
// (n 3,058); one test look 2021-01-01 → 2021-08-01 (n 3,188): paired log-loss
// −0.0038 (z −2.19), expected home 45.0% → 40.8% vs 41.2% actual; unflagged rows
// unchanged (diff exactly 0). Per-league MLE shrunk toward pooled with prior
// weight 500. gPeak = the domestic index's signed reading at its closed-doors
// peak (January 2021).
const REGIME_OFFSET = {
  fittedAt: '2026-09-21', model: 'rgp-wf2020-none', fitWindow: ['2020-06-17', '2021-01-01'], testWindow: ['2021-01-01', '2021-08-01'], shrinkK: 500,
  pooled: { deltaHome: -0.225, deltaDraw: -0.085 },
  byLeague: {
    39: { deltaHome: -0.230, deltaDraw: -0.100, n: 247 }, 40: { deltaHome: -0.216, deltaDraw: -0.072, n: 372 },
    41: { deltaHome: -0.261, deltaDraw: -0.177, n: 231 }, 42: { deltaHome: -0.250, deltaDraw: -0.102, n: 248 },
    61: { deltaHome: -0.243, deltaDraw: -0.129, n: 168 }, 78: { deltaHome: -0.273, deltaDraw: -0.040, n: 142 },
    79: { deltaHome: -0.181, deltaDraw: -0.104, n: 142 }, 88: { deltaHome: -0.217, deltaDraw: -0.047, n: 126 },
    94: { deltaHome: -0.178, deltaDraw: -0.072, n: 168 }, 135: { deltaHome: -0.256, deltaDraw: -0.123, n: 262 },
    136: { deltaHome: -0.204, deltaDraw: 0.015, n: 262 }, 140: { deltaHome: -0.242, deltaDraw: -0.047, n: 250 },
    141: { deltaHome: -0.121, deltaDraw: -0.069, n: 321 }, 179: { deltaHome: -0.288, deltaDraw: -0.148, n: 119 },
  },
  gPeak: -4.64,
};
function _logit3(p) { return { lh: Math.log(p.home / p.away), ld: Math.log(p.draw / p.away) }; }
function applyLogOddsOffset(probs, deltaHome, deltaDraw) {
  if (!deltaHome && !deltaDraw) return probs;
  const { lh, ld } = _logit3(probs);
  const eh = Math.exp(lh + deltaHome), ed = Math.exp(ld + deltaDraw), s = eh + ed + 1;
  return { home: eh / s, draw: ed / s, away: 1 / s };
}
// modes: { termA: 'shadow'|'on', termB: 'shadow'|'on'|'killed' }. Returns the
// deltas each term WOULD apply and the ones actually applied under the modes.
function regimeOffsetDeltas(coef, leagueId, regime, modes = {}) {
  const c = coef || REGIME_OFFSET;
  const out = { available: !!c, termA: { closedDoors: regime?.closedDoors ? 1 : 0, deltaHome: 0, deltaDraw: 0, mode: modes.termA || 'shadow' }, termB: { g: regime?.g ?? 0, deltaHome: 0, deltaDraw: 0, mode: modes.termB || 'shadow' }, applied: { deltaHome: 0, deltaDraw: 0 } };
  if (!c) return out;
  const lc = c.byLeague?.[parseInt(leagueId, 10)] || c.pooled;
  if (regime?.closedDoors) { out.termA.deltaHome = lc.deltaHome; out.termA.deltaDraw = lc.deltaDraw; }
  // gPeak is SIGNED (the index reading at the fitted regime's peak, negative for
  // closed doors). An index reading of the same sign reproduces the fitted offset
  // scaled by |g|/|gPeak| (capped at 1); the opposite sign reverses it.
  const g = regime?.g || 0;
  if (g !== 0 && c.gPeak) { const k = Math.min(1, Math.abs(g) / Math.abs(c.gPeak)) * Math.sign(g) * Math.sign(c.gPeak); out.termB.deltaHome = c.pooled.deltaHome * k; out.termB.deltaDraw = c.pooled.deltaDraw * k; }
  // Combination: the two terms describe the SAME regime, so they never add. A
  // dated regime (Term A) takes precedence where it is flagged; Term B acts only
  // where nothing is dated. `combined` is what both-on would apply; `applied` is
  // what the current modes apply.
  const flagged = !!regime?.closedDoors;
  out.combined = flagged ? { deltaHome: out.termA.deltaHome, deltaDraw: out.termA.deltaDraw } : { deltaHome: out.termB.deltaHome, deltaDraw: out.termB.deltaDraw };
  if (flagged && out.termA.mode === 'on') { out.applied.deltaHome = out.termA.deltaHome; out.applied.deltaDraw = out.termA.deltaDraw; }
  else if (!flagged && out.termB.mode === 'on') { out.applied.deltaHome = out.termB.deltaHome; out.applied.deltaDraw = out.termB.deltaDraw; }
  else if (flagged && out.termA.mode !== 'on' && out.termB.mode === 'on') { out.applied.deltaHome = out.termB.deltaHome; out.applied.deltaDraw = out.termB.deltaDraw; } // A not live: B still covers the index
  return out;
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
  DEAD_ZONE, G_CLAMP, BASELINE_LAG_DAYS, BASELINE_MIN_N, REGIME_OFFSET, INDEX_EXCLUDED_LEAGUE_IDS,
  closedDoorsFlag, buildLeagueHomeRateIndex, leagueHomeRate, leagueBaselineRate, globalRegime, regimeFor, regimeFeatureValues, attachRegime,
  applyLogOddsOffset, regimeOffsetDeltas,
};
