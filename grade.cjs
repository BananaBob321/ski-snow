// Grades every ski day in the trip window from the day-by-day files (data/days/<height>/<#>.json.gz), using the
// cut-offs in grade_config.json. No downloads. Writes snow_grades.csv: for each resort and height, the share of
// window days in each grade, averaged over the seasons. The ski sheet turns the shares into a score with the
// points set there.
// Snow amounts: the model's daily snow water (mm) times a per-resort scale, so the mid-mountain window average
// matches the observed figure in calib.csv (cm per week). Base and top use the mid-mountain scale.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const C = JSON.parse(fs.readFileSync('grade_config.json', 'utf8'));
const HEIGHTS = ['mid', 'base', 'top'], GRADES = ['powder', 'good', 'packed', 'hardpack', 'slushy', 'icysoft', 'icy'];
const NAMES = { powder: 'Powder', good: 'Good', packed: 'Packed', hardpack: 'Hard-packed', slushy: 'Slushy', icysoft: 'Icy then soft', icy: 'Icy' };
const WINDOW = 52;

function load(h, i) {
  const f = path.join('data', 'days', h, i + '.json.gz');
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  const ix = Object.fromEntries(j.fields.map((k, n) => [k, n]));
  for (const y in j.seasons) j.seasons[y] = j.seasons[y].map(r => Object.fromEntries(Object.entries(ix).map(([k, n]) => [k, r[n]])));
  return j;
}

// Model snow water (mm) per window week at this height, averaged over seasons
function modelWeekly(j) {
  const v = Object.values(j.seasons).map(d => d.slice(j.lead).reduce((a, x) => a + x.S, 0) / (d.length - j.lead) * 7);
  return v.reduce((a, b) => a + b, 0) / v.length;
}

// Grade one season. d: days including lead days; k: cm per mm of model snow water.
function gradeSeason(d, lead, k) {
  const n = d.length, cm = d.map(x => x.S * k);
  const wet = d.map(x => x.R >= C.rain_day_mm || x.h0 >= C.melt_hours);
  const sum = (a, b) => { let s = 0; for (let q = Math.max(0, a); q <= b; q++) s += cm[q]; return s; };
  let lastWet = -1, lastCrust = -1, lastSnow = 0; // lastSnow: assume snow at the start of the lead days
  const out = [];
  for (let t = 0; t < n; t++) {
    if (t > 0 && wet[t - 1] && d[t].tam != null && d[t].tam <= C.refreeze_c) lastCrust = t; // crust on this morning
    if (wet[t]) lastWet = t;
    if (cm[t] >= C.good_cm) lastSnow = t;
    if (t < lead) continue;
    const x = d[t];
    let g;
    const icy = lastCrust >= 0 && t - lastCrust < C.icy_days && sum(lastCrust, t) < C.cover_cm;
    if (x.R >= C.rain_day_mm) g = 'slushy';
    else if (icy) g = x.h1d >= C.slushy_hours ? 'icysoft' : 'icy';
    else if (x.h1d >= C.slushy_hours) g = 'slushy';
    else {
      const from = lastWet + 1; // only snow that fell after the last wetting counts as fresh
      const s24 = from <= t ? sum(Math.max(from, t), t) : 0;
      const s48 = from <= t ? sum(Math.max(from, t - 1), t) : 0;
      const s3 = from <= t ? sum(Math.max(from, t - C.good_days + 1), t) : 0;
      if (s24 >= C.powder_24h_cm || s48 >= C.powder_48h_cm) {
        let w = 0, wt = 0, gust = 0;
        for (let q = Math.max(from, t - 1); q <= t; q++) if (d[q].S > 0 && d[q].ts != null) { w += d[q].S; wt += d[q].S * d[q].ts; gust = Math.max(gust, d[q].gs || 0); }
        const tsnow = w ? wt / w : 0;
        g = tsnow <= C.powder_max_snow_temp_c && gust < (C.powder_max_gust_kmh ?? Infinity) ? 'powder' : 'good';
      } else if (s3 >= C.good_cm) g = 'good';
      else g = t - lastSnow > (C.hardpack_days ?? Infinity) ? 'hardpack' : 'packed';
    }
    out.push(g);
  }
  return out;
}

function shares(grades) {
  const c = Object.fromEntries(GRADES.map(g => [g, 0]));
  grades.forEach(g => c[g]++);
  return Object.fromEntries(GRADES.map(g => [g, c[g] / grades.length]));
}
const points = s => GRADES.reduce((a, g) => a + s[g] * C.default_points[g], 0);

function main() {
  const calib = {};
  fs.readFileSync('calib.csv', 'utf8').trim().split('\n').slice(1).forEach(l => { const [i, v] = l.split(','); if (v !== '') calib[+i] = +v; });
  const ids = new Set();
  for (const h of HEIGHTS) { const dir = path.join('data', 'days', h); if (fs.existsSync(dir)) fs.readdirSync(dir).forEach(f => ids.add(parseInt(f))); }
  // per-resort scale from mid-mountain; the median scale for resorts without an observed figure
  const mids = {}, scale = {};
  for (const i of ids) { const j = load('mid', i); if (j) mids[i] = j; }
  for (const i in mids) { const m = modelWeekly(mids[i]); if (calib[i] != null && m > 0) scale[i] = calib[i] / m; }
  const sv = Object.values(scale).sort((a, b) => a - b), med = sv.length ? sv[Math.floor(sv.length / 2)] : 1;

  const head = ['#', 'Heights graded', 'Seasons', 'Snow scale (cm per mm of model snow water)', 'Snow per week used (cm)'];
  for (const h of [...HEIGHTS, 'all']) for (const g of GRADES) head.push(`${h === 'all' ? 'All heights' : h[0].toUpperCase() + h.slice(1)} ${NAMES[g]} (% of days)`);
  head.push('Powder days per week (mid)', 'Day score at default points (all heights)', 'Worst season day score (mid)', 'Best season day score (mid)');
  const rows = [];
  for (const i of [...ids].sort((a, b) => a - b)) {
    const k = scale[i] ?? med, per = {};
    let seasons = 0, worst = null, best = null, powderWk = null, snowWk = null;
    for (const h of HEIGHTS) {
      const j = h === 'mid' ? mids[i] : load(h, i); if (!j) continue;
      const all = [];
      for (const y in j.seasons) {
        const gs = gradeSeason(j.seasons[y], j.lead, k);
        if (gs.length !== WINDOW) continue;
        all.push(gs);
        if (h === 'mid') { const p = points(shares(gs)); worst = worst == null ? p : Math.min(worst, p); best = best == null ? p : Math.max(best, p); }
      }
      if (!all.length) continue;
      per[h] = shares(all.flat());
      if (h === 'mid') { seasons = all.length; powderWk = per.mid.powder * 7; snowWk = modelWeekly(j) * k; }
    }
    const hs = HEIGHTS.filter(h => per[h]);
    if (!hs.length) continue;
    per.all = Object.fromEntries(GRADES.map(g => [g, hs.reduce((a, h) => a + per[h][g], 0) / hs.length]));
    const r = [i, hs.join('+'), seasons, +k.toFixed(3), snowWk == null ? '' : +snowWk.toFixed(1)];
    for (const h of [...HEIGHTS, 'all']) for (const g of GRADES) r.push(per[h] ? +(per[h][g] * 100).toFixed(1) : '');
    r.push(powderWk == null ? '' : +powderWk.toFixed(2), +points(per.all).toFixed(1), worst == null ? '' : +worst.toFixed(1), best == null ? '' : +best.toFixed(1));
    rows.push(r);
  }
  const cell = v => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  fs.writeFileSync('snow_grades.csv', [head, ...rows].map(r => r.map(cell).join(',')).join('\n') + '\n');
  console.log(`graded ${rows.length} resorts (median snow scale ${med.toFixed(3)})`);
}

if (require.main === module) main();
module.exports = { gradeSeason, shares, points, C };
