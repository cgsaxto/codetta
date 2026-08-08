# Roadmap

**Current phase: 1**

Only work on the current phase. Later phases are recorded so scope is visible, not so it
can be pulled forward. When a phase completes, update the line above and say so explicitly.

---

## Phase 0 — Does it sound good? (throwaway, gate)

No backend. No fetching. No routing. One hand-written `RepoFeatures` JSON in `fixtures/`,
loaded directly by the web app, producing 60 seconds of audio.

- [x] Vite + React + TS scaffold, Tone.js wired to a play button
- [x] `fixtures/react.json` hand-authored by eyeballing a real repo, with a conformance test
- [x] Seeded PRNG (`music/rng.ts`) — no unseeded randomness anywhere
- [x] Global skeleton: key, mode, tempo, 4-bar chord loop, 16th grid
- [x] Pad + bass voices only. Verify this alone sounds pleasant on loop.
- [x] Add lead, arp, bell, texture per @docs/music-mapping.md
- [x] Fixed song-structure template (intro → build → peak → break → return → outro)
- [x] Master limiter

**Gate:** render 30 seconds. Would you send it to a friend unprompted? If no, iterate on
constraints — do not proceed. If it still fails after serious iteration, this project does
not work and that is worth knowing now rather than in month three.

**Passed.** The gate took four rounds of listening, and none of what it caught was visible
in a test: chords piling up because the release outlived the bar, a lead that was in key
and on the grid and still a random walk because nothing repeated, a bell drifting out of
tune as the harmony moved under its decay. Every one of those passed the full suite.

Phase 0 was meant to be throwaway and is not being thrown away — the constraints it found
are the product. What carries forward: the Score IR and its validator, the seeded PRNG with
named streams, the voice-leading and spacing rules, the mixdown arbiter, and the recorded
score in `fixtures/react.expected.json` that makes any of it hard to break by accident.

Percussion is deliberately not built. Ranks 5–6 are assigned by `assignVoices` and ignored
by `generateScore`; the six pitched voices already carry the dynamic shape, and drums are a
change of genre rather than a missing feature. Worth a listen before committing to them.

---

## Phase 1 — Real repos

- [x] `packages/schema` — RepoFeatures types for TS and Go, hand-written, proved equivalent

  This originally read "from one source", meaning codegen. Two hand-written declarations
  and a test that proves they agree turned out to be less machinery for the same guarantee:
  the contract is six types that change roughly never, and a generator plus its config
  would have been more to maintain than the thing it generated.

  What replaces the generator is a pair of tests that between them close every gap. Go
  decodes the fixtures with `DisallowUnknownFields` and re-encodes them, which catches a
  field the fixtures have that Go lacks and a field Go has that they lack. TypeScript
  cannot do the same, because structural typing accepts a document with extra fields — so
  the TS side declares its field names as data, proves at compile time that those lists
  cover their own types, and checks the fixtures against them at runtime.

  Both failure directions are verified rather than assumed: adding a field to a fixture
  fails the TS check by name, and dropping one from a key list is a compile error.

- [x] Go service: resolve ref → SHA, stream tarball, enforce all caps in @docs/features-schema.md

  `GITHUB_TOKEN` is required at startup rather than optional. Anonymous GitHub allows sixty
  requests an hour, which is enough to look like it works and then fail mid-demo — better
  refused at boot, with a link to where you get one, than at request time.

  Tests are entirely offline: `httptest` for the GitHub client, in-memory tarballs for the
  walker. `make api-test` never touches the network and never spends a rate limit, which
  matters for a service whose whole job is calling a rate-limited API.

- [x] tree-sitter parsers: TypeScript, JavaScript, Python, Go

  All language knowledge lives in a table of node kinds; the walk that counts them is
  shared. A new language is a table and a registry line, and nothing else moves — which is
  what @docs/features-schema.md asks for.

- [x] Aggregation into modules + timeline, deterministic ordering, 4-decimal rounding
- [ ] Redis cache keyed on commit SHA, works when Redis is down
- [ ] Golden tests: parsing a fixture repo produces a byte-identical document
- [ ] Web app consumes the API instead of the local fixture

  **Blocked on recalibrating Layer 3.** `fixtures/react.json` was hand-authored by
  eyeballing, and every musical decision in Phase 0 was tuned against it. Parsing 6,600
  lines of this repository's own real source says those numbers were fiction:

  | feature             | hand-authored | really parsed |
  | ------------------- | ------------- | ------------- |
  | `cyclomaticDensity` | 0.17–0.34     | 0.003–0.018   |
  | `avgNestingDepth`   | 1.8–3.1       | 0.2–1.0       |
  | `avgFunctionLength` | 11–22         | 1.6–7.1       |
  | `commentRatio`      | 0.07–0.19     | 0.13–0.20     |

  Only `commentRatio` survives. On real numbers three of the Layer 3 mappings stop carrying
  any information at all: density clamps to its 0.15 floor for every repository, nesting
  clamps to the bottom of every register, and every function length falls in the first
  duration bucket. Three features, one output each, identical for every repo on earth.

  The counts are not wrong — they implement @docs/features-schema.md as written, and
  `cyclomaticDensity` really is branch nodes over all AST nodes, which is a small number in
  any real file. What was wrong was the range they were assumed to land in.

  Recalibrating needs a real distribution, not one repository, so the order is: finish the
  API, fetch several repositories, then retune Layer 3 against what actually comes back. The
  golden score in `fixtures/react.expected.json` will show exactly what moves.

Note: tree-sitter's Go bindings need cgo, which complicates builds. Keep the Dockerfile as
the source of truth for building the API. If cgo becomes a real drag, swapping the API to
Node + `web-tree-sitter` requires zero frontend changes — that is what the contract buys.

---

## Phase 2 — Visuals

- [ ] Canvas 2D visualizer driven by `Tone.Transport` position, not rAF timestamps
- [ ] Voices map to visual elements; module colours are seed-derived and stable
- [ ] 60 fps on a mid-range laptop; degrade element count, never framerate

---

## Phase 3 — The gallery (this is the landing page)

**Blocked on a decision.** Four of the six repositories the README currently promises are
in languages the parser does not support — `torvalds/linux` and `redis/redis` are C,
`bitcoin/bitcoin` is C++, `neovim/neovim` is C and Lua. Only `facebook/react` and
`vuejs/core` would return anything; the rest return the 422 that
@docs/features-schema.md specifies for a repository with no supported files. Since Phase 3
says the landing page _is_ the gallery, that is four broken tiles on the front page.

Three ways out, and the choice changes the shape of this phase rather than just its
content: add C, C++ and Lua grammars (the adapter design makes each a table, but it is
three more grammars to carry); pick a gallery of repositories in the four languages we do
support; or keep the list and let the gallery show what a 422 looks like, which is almost
certainly the wrong answer for a landing page. Decide before pre-rendering anything.

- [ ] Pre-render 8 famous repos, commit their RepoFeatures to `fixtures/gallery/`
- [ ] Landing page **is** the gallery, playable in one click
- [ ] **No URL input box above the fold.** Input appears after the first playthrough.

---

## Phase 4 — The share artifact

This phase is the growth loop. It is not polish, and it is not optional.

- [ ] `OfflineAudioContext` render → WAV download
- [ ] `MediaRecorder` + `canvas.captureStream()` → square and vertical MP4/WebM
- [ ] Permalink per repo: `/r/{owner}/{name}`
- [ ] Per-repo OG image generated server-side so links unfurl with the repo's waveform
- [ ] Clip is 30 s, starting at the peak section, not the intro

---

## Phase 5 — Make it about the visitor

- [ ] Username input → most-starred repo → its song
- [ ] Shareable card: waveform art + repo name + avatar

---

## Launch

- [ ] README with the GIF/clip in the first screen, above everything else
- [ ] MIT licence, CONTRIBUTING, issue templates
- [ ] Hosted demo that survives a front-page spike (rate limit + cache warm the gallery)
- [ ] Post the gallery repos one at a time over several weeks, not all at once

---

## Explicitly out of scope

Accounts, auth, saved libraries, playlists, commenting, a Postgres database, real-time
collaboration, mobile apps, MIDI export, VST plugins, "AI-generated" music via an LLM,
analysing private repos.
