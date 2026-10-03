<div align="center">

# Codetta

**Every repository has a sound. Type your GitHub username and hear yours.**

[**Try it →**](https://codetta.onrender.com) &nbsp;·&nbsp; [How it works](#why-it-doesnt-sound-like-noise) &nbsp;·&nbsp; [Run it locally](#run-it-locally)

https://github.com/user-attachments/assets/20002ead-2b7a-4d1c-b843-bb5c4ea9faa7

<sub>↑ <code>facebook/react</code> — 297,593 lines, F Lydian at 120 BPM. Recorded from the live demo.</sub>

</div>

---

## Listen to a few

The hosted demo runs on [Render Free](https://render.com/docs/free). After 15 minutes of
inactivity, the first visit can take about a minute to wake it. The built-in gallery plays
without parsing a repository; large custom repositories can exceed the API's 25-second
parsing budget on the free instance.

Ordered by size, which is what sets the tempo. Every key and tempo below is generated output,
not description — `apps/web/src/features/gallery.test.ts` fails if this table drifts from what
the code actually produces.

| Repository                                                        | Language   | Lines   | Key · Tempo             |
| ----------------------------------------------------------------- | ---------- | ------- | ----------------------- |
| [psf/requests](https://github.com/psf/requests)                   | Python     | 9,841   | A Aeolian · 92 BPM      |
| [expressjs/express](https://github.com/expressjs/express)         | JavaScript | 17,541  | G Aeolian · 96 BPM      |
| [gin-gonic/gin](https://github.com/gin-gonic/gin)                 | Go         | 20,156  | D Aeolian · 96 BPM      |
| [vuejs/core](https://github.com/vuejs/core)                       | TypeScript | 143,315 | Eb Aeolian · 112 BPM    |
| [microsoft/TypeScript](https://github.com/microsoft/TypeScript)   | TypeScript | 145,942 | G Mixolydian · 112 BPM  |
| [facebook/react](https://github.com/facebook/react)               | JavaScript | 297,593 | F Lydian · 120 BPM      |
| [django/django](https://github.com/django/django)                 | Python     | 312,754 | A Dorian · 120 BPM      |
| [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) | Go         | 503,617 | Eb Mixolydian · 124 BPM |

## What it does

Codetta fetches a repository, parses it with [tree-sitter](https://tree-sitter.github.io/),
and turns the shape of the code — module sizes, nesting depth, branching density, how much of
it is comments — into a 60–90 second piece of music.

Give it a username instead of a repository and it plays that account's most-starred
repository — the most-starred one it can read, and it says so when those differ.

The same commit always produces the same music. Forever. It's a fingerprint you can listen to.

## Why it doesn't sound like noise

Most code sonification projects map a number to a pitch and a number to a duration. The result
is reliably unlistenable, because nothing constrains the output to be music.

Codetta inverts that. **Code features never choose notes — they choose arrangement parameters.**

A fixed skeleton is decided first: a root, a mode (Dorian, Aeolian, Lydian, or Mixolydian), a
tempo between 72 and 128 BPM, a four-bar chord loop drawn from six curated progressions, and a
16th-note grid. Every note in the piece is snapped into that scale and quantised onto that grid,
so any combination is consonant by construction.

Only then does the code get a say. The largest module becomes the lead voice; average nesting
depth places it in its register; branching density picks one of eight curated rhythms, none of
which fills every sixteenth, because a wall of sound always sounds bad; comment ratio opens the
filter and the reverb. The
song structure — intro, build, peak, break, return, outro — is a fixed template that the
repository fills in rather than reshapes.

The full specification is in **[docs/music-mapping.md](docs/music-mapping.md)**, including the
list of things that are explicitly forbidden. It's the most opinionated file in the repo.

## Run it locally

```bash
git clone https://github.com/cgsaxto/codetta
cd codetta
pnpm install

docker compose up -d redis     # optional — the app works without it, just slower
make api-dev                   # :8080
pnpm dev                       # :5173
```

`GITHUB_TOKEN` is required, and the service refuses to start without one. Anonymous GitHub
allows sixty requests an hour, which is enough to look like it works and then fail in the
middle of a demo — better refused at boot than at request time. A token with no scopes is
enough; create one at <https://github.com/settings/tokens>.

There are no accounts, no database, and nothing is stored — Redis only caches parsed output,
keyed by commit SHA, and the app works correctly without it.

Two rate limits protect the one thing the service cannot make more of, which is GitHub
requests: one per caller, and one across everybody. The second is the one that matters when a
link goes around, because a thousand visitors are a thousand addresses and only the shared
budget notices that they are related. Behind a proxy, set `TRUST_PROXY=1` — otherwise every
request arrives wearing the proxy's address and they all share one bucket.

### Or in Docker

```bash
GITHUB_TOKEN=... docker compose up
```

One image, one process, serving the API and the built web app together on :8080. That is the
production shape and the only one where a permalink unfurls with its own card, because the
substitution happens in the page the service is serving. The two commands above are the
development shape instead: the app is a Vite server that reloads, and nothing rewrites the
`<head>`.

`Dockerfile` is the source of truth for building the Go half. tree-sitter's bindings are cgo,
so the build needs a C toolchain and produces a dynamically linked binary — worth having that
recipe in a file rather than in somebody's shell history.

## How it's put together

```
apps/web    React + TypeScript + Tone.js + three.js. Owns all music and visuals.
apps/api    Go + tree-sitter. Owns all parsing. Knows nothing about music.
```

The two halves meet at exactly one interface: a `RepoFeatures` JSON document
([spec](docs/features-schema.md)). That's deliberate — tuning musicality is the loop you run a
hundred times, and it should never require re-parsing anything.

## Adding a language

Currently supported: TypeScript, JavaScript, Python, Go.

Adding one means supplying a tree-sitter grammar and a small adapter: seven lists of node
kinds — functions, classes, branches, comments, imports, statements, and whatever marks a
function asynchronous. No aggregation or music code changes. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## FAQ

**Does the music actually mean anything?**
It's deterministic and it's derived from real structure, so two repos that look different will
sound different, and a repo will sound different after a major refactor. But it is not a code
quality metric and you should not read anything into it. This is an instrument, not a linter.

**Why won't it do my private repo?**
Codetta only touches the public tarball endpoint and never clones. Self-host it with a token if
you want to point it at something private.

**Can I get the MIDI / the stems?**
Not yet. [Open an issue](https://github.com/cgsaxto/codetta/issues) if you'd use it.

**The name?**
A _codetta_ is a short closing passage in music. It also has "code" in it.

## Licence

MIT. Go make something with it.
