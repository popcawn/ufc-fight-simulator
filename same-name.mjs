// Two different UFC fighters can share one UFCStats name; without this their fights merge into one record.
// Each fight goes to a fighter by its weight class.
// Row = [weight class that marks him ("" = every other fight), roster name, weight on his UFCStats page].
// Data fix only: no stat formula changes. Bruno Silva = a flyweight (born 1990) and a middleweight (born 1989).
// The Classic builder keeps its own copy of this table (classic-build-roster.mjs): add a new pair to BOTH.
// The roster name must be "Name (Division)": the pages pick the right one from the opponent's division.
export const SAME_NAME = { "Bruno Silva": [["Middleweight", "Bruno Silva (Middleweight)", "185"], ["", "Bruno Silva (Flyweight)", "125"]] };
// UFCStats name + the fight's weight class -> roster name
export const who = (n, wc) => { const t = SAME_NAME[n]; return t ? t.find(([d]) => (wc || "").includes(d))[1] : n; };
// roster name -> the plain UFCStats / sportsbook name
export const baseOf = name => name.replace(/\s*\([^)]*\)$/, "");
// roster name -> his own row in ufc_fighter_tott.csv (height, reach, stance, date of birth); undefined for everyone else
export const tapeRowOf = (tott, name) => { for (const [base, list] of Object.entries(SAME_NAME)) { const e = list.find(x => x[1] === name);
  if (e) return tott.find(t => t.FIGHTER.trim() === base && (t.WEIGHT || "").trim().startsWith(e[2])); } };
