// Shared daily budget for Open-Meteo's free tier, so all downloads together stay under its published limit
// (fewer than 10,000 API calls a day). Open-Meteo counts a request with more than 7 days of data or more than
// 10 variables as several calls (https://open-meteo.com/en/pricing). Counted here, conservatively, as
//   max(1, days / 7) x max(1, variables / 10) x locations
// Usage is kept per UTC day in budget_state.json. OM_DAILY_BUDGET overrides the default of 9,500.
const fs = require('fs');
const FILE = 'budget_state.json', LIMIT = +(process.env.OM_DAILY_BUDGET || 9500);
const today = () => new Date().toISOString().slice(0, 10);
function load() {
  let s = { date: today(), used: 0 };
  try { const f = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (f.date === today()) s = f; } catch (_) {}
  return s;
}
function weight(u) {
  const q = new URL(u).searchParams;
  const days = (Date.parse(q.get('end_date')) - Date.parse(q.get('start_date'))) / 86400000 + 1;
  const vars = ['hourly', 'daily'].reduce((n, k) => n + (q.get(k) ? q.get(k).split(',').length : 0), 0);
  const locs = (q.get('latitude') || '').split(',').length;
  return Math.max(1, days / 7) * Math.max(1, vars / 10) * locs;
}
// Throws (with "Daily" in the message, which the scripts treat as "stop for today") if the request would
// go over the budget; otherwise records it.
function take(u) {
  const s = load(), w = weight(u);
  if (s.used + w > LIMIT) throw new Error(`Daily budget reached (${Math.round(s.used)} of ${LIMIT} weighted calls used today)`);
  s.used = Math.round((s.used + w) * 10) / 10; fs.writeFileSync(FILE, JSON.stringify(s));
}
// Throws if a job needing about w weighted calls can't finish inside today's budget (so a resort isn't half done).
function need(w) {
  const s = load();
  if (s.used + w > LIMIT) throw new Error(`Daily budget reached (${Math.round(s.used)} of ${LIMIT} weighted calls used today)`);
}
const used = () => load().used;
module.exports = { take, need, weight, used, LIMIT };
