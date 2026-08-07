# Music mapping spec

This is the most important document in the repo. Everything else is plumbing.

## The core principle

**Code features choose arrangement parameters. They never choose notes.**

The naive approach — hash a complexity number into a MIDI pitch, hash a loop count into a
duration — produces noise. It has been tried by every sonification project that sounds bad.

Instead: a fixed musical skeleton (key, scale, chord loop, rhythmic grid, song structure)
guarantees the output is consonant. Code features only decide _which_ of a small set of
musically valid options gets used, _when_ voices enter, and _how dense_ they are.

If it sounds bad, the fix is almost always "add a constraint", not "add more analysis".

## Layer 1 — Global skeleton (fixed, seed-selected)

Derived once from `features.seed`. Never from raw feature magnitudes.

| Parameter  | Allowed values                                                    |
| ---------- | ----------------------------------------------------------------- |
| Root       | C, D, E♭, F, G, A                                                 |
| Mode       | Dorian, Aeolian, Lydian, Mixolydian                               |
| Tempo      | One of the 15 entries in `TEMPOS` (72–128 BPM in 4 BPM steps)     |
| Grid       | 16th notes. Nothing shorter, nothing off-grid.                    |
| Chord loop | One of 6 curated 4-bar progressions (see `music/progressions.ts`) |
| Length     | 60–90 s, guaranteed by the templates in Layer 4                   |

Mode and root come from the seed so the same repo always sounds the same, but different
repos sound distinct.

### Tempo

Tempo is an **index into a palette**, never a computed BPM value — the same rule as pitch.

```ts
TEMPOS = [72, 76, 80, 84, 88, 92, 96, 100, 104, 108, 112, 116, 120, 124, 128]; // 15 entries
```

Tempo is the one skeleton parameter driven by a feature rather than the seed, because size is
the one thing a listener can plausibly hear: small repo → slower, large → faster. The index
comes from `totals.linesOfCode` on a log scale, since repo sizes span four orders of magnitude:

```
index = clamp(round((log10(max(linesOfCode, 1)) - 3) / 3 * 14), 0, 14)
```

So 1k LOC → 72 BPM, 10k → 92, 100k → 108, 1M+ → 128. **Never above 128 BPM.** Fast is not the
same as exciting.

The chord loop repeats for the entire piece. Every melodic voice is confined to the active
scale, so any combination is consonant by construction.

## Layer 2 — Voices

Take the top 4–6 modules by `share` from `RepoFeatures.modules`, ranked by size (not by
name hash — the largest module should always be the most prominent voice).

| Rank | Role         | Register | Behaviour                                        |
| ---- | ------------ | -------- | ------------------------------------------------ |
| —    | Pad          | C3–C5    | Plays the chord loop throughout. Always present. |
| —    | Bass         | C1–C2    | Root on beats 1 and 3. Always present.           |
| 1    | Lead / pluck | C4–C6    | Melodic, most active                             |
| 2    | Arp          | C4–C5    | Runs the chord tones                             |
| 3    | Bell         | C5–C6    | Sparse accents                                   |
| 4    | Texture      | C3–C4    | Sustained, filtered                              |
| 5–6  | Percussion   | —        | Kick/hat only. No fills.                         |

Pad and bass are not derived from code at all. They are the safety net that makes everything
else work. Do not make them feature-driven.

Constraint: **max 8 simultaneous notes**. Two voices must never occupy the same octave range
in the same bar — if they collide, transpose the lower-ranked one down an octave.

## Layer 3 — Feature → parameter mapping

Each voice reads its module's aggregate features:

| Code feature          | Musical parameter          | Mapping                                                        |
| --------------------- | -------------------------- | -------------------------------------------------------------- |
| `avgNestingDepth`     | Octave                     | Clamp to 2–6, deeper = higher                                  |
| `avgFunctionLength`   | Note duration              | Bucket into {16n, 8n, 4n, 2n}; longer fn = longer note         |
| `cyclomaticDensity`   | Note density               | Probability a 16th slot fires. **Clamp 0.15–0.75.** Never 1.0. |
| `commentRatio`        | Reverb wet + filter cutoff | More comments = more open, airier. Texture only.               |
| `asyncRatio`          | Delay feedback / swing     | Subtle. Max 20% swing.                                         |
| `share` (module size) | Voice gain + rank          | Bigger module = louder, earlier entry                          |
| `languages` diversity | Number of active voices    | See the table below                                            |

### Voice count

Pad and bass are **not** counted here — they are always present regardless. The count below is
the number of module-driven voices, i.e. ranks 1..N of the Layer 2 table, and it does include
percussion at ranks 5–6.

A language only counts toward diversity if its `share` is **≥ 0.05**. Without that floor a
single stray `.py` file in a 5,000-file JavaScript repo would add a whole voice. If every entry
falls below the floor, the count is 1.

| Counted languages | Module voices | Highest rank active |
| ----------------- | ------------- | ------------------- |
| 1                 | 4             | Texture             |
| 2                 | 5             | Kick                |
| 3                 | 5             | Kick                |
| 4 or more         | 6             | Hat                 |

If `modules` holds fewer entries than the table asks for, use every module there is and stop.
A two-module repo gets two voices over pad and bass, and that is a correct outcome, not a
degraded one — the safety net is the point.

Pitch selection: `scaleDegree = SCALE[ hash(fileFeature) % SCALE.length ]`. The hash picks a
**scale degree**, never a semitone. Chord tones (1, 3, 5) are weighted 2× over passing tones
so melodies resolve.

## Layer 4 — Song structure (fixed template)

The arrangement is a fixed template. Code features fill it; they never reshape it.

There are three templates, selected by tempo — **not** by any feature. A fixed bar count cannot
work, because 40 bars at 72 BPM is 133 seconds and the piece must land in 60–90 s. The slower
the tempo, the fewer bars.

| Tempo   | Bars | Intro | Build | Peak | Break | Return | Outro | Duration    |
| ------- | ---- | ----- | ----- | ---- | ----- | ------ | ----- | ----------- |
| 72–84   | 24   | 4     | 4     | 4    | 4     | 4      | 4     | 68.6–80.0 s |
| 88–104  | 32   | 4     | 4     | 8    | 4     | 8      | 4     | 73.8–87.3 s |
| 108–128 | 40   | 4     | 8     | 12   | 4     | 8      | 4     | 75.0–88.9 s |

Across all 15 tempos this yields 68.6–88.9 s, with no gaps and no overlap.

**Every section length is a multiple of 4 bars.** The chord loop is 4 bars, so this makes every
section begin on the tonic chord. A section change landing mid-progression sounds like a
mistake, and this constraint makes that unrepresentable rather than merely discouraged.

That constraint has a consequence worth stating plainly: six sections × 4 bars minimum means
the 24-bar template is forced into six equal sections, so its peak is 17% of the piece rather
than 30%. That is accepted. The 24-bar template only serves the slowest, smallest repos, which
should sound sparse and simple anyway — a simple form is the right output for a small repo, not
a compromise. Do not "fix" this by allowing 2-bar sections.

Section behaviour is the same in all three:

```
Intro     Pad + bass only
Build     Voices 1, 2 enter — voice 1 at the start, voice 2 at the midpoint
Peak      All voices, full density, percussion enters
Break     Drop to pad + lead, density × 0.4
Return    Full, plus bell accents
Outro     Voices drop out in reverse rank order
```

`RepoFeatures.timeline` walks the repo's files in a stable order and maps them onto bars,
so a repo with a dense core module gets a dense peak. But the entry/exit points are template
constants, not computed.

## Anti-patterns — do not do these

- Mapping a feature value directly to a MIDI number or frequency
- Chromatic runs, or any note outside the active scale
- Notes shorter than a 16th, or triplets against a straight grid
- Tempo above 128 BPM
- Density of 1.0 on any voice (creates a wall of sound, always sounds bad)
- Adding a new voice to "represent" a new metric — the voice budget is fixed at 6
- More than 8 concurrent notes
- Any generation step that reads the wall clock or unseeded randomness

## How to evaluate a change

Not by reading the diff. Render the fixtures and listen:

```bash
pnpm render:fixtures     # writes WAVs to .tmp/renders/
```

The bar is: **would I send this 30-second clip to a friend unprompted?** If no, the change
is not done, regardless of test status.
