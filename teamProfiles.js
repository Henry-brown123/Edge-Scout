'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFILES_PATH = path.join(DATA_DIR, 'team-profiles.json');

// Global league average home win rates by fixture context
const LEAGUE_AVG_HOME_WIN_RATE = {
  club_domestic:  0.463,
  club_european:  0.420,
  international:  0.360,
};

// Minimum data thresholds before each modifier is applied — context-aware.
// International thresholds are lower because teams play far fewer fixtures
// per year than club sides. Modifiers are additionally dampened when a
// profile has fewer than 10 data points (see applyTeamProfileModifiers).
const CONTEXT_THRESHOLDS = {
  club_domestic: {
    homeMultiplier:    10,
    awayModifier:      10,
    oppositionAnomaly: 6,
    momentumPattern:   8,
    congestion:        10,
  },
  club_european: {
    homeMultiplier:    10,
    awayModifier:      10,
    oppositionAnomaly: 6,
    momentumPattern:   8,
    congestion:        10,
  },
  international: {
    homeMultiplier:    4,   // WC group stage gives 3 home games — activate early
    awayModifier:      4,
    oppositionAnomaly: 4,
    momentumPattern:   5,
    congestion:        10,  // less relevant for tournaments
  },
};

// Backwards-compatible alias (used in module.exports)
const THRESHOLDS = CONTEXT_THRESHOLDS.club_domestic;

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────

function readProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); }
  catch { return {}; }
}

function saveProfiles(profiles) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

function getTeamProfile(teamId) {
  return readProfiles()[String(teamId)] || null;
}

function getTeamProfiles(teamIds) {
  const all = readProfiles();
  const result = {};
  for (const id of teamIds) result[id] = all[String(id)] || null;
  return result;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function goalResult(fix) {
  const hg = fix.goals?.home ?? fix.score?.fulltime?.home;
  const ag = fix.goals?.away ?? fix.score?.fulltime?.away;
  if (hg == null || ag == null) return null;
  return { h: Number(hg), a: Number(ag) };
}

function deriveContext(fixtures) {
  const { classifyFixture } = require('./scoring');
  const counts = {};
  for (const f of fixtures) {
    const ctx = classifyFixture(f.league?.id);
    counts[ctx] = (counts[ctx] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'club_domestic';
}

// ─── FULL PROFILE BUILD ───────────────────────────────────────────────────────
// Computes all metrics from scratch from a complete fixture history.
// Called during morning scan with all loaded formFixtures.

function buildProfileFromFixtures(teamId, teamName, fixtures) {
  const tid = parseInt(teamId, 10);

  const completed = fixtures
    .filter(f => {
      const g = goalResult(f);
      return g !== null && ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short);
    })
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

  if (!completed.length) return null;

  const context    = deriveContext(completed);
  const thresholds = CONTEXT_THRESHOLDS[context] || CONTEXT_THRESHOLDS.club_domestic;

  // ── Home / Away records ────────────────────────────────────────────────────
  const homeFixtures = completed.filter(f => f.teams?.home?.id === tid);
  const awayFixtures = completed.filter(f => f.teams?.away?.id === tid);

  function calcRecord(fixes, isHome) {
    return fixes.reduce((r, f) => {
      const g = goalResult(f);
      if (!g) return r;
      r.played++;
      const won  = isHome ? g.h > g.a : g.a > g.h;
      const draw = g.h === g.a;
      if (won) r.won++;
      else if (draw) r.drawn++;
      else r.lost++;
      return r;
    }, { played: 0, won: 0, drawn: 0, lost: 0 });
  }

  const homeRecord = calcRecord(homeFixtures, true);
  const awayRecord = calcRecord(awayFixtures, false);
  const homeWinRate    = homeRecord.played > 0 ? homeRecord.won / homeRecord.played : 0;
  const awayWinRate    = awayRecord.played > 0 ? awayRecord.won / awayRecord.played : 0;
  const totalWon       = homeRecord.won + awayRecord.won;
  const totalPlayed    = homeRecord.played + awayRecord.played;
  const overallWinRate = totalPlayed > 0 ? totalWon / totalPlayed : 0.33;

  const leagueAvg             = LEAGUE_AVG_HOME_WIN_RATE[context] || 0.463;
  const homeConfidence        = Math.min(homeRecord.played / 20, 1);
  const awayConfidence        = Math.min(awayRecord.played / 20, 1);
  const homeWinRateMultiplier = homeRecord.played >= thresholds.homeMultiplier
    ? homeWinRate / Math.max(leagueAvg, 0.01)
    : 1.0;

  // ── Opposition anomalies ────────────────────────────────────────────────────
  const oppMap = {};
  for (const f of completed) {
    const isHome  = f.teams?.home?.id === tid;
    const oppId   = isHome ? f.teams?.away?.id : f.teams?.home?.id;
    const oppName = isHome ? f.teams?.away?.name : f.teams?.home?.name;
    const g = goalResult(f);
    if (!g || !oppId) continue;
    const won = isHome ? g.h > g.a : g.a > g.h;
    if (!oppMap[oppId]) oppMap[oppId] = { name: oppName, wins: 0, total: 0 };
    oppMap[oppId].total++;
    if (won) oppMap[oppId].wins++;
  }

  const oppositionAnomalies = Object.entries(oppMap)
    .filter(([, d]) => d.total >= thresholds.oppositionAnomaly)
    .map(([oppId, d]) => {
      const actual       = d.wins / d.total;
      const anomalyScore = actual - overallWinRate;
      return {
        opponentId:      parseInt(oppId, 10),
        opponentName:    d.name,
        expectedWinRate: parseFloat(overallWinRate.toFixed(3)),
        actualWinRate:   parseFloat(actual.toFixed(3)),
        matches:         d.total,
        anomalyScore:    parseFloat(anomalyScore.toFixed(3)),
        significant:     Math.abs(anomalyScore) >= 0.12,
      };
    })
    .sort((a, b) => Math.abs(b.anomalyScore) - Math.abs(a.anomalyScore));

  // ── Momentum patterns ───────────────────────────────────────────────────────
  const seqResults = completed.map(f => {
    const isHome = f.teams?.home?.id === tid;
    const g = goalResult(f);
    if (!g) return null;
    const won  = isHome ? g.h > g.a : g.a > g.h;
    const draw = g.h === g.a;
    const gd   = isHome ? g.h - g.a : g.a - g.h;
    return { won, draw, lost: !won && !draw, gd };
  }).filter(Boolean);

  const ws3 = { wins: 0, total: 0 };
  const ls3 = { wins: 0, total: 0 };
  const hd  = { wins: 0, total: 0 };

  for (let i = 3; i < seqResults.length; i++) {
    const prev3 = seqResults.slice(i - 3, i);
    const cur   = seqResults[i];
    if (prev3.every(r => r.won))  { ws3.total++; if (cur.won) ws3.wins++; }
    if (prev3.every(r => r.lost)) { ls3.total++; if (cur.won) ls3.wins++; }
    if (seqResults[i - 1].gd <= -3) { hd.total++; if (cur.won) hd.wins++; }
  }

  const msCore = d => d.total < thresholds.momentumPattern
    ? { winRate: null, matches: d.total }
    : { winRate: parseFloat((d.wins / d.total).toFixed(3)), matches: d.total };

  const momentumPatterns = {
    afterWinStreak3Plus:  msCore(ws3),
    afterLoseStreak3Plus: msCore(ls3),
    afterHeavyDefeat:     msCore(hd),
  };

  // ── Fixture congestion ──────────────────────────────────────────────────────
  const cong = { wins: 0, total: 0 };
  const norm = { wins: 0, total: 0 };
  const rest = { wins: 0, total: 0 };

  for (let i = 1; i < completed.length; i++) {
    const days = Math.round(
      (new Date(completed[i].fixture.date) - new Date(completed[i - 1].fixture.date)) / 86400000
    );
    const isHome = completed[i].teams?.home?.id === tid;
    const g = goalResult(completed[i]);
    if (!g) continue;
    const won = isHome ? g.h > g.a : g.a > g.h;
    if      (days <= 3) { cong.total++; if (won) cong.wins++; }
    else if (days <= 6) { norm.total++; if (won) norm.wins++; }
    else                { rest.total++; if (won) rest.wins++; }
  }

  const cs = d => d.total >= thresholds.congestion
    ? parseFloat((d.wins / d.total).toFixed(3))
    : null;

  const congestionSensitivity = {
    restedWinRate:    cs(rest),
    normalWinRate:    cs(norm),
    congestedWinRate: cs(cong),
    matches: { rested: rest.total, normal: norm.total, congested: cong.total },
  };

  return {
    teamId:   tid,
    teamName,
    context,
    lastUpdated:           new Date().toISOString(),
    dataPoints:            completed.length,
    homeRecord,
    homeWinRate:           parseFloat(homeWinRate.toFixed(3)),
    homeWinRateMultiplier: parseFloat(homeWinRateMultiplier.toFixed(3)),
    awayRecord,
    awayWinRate:           parseFloat(awayWinRate.toFixed(3)),
    homeConfidence:        parseFloat(homeConfidence.toFixed(3)),
    awayConfidence:        parseFloat(awayConfidence.toFixed(3)),
    overallWinRate:        parseFloat(overallWinRate.toFixed(3)),
    oppositionAnomalies,
    momentumPatterns,
    congestionSensitivity,
    refereePatterns:    {},
    setPieceDependency: null, // Phase 3
    playerDependency:   null, // Phase 3
    // Phase 2: weather sensitivity — builds incrementally as matches resolve.
    // Cannot be backfilled (no historical weather data); starts at 0 for all teams.
    weatherSensitivity: {
      dry:        { wins: 0, matches: 0, winRate: null },
      rain:       { wins: 0, matches: 0, winRate: null },
      heavy_rain: { wins: 0, matches: 0, winRate: null },
      wind:       { wins: 0, matches: 0, winRate: null },
    },
  };
}

// ─── BATCH REBUILD ────────────────────────────────────────────────────────────
// Call during morning scan, passing all deduplicated formFixtures across leagues.
// Rebuilds every team profile from scratch from the available history.

function updateTeamProfiles(fixtures) {
  if (!fixtures || !fixtures.length) return 0;

  const completed = fixtures.filter(f =>
    ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short)
  );
  if (!completed.length) return 0;

  // Group all completed fixtures by team
  const teamData = {};
  for (const fix of completed) {
    const homeId   = fix.teams?.home?.id;
    const awayId   = fix.teams?.away?.id;
    const homeName = fix.teams?.home?.name;
    const awayName = fix.teams?.away?.name;
    if (!homeId || !awayId) continue;
    if (!teamData[homeId]) teamData[homeId] = { name: homeName, fixes: [] };
    if (!teamData[awayId]) teamData[awayId] = { name: awayName, fixes: [] };
    teamData[homeId].fixes.push(fix);
    teamData[awayId].fixes.push(fix);
  }

  const profiles = readProfiles();
  let updated = 0;

  for (const [teamId, { name, fixes }] of Object.entries(teamData)) {
    const profile = buildProfileFromFixtures(teamId, name, fixes);
    if (profile) {
      // Preserve WOWY data built from lineups — not derivable from fixture history alone
      if (profiles[teamId]?.playerDependency) {
        profile.playerDependency = profiles[teamId].playerDependency;
      }
      profiles[teamId] = profile;
      updated++;
    }
  }

  if (updated > 0) {
    saveProfiles(profiles);
    console.log(`[TeamProfiles] Rebuilt ${updated} profiles`);
  }
  return updated;
}

// ─── INCREMENTAL UPDATE ───────────────────────────────────────────────────────
// Call after checkAndResolve for individual results.
// Updates core stats without needing the full fixture history.

function addResultToProfile(teamId, isHome, won, drawn, opponentId, opponentName, goalDiff, weatherCondition) {
  const profiles = readProfiles();
  const p = profiles[String(teamId)];
  if (!p) return; // profile doesn't exist yet — will be built at next morning scan

  const record = isHome ? p.homeRecord : p.awayRecord;
  record.played++;
  if (won) record.won++;
  else if (drawn) record.drawn++;
  else record.lost++;

  const leagueAvg  = LEAGUE_AVG_HOME_WIN_RATE[p.context] || 0.463;
  const thresholds = CONTEXT_THRESHOLDS[p.context] || CONTEXT_THRESHOLDS.club_domestic;
  p.homeWinRate    = p.homeRecord.played > 0 ? p.homeRecord.won / p.homeRecord.played : 0;
  p.awayWinRate    = p.awayRecord.played > 0 ? p.awayRecord.won / p.awayRecord.played : 0;
  const tw         = p.homeRecord.won + p.awayRecord.won;
  const tp         = p.homeRecord.played + p.awayRecord.played;
  p.overallWinRate = tp > 0 ? tw / tp : 0.33;
  p.homeConfidence = Math.min(p.homeRecord.played / 20, 1);
  p.awayConfidence = Math.min(p.awayRecord.played / 20, 1);
  p.homeWinRateMultiplier = p.homeRecord.played >= thresholds.homeMultiplier
    ? p.homeWinRate / Math.max(leagueAvg, 0.01) : 1.0;
  p.dataPoints++;
  p.lastUpdated = new Date().toISOString();

  // Update or add opposition entry
  const existing = p.oppositionAnomalies?.find(a => a.opponentId === opponentId);
  if (existing) {
    const prevWins = Math.round(existing.actualWinRate * existing.matches);
    existing.matches++;
    existing.actualWinRate   = parseFloat(((prevWins + (won ? 1 : 0)) / existing.matches).toFixed(3));
    existing.expectedWinRate = parseFloat(p.overallWinRate.toFixed(3));
    existing.anomalyScore    = parseFloat((existing.actualWinRate - p.overallWinRate).toFixed(3));
    existing.significant     = Math.abs(existing.anomalyScore) >= 0.12;
  } else if (Array.isArray(p.oppositionAnomalies)) {
    p.oppositionAnomalies.push({
      opponentId, opponentName,
      expectedWinRate: parseFloat(p.overallWinRate.toFixed(3)),
      actualWinRate:   parseFloat((won ? 1 : 0).toFixed(3)),
      matches: 1,
      anomalyScore: parseFloat(((won ? 1 : 0) - p.overallWinRate).toFixed(3)),
      significant:  false,
    });
  }

  ['homeWinRate','awayWinRate','overallWinRate','homeWinRateMultiplier','homeConfidence','awayConfidence']
    .forEach(k => { if (typeof p[k] === 'number') p[k] = parseFloat(p[k].toFixed(3)); });

  // Update weather sensitivity
  const wsKey = weatherCondition && ['dry','rain','heavy_rain','wind'].includes(weatherCondition) ? weatherCondition : null;
  if (wsKey && p.weatherSensitivity) {
    if (!p.weatherSensitivity[wsKey]) p.weatherSensitivity[wsKey] = { wins: 0, matches: 0, winRate: null };
    const ws = p.weatherSensitivity[wsKey];
    ws.matches++;
    if (won) ws.wins++;
    ws.winRate = ws.matches > 0 ? parseFloat((ws.wins / ws.matches).toFixed(3)) : null;
  }

  profiles[String(teamId)] = p;
  saveProfiles(profiles);
}

// ─── SCORING PIPELINE MODIFIER ────────────────────────────────────────────────
// Apply team-profile-based adjustments to base model probabilities.
// Returns { probs, applied, notes, teamIntel }.

function applyTeamProfileModifiers(probs, homeProfile, awayProfile, context, dataConf, homeDaysRest, awayDaysRest, weather, opts = {}) {
  const wowyActive = opts.wowyActive ?? true; // default true for backwards compat in tests
  const leagueAvg  = LEAGUE_AVG_HOME_WIN_RATE[context] || 0.463;
  const thresholds = CONTEXT_THRESHOLDS[context] || CONTEXT_THRESHOLDS.club_domestic;

  // For international profiles with fewer than 10 data points, dampen all
  // modifiers proportionally so they contribute lightly until more data exists.
  const intlSparsityDamp = (profile) => {
    if (context !== 'international' || !profile) return 1;
    return Math.min(profile.dataPoints / 10, 1);
  };

  // Summary always returned (even if no modifiers apply) for UI display
  const teamIntel = {
    home: homeProfile ? {
      teamId:                homeProfile.teamId,
      teamName:              homeProfile.teamName,
      dataPoints:            homeProfile.dataPoints,
      homeWinRate:           homeProfile.homeWinRate,
      homeWinRateMultiplier: homeProfile.homeWinRateMultiplier,
      homeConfidence:        homeProfile.homeConfidence,
      homeDaysRest,
      congestionCategory:    homeDaysRest == null ? 'unknown'
                            : homeDaysRest <= 3 ? 'congested'
                            : homeDaysRest <= 6 ? 'normal' : 'rested',
    } : null,
    away: awayProfile ? {
      teamId:      awayProfile.teamId,
      teamName:    awayProfile.teamName,
      dataPoints:  awayProfile.dataPoints,
      awayWinRate: awayProfile.awayWinRate,
      awayConfidence: awayProfile.awayConfidence,
      awayDaysRest,
      congestionCategory: awayDaysRest == null ? 'unknown'
                         : awayDaysRest <= 3 ? 'congested'
                         : awayDaysRest <= 6 ? 'normal' : 'rested',
    } : null,
    oppositionAnomaly: null,
    modifierNotes: [],
    modifierApplied: false,
    leagueAvgHomeWinRate: leagueAvg,
  };

  if (!homeProfile || !awayProfile) {
    return { probs, applied: false, notes: [], teamIntel };
  }

  let { home, draw, away } = probs;
  const notes = [];

  // 1. Home advantage multiplier — dampened by the profile's own homeConfidence, not
  //    the pipeline dataConf (which is near-zero for teams in their first tournament match
  //    even though they have qualifying history in the profile).
  if (homeProfile.homeRecord?.played >= thresholds.homeMultiplier) {
    const mult     = homeProfile.homeWinRateMultiplier || 1.0;
    const profConf = Math.max(homeProfile.homeConfidence, dataConf); // use whichever is higher
    const blended  = profConf * mult + (1 - profConf);
    const dampened = 1 + (blended - 1) * intlSparsityDamp(homeProfile);
    const clamped  = Math.max(0.5, Math.min(2.0, dampened));
    if (Math.abs(clamped - 1) > 0.02) {
      home = home * clamped;
      notes.push(`Home multiplier ×${clamped.toFixed(2)} (${(homeProfile.homeWinRate * 100).toFixed(0)}% vs ${(leagueAvg * 100).toFixed(0)}% avg, ${homeProfile.homeRecord.played} home matches)`);
    }
  }

  // 2. Opposition anomaly
  const anomaly = homeProfile.oppositionAnomalies?.find(
    a => a.opponentId === awayProfile.teamId && a.significant && a.matches >= thresholds.oppositionAnomaly
  );
  if (anomaly) {
    teamIntel.oppositionAnomaly = anomaly;
    const sparsity = intlSparsityDamp(homeProfile);
    const adj = anomaly.anomalyScore * 0.5 * sparsity;
    home += adj;
    away -= adj;
    notes.push(`H2H anomaly: ${adj >= 0 ? '+' : ''}${(adj * 100).toFixed(1)}pp vs ${anomaly.opponentName} (${anomaly.matches} meetings, actual ${(anomaly.actualWinRate * 100).toFixed(0)}% vs ${(anomaly.expectedWinRate * 100).toFixed(0)}% expected)`);
  }

  // 3. Fixture congestion
  function congAdj(profile, daysRest) {
    const cs = profile.congestionSensitivity;
    if (!cs?.normalWinRate || daysRest == null) return 0;
    const cat = daysRest <= 3 ? cs.congestedWinRate
              : daysRest <= 6 ? cs.normalWinRate
              :                 cs.restedWinRate;
    return cat != null ? (cat - cs.normalWinRate) * 0.5 : 0;
  }

  const hAdj = congAdj(homeProfile, homeDaysRest);
  const aAdj = congAdj(awayProfile, awayDaysRest);

  const hAdjFinal = hAdj * intlSparsityDamp(homeProfile);
  const aAdjFinal = aAdj * intlSparsityDamp(awayProfile);
  if (Math.abs(hAdjFinal) > 0.005) {
    home += hAdjFinal;
    notes.push(`Home congestion ${hAdjFinal >= 0 ? '+' : ''}${(hAdjFinal * 100).toFixed(1)}pp (${homeDaysRest}d rest)`);
  }
  if (Math.abs(aAdjFinal) > 0.005) {
    away += aAdjFinal;
    notes.push(`Away congestion ${aAdjFinal >= 0 ? '+' : ''}${(aAdjFinal * 100).toFixed(1)}pp (${awayDaysRest}d rest)`);
  }

  // 4. Weather sensitivity modifier
  // Requires 8+ matches per condition AND a >10pp gap vs dry before applying.
  const weatherCondition = weather?.condition;
  const WEATHER_MIN = 8;
  const WEATHER_GAP = 0.10;

  if (weatherCondition && weatherCondition !== 'clear') {
    const condKey = weatherCondition; // 'rain' | 'heavy_rain' | 'wind'

    function weatherAdj(profile, side) {
      const ws = profile?.weatherSensitivity;
      if (!ws) return 0;
      const dry  = ws.dry;
      const cond = ws[condKey];
      if (!dry || !cond) return 0;
      if (dry.matches < WEATHER_MIN || cond.matches < WEATHER_MIN) return 0;
      if (dry.winRate == null || cond.winRate == null) return 0;
      const diff = cond.winRate - dry.winRate;
      if (Math.abs(diff) < WEATHER_GAP) return 0;
      return diff * 0.5 * intlSparsityDamp(profile); // dampen
    }

    const hWeather = weatherAdj(homeProfile, 'home');
    const aWeather = weatherAdj(awayProfile, 'away');

    if (Math.abs(hWeather) > 0.005) {
      home += hWeather;
      const ws = homeProfile.weatherSensitivity;
      notes.push(`Home weather (${condKey}): ${hWeather >= 0 ? '+' : ''}${(hWeather * 100).toFixed(1)}pp (${(ws[condKey].winRate * 100).toFixed(0)}% vs ${(ws.dry.winRate * 100).toFixed(0)}% dry, ${ws[condKey].matches} matches)`);
    }
    if (Math.abs(aWeather) > 0.005) {
      away += aWeather;
      const ws = awayProfile.weatherSensitivity;
      notes.push(`Away weather (${condKey}): ${aWeather >= 0 ? '+' : ''}${(aWeather * 100).toFixed(1)}pp (${(ws[condKey].winRate * 100).toFixed(0)}% vs ${(ws.dry.winRate * 100).toFixed(0)}% dry, ${ws[condKey].matches} matches)`);
    }

    teamIntel.weatherModifier = {
      condition: condKey,
      precipProbability: weather.precipProbability ?? null,
      windSpeedKmh:      weather.windSpeedKmh ?? null,
      homeAdj: parseFloat((hWeather * 100).toFixed(1)),
      awayAdj: parseFloat((aWeather * 100).toFixed(1)),
      applied: Math.abs(hWeather) > 0.005 || Math.abs(aWeather) > 0.005,
    };
  }

  // Clamp and renormalise
  home = Math.max(0.01, home);
  draw = Math.max(0.01, draw);
  away = Math.max(0.01, away);
  const total = home + draw + away;
  const adjusted = { home: home / total, draw: draw / total, away: away / total };

  teamIntel.modifierNotes   = notes;
  teamIntel.modifierApplied = notes.length > 0;

  return { probs: adjusted, applied: notes.length > 0, notes, teamIntel };
}

// ─── WOWY (WITH OR WITHOUT YOU) ───────────────────────────────────────────────
// Tracks per-player win rates with/without that player in the starting XI.
// starterIds: player IDs who started the match for this team.
// nonStarterIds: squad members who did NOT start (bench/squad).
// result: 'win' | 'draw' | 'loss' from this team's perspective.

// starters / nonStarters accept either plain IDs or {id, name} objects.
function updateWOWY(teamId, starters, nonStarters, result) {
  if (!teamId || !starters?.length) return;
  const profiles = readProfiles();
  const p = profiles[String(teamId)];
  if (!p) return;

  if (!p.playerDependency) p.playerDependency = { players: {} };
  if (!p.playerDependency.players) p.playerDependency.players = {};

  const players = p.playerDependency.players;
  const normalize = entry => typeof entry === 'object' && entry !== null
    ? { id: entry.id, name: entry.name || null }
    : { id: entry, name: null };

  const recordOutcome = (entry, isStarter) => {
    const { id, name } = normalize(entry);
    const key = String(id);
    if (!players[key]) players[key] = { name: null, with: { w: 0, d: 0, l: 0 }, without: { w: 0, d: 0, l: 0 } };
    // Backfill name if we now have it
    if (name && !players[key].name) players[key].name = name;
    const rec = isStarter ? players[key].with : players[key].without;
    if (result === 'win')       rec.w++;
    else if (result === 'draw') rec.d++;
    else                        rec.l++;
  };

  (starters    || []).forEach(e => recordOutcome(e, true));
  (nonStarters || []).forEach(e => recordOutcome(e, false));

  profiles[String(teamId)] = p;
  saveProfiles(profiles);
}

// Returns a map of playerId → WOWY delta (withWinRate - withoutWinRate).
// Returns null for players with insufficient data (< 5 with, < 3 without appearances).

// Returns map of playerId → { name, delta, withRate, withoutRate, wTotal, woTotal, confidence }
// confidence: 'high' (8+ with, 5+ without), 'low' (5+ with, 3+ without), omitted below threshold.
function getWOWYDeltas(teamId) {
  const profile = readProfiles()[String(teamId)];
  const players = profile?.playerDependency?.players;
  if (!players) return {};

  const result = {};
  for (const [playerId, rec] of Object.entries(players)) {
    const w  = rec.with;
    const wo = rec.without;
    const wTotal  = w.w + w.d + w.l;
    const woTotal = wo.w + wo.d + wo.l;
    if (wTotal < 5 || woTotal < 3) continue; // below minimum — exclude entirely
    const withRate    = (w.w + 0.5 * w.d) / wTotal;
    const withoutRate = (wo.w + 0.5 * wo.d) / woTotal;
    result[playerId] = {
      name:        rec.name || null,
      delta:       parseFloat((withRate - withoutRate).toFixed(3)),
      withRate:    parseFloat(withRate.toFixed(3)),
      withoutRate: parseFloat(withoutRate.toFixed(3)),
      wTotal, woTotal,
      confidence:  (wTotal >= 8 && woTotal >= 5) ? 'high' : 'low',
    };
  }
  return result;
}

module.exports = {
  readProfiles,
  saveProfiles,
  getTeamProfile,
  getTeamProfiles,
  buildProfileFromFixtures,
  updateTeamProfiles,
  addResultToProfile,
  applyTeamProfileModifiers,
  updateWOWY,
  getWOWYDeltas,
  LEAGUE_AVG_HOME_WIN_RATE,
  CONTEXT_THRESHOLDS,
  THRESHOLDS,
};
