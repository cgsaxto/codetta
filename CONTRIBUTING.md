# Contributing

Codetta turns a GitHub repository into a piece of music. Everything below follows from one
rule, which is the same rule the codebase is written around:

> **It has to sound good.** A technically impressive mapping that produces noise is a failed
> feature. When a choice trades analytical fidelity for musicality, take musicality.

If a change makes the output worse, the fix is to revert it rather than to layer another fix
on top. That is not a policy about process; it is what keeps the thing listenable.

## Getting it running

```bash
pnpm install
pnpm dev                       # the web app on :5173

make api-dev                   # the Go service on :8080 — needs GITHUB_TOKEN
docker compose up -d redis     # optional; the app is correct without it, just slower
```

`GITHUB_TOKEN` is required and the service refuses to boot without it. A token with no scopes
is enough — anonymous GitHub allows sixty requests an hour, which is enough to look like it
works and then fail halfway through a demo.

You do not need the service to work on the music. The eight gallery repositories are committed
documents in `fixtures/gallery/`, so `pnpm dev` alone gives you eight real repositories to
listen to.

## Before you open a pull request

```bash
pnpm typecheck && pnpm test && pnpm lint
make api-test                  # if you touched Go
```

All of it is offline. `make api-test` never reaches GitHub and never spends a rate limit,
which matters for a service whose entire job is calling a rate-limited API.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`,
`chore:`, `docs:`, `build:`.

## Two ways to evaluate a change, and they answer different questions

**What changed** is a JSON diff. Every fixture has a recorded score in `fixtures/*.expected.json`
and `pnpm test` fails when the generated one differs. Most changes to the music move those
numbers deliberately — the check is not there to stop you, it is there so a change you did not
intend cannot pass silently. When the diff is what you meant, run `pnpm fixtures:update` in the
same commit that justifies it. The Go equivalent is `make api-golden`.

**Whether it is better** is your ears, and there is no substitute. Run `pnpm dev` and listen to
the peak section, which is where the shareable clip is cut from. The bar is: would you send
this thirty-second clip to a friend unprompted?

Everything that has ever actually mattered in this project was found the second way. Chords
piling up because a release outlived its bar, a lead that was in key and on the grid and still
a random walk, a bell drifting out of tune as the harmony moved underneath it — every one of
those passed the entire test suite. Tests keep the output legal. Only listening keeps it good.

## Adding a language

This is the most useful thing an outside contributor can do, and it is deliberately cheap.
Currently supported: TypeScript, JavaScript, Python, Go.

An adapter is **one table of node kinds plus one line in a registry**, and nothing else moves —
no aggregation code, no music code, no frontend. See `apps/api/internal/parse/languages.go`.

The table has seven sets, all of them just tree-sitter node kinds:

| Set          | What it feeds                                                      |
| ------------ | ------------------------------------------------------------------ |
| `Functions`  | `totals.functions`, and the denominator of most module averages    |
| `Classes`    | `totals.classes`                                                   |
| `Branches`   | `cyclomaticDensity`, and nesting depth is how many enclose a point |
| `Comments`   | `commentRatio`                                                     |
| `Imports`    | `totals.imports`                                                   |
| `Statements` | `avgFunctionLength`, which is measured in statements, not lines    |
| `Async`      | `asyncRatio`                                                       |

Two traps, and both fail silently as a wrong number rather than as an error:

- **A keyword token carries the same kind string as the rule it belongs to.** `class` is both a
  node kind and a keyword, so only named nodes are counted. Async markers are the deliberate
  exception, because those _are_ keywords.
- **Do not invent a meaning the schema did not ask for.** Go has neither async/await nor
  promises, so `asyncRatio` is 0 for a Go module. Counting goroutines instead would be making
  something up, and a wrong number is worse than an honest zero.

What a language PR needs:

1. The grammar as a Go module dependency, and a `Language` value with its extensions.
2. A registry line in `register(...)`.
3. Tests in `apps/api/internal/parse/parse_test.go` against real source in that language —
   assert the counts, because the traps above produce plausible wrong numbers.
4. A note in the PR about anything the language does not have, and why zero is the honest
   answer for it.

Grammars are C and reach Go through cgo, so the build needs a C toolchain. `Dockerfile` is the
source of truth for that.

## Things that will be turned down

Not because they are bad ideas — because this project is deliberately small.

- Anything on the **out of scope** list in [docs/roadmap.md](docs/roadmap.md): accounts, auth,
  saved libraries, playlists, a database, MIDI export, VST plugins, "AI-generated" music via an
  LLM, analysing private repos.
- **A new voice to represent a new metric.** The voice budget is fixed at six. Six is the
  number that fits in eight simultaneous notes without turning into a wall of sound.
- **A feature that maps a code value directly to a pitch, a frequency, or a millisecond
  duration.** Features select an index into a pre-defined musical palette. That inversion is
  the entire reason this does not sound like every other sonification project.
- **Anything unseeded in the generation path.** No `Math.random()`, no `Date.now()`, no
  `crypto.randomUUID()`. The same commit must produce the same audio forever, and a permalink
  that plays something different tomorrow is a broken promise rather than a variation.
- **Notes off the scale or off the 16th grid.** Both are unrepresentable on purpose.

If you want to change one of these rather than work within it, open an issue and make the case
before writing the code. Some of them are load-bearing and some are just old; the difference is
worth a conversation.

## Where the reasoning lives

- [docs/music-mapping.md](docs/music-mapping.md) — how code features become arrangement
  parameters, and the list of things that are explicitly forbidden. The most opinionated file
  in the repo, and the one to read first.
- [docs/features-schema.md](docs/features-schema.md) — the one interface between the two
  halves. Nothing music-related may appear in it.
- [docs/roadmap.md](docs/roadmap.md) — what phase this is in, and what each earlier phase cost
  that was not on the list.

Those files record why decisions were made, not just what they were. If you change a decision,
change the reasoning with it — a stale explanation is worse than none, because the next person
believes it.
