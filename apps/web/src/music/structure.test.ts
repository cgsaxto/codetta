import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../features/fixture';
import { applyStructure } from './arrangement';
import { generateScore } from './generate';
import {
  TICKS_PER_BAR,
  VOICE_ORDER,
  barToTick,
  type NoteEvent,
  type Section,
  type SectionName,
  type VoiceId,
} from './score';
import { buildSkeleton, structureFor } from './skeleton';

const skeleton = buildSkeleton(reactFeatures);
const sections = skeleton.sections;

function sectionNamed(name: SectionName): Section {
  const found = sections.find((section) => section.name === name);
  if (!found) throw new Error(`no ${name} section`);
  return found;
}

/** One note per voice on every bar, so only the gating is under test. */
function everyVoiceEverywhere(): NoteEvent[] {
  const events: NoteEvent[] = [];
  for (let bar = 0; bar < skeleton.bars; bar++) {
    for (const voice of VOICE_ORDER) {
      events.push({ voice, tick: barToTick(bar), durationTicks: 4, midi: 60, velocity: 0.5 });
    }
  }
  return events;
}

function voicesIn(events: readonly NoteEvent[], section: Section): Set<VoiceId> {
  const lo = barToTick(section.startBar);
  const hi = barToTick(section.startBar + section.bars);
  return new Set(events.filter((e) => e.tick >= lo && e.tick < hi).map((e) => e.voice));
}

describe('applyStructure', () => {
  const arranged = applyStructure(everyVoiceEverywhere(), sections);

  it('opens on pad and bass alone', () => {
    expect([...voicesIn(arranged, sectionNamed('intro'))].sort()).toStrictEqual([
      'bass',
      'pad',
    ]);
  });

  it('brings the lead in at the start of the build and the arp at its midpoint', () => {
    const build = sectionNamed('build');
    const barsWith = (voice: VoiceId) =>
      arranged
        .filter((e) => e.voice === voice)
        .map((e) => Math.floor(e.tick / TICKS_PER_BAR))
        .filter((bar) => bar >= build.startBar && bar < build.startBar + build.bars);

    expect(barsWith('lead')[0]).toBe(build.startBar);
    expect(barsWith('arp')[0]).toBe(build.startBar + build.bars / 2);
  });

  it('runs everything at the peak and again on the return', () => {
    for (const name of ['peak', 'return'] as const) {
      expect(voicesIn(arranged, sectionNamed(name)).size, name).toBe(VOICE_ORDER.length);
    }
  });

  it('drops the break to the safety net and the lead', () => {
    // Layer 2 wins over the older wording: four bars with no bass is not a breakdown, it
    // is a hole.
    expect([...voicesIn(arranged, sectionNamed('break'))].sort()).toStrictEqual([
      'bass',
      'lead',
      'pad',
    ]);
  });

  it('thins the break without thinning the safety net', () => {
    const build = sectionNamed('build');
    const brk = sectionNamed('break');
    const count = (voice: VoiceId, section: Section) =>
      arranged.filter((e) => {
        const bar = Math.floor(e.tick / TICKS_PER_BAR);
        return (
          e.voice === voice && bar >= section.startBar && bar < section.startBar + section.bars
        );
      }).length;

    // Same source material in both sections, so per-bar rates are comparable.
    const leadRate = (s: Section) => count('lead', s) / s.bars;
    expect(leadRate(brk)).toBeLessThan(leadRate(build));

    // Pad and bass keep their own pattern. Thinning the safety net is the same mistake in
    // a different form.
    expect(count('pad', brk) / brk.bars).toBe(1);
    expect(count('bass', brk) / brk.bars).toBe(1);
  });

  it('sheds the outro in reverse rank order, pad and bass last', () => {
    const outro = sectionNamed('outro');
    const lastBar = (voice: VoiceId) => {
      const bars = arranged
        .filter((e) => e.voice === voice)
        .map((e) => Math.floor(e.tick / TICKS_PER_BAR))
        .filter((bar) => bar >= outro.startBar);
      return bars.length === 0 ? -1 : Math.max(...bars);
    };

    // Reverse rank order: hat goes first, lead is the last of the module voices to go.
    expect(lastBar('hat')).toBeLessThan(lastBar('kick') + 1);
    expect(lastBar('bell')).toBeLessThanOrEqual(lastBar('arp') + 1);
    expect(lastBar('arp')).toBeLessThan(lastBar('lead'));
    for (const voice of ['lead', 'arp', 'bell', 'texture', 'kick', 'hat'] as const) {
      expect(lastBar(voice), voice).toBeLessThan(lastBar('pad'));
    }

    // The safety net plays to the final bar.
    expect(lastBar('pad')).toBe(skeleton.bars - 1);
    expect(lastBar('bass')).toBe(skeleton.bars - 1);
  });

  it('is deterministic', () => {
    expect(applyStructure(everyVoiceEverywhere(), sections)).toStrictEqual(arranged);
  });

  it('works for every tempo template', () => {
    for (const bpm of [72, 96, 120]) {
      const structure = structureFor(bpm);
      const events: NoteEvent[] = [];
      for (let bar = 0; bar < structure.bars; bar++) {
        for (const voice of VOICE_ORDER) {
          events.push({
            voice,
            tick: barToTick(bar),
            durationTicks: 4,
            midi: 60,
            velocity: 0.5,
          });
        }
      }
      const result = applyStructure(events, structure.sections);
      const intro = structure.sections[0];
      if (!intro) throw new Error('no intro');
      expect([...voicesIn(result, intro)].sort(), `${bpm} BPM`).toStrictEqual(['bass', 'pad']);
    }
  });
});

describe('the arranged score', () => {
  it('is quietest at the intro and the break', () => {
    // The shape the whole template exists to produce. Without it every bar has every voice
    // in it, which is the same forty bars over and over however good each voice is.
    const score = generateScore(reactFeatures);
    const perBar = (section: Section) => {
      const lo = barToTick(section.startBar);
      const hi = barToTick(section.startBar + section.bars);
      return score.events.filter((e) => e.tick >= lo && e.tick < hi).length / section.bars;
    };
    const find = (name: SectionName) => {
      const s = score.sections.find((section) => section.name === name);
      if (!s) throw new Error(`no ${name}`);
      return s;
    };

    expect(perBar(find('intro'))).toBeLessThan(perBar(find('build')));
    expect(perBar(find('break'))).toBeLessThan(perBar(find('peak')));
    expect(perBar(find('peak'))).toBeGreaterThan(perBar(find('intro')));
  });
});
