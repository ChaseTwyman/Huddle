# Build Huddle: a game-night co-host for families

You are building a complete, working hackathon prototype in this (empty) repository. Work autonomously from start to finish.

- Do not ask me questions (the one exception is in section 0). When something is ambiguous, choose the simplest option that satisfies this spec and the PRD, and record the choice in `DECISIONS.md` (one line each).
- Build in the phase order in section 14. Keep the app runnable at the end of every phase, run that phase's checks, and `git commit` after each phase with a clear message.
- Finish every P0 item and pass the P0 checklist (section 15) before starting any P1 item.
- Do not stop at a plan or a skeleton. The deliverable is working software plus a README.

---

## 0. Source documents: read these first

The repository starts with three files the team wrote. Don't recreate or overwrite them.

- `docs/PRD.md`: the product requirements document. It is the source of truth for what Huddle does and why: users, design principles (section 5), feature IDs F1–F15 with priorities and acceptance criteria (section 7), AI design (section 8), and the demo plan (section 11).
- `CLAUDE.md`: project instructions. Claude Code loads it at the start of every session and re-reads it after compaction, and it imports `docs/PRD.md`, so the PRD stays in context throughout the build.
- `BUILD_PROMPT.md` (this file): the implementation spec. It restates what you need from the PRD in implementation terms.

Rules:

1. Read `docs/PRD.md` in full before Phase 1. If `docs/PRD.md` or `CLAUDE.md` is missing, stop and tell me. This is the only case where you should stop and ask.
2. **Precedence.** The PRD decides product behavior and acceptance criteria. This file decides implementation details: stack, layout, data formats, timings, thresholds, prompts, and tests. The two were written to agree. If you find a conflict, satisfy both when you can; otherwise follow this file for implementation details and the PRD for product behavior, and record the conflict under "PRD deviations" in `DECISIONS.md`.
3. Never edit `docs/PRD.md`. The team maintains it.
4. Keep `CLAUDE.md` short. You may update its Commands section as scripts are added. Never remove its `docs/PRD.md` import or its rules.
5. **Traceability.** Before starting each feature, name its PRD ID (F1–F13) and re-read its acceptance criteria in the PRD. Keep a table in `README.md` with the columns PRD ID, feature, priority, status, main files, and tests. Name test suites after the IDs they cover where practical, for example `describe('F5 Call It', …)`.
6. When you delegate work to a subagent, tell it to read `docs/PRD.md` and the relevant section of this file first, since subagents may not load `CLAUDE.md`.
7. Your final summary lists each P0 acceptance criterion from PRD section 7 with how it was verified (test name, `simulate` or `smoke` output, or a manual step for the team).

---

## 1. What Huddle is

Huddle is a shared-screen co-host for watching NFL games with family members who don't follow football. A laptop drives the TV (the "shared screen"). Everyone joins on their phone, which works only as a buzzer. Huddle:

1. **Stakes first.** Before big decisions (4th down, 2-point tries, field goals) everyone predicts the outcome on their phone. A family scoreboard keeps points.
2. **Learn by guessing (Call It).** When a flag is thrown, everyone guesses which penalty it was before the referee announces it.
3. **Explains in dead time.** Between plays, an AI "Director" decides whether anything is worth explaining to *these* people, and if so speaks one short line (browser speech synthesis) with a caption card.
4. **People teach people.** Before Huddle explains, the fan's phone offers "Take it?" with a one-line cheat. When a learner already knows a rule another learner doesn't, Huddle offers the explanation to them first.
5. **Fades out.** Huddle tracks what each learner knows per rule concept and explains less as they learn.

The prototype replays real NFL games from open nflverse play-by-play data. The demo game is **Super Bowl LVII** (Feb 12, 2023; Kansas City 38, Philadelphia 35). AI runs on Meta's **Llama 4 Maverick and Scout** through any OpenAI-compatible API (Groq by default), with a **mock provider** so everything runs and tests pass with no API key.

---

## 2. Non-negotiables

1. **Runs with no API key.** `LLM_PROVIDER=mock` makes every AI job return its deterministic template fallback after a short simulated delay. All flows, tests, `simulate` and `smoke` must pass in mock mode.
2. **Server-authoritative state.** Clients render snapshots the server sends. Clients never receive raw timeline plays.
3. **No spoilers.** Before a play's `penalty_announced` event, the penalty type, its concept id, and its concept name must not appear in any message sent to any client, in any text sent to speech, in the ticker, or in any LLM input except the Call It distractor call (which receives the correct answer only so it can avoid it; its output stays on the server until the window opens). Likewise, no play result is sent before that play's snap, and storyline facts are never sent before their `revealAfter` moment. An automated test enforces this (section 13).
4. **Grounded AI.** Explanations may only use facts from the concept's rule card, the play data and the situation. Storyline text may only use facts from `storylines.json` whose `revealAfter` moment has passed and whose `verified` is true (unless `ALLOW_UNVERIFIED_FACTS=true`).
5. **Every AI call** has a timeout, JSON-schema validation (zod), at most one retry on invalid JSON, and a template fallback. The UI never waits longer than the timeout.
6. **The shared screen is the main surface; phones are buzzers.** No feeds or scrolling lists on phones.
7. TypeScript `strict: true`. `npm run typecheck`, `npm test`, `npm run build`, `npm run simulate` and `npm run smoke` all pass at the end.
8. No betting, odds, or fantasy features. No accounts. No logos (team abbreviations and colors only). No broadcast video committed to the repo.

---

## 3. Stack

- Node 20+, TypeScript 5, **one package** (no workspaces).
- Server: `express`, `socket.io` (v4), `zod`, `openai` (v4+, used as an OpenAI-compatible client with a custom `baseURL`), `dotenv`, `nanoid`, `csv-parse`. Run with `tsx` in dev.
- Web: `vite`, `react` 18, `react-dom`, `react-router-dom`, `socket.io-client`, `qrcode`. Plain CSS with custom properties. No Tailwind, no component libraries.
- Tests: `vitest`. Dev runner: `concurrently`.
- Scripts in `package.json`:
  - `dev`: server on `:8787` (tsx watch) and Vite on `:5173` with `--host` so phones on the LAN can reach it. Vite proxies `/api` and `/socket.io` (with `ws: true`) to `:8787`.
  - `build`: Vite build to `dist/web`; `start`: build then serve `dist/web` and the API from the server on `:8787`.
  - `typecheck`: `tsc --noEmit`.
  - `test`: `vitest run`.
  - `fetch-game`: `tsx scripts/fetch-game.ts`.
  - `simulate`: `tsx scripts/simulate.ts`.
  - `smoke`: `tsx scripts/smoke.ts`.

---

## 4. Repository layout

```
.
├─ package.json  tsconfig.json  vite.config.ts  .env.example  .gitignore
├─ CLAUDE.md                    # provided by the team; imports docs/PRD.md
├─ README.md  DECISIONS.md
├─ docs/PRD.md                  # provided by the team; never edit
├─ data/
│  ├─ concepts.json            # rule concept cards (section 6.2)
│  ├─ penalties.json           # nflverse penalty strings → concept ids (section 6.3)
│  ├─ presets/game1.json  presets/game4.json
│  ├─ fixtures/mini_game.json  # hand-written ~16-play fixture for tests (section 13)
│  ├─ games/index.json         # list of processed games
│  ├─ games/2022_22_KC_PHI/    # timeline.json, moments.json, storylines.json, README.md
│  ├─ raw/  families/  cache/  # gitignored
├─ scripts/  fetch-game.ts  simulate.ts  smoke.ts
├─ shared/   types.ts  teams.ts  constants.ts
├─ server/
│  ├─ index.ts  http.ts
│  ├─ room/        Room.ts  RoomManager.ts  transport.ts  clock.ts
│  ├─ engine/      ReplayEngine.ts  GameSource.ts  condense.ts
│  ├─ data/        loadGame.ts  tagger.ts  penalties.ts  timeline.ts
│  ├─ game/        predict.ts  callit.ts  scoring.ts  knowledge.ts  storylines.ts  recap.ts  ticker.ts
│  ├─ director/    scheduler.ts  director.ts  templates.ts
│  ├─ ai/          llm.ts  prompts.ts  schemas.ts  cache.ts  limiter.ts  vision.ts (P1)
│  └─ persistence/ families.ts
├─ web/
│  ├─ index.html
│  └─ src/  main.tsx  App.tsx
│     ├─ styles/  tokens.css  base.css
│     ├─ lib/     socket.ts  tts.ts  useSnapshot.ts
│     ├─ pages/   HostSetup.tsx  Tv.tsx  Play.tsx  SyncTool.tsx (P1)  VisionLab.tsx (P1)
│     └─ components/tv/*  components/phone/*
└─ tests/  *.test.ts
```

`.gitignore`: `node_modules`, `dist`, `.env`, `data/raw`, `data/cache`, `data/families`, `*.mp4`, `*.mkv`, `*.mov`.

---

## 5. Environment (`.env.example`)

```
# mock = no key needed; openai_compatible = Groq, Together, or any OpenAI-compatible host
LLM_PROVIDER=mock
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=
# Llama 4 on Groq. On Together use:
#   meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8 and meta-llama/Llama-4-Scout-17B-16E-Instruct
LLM_MODEL_SMART=meta-llama/llama-4-maverick-17b-128e-instruct
LLM_MODEL_FAST=meta-llama/llama-4-scout-17b-16e-instruct
LLM_MODEL_VISION=meta-llama/llama-4-scout-17b-16e-instruct
LLM_CACHE=on
LLM_MAX_CONCURRENCY=4
ALLOW_UNVERIFIED_FACTS=false
PORT=8787
# Optional: force the LAN host used in QR codes, e.g. 192.168.1.23
PUBLIC_HOST=
```

Model IDs appear only in `.env.example` and are read from env. If a model call returns 404 or "model not found", log one clear message telling the user to check the provider's model list (`GET {LLM_BASE_URL}/models`) and continue with fallbacks.

---

## 6. Data (Phase 1)

### 6.1 `scripts/fetch-game.ts`

Usage: `npm run fetch-game -- --season 2022 --week 22 --teams KC,PHI` (also accept `--game-id`). Default with no args: Super Bowl LVII.

1. Download `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.csv.gz` to `data/raw/` if not already there. If the download fails, print exact manual instructions (download that URL into `data/raw/`) and exit non-zero.
2. Stream-parse with `csv-parse` (`columns: true`), keeping only rows of the target game. For the default, filter `season == 2022`, `week == 22`, and teams `{KC, PHI}`. The expected `game_id` is `2022_22_KC_PHI`; verify by filtering, don't assume.
3. Print the columns actually present. Use these when available; if one is missing, degrade gracefully and note it in the game's `README.md`:
   `play_id, game_id, home_team, away_team, posteam, defteam, qtr, time, quarter_seconds_remaining, game_seconds_remaining, down, ydstogo, yardline_100, goal_to_go, desc, play_type, play_type_nfl, yards_gained, return_yards, first_down, first_down_penalty, penalty, penalty_team, penalty_player_name, penalty_yards, penalty_type, touchdown, td_team, field_goal_attempt, field_goal_result, kick_distance, extra_point_attempt, extra_point_result, two_point_attempt, two_point_conv_result, fourth_down_converted, fourth_down_failed, punt_attempt, interception, fumble_lost, sack, incomplete_pass, timeout, timeout_team, home_timeouts_remaining, away_timeouts_remaining, total_home_score, total_away_score, replay_or_challenge, replay_or_challenge_result, passer_player_name, receiver_player_name, rusher_player_name, punt_returner_player_name, kickoff_returner_player_name, kicker_player_name, qb_kneel, qb_spike, touchback, safety, wp, wpa, drive`.
4. Build the timeline (6.4), tag concepts (6.5), detect decisions, moments and demo segments (6.6), and write `data/games/<game_id>/timeline.json`, `moments.json`, and a `README.md` describing the column mapping and any gaps. Update `data/games/index.json` with `{ id, title, date, home, away, finalScore }` (title for the default: "Super Bowl LVII").
5. **Validate** and fail loudly if wrong: the final score must be KC 38, PHI 35; every required moment key in 6.6 must be found. Print a summary table of plays, penalties, decisions and moments.

Commit the processed files for Super Bowl LVII so the app works without re-downloading.

### 6.2 Concept cards: `data/concepts.json`

Each entry:
```ts
type Concept = {
  id: string; name: string;
  category: 'basics' | 'scoring' | 'decision' | 'clock' | 'review' | 'result' | 'penalty';
  priority: number;              // higher = more worth explaining (see table)
  short: string;                 // ≤ 12 words, a reminder
  full: string;                  // ≤ 28 words, a first explanation for a newcomer
  detail?: string;               // ≤ 160 chars, e.g. yardage, for the caption card
  yards?: string; autoFirstDown?: boolean;
  preSnap?: boolean;             // penalty called before the snap (dead ball)
  reviewed: false;               // the team flips this after checking
};
```
Write every card from the facts below, in plain words for someone who has never watched football. Describe rules as they applied in the 2022 season. Do not state kickoff touchback yardage or overtime rules (both changed in 2024–2025). Keep every fact you write inside what is listed here.

| id | priority | facts to use |
|---|---|---|
| downs | 30 | Offense gets 4 tries (downs) to gain 10 yards; gain them and it's 1st down again. |
| first_down_line | 30 | The yellow line on TV shows where the offense must reach for a new 1st down. It's a TV graphic; on the field, chains on the sideline mark it. |
| line_of_scrimmage | 30 | Where the ball sits before a play (blue line on our field). Neither side may cross it before the snap. |
| snap | 30 | Every play starts when the center passes the ball back between his legs. |
| third_down | 60 | 3rd down is the big one: fail, and the offense usually punts or tries a field goal on 4th. |
| red_zone | 30 | Inside the opponent's 20-yard line. Scoring chances are highest here. |
| goal_to_go | 30 | When the goal line is closer than 10 yards, it's "& Goal": the only way to a new set of downs is to score. |
| touchdown | 70 | Carry or catch the ball in the opponent's end zone: 6 points, then a bonus try. |
| extra_point | 70 | After a touchdown, a short kick through the uprights: 1 point. |
| two_point_conversion | 70 | Instead of kicking, run one play from the 2-yard line; reaching the end zone is worth 2 points. |
| field_goal | 70 | Kick through the uprights during a play: 3 points. |
| safety | 70 | Offense tackled in its own end zone: 2 points to the defense, which also gets the ball back by a free kick. |
| fourth_down_decision | 60 | On 4th down a coach chooses: go for it, punt it away, or kick a field goal. Falling short when going for it gives the other team the ball right there. |
| turnover_on_downs | 60 | Went for it on 4th down and fell short: the other team takes over at that spot. |
| punt | 40 | A kick on 4th down that gives the ball away but pushes the other team back. |
| punt_return | 40 | The receiving team's returner catches the punt and tries to run it back. |
| fair_catch | 40 | The returner waves an arm above his head: he can't be hit, but he can't run after catching. |
| kickoff | 40 | The kick that starts each half and follows every score. |
| touchback | 40 | A kick downed in or through the end zone: no return, the receiving team starts from a set spot. For punts that spot is its own 20. |
| interception | 40 | A defender catches a pass: the defense takes the ball. |
| fumble | 40 | A ball carrier drops the ball; whoever recovers it keeps it. |
| sack | 40 | The quarterback is tackled behind the line of scrimmage before he throws. |
| incomplete_pass | 40 | The pass hits the ground: the play ends, the ball goes back to where it started, and the clock stops. |
| game_clock | 55 | Four 15-minute quarters. The clock stops for incomplete passes, scores, timeouts, and some plays out of bounds. |
| play_clock | 55 | Usually 40 seconds to start the next play, or it's a delay-of-game penalty. |
| two_minute_warning | 55 | An automatic pause when 2:00 is left in each half. |
| timeout | 55 | Each team gets 3 per half to stop the clock. |
| running_out_the_clock | 55 | A team that's ahead or tied late keeps the ball in bounds and uses its whole play clock so the other team gets less time. |
| kneel_down | 55 | The quarterback kneels right after the snap to end the play safely while the clock keeps running. |
| spike | 55 | The quarterback throws the ball straight into the ground to stop the clock. It uses a down. |
| challenge_flag | 55 | A coach throws a red flag to ask for a replay review. Lose it, and the team loses a timeout. |
| replay_review | 55 | Officials watch replays and change the call only with clear and obvious evidence. Scoring plays, turnovers, and the last two minutes of each half are reviewed from the booth. |
| automatic_first_down | 80 | Some defensive fouls, like holding and pass interference, give the offense a new 1st down no matter the distance. |
| penalty_declined | 80 | The team that was fouled can refuse the penalty if the play's result was better for them. |
| offsetting_penalties | 80 | Fouls by both teams on the same play cancel out, and the down is replayed. |
| half_the_distance | 80 | A penalty can never move the ball more than half the distance to the goal line. |
| false_start | 100 | Offensive player moves before the snap. 5 yards. preSnap. |
| offside | 100 | Defender is across the line of scrimmage when the ball is snapped. 5 yards. |
| encroachment | 100 | Defender crosses the line and touches an offensive player before the snap. 5 yards. preSnap. |
| neutral_zone_infraction | 100 | Defender moves into the neutral zone and causes an offensive player to flinch. 5 yards. preSnap. |
| delay_of_game | 100 | The offense doesn't snap before the play clock runs out. 5 yards. preSnap. |
| illegal_formation | 100 | The offense lines up wrong, for example fewer than 7 players on the line. 5 yards. |
| illegal_shift | 100 | Offensive players move illegally before the snap (not set, or more than one moving). 5 yards. |
| too_many_men | 100 | 12 or more players on the field. 5 yards. |
| holding_offensive | 100 | A blocker grabs or hooks a defender to stop him. 10 yards. |
| holding_defensive | 100 | A defender grabs or restricts a receiver or blocker who doesn't have the ball. 5 yards and an automatic first down. autoFirstDown. |
| pass_interference_defensive | 100 | A defender blocks a receiver's fair chance to catch a catchable pass after it's thrown. Ball placed at the spot of the foul, automatic first down (at the 1 if in the end zone). autoFirstDown. |
| pass_interference_offensive | 100 | A receiver pushes off or blocks a defender while the pass is in the air. 10 yards. |
| illegal_contact | 100 | A defender contacts a receiver more than 5 yards downfield before the ball is thrown. 5 yards, automatic first down. autoFirstDown. |
| illegal_use_of_hands | 100 | Hands to the face or neck, or illegal pushing. 10 yards on offense; 5 yards and an automatic first down on defense. |
| roughing_the_passer | 100 | Hitting the quarterback late, low, or in the head after he throws. 15 yards, automatic first down. autoFirstDown. |
| unnecessary_roughness | 100 | A hit beyond what the play needs, such as after the whistle. 15 yards; on the defense, also an automatic first down. |
| face_mask | 100 | Grabbing and twisting or pulling an opponent's face mask. 15 yards; on the defense, also an automatic first down. |
| intentional_grounding | 100 | A quarterback under pressure throws the ball away with no receiver nearby, from inside the tackle box. Loss of down and at least 10 yards. |
| illegal_block_in_the_back | 100 | Blocking an opponent from behind, above the waist. 10 yards. |
| tripping | 100 | Using a leg or foot to trip an opponent. 10 yards. |
| horse_collar | 100 | Tackling by grabbing the inside of the back or side collar of the shoulder pads. 15 yards. |
| unsportsmanlike_conduct | 100 | Taunting or other unsportsmanlike acts. 15 yards. |
| roughing_the_kicker | 100 | Running into the kicker hard. 15 yards, automatic first down. autoFirstDown. |
| running_into_the_kicker | 100 | Minor contact with the kicker. 5 yards, no automatic first down. |
| fair_catch_interference | 100 | Getting in the way of a returner who signaled for a fair catch. 15 yards. |
| illegal_forward_pass | 100 | A forward pass thrown from beyond the line of scrimmage, or a second forward pass. 5 yards and loss of down. |
| ineligible_downfield | 100 | A lineman is too far downfield when a pass is thrown. 5 yards. |
| penalty_other | 90 | A foul that's rarer; Huddle names it and gives only the yardage from the announcement. |

### 6.3 `data/penalties.json`

Map nflverse `penalty_type` strings to concept ids with case-insensitive matching, plus the side that commits it and whether it's pre-snap. Include at least: "Offensive Holding", "Defensive Holding", "Defensive Pass Interference", "Offensive Pass Interference", "False Start", "Defensive Offside", "Offside on Free Kick" (→ offside), "Encroachment", "Neutral Zone Infraction", "Delay of Game", "Illegal Formation", "Illegal Shift", "Illegal Motion" (→ illegal_shift), "Too Many Men on Field" and its variants, "Illegal Contact", "Illegal Use of Hands", "Roughing the Passer", "Unnecessary Roughness", "Face Mask" (any variant with yardage in parentheses), "Intentional Grounding", "Illegal Block Above the Waist" (→ illegal_block_in_the_back), "Tripping", "Horse Collar Tackle", "Unsportsmanlike Conduct", "Taunting" (→ unsportsmanlike_conduct), "Roughing the Kicker", "Running Into the Kicker", "Fair Catch Interference", "Illegal Forward Pass", "Ineligible Downfield Pass". Unknown strings map to `penalty_other` with the raw name kept for the announcement, and `fetch-game` prints them.

### 6.4 Timeline (`shared/types.ts`)

```ts
type TeamSide = 'home' | 'away';
type TimelinePlay = {
  idx: number; playId: number; qtr: number; clock: string; gameSecondsRemaining: number;
  posteam: string | null; defteam: string | null;
  down: 1 | 2 | 3 | 4 | null; ydstogo: number | null; yardline100: number | null; goalToGo: boolean;
  scoreBefore: { home: number; away: number }; scoreAfter: { home: number; away: number };
  timeoutsBefore: { home: number; away: number } | null;
  kind: 'pass' | 'run' | 'punt' | 'field_goal' | 'extra_point' | 'two_point' | 'kickoff'
      | 'kneel' | 'spike' | 'timeout' | 'penalty_only' | 'end_of_period' | 'other';
  desc: string;                     // official text. SERVER ONLY (contains spoilers).
  publicDesc: string;               // cleaned text with any penalty clause removed (section 9.7)
  yardsGained: number | null; returnYards: number | null;
  players: { passer?: string; receiver?: string; rusher?: string; returner?: string; kicker?: string; penaltyPlayer?: string };
  result: {
    touchdown: boolean; tdTeam?: string;
    fieldGoal?: 'made' | 'missed' | 'blocked'; kickDistance?: number;
    extraPoint?: 'good' | 'failed' | 'blocked';
    twoPoint?: 'success' | 'failure';
    turnover?: 'interception' | 'fumble' | 'downs';
    firstDown: boolean; sack: boolean; incomplete: boolean; safety: boolean; touchback: boolean; fairCatch: boolean;
  };
  penalty: null | {
    rawType: string; conceptId: string; team: string; side: 'offense' | 'defense';
    yards: number; player?: string; autoFirstDown: boolean;
    status: 'accepted' | 'declined' | 'offsetting'; noPlay: boolean; preSnap: boolean;
    announcement: string;           // section 9.4
  };
  challenge: null | { result: string };
  wp?: number; wpa?: number;
  decision: null | { kind: 'fourth_down' | 'two_point' | 'field_goal' };
  concepts: string[];               // tagged concept ids, highest priority first
  momentKeys: string[];             // e.g. ['bradberry-flag']
  notable: boolean;                 // big play / score / turnover / flag / decision / review
  field: { losAbs: number | null; firstDownAbs: number | null; ballEndAbs: number | null };
};
```
Derivations:
- **Scores.** Validate whether `total_home_score`/`total_away_score` are before or after the play by checking the final row; compute `scoreBefore` as the previous play's `scoreAfter`.
- **Absolute field position** (0–100, measured from the home team's goal line; home attacks to the right): if `posteam == home`, `losAbs = 100 - yardline100`, else `losAbs = yardline100`. `firstDownAbs = losAbs ± ydstogo` in the attack direction (null when goal to go). `ballEndAbs` = the next play's `losAbs` when the next play is by the same team in the same drive; 100 or 0 for a touchdown; otherwise estimate from yards gained.
- **kind** from `play_type` / `play_type_nfl`, `two_point_attempt`, `qb_kneel`, `qb_spike`.
- **Penalty status** from `desc` ("declined", "offsetting"). `noPlay` when `play_type == 'no_play'`. `preSnap` from the concept.
- **Notable**: any decision, any flag, any score, turnover, review, |wpa| ≥ 0.08, gain ≥ 20 yards, or a notable storyline involvement (6.6).

### 6.5 Concept tagger (`server/data/tagger.ts`)

Pure function `tag(play, prevPlay, gameCtx) → conceptIds`, sorted by concept priority. Rules:
- Every scrimmage play: `downs`, `first_down_line` (basics; the scheduler will explain them once, early).
- `down == 3` → `third_down`; `down == 4` → `fourth_down_decision`; turnover on downs → `turnover_on_downs`.
- Scoring: `touchdown`, `extra_point`, `two_point_conversion`, `field_goal`, `safety`.
- Results: `punt`, `punt_return` (returner and return yards > 0), `fair_catch` (desc contains "fair catch"), `kickoff`, `touchback`, `interception`, `fumble`, `sack`, `incomplete_pass`.
- Clock: `timeout`; `two_minute_warning` on the first play of the 2nd or 4th quarter with ≤ 120 quarter seconds remaining; `kneel_down`; `spike`.
- `running_out_the_clock`: qtr 4, ≤ 300 game seconds left, possession team not trailing, and (run or kneel), **or** an accepted penalty with `autoFirstDown` in qtr 4 with ≤ 180 seconds left and the possession team not trailing.
- Review: `challenge_flag` (desc mentions a challenge) or `replay_review`.
- Penalty: the penalty concept, plus `automatic_first_down` (accepted and autoFirstDown or `first_down_penalty == 1`), `penalty_declined`, `offsetting_penalties`, `half_the_distance` (desc contains "half the distance").
- Position: `goal_to_go`, `red_zone` (yardline100 ≤ 20).

### 6.6 Decisions, moments, demo segments

- `decision`: `fourth_down` when `down == 4` and kind is pass/run/punt/field_goal; `two_point` for 2-point attempts; `field_goal` for field-goal attempts on downs 1–3.
- `moments.json`: `{ moments: Moment[], segments: Segment[] }` where every notable play becomes a Moment `{ id, idx, label, qtr, clock, features }` (label like "Q4 1:54 · Flag · 3rd & 8 at PHI 15"), and **segments** drive the demo jump list.
- **Required moment keys** (fail loudly if any is missing; print each with its idx):
  - `toney-return`: punt returned by a player whose name contains "Toney" for ≥ 60 yards.
  - `toney-td`: touchdown pass caught by "Toney".
  - `hurts-2pt`: successful two-point attempt run by "Hurts".
  - `bradberry-flag`: penalty by "Bradberry" whose type contains "Holding".
  - `butker-fg`: 4th-quarter 27-yard field goal by "Butker".
  - `halftime`: the first play of the 3rd quarter. `final`: the last play.
- **Segments** (hotkeys 1–9): A = `toney-return` with 2 lead-in plays; B = `hurts-2pt` with 2 lead-in plays (include the touchdown before it); C = from 2 plays before `bradberry-flag` through `butker-fg`, continuous.

### 6.7 Storylines: `data/games/2022_22_KC_PHI/storylines.json`

Write exactly this content (the team will review and extend it):

```json
{
  "gameFacts": [
    { "text": "Super Bowl LVII was played on February 12, 2023, at State Farm Stadium in Glendale, Arizona.", "revealAfter": null, "verified": true },
    { "text": "Rihanna performed the halftime show.", "revealAfter": null, "verified": true },
    { "text": "Philadelphia led 24–14 at halftime.", "revealAfter": "halftime", "verified": true },
    { "text": "Kansas City won 38–35.", "revealAfter": "final", "verified": true }
  ],
  "storylines": [
    {
      "id": "kelce-brothers", "title": "The Kelce brothers", "assignable": true,
      "tags": ["family", "drama", "relationships"],
      "players": [
        { "name": "Travis Kelce", "team": "KC", "position": "tight end", "pbpNames": ["T.Kelce"] },
        { "name": "Jason Kelce", "team": "PHI", "position": "center", "pbpNames": ["J.Kelce"] }
      ],
      "facts": [
        { "text": "Travis Kelce (Chiefs tight end) and Jason Kelce (Eagles center) are the first brothers to play against each other in a Super Bowl.", "revealAfter": null, "verified": true },
        { "text": "Their mother, Donna Kelce, is the first mom to have two sons play against each other in a Super Bowl.", "revealAfter": null, "verified": true },
        { "text": "As the Eagles' center, Jason snaps the ball to start nearly every Eagles offensive play.", "revealAfter": null, "verified": true }
      ]
    },
    {
      "id": "toney-second-chance", "title": "Kadarius Toney's second chance", "assignable": true,
      "tags": ["underdog", "comeback", "chaos"],
      "players": [ { "name": "Kadarius Toney", "team": "KC", "position": "wide receiver and punt returner", "pbpNames": ["K.Toney"] } ],
      "facts": [
        { "text": "The New York Giants gave up on Toney midway through his second season and traded him to Kansas City.", "revealAfter": null, "verified": true },
        { "text": "Toney caught a 5-yard touchdown pass that gave Kansas City its first lead of the night, 28–27.", "revealAfter": "toney-td", "verified": true },
        { "text": "Toney returned a punt 65 yards, the longest punt return in Super Bowl history.", "revealAfter": "toney-return", "verified": true }
      ]
    },
    {
      "id": "hurts-philly", "title": "Jalen Hurts", "assignable": true,
      "tags": ["drama", "leader", "numbers"],
      "players": [ { "name": "Jalen Hurts", "team": "PHI", "position": "quarterback", "pbpNames": ["J.Hurts"] } ],
      "facts": [
        { "text": "Jalen Hurts is Philadelphia's quarterback.", "revealAfter": null, "verified": true },
        { "text": "Hurts finished second in MVP voting that season.", "revealAfter": null, "verified": false },
        { "text": "Hurts ran in a two-point conversion to tie the game 35–35.", "revealAfter": "hurts-2pt", "verified": true }
      ]
    },
    {
      "id": "mahomes-star", "title": "Patrick Mahomes", "assignable": true,
      "tags": ["favorite", "star", "numbers"],
      "players": [ { "name": "Patrick Mahomes", "team": "KC", "position": "quarterback", "pbpNames": ["P.Mahomes"] } ],
      "facts": [
        { "text": "Patrick Mahomes is Kansas City's quarterback.", "revealAfter": null, "verified": true },
        { "text": "Mahomes was playing through an ankle injury.", "revealAfter": null, "verified": false },
        { "text": "Mahomes was named Super Bowl MVP, his second.", "revealAfter": "final", "verified": true }
      ]
    },
    {
      "id": "kickers", "title": "The kickers", "assignable": true,
      "tags": ["numbers", "pressure"],
      "players": [ { "name": "Harrison Butker", "team": "KC", "position": "kicker", "pbpNames": ["H.Butker"] } ],
      "facts": [
        { "text": "Harrison Butker is Kansas City's kicker.", "revealAfter": null, "verified": true },
        { "text": "Butker kicked the go-ahead 27-yard field goal, leaving 8 seconds on the clock.", "revealAfter": "butker-fg", "verified": true }
      ]
    },
    {
      "id": "the-call", "title": "The call", "assignable": false,
      "tags": ["drama"],
      "players": [ { "name": "James Bradberry", "team": "PHI", "position": "cornerback", "pbpNames": ["J.Bradberry"] } ],
      "facts": [
        { "text": "With the game tied and under two minutes left, Bradberry was called for defensive holding on 3rd and 8.", "revealAfter": "bradberry-flag", "verified": true },
        { "text": "After the game Bradberry said: \"It was a holding. I tugged his jersey. I was hoping they would let it slide.\"", "revealAfter": "bradberry-flag", "verified": true }
      ]
    }
  ]
}
```

A storyline player's play is a **notable involvement** when they score, gain ≥ 15 yards, return a kick ≥ 20 yards, commit or suffer a turnover, attempt a field goal, or commit an accepted penalty (after its announcement).

### 6.8 Presets: `data/presets/game1.json`, `game4.json`

Knowledge maps applied to learners **in join order** (slot 1, 2, 3…). `game1`: everything New. `game4`: slot 1 is Mastered on the basics, `touchdown`, `extra_point`, `field_goal`, `punt`, `holding_offensive`, `false_start`, and Familiar on `holding_defensive`, `pass_interference_defensive`, `automatic_first_down`, `two_point_conversion`, `fourth_down_decision`, `running_out_the_clock`; slot 2 is Familiar on the basics, `touchdown`, `field_goal`, `punt`, and Seen on `holding_defensive`, `two_point_conversion`, `extra_point`; slot 3+ is Seen on the basics. Tune `game4` (never the thresholds) until `simulate` shows at least 50% fewer Huddle-spoken lines than `game1` over the demo segments. When a preset is active, the TV shows a small label "Simulated: Game 4 knowledge", and knowledge is not saved to the family file.

---

## 7. Game engine (Phase 2)

### 7.1 Clock

`server/room/clock.ts`: a `Clock` interface (`now()`, `setTimeout`, `clearTimeout`) with a real implementation and a `VirtualClock` for tests, `simulate` and `smoke`, which advances instantly. Everything time-based uses the injected clock.

### 7.2 `GameSource` and `ReplayEngine`

`GameSource` is an interface that emits engine events. `ReplayEngine` implements it from a timeline; a future live source (screen capture) would implement the same interface. Events:

```ts
type EngineEvent =
  | { type: 'pre_snap'; play: TimelinePlay }                // situation visible, result hidden
  | { type: 'snap'; play: TimelinePlay }
  | { type: 'play_result'; play: TimelinePlay }             // result visible; penalty hidden
  | { type: 'flag'; play: TimelinePlay }
  | { type: 'penalty_announced'; play: TimelinePlay }
  | { type: 'dead_time'; play: TimelinePlay }
  | { type: 'summary'; text: string; skipped: number }      // condensed mode
  | { type: 'halftime' } | { type: 'final' };
```

Per-play sequence: `pre_snap` → (decision: wait for the Predict window) → `snap` → `play_result` (with the field animation). If the play has a flag: `flag` → wait for the Call It window → `penalty_announced` (after `announceMs`). Pre-snap penalties skip the animation: show "Whistle. Flag before the snap." → `flag` → … Then `dead_time`, during which the Director may act; the engine waits for the Director and any take-it, handoff, or feedback window to finish, then moves on.

Pacing constants in `shared/constants.ts`:

```ts
export const PACING = {
  gameNight: { preSnapMs: 5000, playMs: 3500, postPlayMs: 4000, announceMs: 3500, summaryMs: 3000, halftimeMs: 12000 },
  demo:      { preSnapMs: 2500, playMs: 2500, postPlayMs: 2500, announceMs: 2500, summaryMs: 2000, halftimeMs: 5000 },
};
export const WINDOWS = { predictMs: 12000, callItMs: 15000, takeItMs: 4000, handoffMs: 6000, humanExplainMaxMs: 20000, feedbackMs: 8000 };
```
Tune `gameNight` so a condensed Super Bowl LVII lasts 20–30 minutes; `simulate` prints the estimate.

Modes: `full` (every play), `condensed` (notable plays only; between them emit `summary` such as "Kansas City drove 38 yards in 6 plays"), `demo` (segments only). Host controls: play, pause, next play, jump to a moment or segment, change mode, and change pacing. Jumping resets the scorebug and field to the state before that play and keeps family points.

### 7.3 Predict (`server/game/predict.ts`)

- `fourth_down`: question "4th & {ydstogo} at the {TEAM yardline}. What will {Team} do?" Options: Go for it / Punt / Kick a field goal (omit the field goal when `yardline100 > 45`). Resolve: pass or run → go for it; punt → punt; field_goal → field goal.
- `two_point`: "Two-point try. Will {Team} get in?" Yes / No. Resolve from `twoPoint`.
- `field_goal`: "{distance}-yard field goal. Good?" Good / No good. Resolve from `fieldGoal`.
- A play wiped out by an accepted pre-snap or no-play penalty **voids** the prediction ("No play. Prediction voided.").
- Everyone may answer, fan included. The TV shows who has locked in, never what they picked. Early lock-in doesn't close the window unless all connected players have answered.

### 7.4 Call It (`server/game/callit.ts`)

On every flagged play, build four options: the correct concept plus three distractors, shuffled with a seeded RNG (seed = play idx). The LLM chooses distractors (section 10); validate that there are 3, they're distinct, they're in the catalog, and none equals the correct concept; otherwise use the fallback table:

- preSnap: false_start, offside, neutral_zone_infraction, encroachment, delay_of_game, illegal_formation, illegal_shift
- pass: pass_interference_defensive, holding_defensive, illegal_contact, pass_interference_offensive, holding_offensive, roughing_the_passer, intentional_grounding
- run: holding_offensive, face_mask, unnecessary_roughness, illegal_block_in_the_back, holding_defensive, tripping
- kick: illegal_block_in_the_back, holding_offensive, roughing_the_kicker, running_into_the_kicker, fair_catch_interference, face_mask
- other: holding_offensive, unnecessary_roughness, unsportsmanlike_conduct, face_mask

For `penalty_other`, the correct option label is the raw penalty name. For declined or offsetting penalties, still play Call It on the first listed penalty; the announcement states the status. In replay mode, prefetch distractors one play ahead, held server-side.

### 7.5 Scoring (`server/game/scoring.ts`)

Predict correct +100, plus 50 if fewer than half of the players who answered picked it. Call It correct +150, plus 25 for the earliest correct lock-in. Completing a handoff or "I got this" explanation: learners +100; fan +0 (tracked as "assists"). **Fan handicap** (default on): the fan's Predict and Call It points are halved. Ties are broken by correct Call Its.

### 7.6 Knowledge (`server/game/knowledge.ts`)

Per learner per concept: `{ exposures, recalls, explainedToRoom }` → level:
- **New**: 0 exposures and 0 recalls.
- **Seen**: ≥ 1 exposure.
- **Familiar**: ≥ 2 exposures, or ≥ 1 recall.
- **Mastered**: (≥ 3 exposures and ≥ 1 recall) or ≥ 2 recalls or `explainedToRoom`.

An **exposure** happens to every connected learner when the concept is explained (by Huddle or a person). A **recall** is a correct Call It on that penalty concept, or completing a handoff on that concept. The fan has no knowledge map. **Room level** for a concept = the lowest level among connected learners.

### 7.7 Season memory (`server/persistence/families.ts`)

`data/families/<slug>.json`: `{ familyName, players: { [lowercaseName]: { knowledge, lifetimePoints, games } }, games: [{ gameId, date }] }`. When a room has a family name, a player who joins with a known name gets their saved knowledge. Save on knowledge change (debounced 2 s) and at the end of the game, except while a preset is active.

---

## 8. Director (Phase 3 for templates, Phase 5 for the LLM)

### 8.1 Scheduler (`server/director/scheduler.ts`), deterministic

Runs on `dead_time`, `penalty_announced`, a decision result, quarter breaks and halftime.

1. **Candidates**: the play's tagged concepts where the room level is below Mastered. Keep the top 3 by priority. After `penalty_announced`, the penalty concept is always the first candidate.
2. **Budget** by talkativeness:
   - `quiet`: only after `penalty_announced` and decision results.
   - `normal`: ≤ 6 Huddle explanations per quarter, not counting those after `penalty_announced` or decision results; ≥ 20 s between any two spoken lines.
   - `chatty`: ≤ 1 per 2 plays; ≥ 12 s between spoken lines.
3. Never speak while a Predict, Call It, take-it, handoff, or feedback window is open.
4. **Handoff candidates**: connected learners whose level for a candidate concept is Familiar or Mastered, when another connected learner is below them on it.
5. If there are no candidates or no budget, stay silent without calling the LLM.
6. **Depth**: room level New → `full`; Seen or Familiar → `short`.

### 8.2 Director turn (`server/director/director.ts`)

Calls the LLM (section 10) with the event, situation, public play text, candidates (with rule cards and room level), handoff candidates, unlocked storyline facts for players involved in the play, the last 5 spoken lines, and the budget. It returns `silent | explain | handoff`. Validate that `conceptId` is a candidate, `handoffTo` is a handoff candidate, and word limits hold (`full` ≤ 28 words, `short` ≤ 12); if not, use the template. **Template fallback**: explain the top candidate, using `full` or `short` from its card, with `cheat` = `short`. Prefer a handoff when one exists for that concept.

### 8.3 Flows after the Director decides

- **explain**: if a fan is connected, send them "Take it?" with the card title and cheat line (`takeItMs`). If they accept, the TV shows "{Fan} is explaining" with the caption card and nothing is spoken; the fan taps Done (or `humanExplainMaxMs` passes); learners then get Got it / Still confused (`feedbackMs`), and any "Still confused" makes Huddle speak the `short` version. If the fan declines or doesn't answer, Huddle speaks the line and shows the card. Either way every connected learner gets one exposure.
- **handoff**: the chosen learner's phone shows "You know this one. Explain {concept name} to {other names}?" with the cheat line: I'll explain / Pass (`handoffMs`). On accept, the same human-explain flow runs, and the learner gets `explainedToRoom` and +100. On pass or timeout, Huddle speaks the `short` version.
- **Storyline beat**: on a notable involvement of a learner's storyline player (and, for penalties, only after the announcement): TV card "{Name}'s player: …", a buzz on that learner's phone, and a spoken line that starts with their name. At most one beat per learner per quarter. Beats respect the minimum gap but don't count toward the explanation budget.
- **Halftime**: TV card with the score, unlocked game facts, and the family scoreboard, spoken briefly.

---

## 9. Server, rooms, and messages (Phase 3)

### 9.1 HTTP (`server/http.ts`)

- `GET /api/games` → `data/games/index.json`.
- `POST /api/rooms` `{ familyName?, gameId, mode, pacing, talkativeness, voice, fanHandicap }` → `{ code, hostToken }`. Codes are 4 letters without I, O, or L.
- `GET /api/lan` → `{ phoneUrlBase }`, using `PUBLIC_HOST` or the first non-internal IPv4 address, port 5173 in dev and 8787 in prod.
- P1: `POST /api/vision/scorebug`, `GET` and `PUT /api/games/:id/video-sync`.
- In prod, serve `dist/web` with an SPA fallback.

### 9.2 Socket events (types in `shared/types.ts`)

Client → server:
`tv:join { code, hostToken? }` · `tv:spoken { lineId }` · `host:control { action: 'start_profiles' | 'start_game' | 'play' | 'pause' | 'next' | 'jump' | 'mode' | 'pacing' | 'talkativeness' | 'voice' | 'preset' | 'reroll_storyline', value? }` ·
`player:join { code, name, color, playerId? }` · `player:profile { answers }` · `player:answer { promptId, optionId }` · `player:takeit { promptId, accept }` · `player:handoff { promptId, accept }` · `player:done { promptId }` · `player:feedback { promptId, value: 'got_it' | 'confused' }`.

Server → client:
`room:snapshot RoomSnapshot` (TV sockets) · `player:view PlayerView` (each player socket, personalized) · `tv:speak { lineId, text, priority }` · `host:ailog AiLogEntry[]` (host TV only).

Broadcast snapshots on every state change, debounced to 50 ms. A `Transport` abstraction wraps socket.io so tests and `simulate` can record every outgoing message.

```ts
type RoomSnapshot = {
  code: string;
  phase: 'lobby' | 'profiles' | 'storylines' | 'live' | 'halftime' | 'final' | 'recap';
  settings: Settings; game: { id: string; title: string; home: TeamInfo; away: TeamInfo };
  players: { id: string; name: string; color: string; role: 'fan' | 'learner'; connected: boolean; points: number; profileDone: boolean; lockedIn: boolean }[];
  scorebug: { qtr: number; clock: string; home: number; away: number; possession: TeamSide | null; downDistance: string | null; ballOn: string | null; timeouts: { home: number; away: number } | null; flag: boolean; review: boolean } | null;
  field: { losAbs: number | null; firstDownAbs: number | null; ballAbs: number | null; possession: TeamSide | null; animateMs: number } | null;
  ticker: string | null;
  prompt: null | { id: string; kind: 'predict' | 'callit'; question: string; options: { id: string; label: string }[]; closesAt: number; reveal?: { correctOptionId: string; results: { playerId: string; correct: boolean; points: number }[] } };
  card: null | { id: string; kind: 'explain' | 'announcement' | 'storyline' | 'summary' | 'halftime' | 'human'; title: string; body: string; source?: string; by: string };
  storylines: { playerId: string; title: string; hook: string; watchFor: string }[];
  presetLabel: string | null;
  recap: FamilyRecap | null;
  demo: { segments: { id: string; label: string }[]; moments: { id: string; label: string }[]; idx: number; total: number; paused: boolean; mode: string; pacing: string };
};
```
`PlayerView` holds the player's own profile, points and rank, their storyline card, the active prompt (predict, callit, takeit, handoff, done, feedback) with `closesAt`, their last result, and their recap.

### 9.3 Room lifecycle

`lobby` → (host: start_profiles) `profiles` → when all learners are done, or the host continues, run storyline assignment → `storylines` (the TV reveals each card and speaks it; about 6 s each) → `live` → `halftime` → `live` → `final` → recap generation → `recap`. Rooms expire after 6 hours idle. Players reconnect by a stored `playerId` (localStorage on the phone, wrapped in try/catch).

### 9.4 Referee announcement

A template built from the play: "{Concept name}, {team city or name}{, player}. {yards} yards{, automatic first down}{. Replay {ordinal} down}." Declined: "{name} on {team}. Declined." Offsetting: "Offsetting fouls. Replay the down." Unknown types use the raw name.

### 9.5 Ticker (P0 version)

Clean `desc` by removing the leading "(m:ss)", formation tags such as "(Shotgun)" and "(No Huddle, Shotgun)", and everything from "PENALTY" onward (replaced with "Flag on the play."). After the announcement, the ticker shows the announcement. The P1 LLM version rewrites the cleaned text in plain English (section 10).

---

## 10. AI layer (Phase 5)

### 10.1 Client (`server/ai/llm.ts`)

```ts
json<T>(opts: {
  task: TaskName; model: 'smart' | 'fast' | 'vision';
  system: string; user: string; images?: string[];   // data: URLs
  schema: z.ZodType<T>; timeoutMs: number; temperature?: number; fallback: () => T;
}): Promise<{ value: T; source: 'llm' | 'cache' | 'fallback'; ms: number }>
```
- `openai` client with `baseURL` and `apiKey`; `response_format: { type: 'json_object' }`; `AbortSignal.timeout(timeoutMs)`. If the provider rejects `response_format` (for example with images), retry without it and extract the first JSON object from the text (strip code fences).
- One retry with the zod error appended when the JSON is invalid and time remains; otherwise `fallback()`.
- Cache in memory and in `data/cache/llm/<sha1>.json`, keyed by task, model, system, user and an image hash (`LLM_CACHE=on|off`).
- Concurrency limiter (`LLM_MAX_CONCURRENCY`) with priorities: callit and director > beat and storylines > ticker. On HTTP 429, use the fallback immediately and back off that task for 10 s.
- Log each call (task, source, ms) to the console and a 50-entry ring buffer sent to the host's AI log.
- Mock provider: return `fallback()` after 50–150 ms.

### 10.2 Jobs

| Task | Model | Timeout | Temperature |
|---|---|---|---|
| storylines | smart | 5000 | 0.7 |
| callit | fast (vision in P1 video mode) | 2500 | 0.3 |
| director | smart | 4000 | 0.4 |
| beat | fast | 3000 | 0.6 |
| recap | smart | 8000 | 0.7 |
| ticker (P1) | fast | 3000 | 0.2 |
| scorebug (P1) | vision | 2000 | 0 |

### 10.3 Prompts (`server/ai/prompts.ts`), used verbatim as system prompts

**storylines**
```
You match family members to storylines for an NFL game they are about to watch together. Most of them don't follow football.
Rules:
- Use only the storyline facts provided. Do not add facts, statistics, or anything about the game's result.
- Give each learner exactly one storyline id from the list. Give different learners different storylines when there are enough.
- Match on what each person told you: what they watch, favorite or underdog, and their vibe.
- For each learner write "hook" (at most 22 words, addressed to them by first name: who to watch and why it's interesting) and "watchFor" (at most 12 words: one concrete thing to look for during plays). You may describe what the player's position does in general terms.
Return JSON only: {"assignments":[{"playerId":"...","storylineId":"...","hook":"...","watchFor":"..."}]}
```

**callit**
```
You write wrong answer choices for a family guessing game. A flag was thrown on an NFL play, and the family will guess which penalty it was before the referee announces it.
You get the situation, what happened on the play (without the penalty), the correct penalty, and a catalog of penalty ids that fit this kind of play.
Choose exactly 3 wrong answers from the catalog that a newcomer could reasonably believe happened on this play. Never choose the correct penalty or a near-synonym of it. Prefer penalties that fit the play type (before the snap, pass, run, or kick).
Return JSON only: {"distractors":["id1","id2","id3"],"why":"at most 20 words, for logs"}
```
In P1 video mode, add to the user message: "A frame from the moment of the flag is attached. Use what is visible (whether the ball was in the air, whether it was a kick, where players are) to pick plausible wrong answers."

**director**
```
You are Huddle, a warm, quick co-host for a family watching an NFL game together on one TV. Most people in the room are new to football; one may be a fan.
You speak rarely, briefly, and only about what just happened. You help the room enjoy the game together; you are not a lecturer.

You receive the event, the game situation, a plain description of the play, up to 3 candidate concepts (each with a reviewed rule card and the room's level: new, seen, or familiar), people who could explain instead of you, facts about players in the play, what you said recently, and the talk budget.

Choose one action:
- "silent": nothing here is worth interrupting the room for. Silence is often right.
- "explain": explain one candidate concept.
- "handoff": offer a handoff candidate the chance to explain one candidate concept. Prefer this when a handoff candidate exists for the concept you would explain.

Writing rules:
- Use only facts from the rule card, the play, the situation, and the player facts given. Never add rule details, statistics, quotes, or player facts that are not provided.
- Connect the rule to this play in plain words.
- Room level "new": "spoken" at most 28 words, one idea. Level "seen" or "familiar": "spoken" at most 12 words.
- "card.title" at most 40 characters. "card.body" at most 280 characters; it may add one detail from the rule card (such as the yardage) or one provided player fact.
- "cheat": one line, at most 120 characters, that a person could read aloud to explain it.
- "fanNote": optional, at most 200 characters, a strategy note for the fan based only on the situation.
- Talk to the whole room. No jargon unless you define it in the same sentence. Never condescend. Don't open with "So" or "Great".
Return JSON only:
{"action":"silent|explain|handoff","conceptId":"...","spoken":"...","card":{"title":"...","body":"..."},"cheat":"...","handoffTo":"playerId","fanNote":"..."}
```

**beat**
```
Write one short line (at most 20 words) for the TV when a family member's storyline player makes a play. Address that family member by first name. Use only the play description and the facts provided. Return JSON only: {"line":"..."}
```

**recap**
```
Write a warm, playful post-game recap for a family who watched a game together. Stats are provided; never change a number or invent an event.
For each person: "headline" (at most 60 characters) and "bestMoment" (at most 140 characters, chosen from their log).
For the family: "title" (at most 60 characters), "momentOfTheNight" (at most 200 characters, chosen from the game log), and "nextTime" (at most 120 characters, a teaser to watch together again).
Return JSON only: {"people":[{"playerId":"...","headline":"...","bestMoment":"..."}],"family":{"title":"...","momentOfTheNight":"...","nextTime":"..."}}
```
Code computes all stats (points, rank, Predict and Call It records, explanations given, and concepts that reached Familiar or Mastered tonight) and assembles the group-chat text from the stats plus these fields.

**ticker (P1)**
```
Rewrite an official NFL play description as one plain-English sentence (at most 22 words) for someone new to football. Use last names and team names. Drop jargon like "Shotgun" or "short right". Write yard lines as words ("PHI 15" becomes "Philadelphia's 15-yard line"). If the text says "Flag on the play", keep that and say nothing about which penalty. Return JSON only: {"text":"..."}
```

**scorebug (P1, vision)**
```
You read the score graphic (the "scorebug") in a frame from an NFL broadcast. Report only what you can read; use null for anything not visible. Do not guess. Broadcast scorebugs often show a yellow "FLAG" box when a penalty flag has been thrown.
Return JSON only: {"visible":true,"awayTeam":null,"homeTeam":null,"awayScore":null,"homeScore":null,"quarter":null,"clock":null,"down":null,"distance":null,"flag":false,"replayReview":false,"confidence":0.0}
```

### 10.4 Storyline assignment fallback

Score each assignable storyline by tag overlap with the learner's answers, then assign greedily without repeats:
- What they watch: reality and competition → drama, chaos · dramas → drama, family, relationships · documentaries and true crime → numbers, underdog · comedies → chaos · music and pop culture → star · sports → numbers, star.
- Favorite → favorite, star · underdog → underdog, comeback.
- Vibe: drama → drama, family · numbers → numbers, pressure · chaos → chaos, comeback.

Template hook: "{Name}, watch {storyline title}. {first pregame-safe fact}"; watchFor: "{player name}, the {position}."

---

## 11. Web app (Phase 4)

### 11.1 Look

A "stadium night" identity: dark and high-contrast, readable from a couch.

```css
--bg: #0B120E; --surface: #111B15; --surface-2: #17241C; --line: #24332A;
--chalk: #F2F5EF; --muted: #9FB0A5; --turf: #1D4D2E; --turf-stripe: #1F5532;
--flag: #F5C518; --los: #3D8BFF; --good: #3DDC84; --bad: #FF6B6B;
--display: "Big Shoulders Display", "Arial Narrow", sans-serif;   /* headings, scorebug, numbers */
--body: "IBM Plex Sans", system-ui, sans-serif;
--mono: "IBM Plex Mono", ui-monospace, monospace;               /* data, sources */
```
Load the fonts from Google Fonts in `web/index.html` (Big Shoulders Display 700/800, IBM Plex Sans 400/500/600, IBM Plex Mono 500), with fallbacks so the app still works offline. `shared/teams.ts` holds all 32 teams: abbreviation, city, name, primary and secondary colors. No logos. TV text is at least 24px at 1080p; phone text at least 18px; phone buttons at least 64px tall. Respect `prefers-reduced-motion`.

### 11.2 Host setup (`/`)

Form: family name (optional), game (from `/api/games`), mode (Condensed by default, Full, Demo moments), pacing (Game night, Demo), talkativeness (Normal), voice on, fan handicap on. "Create room" → navigate to `/tv/{code}?host={hostToken}` (also stored in sessionStorage).

### 11.3 Shared screen (`/tv/:code`)

- **Start overlay**: "Start Huddle" button (required so the browser allows speech). Then join as TV.
- **Lobby**: a huge room code, a QR code for `{phoneUrlBase}/play/{code}`, joined players as colored initials, and "Press Enter to start".
- **Profiles**: players with checkmarks as they finish.
- **Storylines**: cards revealed one by one and spoken.
- **Live** (layout for 1920×1080, down to 1280×720): scorebug across the top; field on the left; a 420px rail on the right with the family scoreboard (sorted), the current caption card, and storyline chips; ticker along the bottom. Prompt overlay over the field: question, option tiles, a countdown ring, and player avatars that lock as people answer. On reveal, the correct tile turns `--good`, correct avatars bounce once, and "+150" floats up.
- **Field** (SVG, viewBox 0 0 1200 560): 10 px per yard; end zones in team colors at 35% opacity with the team abbreviation; yard lines every 5, numbers every 10, hash marks; line of scrimmage in `--los` (3px); first-down line in `--flag` (4px, soft glow); the ball as a brown ellipse with a lace line, animated to `ballAbs` over `animateMs`; a possession arrow in the team color. The first time the yellow line appears, label it "yellow line = first down".
- **Scorebug**: team abbreviations with color chips and scores, quarter and clock, a down-and-distance pill ("3rd & 8"), ball on ("PHI 15"), three timeout pips per team, a FLAG pill (`--flag`) during the flag window, and a REVIEW pill.
- **Caption card**: title in the display face, body at 24px, and a source line in mono, for example "Rule card · Defensive holding · 5 yards + automatic first down". Every spoken line appears here.
- **Halftime, final, and recap** screens.
- **Host dock** (toggle with H): play/pause, next, mode, pacing, talkativeness, voice, preset (Game 1 / Game 4), a moment and segment jump list, and the AI log (task · source · ms).
- **Hotkeys**: Space play/pause · N next play · 1–9 jump to segment · J jump list · M mute · T cycle talkativeness · G toggle the Game 4 preset · H host dock · Enter to advance lobby, profiles and storylines.
- **Speech** (`web/src/lib/tts.ts`): `speechSynthesis`, choosing the first available of "Google US English", "Samantha", "Microsoft Aria Online (Natural)", then any en-US voice; rate 1.05. Speak one line at a time, drop queued lines of lower priority, and emit `tv:spoken` when done. If speech isn't available, estimate duration at 2.6 words per second.

### 11.4 Phone (`/play/:code`)

Screens: Join (name and six color swatches) → Profile (three questions as big tap cards, plus "I already know football" to become the fan) → Waiting ("Eyes on the TV", your points and rank, your storyline card collapsed) → prompts one at a time: Predict and Call It (big stacked buttons, lock on tap, countdown bar), Take it? (cheat line, Take it / Not now), Handoff (cheat line, I'll explain / Pass), Done button while explaining, Got it / Still confused → result flash (green or red tint for 1.2 s and "+150") → Recap (your card, the family card, and "Copy for group chat", which calls `navigator.clipboard.writeText` inside the click handler and falls back to a selectable textarea). Buzz with `navigator.vibrate?.(30)` when a prompt opens. Respect safe-area insets.

Profile questions, exactly:
1. "What do you usually watch?" Reality and competition shows · Dramas · Documentaries and true crime · Comedies · Music and pop culture · Sports
2. "Root for the favorite or the underdog?" Favorite · Underdog
3. "Pick a vibe." Drama · Numbers · Chaos

---

## 12. P1 features (only after the P0 checklist passes, in this order)

1. **Plain-English ticker**: LLM rewrite of `publicDesc`, cached and prefetched one play ahead, with a spoiler-safe input.
2. **Vision lab** (`/lab/vision`): upload any broadcast screenshot → `POST /api/vision/scorebug` (the client downscales to 768px wide, JPEG quality 0.7) → show the extracted JSON beside the image.
3. **Video mode**: host setup accepts a local video file (object URL; never uploaded or committed). The TV shows the video in place of the field, with the rail. `data/games/<id>/video_sync.json` maps play idx → video seconds, and the engine follows the video time.
4. **Sync tool** (`/sync/:gameId`): video on the left, play list on the right; Space records the current time as the selected play's snap and moves to the next play; Save writes via `PUT /api/games/:id/video-sync`.
5. **Vision in video mode**: every 2 s and at each flag, capture a frame and run the scorebug reader; show a "Huddle sees: 3rd & 8 · 1:54 Q4 · FLAG" chip in the host dock, with a warning when it disagrees with the timeline. Include the flag frame in the Call It distractor call.

Out of scope for this build (keep the `GameSource` interface ready for it): live screen-capture mode with speech-to-text, remote families, other sports.

---

## 13. Tests and verification

Write `data/fixtures/mini_game.json`, a hand-written ~16-play timeline covering: a normal drive, a first down, 3rd down, a 4th-down punt, a 4th-down go-for-it, a touchdown plus extra point, a 2-point try, a field goal, an accepted defensive holding with automatic first down, a declined penalty, a pre-snap false start, an incomplete pass, and a coach's challenge.

Unit tests (vitest):
- `tagger.test.ts`: each fixture play gets the expected concepts; `running_out_the_clock` fires on the late penalty case.
- `predict.test.ts`: every decision kind resolves correctly; a no-play penalty voids it.
- `callit.test.ts`: the correct option is always among 4 distinct catalog options; junk LLM output falls back to the table; the options are identical for the same seed.
- `scoring.test.ts`: points, the contrarian bonus, the first-correct bonus, the fan handicap, tie-breaks.
- `knowledge.test.ts`: every level threshold; room level; handoff candidate selection.
- `scheduler.test.ts`: budgets for each talkativeness; the minimum gap; no speech while a window is open; silence when everything is Mastered.
- `engine.test.ts`: event order for a normal play, a flagged play, and a pre-snap flag; `penalty_announced` never comes before the Call It window closes.
- **`spoilers.test.ts`**: run the full Super Bowl LVII timeline through a room with the `VirtualClock`, the mock LLM, a recording transport, and 3 bot players. For every flagged play, assert that no outgoing message, TTS text, or non-callit LLM input produced before its `penalty_announced` contains the penalty's raw type, concept id, or concept name; that no play result is sent before its snap; and that no storyline fact appears before its `revealAfter` moment.

`npm run simulate` (VirtualClock, mock LLM unless `--llm`, 1 fan and 3 learner bots with 40/60/80% accuracy; the fan accepts "Take it?" 50% of the time; learners accept handoffs 70% of the time):
- Runs the full game in condensed mode for each talkativeness and prints: plays shown, the estimated real-time duration with `gameNight` pacing, Predict and Call It rounds, Huddle-spoken lines per quarter, take-its and handoffs offered and accepted, and the final scoreboard. It asserts the budgets and that a recap was produced.
- Runs the demo segments with the `game1` preset and then the `game4` preset, prints spoken lines for each, and asserts a reduction of at least 50%.

`npm run smoke`: start the real server on a free port with the mock LLM and demo pacing sped up 20×, connect one TV and three phones with `socket.io-client`, go through lobby, profiles and storylines, play segment C, and assert: the Call It prompt opens on the Bradberry flag with four options; the TV card shows the announcement only after the window closes; a Director explanation or handoff follows; the scoreboard changes; `final` and `recap` are reached after jumping to the end. Exit non-zero on failure.

If Playwright with Chromium is available, also take screenshots of `/tv` (live, during a Call It) and `/play` (Call It prompt) into `docs/` and use them in the README. Skip this silently if it isn't available.

---

## 14. Build order

1. **Scaffold**: confirm `CLAUDE.md` and `docs/PRD.md` exist and read the PRD (section 0). Then package.json, tsconfig, Vite config and proxy, tokens and base CSS, `.env.example`, `.gitignore`, a README skeleton with the PRD traceability table (every F1–F13 row, status "not started"), and `DECISIONS.md` with two headings: "Decisions" and "PRD deviations". Check: `npm run typecheck` and `npm run dev` start. Commit, including the team's three files.
2. **Data**: `fetch-game`, penalties map, tagger, concepts, storylines, presets, fixture. Run it for Super Bowl LVII and commit the processed files. Check: validations pass; tagger tests pass. Commit.
3. **Engine and rules**: clock, ReplayEngine, condense, predict, callit, scoring, knowledge, and their unit tests. Commit.
4. **Server and Director (templates)**: rooms, transport, sockets, scheduler, Director with the mock LLM, storylines fallback, recap fallback, season memory, `simulate`. Check: tests and `simulate` pass. Commit.
5. **Web**: host setup, TV (every screen and component in 11.3), phone (every screen in 11.4), speech, hotkeys, host dock. Check: `npm run build`; `smoke`. Commit.
6. **Real AI**: LLM client, limiter, cache, prompts, schemas, validation, the AI log. Check: everything still passes in mock mode. If `LLM_API_KEY` is set in the environment, run `simulate --llm` on segment C and print sample outputs. Commit.
7. **Demo polish**: segments and jump list, presets and label, condensed summaries, halftime, recap and copy text, the spoilers test. Check: the full P0 checklist. Commit.
8. **P1 features** in the order of section 12, committing after each.
9. **README**: what Huddle is, with a link to `docs/PRD.md`; the PRD traceability table, complete; setup (Node version, `npm install`, `npm run fetch-game`, `.env`); running (`npm run dev`, open `/` on the laptop, put `/tv` on the TV, phones on the same Wi-Fi scan the QR; if phones can't connect, allow port 5173 through the firewall or use the laptop's hotspot); switching providers and models; the demo guide (segments, hotkeys, presets, recording tips); a section asking the team to review `data/concepts.json` and `storylines.json` (set `reviewed`/`verified`) before demoing; the architecture; what is real vs. prepared in the demo; troubleshooting (no voices, model 404, 429 rate limits). Final commit.

---

## 15. P0 checklist (all must be true before P1)

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `npm run simulate` and `npm run smoke` pass with `LLM_PROVIDER=mock`.
- [ ] `data/games/2022_22_KC_PHI/` holds the timeline, moments with every required key, and storylines; the final score validates as 38–35.
- [ ] A room can be created; the TV shows a code and QR; phones join, answer the profile, and get storyline cards with no spoilers.
- [ ] Condensed mode plays the whole game (estimated 20–30 minutes at `gameNight` pacing) through halftime, final, and recap.
- [ ] Every decision play opens Predict; every flagged play opens Call It with 4 options; results score correctly.
- [ ] The Director explains, hands off, or stays silent within budget; "Take it?", handoff, and feedback flows all work; mute works.
- [ ] The Game 4 preset produces at least 50% fewer Huddle-spoken lines over the demo segments, and the TV labels it.
- [ ] The spoilers test passes.
- [ ] Segment hotkeys 1–3 jump to the Toney return, the 2-point try, and the Bradberry flag.
- [ ] The README explains setup, the demo, and the team's review steps.
- [ ] Every P0 acceptance criterion in PRD section 7 (F1–F10) is met, and the README traceability table names the test, script output, or manual step that shows it. Criteria that need a human (for example "five phones join in under 60 seconds") are listed as manual checks for the team.
- [ ] `DECISIONS.md` lists every PRD deviation, or says there are none.
