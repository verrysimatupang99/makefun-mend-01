# makefun-mend-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/verrysimatupang99/makefun-mend-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/verrysimatupang99/makefun-mend-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. A Node.js CLI that applies AI-written edits in four formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls) to a tree of text files, to the `SPEC.md` that ships in the kit. It finds the lines an edit names at the first of three matching tiers (exact, trailing-whitespace, trimmed), re-indents at the loosest tier, and changes every file or none.

Practice score: **100/100 checks (1000)** against the kit's public practice set, plus 33 extra edge-case probes written from the spec.

## Run it

```sh
node main.ts [options] [PATCH]
node main.ts --format=unified change.diff
node main.ts --check patch.txt
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

Options: `--format=auto|unified|search-replace|v4a|json`, `--check` (report without writing), `--strict` (tier-0 matching only). `PATCH` is a patch file, or `-`/absent for standard input. Node 22+, standard library only, no dependencies. `runner.ts` is the kit's trial runner (kept as-is); `check.ts` runs the practice set; `SPEC.md` is the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
