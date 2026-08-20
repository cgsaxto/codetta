# Roadmap

**Current phase: 4**

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

## Phase 1 — Real repos ✅

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
- [x] Redis cache keyed on commit SHA, works when Redis is down

  The Cache interface returns no errors, from either method. Not a simplification — the
  mechanism: a caller that cannot see a Redis failure cannot fail a request because of one,
  so "cache miss and cache unavailable take the same path" stops depending on every future
  caller remembering it. Tests run against miniredis, so `make api-test` stays offline.

- [x] Recalibrate Layer 3 against real parsed features

  Not originally a line item. `fixtures/react.json` was hand-authored by eyeballing, every
  musical decision in Phase 0 was tuned against it, and its numbers were wrong by an order
  of magnitude — `cyclomaticDensity` guessed at 0.17–0.34 against a real 0.001–0.025. Three
  of the five Layer 3 mappings clamped to the same answer for every repository on earth, and
  the tests all passed, because they asserted against the same invented numbers.

  Fixed in three parts. The ranges now live in one file, `music/calibration.ts`, taken from
  the p10/p90 of 44 modules across eight repositories in all four supported languages —
  previously each voice clamped and scaled inline and the two density constants were copied
  into three files. `fixtures/react.json` is a real document now, produced by `cmd/fetch`.
  And the tests that encoded the fiction were rewritten against measured values.

  It caught a real musical bug on the way. The lead's AABA form built its B phrase from an
  independent hash, which on the sparsest rhythm has one free step and therefore a coin-flip
  chance of matching A — half of all repositories would have collapsed to AAAA. The old
  fixture's invented branching figure put every repo on the busiest rhythm, so it never
  showed. B is now A inverted, which makes the contrast a property rather than a coincidence
  and is the better answer musically anyway.

- [x] Golden tests: parsing a fixture repo produces a byte-identical document

  The recorded document is `apps/api/internal/features/testdata/repo.golden.json`, from a
  fixture repository that covers all four supported languages and every skip rule; the
  escape hatch is `make api-golden`, the mirror of `pnpm fixtures:update`. Offline like the
  rest of `make api-test`.

  It closes the gap the other tests in that package leave. Each of those asserts a property
  — this file is skipped, that count is five, the seed matches the sha — and not one of them
  would notice a nesting sum shifting by one, which reaches the music as a different note
  and a reviewer as nothing at all.

  Alongside it, two ordering tests, and the split between them is worth keeping. At the
  pipeline level a reordered tar must produce the same document; that survives deleting
  either the archive's sort or the aggregation's, because they cover each other, and it is
  meant to — the guarantee belongs to the pipeline. At the archive level a reordered tar
  must produce the same _sample_, and that one is load-bearing on a single sort: once the
  file cap bites, order decides which files are opened, and nothing downstream can sort in a
  file that was never read.

  `stars` had to join `fetchedAt` in the exclusions, per @docs/features-schema.md — two
  fetches of `vuejs/core` at one SHA differ by five stars and nothing else.

- [x] Web app consumes the API instead of the local fixture

  `GET /v1/features/{owner}/{name}`, with the four statuses @docs/features-schema.md implies
  — 404, 422, 504 — plus a 502 for a dropped connection, which is what an ordinary network
  blip actually looks like and which used to arrive as a 500 with no advice.

  The two fixtures stay as one-click examples rather than being replaced. They need no
  service, which makes them the honest answer to "does this work with the backend down".

**Phase 1 is complete.** What it cost that was not on the list: recalibrating Layer 3 against
real data, sampling the file cap instead of truncating it, and giving each repository its own
instruments. All three were only findable by running the thing on real repositories, which is
what the phase was for.

Three findings that are decisions rather than work, all recorded in @docs/music-mapping.md
and none blocking:

**Nesting, branching and function length are one axis, not three** (r = +0.73 to +0.79).
Octave, density and note duration therefore move together. Coherent, but it means Layer 3
has two real dimensions plus `commentRatio`, not five.

**JS and TS repositories systematically land at the calm end.** Their largest module is flat
and unbranchy where Python's and Go's is not — react's top module scores 0.05 nesting and
0.11 branching, django's 0.83 and 0.71. So react and express get a three-note lead in a
three-semitone band while django, flask, requests and cobra get ten to fourteen semitones and
several note lengths. Honest, and probably right, but Phase 3's gallery is mostly JS and TS,
which would make the landing page sound uniformly sparse. Worth listening to before deciding
whether it needs anything.

**The progression draw is skewed and the kit draw is not.** Progressions are filtered by mode
before the draw, so `current` — valid in three of the four modes — lands 33% of the time and
`updraft` takes all of Lydian at 25%, against 8% for `undertow`. Worth knowing before reading
anything into how often a loop turns up. Fixing it means writing more progressions per mode,
each of which has to be verified against @docs/music-mapping.md's no-diminished-triad rule.

Note: tree-sitter's Go bindings need cgo, which complicates builds. Keep the Dockerfile as
the source of truth for building the API. If cgo becomes a real drag, swapping the API to
Node + `web-tree-sitter` requires zero frontend changes — that is what the contract buys.

---

## Phase 2 — Visuals ✅

- [x] Canvas 2D visualizer driven by `Tone.Transport` position, not rAF timestamps

  `Transport.seconds` is the obvious reading and is wrong by a fixed amount: it resolves to
  `getSecondsAtTime(now())`, and Tone's `now()` is `currentTime + lookAhead`, so anything
  drawn from it leads the audio by 100 ms — most of a sixteenth at 120 BPM, on every beat of
  every piece. Asking for the position at the context's actual current time removes it.

  The frame decides when to paint and never what time it is. The awkward case is a frame
  straddling the loop point, about one in three thousand, which lives in a pure module where
  a test can reach it: stepping a real 40-bar score in frames visits all 448 notes exactly
  once, at four frame sizes.

- [x] Voices map to visual elements; module colours are seed-derived and stable

  A column per module, as wide as that module is large, filled with its files — each a rule
  as long as it has lines and indented as deep as it nests. A line descends in the
  repository's own traversal order and what it has passed stays lit. Not a waveform: a
  waveform is true of any audio and says nothing about this repository.

  Colours are built the way the music is — one hue from the seed, five fixed rotations from
  it, rather than six free hues that would clash on some commits with no way to know which.
  In OKLCH converted to sRGB by hand, because the hue comes from a commit so every hue has
  to work; contrast is asserted over 200 synthetic seeds.

  It took two passes. The first read as "a progress line sweeping a black player" because
  the colour lived only in the marks and the line, columns had no body so the
  width-to-loudness mapping was invisible, and unread files were too faint to show that the
  thing on screen was code. The palette now runs the ground, the column bodies, both file
  states and the sounding voice, and the read region is tinted harder than the unread one so
  progress is an area rather than the position of a line.

- [x] 60 fps on a mid-range laptop; degrade element count, never framerate

  Confirmed at a steady 60 with no repository triggering degradation, so the budget is a
  safety net that never fires. It sheds four times faster than it restores, because
  symmetric adjustment oscillates and the picture would pulse at a rate unrelated to the
  music, and it floors at a quarter, because a strategy that can blank the screen is worse
  than the slow frames it avoids.

**Phase 2 is complete.** What it cost that was not on the list: `aggregate.buildTimeline` was
dropping every file at the repository root, so 97% of `urfave/cli` was missing from the
document meant to describe it. The music had absorbed that as a missing detail; the
visualiser draws the timeline, so it rendered as one enormous empty column and the whole
concept failed to read.

The note left in that code said the cost was "the file-driven detail in the peak and nothing
else", and it was accurate when it was written — nothing but the music read the timeline
then. **A recorded trade-off expires when a new consumer arrives, and nothing goes back to
check it.** That is the one worth remembering from this phase.

---

## Phase 3 — The gallery (this is the landing page)

**Decided: the gallery is drawn from the four languages the parser supports.** The README
promised `torvalds/linux`, `redis/redis`, `bitcoin/bitcoin` and `neovim/neovim`, which are C,
C++ and Lua and would each return the 422 that @docs/features-schema.md specifies — four
broken tiles on a front page that _is_ the gallery.

Adding the grammars was a real option and the objection to it was not the one you would
guess. An adapter genuinely is one table of node kinds and one registry line, exactly as
@docs/features-schema.md claims; the cost is three more cgo grammars to carry in a build the
roadmap already flags as awkward, and three more tables to verify against real grammars,
which the keyword-token trap has already cost us once. Against that, TypeScript, JavaScript,
Python and Go cover most of the open source anyone would recognise, and language support can
be added later without reshaping the gallery — where the reverse blocks a launch.

The README also has to change for a second reason. Its table of keys and tempos was written
by hand and is fiction: it claims react is D Dorian at 104 BPM over 268,430 lines, and react
is C Aeolian at 120 BPM over 293,684. The same class of mistake as the hand-authored fixture,
in a file that is the first thing a stranger reads.

- [x] Pre-render 8 famous repos, commit their RepoFeatures to `fixtures/gallery/`

  Two per supported language, 428 KB in total. Fetched at their current HEADs, and separate
  from `fixtures/react.json` and `fixtures/requests.json`, which stay pinned to fixed commits
  — those exist so a change in the music is detectable, and a gallery that is refreshed would
  destroy that the first time it moved.

- [x] Landing page **is** the gallery, playable in one click

  Eight tiles, each the repository drawn, each one click from playing. The page itself
  contributes no colour — every hue on screen comes from a commit — because a dark page
  would have merged the tiles into it and spent the contrast that makes eight repositories
  look like eight repositories.

  The order encodes something: smallest first, so reading the grid is reading it slowest to
  fastest, since size is what sets tempo. The largest type on the page is 15px, which is the
  one real risk taken here — the eight pictures are the headline, and no sentence above them
  would have carried it better.

  It also forced a second detail bound on the visualiser. The frame budget asks what a
  machine can afford; a tile 172px tall holding 256 files asks what the space can hold, and
  without the second one every frame arrives on time with nothing legible in it.

- [x] **No URL input box above the fold.** Input appears after the first playthrough.

  Revealed after twenty seconds of playback, or immediately when someone stops a piece —
  nobody stops something they have not listened to. Started once and never restarted, since
  sampling eight tiles for fifteen seconds each is hearing plenty and would otherwise show
  nothing.

  The timing was right first time and the reveal was invisible anyway: in a 536px window the
  section's top sits around 740px down the page, so it appeared below the fold with nothing
  to say it had. A reveal nobody sees is the same as no reveal.

**Phase 3 is complete.** Two findings worth carrying, both about colour.

**Independent draws do not spread out.** Eight seed-derived hues clumped into about five
colour families, the way eight coin flips are rarely four and four. A set is now laid out on
a wheel anchored on the first seed's own hue, so eight tiles sit 45 degrees apart and each
later seed takes the free slot nearest what it wanted. Slots rather than nudging a hue past
whatever blocks it — that was the first attempt and it can drop a third seed exactly where
the second already sits.

**Clipping sRGB channels changes the hue.** Not every OKLCH colour exists in sRGB, and
clamping each channel independently bends the colour, because the three clip by different
amounts. Eight hues laid out exactly 45 degrees apart came back 28 degrees apart once
rendered — most of the separation thrown away, and the whole reason for working in a
perceptually uniform space defeated. Out-of-gamut colours now lose chroma instead.

The README was corrected at the same time, since the gallery is what made it possible: its
table of keys and tempos was hand-written fiction, and four of the six repositories it
listed are in languages the parser cannot read. It is now generated output, and
`gallery.test.ts` fails if it drifts.

---

## Phase 4 — The share artifact

This phase is the growth loop. It is not polish, and it is not optional.

- [x] `OfflineAudioContext` render → WAV download

  The decision is the split, not the encoder. `buildRig` is extracted so that rendering a
  file and playing one out loud are the same code in a different context — a separate
  offline graph would be a second copy of every envelope and gain Phase 0 found by ear, and
  the first divergence would arrive as a download that sounds unlike what the visitor
  pressed play on.

  That made the master limiter one-per-context: a node belongs to the context that made it,
  so handing the offline graph the live limiter renders to the speakers and saves silence.
  A silent render now throws rather than saving, because it is the likeliest failure and the
  best hidden — every promise resolves and the header is valid.

- [x] Clip is 30 s, starting at the peak section, not the intro

  Taken out of order, before the video, because it is a property of the artifacts rather
  than an artifact: defining the window once means the recorder inherits it, and two
  artifacts of different moments would be a pairing that lies.

  The whole piece is rendered and then sliced, rather than starting the transport at an
  offset. The reverb tails and the pad still ringing from the bars before the peak are part
  of what the peak sounds like; a clip that began in an empty room would not be the moment
  it claims to be. Twenty milliseconds of fade in, because a clip starts mid-note and a step
  is a click; a second and a half out, because stopping dead reads as truncation.

- [x] `MediaRecorder` + `canvas.captureStream()` → square and vertical MP4/WebM

  `MediaRecorder` captures in real time and has no offline equivalent, which leaves two
  obvious approaches and both are wrong. Playing the whole piece to capture the peak costs a
  minute of waiting for thirty seconds of video. Starting the transport at the peak is fast
  and produces a different clip from the WAV, missing exactly the tails the audio clip is
  careful to keep.

  So the audio is rendered offline first, as the WAV is, and the recording plays that back:
  thirty seconds of real time, and the sound in the video is the sound in the file rather
  than a second performance resembling it. The canvas follows the buffer's own progress
  through its context, so a dropped frame moves the picture and never the sound.

  Drawing had to leave React for this — an offscreen canvas at 1080 square or 1080×1920 and
  the one on the page now share `visuals/draw.ts`. Two implementations would have meant the
  video was a picture of a slightly different piece, findable only by watching both.

- [x] Permalink per repo: `/r/{owner}/{name}`

  Hand-rolled, not routed: there are two paths and one of them is `/`, so a router would be
  a dependency, a provider and a mental model in exchange for fifteen lines.

  The address is replaced rather than pushed, because the gallery never leaves the screen —
  playing a repository is not navigation, and eight tiles sampled in a row would otherwise
  leave eight entries to press back through to escape a page nobody left.

  Arriving on a link focuses and scrolls to the tile rather than autoplaying it. Browsers
  refuse audio without a gesture, and a link that appears to fail is worse than one that
  asks for a click; focus rather than only scroll, so the keyboard can start it, and because
  a link that lands on a grid of eight without saying which one it meant has not arrived
  anywhere. A gallery repository is matched to its own tile rather than appended as a custom
  one, which would have listed it twice.

- [ ] Per-repo OG image generated server-side so links unfurl with the repo's waveform

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
