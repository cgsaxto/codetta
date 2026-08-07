import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../features/fixture';
import { generateScore } from './generate';

/**
 * The regression check CLAUDE.md asks for.
 *
 * "The same commit SHA always produces the same audio, forever" is a promise about the
 * whole generation path, and every other test in this repo checks one property of it in
 * isolation — in key, on the grid, inside the register, under the ceiling. A score can
 * satisfy all of them and still be a different piece of music.
 *
 * This is the check that notices. It is deliberately a JSON diff rather than a WAV
 * comparison: the Score is plain data precisely so that a change shows up as a readable
 * list of moved notes instead of a binary that differs.
 *
 * A failure here is not automatically a bug — most of the changes in Phase 0 moved these
 * numbers on purpose. It means: look at the diff, decide whether you meant it, and if you
 * did, run `pnpm fixtures:update` in the same commit that justifies it.
 */
describe('golden score', () => {
  it('matches the recorded score for the react fixture', async () => {
    const score = generateScore(reactFeatures);
    await expect(`${JSON.stringify(score, null, 2)}\n`).toMatchFileSnapshot(
      '../../../../fixtures/react.expected.json',
    );
  });
});
