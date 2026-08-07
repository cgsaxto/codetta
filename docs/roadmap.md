# Roadmap

**Current phase: 0**

Only work on the current phase. Later phases are recorded so scope is visible, not so it
can be pulled forward. When a phase completes, update the line above and say so explicitly.

---

## Phase 0 — Does it sound good? (throwaway, gate)

No backend. No fetching. No routing. One hand-written `RepoFeatures` JSON in `fixtures/`,
loaded directly by the web app, producing 60 seconds of audio.

- [x] Vite + React + TS scaffold, Tone.js wired to a play button
- [x] `fixtures/react.json` hand-authored by eyeballing a real repo, with a conformance test
- [x] Seeded PRNG (`music/rng.ts`) — no unseeded randomness anywhere
- [ ] Global skeleton: key, mode, tempo, 4-bar chord loop, 16th grid
- [ ] Pad + bass voices only. Verify this alone sounds pleasant on loop.
- [ ] Add lead, arp, bell, texture per @docs/music-mapping.md
- [ ] Fixed song-structure template (intro → build → peak → break → return → outro)
- [ ] Master limiter

**Gate:** render 30 seconds. Would you send it to a friend unprompted? If no, iterate on
constraints — do not proceed. If it still fails after serious iteration, this project does
not work and that is worth knowing now rather than in month three.

---

## Phase 1 — Real repos

- [ ] `packages/schema` — RepoFeatures types for TS and Go from one source
- [ ] Go service: resolve ref → SHA, stream tarball, enforce all caps in @docs/features-schema.md
- [ ] tree-sitter parsers: TypeScript, JavaScript, Python, Go
- [ ] Aggregation into modules + timeline, deterministic ordering, 4-decimal rounding
- [ ] Redis cache keyed on commit SHA, works when Redis is down
- [ ] Golden tests: parsing a fixture repo produces a byte-identical document
- [ ] Web app consumes the API instead of the local fixture

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
