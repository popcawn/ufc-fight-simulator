// Warns when a fighter on an upcoming card can't be tied to the roster, so a name mismatch isn't mistaken for a debut.
// Read-only: prints GitHub warnings, changes nothing. Fix a flagged name by adding a line to NAME_ALIAS in index.html.
import { readFileSync } from "fs";
const ROOT = import.meta.dirname.replace(/\\/g, "/");
const O = JSON.parse(readFileSync(ROOT + "/odds.json", "utf8"));
const html = readFileSync(ROOT + "/classic.html", "utf8"); // the Classic roster holds every UFC fighter
const roster = [...html.match(/const F = \[([\s\S]*?)\n\];/)[1].matchAll(/^\["((?:[^"\\]|\\.)*)"/gm)].map(m => JSON.parse('"' + m[1] + '"'));
const alias = (() => { const m = readFileSync(ROOT + "/index.html", "utf8").match(/const NAME_ALIAS = (\{[\s\S]*?\});/); try { return m ? Function("return " + m[1])() : {}; } catch (e) { return {}; } })();
const nmz = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
// a roster name like "Bruno Silva (Flyweight)" counts as the sportsbook's plain "Bruno Silva"
const keys = roster.map(n => { const q = nmz(n.replace(/\s*\([^)]*\)$/, "")); return { n, q, sq: q.replace(/ /g, ""), last: q.split(" ").pop() }; }), exact = new Map(keys.map(k => [k.q, k.n]));
const dist = (a, b) => { const d = [...Array(a.length + 1)].map((_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] !== b[j - 1])); return d[a.length][b.length]; };
const now = Date.now(), up = Object.values(O.fights).filter(f => { const t = new Date(f.t).getTime(); return t > now && t < now + 21 * 864e5 && f.seen === O.updated; });
let flagged = 0;
for (const f of up) {
  const hit = [f.a, f.b].map(n => { const k = nmz(n); return exact.get(alias[k] ? nmz(alias[k]) : k); });
  if (hit[0] && hit[1]) continue; if (!hit[0] && !hit[1]) continue; // both known, or neither (another promotion / two debuts)
  const miss = hit[0] ? f.b : f.a, k = nmz(miss), sq = k.replace(/ /g, ""), last = k.split(" ").pop();
  const close = keys.filter(x => dist(x.sq, sq) <= 2 || (x.last === last && x.q[0] === k[0])).map(x => x.n).slice(0, 4);
  if (close.length) { flagged++; console.log(`::warning::${f.t.slice(0, 10)} "${miss}" (vs ${hit[0] || hit[1]}) is not an exact roster name. Possible match: ${close.join(" / ")}. If it is the same person, add an alias.`); }
}
for (let i = 0; i < up.length; i++) for (let j = i + 1; j < up.length; j++) { // one fight listed twice = its books are split across two rows
  const a = up[i], b = up[j], A = [nmz(a.a), nmz(a.b)], B = [nmz(b.a), nmz(b.b)];
  if (Math.abs(new Date(a.t) - new Date(b.t)) < 3 * 864e5 && A.some(x => B.includes(x))) { flagged++; console.log(`::warning::same fighter in two listings: "${a.a} v ${a.b}" and "${b.a} v ${b.b}". If it is one fight, alias the odd name so the books line up.`); }
}
console.log(`check-names: ${up.length} upcoming fights checked, ${flagged} flagged`);
