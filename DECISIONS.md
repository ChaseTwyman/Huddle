# Decisions

One line per ambiguous choice made during the build.

- Repo setup: the team's upload had the build prompt saved as both `CLAUDE.md` and `BUILD_PROMPT (1).md`, and the PRD at the root. Moved them to `BUILD_PROMPT.md` and `docs/PRD.md`, and replaced `CLAUDE.md` with a short project file that imports `docs/PRD.md` (per BUILD_PROMPT section 0).
- `CLAUDE.md` imports only `docs/PRD.md`, not `BUILD_PROMPT.md`, to keep per-session context small; it points to `BUILD_PROMPT.md` for implementation details.
- Pinned React 18, TypeScript 5, zod 3, openai 4, Vite 6, vitest 3 (spec names major versions; newer majors were available but not required).
- `.claude-flow/` (local agent tooling state) is gitignored.

# PRD deviations

- None yet.
