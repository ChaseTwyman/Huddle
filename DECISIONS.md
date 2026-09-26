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
- Preset files seed knowledge levels by slot: Seen = 1 exposure, Familiar = 2 exposures + 1 recall ("you called this last time"), Mastered = 3 exposures + 1 recall; "basics" = every concept with category `basics`. A learner who turns out to be the fan is dropped from the slots and the preset is re-applied.
- `game4.json` keeps every item from BUILD_PROMPT 6.8 and adds everyday concepts three games of watching would cover (third down, incomplete pass, timeout, kneel-down…), tuned until `simulate` shows ≥ 50% fewer Huddle lines. Thresholds unchanged.
- "Huddle-spoken lines" (budgets, the Game 1 vs Game 4 comparison) = Director explanation lines Huddle speaks (full or short). Referee announcements, storyline intros, halftime/final lines and people's explanations don't count; storyline beats count toward the minimum gap but not the budget.
- The preset comparison runs 10 seeded bot runs of segments A–C at demo pacing and compares totals: bot choices (take-its, handoffs, Call It accuracy) are random, and single runs of ~3 lines were too noisy to measure a 50% change.
- Simulation bots play like their knowledge: a learner at Familiar or better on the flagged concept calls it right 90% of the time and never taps "Still confused".
- One Director turn per play, at `dead_time`, with trigger = penalty (flag announced), decision (decision play) or play. It is equivalent to running after `penalty_announced` / the decision result, and avoids two turns on one play.
- Minimum gap: penalty turns wait out the remaining gap (the room never skips the explanation after a reveal); decision and ordinary turns are skipped if the gap isn't met. Referee announcements don't count as Huddle lines for the gap.
- Order in dead time: storyline beat first (e.g. Toney's return), then the Director. A decision explanation right after a beat is skipped to avoid crowding.
- The LLM may choose "silent", except after a flag: F5 says the explanation follows the reveal, so a silent answer after a penalty falls back to the template.
- Template fallback after a flag adds one unlocked quote about the flagged player to the card (e.g. Bradberry's quote), per the Director's "one provided player fact" rule.
- Pause takes effect at the next engine step (the current timer finishes first), and open windows keep their timers.
- "Next" closes any open window early and cuts the current pacing wait.
- Predict resolves at `play_result`; on flagged plays it resolves at `penalty_announced` so a voided prediction doesn't hint at a no-play before the call.
- The referee announcement is also spoken by the TV voice (priority 2).
- `gameNight` pacing raised (preSnap 7 s, play 4 s, postPlay 5.5 s, announce 4 s, summary 4 s, halftime 15 s) so a condensed Super Bowl LVII runs ~25 minutes in `simulate`.
- An LLM client is created per room (sharing the disk cache) so each host's AI log only shows its own room.

# PRD deviations

- None yet.
