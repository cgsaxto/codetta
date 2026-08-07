/**
 * Placing chord tones inside a register so they move as little as possible from bar to bar.
 *
 * The naive alternative — realise every chord in root position and transpose it into range —
 * makes the pad leap by a fifth or a sixth whenever the progression does. That reads as four
 * unrelated chords rather than one instrument holding a line, and it is the single most
 * common reason a generated pad sounds mechanical.
 *
 * Pure and deterministic: ties are broken by pitch order, never by an rng.
 */

/** Every octave of `pitchClass` that lands inside the inclusive register. */
export function placementsInRange(pitchClass: number, lo: number, hi: number): number[] {
  const normalized = ((pitchClass % 12) + 12) % 12;
  const first = lo + ((((normalized - lo) % 12) + 12) % 12);
  const placements: number[] = [];
  for (let midi = first; midi <= hi; midi += 12) placements.push(midi);
  return placements;
}

/** Where n voices would sit if nothing else mattered: evenly spread across the register. */
function idealSpread(count: number, lo: number, hi: number): number[] {
  return Array.from(
    { length: count },
    (_unused, i) => lo + ((hi - lo) * (i + 1)) / (count + 1),
  );
}

function combinations(options: readonly (readonly number[])[]): number[][] {
  let result: number[][] = [[]];
  for (const placements of options) {
    const next: number[][] = [];
    for (const partial of result) {
      for (const midi of placements) {
        if (partial.includes(midi)) continue;
        next.push([...partial, midi]);
      }
    }
    result = next;
  }
  return result;
}

function compareVoicings(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function movementCost(candidate: readonly number[], target: readonly number[]): number {
  return candidate.reduce((sum, midi, i) => sum + Math.abs(midi - (target[i] ?? midi)), 0);
}

/**
 * Voice each chord inside `register`, minimising total semitone movement from the previous
 * chord. The first chord has no predecessor, so it is placed nearest an even spread of the
 * register — which keeps the pad centred instead of hugging one end.
 *
 * Input is one array of pitch classes per chord. Output is one array of MIDI notes per
 * chord, ascending.
 */
export function voiceLead(
  chords: readonly (readonly number[])[],
  register: readonly [number, number],
): number[][] {
  const [lo, hi] = register;
  const voicings: number[][] = [];
  let previous: number[] | undefined;

  for (const pitchClasses of chords) {
    const options = pitchClasses.map((pitchClass) => placementsInRange(pitchClass, lo, hi));
    for (const [i, placements] of options.entries()) {
      if (placements.length === 0) {
        throw new Error(`Pitch class ${pitchClasses[i]} does not fit in register ${lo}–${hi}.`);
      }
    }

    const seen = new Set<string>();
    const candidates: number[][] = [];
    for (const combination of combinations(options)) {
      const sorted = [...combination].sort((a, b) => a - b);
      const key = sorted.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(sorted);
    }
    if (candidates.length === 0) {
      throw new Error(`No voicing of ${pitchClasses.join(',')} fits in register ${lo}–${hi}.`);
    }

    // Lexicographic first, so the tie-break below is stable rather than input-order dependent.
    candidates.sort(compareVoicings);

    const target = previous ?? idealSpread(pitchClasses.length, lo, hi);
    let best = candidates[0] ?? [];
    let bestCost = movementCost(best, target);
    for (const candidate of candidates) {
      const cost = movementCost(candidate, target);
      if (cost < bestCost) {
        best = candidate;
        bestCost = cost;
      }
    }

    voicings.push(best);
    previous = best;
  }

  return voicings;
}
