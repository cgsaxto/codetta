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

### Collisions

Constraint: **max 8 simultaneous notes**, and **no two voices sounding the same pitch at the
same time**.

Both are enforced in one place, after every voice has produced its notes — `music/mixdown.ts`.
They cannot be enforced inside a voice, because a voice cannot see what the others are doing.

An earlier version of this rule said two voices must never occupy the same octave range in the
same bar. That cannot be implemented as written: the registers in the table above are chosen to
overlap — pad reaches C5 and lead starts at C4 — so the rule fires constantly and the only way
to satisfy it is to push a voice outside its own register. What is audible is not that two
voices share an octave, it is that two voices land on the same note, where the quieter one
simply disappears into the louder. That is the rule.

Resolution order:

- On a unison, the **later-ranked** voice moves by an octave — up first, then down — and keeps
  its pitch only if neither octave is inside its register. Pad and bass never move: they are
  the safety net, and their voicing is chosen as a whole.
- Over the polyphony ceiling, notes are dropped from the **lowest-ranked voice first**, in
  reverse rank order. Pad and bass are dropped last and in practice never.

## Layer 3 — Feature → parameter mapping

Each voice reads its module's aggregate features:

| Code feature          | Musical parameter          | Mapping                                                   |
| --------------------- | -------------------------- | --------------------------------------------------------- |
| `avgNestingDepth`     | Octave                     | Deeper sits higher in the voice's register                |
| `avgFunctionLength`   | Note duration              | Articulation: fraction of the gap filled, 0.5 to legato   |
| `cyclomaticDensity`   | Note density               | Selects a rhythm, sparse to busy. Never fills every 16th. |
| `commentRatio`        | Reverb wet + filter cutoff | More comments = more open, airier. Texture only.          |
| `asyncRatio`          | Delay feedback / swing     | Subtle. Max 20% swing. **Not built yet.**                 |
| `share` (module size) | Voice gain + rank          | Bigger module = louder, earlier entry                     |
| `languages` diversity | Number of active voices    | See the table below                                       |

### Calibration

Every row above is "feature selects an index", and an index needs a range. The ranges are in
`music/calibration.ts` and nowhere else — the p10 and p90 of 44 modules parsed from eight
repositories across all four supported languages.

They are there because the first set was guessed. `fixtures/react.json` was originally
hand-authored by eyeballing a repository, every mapping was tuned against it, and it was
wrong by an order of magnitude: `cyclomaticDensity` was assumed to sit in 0.17–0.34 and
really sits in 0.001–0.025. Three of the five mappings clamped to the same answer for every
repository on earth, and the whole test suite passed, because the tests asserted against the
same invented numbers.

Two consequences worth knowing before changing anything here:

- **Nesting, branching and function length are one axis, not three.** Across the sample they
  correlate at r = +0.73 to +0.79 — algorithmic code is nested and branchy and long-bodied
  together. Octave, density and note length therefore move together, which is coherent but
  is not three independent dimensions, and stacking a fourth mapping onto the same axis buys
  nothing. `commentRatio` (r ≈ −0.05 to −0.38) is the one genuinely independent feature.
- **`asyncRatio` is zero for more than half of all modules.** Go has no async by definition
  and Python's median is also 0. Whatever eventually reads it has to sound right when the
  answer is "none", because that is the common case rather than the edge case.

That correlation is also why note duration is an articulation rather than an absolute length,
which is a change from what this table used to specify. Bucketing into {16n, 8n, 4n, 2n} reads
fine on its own and cannot work alongside the density mapping: the repos that select a sparse
rhythm select the short buckets too, so react's lead came out at three sixteenths of sound per
two bars — a quarter of its phrase, and audibly empty rather than calm. At the busy end the
mapping did nothing instead, because those notes were already being cut short by the next
onset. As a fraction of the gap to the next onset, one number means the same thing at both
ends. **A voice is never mostly silence**; sparse and hollow are different outcomes and only
the first one is ever correct.

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
Break     Drop to pad, bass and lead, density × 0.4
Return    Full, plus bell accents
Outro     Voices drop out in reverse rank order, pad and bass last
```

### Metric accent

Velocity is shaped by position in the bar, in the ordinary 4/4 hierarchy: beat one strongest,
beat three next, the other two beats after that, then offbeat eighths, then sixteenths. It is
a multiplier, so a voice's feature-driven gain still sets its level against the other voices
and this only shapes it within the bar.

This is not decoration. Without it every voice emitted a single velocity for the whole piece,
and the output had no pulse at all — a listener finds the beat by hearing which notes are
stressed, and a line with no stresses has no metre to find however correct its rhythm is on
the grid. Reaching for drums first would have covered that up rather than fixed it.

Break used to read "drop to pad + lead", which contradicted Layer 2's "always present" for
the bass. Layer 2 wins: the safety net is the one thing nothing is allowed to switch off,
and four bars with no bass is not a breakdown, it is a hole. The density multiplier applies
to the foreground voices — pad and bass keep their own pattern, because thinning the safety
net is the same mistake in a different form.

This is enforced in one place, after every voice has produced its notes, for the same reason
the collision rules are: a voice cannot see the section it is in without every voice growing
its own copy of the arrangement.

`RepoFeatures.timeline` walks the repo's files in a stable order and maps them onto bars,
so a repo with a dense core module gets a dense peak. But the entry/exit points are template
constants, not computed.

## Anti-patterns — do not do these

- Mapping a feature value directly to a MIDI number or frequency
- Chromatic runs, or any note outside the active scale
- Notes shorter than a 16th, or triplets against a straight grid
- Tempo above 128 BPM
- Density of 1.0 on any voice (creates a wall of sound, always sounds bad)
- A lead sparser than the arp beneath it. Three onsets in two bars fails in both directions
  at once — hollow when the notes are short, dragging when they are long — and no note length
  rescues it, because the fault is the rate. The rhythm palette's floor is five.
- Adding a new voice to "represent" a new metric — the voice budget is fixed at 6
- More than 8 concurrent notes
- Any generation step that reads the wall clock or unseeded randomness

## How to evaluate a change

Not by reading the diff. Two things, and they answer different questions.

**What changed** is a JSON diff. Every fixture has a recorded Score in
`fixtures/*.expected.json`, and `pnpm test` fails when the generated one differs. Most
changes to this project move those numbers deliberately — the check is not there to stop
you, it is there so that a change you did not intend cannot pass silently. When the diff is
what you meant, run `pnpm fixtures:update` in the same commit that justifies it.

**Whether it is better** is your ears, and there is no substitute. Run `pnpm dev` and
listen to the peak section, which is where the shareable clip is cut from.

The bar is: **would I send this 30-second clip to a friend unprompted?** If no, the change
is not done, regardless of test status.

Everything in Phase 0 that actually mattered was found this way. Muddy chord voicings, a
lead that was in key and on the grid and still sounded like a random walk, a bell drifting
out of tune as the harmony moved underneath it — every one of those passed the entire test
suite. Tests keep the output legal; only listening keeps it good.

Offline WAV rendering, so a clip can be produced without a browser, is Phase 4.
