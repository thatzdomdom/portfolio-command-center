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

Stored filings: `fixtures/data/13f/` holds five public EDGAR files for `19-13f` — Berkshire Hathaway and
Baupost 2026 Q2 cover pages and information tables, and Pershing Square's 13F-NT that names CIK 2026053.
They were copied from what 13f-scan.js fetched on 13 Sep 2026; no fixture ever fetches. The runner loads
only top-level `NN-*.js`, so the folder is never mistaken for a fixture.
