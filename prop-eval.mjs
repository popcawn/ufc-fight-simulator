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
// variants tested 2026-10-02 (bias hunt: women's fights got 24.5% KO odds vs 13.7% real):
//   --divbase     shrink each career mix toward its division+gender's own mix (earlier years only)
//   --genderbase  shrink toward the men's / women's mix (earlier years only)
//   --womenbias   two extra numbers: KO and submission offsets for women's fights
// ADOPTED: gender base (improved every log loss in both 2022-23 and 2024-26; women's KO odds 24.5% -> 16.7% vs 13.7% real).
// --formatbase restores the old single league-wide average.
const DIVB = process.argv.includes("--divbase"), GENB = !process.argv.includes("--formatbase") && !DIVB, WB = process.argv.includes("--womenbias");
const isW = r => /Women/.test(r.div || ""), NP = WB ? 9 : 7;
const genderSplit = (year, w, f) => { const key = `g|${year}|${w}|${f}`; if (splitCache.has(key)) return splitCache.get(key);
  const c = [1, 1, 1]; for (const h of hist) if (h.y < year && h.f === f && /Women/.test(h.div) === w) c[h.k]++;
  const n = c[0] + c[1] + c[2], s = c.map(x => x / n); splitCache.set(key, s); return s; };
const baseOf = r => DIVB ? divSplit(+r.date.slice(0, 4), r.div, r.nR) : GENB ? genderSplit(+r.date.slice(0, 4), isW(r), r.nR) : BASE[r.nR];
const mixOf = (k1, k2, n, b) => { const d = Math.max(0, n - k1 - k2); return [(k1 + K*b[0])/(n+K), (k2 + K*b[1])/(n+K), (d + K*b[2])/(n+K)]; };
const feats = (sh, tW, tL, b) => { const w = mixOf(tW[0], tW[1], tW[2], b), l = mixOf(tL[3], tL[4], tL[5], b);
  return [0, 1, 2].map(m => [Math.log(Math.max(FL, sh[m])), Math.log(w[m]), Math.log(l[m])]); };
const softmax = z => { const mx = Math.max(...z), e = z.map(v => Math.exp(v - mx)), s = e.reduce((a, b) => a + b, 0); return e.map(v => v / s); };
const headShares = (th, Fm, f, w) => softmax([0, 1, 2].map(m => th[0]*Fm[m][0] + th[1]*Fm[m][1] + th[2]*Fm[m][2] + (m < 2 ? th[f === 5 ? 5 + m : 3 + m] + (w && NP > 7 ? th[7 + m] : 0) : 0)));
const sideFeats = (r, side) => side === 0 ? feats(r.sh.slice(0, 3), r.tend[0], r.tend[1], baseOf(r)) : feats(r.sh.slice(3), r.tend[1], r.tend[0], baseOf(r));
function fitHead(S) { // conditional on the actual winner: which method did they win by?
  const ex = S.map(r => ({ Fm: sideFeats(r, r.oc < 3 ? 0 : 1), f: r.nR, m: r.oc % 3, w: isW(r) }));
  const th = new Array(NP).fill(0); th[0] = 1;
  for (let it = 0; it < 2500; it++) {
    const g = new Array(NP).fill(0);
    for (const e of ex) { const p = headShares(th, e.Fm, e.f, e.w);
      for (let m = 0; m < 3; m++) { const d = p[m] - (m === e.m ? 1 : 0);
        g[0] += d*e.Fm[m][0]; g[1] += d*e.Fm[m][1]; g[2] += d*e.Fm[m][2];
        if (m < 2) { g[e.f === 5 ? 5 + m : 3 + m] += d; if (e.w && NP > 7) g[7 + m] += d; } } }
    for (let k = 0; k < NP; k++) th[k] -= 0.8 * g[k] / ex.length;
  }
  return th.map(v => +v.toFixed(4));
}
const years = [...new Set(F.map(r => +r.date.slice(0, 4)))].sort();
for (const Y of years.slice(1)) {
  const th = fitHead(F.filter(r => +r.date.slice(0, 4) < Y));
  for (const r of F.filter(r => +r.date.slice(0, 4) === Y))
    r.P.head = six(r.p, headShares(th, sideFeats(r, 0), r.nR, isW(r)), headShares(th, sideFeats(r, 1), r.nR, isW(r)));
}
F = F.filter(r => r.P.head);   // score every model on the same walk-forward years
const YR = (process.argv.find(a => a.startsWith("--years=")) || "").slice(8).split("-").map(Number); // e.g. --years=2022-2023
if (YR.length === 2 && YR[0]) F = F.filter(r => +r.date.slice(0, 4) >= YR[0] && +r.date.slice(0, 4) <= YR[1]);
if (process.argv.includes("--thin")) F = F.filter(r => r.mf < 4);   // a fighter with under 4 UFC fights
if (process.argv.includes("--est")) F = F.filter(r => r.mf >= 4);    // both fighters 4+ UFC fights

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
// trouble spots found by the bias hunt: predicted vs actual for the calibrated head
{ const G = (lab, S, m) => { if (S.length < 40) return; const pr = S.reduce((s, r) => s + (m === 2 ? r.P.head[2] + r.P.head[5] : r.P.head[m] + r.P.head[m + 3]), 0) / S.length, ac = S.filter(r => r.oc % 3 === m).length / S.length;
    const se = Math.sqrt(S.reduce((s, r) => { const q = m === 2 ? r.P.head[2] + r.P.head[5] : r.P.head[m] + r.P.head[m + 3]; return s + q*(1-q); }, 0)) / S.length;
    console.log(`  ${lab.padEnd(34)} n=${String(S.length).padStart(4)} predicted ${(100*pr).toFixed(1)}% actual ${(100*ac).toFixed(1)}% (z ${((ac-pr)/se).toFixed(1)})`); };
  console.log("\nTROUBLE SPOTS (calibrated head):");
  const W = F.filter(r => /Women/.test(r.div)), M = F.filter(r => !/Women/.test(r.div));
  G("women's: ends by KO/TKO", W, 0); G("women's: goes the distance", W, 2); G("men's: ends by KO/TKO", M, 0); G("men's: goes the distance", M, 2);
  for (const dv of ["Heavyweight", "Light Heavyweight", "Middleweight", "Welterweight", "Lightweight", "Featherweight", "Bantamweight", "Flyweight"]) {
    const S = F.filter(r => r.div === dv); G(`${dv}: ends by KO/TKO`, S, 0); G(`${dv}: goes the distance`, S, 2); }
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
// ---- TOTAL ROUNDS vs REAL BETTING LINES (ufc-data/totals-history.json from totals-history.mjs, paid key) ----
// Joins near-close round lines to the walk-forward predictions and bets them: raw model vs market-anchored
// (blend fit on earlier years only), split by how far the model and the books disagree.
if (F[0].rdp && existsSync(DIR + "totals-history.json")) {
  const TH_ = JSON.parse(readFileSync(DIR + "totals-history.json", "utf8"));
  const pre = hist.filter(h => h.y < 2021 && h.k < 2), HALF = pre.filter(h => (h.tm % 5) < 2.5).length / pre.length;
  const underP = (r, L) => { const tot = r.rdp.reduce((a, b) => a + b, 0), sc = tot ? (1 - r.P.head[2] - r.P.head[5]) / tot : 0, X = Math.floor(L);
    let u = 0; for (let k = 1; k <= X; k++) u += (r.rdp[k - 1] || 0) * sc; return u + HALF * (r.rdp[X] || 0) * sc; };
  const nm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(), ln = s => nm(s).split(" ").pop();
  const byDay = new Map(); for (const [d, c] of Object.entries(TH_)) for (const f of c.fights) (byDay.get(d) || byDay.set(d, []).get(d)).push(f);
  const lg = p => Math.log(Math.min(.99, Math.max(.01, p)) / (1 - Math.min(.99, Math.max(.01, p)))), sg = z => 1 / (1 + Math.exp(-z));
  const X = [];
  for (const r of F) { const t = new Date(r.date).getTime(), A = nm(r.a), B = nm(r.b); let m = null;
    for (let k = -1; k <= 1 && !m; k++) { const L2 = byDay.get(new Date(t + k * 864e5).toISOString().slice(0, 10)) || [];
      m = L2.find(f => (nm(f.a) === A && nm(f.b) === B) || (nm(f.a) === B && nm(f.b) === A)) || L2.find(f => (ln(f.a) === ln(r.a) && ln(f.b) === ln(r.b)) || (ln(f.a) === ln(r.b) && ln(f.b) === ln(r.a))); }
    if (!m) continue;
    const pts = {}; for (const b of Object.values(m.tot)) for (const [pt, v] of Object.entries(b)) if (v[0] > 1 && v[1] > 1) (pts[pt] ||= []).push(v);
    const main = Object.entries(pts).sort((a, b) => b[1].length - a[1].length)[0]; if (!main) continue;
    const L = +main[0], v = main[1], mo = v.reduce((s, x) => s + x[0], 0) / v.length, mu = v.reduce((s, x) => s + x[1], 0) / v.length;
    const mktU = (1 / mu) / (1 / mo + 1 / mu), modU = underP(r, L), y = r.tm < L * 5 ? 1 : 0;
    X.push({ r, L, mo, mu, mktU, modU, y, yr: +r.date.slice(0, 4), gap: Math.abs(lg(modU) - lg(mktU)) });
  }
  const ll = (k) => (X.reduce((s, x) => s - Math.log(x.y ? Math.min(.99, Math.max(.01, x[k])) : 1 - Math.min(.99, Math.max(.01, x[k]))), 0) / X.length).toFixed(4);
  console.log(`\nTOTAL ROUNDS vs REAL LINES — ${X.length} fights matched (near-close, mean price across books)`);
  console.log(`  who predicts rounds better (log loss): market ${ll("mktU")} · model ${ll("modU")}`);
  // anchored blend fit on earlier years only (same idea as the moneyline anchor)
  const fit = S => { let a = 1, b = 0; for (let it = 0; it < 3000; it++) { let ga = 0, gb = 0; for (const x of S) { const e = sg(a * lg(x.mktU) + b * lg(x.modU)) - x.y; ga += e * lg(x.mktU); gb += e * lg(x.modU); } a -= 0.5 * ga / S.length; b -= 0.5 * gb / S.length; } return [a, b]; };
  const yrs = [...new Set(X.map(x => x.yr))].sort(); let lastW = null;
  for (const Y of yrs.slice(1)) { const w = fit(X.filter(x => x.yr < Y)); lastW = w; for (const x of X.filter(x => x.yr === Y)) x.ancU = sg(w[0] * lg(x.mktU) + w[1] * lg(x.modU)); }
  const XA = X.filter(x => x.ancU != null);
  console.log(`  anchored blend (walk-forward ${yrs[1]}+): latest weights market ${lastW[0].toFixed(2)} / model ${lastW[1].toFixed(2)} · log loss market ${(XA.reduce((s, x) => s - Math.log(x.y ? x.mktU : 1 - x.mktU), 0) / XA.length).toFixed(4)} vs blend ${(XA.reduce((s, x) => s - Math.log(x.y ? x.ancU : 1 - x.ancU), 0) / XA.length).toFixed(4)}`);
  const bets = (k, lo, hi, S = XA) => { const out = []; for (const x of S) for (const [p, o, won] of [[x[k], x.mu, x.y === 1], [1 - x[k], x.mo, x.y === 0]]) { const ev = p * o - 1; if (ev >= lo && ev < hi) out.push({ x, pnl: won ? o - 1 : -1 }); } return out; };
  const st = B => { const pl = B.reduce((s, b) => s + b.pnl, 0); return B.length ? `${String(B.length).padStart(4)} bets ROI ${(100 * pl / B.length >= 0 ? "+" : "") + (100 * pl / B.length).toFixed(1)}% (${pl >= 0 ? "+" : ""}${pl.toFixed(0)}u)` : "   0 bets"; };
  console.log(`  BETTING at the mean near-close price (flat 1u):`);
  console.log(`    raw model, edge 5-20%            ${st(bets("modU", .05, .20))}   |   raw model, any edge 5%+ ${st(bets("modU", .05, 9))}`);
  console.log(`    market-anchored, edge 5-20%      ${st(bets("ancU", .05, .20))}   |   anchored, edge 3%+ ${st(bets("ancU", .03, 9))}`);
  for (const [lab, lo, hi] of [["model & books close (gap < 0.4)", 0, .4], ["moderate gap (0.4-0.75)", .4, .75], ["big gap (> 0.75, ~2x odds)", .75, 99]]) {
    const S2 = XA.filter(x => x.gap >= lo && x.gap < hi); console.log(`    ${lab.padEnd(34)} n=${String(S2.length).padStart(4)} · raw 5-20% ${st(bets("modU", .05, .20, S2))} · anchored 5-20% ${st(bets("ancU", .05, .20, S2))}`); }
  const D5 = XA.filter(x => x.r.nR === 5 && x.L === 4.5); console.log(`    5-round fights, 4.5-round line (≈ goes the distance) n=${D5.length} · raw ${st(bets("modU", .05, .20, D5))} · anchored ${st(bets("ancU", .05, .20, D5))}`);
}
// production fit on every year -> index.html (M_COEF) with --apply
const PROD = fitHead(JSON.parse(readFileSync(ROOT + "/ufc-eval-preds.json", "utf8")).filter(r => r.sh && r.oc >= 0 && r.tend));
console.log(`\nPRODUCTION M_COEF (all years): ${JSON.stringify(PROD)}   [sim, winner's finish mix, loser's finished mix, KO3, SUB3, KO5, SUB5]`);
if (process.argv.includes("--apply")) {
  const idx = ROOT + "/index.html", src = readFileSync(idx, "utf8"), re = /\/\*MCOEF\*\/[\s\S]*?\/\*END_MCOEF\*\//;
  if (!re.test(src)) { console.log("index.html has no /*MCOEF*/ marker"); process.exit(1); }
  let out = src.replace(re, `/*MCOEF*/${JSON.stringify(PROD)}/*END_MCOEF*/`);
  const GB = {}; for (const w of [false, true]) for (const f of [3, 5]) GB[(w ? "W" : "M") + f] = genderSplit(9999, w, f).map(v => +v.toFixed(4));
  const gre = /\/\*GBASE\*\/[\s\S]*?\/\*END_GBASE\*\//; if (!gre.test(out)) { console.log("index.html has no /*GBASE*/ marker"); process.exit(1); }
  out = out.replace(gre, `/*GBASE*/${JSON.stringify(GB)}/*END_GBASE*/`);
  writeFileSync(idx, out);
  console.log("M_COEF + GBASE written to index.html", JSON.stringify(GB));
}
