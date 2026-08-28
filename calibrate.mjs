// Compares the engine's predicted method/round distribution against the real
// UFC distribution (2018+), to calibrate finish timing.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

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
const ROOT = import.meta.dirname.replace(/\\/g, "/"), DIR = ROOT + "/ufc-data/";
const BASE = "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/";
// fresh download by default; --cache reuses local snapshot
const USE_CACHE = process.argv.includes("--cache");
if (!existsSync(DIR)) mkdirSync(DIR);
async function csv(name){ const p = DIR + name; if(!(USE_CACHE && existsSync(p))){ console.log("downloading", name); writeFileSync(p, await fetch(BASE+name).then(r=>r.text())); } return parseCSV(readFileSync(p, "utf8")); }
const ev = new Map((await csv("ufc_event_details.csv")).map(e => [e.EVENT.trim(), new Date(e.DATE)]));
const res = await csv("ufc_fight_results.csv");
const since = new Date("2018-01-01");

console.log("=== REAL UFC (2018+) ===");
for (const fmt of ["3 Rnd", "5 Rnd"]) {
  const f = res.filter(r => {
    const d = ev.get(r.EVENT.trim());
    return d && d >= since && (r["TIME FORMAT"]||"").startsWith(fmt) && /^(W\/L|L\/W)$/.test(r.OUTCOME.trim());
  });
  let ko=0, sub=0, dec=0, other=0; const rd = {};
  for (const r of f) {
    const m = r.METHOD || "";
    if (/KO\/TKO|TKO/.test(m)) { ko++; rd[r.ROUND]=(rd[r.ROUND]||0)+1; }
    else if (/Submission/.test(m)) { sub++; rd[r.ROUND]=(rd[r.ROUND]||0)+1; }
    else if (/Decision/.test(m)) dec++;
    else other++;
  }
  const n = f.length, fin = ko+sub;
  console.log(`${fmt}: n=${n}  KO ${(100*ko/n).toFixed(1)}%  SUB ${(100*sub/n).toFixed(1)}%  DEC ${(100*dec/n).toFixed(1)}%  other ${(100*other/n).toFixed(1)}%`);
  console.log("  finish rounds: " + Object.keys(rd).sort().map(k=>`R${k} ${(100*rd[k]/fin).toFixed(1)}%`).join("  "));
}

// engine's aggregate distribution over a random sample of real-roster matchups (same division)
console.log("\n=== ENGINE (current) ===");
const html = readFileSync(ROOT + "/index.html","utf8");
const scr = html.match(/<script>([\s\S]*)<\/script>/)[1];
const el = () => new Proxy({ classList:{add(){},remove(){}}, style:{}, addEventListener(){}, appendChild(){}, scrollIntoView(){} }, { get(t,k){ return k in t ? t[k] : (t[k]=""); }, set(t,k,v){ t[k]=v; return true; } });
globalThis.document = { getElementById: el, createElement: () => el() };
const { fighters, simulate } = new Function(scr + "; return {fighters, simulate};")();
const byDiv = {};
for (const f of fighters) (byDiv[f.div] = byDiv[f.div] || []).push(f);
let agg = { KO:0, SUB:0, DEC:0, rd:{}, n:0 };
let seed = 42; const rnd = () => (seed = (seed*1103515245+12345) % 2147483648) / 2147483648;
for (let i = 0; i < 300; i++) {
  const divs = Object.keys(byDiv).filter(d => byDiv[d].length > 5);
  const pool = byDiv[divs[Math.floor(rnd()*divs.length)]];
  const A = pool[Math.floor(rnd()*pool.length)], B = pool[Math.floor(rnd()*pool.length)];
  if (A === B) continue;
  const t = simulate(A, B, 3, 300);
  const n = t.A + t.B;
  agg.KO += (t.mA.KO + t.mB.KO)/n; agg.SUB += (t.mA.SUB + t.mB.SUB)/n; agg.DEC += (t.mA.DEC + t.mB.DEC)/n;
  for (const r of Object.keys(t.rdA)) agg.rd[r] = (agg.rd[r]||0) + t.rdA[r]/n;
  for (const r of Object.keys(t.rdB)) agg.rd[r] = (agg.rd[r]||0) + t.rdB[r]/n;
  agg.n++;
}
const fin = agg.KO + agg.SUB;
console.log(`3 Rnd sample (n=${agg.n} matchups): KO ${(100*agg.KO/agg.n).toFixed(1)}%  SUB ${(100*agg.SUB/agg.n).toFixed(1)}%  DEC ${(100*agg.DEC/agg.n).toFixed(1)}%`);
console.log("  finish rounds: " + Object.keys(agg.rd).sort().map(k=>`R${k} ${(100*agg.rd[k]/fin).toFixed(1)}%`).join("  "));
