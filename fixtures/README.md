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
