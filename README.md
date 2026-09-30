# UFC Fight Simulator

A self-contained UFC fight predictor. Pick any two active fighters and it runs a
10,000-fight Monte Carlo simulation blended with a trained outcome model (Elo, age,
reach, recent form, ring rust, experience, octagon control) to produce win
probabilities, American odds, the likely method/round, and the stats that drove the
pick. Picks ~66% of winners on 741 held-out real fights (Jan 2025 onward, no data
leakage) — the betting market is sharper still, so the built-in odds calculator anchors
the model to the moneyline; that anchored blend returned +9% ROI at opening lines in a
walk-forward backtest against real BestFightOdds lines (`market-eval.mjs`). All data and logic live in one file — `index.html` runs offline in
any browser.

## Use it right now (no setup)

Open **`index.html`** in any web browser (double-click it). Works on Windows, Mac,
Linux, and phones, online or offline. That's the whole app.

## Put it online so it updates itself (recommended)

Hosting it on GitHub Pages gives you a shareable link **and** automatic weekly stat
updates — you never touch it again after setup.

1. Create a free account at [github.com](https://github.com) if you don't have one.
2. Create a new **public** repository named `ufc-fight-simulator` (empty — no README).
3. In a terminal, from inside this folder, run (replace `YOURNAME`):
   ```sh
   git remote add origin https://github.com/YOURNAME/ufc-fight-simulator.git
   git branch -M main
   git push -u origin main
   ```
4. On GitHub: **Settings → Pages → Source: "Deploy from a branch" → `main` / `/root` → Save.**
5. Wait ~1 minute. Your simulator is live at:
   **`https://YOURNAME.github.io/ufc-fight-simulator/`**

### Auto-updates
A GitHub Action (`.github/workflows/update-stats.yml`) runs **every Monday**, pulls the
latest UFCStats data, rebuilds the roster, and commits it — GitHub Pages republishes
automatically. To update on demand, go to the **Actions** tab → **Update stats** →
**Run workflow**.

## This week, parlays and your bet log

- **This week** scans every UFC line from ~10 US sportsbooks with the backtested rule and lists the
  TAKE bets, the best price at the books you pick, and a stake. **+ Parlay** builds a slip that only
  uses TAKE legs from different fights and prices it at one book (hit chance, EV, capped stake).
  **Log bet** saves it to **My bets**, which tracks closing-line value and your P/L (stored in your
  browser; Export/Import moves it between computers).
- The odds come from `odds.json`, refreshed twice a day by the **Scan odds** GitHub Action
  (`odds-scan.mjs`, 4 credits per run on The Odds API's free 500/month). It needs one repo secret:
  **Settings → Secrets and variables → Actions → New repository secret**, name `ODDS_API_KEY`.
  Locally, put the key in a `.odds-key` file (gitignored) and run `node odds-scan.mjs`.

## Update the data manually (local)

Requires [Node.js](https://nodejs.org) (v20+; the Actions use v24).

```sh
node build-roster.mjs    # always re-downloads current data, recomputes roster, rewrites index.html
```

This **always fetches fresh data** — a stale cache can never silently produce a wrong roster. Add `--cache` to reuse the local snapshot for faster dev iteration (`eval.mjs` and `calibrate.mjs` behave the same way).

If hosting online, commit and push afterward (`git add -A && git commit -m "update" && git push`).

## Files

| File | Purpose |
|------|---------|
| `index.html` | The app. Self-contained — open in a browser. |
| `build-roster.mjs` | Downloads latest UFCStats data, recomputes all fighter stats, injects them into `index.html`. |
| `eval.mjs` | Re-validates model accuracy on held-out fights and retrains the coefficients. |
| `calibrate.mjs` | Checks the engine's method/round finish mix against real UFC distributions. |
| `prop-eval.mjs` | Validates the KO/SUB/decision odds fight by fight on held-out fights and fits the calibration layer the app uses (`--apply`). |
| `odds-scan.mjs` | Pulls current sportsbook lines (moneylines + total rounds) into `odds.json` for the This week scanner. |
| `espn-history.mjs` | Fetches every fighter's full pro history (regional + Contender Series) from ESPN into `espn-history.json` (cached; the weekly Action adds new fighters). Shown as "Pro record" in the tale of the tape. Tested as a model feature with `node eval.mjs --pre`: more accurate raw picks, but no betting edge because the books already price it, so it's display-only. |
| `market-eval.mjs` | Model vs the betting market: joins walk-forward predictions (`node eval.mjs --dump`) to BestFightOdds opening/closing lines; source of the calculator's market-anchor weights. |
| `.github/workflows/update-stats.yml` | Weekly automatic stat refresh. |

## Data source

Fighter stats come from the [Greco1899/scrape_ufc_stats](https://github.com/Greco1899/scrape_ufc_stats)
dataset, a public mirror of [ufcstats.com](http://ufcstats.com) that auto-updates after
each event.

## A note on accuracy

No fight model hits 90% — MMA is high variance. Vegas favorites win ~65% of UFC fights
and published ML models top out around 65–72%. This model sits at the upper edge of
what box-score stats can do. Treat single-fight picks as probabilities, not certainties.
