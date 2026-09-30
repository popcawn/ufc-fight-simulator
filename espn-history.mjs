// Newcomer data: every UFC fighter's FULL pro history (regional + Contender Series + UFC) from ESPN's public
// MMA API — one request per fighter (the athlete doc's eventsMap has date, result, method, promotion).
// Identity check: an ESPN profile is accepted only if one of its UFC-promotion fight dates matches that
// fighter's real UFC fights (UFCStats), so same-name fighters can't get mixed up.
// Output: espn-history.json  { name: { id, f: [[yyyy-mm-dd, "W"|"L"|"D", kind, method], ...] } | { id: null } }
//   kind: "C" Contender Series, "R" regional/other promotion (UFC fights are skipped — UFCStats has them)
//   method: "K" KO/TKO, "S" submission, "D" decision, "O" other
// Cached: only fighters not yet in the file are fetched. Run: node espn-history.mjs [--refresh=Name]
import { readFileSync, writeFileSync, existsSync } from "fs";

const ROOT = import.meta.dirname.replace(/\\/g, "/"), DIR = ROOT + "/ufc-data/", OUT = ROOT + "/espn-history.json";
function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur.replace(/\r$/, "")); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h,i)=>[h, r[i].trim()])));
}
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const day = d => new Date(d).toISOString().slice(0, 10);

// every fighter in a UFC fight since 2019, with their UFC fight dates (for the identity check)
const ev = new Map(parseCSV(readFileSync(DIR + "ufc_event_details.csv", "utf8")).map(e => [e.EVENT.trim(), new Date(e.DATE)]));
const ufcDates = new Map();
for (const r of parseCSV(readFileSync(DIR + "ufc_fight_results.csv", "utf8"))) {
  const d = ev.get(r.EVENT.trim()); if (!d || isNaN(d)) continue;
  for (const n of r.BOUT.split(" vs. ").map(x => x.trim())) (ufcDates.get(n) || ufcDates.set(n, []).get(n)).push(d.getTime());
}
const want = [...ufcDates.entries()].filter(([, ds]) => ds.some(t => t >= Date.UTC(2019, 0, 1))).map(([n]) => n);
const cache = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const refresh = (process.argv.find(a => a.startsWith("--refresh=")) || "").slice(10);
if (refresh) delete cache[refresh];
const LIMIT = +((process.argv.find(a => a.startsWith("--limit=")) || "--limit=99999").slice(8));
const todo = want.filter(n => !(n in cache)).slice(0, LIMIT);
console.log(`${want.length} fighters since 2019 · ${want.filter(n => n in cache).length} cached · fetching ${todo.length}`);

const UA = { "User-Agent": "Mozilla/5.0 (ufc-fight-simulator research)" };
const getJSON = async (url, tries = 3) => { for (let i = 0; i < tries; i++) { try { const r = await fetch(url, { headers: UA }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) {} await new Promise(r => setTimeout(r, 800 * (i + 1))); } return null; };
const kindOf = e => /Contender Series/i.test(e.name || "") ? "C" : /\bUFC\b|Ultimate Fighter/i.test(e.name || "") && /~l:3321~/.test(e.uid || "") ? "U" : "R";
const methodOf = e => { const m = ((e.status && e.status.result && e.status.result.name) || "").toLowerCase(); return /ko|tko/.test(m) ? "K" : /sub/.test(m) ? "S" : /decision/.test(m) ? "D" : "O"; };

async function lookup(name) {
  const s = await getJSON(`https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=8&mode=prefix&type=player&sport=mma`);
  const items = (s && s.items || []).filter(x => x.sport === "mma" || /mma/i.test(x.label || ""));
  const k = norm(name), last = k.split(" ").pop();
  let cands = items.filter(x => norm(x.displayName || "") === k);
  if (!cands.length) cands = items.filter(x => { const q = norm(x.displayName || ""); return q.split(" ").pop() === last && q[0] === k[0]; });
  const mine = ufcDates.get(name) || [];
  for (const c of cands.slice(0, 4)) {
    const a = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/mma/athletes/${c.id}`);
    const evs = Object.values((a && a.eventsMap) || {});
    const match = evs.some(e => kindOf(e) === "U" && mine.some(t => Math.abs(new Date(e.gameDate).getTime() - t) < 2.5 * 864e5));
    if (!match) continue;
    const f = evs.filter(e => kindOf(e) !== "U" && /^[WLD]$/.test(e.gameResult || "") && e.gameDate)
      .map(e => [day(e.gameDate), e.gameResult, kindOf(e), methodOf(e)]).sort((x, y) => x[0] < y[0] ? -1 : 1);
    return { id: c.id, f };
  }
  return { id: null };
}

let done = 0, found = 0;
const queue = todo.slice();
async function worker() {
  while (queue.length) {
    const n = queue.shift();
    cache[n] = await lookup(n); done++; if (cache[n].id) found++;
    if (done % 100 === 0) { writeFileSync(OUT, JSON.stringify(cache)); console.log(`  ${done}/${todo.length} (${found} matched)`); }
    await new Promise(r => setTimeout(r, 120));
  }
}
await Promise.all(Array.from({ length: 5 }, worker));
writeFileSync(OUT, JSON.stringify(cache));
const all = Object.values(cache), hit = all.filter(x => x.id);
console.log(`done: ${hit.length}/${all.length} fighters matched to ESPN · avg ${(hit.reduce((s, x) => s + x.f.length, 0) / Math.max(1, hit.length)).toFixed(1)} non-UFC pro fights each`);
