# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and each public applier reads one of them; mend
reads all four to one written contract, finds the lines an edit names even
when the model drifted their whitespace or indentation, and changes every
file or none.

- **Unified diffs** (`diff --git`, `---`/`+++`, `@@` hunks) — including
  creations (`/dev/null`, `new file mode`), deletions, renames and moves,
  wrong hunk line numbers, and `\ No newline at end of file`.
- **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`),
  with the file path on the line before the block.
- **V4A patches** (`*** Begin Patch` … `*** End Patch`, with `Add` / `Delete` /
  `Update File` sections, `@@` anchors, `*** Move to:` and `*** End of File`).
- **JSON edits** — one JSON array or JSON Lines of `create`, `str_replace`
  and `insert` tool calls.

Matching is tried at three tiers, first match wins: exact lines, then lines
equal after trailing whitespace is removed, then lines equal after leading
and trailing whitespace is removed (with new lines re-indented to the file).
`--strict` matches exactly only. A failed edit changes nothing, the edits
after it still run, and when any edit failed no file is written at all.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

On success it prints one line per changed path (`A` created, `D` deleted,
`M` modified, `R old -> new` moved) in byte order, then `ok: <n> files`.
On failure it prints one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`, and writes nothing. Usage, missing-patch,
format and parse errors exit 2 with a single `error: …` line; note that
there is no `--help` flag — an unknown option is a usage error, as SPEC.md
says. The working directory is the root of the tree; every path in a patch
is relative to it.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone, zero
  dependencies, fully deterministic. Its last lines hand a trial over to
  `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts` — the kit's runner, kept as it is. In a trial it reads the
  checks from the env, runs `main.ts` on each one in a fresh directory, and
  posts what it did.
- `check.ts` — the practice set on your own machine:
  `node check.ts <practice.json>`.
- `SPEC.md` — the whole specification; it decides what a check expects.

## Development

    node check.ts /path/to/kit/program/generator/practice.json

The 100 public practice checks (unified 30, SEARCH/REPLACE 20, V4A 20,
JSON 15, CLI 15) all pass, as do the extra edge cases in the work
directory's `test-edge.mjs` (run from the work dir, not the repo).
