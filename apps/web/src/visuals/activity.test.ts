import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../features/fixture';
import { generateScore } from '../music/generate';
import { barToTick, VOICE_ORDER, type NoteEvent, type Score } from '../music/score';
import { prepareActivity } from './activity';

/**
 * The property under test is the one an FFT could not give: the same tick always produces the
 * same answer, and the answer actually moves.
 */

function scoreOf(events: NoteEvent[], bars = 4): Score {
  const base = generateScore(reactFeatures);
  return { ...base, events, bars, sections: base.sections };
}

function note(over: Partial<NoteEvent> = {}): NoteEvent {
  return { voice: 'lead', tick: 0, durationTicks: 2, midi: 60, velocity: 1, ...over };
}

describe('prepareActivity', () => {
  it('is silent before the first note', () => {
    const read = prepareActivity(scoreOf([note({ tick: 16 })]));
    expect(read.at(0).voices.lead).toBe(0);
    expect(read.at(15.9).voices.lead).toBe(0);
    expect(read.at(16).voices.lead).toBeGreaterThan(0);
  });

  it('strikes at the onset and falls away after it', () => {
    const read = prepareActivity(scoreOf([note({ tick: 8, durationTicks: 2 })]));

    const struck = read.at(8).voices.lead;
    expect(struck).toBeCloseTo(1, 5);

    // Monotonic from the attack onwards, with nothing else to retrigger it.
    let previous = struck;
    for (let tick = 8.5; tick < 24; tick += 0.5) {
      const level = read.at(tick).voices.lead;
      expect(level, `tick ${tick}`).toBeLessThanOrEqual(previous + 1e-9);
      previous = level;
    }
    expect(previous).toBeLessThan(0.05);
  });

  it('gives the same answer however often it is asked, and in any order', () => {
    // The flare map in draw.ts cannot do this: its value at a tick depends on the frames that
    // reached it, so a dropped frame changes the picture. That is fine for a canvas being
    // driven by a transport and disqualifying for anything rendered offline.
    const read = prepareActivity(generateScore(reactFeatures));
    const ticks = [0, 3.25, 61.5, 200, 7.75, 61.5, 3.25];
    const seen = new Map<number, string>();

    for (const tick of ticks) {
      const answer = JSON.stringify(read.at(tick));
      const before = seen.get(tick);
      if (before !== undefined) expect(answer, `tick ${tick}`).toBe(before);
      seen.set(tick, answer);
    }
  });

  it('lets the loudest note of a chord speak for the voice rather than summing them', () => {
    // A pad plays three notes at once. Summing would pin it at full scale for the whole
    // piece and leave the voice with no dynamic at all.
    const chord = [0, 4, 7].map((offset) => note({ voice: 'pad', midi: 60 + offset }));
    const read = prepareActivity(scoreOf(chord));
    expect(read.at(0).voices.pad).toBeCloseTo(1, 5);
  });

  it('carries velocity through, so an accented beat reads louder', () => {
    const read = prepareActivity(
      scoreOf([note({ tick: 0, velocity: 1 }), note({ tick: 8, velocity: 0.4 })]),
    );
    expect(read.at(0).voices.lead).toBeCloseTo(1, 5);
    expect(read.at(8).voices.lead).toBeCloseTo(0.4, 5);
  });

  it('never reports a level outside 0–1', () => {
    const read = prepareActivity(generateScore(reactFeatures));
    const total = barToTick(generateScore(reactFeatures).bars);

    for (let tick = 0; tick < total; tick += 3.7) {
      const activity = read.at(tick);
      for (const voice of VOICE_ORDER) {
        expect(activity.voices[voice], `${voice} at ${tick}`).toBeGreaterThanOrEqual(0);
        expect(activity.voices[voice], `${voice} at ${tick}`).toBeLessThanOrEqual(1);
      }
      expect(activity.energy).toBeGreaterThanOrEqual(0);
      expect(activity.energy).toBeLessThanOrEqual(1);
    }
  });
});

describe('register bands', () => {
  it('splits by pitch, so the bright band is a register this music uses', () => {
    const read = prepareActivity(
      scoreOf([
        note({ voice: 'bass', midi: 36 }),
        note({ voice: 'lead', midi: 60 }),
        note({ voice: 'bell', midi: 84 }),
      ]),
    );

    const activity = read.at(0);
    expect(activity.low).toBeGreaterThan(0.9);
    expect(activity.mid).toBeGreaterThan(0.9);
    expect(activity.high).toBeGreaterThan(0.9);
  });

  it('files a hat by its voice, not by its note number', () => {
    // A drum's MIDI number names an instrument, not a frequency. Read as a pitch it would put
    // the brightest thing in the kit in the bass band.
    const read = prepareActivity(scoreOf([note({ voice: 'hat', midi: 42 })]));
    const activity = read.at(0);
    expect(activity.high).toBeGreaterThan(0.9);
    expect(activity.low).toBe(0);
  });
});

describe('against a real score', () => {
  const score = generateScore(reactFeatures);
  const read = prepareActivity(score);
  const total = barToTick(score.bars);

  const sample = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let tick = from; tick < to; tick += 0.5) out.push(read.at(tick).energy);
    return out;
  };

  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

  it('moves — which is the whole point, and the thing the FFT could not do', () => {
    // The threshold has a source rather than being a taste. Measured against the live
    // analyser this replaces, over forty seconds of one playthrough: its strongest band ran
    // 19–30 out of 100, which is a standard deviation of 0.024 on this scale, and its other
    // two managed 2–11 and 0–1. The canvas it drove differed from silence by a third of one
    // percent of its pixels — a still image with a label saying AUDIO REACTIVE.
    //
    // So: more than double the variation of the best thing the FFT produced, and a range that
    // covers most of the scale rather than a tenth of it.
    const energies = sample(0, total);
    const spread = Math.max(...energies) - Math.min(...energies);
    expect(spread).toBeGreaterThan(0.35);

    const average = mean(energies);
    const variance = mean(energies.map((value) => (value - average) ** 2));
    expect(Math.sqrt(variance)).toBeGreaterThan(0.06);
  });

  it('follows the arrangement: the peak is busier than the intro and the break', () => {
    const section = (name: string) => {
      const found = score.sections.find((item) => item.name === name);
      if (!found) throw new Error(`no ${name} section`);
      return [barToTick(found.startBar), barToTick(found.startBar + found.bars)] as const;
    };

    const intro = mean(sample(...section('intro')));
    const peak = mean(sample(...section('peak')));
    const brk = mean(sample(...section('break')));

    expect(peak).toBeGreaterThan(intro);
    expect(peak).toBeGreaterThan(brk);
  });

  it('gives every voice something to do rather than leaving a band dead', () => {
    // The failure this rules out: a band that is structurally zero for every repository,
    // which is what 6–13 kHz is for pads and plucks.
    for (const band of ['low', 'mid', 'high'] as const) {
      let peak = 0;
      for (let tick = 0; tick < total; tick += 0.5) {
        peak = Math.max(peak, read.at(tick)[band]);
      }
      expect(peak, `${band} never rose`).toBeGreaterThan(0.5);
    }
  });
});
