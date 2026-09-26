# Decisions

One line per ambiguous choice made during the build.

- Repo setup: the team's upload had the build prompt saved as both `CLAUDE.md` and `BUILD_PROMPT (1).md`, and the PRD at the root. Moved them to `BUILD_PROMPT.md` and `docs/PRD.md`, and replaced `CLAUDE.md` with a short project file that imports `docs/PRD.md` (per BUILD_PROMPT section 0).
- `CLAUDE.md` imports only `docs/PRD.md`, not `BUILD_PROMPT.md`, to keep per-session context small; it points to `BUILD_PROMPT.md` for implementation details.
- Pinned React 18, TypeScript 5, zod 3, openai 4, Vite 6, vitest 3 (spec names major versions; newer majors were available but not required).
- `.claude-flow/` (local agent tooling state) is gitignored.
- Declined penalties can have `penalty == 0` in nflverse (e.g. Super Bowl LVII Q1 10:13); a play also counts as flagged when `desc` contains "Penalty on", with type, team and player parsed from `desc`.
- `no_play` rows whose `desc` holds only the penalty become `kind: "penalty_only"` (shown as "Whistle. Flag before the snap." and treated as pre-snap for Call It distractors), even when the concept (e.g. defensive offside) isn't `preSnap`.
- Reviewed plays: `publicDesc` keeps only the final ruling plus "(Call reversed/upheld after review.)", so the ticker never shows an overturned touchdown.
- Announcements say "First down" when a non-automatic defensive foul's yardage reaches the line to gain, instead of "Replay Nth down".
- Moment and segment labels sent to the TV are spoiler-free ("Q4 1:54 · KC · 3rd & 8 at PHI 15"); labels with features (Flag, Score…) stay in `moments.json` for logs.
- The test fixture `data/fixtures/mini_game.json` is written as nflverse-style rows and built through the real pipeline (`loadFixture()`), so tests cover the builder too. It has 20 plays.
- Preset files seed knowledge levels by slot: Seen = 1 exposure, Familiar = 2 exposures, Mastered = 3 exposures + 1 recall; "basics" = every concept with category `basics`.

# PRD deviations

- None yet.
