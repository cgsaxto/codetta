<div align="center">

# Codetta

**Every repository has a sound. Paste a GitHub URL and hear yours.**

[**Try it →**](https://codetta.dev) &nbsp;·&nbsp; [How it works](#why-it-doesnt-sound-like-noise) &nbsp;·&nbsp; [Run it locally](#run-it-locally)

<!--
  THE CLIP GOES HERE AND NOTHING GOES ABOVE IT.
  Upload a 30s MP4 by dragging it into a GitHub issue comment, then paste the
  resulting URL on its own line — GitHub renders it as an inline player.
  Use the peak section, not the intro. Square or 16:9. Under 10 MB.
-->

https://github.com/USER/codetta/assets/PLACEHOLDER/clip.mp4

<sub>↑ `facebook/react`, 232k stars, 268,430 lines, in D Dorian at 104 BPM</sub>

</div>

---

## Listen to a few

| Repository                                               |                        |                    |
| -------------------------------------------------------- | ---------------------- | ------------------ |
| [facebook/react](https://codetta.dev/r/facebook/react)   | D Dorian · 104 BPM     | dense, restless    |
| [torvalds/linux](https://codetta.dev/r/torvalds/linux)   | A Aeolian · 88 BPM     | vast, slow-moving  |
| [bitcoin/bitcoin](https://codetta.dev/r/bitcoin/bitcoin) | C Aeolian · 76 BPM     | sparse, deliberate |
| [redis/redis](https://codetta.dev/r/redis/redis)         | G Mixolydian · 120 BPM | tight, percussive  |
| [vuejs/core](https://codetta.dev/r/vuejs/core)           | F Lydian · 112 BPM     | bright, airy       |
| [neovim/neovim](https://codetta.dev/r/neovim/neovim)     | Eb Aeolian · 96 BPM    | layered, deep      |

<!-- TODO: fill in the real key/tempo/feel once the gallery is rendered. -->

## What it does

Codetta fetches a repository, parses it with [tree-sitter](https://tree-sitter.github.io/),
and turns the shape of the code — module sizes, nesting depth, branching density, how much of
it is comments — into a 60–90 second piece of music.

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
depth picks an octave; branching density sets how often a sixteenth slot fires (capped at 0.75,
because a wall of sound always sounds bad); comment ratio opens the filter and the reverb. The
song structure — intro, build, peak, break, return, outro — is a fixed template that the
repository fills in rather than reshapes.

The full specification is in **[docs/music-mapping.md](docs/music-mapping.md)**, including the
list of things that are explicitly forbidden. It's the most opinionated file in the repo.

## Run it locally

```bash
git clone https://github.com/USER/codetta
cd codetta
pnpm install

docker compose up -d redis     # optional — the app works without it, just slower
make api-dev                   # :8080
pnpm dev                       # :5173
```

No API key is required for public repositories, though setting `GITHUB_TOKEN` raises the rate
limit considerably. There are no accounts, no database, and nothing is stored — Redis only
caches parsed output, keyed by commit SHA.

## How it's put together

```
apps/web    React + TypeScript + Tone.js. Owns all music and visuals.
apps/api    Go + tree-sitter. Owns all parsing. Knows nothing about music.
```

The two halves meet at exactly one interface: a `RepoFeatures` JSON document
([spec](docs/features-schema.md)). That's deliberate — tuning musicality is the loop you run a
hundred times, and it should never require re-parsing anything.

## Adding a language

Currently supported: TypeScript, JavaScript, Python, Go.

Adding one means supplying a tree-sitter grammar and a small adapter that maps its node types
onto the four things Codetta counts — functions, classes, branches, comments. No aggregation or
music code needs to change. See [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- TODO: write CONTRIBUTING.md before launch. Language support is the natural
     first contribution and the cheapest way to get outside commits. -->

## FAQ

**Does the music actually mean anything?**
It's deterministic and it's derived from real structure, so two repos that look different will
sound different, and a repo will sound different after a major refactor. But it is not a code
quality metric and you should not read anything into it. This is an instrument, not a linter.

**Why won't it do my private repo?**
Codetta only touches the public tarball endpoint and never clones. Self-host it with a token if
you want to point it at something private.

**Can I get the MIDI / the stems?**
Not yet. [Open an issue](https://github.com/USER/codetta/issues) if you'd use it.

**The name?**
A _codetta_ is a short closing passage in music. It also has "code" in it.

## Licence

MIT. Go make something with it.
