# research/retired — code that is kept as evidence, not run

Nothing in this folder is wired to anything. No launchd job, no GitHub Action, no
`research-headless.sh` step and no other script calls any of it — that was checked by grep across
the repo, `~/Library/LaunchAgents`, `.github/`, the scheduled-task SKILL.md files and the fixtures
before each file was moved here. They are kept because the decisions they produced are still in
force: the target weights in the book, the trend gate in `technicals.js`, and the reason the
insider feed was rebuilt. A retired script that is deleted takes the evidence for a live rule with
it, and then the rule is just an opinion.

**They are not runnable from this folder as they stand.** `backtest.js` and `design-backtest.js`
resolve their price cache as `__dirname/../.backtest-cache`, which pointed at the repo root while
they lived in `scripts/` and points at `research/` from here. Re-running one means copying it back
to `scripts/` for the session. That is deliberate: the barrier is the point.

## Retired 13 Sep 2026 (phase 5 of the 11 Sep redesign)

**`macd-screen.js`** — a multi-timeframe MACD screen: MACD(12,26,9) rising, above signal, and
having turned up from below zero, on daily/weekly/monthly at once, plus price above the 200-day,
scored into STRICT / RELAXED / near-miss tiers. Written 8 Jul 2026 against the `.backtest-cache`
ETF universe (plus Coinbase for crypto and the ECB reference rates for FX).
*Why retired:* dead — nothing has referenced it since the day it was written, and the July
post-mortem (`signal-lab.js`, 12,871 observations over a decade) found no durable edge in
oscillator state. The one edge that survived is the trend gate, which now lives in
`scripts/technicals.js` and is computed every morning. Keeping a second, unvalidated signal in
`scripts/` invites someone to run it and believe the output.

**`backtest.js`** — the backtest of the old Opportunity Matrix "STRONG BUY" engine: it replicated
`buildModel()` from index.html exactly (same constants, same ≥70 threshold, same RISK-OFF override)
and rebalanced monthly into the STRONG BUY set, with 10bps/side costs and an `EXCLUDE=RE,CRYPTO`
switch for the selection-bias check.
*Why retired:* superseded. It backtests a model that the post-mortem retired — the deployed
probability model was an anti-signal (−1.80% expectancy per call, inverted calibration). The
regression evidence that is still cited lives in `scripts/signal-lab.js` (a decade of candidate
designs) and `scripts/portfolio-lab.js` (11.5 years, monthly), and both stay in `scripts/`.

**`design-backtest.js`** — the backtest behind the "Bottleneck Barbell" target design: fixed target
weights in three modes (A static monthly rebalance, B trend overlay on the growth sleeves, C
overlay on growth + asymmetry), 10bps/side on turnover, daily data from `.backtest-cache`.
*Why retired:* superseded by `scripts/targets.js`, which publishes the target weights in SHADOW
against the live book every morning under the post-mortem's regime (gate + cluster cap +
inverse-vol, no vol ceiling), and by `scripts/silver-backtest.js` for the leverage rule.
*Note for whoever reads index.html:* two lines there still cite this file by its old path —
`index.html:2471` (the MaxDD −21.3% vs −33.7% provenance comment) and `index.html:2528` (the
"sims via scripts/design-backtest.js (reproducible)" disclosure). index.html is frozen for the
parallel week and was not edited. The path in those two lines is now
`research/retired/design-backtest.js`; fix them at cutover, when today.html replaces index.html.

## Retired 12 Sep 2026 (phase 2 — the Dell fix)

**`insider-watch.js`** — the near-real-time Form 4 poller: every 20 minutes it asked EDGAR for the
filings of a fixed list of ~15 tickers and queued anything new for the morning brief to drain. US
names only, and honest about it (SGX and HKEX publish no equivalent open feed).
*Why retired:* it asked the wrong question. Polling "my 15 tickers" meant three Dell insider trades
were never seen, because Dell was not on the list. `scripts/form4-scan.js` asks the other question —
read EDGAR's daily index for *every* Form 4 filed anywhere (~1,000 a weekday), keep the facts in
`data/signals.json` — and `scripts/alerts.js` judges those facts against `data/policy.json` into the
append-only `data/alerts.json` that `inbox.html` renders. The brief's old "INSIDER FILINGS CAUGHT
LIVE" block, which drained this file's queue, was removed in phase 4.

**`com.dominiczhao.insider-watch.plist`** — the launchd agent that ran the poller every 1,200
seconds (`StartInterval`, `RunAtLoad false`), logging to
`~/Library/Logs/insider-watch.log`.
*Why retired:* it is the poller's schedule. It was unloaded and moved here with the script so that
a future `launchctl load ~/Library/LaunchAgents/*.plist` cannot quietly resurrect a feed that
misses Dell. It is kept, rather than deleted, as the record of what the cadence used to be.

---
These moves were made with plain `mv` (a `git mv` is a git write command and this repo's agents do
not run those), so git currently sees three deletions under `scripts/` (`macd-screen.js`,
`backtest.js`, `design-backtest.js`) and four untracked files here (those three plus this README).
**They still need staging** — the three moved scripts and this README are not in a commit yet (the
phase-2 pair, `insider-watch.js` and its plist, already are). `publish.js` will not stage them
either: its ALLOW list is data files and index.html.
