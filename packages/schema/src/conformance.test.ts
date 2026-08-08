import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_SHARE_KEYS,
  REPO_FEATURES_KEYS,
  REPO_IDENTITY_KEYS,
  REPO_MODULE_KEYS,
  SCHEMA_VERSION,
  TIMELINE_ENTRY_KEYS,
  TOTALS_KEYS,
  type LanguageShare,
  type RepoFeatures,
  type RepoIdentity,
  type RepoModule,
  type TimelineEntry,
  type Totals,
} from './index';

/**
 * The TypeScript half of the conformance check. schema_test.go is the other half.
 *
 * The roadmap asked for both languages to be generated from one source. Two hand-written
 * declarations and a test that proves they agree turned out to be less machinery for the
 * same guarantee on a contract this small — but only if the test is genuinely strong, so
 * this is where that claim gets paid for.
 *
 * Go covers its own side by decoding the fixtures strictly and round-tripping them. That
 * leaves one hole TypeScript has to close itself: structural typing means a document with
 * an *extra* field still satisfies an interface, so `tsc` alone would never notice a field
 * that Go and the fixtures know about and TypeScript does not.
 */

/**
 * Fails to compile unless `T` is `never`. Applied below to the leftovers of subtracting a
 * key list from its own type, which is what makes the lists provably complete rather than
 * merely plausible.
 */
function assertNoMissingKeys<_T extends never>(): void {}

type Missing<T, K extends readonly PropertyKey[]> = Exclude<keyof T, K[number]>;

assertNoMissingKeys<Missing<RepoIdentity, typeof REPO_IDENTITY_KEYS>>();
assertNoMissingKeys<Missing<Totals, typeof TOTALS_KEYS>>();
assertNoMissingKeys<Missing<LanguageShare, typeof LANGUAGE_SHARE_KEYS>>();
assertNoMissingKeys<Missing<RepoModule, typeof REPO_MODULE_KEYS>>();
assertNoMissingKeys<Missing<TimelineEntry, typeof TIMELINE_ENTRY_KEYS>>();
assertNoMissingKeys<Missing<RepoFeatures, typeof REPO_FEATURES_KEYS>>();

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', '..', 'fixtures');

function loadFixtures(): Array<readonly [string, RepoFeatures]> {
  const names = readdirSync(FIXTURES_DIR).filter(
    // *.expected.json holds recorded Scores, which are the music layer's business.
    (name) => name.endsWith('.json') && !name.endsWith('.expected.json'),
  );
  return names.map((name) => {
    const raw: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
    return [name, raw as RepoFeatures] as const;
  });
}

const FIXTURES = loadFixtures();

function expectExactKeys(value: object, allowed: readonly string[], where: string): void {
  expect([...Object.keys(value)].sort(), where).toStrictEqual([...allowed].sort());
}

describe('fixtures', () => {
  it('exist, so the check cannot pass vacuously', () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });
});

describe.each(FIXTURES)('%s', (name, features) => {
  it('carries exactly the declared top-level fields', () => {
    expectExactKeys(features, REPO_FEATURES_KEYS, name);
  });

  it('declares the current schema version', () => {
    expect(features.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('carries exactly the declared repo fields', () => {
    expectExactKeys(features.repo, REPO_IDENTITY_KEYS, `${name} repo`);
  });

  it('carries exactly the declared totals fields', () => {
    expectExactKeys(features.totals, TOTALS_KEYS, `${name} totals`);
  });

  it('carries exactly the declared language fields', () => {
    for (const [i, language] of features.languages.entries()) {
      expectExactKeys(language, LANGUAGE_SHARE_KEYS, `${name} languages[${i}]`);
    }
  });

  it('carries exactly the declared module fields', () => {
    for (const [i, module] of features.modules.entries()) {
      expectExactKeys(module, REPO_MODULE_KEYS, `${name} modules[${i}]`);
    }
  });

  it('carries exactly the declared timeline fields', () => {
    for (const [i, entry] of features.timeline.entries()) {
      expectExactKeys(entry, TIMELINE_ENTRY_KEYS, `${name} timeline[${i}]`);
    }
  });
});
