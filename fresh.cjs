// Fresh-snow and ice-risk measures for the ski sheet, from Open-Meteo's free tier
// (ECMWF IFS 9 km, mid-mountain, 9 seasons). For each resort, averaged over the seasons, inside the
// trip window (10 Dec - 30 Jan; 10 Jul - 30 Aug in the south):
//   thaw days          days whose maximum temperature is above 0 C
//   freeze-thaw days   days that go above 0 C and below -1 C (melt then refreeze: the main cause of ice)
//   sunny days         days with at least 6 hours of sunshine (sun bakes and crusts the snow)
//   rain days          days with at least 1 mm of rain at mid-mountain
//   days since snow    average number of days since the last snowfall of 1 cm or more (how stale the snow is)
//   snow days a week   days with 1 cm or more of snowfall, per week (model; reads low but consistent)
// Progress in fresh_state.json, results in snow_fresh.csv. Stops at the daily limit and resumes next run.
const fs = require('fs'), vm = require('vm');
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
vm.runInThisContext(fs.readFileSync('runner.js', 'utf8'), { filename: 'runner.js' }); // for GEO2
const STATE = 'fresh_state.json', OUT = 'snow_fresh.csv', TOTAL = GEO2.length;
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: {}, fail: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(st));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Daily variable sets tried in order (the first the API accepts is remembered). Temperature comes hourly,
// because the model's daily max/min are often empty; daily max and min are worked out from the hours.
const VARSETS = [['snowfall_sum', 'rain_sum', 'sunshine_duration'], ['snowfall_sum', 'rain_sum']];
const LEAD = 14; // days fetched before the window so "days since snow" starts from real history
let LASTMSG = '';

async function get(u) {
  const r = await fetch(u);
  if (r.status === 429) { const t = await r.text(); throw new Error('429 ' + t.slice(0, 90)); }
  const j = await r.json(); if (j.error) throw new Error(String(j.reason)); return j;
}
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const iso = d => d.toISOString().slice(0, 10);

async function one(i) {
  const [lat, lon, base, top, shf] = GEO2[i]; if (lat == null) throw new Error('no coords');
  const sh = shf === 1, mid = Math.round((base + top) / 2);
  const years = sh ? [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] : [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const per = []; let nullSeasons = 0;
  for (const y of years) {
    const ws = new Date(Date.UTC(y, sh ? 6 : 11, 10)), we = new Date(Date.UTC(sh ? y : y + 1, sh ? 7 : 0, 30));
    const fs0 = new Date(ws.getTime() - LEAD * 86400000);
    const url = vs => `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&elevation=${mid}&start_date=${iso(fs0)}&end_date=${iso(we)}&daily=${vs.join(',')}&hourly=temperature_2m&timezone=auto&models=ecmwf_ifs`;
    let j;
    if (st.vs != null) j = await get(url(VARSETS[st.vs]));
    else {
      for (let v = 0; v < VARSETS.length; v++) {
        try { j = await get(url(VARSETS[v])); st.vs = v; st.vsNote = 'using daily set ' + v; save(); break; }
        catch (err) { const m = String(err.message || err); if (/429|[Dd]aily|fetch failed/.test(m)) throw err; (st.err = st.err || {})['vars' + v] = m.slice(0, 200); save(); }
      }
      if (!j) throw new Error('no variable set accepted');
    }
    const d = j.daily, n = d.time.length;
    const tx = {}, tn = {};
    j.hourly.time.forEach((t, k) => { const v = j.hourly.temperature_2m[k]; if (v == null) return; const day = t.slice(0, 10);
      tx[day] = tx[day] == null ? v : Math.max(tx[day], v); tn[day] = tn[day] == null ? v : Math.min(tn[day], v); });
    d.temperature_2m_max = d.time.map(t => tx[t] == null ? null : tx[t]);
    d.temperature_2m_min = d.time.map(t => tn[t] == null ? null : tn[t]);
    const bad = a => !a || a.some(v => v == null);
    if (bad(d.snowfall_sum) || bad(d.temperature_2m_max)) { nullSeasons++; continue; }
    let since = LEAD; const S = { thaw: 0, ft: 0, sun: 0, sunN: 0, rain: 0, stale: 0, snow: 0, days: 0 };
    for (let k = 0; k < n; k++) {
      const sn = d.snowfall_sum[k];
      since = sn >= 1 ? 0 : since + 1;
      if (k < LEAD) continue;
      S.days++;
      const tx = d.temperature_2m_max[k], tn = d.temperature_2m_min[k];
      if (tx > 0) S.thaw++;
      if (tx > 0 && tn < -1) S.ft++;
      if (d.sunshine_duration && d.sunshine_duration[k] != null) { S.sunN++; if (d.sunshine_duration[k] >= 6 * 3600) S.sun++; }
      if ((d.rain_sum[k] || 0) >= 1) S.rain++;
      if (sn >= 1) S.snow++;
      S.stale += Math.min(since, 30);
    }
    if (S.days < 50) continue;
    const f = 52 / S.days; // scale to the 52-day window
    per.push({ thaw: S.thaw * f, ft: S.ft * f, sun: S.sunN >= 50 ? S.sun * f : null, rain: S.rain * f, stale: S.stale / S.days, snowWk: S.snow / S.days * 7 });
    await sleep(300);
  }
  if (per.length < 5) throw new Error('few seasons ' + per.length + ' (seasons with missing values: ' + nullSeasons + ')');
  const m = k => { const v = per.map(p => p[k]).filter(x => x != null); return v.length ? avg(v) : null; };
  const r1 = x => x == null ? '' : +x.toFixed(1);
  return [i, per.length, mid, r1(m('thaw')), r1(m('ft')), r1(m('sun')), r1(m('rain')), r1(m('stale')), r1(m('snowWk'))];
}

const HEADER = ['#', 'Seasons used', 'Mid-mountain elevation (m)', 'Thaw days in window (of 52)', 'Freeze-thaw days in window (of 52)',
  'Sunny days in window (6 h+ sun; of 52)', 'Rain days at mid-mountain in window (of 52)', 'Average days since last snowfall',
  'Snow days per week at mid-mountain (model)'];
function write(state) {
  const ids = Object.keys(st.done).map(Number).sort((a, b) => a - b);
  fs.writeFileSync(OUT, [HEADER, ...ids.map(i => st.done[i])].map(r => r.join(',')).join('\n') + '\n');
  const failed = Object.keys(st.fail).filter(k => st.fail[k] >= 2 && !st.done[k]);
  const done = state === 'complete' && ids.length + failed.length >= TOTAL;
  const line = `${ids.length} of ${TOTAL} resorts done; stopped: ${state}` + (failed.length ? `; no data for #${failed.join(', #')}` : '');
  fs.writeFileSync('status_fresh.txt', line + '\n' + new Date().toISOString() + '\nlast: ' + LASTMSG + '\n');
  console.log(line);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `done=${done}\n`);
}
async function run() {
  let streak = 0, net = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (st.done[i] || (st.fail[i] || 0) >= 2) continue;
    try { st.done[i] = await one(i); save(); LASTMSG = 'ok ' + i; streak = 0; net = 0; }
    catch (err) {
      LASTMSG = String(err.message || err) + ' @' + i;
      if (/[Dd]aily/.test(LASTMSG)) return 'daily limit';
      if (/429/.test(LASTMSG)) { await sleep(70000); i--; continue; }
      if (/fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(LASTMSG) && (net = (net || 0) + 1) <= 6) { await sleep(30000); i--; continue; }
      st.fail[i] = (st.fail[i] || 0) + 1; (st.err = st.err || {})[i] = LASTMSG.slice(0, 200); save();
      if (++streak >= 5) return 'stopped after 5 errors in a row (saving the daily allowance): ' + LASTMSG.slice(0, 150);
    }
    await sleep(800);
  }
  return 'complete';
}
(async () => {
  const before = Object.keys(st.done).length;
  const cap = new Promise(r => setTimeout(() => r('time cap'), +(process.env.MINUTES || 120) * 60000));
  const state = await Promise.race([run(), cap]);
  console.log('new today', Object.keys(st.done).length - before);
  write(state); process.exit(0);
})().catch(e => { console.error(e); try { write('error: ' + e.message); } catch (_) {} process.exit(1); });
