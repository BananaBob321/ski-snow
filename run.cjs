// Runs the browser snow runner (runner.js) under Node: browser storage becomes state.json,
// results go to snow_raw.csv (the ski sheet imports this file) and a one-line summary to status.txt.
const fs = require('fs'), vm = require('vm');
const STATE = 'state.json', OUT = 'snow_raw.csv', SEED = 'seed.json', TOTAL = 481;
const store = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); fs.writeFileSync(STATE, JSON.stringify(store)); },
};
vm.runInThisContext(fs.readFileSync('runner.js', 'utf8'), { filename: 'runner.js' });

const HEADER = ['#', 'Model seasons', 'Mid-mountain elevation (m)', 'Best week starts', 'Best week snowfall, model (cm)',
  "Each season's best week, avg (cm)", 'Best 30 days start', 'Best 30 days snowfall, model (cm)',
  "Each season's best 30 days, avg (cm)", 'Window snowfall, model (cm)', 'Snow days in window',
  'Avg temp in window (°C)', 'Season snowfall, model (cm)'];
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function save(state) {
  const rows = omRows();
  fs.writeFileSync(OUT, [HEADER, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n');
  const fail = JSON.parse(localStorage.getItem('OMFAIL') || '{}');
  const failed = Object.keys(fail).filter(k => fail[k] >= 2 && !OM[k]);
  const done = rows.length >= TOTAL || (state === 'complete' && rows.length + failed.length >= TOTAL);
  const line = `${rows.length} of ${TOTAL} resorts done; stopped: ${state}` + (failed.length ? `; no data for #${failed.join(', #')}` : '');
  fs.writeFileSync('status.txt', line + '\n' + new Date().toISOString() + '\nlast: ' + (window.OMLAST || '') + '\n');
  console.log(line);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `done=${done}\n`);
}

(async () => {
  if (fs.existsSync(SEED)) console.log('seeded', omSeed(JSON.parse(fs.readFileSync(SEED, 'utf8'))));
  const before = Object.keys(OM).length;
  const minutes = +(process.env.MINUTES || 100);
  const cap = new Promise(r => setTimeout(() => r('time cap'), minutes * 60000));
  const state = await Promise.race([omRunToday(), cap]);
  console.log('new today', Object.keys(OM).length - before);
  save(state);
  process.exit(0);
})().catch(e => { console.error(e); try { save('error: ' + e); } catch (_) {} process.exit(1); });
