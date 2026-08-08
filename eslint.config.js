import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * The rules below turn the hard rules in CLAUDE.md into something the linter enforces.
 * They exist because "same commit SHA always produces the same audio, forever" is a
 * promise no reviewer can keep by memory alone.
 */

const NO_UNSEEDED_RANDOMNESS = [
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Math.random() breaks determinism. Use the seeded PRNG in music/rng.ts.',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Date.now() breaks determinism. The generation path may not read the clock.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'new Date() breaks determinism. The generation path may not read the clock.',
  },
  {
    selector: "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
    message: 'crypto.randomUUID() breaks determinism. Derive ids from features.seed.',
  },
  {
    selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
    message:
      'performance.now() breaks determinism. The generation path may not read the clock.',
  },
];

const NO_WALL_CLOCK_SCHEDULING = [
  {
    selector: 'CallExpression[callee.name=/^(setTimeout|setInterval|requestAnimationFrame)$/]',
    message: 'All musical timing goes through Tone.Transport. Wall-clock timers drift.',
  },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.tmp/**'],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // A leading underscore marks a binding that exists to be declared rather than read —
      // a type parameter carrying a constraint that is itself the assertion, for instance.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    // The generation path: pure functions only. Must be deterministic, and must not know
    // that Tone.js exists — see the architecture section of CLAUDE.md.
    files: ['apps/web/src/music/**/*.ts'],
    ignores: ['apps/web/src/music/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_UNSEEDED_RANDOMNESS, ...NO_WALL_CLOCK_SCHEDULING],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'tone',
              message:
                'music/ emits a plain Score. Tone.js objects are constructed only in audio/.',
            },
          ],
        },
      ],
    },
  },

  {
    // audio/ only plays back a Score it was handed. It has no business inventing values,
    // so the determinism bans apply here too — "no unseeded randomness anywhere".
    files: ['apps/web/src/audio/**/*.ts'],
    ignores: ['apps/web/src/audio/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_UNSEEDED_RANDOMNESS, ...NO_WALL_CLOCK_SCHEDULING],
    },
  },

  prettier,
);
