// Model vs the betting market. Joins the walk-forward out-of-sample predictions
// (node eval.mjs --dump) to BestFightOdds opening/closing cross-book mean lines and asks:
//   1) Who predicts better — the model, the opening line, or the closing line?
//   2) Closing-line value: when the model disagrees with the open, does the line move its way?
//   3) Betting: flat-stake the model's +EV sides at the opening line — what's the ROI?
//   4) Does the model add information BEYOND the closing line (blend test)?
// Odds source: github.com/lkirby195/FightNight data/bfo_lines.csv (first tick = open, last = close).
// Run:  node eval.mjs --dump && node market-eval.mjs --apply   (--apply refreshes the in-app track record;
//       --cache reuses the downloaded lines)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const ROOT = import.meta.dirname.replace(/\\/g, "/"), DIR = ROOT + "/ufc-data/";
const BFO_URL = "https://raw.githubusercontent.com/lkirby195/FightNight/HEAD/data/bfo_lines.csv";
if (!existsSync(DIR)) mkdirSync(DIR);
const bfoPath = DIR + "bfo_lines.csv";
if (!(process.argv.includes("--cache") && existsSync(bfoPath))) {
  console.log("downloading bfo_lines.csv");
  writeFileSync(bfoPath, await fetch(BFO_URL).then(r => r.text()));
}

// ---- load ----
const preds = JSON.parse(readFileSync(ROOT + "/ufc-eval-preds.json", "utf8"));
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
const last = s => norm(s).split(" ").pop();
const lines = readFileSync(bfoPath, "utf8").trim().split("\n").slice(1).map(l => {
  const c = l.split(",");
  return { date: c[2], f1: c[4], f2: c[5], f1o: +c[6], f1c: +c[7], f2o: +c[8], f2c: +c[9] };
}).filter(r => r.f1o > 1 && r.f2o > 1 && r.f1c > 1 && r.f2c > 1);
const byDate = new Map();
for (const r of lines) { (byDate.get(r.date) || byDate.set(r.date, []).get(r.date)).push(r); }
const near = d => { const t = new Date(d).getTime(), out = []; for (let k = -2; k <= 2; k++) { const dd = new Date(t + k*864e5).toISOString().slice(0,10); if (byDate.has(dd)) out.push(...byDate.get(dd)); } return out; };

// ---- join: exact normalized names first, then last-name fallback on the same card ----
const devig = (o1, o2) => (1/o1) / (1/o1 + 1/o2);
const J = [];
for (const p of preds) {
  const cands = near(p.date), A = norm(p.a), B = norm(p.b);
  let m = cands.find(r => (norm(r.f1) === A && norm(r.f2) === B) || (norm(r.f1) === B && norm(r.f2) === A));
  if (!m) m = cands.find(r => (last(r.f1) === last(p.a) && last(r.f2) === last(p.b)) || (last(r.f1) === last(p.b) && last(r.f2) === last(p.a)));
  if (!m) continue;
  const aIs1 = norm(m.f1) === A || (norm(m.f1) !== B && last(m.f1) === last(p.a));
  const [ao, ac, bo, bc] = aIs1 ? [m.f1o, m.f1c, m.f2o, m.f2c] : [m.f2o, m.f2c, m.f1o, m.f1c];
  J.push({ ...p, pOpen: devig(ao, bo), pClose: devig(ac, bc), ao, ac, bo, bc });
}
console.log(`joined ${J.length} of ${preds.length} out-of-sample fights to opening+closing lines (${(100*J.length/preds.length).toFixed(0)}%)\n`);

// ---- 1) head-to-head predictive quality ----
const clip = p => Math.min(0.99, Math.max(0.01, p));
function score(set, key) {
  let hit = 0, ll = 0, br = 0;
  for (const r of set) { const p = clip(r[key]); if ((p >= 0.5) === (r.y === 1)) hit++; ll += -Math.log(r.y ? p : 1-p); br += (p - r.y) ** 2; }
  return { acc: 100*hit/set.length, ll: ll/set.length, br: br/set.length };
}
const row = (label, s) => console.log(`  ${label.padEnd(20)} acc ${s.acc.toFixed(1)}%   logloss ${s.ll.toFixed(4)}   brier ${s.br.toFixed(4)}`);
console.log("=== 1) WHO PREDICTS BETTER? (lower logloss/brier = better) ===");
row("Model", score(J, "p")); row("Opening line", score(J, "pOpen")); row("Closing line", score(J, "pClose"));
for (const [lo, hi, lab] of [[1,3,"both 1-3 UFC fights"],[4,99,"both 4+ UFC fights"]]) {
  const S = J.filter(r => r.mf >= lo && r.mf <= hi);
  console.log(`  -- ${lab} (n=${S.length}): model ${score(S,"p").ll.toFixed(4)} | open ${score(S,"pOpen").ll.toFixed(4)} | close ${score(S,"pClose").ll.toFixed(4)}`);
}

// ---- 2) closing-line value: does the line move toward the model? ----
console.log("\n=== 2) DOES THE LINE MOVE TOWARD THE MODEL? (open -> close) ===");
const corr = (xs, ys) => { const n = xs.length, mx = xs.reduce((a,b)=>a+b)/n, my = ys.reduce((a,b)=>a+b)/n; let sxy=0,sxx=0,syy=0; for (let i=0;i<n;i++){ sxy+=(xs[i]-mx)*(ys[i]-my); sxx+=(xs[i]-mx)**2; syy+=(ys[i]-my)**2; } return sxy/Math.sqrt(sxx*syy); };
console.log(`  correlation(model - open, close - open) = ${corr(J.map(r=>r.p-r.pOpen), J.map(r=>r.pClose-r.pOpen)).toFixed(3)}   (> 0 = model anticipates line moves)`);
for (const th of [0.05, 0.10, 0.15]) {
  const S = J.filter(r => Math.abs(r.p - r.pOpen) >= th);
  const toward = S.filter(r => Math.sign(r.pClose - r.pOpen) === Math.sign(r.p - r.pOpen)).length;
  const avgMove = S.reduce((s,r)=> s + (r.pClose - r.pOpen) * Math.sign(r.p - r.pOpen), 0) / S.length;
  console.log(`  model disagrees with open by >=${(th*100).toFixed(0)}pts: n=${String(S.length).padStart(4)}  line moved toward model ${(100*toward/S.length).toFixed(0)}%  avg move ${(avgMove*100>=0?"+":"")}${(avgMove*100).toFixed(1)}pts`);
}

// ---- 3) betting: flat 1u on the model's +EV side at the OPENING mean line ----
// Mean lines include vig; line-shopping the best book beats them, so these ROIs are conservative.
console.log("\n=== 3) BET THE MODEL'S EDGES (flat 1 unit, cross-book mean line) ===");
for (const minEV of [0.00, 0.05, 0.10, 0.20]) {
  for (const when of ["open", "close"]) {
    let n = 0, pnl = 0, beatClose = 0;
    for (const r of J) {
      for (const side of ["a", "b"]) {
        const pm = side === "a" ? r.p : 1 - r.p, won = side === "a" ? r.y === 1 : r.y === 0;
        const odds = side === "a" ? (when === "open" ? r.ao : r.ac) : (when === "open" ? r.bo : r.bc);
        if (pm * odds - 1 < minEV) continue;
        n++; pnl += won ? odds - 1 : -1;
        if (when === "open") { const closeOdds = side === "a" ? r.ac : r.bc; if (closeOdds < odds) beatClose++; }
      }
    }
    const clv = when === "open" ? `   beat the close ${n ? (100*beatClose/n).toFixed(0) : 0}%` : "";
    console.log(`  EV >= ${(minEV*100).toFixed(0).padStart(2)}% at ${when.padEnd(5)}: bets ${String(n).padStart(4)}   ROI ${(n ? 100*pnl/n : 0).toFixed(1).padStart(6)}%   units ${pnl>=0?"+":""}${pnl.toFixed(1)}${clv}`);
  }
}

// ---- 4) blend test: does the model add information beyond the closing line? ----
// Walk-forward: fit y ~ a*logit(close) + b*logit(model) on earlier years, score the next year.
console.log("\n=== 4) DOES THE MODEL ADD INFO BEYOND THE CLOSING LINE? (walk-forward blend) ===");
const lg = p => Math.log(clip(p)/(1-clip(p))), sg = z => 1/(1+Math.exp(-z));
const fit2 = S => { let a = 1, b = 0; for (let it=0; it<4000; it++) { let ga=0, gb=0; for (const r of S) { const x1=lg(r.pClose), x2=lg(r.p), e=sg(a*x1+b*x2)-r.y; ga+=e*x1; gb+=e*x2; } a -= 0.5*ga/S.length; b -= 0.5*gb/S.length; } return [a,b]; };
const blended = [];
const years = [...new Set(J.map(r => +r.date.slice(0,4)))].sort();
for (const Y of years.slice(1)) {
  const tr = J.filter(r => +r.date.slice(0,4) < Y), te = J.filter(r => +r.date.slice(0,4) === Y);
  const [a, b] = fit2(tr);
  for (const r of te) blended.push({ ...r, pBlend: sg(a*lg(r.pClose) + b*lg(r.p)) });
  if (Y === years[years.length-1]) console.log(`  latest fit: weight on closing line ${a.toFixed(3)}, weight on model ${b.toFixed(3)}`);
}
row("Closing line", score(blended, "pClose")); row("Close + model blend", score(blended, "pBlend"));

// ---- 5) market-anchored model: blend OPENING line + model, bet its edges at the open ----
// The model moves the line (section 2), so open+model should beat open alone. If so, its
// edges vs the opening price are the real, bettable ones — not raw model-vs-line gaps.
console.log("\n=== 5) MARKET-ANCHORED: open line + model blend, bet at the open ===");
const fitO = S => { let a = 1, b = 0; for (let it=0; it<4000; it++) { let ga=0, gb=0; for (const r of S) { const x1=lg(r.pOpen), x2=lg(r.p), e=sg(a*x1+b*x2)-r.y; ga+=e*x1; gb+=e*x2; } a -= 0.5*ga/S.length; b -= 0.5*gb/S.length; } return [a,b]; };
const OB = [];
for (const Y of years.slice(1)) {
  const tr = J.filter(r => +r.date.slice(0,4) < Y), te = J.filter(r => +r.date.slice(0,4) === Y);
  const [a, b] = fitO(tr);
  for (const r of te) OB.push({ ...r, pOB: sg(a*lg(r.pOpen) + b*lg(r.p)) });
  if (Y === years[years.length-1]) console.log(`  latest fit: weight on opening line ${a.toFixed(3)}, weight on model ${b.toFixed(3)}`);
}
row("Opening line", score(OB, "pOpen")); row("Open + model blend", score(OB, "pOB")); row("Closing line", score(OB, "pClose"));
for (const minEV of [0.00, 0.03, 0.05, 0.08]) {
  let n = 0, pnl = 0, beat = 0;
  for (const r of OB) for (const side of ["a","b"]) {
    const pm = side === "a" ? r.pOB : 1 - r.pOB, won = side === "a" ? r.y === 1 : r.y === 0;
    const o = side === "a" ? r.ao : r.bo, c = side === "a" ? r.ac : r.bc;
    if (pm * o - 1 < minEV) continue;
    n++; pnl += won ? o - 1 : -1; if (c < o) beat++;
  }
  console.log(`  blend EV >= ${(minEV*100).toFixed(0)}% at open: bets ${String(n).padStart(4)}   ROI ${(n?100*pnl/n:0).toFixed(1).padStart(6)}%   units ${pnl>=0?"+":""}${pnl.toFixed(1)}   beat the close ${n?(100*beat/n).toFixed(0):0}%`);
}
// baseline: what does betting a coin-flip side at the mean line cost? (the vig you're fighting)
let vn = 0, vp = 0; for (const r of OB) { vn += 2; vp += (r.y===1 ? r.ao-1 : -1) + (r.y===0 ? r.bo-1 : -1); }
console.log(`  (baseline: betting BOTH sides of every fight at the open mean line = ROI ${(100*vp/vn).toFixed(1)}% — that's the vig to beat)`);

// ---- 6) robustness: open-blend edges by year, and the same idea at the close ----
console.log("\n=== 6) ROBUSTNESS ===");
for (const Y of years.slice(1)) {
  let n = 0, pnl = 0, beat = 0;
  for (const r of OB.filter(r => +r.date.slice(0,4) === Y)) for (const side of ["a","b"]) {
    const pm = side === "a" ? r.pOB : 1 - r.pOB, won = side === "a" ? r.y === 1 : r.y === 0;
    const o = side === "a" ? r.ao : r.bo, c = side === "a" ? r.ac : r.bc;
    if (pm * o - 1 < 0.03) continue; n++; pnl += won ? o - 1 : -1; if (c < o) beat++;
  }
  console.log(`  ${Y}  open-blend EV>=3%: bets ${String(n).padStart(3)}  ROI ${(n?100*pnl/n:0).toFixed(1).padStart(6)}%  units ${pnl>=0?"+":""}${pnl.toFixed(1).padStart(5)}  beat close ${n?(100*beat/n).toFixed(0):0}%`);
}
for (const minEV of [0.00, 0.03, 0.05]) {
  let n = 0, pnl = 0;
  for (const r of blended) for (const side of ["a","b"]) {
    const pm = side === "a" ? r.pBlend : 1 - r.pBlend, won = side === "a" ? r.y === 1 : r.y === 0, c = side === "a" ? r.ac : r.bc;
    if (pm * c - 1 < minEV) continue; n++; pnl += won ? c - 1 : -1;
  }
  console.log(`  close-blend EV >= ${(minEV*100).toFixed(0)}% bet AT THE CLOSE: bets ${String(n).padStart(4)}  ROI ${(n?100*pnl/n:0).toFixed(1).padStart(6)}%`);
}

// ---- 7) does the open-blend edge hold for thin-data fighters? ----
console.log("\n=== 7) OPEN-BLEND EDGE BY EXPERIENCE (EV >= 3%, bet at open) ===");
for (const [lo, hi, lab] of [[1,3,"less-experienced fighter has 1-3 UFC fights"],[4,99,"both fighters have 4+ UFC fights"]]) {
  let n = 0, pnl = 0, beat = 0;
  for (const r of OB.filter(r => r.mf >= lo && r.mf <= hi)) for (const side of ["a","b"]) {
    const pm = side === "a" ? r.pOB : 1 - r.pOB, won = side === "a" ? r.y === 1 : r.y === 0;
    const o = side === "a" ? r.ao : r.bo, c = side === "a" ? r.ac : r.bc;
    if (pm * o - 1 < 0.03) continue; n++; pnl += won ? o - 1 : -1; if (c < o) beat++;
  }
  console.log(`  ${lab.padEnd(46)} bets ${String(n).padStart(3)}  ROI ${(100*pnl/n).toFixed(1).padStart(5)}%  beat close ${(100*beat/n).toFixed(0)}%`);
}

// ---- 8) summary for the in-app "Model track record" card ----
// `node market-eval.mjs --apply` writes it into index.html between the /*TRACK*/ markers.
const betSim = (set, pk, when, minEV, maxEV = 9) => { let n = 0, pnl = 0, beat = 0;
  for (const r of set) for (const side of ["a","b"]) {
    const pm = side === "a" ? r[pk] : 1 - r[pk], won = side === "a" ? r.y === 1 : r.y === 0;
    const o = side === "a" ? (when === "open" ? r.ao : r.ac) : (when === "open" ? r.bo : r.bc), c = side === "a" ? r.ac : r.bc;
    if (pm * o - 1 < minEV || pm * o - 1 >= maxEV) continue; n++; pnl += won ? o - 1 : -1; if (c < o) beat++;
  }
  return { n, roi: +(100*pnl/Math.max(1,n)).toFixed(1), clv: when === "open" ? Math.round(100*beat/Math.max(1,n)) : null };
};
const sc = k => { const s = score(J, k); return { acc: +s.acc.toFixed(1), ll: +s.ll.toFixed(4) }; };
const S15 = J.filter(r => Math.abs(r.p - r.pOpen) >= 0.15);
const TRACK = {
  asOf: new Date().toISOString().slice(0,10), n: J.length, bFrom: String(years[1]), // first year of anchored bets (earlier years only fit the blend)
  from: J.reduce((a,r) => r.date < a ? r.date : a, "9999"), to: J.reduce((a,r) => r.date > a ? r.date : a, ""),
  model: sc("p"), open: sc("pOpen"), close: sc("pClose"),
  toward15: Math.round(100 * S15.filter(r => Math.sign(r.pClose - r.pOpen) === Math.sign(r.p - r.pOpen)).length / S15.length),
  rawOpen: betSim(J, "p", "open", 0), rawClose: betSim(J, "p", "close", 0),
  // THE RULE (bias hunt 2026-10-02): bet anchored edges of 5-20% at the open. 3-5% edges lost money (noise) and 20%+
  // edges lost too (usually the model being wrong); the window beat the old >=3% rule in both 2022-23 and 2024-26.
  rule: betSim(OB, "pOB", "open", 0.05, 0.20), anch3: betSim(OB, "pOB", "open", 0.03), anch5: betSim(OB, "pOB", "open", 0.05),
  est: betSim(OB.filter(r => r.mf >= 4), "pOB", "open", 0.05, 0.20), thin: betSim(OB.filter(r => r.mf < 4), "pOB", "open", 0.05, 0.20),
  byYear: years.slice(1).map(Y => ({ y: Y, ...betSim(OB.filter(r => +r.date.slice(0,4) === Y), "pOB", "open", 0.05, 0.20) })),
};
console.log("\n=== 8) TRACK RECORD SUMMARY ===\n" + JSON.stringify(TRACK));
if (process.argv.includes("--apply")) {
  const ip = ROOT + "/index.html", html = readFileSync(ip, "utf8"), re = /\/\*TRACK\*\/[\s\S]*?\/\*END_TRACK\*\//;
  if (!re.test(html)) { console.error("TRACK markers not found in index.html"); process.exit(1); }
  writeFileSync(ip, html.replace(re, "/*TRACK*/" + JSON.stringify(TRACK) + "/*END_TRACK*/"));
  console.log("wrote track record into index.html");
}
