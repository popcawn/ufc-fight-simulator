# UFC Fight Simulator

A self-contained UFC fight predictor. Pick any two active fighters and it runs a
10,000-fight Monte Carlo simulation blended with a trained outcome model (Elo, age,
reach, recent form, ring rust, experience, octagon control) to produce win
probabilities, American odds, the likely method/round, and the stats that drove the
pick. Validated at **65.8% accuracy** on 585 held-out real fights (Jan 2025–Jun 2026,
no data leakage). All data and logic live in one file — `index.html` runs offline in
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

## Update the data manually (local)

Requires [Node.js](https://nodejs.org) (v20+).

```sh
node build-roster.mjs    # download latest stats, recompute roster, rewrite index.html
```

If hosting online, commit and push afterward (`git add -A && git commit -m "update" && git push`).

## Files

| File | Purpose |
|------|---------|
| `index.html` | The app. Self-contained — open in a browser. |
| `build-roster.mjs` | Downloads latest UFCStats data, recomputes all fighter stats, injects them into `index.html`. |
| `eval.mjs` | Re-validates model accuracy on held-out fights and retrains the coefficients. |
| `calibrate.mjs` | Checks the engine's method/round finish mix against real UFC distributions. |
| `.github/workflows/update-stats.yml` | Weekly automatic stat refresh. |

## Data source

Fighter stats come from the [Greco1899/scrape_ufc_stats](https://github.com/Greco1899/scrape_ufc_stats)
dataset, a public mirror of [ufcstats.com](http://ufcstats.com) that auto-updates after
each event.

## A note on accuracy

No fight model hits 90% — MMA is high variance. Vegas favorites win ~65% of UFC fights
and published ML models top out around 65–72%. This model sits at the upper edge of
what box-score stats can do. Treat single-fight picks as probabilities, not certainties.
