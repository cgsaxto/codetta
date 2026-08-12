import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../features/fixture';
import { generateScore } from '../music/generate';
import { TICKS_PER_BAR, TICKS_PER_BEAT, barToTick, type NoteEvent } from '../music/score';
import { onsetsBetween, soundingAt, ticksAtSeconds } from './clock';

function note(tick: number, durationTicks = 2): NoteEvent {
  return { voice: 'lead', tick, durationTicks, midi: 72, velocity: 0.5 };
}

/** Frame positions from `step` up to but not including `total`. */
function steps(step: number, total: number): number[] {
  const out: number[] = [];
  for (let position = step; position < total; position += step) out.push(position);
  return out;
}

describe('ticksAtSeconds', () => {
  it('converts at the tempo it is given', () => {
    // 120 BPM: a beat every half second, four sixteenths to the beat.
    expect(ticksAtSeconds(0, 120, 640)).toBe(0);
    expect(ticksAtSeconds(0.5, 120, 640)).toBe(TICKS_PER_BEAT);
    expect(ticksAtSeconds(2, 120, 640)).toBe(TICKS_PER_BAR);

    // Half the tempo, half the distance in the same time.
    expect(ticksAtSeconds(2, 60, 640)).toBe(TICKS_PER_BAR / 2);
  });

  it('is fractional between sixteenths', () => {
    // A visual that can only land on a sixteenth moves in sixteen steps a bar however smooth
    // the framerate is, and reads as a slideshow rather than as motion.
    expect(ticksAtSeconds(0.125, 120, 640)).toBeCloseTo(1, 6);
    expect(ticksAtSeconds(0.0625, 120, 640)).toBeCloseTo(0.5, 6);
  });

  it('wraps into the loop instead of running off the end', () => {
    const total = 64;
    // 8 seconds at 120 BPM is 64 ticks — exactly one lap, so back to the start.
    expect(ticksAtSeconds(8, 120, total)).toBe(0);
    expect(ticksAtSeconds(9, 120, total)).toBe(8);
    expect(ticksAtSeconds(25, 120, total)).toBe(8);
  });

  it('never returns a negative position', () => {
    // A transport reports one in the instant between being started and the context reaching
    // it, and a negative index into anything downstream is a blank frame at best.
    expect(ticksAtSeconds(-0.5, 120, 64)).toBeGreaterThanOrEqual(0);
    expect(ticksAtSeconds(-100, 120, 64)).toBeGreaterThanOrEqual(0);
  });

  it('answers 0 rather than NaN for nonsense', () => {
    // NaN reaching a canvas is an invisible element, which is the hardest kind of drawing
    // bug to trace back — the same reason music/palette.ts clamps rather than returning
    // undefined.
    for (const value of [
      ticksAtSeconds(Number.NaN, 120, 64),
      ticksAtSeconds(1, 0, 64),
      ticksAtSeconds(1, 120, 0),
      ticksAtSeconds(Infinity, 120, 64),
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(0);
    }
  });
});

describe('onsetsBetween', () => {
  const events = [note(0), note(4), note(8), note(60), note(63)];
  const total = 64;

  it('reports a note once, in the frame that contains its onset', () => {
    expect(onsetsBetween(events, 0, 2, total).map((e) => e.tick)).toStrictEqual([0]);
    expect(onsetsBetween(events, 2, 4, total)).toStrictEqual([]);
    expect(onsetsBetween(events, 4, 6, total).map((e) => e.tick)).toStrictEqual([4]);
  });

  it('fires a note on tick 0 on the first frame of a playthrough', () => {
    // The window is [from, to) rather than (from, to] precisely for this: a piece whose
    // first note is on its first tick would otherwise never show that note until the loop
    // came round, and only the second time would look right.
    expect(onsetsBetween(events, 0, 0.5, total).map((e) => e.tick)).toStrictEqual([0]);
  });

  it('covers both sides of the loop point in the frame that straddles it', () => {
    // Roughly one frame in three thousand, which is exactly the sort of case that survives
    // to production and then shows up as a stutter once a loop.
    const crossing = onsetsBetween(events, 63.5, 0.5, total).map((e) => e.tick);
    expect(crossing).toStrictEqual([0]);

    const wider = onsetsBetween(events, 59.5, 4.5, total).map((e) => e.tick);
    expect(wider).toStrictEqual([0, 4, 60, 63]);
  });

  it('reports nothing while the position is not moving', () => {
    expect(onsetsBetween(events, 12, 12, total)).toStrictEqual([]);
  });

  it('loses no onset and repeats none over a whole lap', () => {
    // The property that matters, stated directly: stepping through the piece in frames must
    // visit every note exactly once, whatever the frame size or where it starts.
    for (const step of [0.4, 1, 2.7, 7]) {
      const seen: number[] = [];
      let previous = 0;
      // Up to but not past the end, then one window that lands exactly on it. A step that
      // does not divide the loop would otherwise leave the last fraction of a bar uncovered,
      // and the notes in it unaccounted for — which is a fact about the loop below, not
      // about the function, and it is why the final window is explicit.
      for (const position of [...steps(step, total), total]) {
        const now = position % total;
        seen.push(...onsetsBetween(events, previous, now, total).map((e) => e.tick));
        previous = now;
      }
      expect(
        seen.sort((a, b) => a - b),
        `step ${step}`,
      ).toStrictEqual([0, 4, 8, 60, 63]);
    }
  });
});

describe('soundingAt', () => {
  it('reports how far through each note is, so a visual can decay', () => {
    const events = [note(0, 8), note(4, 8)];

    expect(soundingAt(events, 0)).toStrictEqual([{ event: events[0], progress: 0 }]);
    expect(soundingAt(events, 6).map((s) => s.progress)).toStrictEqual([0.75, 0.25]);
    // A note is over at its release, not after it: half-open, like the onset window.
    expect(soundingAt(events, 8).map((s) => s.event.tick)).toStrictEqual([4]);
    expect(soundingAt(events, 12)).toStrictEqual([]);
  });

  it('never divides by a zero-length note', () => {
    expect(soundingAt([note(0, 0)], 0)).toStrictEqual([]);
  });
});

describe('against a real score', () => {
  const score = generateScore(reactFeatures);
  const total = barToTick(score.bars);

  it('visits every note of the piece exactly once across one playthrough', () => {
    // The end-to-end version of the property, on 40 bars of real output rather than five
    // hand-placed notes. A frame every 16 ms at 120 BPM is about half a tick.
    const perFrame = (16 / 1000) * (score.bpm / 60) * TICKS_PER_BEAT;

    const counts = new Map<NoteEvent, number>();
    let previous = 0;
    for (const position of [...steps(perFrame, total), total]) {
      // Through ticksAtSeconds rather than straight, so the conversion and the wrap are both
      // in the path this exercises.
      const now = ticksAtSeconds(
        (position / TICKS_PER_BEAT) * (60 / score.bpm),
        score.bpm,
        total,
      );
      for (const event of onsetsBetween(score.events, previous, now, total)) {
        counts.set(event, (counts.get(event) ?? 0) + 1);
      }
      previous = now;
    }

    expect(counts.size).toBe(score.events.length);
    expect([...new Set(counts.values())]).toStrictEqual([1]);
  });
});
