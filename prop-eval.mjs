// Prop validation: does the sim know HOW fights end, fight by fight — or only who wins?
// Uses the walk-forward dump (node eval.mjs --dump): each fight's pre-fight win prob (p), the sim's
// method split for each fighter (sh = A KO/SUB/DEC share of A's wins, then B's), and what actually
// happened (oc: 0-2 = A by KO/SUB/DEC, 3-5 = B by KO/SUB/DEC). No prop betting lines exist in the data,
// so this checks calibration and skill against simple baselines, not ROI.
//   Baseline "division": same win prob, each division+format's method split from EARLIER years only.
//   Baseline "tendency": same win prob, each fighter's own career finish mix, shrunk to the division.
// The fix, "head": a 7-number softmax that turns the sim's method split into calibrated odds, blending
// it with the winner's career finishing mix and the loser's career history of being finished. Fit
// walk-forward (earlier years only) for the report; --apply writes the all-years fit into index.html.
// Run: node eval.mjs --dump && node prop-eval.mjs [--apply]
import { readFileSync, writeFileSync, existsSync } from "fs";

const ROOT = import.meta.dirname.replace(/\\/g, "/"), DIR = ROOT + "/ufc-data/";
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
if (!existsSync(ROOT + "/ufc-eval-preds.json")) { console.log("run: node eval.mjs --dump   first"); process.exit(1); }
let F = JSON.parse(readFileSync(ROOT + "/ufc-eval-preds.json", "utf8")).filter(r => r.sh && r.oc >= 0);
if (!F.length) { console.log("dump has no method fields — re-run: node eval.mjs --dump"); process.exit(1); }

// division + format method split from real fights BEFORE each year (2010+), keyed "year|div|fmt"
const ev = new Map(parseCSV(readFileSync(DIR + "ufc_event_details.csv", "utf8")).map(e => [e.EVENT.trim(), new Date(e.DATE)]));
const hist = [];
for (const r of parseCSV(readFileSync(DIR + "ufc_fight_results.csv", "utf8"))) {
  const d = ev.get(r.EVENT.trim()); if (!d || d.getFullYear() < 2010 || !/^(W\/L|L\/W)$/.test(r.OUTCOME.trim())) continue;
  const m = r.METHOD || "", k = /KO\/TKO|TKO/.test(m) ? 0 : /Submission/.test(m) ? 1 : /Decision/.test(m) ? 2 : -1; if (k < 0) continue;
  const div = ((r.WEIGHTCLASS || "").match(/(Women's )?(Straw|Fly|Bantam|Feather|Light Heavy|Light|Welter|Middle|Heavy)weight/) || ["Unknown"])[0];
  const q = (r.TIME || "0:00").split(":"), tm = (Math.max(1, +r.ROUND || 1) - 1) * 5 + (+q[0] || 0) + (+q[1] || 0) / 60;
  hist.push({ y: d.getFullYear(), div, f: /5 Rnd/.test(r["TIME FORMAT"] || "") ? 5 : 3, k, tm });
}
const splitCache = new Map();
const divSplit = (year, div, f) => {
  const key = `${year}|${div}|${f}`; if (splitCache.has(key)) return splitCache.get(key);
  const c = [1, 1, 1], all = [1, 1, 1]; // +1 smoothing
  for (const h of hist) if (h.y < year && h.f === f) { all[h.k]++; if (h.div === div) c[h.k]++; }
  const n = c[0] + c[1] + c[2], na = all[0] + all[1] + all[2], w = Math.min(1, n / 150); // thin divisions lean on the all-division mix
  const s = [0, 1, 2].map(i => w * c[i] / n + (1 - w) * all[i] / na);
  splitCache.set(key, s); return s;
};

const EPS = 0.002, norm6 = v => { const x = v.map(p => Math.max(EPS, p)), s = x.reduce((a, b) => a + b, 0); return x.map(p => p / s); };
const six = (pA, sA, sB) => norm6([pA*sA[0], pA*sA[1], pA*sA[2], (1-pA)*sB[0], (1-pA)*sB[1], (1-pA)*sB[2]]);
const tend = (r, who, base) => { const t = r.tend && r.tend[who]; if (!t) return null; const [ko, sub, w] = t, K = 5, dec = Math.max(0, w - ko - sub);
  return [(ko + K*base[0]) / (w + K), (sub + K*base[1]) / (w + K), (dec + K*base[2]) / (w + K)]; };
const models = { sim: [], division: [], tendency: [] };
for (const r of F) {
  const base = divSplit(+r.date.slice(0, 4), r.div, r.nR);
  r.P = { sim: six(r.p, r.sh.slice(0, 3), r.sh.slice(3)), division: six(r.p, base, base) };
  const tA = tend(r, 0, base), tB = tend(r, 1, base);
  if (tA && tB) r.P.tendency = six(r.p, tA, tB);
}
// ---- calibrated method head (must match methodShares() in index.html) ----
const BASE = { 3: [0.31, 0.185, 0.505], 5: [0.40, 0.15, 0.45] }, K = 5, FL = 0.01;
const mixOf = (k1, k2, n, b) => { const d = Math.max(0, n - k1 - k2); return [(k1 + K*b[0])/(n+K), (k2 + K*b[1])/(n+K), (d + K*b[2])/(n+K)]; };
const feats = (sh, tW, tL, f) => { const b = BASE[f], w = mixOf(tW[0], tW[1], tW[2], b), l = mixOf(tL[3], tL[4], tL[5], b);
  return [0, 1, 2].map(m => [Math.log(Math.max(FL, sh[m])), Math.log(w[m]), Math.log(l[m])]); };
const softmax = z => { const mx = Math.max(...z), e = z.map(v => Math.exp(v - mx)), s = e.reduce((a, b) => a + b, 0); return e.map(v => v / s); };
const headShares = (th, Fm, f) => softmax([0, 1, 2].map(m => th[0]*Fm[m][0] + th[1]*Fm[m][1] + th[2]*Fm[m][2] + (m < 2 ? th[f === 5 ? 5 + m : 3 + m] : 0)));
const sideFeats = (r, side) => side === 0 ? feats(r.sh.slice(0, 3), r.tend[0], r.tend[1], r.nR) : feats(r.sh.slice(3), r.tend[1], r.tend[0], r.nR);
function fitHead(S) { // conditional on the actual winner: which method did they win by?
  const ex = S.map(r => ({ Fm: sideFeats(r, r.oc < 3 ? 0 : 1), f: r.nR, m: r.oc % 3 }));
  const th = [1, 0, 0, 0, 0, 0, 0];
  for (let it = 0; it < 2500; it++) {
    const g = new Array(7).fill(0);
    for (const e of ex) { const p = headShares(th, e.Fm, e.f);
      for (let m = 0; m < 3; m++) { const d = p[m] - (m === e.m ? 1 : 0);
        g[0] += d*e.Fm[m][0]; g[1] += d*e.Fm[m][1]; g[2] += d*e.Fm[m][2]; if (m < 2) g[e.f === 5 ? 5 + m : 3 + m] += d; } }
    for (let k = 0; k < 7; k++) th[k] -= 0.8 * g[k] / ex.length;
  }
  return th.map(v => +v.toFixed(4));
}
const years = [...new Set(F.map(r => +r.date.slice(0, 4)))].sort();
for (const Y of years.slice(1)) {
  const th = fitHead(F.filter(r => +r.date.slice(0, 4) < Y));
  for (const r of F.filter(r => +r.date.slice(0, 4) === Y))
    r.P.head = six(r.p, headShares(th, sideFeats(r, 0), r.nR), headShares(th, sideFeats(r, 1), r.nR));
}
F = F.filter(r => r.P.head);   // score every model on the same walk-forward years

const ll = (S, k, f) => S.reduce((s, r) => s - Math.log(f(r.P[k], r)), 0) / S.length;
const oc6 = (P, r) => P[r.oc];                                           // exact: winner + method
const oc3 = (P, r) => P[r.oc % 3] + P[r.oc % 3 + 3];                     // method only (KO/SUB/DEC, either fighter)
const dist = (P, r) => (r.oc % 3 === 2) ? P[2] + P[5] : 1 - P[2] - P[5]; // goes the distance yes/no
const kinds = ["sim", "division", "tendency", "head"].filter(k => F.every(r => r.P[k]));

console.log(`PROP VALIDATION — ${F.length} held-out fights (${F[0].date.slice(0,4)}–${F.at(-1).date.slice(0,4)}), win prob from the walk-forward model`);
console.log("log loss, lower = better (sim must beat the baselines to know anything about HOW fights end)");
for (const [lab, f] of [["winner + method (6-way)", oc6], ["method only (KO/SUB/DEC)", oc3], ["goes the distance (y/n)", dist]]) {
  for (const fmt of [3, 5]) {
    const S = F.filter(r => r.nR === fmt);
    console.log(`  ${lab.padEnd(26)} ${fmt}-rd n=${String(S.length).padStart(4)}  ` + kinds.map(k => `${k} ${ll(S, k, f).toFixed(4)}`).join("   "));
  }
}
// calibration: every outcome probability the sim assigned vs how often it happened
const bands = [[0, .05], [.05, .10], [.10, .15], [.15, .20], [.20, .30], [.30, .45], [.45, 1]], names = ["KO", "SUB", "DEC"];
for (const fmt of [3, 5]) for (const K_ of ["sim", "head"]) {
  const S = F.filter(r => r.nR === fmt);
  console.log(`\nCALIBRATION, ${fmt}-round fights — ${K_ === "sim" ? "raw sim" : "calibrated head"} ("fighter X by METHOD" probabilities)`);
  for (const m of [0, 1, 2]) {
    const row = bands.map(([lo, hi]) => { let n = 0, pr = 0, hit = 0;
      for (const r of S) for (const side of [0, 3]) { const p = r.P[K_][side + m]; if (p >= lo && p < hi) { n++; pr += p; hit += r.oc === side + m ? 1 : 0; } }
      return n >= 25 ? `${Math.round(100*pr/n)}→${Math.round(100*hit/n)}%(${n})` : null; }).filter(Boolean);
    console.log(`  ${names[m].padEnd(4)} predicted→actual: ` + row.join("  "));
  }
  const agg = [0, 1, 2].map(m => S.reduce((s, r) => s + r.P[K_][m] + r.P[K_][m + 3], 0) / S.length);
  const act = [0, 1, 2].map(m => S.filter(r => r.oc % 3 === m).length / S.length);
  console.log(`  overall mix   model KO ${(100*agg[0]).toFixed(1)} SUB ${(100*agg[1]).toFixed(1)} DEC ${(100*agg[2]).toFixed(1)}   |   actual KO ${(100*act[0]).toFixed(1)} SUB ${(100*act[1]).toFixed(1)} DEC ${(100*act[2]).toFixed(1)}`);
  const db = [[0, .3], [.3, .45], [.45, .6], [.6, .75], [.75, 1]].map(([lo, hi]) => { const B = S.filter(r => { const d = r.P[K_][2] + r.P[K_][5]; return d >= lo && d < hi; });
    return B.length >= 20 ? `${Math.round(100*B.reduce((s, r) => s + r.P[K_][2] + r.P[K_][5], 0)/B.length)}→${Math.round(100*B.filter(r => r.oc % 3 === 2).length/B.length)}%(${B.length})` : null; }).filter(Boolean);
  console.log(`  goes the distance predicted→actual: ` + db.join("  "));
}
// ---- TOTAL ROUNDS (over/under X.5) — the one UFC prop that sportsbook feeds carry ----
// P(under X.5) = finishes in rounds 1..X plus the share of round-(X+1) finishes that land before 2:30.
// Round timing is the sim's, scaled to the calibrated finish chance (exactly as the app shows it).
if (F[0].rdp) {
  const pre = hist.filter(h => h.y < 2021 && h.k < 2), HALF = pre.filter(h => (h.tm % 5) < 2.5).length / pre.length;
  const baseU = (f, L) => { const H = hist.filter(h => h.y < 2021 && h.f === f); return H.filter(h => h.tm < L * 5).length / H.length; };
  const underP = (r, L, raw) => { const tot = r.rdp.reduce((a, b) => a + b, 0), sc = raw ? 1 : (tot ? (1 - r.P.head[2] - r.P.head[5]) / tot : 0), X = Math.floor(L);
    let u = 0; for (let k = 1; k <= X; k++) u += (r.rdp[k - 1] || 0) * sc; return u + HALF * (r.rdp[X] || 0) * sc; };
  console.log(`\nTOTAL ROUNDS — P(under X.5) vs real finish times · ${(100*HALF).toFixed(0)}% of finishes come in a round's first half`);
  for (const [f, lines] of [[3, [1.5, 2.5]], [5, [1.5, 2.5, 3.5, 4.5]]]) for (const L of lines) {
    const S = F.filter(r => r.nR === f && r.rdp), bu = baseU(f, L), y = r => r.tm < L * 5 ? 1 : 0;
    const ll = g => S.reduce((s, r) => { const p = Math.min(.99, Math.max(.01, g(r))); return s - Math.log(y(r) ? p : 1 - p); }, 0) / S.length;
    const cal = [[0, .25], [.25, .4], [.4, .55], [.55, .7], [.7, 1]].map(([lo, hi]) => { const B = S.filter(r => { const p = underP(r, L); return p >= lo && p < hi; });
      return B.length >= 20 ? `${Math.round(100*B.reduce((s, r) => s + underP(r, L), 0)/B.length)}→${Math.round(100*B.filter(y).length/B.length)}%(${B.length})` : null; }).filter(Boolean);
    console.log(`  ${f}-rd under ${L}: n=${S.length} logloss model ${ll(r => underP(r, L)).toFixed(4)}  raw sim ${ll(r => underP(r, L, true)).toFixed(4)}  baseline ${ll(() => bu).toFixed(4)} · calibration ${cal.join("  ")}`);
  }
}
// production fit on every year -> index.html (M_COEF) with --apply
const PROD = fitHead(JSON.parse(readFileSync(ROOT + "/ufc-eval-preds.json", "utf8")).filter(r => r.sh && r.oc >= 0 && r.tend));
console.log(`\nPRODUCTION M_COEF (all years): ${JSON.stringify(PROD)}   [sim, winner's finish mix, loser's finished mix, KO3, SUB3, KO5, SUB5]`);
if (process.argv.includes("--apply")) {
  const idx = ROOT + "/index.html", src = readFileSync(idx, "utf8"), re = /\/\*MCOEF\*\/[\s\S]*?\/\*END_MCOEF\*\//;
  if (!re.test(src)) { console.log("index.html has no /*MCOEF*/ marker"); process.exit(1); }
  writeFileSync(idx, src.replace(re, `/*MCOEF*/${JSON.stringify(PROD)}/*END_MCOEF*/`));
  console.log("M_COEF written to index.html");
}
