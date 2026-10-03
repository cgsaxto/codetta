# Codetta

Turns a GitHub repository into a piece of music. Paste a repo, hear what it sounds like, share the clip.

## The one rule that governs every decision

**It has to sound good.** A technically impressive mapping that produces noise is a failed
feature. When a choice trades analytical fidelity for musicality, take musicality every time.

The second goal is shareability: every output must be reducible to a 30-second clip someone
would post. Features that don't serve "sounds good" or "gets shared" are out of scope.

## Architecture

```
apps/web     Vite + React 19 + TypeScript + Tone.js + three.js + Tailwind. Owns ALL music and
             visuals.
apps/api     Go 1.23+. Fetches repo tarballs, parses with tree-sitter, emits RepoFeatures JSON.
packages/schema   TypeScript types + Go structs for RepoFeatures. Hand-written in both
                  languages; conformance tests prove the two agree. Single source of truth.
docs/        Design specs (see references below).
fixtures/    Committed RepoFeatures JSON for known repos. Used by tests and the gallery.
```

The API and the web app are decoupled by one contract: the `RepoFeatures` JSON document.
The API knows nothing about music. The web app knows nothing about ASTs. Never leak
music concepts into `apps/api` or parsing concepts into `apps/web`.

- Feature contract: @docs/features-schema.md
- Music mapping spec: @docs/music-mapping.md
- Phased plan and current phase: @docs/roadmap.md

## Commands

```bash
pnpm install              # root, installs all workspaces
pnpm dev                  # web on :5173
pnpm test                 # vitest, all workspaces
pnpm typecheck            # tsc --noEmit across workspaces
pnpm lint                 # eslint + prettier check

make api-dev              # go run ./cmd/server, :8080
make api-test             # go test, every module in go.work
docker compose up redis   # local cache
docker compose up         # the production shape: one image serving API + web on :8080
```

`Dockerfile` is the source of truth for building the Go half — tree-sitter is cgo, so the
build needs a C toolchain. Build for the host you deploy to: `--platform linux/amd64`.

Before finishing any task: `pnpm typecheck && pnpm test` (and `make api-test` if Go changed).

## Hard rules

**Audio**

- Never schedule notes with `setTimeout`, `setInterval`, or `requestAnimationFrame`.
  All timing goes through `Tone.Transport`. Drift is a bug, not a tradeoff.
- Never let a repo feature choose a raw MIDI number, frequency, or millisecond value.
  Features select an index into a pre-defined musical palette. See @docs/music-mapping.md.
- Every note is snapped to the active scale and quantized to the 16th grid. No exceptions.
- The master chain always ends in a limiter. Clipping is a bug.

**Determinism**

- Same commit SHA must always produce the same audio, forever.
- No `Math.random()`, `Date.now()`, or `crypto.randomUUID()` anywhere in the generation path.
  Use the seeded PRNG in `apps/web/src/music/rng.ts`, seeded from `features.seed`.

**Fetching repos**

- Never `git clone`. Use the GitHub tarball endpoint only.
- Always enforce the caps in @docs/features-schema.md (archive size, file count, file size,
  wall-clock timeout). An unbounded fetch is a denial-of-service vector.
- Never execute, `eval`, import, or run any code from a fetched repo. It is parsed as text.
- The browser never talks to GitHub. All tokens live in `apps/api` and never cross the wire.

**Scope**

- No user accounts, no login, no OAuth, no Postgres. Redis is the only datastore, and it is a
  cache — the app must work correctly with a cold/empty Redis.
- Do not implement anything outside the current phase in @docs/roadmap.md. If a task seems to
  need it, say so and stop rather than expanding scope.

## Conventions

- TypeScript strict mode. No `any` — use `unknown` and narrow.
- Music code is pure functions: `(features, seed) => Score`. Tone.js objects are only
  constructed in `apps/web/src/audio/`, never in `apps/web/src/music/`.
- Go: return errors, don't panic. Context with timeout on every outbound call.
- Comments explain _why_, never _what_. Don't add file-header comments or JSDoc that
  restates the signature.
- Conventional Commits (`feat:`, `fix:`, `chore:`).
- This repo is public from day one. Assume every commit is read by strangers.

## When something sounds wrong

Musical output bugs are the highest-priority class of bug in this project. If a change makes
output worse, revert it rather than layering fixes. Regression check: render the fixtures in
`fixtures/` and compare against `fixtures/*.expected.json` scores before and after.
