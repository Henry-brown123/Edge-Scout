'use strict';

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const cron   = require('node-cron');
const sc     = require('./scoring');

const API_KEY  = '36e45a67eec7cabd0a51db8f2570f934';
const DATA_DIR = path.join(__dirname, 'data');

const api = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': API_KEY },
  timeout: 15000,
});

// Leagues scanned each morning
const SCAN_LEAGUES = [
  { id: 1,   season: 2026, name: 'World Cup 2026',      oddsKey: 'soccer_fifa_world_cup' },
  { id: 39,  season: 2024, name: 'Premier League',      oddsKey: 'soccer_epl' },
  { id: 140, season: 2024, name: 'La Liga',              oddsKey: 'soccer_spain_la_liga' },
  { id: 135, season: 2024, name: 'Serie A',              oddsKey: 'soccer_italy_serie_a' },
  { id: 78,  season: 2024, name: 'Bundesliga',           oddsKey: 'soccer_germany_bundesliga' },
  { id: 61,  season: 2024, name: 'Ligue 1',              oddsKey: 'soccer_france_ligue_1' },
  { id: 2,   season: 2024, name: 'Champions League',     oddsKey: 'soccer_uefa_champions_league' },
];

// Stadium coordinates keyed by city name (lowercase)
const COORDS = {
  // World Cup 2026
  'east rutherford': { lat: 40.8135, lon: -74.0745 },
  'new york':        { lat: 40.8135, lon: -74.0745 },
  'inglewood':       { lat: 33.9535, lon: -118.3392 },
  'los angeles':     { lat: 33.9535, lon: -118.3392 },
  'arlington':       { lat: 32.7479, lon: -97.0945 },
  'dallas':          { lat: 32.7479, lon: -97.0945 },
  'santa clara':     { lat: 37.4032, lon: -121.9696 },
  'san francisco':   { lat: 37.4032, lon: -121.9696 },
  'miami gardens':   { lat: 25.9580, lon: -80.2388 },
  'miami':           { lat: 25.9580, lon: -80.2388 },
  'seattle':         { lat: 47.5952, lon: -122.3316 },
  'foxborough':      { lat: 42.0909, lon: -71.2643 },
  'boston':          { lat: 42.0909, lon: -71.2643 },
  'houston':         { lat: 29.6847, lon: -95.4107 },
  'kansas city':     { lat: 39.0489, lon: -94.4840 },
  'philadelphia':    { lat: 39.9012, lon: -75.1673 },
  'atlanta':         { lat: 33.7553, lon: -84.4006 },
  'vancouver':       { lat: 49.2769, lon: -123.1108 },
  'toronto':         { lat: 43.6336, lon: -79.5890 },
  'guadalajara':     { lat: 20.6851, lon: -103.4660 },
  'monterrey':       { lat: 25.6693, lon: -100.2488 },
  'mexico city':     { lat: 19.3030, lon: -99.1504 },
  // Europe
  'london':          { lat: 51.5074, lon: -0.1278 },
  'manchester':      { lat: 53.4631, lon: -2.2913 },
  'liverpool':       { lat: 53.4308, lon: -2.9609 },
  'birmingham':      { lat: 52.4548, lon: -1.8983 },
  'newcastle':       { lat: 54.9756, lon: -1.6217 },
  'madrid':          { lat: 40.4531, lon: -3.6883 },
  'barcelona':       { lat: 41.3809, lon:  2.1228 },
  'seville':         { lat: 37.3841, lon: -5.9714 },
  'munich':          { lat: 48.2188, lon: 11.6247 },
  'berlin':          { lat: 52.5147, lon: 13.4492 },
  'dortmund':        { lat: 51.4926, lon:  7.4519 },
  'milan':           { lat: 45.4781, lon:  9.1240 },
  'rome':            { lat: 41.9341, lon: 12.4547 },
  'turin':           { lat: 45.1096, lon:  7.6413 },
  'naples':          { lat: 40.8279, lon: 14.1931 },
  'paris':           { lat: 48.9244, lon:  2.3601 },
  'lyon':            { lat: 45.7652, lon:  4.9822 },
  'amsterdam':       { lat: 52.3143, lon:  4.9422 },
  'lisbon':          { lat: 38.7634, lon: -9.1845 },
};

// ── Data helpers ─────────────────────────────────────────────────────────────

function read(file, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return def; }
}

function write(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ── Weather ───────────────────────────────────────────────────────────────────

async function getWeather(city, kickoffISO) {
  const coords = COORDS[city?.toLowerCase?.()];
  if (!coords) return null;
  try {
    const { data } = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: coords.lat, longitude: coords.lon,
        hourly: 'precipitation_probability,windspeed_10m,weathercode',
        forecast_days: 7, timezone: 'auto',
      },
      timeout: 8000,
    });
    const times = data.hourly?.time || [];
    const kickoffHour = new Date(kickoffISO).toISOString().slice(0, 13);
    // Find closest hour
    let idx = times.findIndex(t => t.replace('T', ' ').slice(0, 13) === kickoffHour.replace('T', ' '));
    if (idx === -1) idx = 0;
    return {
      precipProb: data.hourly.precipitation_probability?.[idx] ?? 0,
      windSpeed:  data.hourly.windspeed_10m?.[idx] ?? 0,
      code:       data.hourly.weathercode?.[idx] ?? 0,
    };
  } catch { return null; }
}

// ── Form data (multi-season) ──────────────────────────────────────────────────

async function getFormFixtures(teamId, leagueId, season) {
  const seasons = [season, season - 1];
  const results = await Promise.allSettled(
    seasons.map(s =>
      api.get('/fixtures', { params: { team: teamId, league: leagueId, season: s, last: 30 } })
         .catch(() => ({ data: { response: [] } }))
    )
  );
  return results
    .flatMap(r => r.status === 'fulfilled' ? r.value?.data?.response || [] : [])
    .filter(f => f.fixture?.status?.short === 'FT')
    .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));
}

// ── Score a fixture (used in both Stage 1 & 2) ───────────────────────────────

async function scoreFixture(fix, standings, weights) {
  const homeId  = fix.teams?.home?.id;
  const awayId  = fix.teams?.away?.id;
  const leagueId = fix.league?.id;
  const season   = fix.league?.season;

  const [h2hRes, injRes, homeFormRes, awayFormRes] = await Promise.allSettled([
    api.get('/fixtures/headtohead', { params: { h2h: `${homeId}-${awayId}`, last: 5 } }),
    api.get('/injuries',            { params: { fixture: fix.fixture?.id } }),
    getFormFixtures(homeId, leagueId, season),
    getFormFixtures(awayId, leagueId, season),
  ]);

  const h2h      = h2hRes.status     === 'fulfilled' ? h2hRes.value?.data?.response     || [] : [];
  const injuries = injRes.status     === 'fulfilled' ? injRes.value?.data?.response     || [] : [];
  const homeForm = homeFormRes.status === 'fulfilled' ? homeFormRes.value : [];
  const awayForm = awayFormRes.status === 'fulfilled' ? awayFormRes.value : [];

  // Dedupe combined form
  const allForm = [...new Map(
    [...homeForm, ...awayForm].map(f => [f.fixture?.id, f])
  ).values()].sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));

  const hf = {
    form:      sc.formScore(allForm, homeId),
    homeAdv:   sc.homeAdvScore(allForm, homeId),
    xg:        sc.xgScore(allForm, homeId),
    h2h:       sc.h2hScore(h2h, homeId),
    defense:   sc.defenseScore(allForm, homeId),
    momentum:  sc.momentumScore(allForm, homeId),
    injuries:  sc.injuryScore(injuries, homeId),
    standings: sc.standingsScore(standings, homeId),
  };
  const af = {
    form:      sc.formScore(allForm, awayId),
    homeAdv:   50,
    xg:        sc.xgScore(allForm, awayId),
    h2h:       100 - sc.h2hScore(h2h, homeId),
    defense:   sc.defenseScore(allForm, awayId),
    momentum:  sc.momentumScore(allForm, awayId),
    injuries:  sc.injuryScore(injuries, awayId),
    standings: sc.standingsScore(standings, awayId),
  };

  const probs = sc.computeModelProb(hf, af, weights);
  return { hf, af, probs, h2h, injuries, allForm, standings };
}

// ── Stage 1: Morning scan ────────────────────────────────────────────────────

async function runMorningScan() {
  console.log('[Stage 1] Morning scan starting…');
  const weights  = read('weights.json', sc.DEFAULT_WEIGHTS);
  const today    = new Date().toISOString().split('T')[0];
  const watching = read('watching.json', []);
  const existing = new Set(watching.map(w => w.fixtureId));
  let added = 0;

  for (const league of SCAN_LEAGUES) {
    try {
      const { data } = await api.get('/fixtures', {
        params: { league: league.id, season: league.season, date: today, status: 'NS' },
      });
      const fixtures = data?.response || [];
      if (!fixtures.length) continue;
      console.log(`[Stage 1] ${league.name}: ${fixtures.length} fixtures`);

      let standings = [];
      try {
        const sd = await api.get('/standings', { params: { league: league.id, season: league.season } });
        standings = sd.data?.response?.[0]?.league?.standings || [];
      } catch {}

      for (const fix of fixtures) {
        if (existing.has(fix.fixture.id)) continue;
        try {
          const city    = fix.fixture?.venue?.city?.toLowerCase() || '';
          const weather = await getWeather(city, fix.fixture?.date);
          const { hf, af, probs, allForm } = await scoreFixture(fix, standings, weights);

          // Early watch threshold: any outcome model prob > 38% with 5+ fixtures of data
          const maxProb = Math.max(probs.home, probs.draw, probs.away);
          if (maxProb >= 0.38 && allForm.length >= 5) {
            const entry = {
              fixtureId:  fix.fixture.id,
              league:     league.name,
              leagueId:   league.id,
              season:     league.season,
              fixture:    `${fix.teams.home.name} vs ${fix.teams.away.name}`,
              homeTeam:   fix.teams.home.name,
              awayTeam:   fix.teams.away.name,
              homeId:     fix.teams.home.id,
              awayId:     fix.teams.away.id,
              kickoff:    fix.fixture.date,
              venue:      fix.fixture?.venue?.name,
              city:       fix.fixture?.venue?.city,
              status:     'WATCHING',
              earlyProbs: probs,
              homeFactors: hf,
              awayFactors: af,
              weather,
              fixtureCount: allForm.length,
              scannedAt:  new Date().toISOString(),
            };
            watching.push(entry);
            existing.add(fix.fixture.id);
            added++;
            console.log(`[Stage 1] WATCHING: ${entry.fixture}`);
          }
        } catch (e) {
          console.error(`[Stage 1] Error on ${fix.teams?.home?.name} vs ${fix.teams?.away?.name}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`[Stage 1] ${league.name} error: ${e.message}`);
    }
  }

  write('watching.json', watching);
  console.log(`[Stage 1] Done. ${added} new fixtures added to watchlist.`);
  return watching;
}

// ── Stage 2: Pre-match lock (T-60) ──────────────────────────────────────────

async function runPreMatchScan(entry) {
  console.log(`[Stage 2] T-60 scan: ${entry.fixture}`);
  const weights = read('weights.json', sc.DEFAULT_WEIGHTS);
  const bankroll = read('bankroll.json', { current: 1000 });

  let standings = [];
  try {
    const sd = await api.get('/standings', { params: { league: entry.leagueId, season: entry.season } });
    standings = sd.data?.response?.[0]?.league?.standings || [];
  } catch {}

  // Check for confirmed lineups
  let lineupsConfirmed = false;
  try {
    const ld = await api.get('/fixtures/lineups', { params: { fixture: entry.fixtureId } });
    lineupsConfirmed = (ld.data?.response?.length || 0) >= 2;
  } catch {}

  // Rebuild fresh fixture object for scoring
  const fix = {
    fixture:  { id: entry.fixtureId, date: entry.kickoff, venue: { city: entry.city } },
    teams:    { home: { id: entry.homeId, name: entry.homeTeam }, away: { id: entry.awayId, name: entry.awayTeam } },
    league:   { id: entry.leagueId, season: entry.season },
  };

  const weather = await getWeather(entry.city?.toLowerCase(), entry.kickoff);
  const { hf, af, probs, allForm } = await scoreFixture(fix, standings, weights);

  // Synthetic odds from probabilities with typical bookmaker margin
  const synOdds = {
    home: parseFloat((1 / probs.home * 1.06).toFixed(2)),
    draw: parseFloat((1 / probs.draw * 1.08).toFixed(2)),
    away: parseFloat((1 / probs.away * 1.06).toFixed(2)),
  };

  const candidates = [
    { label: 'Home Win', prob: probs.home, odds: synOdds.home },
    { label: 'Draw',     prob: probs.draw, odds: synOdds.draw },
    { label: 'Away Win', prob: probs.away, odds: synOdds.away },
  ];

  let best = null;
  for (const c of candidates) {
    const score = sc.computeSuccessScore(c.prob, c.odds, allForm.length);
    if (!best || score > best.score) {
      best = { ...c, score, edge: c.prob - 1 / c.odds };
    }
  }

  const watching = read('watching.json', []);
  const idx = watching.findIndex(w => w.fixtureId === entry.fixtureId);

  if (best && best.score >= 40 && best.edge > 0) {
    const k = sc.kelly(best.prob, best.odds, 0.5, bankroll.current);
    const bet = {
      id:               `${entry.fixtureId}_${best.label.replace(/ /g,'_')}`,
      fixtureId:        entry.fixtureId,
      fixture:          entry.fixture,
      league:           entry.league,
      kickoff:          entry.kickoff,
      homeTeam:         entry.homeTeam,
      awayTeam:         entry.awayTeam,
      bet:              best.label,
      modelProb:        parseFloat(best.prob.toFixed(4)),
      bookOdds:         best.odds,
      impliedProb:      parseFloat((1 / best.odds).toFixed(4)),
      edge:             parseFloat(best.edge.toFixed(4)),
      successScore:     best.score,
      stake:            k.stake,
      ev:               parseFloat(((best.prob * (best.odds - 1)) - (1 - best.prob)).toFixed(4)),
      lineupsConfirmed,
      weather,
      homeFactors:      hf,
      awayFactors:      af,
      probs,
      status:           'RECOMMENDED',
      lockedAt:         new Date().toISOString(),
      result:           null,
      won:              null,
      pnl:              null,
      resolvedAt:       null,
      finalScore:       null,
    };

    const bets = read('bets.json', []);
    if (!bets.find(b => b.id === bet.id)) {
      bets.push(bet);
      write('bets.json', bets);
    }

    if (idx !== -1) {
      watching[idx].status       = 'RECOMMENDED';
      watching[idx].betId        = bet.id;
      watching[idx].successScore = best.score;
    }
    console.log(`[Stage 2] LOCKED: ${entry.fixture} — ${best.label} | Score ${best.score} | Stake £${k.stake}`);
  } else {
    if (idx !== -1) {
      watching[idx].status     = 'DROPPED';
      watching[idx].dropReason = best ? `Score ${best.score} < 40` : 'No positive edge';
    }
    console.log(`[Stage 2] DROPPED: ${entry.fixture} (score: ${best?.score ?? 0})`);
  }

  write('watching.json', watching);
}

// ── Auto-resolution ───────────────────────────────────────────────────────────

async function checkAndResolve() {
  const bets = read('bets.json', []);
  const pending = bets.filter(b => b.status === 'RECOMMENDED' && !b.result);
  if (!pending.length) return;

  const bankroll = read('bankroll.json', { starting: 1000, current: 1000 });
  let dirty = false;

  for (const bet of pending) {
    const expectedFinish = new Date(bet.kickoff).getTime() + 115 * 60 * 1000;
    if (Date.now() < expectedFinish) continue;

    try {
      const { data } = await api.get('/fixtures', { params: { id: bet.fixtureId } });
      const fix    = data?.response?.[0];
      const status = fix?.fixture?.status?.short;
      if (!fix || !['FT', 'AET', 'PEN'].includes(status)) continue;

      const hg = fix.goals?.home ?? 0;
      const ag = fix.goals?.away ?? 0;
      const actual = hg > ag ? 'Home Win' : ag > hg ? 'Away Win' : 'Draw';
      const won    = actual === bet.bet;
      const pnl    = won
        ? parseFloat((bet.stake * (bet.bookOdds - 1)).toFixed(2))
        : parseFloat((-bet.stake).toFixed(2));

      const i = bets.findIndex(b => b.id === bet.id);
      bets[i].result     = actual;
      bets[i].won        = won;
      bets[i].pnl        = pnl;
      bets[i].resolvedAt = new Date().toISOString();
      bets[i].finalScore = `${hg}-${ag}`;

      bankroll.current   = parseFloat((bankroll.current + pnl).toFixed(2));
      bankroll.lastUpdated = new Date().toISOString();
      dirty = true;

      console.log(`[Resolve] ${bet.fixture} → ${actual} | ${won ? `WIN +£${pnl}` : `LOSS £${pnl}`} | Bankroll: £${bankroll.current}`);
    } catch (e) {
      console.error(`[Resolve] ${bet.fixture}: ${e.message}`);
    }
  }

  if (dirty) {
    write('bets.json', bets);
    write('bankroll.json', bankroll);
  }
}

// ── Scheduler init ────────────────────────────────────────────────────────────

const scheduledT60 = new Set();

function scheduleT60(entry) {
  if (scheduledT60.has(entry.fixtureId)) return;
  const t60ms   = new Date(entry.kickoff).getTime() - 60 * 60 * 1000;
  const delayMs = t60ms - Date.now();

  scheduledT60.add(entry.fixtureId);

  if (delayMs < -5 * 60 * 1000) {
    // Missed window — run immediately if < 30 min past T-60
    if (delayMs > -30 * 60 * 1000) {
      setTimeout(() => runPreMatchScan(entry), 1000);
      console.log(`[Scheduler] T-60 missed for ${entry.fixture}, running now`);
    }
  } else if (delayMs > 0) {
    setTimeout(() => runPreMatchScan(entry), delayMs);
    console.log(`[Scheduler] T-60 scheduled for ${entry.fixture} in ${Math.round(delayMs / 60000)}min`);
  }
}

function scheduleAllPending() {
  const watching = read('watching.json', []);
  watching.filter(w => w.status === 'WATCHING').forEach(scheduleT60);
}

function initScheduler() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Morning scan at 6am daily
  cron.schedule('0 6 * * *', async () => {
    await runMorningScan();
    scheduleAllPending();
  });

  // Auto-resolution every 5 minutes
  cron.schedule('*/5 * * * *', checkAndResolve);

  // On startup: run morning scan if not yet done today, then schedule T-60s
  const watching = read('watching.json', []);
  const today    = new Date().toISOString().split('T')[0];
  const doneToday = watching.some(w => w.scannedAt?.startsWith(today));

  if (!doneToday) {
    console.log('[Scheduler] No scan today yet — running morning scan in 5s…');
    setTimeout(async () => {
      await runMorningScan();
      scheduleAllPending();
    }, 5000);
  } else {
    console.log('[Scheduler] Already scanned today — scheduling pending T-60s…');
    scheduleAllPending();
  }

  // Also run an immediate resolution pass on startup
  setTimeout(checkAndResolve, 8000);

  console.log('[Scheduler] Ready. Morning scan: 6am. Resolution: every 5min.');
}

module.exports = {
  initScheduler, runMorningScan, runPreMatchScan,
  checkAndResolve, scheduleAllPending,
};
