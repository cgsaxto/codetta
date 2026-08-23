<!--
  Conventional Commits for the title: feat:, fix:, chore:, docs:, build:
-->

## What this changes

## Why

<!--
  If this touches the music, the second half of this template is the important half. If it
  does not, delete it — nobody needs to read "n/a" four times.
-->

## If this changes the sound

**What changed** — the recorded scores in `fixtures/*.expected.json`:

- [ ] They did not move.
- [ ] They moved, on purpose, and `pnpm fixtures:update` is in this PR.

**Whether it is better** — the part no test can answer:

- [ ] I ran `pnpm dev` and listened to the peak section.

Would you send this thirty-second clip to a friend unprompted?

## Checks

- [ ] `pnpm typecheck && pnpm test && pnpm lint`
- [ ] `make api-test` (if Go changed)
