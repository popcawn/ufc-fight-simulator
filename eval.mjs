// Time-aware evaluation + training harness for the UFC fight simulator.
// Phase 1: replay UFC history chronologically (no leakage), collecting features for every
//          fight since TRAIN_START: Monte Carlo sim probability, Elo gap, age/reach/form/
//          layoff/experience/win-rate differentials.
// Phase 2: fit an antisymmetric logistic model on fights before TEST_START, evaluate on the rest.
// Prints coefficients to paste into ufc-fight-simulator.html.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const ROOT = import.meta.dirname.replace(/\\/g, "/");
const BASE = "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/";
const DIR = ROOT + "/ufc-data/";
const HTML_PATH = ROOT + "/index.html";
const TRAIN_START = new Date("2019-01-01");
const TEST_START = new Date("2025-01-01");
const TODAY = new Date();
const SIMS = 400;
const HL = 730;   // stat recency half-life (days) — won grid search
const ELO_K = 40; // won grid search

// ---- engine from the shipped HTML ----
const html = readFileSync(HTML_PATH, "utf8");
const scr = html.match(/<script>([\s\S]*)<\/script>/)[1];
const el = () => new Proxy({ classList:{add(){},remove(){}}, style:{}, addEventListener(){}, appendChild(){}, scrollIntoView(){} }, { get(t,k){ return k in t ? t[k] : (t[k]=""); }, set(t,k,v){ t[k]=v; return true; } });
globalThis.document = { getElementById: el, createElement: () => el() };
const { simulate, derive } = new Function(scr + "; return {simulate, derive};")();

// ---- data ----
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
const secs = s => { const m = (s||"").match(/(\d+):(\d+)/); return m ? +m[1]*60 + +m[2] : 0; };
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
  a.kd += +(s.KD||0)||0; a.ctrl += secs(s.CTRL);
}
const tape = new Map(tott.map(t => [t.FIGHTER.trim(), t]));
const inches = s => { const m=(s||"").match(/(\d+)'\s*(\d+)/); if(m) return +m[1]*12 + +m[2]; const m2=(s||"").match(/^(\d+)"/); return m2 ? +m2[1] : 0; };

const WCRE = /(Women's )?(Strawweight|Flyweight|Bantamweight|Featherweight|Lightweight|Welterweight|Middleweight|Light Heavyweight|Heavyweight)/;
const bouts = results.map(r => ({ r, date: evDate.get(r.EVENT.trim()) }))
  .filter(b => b.date && !isNaN(b.date) && b.date <= TODAY && /^(W\/L|L\/W|D\/D|NC\/NC)$/.test((b.r.OUTCOME||"").trim()))
  .sort((a,b) => a.date - b.date);
console.log(`${bouts.length} historical bouts`);

// ---- chronological pass collecting feature rows ----
const S = new Map();
const getS = n => { if(!S.has(n)) S.set(n, { sl:0,sa:0,osl:0,osa:0,td:0,tda:0,otd:0,otda:0,sub:0,time:0, kd:0,okd:0,ctrl:0,octrl:0, last:null,
  w:0,l:0,koW:0,subW:0,koL:0,subL:0, res:[], elo:1500 }); return S.get(n); };
const decayTo = (s, date) => (HL === Infinity || !s.last) ? 1 : Math.pow(0.5, (date - s.last)/86400000/HL);
const eloP = (a,b) => 1/(1+Math.pow(10, -(a-b)/400));
const snap = (n, s, date, div) => {
  const d = decayTo(s, date);
  const t = tape.get(n) || {};
  const ht = inches(t.HEIGHT) || 70, reach = inches(t.REACH) || ht;
  const dob = t.DOB && t.DOB !== "--" ? new Date(t.DOB) : null;
  const min = Math.max(1, s.time * d);
  return derive({
    name:n, div, age: dob && !isNaN(dob) ? Math.floor((date-dob)/31557600000) : 30,
    ht, reach, stance: /South/i.test(t.STANCE||"") ? "S" : /Switch/i.test(t.STANCE||"") ? "X" : "O",
    w:s.w, l:s.l, koW:s.koW, subW:s.subW, koL:s.koL, subL:s.subL,
    slpm: s.sl*d/min, sapm: s.osl*d/min,
    acc: s.sa ? s.sl/s.sa : 0.45, def: s.osa ? 1 - s.osl/s.osa : 0.55,
    td15: s.td*d/min*15, tdAcc: s.tda ? s.td/s.tda : 0.40,
    tdDef: s.otda ? 1 - s.otd/s.otda : 0.55, sub15: s.sub*d/min*15,
    elo: s.elo, form: s.res.slice(-5).reduce((x,y)=>x+y,0),
    kd15: s.kd*d/min*15, okd15: s.okd*d/min*15,
    ctrlR: (s.ctrl/60)*d/min, octrlR: (s.octrl/60)*d/min,
  });
};
const logit = p => Math.log(Math.max(1e-6, Math.min(1-1e-6, p)) / (1 - Math.max(1e-6, Math.min(1-1e-6, p))));
// current win/loss streak: consecutive same-sign results from the most recent fight (+N win, -N loss)
const streak = res => { let n = 0; for (let i = res.length-1; i >= 0; i--) { if (res[i] === 0) break; if (n === 0) n = res[i]; else if (Math.sign(res[i]) === Math.sign(n)) n += res[i]; else break; } return n; };
const rows = [];
const t0 = Date.now();
for (const { r, date } of bouts) {
  const names = r.BOUT.split(" vs. ").map(x=>x.trim());
  if (names.length !== 2) continue;
  const [nA, nB] = names;
  const sA = getS(nA), sB = getS(nB);
  const out = r.OUTCOME.trim();
  const method = r.METHOD || "";
  const isKO = /KO\/TKO|TKO/.test(method), isSub = /Submission/.test(method);
  const wcM = (r.WEIGHTCLASS||"").match(WCRE); const div = wcM ? wcM[0] : "Unknown";

  if (date >= TRAIN_START && out !== "D/D" && out !== "NC/NC" && sA.w + sA.l > 0 && sB.w + sB.l > 0) {
    const A = snap(nA, sA, date, div), B = snap(nB, sB, date, div);
    const nR = /5 Rnd/.test(r["TIME FORMAT"]||"") ? 5 : 3;
    const t = simulate(A, B, nR, SIMS);
    const wp = s => (s.w + 2.5) / (s.w + s.l + 5); // shrunk win rate
    const layoff = s => Math.min(36, (date - s.last)/86400000/30.44 || 12); // months, capped
    rows.push({
      date,
      x: [
        logit(t.A/(t.A+t.B)),               // 0 sim probability (logit)
        (sA.elo - sB.elo)/100,              // 1 Elo gap
        (B.age - A.age)/5,                  // 2 youth edge
        (A.reach - B.reach)/5,              // 3 reach edge
        (A.form - B.form)/3,                // 4 recent form (last 5)
        (layoff(sB) - layoff(sA))/12,       // 5 ring rust edge
        (Math.sqrt(sA.w+sA.l) - Math.sqrt(sB.w+sB.l))/2, // 6 UFC experience
        (wp(sA) - wp(sB))*4,                // 7 shrunk UFC win rate
        ((A.ctrlR - A.octrlR) - (B.ctrlR - B.octrlR))*2,  // 8 net octagon-control dominance
        // NOTE: net knockdown differential tested as a 10th feature — coefficient ~0.01,
        // redundant with the sim's power/KO model, no accuracy gain. Dropped.
        // NOTE: current streak tested as a feature — redundant with form (#4),
        // did not improve held-out accuracy. Displayed in UI only.
      ],
      y: out === "W/L" ? 1 : 0,
    });
  }
  // update
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
console.log(`${rows.length} feature rows in ${((Date.now()-t0)/1000).toFixed(0)}s`);

// ---- antisymmetric logistic regression (no intercept), mirrored training ----
const train = [], test = [];
for (const r of rows) (r.date < TEST_START ? train : test).push(r);
// mirror each train row so the model is exactly antisymmetric
const tr = train.flatMap(r => [r, { x: r.x.map(v=>-v), y: 1 - r.y }]);
const D = rows[0].x.length;
const sig = z => 1/(1+Math.exp(-z));
let b = new Array(D).fill(0);
const LR = 0.3, L2 = 1e-4;
for (let it = 0; it < 3000; it++) {
  const g = new Array(D).fill(0);
  for (const r of tr) {
    const err = sig(r.x.reduce((s,v,i)=>s+v*b[i],0)) - r.y;
    for (let i = 0; i < D; i++) g[i] += err * r.x[i];
  }
  for (let i = 0; i < D; i++) b[i] -= LR * (g[i]/tr.length + L2*b[i]);
}
const FEAT = ["logit(pSim)","eloGap/100","youth/5","reach/5","form/3","rust/12","exp","winrate*4","ctrlDom"];
console.log("\ncoefficients:"); FEAT.forEach((f,i)=>console.log("  " + f.padEnd(12), b[i].toFixed(4)));

function evalSet(set, fn, label) {
  let hit = 0, ll = 0;
  for (const r of set) {
    const p = Math.min(0.99, Math.max(0.01, fn(r)));
    if ((p >= 0.5) === (r.y === 1)) hit++;
    ll += -Math.log(r.y ? p : 1-p);
  }
  console.log(`${label.padEnd(34)} acc ${(100*hit/set.length).toFixed(1)}%  logloss ${(ll/set.length).toFixed(4)}  (n=${set.length})`);
}
console.log(`\n=== held-out test: fights since ${TEST_START.toISOString().slice(0,10)} ===`);
evalSet(test, r => sig(r.x[0]), "sim only");
evalSet(test, r => sig(1.15*r.x[1]*Math.LN10/4), "elo only (approx)");
evalSet(test, r => 0.4*sig(r.x[0]) + 0.6*eloPfromX(r), "fixed blend w=0.4");
function eloPfromX(r){ return 1/(1+Math.pow(10, -r.x[1]*100/400)); }
evalSet(test, r => sig(r.x.reduce((s,v,i)=>s+v*b[i],0)), "logistic (all features)");
evalSet(train, r => sig(r.x.reduce((s,v,i)=>s+v*b[i],0)), "logistic on TRAIN (overfit check)");
// established fighters only (3+ UFC fights each is implied by experience feature >= ...): use exp feature reconstruction
writeFileSync(ROOT + "/ufc-eval-coefs.json", JSON.stringify(b));
console.log("\ncoefficients saved to ufc-eval-coefs.json");
