# RepoFeatures contract

The single interface between `apps/api` and `apps/web`. Types live in `packages/schema`,
hand-written once in TypeScript and once in Go, with conformance tests on both sides that
fail if the two drift apart. Changing this file means bumping `schemaVersion` and updating
every fixture in `fixtures/`.

Nothing music-related may appear here. If a field name mentions pitch, tempo, instrument,
or volume, it is in the wrong document.

## Shape

```jsonc
{
  "schemaVersion": 1,

  "repo": {
    "owner": "facebook",
    "name": "react",
    "ref": "main",
    "commitSha": "a1b2c3...", // full 40-char SHA, the cache key
    "primaryLanguage": "JavaScript",
    "stars": 228000,
    "fetchedAt": "2026-08-06T12:00:00Z",
  },

  "seed": "a1b2c3d4", // first 8 hex chars of commitSha

  "totals": {
    "filesScanned": 412,
    "filesSkipped": 88, // over cap, binary, vendored, or unsupported language
    "linesOfCode": 91240,
    "functions": 3102,
    "classes": 214,
    "imports": 2890,
  },

  "languages": [
    { "name": "JavaScript", "share": 0.71, "files": 290 },
    { "name": "TypeScript", "share": 0.24, "files": 98 },
  ],

  // Top 6 directories by LOC. These become voices. Ordered by share, descending.
  "modules": [
    {
      "path": "packages/react-dom",
      "share": 0.31, // fraction of total LOC
      "files": 64,
      "linesOfCode": 28200,
      "avgNestingDepth": 2.4, // mean max-depth per function
      "maxNestingDepth": 9,
      "avgFunctionLength": 18.2, // in statements, not lines
      "cyclomaticDensity": 0.31, // branch nodes / total AST nodes, 0–1
      "commentRatio": 0.09, // comment lines / total lines, 0–1
      "asyncRatio": 0.42, // async or promise-returning fns / total fns, 0–1
    },
  ],

  // Files in a stable traversal order (depth-first, lexicographic). Capped at 256 entries;
  // if the repo has more, sample evenly across the sorted list so the shape is preserved.
  "timeline": [
    {
      "index": 0,
      "modulePath": "packages/react-dom",
      "path": "packages/react-dom/src/client/ReactDOMRoot.js",
      "linesOfCode": 210,
      "functions": 8,
      "maxNesting": 5,
      "branches": 31,
      "commentLines": 12,
    },
  ],
}
```

All ratio fields are 0–1 floats. All counts are non-negative integers. No nulls — omit
optional objects entirely rather than emitting `null`.

## Determinism requirements

Given the same `commitSha`, the API must emit a byte-identical document. That means:

- File traversal order is depth-first, lexicographic by path. Never filesystem order.
- Parallel parsing is fine, but results are re-sorted before aggregation.
- Floats are rounded to 4 decimal places before serialization.
- `fetchedAt` is excluded from the cached payload's equality check.

## Fetch limits (enforced in `apps/api`, non-negotiable)

| Limit            | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| Endpoint         | `GET /repos/{owner}/{repo}/tarball/{ref}` only. Never `git clone`.        |
| Archive size     | 100 MB, streamed with a hard cutoff                                       |
| Files parsed     | 2,000 max                                                                 |
| Single file size | 512 KB                                                                    |
| Wall clock       | 25 s total, then 504 with a friendly message                              |
| Skipped paths    | `node_modules`, `vendor`, `dist`, `build`, `.min.`, lockfiles, `testdata` |

Exceeding a limit is a normal outcome, not an error: parse what fits, report the rest in
`totals.filesSkipped`, and return a valid document.

**"Parse what fits" means sample, never truncate** — the same rule the `timeline` above
states, for the same reason, and it is worth spelling out separately because the obvious
implementation of a file cap violates it. A tarball arrives in roughly alphabetical order, so
keeping the first 2,000 files keeps the first alphabetical corner of the repository. On
`facebook/react` that corner is `compiler/`, which swallowed the entire budget before the
walk reached `packages/react-dom` — the document described the compiler and called it React.
So the 2,000 are chosen evenly across the sorted candidate list, keeping both ends, and the
files that fall between the samples count toward `filesSkipped` like any other.

This is why the archive is read twice. A sample cannot pick anything until it knows how many
candidates exist, and a stream cannot know that until it has ended.

## Caching

Redis, key `features:v1:{commitSha}`, TTL 30 days. Resolve `ref` → `commitSha` first
(cheap API call), then check cache. Never key on the repo URL — branches move.

The app must work with Redis down. Cache miss and cache unavailable take the same path.

## Language support

Phase 1: TypeScript, JavaScript, Python, Go. Each language needs a grammar and a small
adapter mapping its node types to the things we count. Adding a language must not require
touching aggregation code, and does not: an adapter is one table plus one line in a
registry, and the walk that reads it is shared by every language.

That table has seven sets, not the four this section used to claim. Functions, classes,
branches and comments are the four that are obvious; imports appear in `totals`,
`avgFunctionLength` is measured in statements so statements have to be nameable, and
`asyncRatio` needs to know what asynchrony looks like in that grammar. All seven are just
lists of node kinds.

Two traps worth writing down, because both fail silently as a wrong number rather than as
an error. A keyword token carries the same kind string as the rule it belongs to — `class`
is both a node kind and a keyword — so only named nodes may be counted, with async markers
the deliberate exception because those _are_ keywords. And Go has neither async/await nor
promises, so `asyncRatio` is 0 for a Go module; counting goroutines instead would be
inventing a meaning this document never asked for.

Unsupported languages count toward `filesSkipped` and are otherwise ignored. A repo with
zero supported files returns a 422 with a message naming the languages we do support.
