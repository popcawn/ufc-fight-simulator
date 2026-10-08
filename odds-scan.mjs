// Card scanner feed: pulls every MMA moneyline from US sportsbooks (The Odds API) into odds.json, which
// the app's "This week" panel reads. Keeps, per fight and book, the FIRST price ever seen (so the app knows
// how fresh a line is — the backtested edge lives at the opener) and the latest price (frozen once the fight
// starts = the closing line, used by the bet log's CLV tracker).
// Also pulls total rounds (over/under X.5), the one UFC prop the feed carries, as f.tot = { book: { point: [over, under] } }.
// Key: env ODDS_API_KEY (GitHub secret) or a local .odds-key file (gitignored). Each run costs 4 API credits.
// Run: node odds-scan.mjs
import { readFileSync, writeFileSync, existsSync } from "fs";

const ROOT = import.meta.dirname.replace(/\\/g, "/"), OUT = ROOT + "/odds.json";
const KEY = process.env.ODDS_API_KEY || (existsSync(ROOT + "/.odds-key") ? readFileSync(ROOT + "/.odds-key", "utf8").trim() : "");
if (!KEY) { console.log("::warning::ODDS_API_KEY not set — add it under repo Settings > Secrets and variables > Actions"); process.exit(0); }

const url = `https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds?regions=us,us2&markets=h2h,totals&oddsFormat=decimal&apiKey=${KEY}`;
const res = await fetch(url);
if (!res.ok) { // out of monthly credits / bad key: warn instead of failing every run; the app flags odds older than 36h
  const msg = (await res.text()).slice(0, 200);
  if (res.status === 401 || res.status === 429) { console.log(`::warning::Odds API ${res.status}: ${msg}`); process.exit(0); }
  console.log(`::error::Odds API ${res.status}: ${msg}`); process.exit(1); }
const feed = await res.json(), now = new Date().toISOString();

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const fights = prev ? prev.fights : {};
const seeding = !prev; // lines already posted before the first scan: their true opener is unknown
let added = 0;
for (const e of feed) {
  const f = fights[e.id] || (added++, fights[e.id] = { a: e.home_team, b: e.away_team, t: e.commence_time, first: seeding ? null : now, open: {}, now: {} });
  f.t = e.commence_time; f.seen = now;
  for (const bk of e.bookmakers) {
    const m = bk.markets.find(x => x.key === "h2h"); if (!m) continue;
    const pa = m.outcomes.find(o => o.name === f.a), pb = m.outcomes.find(o => o.name === f.b);
    if (!pa || !pb) continue;
    const px = [pa.price, pb.price];
    if (!(bk.key in f.open)) f.open[bk.key] = seeding ? null : px; // first price this book ever showed (null = posted before scanning began)
    f.now[bk.key] = px;
  }
  f.tot = {}; // total rounds: latest prices only (frozen once the fight starts = closing, for the bet log)
  for (const bk of e.bookmakers) {
    const m = bk.markets.find(x => x.key === "totals"); if (!m) continue;
    const t = {};
    for (const o of m.outcomes) if (o.point != null) (t[o.point] ||= [0, 0])[o.name === "Over" ? 0 : 1] = o.price;
    for (const [pt, v] of Object.entries(t)) if (v[0] > 1 && v[1] > 1) {
      (f.tot[bk.key] ||= {})[pt] = v;
      const o = (f.totOpen ||= {})[bk.key] ||= {}; if (!(pt in o)) o[pt] = seeding ? null : v; // first round line this book showed
    }
  }
}
// keep finished fights 60 days in odds.json (closing lines for the bet log), then move them to odds-archive.json —
// a permanent record of opening + closing moneylines and round lines for future prop backtests
const cutoff = Date.now() - 60 * 864e5, ARCH = ROOT + "/odds-archive.json";
const archive = existsSync(ARCH) ? JSON.parse(readFileSync(ARCH, "utf8")) : {};
let archived = 0;
for (const [id, f] of Object.entries(fights)) if (new Date(f.t).getTime() < cutoff) { archive[id] = f; delete fights[id]; archived++; }
if (archived || !existsSync(ARCH)) writeFileSync(ARCH, JSON.stringify(archive));

const books = { ...(prev ? prev.books : {}) };
for (const e of feed) for (const bk of e.bookmakers) books[bk.key] = bk.title;
const credits = { remaining: +res.headers.get("x-requests-remaining"), used: +res.headers.get("x-requests-used") };
writeFileSync(OUT, JSON.stringify({ updated: now, credits, books, fights }));
console.log(`odds.json: ${feed.length} fights in feed, ${added} new, ${Object.keys(fights).length} stored · API credits left this month: ${credits.remaining}`);
