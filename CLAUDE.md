# Huddle

A game-night co-host for families watching NFL games together. Shared TV screen, phones as buzzers, AI Director that explains in dead time and fades out as the family learns.

@docs/PRD.md

## Source documents

- `docs/PRD.md` — product requirements (source of truth for behavior and acceptance criteria). Never edit.
- `BUILD_PROMPT.md` — implementation spec (stack, layout, data formats, timings, prompts, tests). Read the relevant section before working on a feature.
- `DECISIONS.md` — one line per ambiguous choice; "PRD deviations" section for conflicts.

## Rules

- PRD decides product behavior; `BUILD_PROMPT.md` decides implementation details. Record conflicts in `DECISIONS.md`.
- Everything must run with `LLM_PROVIDER=mock` (no API key).
- Server-authoritative state. No spoilers: penalty names, play results, and storyline facts never reach clients, speech, ticker, or non-callit LLM inputs before their reveal moment.
- Every AI call: timeout, zod validation, one retry on invalid JSON, template fallback.
- Name the PRD feature ID (F1–F15) when working on a feature; keep the README traceability table current.
- Subagents must read `docs/PRD.md` and the relevant `BUILD_PROMPT.md` section first.
- TypeScript `strict: true`.

## Commands

- `npm run dev` — server :8787 + Vite :5173 (LAN-reachable)
- `npm run typecheck` · `npm test` · `npm run build` · `npm start`
- `npm run fetch-game` — download nflverse pbp and build Super Bowl LVII data
- `npm run simulate` — full-game simulation with bots (mock LLM; `--llm` for real)
- `npm run smoke` — end-to-end socket test against a real server
