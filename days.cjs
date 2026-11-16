// Day-by-day weather for every resort, for grading each ski day (powder / good / packed / slushy / icy).
// Open-Meteo free tier, ECMWF IFS 9 km, 9 seasons, the trip window (10 Dec - 30 Jan; 10 Jul - 30 Aug in the
// south) plus 10 lead days so each day knows what happened before it.
// Heights are downloaded separately, mid-mountain first, then base, then top (Open-Meteo's rain/snow split
// and temperature depend on the height asked for). Each resort and height is saved as one small file of
// daily summaries worked out from hourly data, so grades can be recalculated without downloading again:
//   data/days/<height>/<resort #>.json.gz
// Progress in days_state.json. Stops at the daily limit and resumes next run.
const fs = require('fs'), vm = require('vm'), zlib = require('zlib'), path = require('path');
const budget = require('./budget.cjs');
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
vm.runInThisContext(fs.readFileSync('runner.js', 'utf8'), { filename: 'runner.js' }); // for GEO2
const STATE = 'days_state.json', TOTAL = GEO2.length, LEAD = 10;
const HEIGHTS = (process.env.HEIGHTS || 'mid,base,top').split(',');
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
for (const h of HEIGHTS) st[h] = st[h] || { done: {}, fail: {}, err: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(st));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VARS = ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'snowfall', 'rain', 'wind_gusts_10m', 'shortwave_radiation'];
// Fields saved for each day (rounded to 0.1):
const FIELDS = ['date',
  'P',    // precipitation, mm
  'S',    // snow, mm of water (Open-Meteo snowfall cm / 0.7)
  'R',    // rain, mm
  'tx', 'tn', 'tm', // max, min, mean temperature, C
  'tam',  // lowest temperature 00:00-08:59 local (overnight refreeze), C
  'h0',   // hours above 0.5 C (surface melting)
  'h1d',  // hours above 1 C between 09:00 and 17:59 local (soft, slushy skiing)
  'ts',   // temperature while snowing, weighted by snowfall, C (blank if no snow)
  'rhs',  // relative humidity while snowing, weighted by snowfall, % (blank if no snow)
  'gx',   // maximum wind gust, km/h
  'gs',   // maximum wind gust in hours with snowfall, km/h (blank if no snow)
  'sw'];  // solar radiation, kWh/m2 for the day
let LASTMSG = '';

async function get(u) {
  budget.take(u);
  const r = await fetch(u);
  if (r.status === 429) { const t = await r.text(); throw new Error('429 ' + t.slice(0, 90)); }
  const j = await r.json(); if (j.error) throw new Error(String(j.reason)); return j;
}
const iso = d => d.toISOString().slice(0, 10);
const r1 = x => x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10;
const elevFor = (h, base, top) => h === 'base' ? base : h === 'top' ? top : Math.round((base + top) / 2);

// Hourly -> daily summaries (local time; Open-Meteo returns local hours with timezone=auto)
function daily(H) {
  const days = new Map();
  for (let k = 0; k < H.time.length; k++) {
    const day = H.time[k].slice(0, 10), hr = +H.time[k].slice(11, 13);
    let d = days.get(day);
    if (!d) { d = { P: 0, S: 0, R: 0, T: [], tam: null, h0: 0, h1d: 0, sT: 0, sRH: 0, gx: null, gs: null, sw: 0, bad: 0 }; days.set(day, d); }
    const t = H.temperature_2m[k], p = H.precipitation[k], sf = H.snowfall[k], rn = H.rain[k], g = H.wind_gusts_10m[k];
    if (t == null || p == null || sf == null || rn == null) { d.bad++; continue; }
    const s = sf / 0.7;
    d.P += p; d.S += s; d.R += rn; d.T.push(t);
    if (hr <= 8) d.tam = d.tam == null ? t : Math.min(d.tam, t);
    if (t > 0.5) d.h0++;
    if (t > 1 && hr >= 9 && hr <= 17) d.h1d++;
    if (s > 0) { d.sT += s * t; d.sRH += s * (H.relative_humidity_2m[k] ?? 0); if (g != null) d.gs = d.gs == null ? g : Math.max(d.gs, g); }
    if (g != null) d.gx = d.gx == null ? g : Math.max(d.gx, g);
    d.sw += (H.shortwave_radiation[k] || 0) / 1000;
  }
  const out = [];
  for (const [day, d] of days) {
    if (d.bad > 2 || d.T.length < 20) return null; // too many missing hours: drop the season
    out.push([day, r1(d.P), r1(d.S), r1(d.R), r1(Math.max(...d.T)), r1(Math.min(...d.T)), r1(d.T.reduce((a, b) => a + b, 0) / d.T.length),
      r1(d.tam), d.h0, d.h1d, d.S > 0 ? r1(d.sT / d.S) : null, d.S > 0 ? Math.round(d.sRH / d.S) : null, r1(d.gx), r1(d.gs), r1(d.sw)]);
  }
  return out;
}

async function one(i, h) {
  const [lat, lon, base, top, shf] = GEO2[i]; if (lat == null) throw new Error('no coords');
  const sh = shf === 1, elev = elevFor(h, base, top);
  budget.need(9 * (LEAD + 52) / 7); // the whole resort must fit in today's budget
  const years = sh ? [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] : [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const seasons = {}; let dropped = 0;
  for (const y of years) {
    const ws = new Date(Date.UTC(y, sh ? 6 : 11, 10)), we = new Date(Date.UTC(sh ? y : y + 1, sh ? 7 : 0, 30));
    const fs0 = new Date(ws.getTime() - LEAD * 86400000);
    const j = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&elevation=${elev}&start_date=${iso(fs0)}&end_date=${iso(we)}&hourly=${VARS.join(',')}&timezone=auto&models=ecmwf_ifs`);
    const d = daily(j.hourly);
    if (!d || d.length < LEAD + 50) { dropped++; } else seasons[y] = d;
    await sleep(300);
  }
  if (Object.keys(seasons).length < 5) throw new Error(`few seasons ${Object.keys(seasons).length} (dropped ${dropped})`);
  const file = path.join('data', 'days', h, i + '.json.gz');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ i, height: h, elev, lat, lon, hemisphere: sh ? 'S' : 'N', lead: LEAD, fields: FIELDS, seasons })));
  return Object.keys(seasons).length;
}

function status(state) {
  const parts = HEIGHTS.map(h => `${h} ${Object.keys(st[h].done).length}/${TOTAL}`);
  const fails = HEIGHTS.flatMap(h => Object.keys(st[h].fail).filter(k => st[h].fail[k] >= 2 && !st[h].done[k]).map(k => h + '#' + k));
  const line = parts.join(', ') + `; stopped: ${state}` + (fails.length ? `; no data for ${fails.join(' ')}` : '');
  fs.writeFileSync('status_days.txt', line + '\n' + new Date().toISOString() + '\nlast: ' + LASTMSG + '\n');
  console.log(line);
  const done = HEIGHTS.every(h => Object.keys(st[h].done).length + Object.keys(st[h].fail).filter(k => st[h].fail[k] >= 2).length >= TOTAL);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `done=${done}\n`);
}

async function run() {
  for (const h of HEIGHTS) {
    let streak = 0, net = 0;
    for (let i = 0; i < TOTAL; i++) {
      const S = st[h];
      if (S.done[i] || (S.fail[i] || 0) >= 2) continue;
      try { S.done[i] = await one(i, h); save(); LASTMSG = `ok ${h} ${i}`; streak = 0; net = 0; }
      catch (err) {
        LASTMSG = String(err.message || err) + ` @${h} ${i}`;
        if (/[Dd]aily/.test(LASTMSG)) return 'daily limit';
        if (/429/.test(LASTMSG)) { await sleep(70000); i--; continue; }
        if (/fetch failed|ECONNRESET|ETIMEDOUT|socket|Unexpected token/i.test(LASTMSG) && ++net <= 6) { await sleep(30000); i--; continue; }
        S.fail[i] = (S.fail[i] || 0) + 1; S.err[i] = LASTMSG.slice(0, 200); save();
        if (++streak >= 5) return 'stopped after 5 errors in a row (saving the daily allowance): ' + LASTMSG.slice(0, 150);
      }
      await sleep(500);
    }
  }
  return 'complete';
}

if (require.main === module) (async () => {
  const cap = new Promise(r => setTimeout(() => r('time cap'), +(process.env.MINUTES || 120) * 60000));
  const state = await Promise.race([run(), cap]);
  status(state); process.exit(0);
})().catch(e => { console.error(e); try { status('error: ' + e.message); } catch (_) {} process.exit(1); });

module.exports = { daily, FIELDS, one };
