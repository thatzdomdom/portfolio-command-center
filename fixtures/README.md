# fixtures/ — the incidents, replayed

Run: `node scripts/test-fixtures.js [name…] [--keep] [--verbose] [--overlay <dir>]` (see the header of
`scripts/test-fixtures.js` for the sandbox it builds: a temp copy of the repo with its own HOME,
PATH stubs for `curl`/`gh`, a git repo with a bare origin; nothing reaches Mail, ntfy, Yahoo or the
live origin).

One file per fixture, `NN-name.js`, exporting:

| field          | required | meaning |
|----------------|----------|---------|
| `name`         | yes      | equals the file name without `.js` |
| `incident`     | yes      | one line: the failure this fixture replays |
| `run(ctx)`     | yes      | sync or async; throwing = FAIL |
| `needsGreen`   | no       | SKIPPED when `00-baseline` is red |
| `requires`     | no       | repo-relative files; SKIPPED (missing) if any is absent (13 needs `scripts/lib/reply-grammar.js`) |
| `log`          | no       | research-log text, or `today => text`, written to `<HOME>/Library/Logs/portfolio-research.log` |
| `curlResponse` | no       | `{ '<url substring>': body }` — the curl stub prints `body` (string or JSON) and exits 0; anything else exits 22 |

`ctx` (all paths inside the sandbox): `root home stub origin env today addDays daysAgo(n) note`,
files `read(f) write(f,obj|text) edit(f,fn) text(f) mtime(f) rm(f) ndjson(f,rows) readNdjson(f)
resetData() writeEnv(text) writeLog(text) removeLog()`, runners `run(script,args) sh(cmd) git(…args)
originHead() originFiles() stubLog()`, steps `validateAll(label) → {exit, report, …}` (asserts
checkedOn today), `publish({full}) → {…, ledger, lastRow}`, `dailyBrief() → {…, subject}` (asserts
the `SUBJECT:` contract on stdout line 1), `oneAction() → {…, json}`, `cutover(args) → {…, json}`,
assertions `check(label, ok, detail)`, `expect(label, result, {exit:[…], stdoutMatch, stderrMatch,
outMatch, problems:[re], warnings:[re], passed:[re], notProblems, notWarnings, notPassed,
noProblems})` — one check per key — and `gap(id, text, observed)` for a KNOWN GAP row.

Every assertion targets a specific `problems[]` / `passed[]` / `warnings[]` line or a specific
stdout line; an exit code alone is never enough. No Date shim: fixtures compute expectations from
the real clock (05 derives the 13F quarter labels, 16 the cutover streak).

Stored notices: `fixtures/data/hkex/` holds three public HKEX Disclosure of Interests pages for `20-hkex`,
saved verbatim on 19 Sep 2026 from `di.hkex.com.hk` (keyless, no login, no terms gate) — the exact URLs
`scripts/hkex-di.js` builds:

| file | sha256 | what it proves |
|------|--------|----------------|
| `notices-1810-90d.html` | `eaf1cbc5c3ad2eea6cb2b7b16772398f0f5465b76af4339e8d9f467ec2177192` | Xiaomi, 44 records over 23 Jun–20 Sep 2026: the only priced buy (CS20260903E00040, code 1001) and sell (CS20260829E00026, code 1201) in the whole HK sleeve, a crossing with no bought/sold figure (CS20260723E00550), the (L)/(S) legs, and the Lei Jun / Lin Bin class-conversion pairs |
| `notices-0981-90d.html` | `466edad761cd9f158a165fdbaaea37fe073aa2dbd5444346994163b0fa2cbf60` | SMIC, 2 records, both code 1213 "any other event": one with no figures at all, one carrying 9,000,000 sh at HKD 79.70 that is still not a sale |
| `notices-0700-90d.html` | `7c94c15a624621801a27236476c24d2e6463e00dd1cf825a2d6a86c6707555a7` | Tencent, ONE notice in ninety days — the quiet-name case: a valid table with almost nothing in it is normal, not a dead feed |

`20-hkex` also rebuilds `data/hkex.json` in its sandbox from those pages before running `alerts.js` and
`validate-all.js`, so its assertions do not move when the live file rolls; the one synthetic row it adds
(a director buy, which the real 90-day window does not contain) is named `FIXTURE-20`.

Stored theme pages: `fixtures/data/themes/` holds two EDGAR full-text-search response pages for `21-themes`.
**They are RECONSTRUCTED from `data/themes.json`, not captured from `efts.sec.gov`** — the wiring agent was
not permitted to call that endpoint, and no fixture ever fetches. They carry only values the live file
vouched for on 20 Sep 2026, and each one carries an `_expect` block — the parser output frozen that day.
The round trip that makes them worth having runs against `_expect`, **not** against `data/themes.json`:
the radar is weekly and the live file will roll to a new quarter, and a fixture that went red because a
scheduled job ran on time is a fixture nobody trusts. Whether the live file still agrees is printed in
the fixture's note line, never as a failure; what the live file is held to in every week is the set of
invariants (stage on the ladder, `entryWindow === (Priced AND not crowded)`, no `candidateOn` under
Watching, no Priced without three priced names, no `crowded` on fewer than three effective trusts).

| file | sha256 | what it proves |
|------|--------|----------------|
| `physical-ai-2026q3-hits.json` | `3b2ee7e431bbcc73ad4bc285dab98e0befe991b8d98c45bee2920e89a08eb132` | "physical AI", 2026 Q3: 120 hits over 56 distinct filer CIKs while `aggregations.entity_filter` carries only **30** buckets — the aggregation truncates, and taking its word for it is a 46% undercount. Also the 27 real `sic_filter` buckets. Each hit carries only `ciks[]` and `display_names[]`: the live file records no per-filing date or accession, so none was invented |
| `physical-ai-etfs-24m-hits.json` | `94dfe13282a7b67e1e85fc007fdb359e5ef6e44bd4993632ecbad66f32b8f81e` | the 36 ETF filings (485APOS/485BPOS/N-1A) over 24 months, every field real (trust, CIK, form, file date, accession). The **37th hit repeats the first accession** on purpose — EDGAR returns one accession under several root forms and `etfRows()` must dedupe it |

`21-themes` then asserts every stage rule against synthetic quarter series (the 2× rule at a base of exactly
10 and of 11, Evidenced by ETF versus by cluster, Priced refused at 2 priced names and granted at 3, crowded
needing three **distinct effective trusts** and not three filings, the open quarter never scored, a pair
touching the paging ceiling set aside), and the wiring against a synthetic `data/themes.json` whose three
terms are named `FIXTURE-21 …` so they can never be mistaken for a seeded theme.

Stored filings: `fixtures/data/13f/` holds five public EDGAR files for `19-13f` — Berkshire Hathaway and
Baupost 2026 Q2 cover pages and information tables, and Pershing Square's 13F-NT that names CIK 2026053.
They were copied from what 13f-scan.js fetched on 13 Sep 2026; no fixture ever fetches. The runner loads
only top-level `NN-*.js`, so the folder is never mistaken for a fixture.

No stored input at all: `22-drawdown` (phase 9, 2 Oct 2026) needs none, and that is the point. The incident
it replays is an email another assistant sent calling a 4.2% Xiaomi day a "BREACH" of a -3% rule this book
does not have — a 1.42-sigma move worth 4.47bp of net worth. Those four figures (`vol60 46.8`, `-4.2%`,
`106.34bp`, the fixed `-3%`) are **FROZEN as constants at the top of the fixture**, never read from
`data/drawdown.json`, and the contrast case (`-3%` on VICOM's `vol60 11` = 4.33 sigma) with them. The
arithmetic runs against `scripts/drawdown.js`'s exported pure helpers — `dailySigma`, `peakDrawdown`,
`bandOf`, `lastTwoBars` — which touch no file and no network.

Everything the fixture COUNTS, it counts over a **synthetic `data/drawdown.json` it writes itself**, whose
two positions are named `FX22BIG` (106.34bp, -58.04% off peak → alerts) and `FX22TINY` (2.91bp, -54.2% off
peak → silent, the materiality gate) so they can never be mistaken for a book line. It clears the sandbox's
`family:'risk'` rows before each run, so every count is a count of THAT run and not of the log's history.
A fixture that goes red because a scheduled job ran on time is a fixture nobody trusts.

**`20-hkex` and `21-themes` were exactly that, and were repaired on 3 Oct 2026.** Both counted every row of
their family in the sandbox's copy of the live `data/alerts.json`, which by then carried production rows from
the daily 06:45 HKEX scan and the weekly Monday theme radar — so `48 filings → 48 hk: rows` counted 52, and
`3 stage rows` counted 5, and a real BlackRock "sold HKD 172.1M" headline was swept into an assertion about
synthetic non-trade rows. `20-hkex` had a second, slower bomb: it asserted a literal `≈ S$37.5M` for a
conversion computed from live FX, which became false when HKD/SGD drifted to 0.163094 and the same trade
rounded to S$37.6M. Both now clear their family before counting (the isolation above), and the SGD figure is
**recomputed from the sandbox's own `fx.json`** so the exact string is still required but cannot rot. The
general rule: an absolute count is only meaningful over rows the run created, and any expectation derived
from live data must be derived in the fixture too, never frozen.

Against the LIVE `data/drawdown.json` it asserts only **invariants and relationships**, never counts: every
event has a unique id and a reason; every `thesis` event is at or above `policy.drawdown.thesis.minNavBp`;
every `anomaly` event carries a sigma; no position has a `day` without a `bar.on`; `usedOfTolerancePct`
reconciles to `drawdownPct / tolerancePct` for both scopes; and at least one line past the first thesis band
but under the gate exists with **no** event, which is the only way to show the gate is doing work rather than
sitting decoratively in `policy.json`. Whether the live file still matches the emailed figures is printed in
the fixture's note line, never failed.

The wiring it holds down, in order: the bootstrap cohort collapsing into ONE `Log` summary with no per-event
rows; **the carried-bootstrap trap** — `drawdown.js` writes `bootstrap: !prev`, so the second run has
`bootstrap:false` while the carried events still read `bootstrap:true`, and keying on the top-level flag alone
would fire Notables about falls months old; per-event rows resuming with their documented severities (margin
always Notable, thesis Notable at band ≥ 40, regime Notable only at band ≥ 80); a band NOT re-alerting on an
unchanged second run; a band re-alerting when it WORSENS, with the shallower row left untouched because
`alerts.json` is append-only; every `validate-all` PHASE 9 failure (a thesis event under the gate, an anomaly
with no sigma, a `day` with no bar date, a scan 4 days stale → "DEAD, not quiet", `data/drawdown.json`
tracked by git); the daily brief block leading with the three scopes, carrying net worth's short-window
caveat, never disappearing on a quiet day, and never sitting above THE ONE ACTION; the manifest entry; and
`'risk'` in `inbox.html`'s `FAM` array with its chip label (read from the repo, since the runner copies only
`scripts/`, `common.js`, `index.html`, `data/` and `.gitignore` into the sandbox).

It also writes a `git` stub into the sandbox's PATH that exits 69 with Apple's Xcode-licence message, to prove
the phase-9 plaintext guard FAILS rather than reporting success from an empty stdout. The phase-1 guard beside
it checks only `spawnSync`'s `error` and not the exit STATUS, so under the same failure it still passes — that
is recorded as a **KNOWN GAP** row (`validate-all/plaintext-exit-status`), never silently accepted, and never
"fixed" by this fixture loosening an unrelated assertion.

Last, the governing constraint, scanned across every surface the phase writes: `policy.json`'s
`regime.notRules` records P&L-triggered de-grossing (return/drawdown 0.67 vs 0.80) and a volatility ceiling as
TESTED AND HARMFUL in this book, so no risk row and no brief line may ask for a position to be cut, reduced or
de-risked because it fell. The only actions the family may request are REPAY (margin, sized by `one-action.js`)
and a written NOTE (thesis), and `policy.drawdown.purpose` is quoted verbatim rather than paraphrased —
a paraphrase is how "information" becomes "consider reducing" three edits later.

## `23-fixture-ledger` — the watchdog's own watchdog (3 Oct 2026)

Until 3 Oct 2026 **nothing ran this suite**: not `validate-all.js`, not `publish.js`, not
`research-headless.sh`, not a workflow, not a launchd job. It ran only when a human typed it, and
`20-hkex` and `21-themes` sat red for twelve days before a manual run found them. The regression net had a
hole in it and the net was the thing meant to report holes.

`test-fixtures.js` now writes `data/.fixtures.json` (gitignored — harness state, not portfolio data);
`research-headless.sh` runs the suite every morning **after publish**; and `validate-all.js` reads the
ledger, so a red suite surfaces in the morning integrity section. `23-fixture-ledger` tests that check
against eight synthetic ledgers it writes itself: green-and-full, RED, stale at 4 days, the 2-day boundary
that must still pass (or a weekend turns the check into wallpaper), a `--only` partial run, a pass that
leaked a real ntfy call, an absent ledger, and a truncated one.

Its most important assertion is the last: **every one of those states is a WARNING and none exits 1.**
`validate-all`'s `problems[]` turn the publish red and send the 08:15 brief as `[DEGRADED]`. By the time the
suite runs, publish has already happened — and a stale assertion about a fixture is not a reason to take the
owner's morning email down. If someone later "tightens" these to `fail()`, this fixture is what says no.
