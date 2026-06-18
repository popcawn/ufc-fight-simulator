// Builds the full active-UFC-roster stats array from the Greco1899/scrape_ufc_stats
// dataset (auto-updated mirror of ufcstats.com) and injects it into ufc-fight-simulator.html.
// Processes the entire UFC history chronologically to compute, per fighter:
//   - recency-weighted career stats (730-day half-life, so recent fights count more)
//   - Elo rating (K=40) across all UFC fights -> opponent quality / strength of schedule
//   - recent form (net result of last 5 fights) and months since last fight
// Re-run any time to refresh:  node ufc-build-roster.mjs  (delete ufc-data\ to force re-download)
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";

const ROOT = import.meta.dirname.replace(/\\/g, "/"); // repo folder, works on Windows/Linux/CI
const BASE = "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/";
const DIR = ROOT + "/ufc-data/";
const HTML_PATH = ROOT + "/index.html";
const CUTOFF = new Date("2024-06-01"); // "active" = fought in the last ~24 months
const TODAY = new Date();
const HL = 730, ELO_K = 40;

if (process.argv.includes("--fresh") && existsSync(DIR)) rmSync(DIR, { recursive: true });
if (!existsSync(DIR)) mkdirSync(DIR);
async function csv(name) {
  const p = DIR + name;
  if (!existsSync(p)) { console.log("downloading", name); writeFileSync(p, await fetch(BASE + name).then(r => r.text())); }
  return parseCSV(readFileSync(p, "utf8"));
}
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
  if (cur || row.length) { row.push(cur.replace(/\r$/, "")); rows.push(row); }
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h,i)=>[h, r[i].trim()])));
}
const [events, tott, results, stats] = await Promise.all(["ufc_event_details.csv","ufc_fighter_tott.csv","ufc_fight_results.csv","ufc_fight_stats.csv"].map(csv));
const evDate = new Map(events.map(e => [e.EVENT.trim(), new Date(e.DATE)]));

const of = s => { const m = (s||"").match(/(\d+)\s+of\s+(\d+)/); return m ? [+m[1], +m[2]] : [0,0]; };
const secs = s => { const m = (s||"").match(/(\d+):(\d+)/); return m ? +m[1]*60 + +m[2] : 0; }; // "M:SS" -> seconds
const boutAgg = new Map();
for (const s of stats) {
  const key = s.EVENT.trim() + "|" + s.BOUT.trim();
  if (!boutAgg.has(key)) boutAgg.set(key, new Map());
  const bm = boutAgg.get(key);
  const n = s.FIGHTER.trim();
  if (!bm.has(n)) bm.set(n, { sl:0,sa:0,td:0,tda:0,sub:0,kd:0,ctrl:0 });
  const a = bm.get(n);
  const [sl,sa] = of(s["SIG.STR."]); const [td,tda] = of(s.TD);
  a.sl+=sl; a.sa+=sa; a.td+=td; a.tda+=tda; a.sub += +(s["SUB.ATT"]||0)||0;
  a.kd += +(s.KD||0)||0; a.ctrl += secs(s.CTRL); // knockdowns scored, octagon control (seconds)
}
const tape = new Map(tott.map(t => [t.FIGHTER.trim(), t]));
const inches = s => { const m=(s||"").match(/(\d+)'\s*(\d+)/); if(m) return +m[1]*12 + +m[2]; const m2=(s||"").match(/^(\d+)"/); return m2 ? +m2[1] : 0; };

const WCRE = /(Women's )?(Strawweight|Flyweight|Bantamweight|Featherweight|Lightweight|Welterweight|Middleweight|Light Heavyweight|Heavyweight)/;
const bouts = results.map(r => ({ r, date: evDate.get(r.EVENT.trim()) }))
  .filter(b => b.date && !isNaN(b.date) && b.date <= TODAY && /^(W\/L|L\/W|D\/D|NC\/NC)$/.test((b.r.OUTCOME||"").trim()))
  .sort((a,b) => a.date - b.date);

// ---- chronological pass ----
const S = new Map();
const getS = n => { if(!S.has(n)) S.set(n, { sl:0,sa:0,osl:0,osa:0,td:0,tda:0,otd:0,otda:0,sub:0,time:0, kd:0,okd:0,ctrl:0,octrl:0, last:null,
  w:0,l:0,koW:0,subW:0,koL:0,subL:0, res:[], elo:1500, div:null }); return S.get(n); };
const decayTo = (s, date) => !s.last ? 1 : Math.pow(0.5, (date - s.last)/86400000/HL);
const eloP = (a,b) => 1/(1+Math.pow(10, -(a-b)/400));
for (const { r, date } of bouts) {
  const names = r.BOUT.split(" vs. ").map(x=>x.trim());
  if (names.length !== 2) continue;
  const [nA, nB] = names;
  const sA = getS(nA), sB = getS(nB);
  const out = r.OUTCOME.trim();
  const method = r.METHOD || "";
  const isKO = /KO\/TKO|TKO/.test(method), isSub = /Submission/.test(method);
  const wcM = (r.WEIGHTCLASS||"").match(WCRE);
  const mins = (Math.max(1,+r.ROUND||1)-1)*5 + (()=>{const t=(r.TIME||"0:00").split(":");return (+t[0]||0)+(+t[1]||0)/60;})();
  const ba = boutAgg.get(r.EVENT.trim() + "|" + r.BOUT.trim());
  [[nA,sA,nB],[nB,sB,nA]].forEach(([n,s,on])=>{
    const dF = decayTo(s, date);
    for (const k of ["sl","sa","osl","osa","td","tda","otd","otda","sub","time","kd","okd","ctrl","octrl"]) s[k] *= dF;
    const mine = ba ? ba.get(n) : null, theirs = ba ? ba.get(on) : null;
    if (mine && theirs) {
      s.sl+=mine.sl; s.sa+=mine.sa; s.td+=mine.td; s.tda+=mine.tda; s.sub+=mine.sub;
      s.osl+=theirs.sl; s.osa+=theirs.sa; s.otd+=theirs.td; s.otda+=theirs.tda;
      s.kd+=mine.kd; s.okd+=theirs.kd; s.ctrl+=mine.ctrl; s.octrl+=theirs.ctrl;
    }
    s.time += mins; s.last = date;
    if (wcM) s.div = wcM[0];
  });
  if (out === "W/L" || out === "L/W") {
    const [win, lose] = out === "W/L" ? [sA,sB] : [sB,sA];
    win.w++; lose.l++;
    if (isKO) { win.koW++; lose.koL++; } if (isSub) { win.subW++; lose.subL++; }
    win.res.push(1); lose.res.push(-1);
    const e = eloP(win.elo, lose.elo);
    win.elo += ELO_K*(1-e); lose.elo -= ELO_K*(1-e);
  } else if (out === "D/D") {
    sA.res.push(0); sB.res.push(0);
    const e = eloP(sA.elo, sB.elo); sA.elo += ELO_K*(0.5-e); sB.elo -= ELO_K*(0.5-e);
  }
}

// ---- emit active roster ----
const medHt = { "Heavyweight":75,"Light Heavyweight":75,"Middleweight":73,"Welterweight":71,"Lightweight":70,"Featherweight":68,"Bantamweight":67,"Flyweight":66,"Women's Featherweight":68,"Women's Bantamweight":66,"Women's Flyweight":65,"Women's Strawweight":64 };
// current win/loss streak: consecutive same-sign results from the most recent fight (+N win, -N loss)
const streak = res => { let n = 0; for (let i = res.length-1; i >= 0; i--) { if (res[i] === 0) break; if (n === 0) n = res[i]; else if (Math.sign(res[i]) === Math.sign(n)) n += res[i]; else break; } return n; };
const rows = [];
for (const [name, s] of S) {
  if (!s.last || s.last < CUTOFF) continue;
  const t = tape.get(name) || {};
  const div = s.div || "Unknown";
  const ht = inches(t.HEIGHT) || medHt[div] || 70;
  const reach = inches(t.REACH) || ht;
  const stance = /South/i.test(t.STANCE||"") ? "S" : /Switch/i.test(t.STANCE||"") ? "X" : "O";
  const dob = t.DOB && t.DOB !== "--" ? new Date(t.DOB) : null;
  const age = dob && !isNaN(dob) ? Math.floor((TODAY - dob)/31557600000) : 30;
  const min = Math.max(1, s.time);
  rows.push([name, div, age, ht, reach, stance, s.w, s.l, s.koW, s.subW, s.koL, s.subL,
    +(s.sl/min).toFixed(2), +(s.osl/min).toFixed(2),
    s.sa ? +(s.sl/s.sa).toFixed(2) : 0.45, s.osa ? +(1-s.osl/s.osa).toFixed(2) : 0.55,
    +(s.td/min*15).toFixed(2), s.tda ? +(s.td/s.tda).toFixed(2) : 0.40,
    s.otda ? +(1-s.otd/s.otda).toFixed(2) : 0.55, +(s.sub/min*15).toFixed(2),
    Math.round(s.elo), s.res.slice(-5).reduce((x,y)=>x+y,0),
    +((TODAY - s.last)/86400000/30.44).toFixed(1), streak(s.res),
    +(s.kd/min*15).toFixed(3), +(s.okd/min*15).toFixed(3),     // knockdowns scored / absorbed per 15min
    +((s.ctrl/60)/min).toFixed(3), +((s.octrl/60)/min).toFixed(3)]); // control min / fight min, for & against
}
rows.sort((x,y) => x[0].localeCompare(y[0]));
console.log(`Active roster: ${rows.length} fighters (fought since ${CUTOFF.toISOString().slice(0,10)})`);
for (const n of ["Max Holloway","Merab Dvalishvili","Alex Pereira","Tom Aspinall","Islam Makhachev"]) {
  const r = rows.find(r => r[0] === n);
  console.log(n + ":", r ? JSON.stringify(r) : "MISSING");
}
writeFileSync(ROOT + "/ufc-roster.json", JSON.stringify(rows));

// ---- inject into HTML + verify backtest names ----
let html = readFileSync(HTML_PATH, "utf8");
const re = /const F = \[[\s\S]*?\n\];/;
if (!re.test(html)) { console.error("FATAL: F array not found in HTML"); process.exit(1); }
html = html.replace(re, "const F = [\n" + rows.map(r => JSON.stringify(r)).join(",\n") + "\n];");
writeFileSync(HTML_PATH, html);
const names = new Set(rows.map(r => r[0]));
const btNames = [...html.matchAll(/^\["([^"]+)","([^"]+)","(?:KO|SUB|DEC)","\d{4}-\d{2}"\]/gm)].flatMap(m => [m[1], m[2]]);
const missing = [...new Set(btNames.filter(n => !names.has(n)))];
console.log(missing.length ? "BACKTEST NAMES MISSING: " + missing.join(", ") : "All backtest names resolve.");
console.log("DONE — full roster injected.");
