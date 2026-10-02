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
// --shrink=K: pull per-minute rates toward league average as if K extra average minutes were fought.
// Default 20: tames tiny-sample stat blowups (engine-alone logloss 0.754 -> 0.701); final model unchanged.
const SH = +((process.argv.find(a => a.startsWith("--shrink=")) || "--shrink=20").split("=")[1]);
const SIMS = +((process.argv.find(a => a.startsWith("--sims=")) || "--sims=1000").slice(7)); // sims per historical fight (~10s)
const HL = 730;   // stat recency half-life (days) — won grid search
const ELO_K = 40; // won grid search

// ---- engine from the shipped HTML ----
const html = readFileSync(HTML_PATH, "utf8");
const scr = html.match(/<script>([\s\S]*)<\/script>/)[1];
const el = () => new Proxy({ classList:{add(){},remove(){}}, style:{}, addEventListener(){}, appendChild(){}, scrollIntoView(){} }, { get(t,k){ return k in t ? t[k] : (t[k]=""); }, set(t,k,v){ t[k]=v; return true; } });
globalThis.document = { getElementById: el, createElement: () => el() };
// --seed=N: deterministic simulations (identical random draws every run) for exact with/without comparisons
const SEED = (process.argv.find(a => a.startsWith("--seed=")) || "").slice(7);
if (SEED) { let s = (+SEED >>> 0) || 1; Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const { simulate, derive } = new Function(scr + "; return {simulate, derive};")();

// ---- data ---- (fresh download by default; --cache reuses local snapshot for fast dev)
const USE_CACHE = process.argv.includes("--cache");
if (!existsSync(DIR)) mkdirSync(DIR);
async function csv(name) {
  const p = DIR + name;
  if (!(USE_CACHE && existsSync(p))) { console.log("downloading", name); writeFileSync(p, await fetch(BASE + name).then(r => r.text())); }
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
    ...(SH > 0 ? shrunk(s, d) : {
    slpm: s.sl*d/min, sapm: s.osl*d/min,
    acc: s.sa ? s.sl/s.sa : 0.45, def: s.osa ? 1 - s.osl/s.osa : 0.55,
    td15: s.td*d/min*15, tdAcc: s.tda ? s.td/s.tda : 0.40,
    tdDef: s.otda ? 1 - s.otd/s.otda : 0.55, sub15: s.sub*d/min*15,
    kd15: s.kd*d/min*15, okd15: s.okd*d/min*15,
    ctrlR: (s.ctrl/60)*d/min, octrlR: (s.octrl/60)*d/min }),
    elo: s.elo, form: s.res.slice(-5).reduce((x,y)=>x+y,0),
  });
};
const logit = p => Math.log(Math.max(1e-6, Math.min(1-1e-6, p)) / (1 - Math.max(1e-6, Math.min(1-1e-6, p))));
// current win/loss streak: consecutive same-sign results from the most recent fight (+N win, -N loss)
const streak = res => { let n = 0; for (let i = res.length-1; i >= 0; i--) { if (res[i] === 0) break; if (n === 0) n = res[i]; else if (Math.sign(res[i]) === Math.sign(n)) n += res[i]; else break; } return n; };
const rows = [];
const t0 = Date.now();
// --pre: pre-UFC / outside-the-UFC pro record (regional + Contender Series) from espn-history.json, counted
// only from fights BEFORE each bout's date (no look-ahead). --pre=thin weights it toward low-UFC-experience fights.
const PRE = (process.argv.find(a => a.startsWith("--pre")) || "").replace(/^--pre=?/, "") || (process.argv.includes("--pre") ? "on" : "");
const KOF = process.argv.includes("--kofeat"); // test: "lost his last fight by KO" as a model input
const ESPN = PRE && existsSync(ROOT + "/espn-history.json") ? JSON.parse(readFileSync(ROOT + "/espn-history.json", "utf8")) : {};
const outRec = (n, date) => { const hh = ESPN[n], d = date.toISOString().slice(0, 10); let w = 0, l = 0, fin = 0;
  if (hh && hh.f) for (const [dt, r, , m] of hh.f) { if (dt >= d) break; if (r === "W") { w++; if (m === "K" || m === "S") fin++; } else if (r === "L") l++; }
  return { w, l, fin }; };
// league-average priors (a prior on rates, not outcome info) for --shrink
const P = (() => { let m=0,sl=0,sa=0,td=0,tda=0,sub=0,kd=0,ct=0;
  for (const { r } of bouts) { const ba = boutAgg.get(r.EVENT.trim()+"|"+r.BOUT.trim()); if (!ba || ba.size !== 2) continue;
    const mins = (Math.max(1,+r.ROUND||1)-1)*5 + (()=>{const t=(r.TIME||"0:00").split(":");return (+t[0]||0)+(+t[1]||0)/60;})();
    for (const a of ba.values()) { m+=mins; sl+=a.sl; sa+=a.sa; td+=a.td; tda+=a.tda; sub+=a.sub; kd+=a.kd; ct+=a.ctrl/60; } }
  return { sl:sl/m, sa:sa/m, acc:sl/sa, td:td/m, tda:tda/m, tdacc:td/tda, sub:sub/m, kd:kd/m, ctrl:ct/m }; })();
const shrunk = (s, d) => { const M = s.time*d, r = (c, p) => (c + p*SH) / (M + SH), q = (k, n, p, n0) => (k + p*n0) / (n + n0);
  return { slpm:r(s.sl*d,P.sl), sapm:r(s.osl*d,P.sl), acc:q(s.sl,s.sa,P.acc,SH*P.sa), def:1-q(s.osl,s.osa,P.acc,SH*P.sa),
    td15:15*r(s.td*d,P.td), tdAcc:q(s.td,s.tda,P.tdacc,SH*P.tda), tdDef:1-q(s.otd,s.otda,P.tdacc,SH*P.tda), sub15:15*r(s.sub*d,P.sub),
    kd15:15*r(s.kd*d,P.kd), okd15:15*r(s.okd*d,P.kd), ctrlR:r(s.ctrl/60*d,P.ctrl), octrlR:r(s.octrl/60*d,P.ctrl) }; };
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
        ...(PRE ? (() => { const oA = outRec(nA, date), oB = outRec(nB, date), sw = o => (o.w + 2.5) / (o.w + o.l + 5);
          const th = PRE === "thin" ? 3 / (3 + Math.min(sA.w + sA.l, sB.w + sB.l)) : 1;
          return [ (sw(oA) - sw(oB)) * 4 * th,                                                          // 9 outside win-rate edge
                   (Math.sqrt(sA.w + sA.l + oA.w + oA.l) - Math.sqrt(sB.w + sB.l + oB.w + oB.l)) / 2 * th ]; })() : []), // 10 total pro experience edge
        ...(KOF ? [(sB.lastLossKO ? 1 : 0) - (sA.lastLossKO ? 1 : 0)] : []), // opponent coming off a KO loss (+) / me (-)
        // NOTE: net knockdown differential tested as a 10th feature — coefficient ~0.01,
        // redundant with the sim's power/KO model, no accuracy gain. Dropped.
        // NOTE: current streak tested as a feature — redundant with form (#4),
        // did not improve held-out accuracy. Displayed in UI only.
      ],
      y: out === "W/L" ? 1 : 0,
      mf: Math.min(sA.w + sA.l, sB.w + sB.l), // prior UFC fights of the LESS experienced fighter
      fa: nA, fb: nB,                         // fighter names (for joining to betting lines)
      // for prop validation (prop-eval.mjs): format, actual method class, and the sim's method split per fighter
      nR, div, rd: +r.ROUND || 0,
      oc: out === "W/L" || out === "L/W" ? (out === "W/L" ? 0 : 3) + (isKO ? 0 : isSub ? 1 : /Decision/.test(method) ? 2 : NaN) : NaN,
      sh: [t.mA.KO/Math.max(1,t.A), t.mA.SUB/Math.max(1,t.A), t.mA.DEC/Math.max(1,t.A), t.mB.KO/Math.max(1,t.B), t.mB.SUB/Math.max(1,t.B), t.mB.DEC/Math.max(1,t.B)],
      tend: [[sA.koW, sA.subW, sA.w, sA.koL, sA.subL, sA.l], [sB.koW, sB.subW, sB.w, sB.koL, sB.subL, sB.l]], // career finish/finished mix at fight time
      snap: nR === 5 ? [A, B] : null,         // 5-round snapshots for format tuning
      // fighter profiles at fight time, for bias checks (output only — not model inputs)
      at: { ageA: A.age, ageB: B.age, reachA: A.reach, reachB: B.reach, htA: A.ht, htB: B.ht, layA: +layoff(sA).toFixed(1), layB: +layoff(sB).toFixed(1),
            stA: A.stance, stB: B.stance, td15A: +A.td15.toFixed(2), td15B: +B.td15.toFixed(2), slpmA: +A.slpm.toFixed(2), slpmB: +B.slpm.toFixed(2),
            sapmA: +A.sapm.toFixed(2), sapmB: +B.sapm.toFixed(2), sub15A: +A.sub15.toFixed(2), sub15B: +B.sub15.toFixed(2),
            eloA: Math.round(sA.elo), eloB: Math.round(sB.elo), wA: sA.w, lA: sA.l, wB: sB.w, lB: sB.l, koWA: sA.koW, koWB: sB.koW, koLA: sA.koL, koLB: sB.koL,
            strA: streak(sA.res), strB: streak(sB.res), koLastA: sA.lastLossKO ? 1 : 0, koLastB: sB.lastLossKO ? 1 : 0 },
      rdp: [1, 2, 3, 4, 5].slice(0, nR).map(k => ((t.rdA[k] || 0) + (t.rdB[k] || 0)) / (t.A + t.B)), // sim finish chance by round
      tm: (Math.max(1, +r.ROUND || 1) - 1) * 5 + (() => { const q = (r.TIME || "0:00").split(":"); return (+q[0] || 0) + (+q[1] || 0) / 60; })(), // minutes elapsed at the end
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
    win.res.push(1); lose.res.push(-1); win.lastLossKO = false; lose.lastLossKO = isKO;
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
const FEAT = ["logit(pSim)","eloGap/100","youth/5","reach/5","form/3","rust/12","exp","winrate*4","ctrlDom", ...(PRE ? ["outsideWR","proExp"] : []), ...(KOF ? ["koLast"] : [])];
console.log("\ncoefficients:"); FEAT.slice(0, b.length).forEach((f,i)=>console.log("  " + f.padEnd(12), b[i].toFixed(4)));

const fitRows = trainRows => {
  const m = trainRows.flatMap(r => [r, { x: r.x.map(v=>-v), y: 1 - r.y }]);
  const w = new Array(D).fill(0);
  for (let it = 0; it < 3000; it++) {
    const g = new Array(D).fill(0);
    for (const r of m) { const e = sig(r.x.reduce((s,v,i)=>s+v*w[i],0)) - r.y; for (let i = 0; i < D; i++) g[i] += e * r.x[i]; }
    for (let i = 0; i < D; i++) w[i] -= LR * (g[i]/m.length + L2*w[i]);
  }
  return w;
};
console.log("\nPRODUCTION B_COEF (fit on all " + rows.length + " rows, 2019->now):", JSON.stringify(fitRows(rows).map(v => +v.toFixed(4))));

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

// ---- accuracy bucketed by the LESS-experienced fighter's prior UFC fights ----
console.log(`\n=== held-out accuracy by min(prior UFC fights) of the two fighters ===`);
const predOf = r => sig(r.x.reduce((s,v,i)=>s+v*b[i],0));
const buckets = [[0,1,"0-1 fights (debut/near-debut)"],[2,3,"2-3 fights"],[4,6,"4-6 fights"],[7,10,"7-10 fights"],[11,999,"11+ fights (established)"]];
for (const [lo,hi,label] of buckets) {
  const set = test.filter(r => r.mf >= lo && r.mf <= hi);
  if (!set.length) { console.log(`  ${label.padEnd(30)} n=0`); continue; }
  let hit = 0, ll = 0;
  for (const r of set) { const p = Math.min(0.99, Math.max(0.01, predOf(r))); if ((p >= 0.5) === (r.y === 1)) hit++; ll += -Math.log(r.y ? p : 1-p); }
  console.log(`  ${label.padEnd(30)} n=${String(set.length).padStart(3)}  acc ${(100*hit/set.length).toFixed(1)}%  logloss ${(ll/set.length).toFixed(3)}`);
}

writeFileSync(ROOT + "/ufc-eval-coefs.json", JSON.stringify(b));
console.log("\ncoefficients saved to ufc-eval-coefs.json");

// ---- --dump: walk-forward out-of-sample predictions for market comparison ----
// For each year Y (2021..now) fit the logistic head ONLY on fights before Y, then predict
// every fight in Y. Every probability is genuinely pre-fight; nothing is fit on its own year.
if (process.argv.includes("--dump")) {
  const fitLogit = fitRows;
  const out = [];
  for (let Y = 2021; Y <= TODAY.getFullYear(); Y++) {
    const cut = new Date(`${Y}-01-01`), next = new Date(`${Y+1}-01-01`);
    const w = fitLogit(rows.filter(r => r.date < cut));
    for (const r of rows.filter(r => r.date >= cut && r.date < next))
      out.push({ date: r.date.toISOString().slice(0,10), a: r.fa, b: r.fb, p: +sig(r.x.reduce((s,v,i)=>s+v*w[i],0)).toFixed(4), y: r.y, mf: r.mf,
        nR: r.nR, div: r.div, rd: r.rd, oc: Number.isNaN(r.oc) ? -1 : r.oc, sh: r.sh.map(v => +v.toFixed(3)), tend: r.tend, rdp: r.rdp.map(v => +v.toFixed(4)), tm: +r.tm.toFixed(2), at: r.at });
  }
  writeFileSync(ROOT + "/ufc-eval-preds.json", JSON.stringify(out));
  // 5-round fighter snapshots (all years) so the 5-round engine can be tuned without re-running everything
  writeFileSync(ROOT + "/ufc-eval-snaps5.json", JSON.stringify(rows.filter(r => r.snap).map(r => ({ date: r.date.toISOString().slice(0,10), A: r.snap[0], B: r.snap[1], oc: Number.isNaN(r.oc) ? -1 : r.oc, rd: r.rd }))));
  console.log(`\nwalk-forward dump: ${out.length} out-of-sample predictions (2021-${TODAY.getFullYear()}) -> ufc-eval-preds.json`);
}
