import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../../features/fixture';
import type { RepoModule } from '../../features/types';
import {
  PHRASE_ACTIVE_TICKS,
  PHRASE_TICKS,
  assignVoices,
  type VoiceContext,
} from '../arrangement';
import { ROOT_PITCH_CLASS } from '../progressions';
import { VOICE_REGISTERS, barToTick } from '../score';
import { buildSkeleton } from '../skeleton';
import { textureEvents, textureTimbre } from './texture';

const skeleton = buildSkeleton(reactFeatures);

function textureContext(overrides: Partial<RepoModule> = {}): VoiceContext {
  const base = assignVoices(reactFeatures, skeleton).find((c) => c.voice === 'texture');
  if (!base) throw new Error('react fixture does not reach the texture voice');
  return { ...base, module: { ...base.module, ...overrides } };
}

describe('texture', () => {
  it('stays inside the texture register', () => {
    const [lo, hi] = VOICE_REGISTERS.texture;
    for (const event of textureEvents(textureContext())) {
      expect(event.midi).toBeGreaterThanOrEqual(lo);
      expect(event.midi).toBeLessThanOrEqual(hi);
    }
  });

  it('holds the tonic and nothing else', () => {
    // A pedal cannot clash with a loop that never leaves its own mode, which is what makes
    // this the one voice safe to leave running underneath everything.
    const pitches = new Set(
      textureEvents(textureContext()).map((e) => ((e.midi % 12) + 12) % 12),
    );
    expect([...pitches]).toStrictEqual([ROOT_PITCH_CLASS[skeleton.root]]);
  });

  it('does not stop for the phrase rest', () => {
    // It is a bed, like the pad and the bass. A drone that breaks every two bars is not a
    // drone, and the rest exists for the foreground voices rather than for everything.
    const events = textureEvents(textureContext());
    const coversRest = events.some((event) => {
      const position = event.tick % PHRASE_TICKS;
      return position + event.durationTicks > PHRASE_ACTIVE_TICKS;
    });
    expect(coversRest).toBe(true);
  });

  it('covers the whole piece without a gap', () => {
    const events = textureEvents(textureContext());
    let cursor = 0;
    for (const event of events) {
      expect(event.tick).toBe(cursor);
      cursor += event.durationTicks;
    }
    expect(cursor).toBe(barToTick(skeleton.bars));
  });

  it('is quieter than every other voice', () => {
    expect(textureEvents(textureContext())[0]?.velocity).toBeLessThan(0.25);
  });

  it('is deterministic', () => {
    expect(textureEvents(textureContext())).toStrictEqual(textureEvents(textureContext()));
  });
});

describe('textureTimbre', () => {
  it('opens up as the module gains comments', () => {
    expect(textureTimbre(textureContext({ commentRatio: 0.02 })).openness).toBeLessThan(
      textureTimbre(textureContext({ commentRatio: 0.3 })).openness,
    );
  });

  it('stays normalised whatever the ratio is', () => {
    // The audio layer owns the cutoff palette this indexes into. A repo feature choosing a
    // frequency directly is exactly what CLAUDE.md forbids.
    for (const ratio of [0, 0.1, 0.5, 1]) {
      const { openness } = textureTimbre(textureContext({ commentRatio: ratio }));
      expect(openness, `ratio ${ratio}`).toBeGreaterThanOrEqual(0);
      expect(openness, `ratio ${ratio}`).toBeLessThanOrEqual(1);
    }
  });
});
