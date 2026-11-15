// Long-record snow timing (ERA5, 0.25 deg, seasons from 1991) plus base-of-mountain rain and temperature
// (ECMWF IFS 9 km, seasons from 2017), from Open-Meteo's free tier. Progress in long_state.json,
// results in snow_long.csv. Stops at the daily limit and resumes next run.
const fs = require('fs'), vm = require('vm');
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
vm.runInThisContext(fs.readFileSync('runner.js', 'utf8'), { filename: 'runner.js' }); // for GEO2 and omFmt
const STATE = 'long_state.json', OUT = 'snow_long.csv', TOTAL = GEO2.length;
const FIRST = 1991, LAST = 2025, LAPSE = 0.0065;
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: {}, fail: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(st));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let LASTMSG = '';

async function get(u) {
  const r = await fetch(u);
  if (r.status === 429) { const t = await r.text(); throw new Error('429 ' + t.slice(0, 90)); }
  const j = await r.json(); if (j.error) throw new Error(String(j.reason)); return j;
}
async function seasons(lat, lon, elev, sh, model, years, vars) {
  const out = { time: [] }; vars.forEach(v => out[v] = []);
  for (const y of years) {
    const s = sh ? `${y}-05-01` : `${y}-11-01`, e = sh ? `${y}-10-31` : `${y + 1}-04-30`;
    const j = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&elevation=${elev}&start_date=${s}&end_date=${e}&daily=${vars.join(',')}&timezone=auto&models=${model}`);
    out.time.push(...j.daily.time); vars.forEach(v => out[v].push(...j.daily[v]));
    await sleep(400);
  }
  return out;
}
function bySeason(d, sh, vars) {
  const S = {};
  d.time.forEach((t, k) => {
    const [Y, M, D] = t.split('-').map(Number); if (M === 2 && D === 29) return;
    let sy, inS; if (!sh) { inS = M >= 11 || M <= 4; sy = M >= 11 ? Y : Y - 1; } else { inS = M >= 5 && M <= 10; sy = Y; }
    if (!inS) return; (S[sy] = S[sy] || []).push([t.slice(5), ...vars.map(v => d[v][k])]);
  });
  const L = sh ? 184 : 181;
  return Object.entries(S).filter(([y, a]) => a.length === L && a.every(x => x.slice(1).every(v => v != null))).sort((a, b) => a[0] - b[0]);
}
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const roll = (arr, w) => { let best = -1, bi = 0, c = 0; for (let d = 0; d < arr.length; d++) { c += arr[d]; if (d >= w) c -= arr[d - w]; if (d >= w - 1 && c > best) { best = c; bi = d - w + 1; } } return [best, bi]; };

async function one(i) {
  const [lat, lon, base, top, shf] = GEO2[i]; if (lat == null) throw new Error('no coords');
  const sh = shf === 1, mid = Math.round((base + top) / 2);
  const years = []; for (let y = FIRST; y <= LAST; y++) years.push(y);
  // ERA5 long record (snowfall does not depend on the elevation asked for; temperature does)
  const e = bySeason(await seasons(lat, lon, mid, sh, 'era5', years, ['snowfall_sum']), sh, ['snowfall_sum']);
  if (e.length < 20) throw new Error('few ERA5 seasons ' + e.length);
  const md = e[0][1].map(x => x[0]);
  const mean = md.map((_, d) => avg(e.map(([y, a]) => a[d][1])));
  const [, i7] = roll(mean, 7), [, i30] = roll(mean, 30);
  const ws = md.indexOf(sh ? '07-10' : '12-10'), we = md.indexOf(sh ? '08-30' : '01-30');
  const seasonTot = e.map(([y, a]) => a.reduce((x, z) => x + z[1], 0));
  const winDays = avg(e.map(([y, a]) => a.slice(ws, we + 1).filter(z => z[1] >= 1).length));
  const ten = Math.min(10, Math.floor(e.length / 2));
  const trend = 100 * (avg(seasonTot.slice(-ten)) / avg(seasonTot.slice(0, ten)) - 1);
  // IFS 9 km at the base: rain vs snow and temperature
  const yIfs = sh ? [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] : [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const b = bySeason(await seasons(lat, lon, base, sh, 'ecmwf_ifs', yIfs, ['rain_sum', 'temperature_2m_mean']), sh, ['rain_sum', 'temperature_2m_mean']);
  if (b.length < 3) throw new Error('few IFS seasons ' + b.length);
  const rainDays = avg(b.map(([y, a]) => a.slice(ws, we + 1).filter(z => z[1] >= 1).length));
  const tBase = avg(b.map(([y, a]) => avg(a.slice(ws, we + 1).map(z => z[2]))));
  const tTop = tBase - LAPSE * (top - base);
  return [i, e.length, sh ? `${e[0][0]} to ${e[e.length - 1][0]}` : `${e[0][0]}-${String(+e[0][0] + 1).slice(2)} to ${e[e.length - 1][0]}-${String(+e[e.length - 1][0] + 1).slice(2)}`, omFmt(md[i7]), omFmt(md[i30]),
    +(winDays / (52 / 7)).toFixed(1), Math.round(trend), base, +rainDays.toFixed(1), +tBase.toFixed(1), top, +tTop.toFixed(1)];
}

const HEADER = ['#', 'ERA5 seasons used', 'ERA5 seasons span', 'Best week starts (long record)', 'Best 30 days start (long record)',
  'Snow days per week in window (long record)', 'Season snowfall change: last 10 vs first 10 seasons (%)',
  'Base elevation (m)', 'Rain days at base in window (2017-26)', 'Avg temp at base in window (°C)', 'Top elevation (m)', 'Avg temp at top in window (°C)'];
function write(state) {
  const ids = Object.keys(st.done).map(Number).sort((a, b) => a - b);
  fs.writeFileSync(OUT, [HEADER, ...ids.map(i => st.done[i])].map(r => r.join(',')).join('\n') + '\n');
  const failed = Object.keys(st.fail).filter(k => st.fail[k] >= 2 && !st.done[k]);
  const done = ids.length >= TOTAL || (state === 'complete' && ids.length + failed.length >= TOTAL);
  const line = `${ids.length} of ${TOTAL} resorts done; stopped: ${state}` + (failed.length ? `; no data for #${failed.join(', #')}` : '');
  fs.writeFileSync('status_long.txt', line + '\n' + new Date().toISOString() + '\nlast: ' + LASTMSG + '\n');
  console.log(line);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `done=${done}\n`);
}
async function run() {
  for (let i = 0; i < TOTAL; i++) {
    if (st.done[i] || (st.fail[i] || 0) >= 2) continue;
    try { st.done[i] = await one(i); save(); LASTMSG = 'ok ' + i; }
    catch (err) {
      LASTMSG = String(err.message || err) + ' @' + i;
      if (/[Dd]aily/.test(LASTMSG)) return 'daily limit';
      if (/429/.test(LASTMSG)) { await sleep(70000); i--; continue; }
      st.fail[i] = (st.fail[i] || 0) + 1; save();
    }
    await sleep(1500);
  }
  return 'complete';
}
(async () => {
  const before = Object.keys(st.done).length;
  const cap = new Promise(r => setTimeout(() => r('time cap'), +(process.env.MINUTES || 150) * 60000));
  const state = await Promise.race([run(), cap]);
  console.log('new today', Object.keys(st.done).length - before);
  write(state); process.exit(0);
})().catch(e => { console.error(e); try { write('error: ' + e.message); } catch (_) {} process.exit(1); });
