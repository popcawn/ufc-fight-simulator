// Historical UFC total-rounds lines (The Odds API historical endpoint — needs a PAID key) for prop backtests.
// One near-close snapshot per UFC card (event day 12:00 UTC; Asia/Oceania cards that start earlier fall back to
// the previous day 18:00 UTC). Only fights that had NOT started at snapshot time are kept (no live odds).
// Output (gitignored): ufc-data/totals-history.json  { "<card date>": { ts, fights: [{ a, b, t, tot: { book: { point: [over, under] } } }] } }
// Cached per card; stops if the key drops below --floor credits (default 4000) so other projects keep theirs.
// Run: ODDS_HIST_KEY=... node totals-history.mjs [--from=2021-01-01] [--floor=4000]
import { readFileSync, writeFileSync, existsSync } from "fs";
const ROOT = import.meta.dirname.replace(/\\/g, "/"), DIR = ROOT + "/ufc-data/", OUT = DIR + "totals-history.json";
const KEY = process.env.ODDS_HIST_KEY || ""; if (!KEY) { console.log("set ODDS_HIST_KEY (a paid Odds API key)"); process.exit(1); }
const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=")[1];
const FROM = arg("from", "2021-01-01"), FLOOR = +arg("floor", 4000);
const ev = readFileSync(DIR + "ufc_event_details.csv", "utf8").split("\n").slice(1).map(l => { const m = l.match(/^"?(.*?)"?,"?([A-Z][a-z]+ \d{1,2}, \d{4})"?/); return m ? new Date(m[2] + " UTC") : null; })
  .filter(d => d && !isNaN(d)).map(d => d.toISOString().slice(0, 10));
const cards = [...new Set(ev)].filter(d => d >= FROM && d < new Date().toISOString().slice(0, 10)).sort();
const cache = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const todo = cards.filter(d => !cache[d]);
console.log(`${cards.length} UFC cards since ${FROM} · ${cards.length - todo.length} cached · fetching ${todo.length} (~${todo.length * 10} credits)`);
let remaining = Infinity;
async function snap(iso) {
  const r = await fetch(`https://api.the-odds-api.com/v4/historical/sports/mma_mixed_martial_arts/odds?regions=us&markets=totals&oddsFormat=decimal&date=${iso}&apiKey=${KEY}`);
  remaining = +r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}
const keep = (j, day) => (j.data || []).filter(e => e.commence_time > j.timestamp && Math.abs(new Date(e.commence_time) - new Date(day + "T12:00:00Z")) < 36 * 36e5)
  .map(e => { const tot = {}; for (const b of e.bookmakers) { const m = b.markets.find(x => x.key === "totals"); if (!m) continue;
      for (const o of m.outcomes) if (o.point != null) ((tot[b.key] ||= {})[o.point] ||= [0, 0])[o.name === "Over" ? 0 : 1] = o.price; }
    return { a: e.home_team, b: e.away_team, t: e.commence_time, tot }; }).filter(f => Object.keys(f.tot).length);
let done = 0;
for (const day of todo) {
  if (remaining < FLOOR) { console.log(`stopping: ${remaining} credits left (floor ${FLOOR})`); break; }
  try {
    let j = await snap(`${day}T12:00:00Z`), fights = keep(j, day);
    if (fights.length < 4) { const prev = new Date(new Date(day) - 864e5).toISOString().slice(0, 10); const j2 = await snap(`${prev}T18:00:00Z`); const f2 = keep(j2, day); if (f2.length > fights.length) { j = j2; fights = f2; } }
    cache[day] = { ts: j.timestamp, fights };
  } catch (e) { console.log(`  ${day}: ${e.message}`); if (/40[13]|429/.test(e.message)) break; }
  if (++done % 20 === 0) { writeFileSync(OUT, JSON.stringify(cache)); console.log(`  ${done}/${todo.length} · credits left ${remaining}`); }
}
writeFileSync(OUT, JSON.stringify(cache));
const nF = Object.values(cache).reduce((s, c) => s + c.fights.length, 0);
console.log(`done: ${Object.keys(cache).length} cards, ${nF} fights with total-rounds lines · credits left ${remaining}`);
