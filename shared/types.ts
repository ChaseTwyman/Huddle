// Shared types for server, web, scripts and tests.

export type TeamSide = 'home' | 'away';

export type PlayKind =
  | 'pass' | 'run' | 'punt' | 'field_goal' | 'extra_point' | 'two_point' | 'kickoff'
  | 'kneel' | 'spike' | 'timeout' | 'penalty_only' | 'end_of_period' | 'other';

export type TimelinePlay = {
  idx: number; playId: number; qtr: number; clock: string; gameSecondsRemaining: number;
  posteam: string | null; defteam: string | null;
  down: 1 | 2 | 3 | 4 | null; ydstogo: number | null; yardline100: number | null; goalToGo: boolean;
  scoreBefore: { home: number; away: number }; scoreAfter: { home: number; away: number };
  timeoutsBefore: { home: number; away: number } | null;
  kind: PlayKind;
  /** Official text. SERVER ONLY (contains spoilers). */
  desc: string;
  /** Cleaned text with any penalty clause removed. */
  publicDesc: string;
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
    announcement: string;
  };
  challenge: null | { result: string };
  wp?: number; wpa?: number;
  decision: null | { kind: 'fourth_down' | 'two_point' | 'field_goal' };
  /** Tagged concept ids, highest priority first. */
  concepts: string[];
  momentKeys: string[];
  notable: boolean;
  field: { losAbs: number | null; firstDownAbs: number | null; ballEndAbs: number | null };
};

export type Timeline = {
  gameId: string; title: string; date: string;
  home: string; away: string;
  finalScore: { home: number; away: number };
  plays: TimelinePlay[];
};

export type ConceptCategory = 'basics' | 'scoring' | 'decision' | 'clock' | 'review' | 'result' | 'penalty';

export type Concept = {
  id: string; name: string;
  category: ConceptCategory;
  priority: number;
  short: string;
  full: string;
  detail?: string;
  yards?: string; autoFirstDown?: boolean;
  preSnap?: boolean;
  reviewed: false | true;
};

/** label includes features (server/logs only); publicLabel is spoiler-free (sent to the TV jump list). */
export type Moment = { id: string; idx: number; label: string; publicLabel: string; qtr: number; clock: string; features: string[] };
export type Segment = { id: string; label: string; startIdx: number; endIdx: number };
export type MomentsFile = { moments: Moment[]; segments: Segment[]; keys: Record<string, number> };

export type GameIndexEntry = { id: string; title: string; date: string; home: string; away: string; finalScore: { home: number; away: number } };

// Storylines
export type StoryFact = { text: string; revealAfter: string | null; verified: boolean };
export type StoryPlayer = { name: string; team: string; position: string; pbpNames: string[] };
export type Storyline = { id: string; title: string; assignable: boolean; tags: string[]; players: StoryPlayer[]; facts: StoryFact[] };
export type StorylinesFile = { gameFacts: StoryFact[]; storylines: Storyline[] };

// Engine
export type EngineEvent =
  | { type: 'pre_snap'; play: TimelinePlay }
  | { type: 'snap'; play: TimelinePlay }
  | { type: 'play_result'; play: TimelinePlay }
  | { type: 'flag'; play: TimelinePlay }
  | { type: 'penalty_announced'; play: TimelinePlay }
  | { type: 'dead_time'; play: TimelinePlay }
  | { type: 'summary'; text: string; skipped: number }
  | { type: 'halftime' } | { type: 'final' };

// Settings
export type Mode = 'full' | 'condensed' | 'demo';
export type Pacing = 'gameNight' | 'demo';
export type Talkativeness = 'quiet' | 'normal' | 'chatty';
export type Settings = {
  familyName: string | null;
  gameId: string;
  mode: Mode;
  pacing: Pacing;
  talkativeness: Talkativeness;
  voice: boolean;
  fanHandicap: boolean;
};

export type TeamInfo = { abbr: string; city: string; name: string; primary: string; secondary: string };

export type KnowledgeLevel = 'new' | 'seen' | 'familiar' | 'mastered';
export type KnowledgeEntry = { exposures: number; recalls: number; explainedToRoom: boolean };
export type KnowledgeMap = Record<string, KnowledgeEntry>;

export type ProfileAnswers = {
  watch: 'reality' | 'dramas' | 'documentaries' | 'comedies' | 'music' | 'sports';
  rootFor: 'favorite' | 'underdog';
  vibe: 'drama' | 'numbers' | 'chaos';
  fan?: boolean;
};

export type PromptOption = { id: string; label: string };

export type SnapshotPrompt = {
  id: string; kind: 'predict' | 'callit'; question: string; options: PromptOption[]; closesAt: number;
  reveal?: { correctOptionId: string; results: { playerId: string; correct: boolean; points: number }[] };
  voided?: boolean;
};

export type SnapshotCard = {
  id: string; kind: 'explain' | 'announcement' | 'storyline' | 'summary' | 'halftime' | 'human';
  title: string; body: string; source?: string; by: string;
};

export type PersonRecap = {
  playerId: string; name: string; color: string; role: 'fan' | 'learner';
  points: number; rank: number;
  predict: { correct: number; total: number };
  callIt: { correct: number; total: number };
  explanationsGiven: number;
  learnedTonight: string[]; // concept names reaching familiar or mastered tonight
  rulesKnown: number;
  headline: string; bestMoment: string;
};

export type FamilyRecap = {
  title: string; momentOfTheNight: string; nextTime: string;
  finalScore: string;
  people: PersonRecap[];
  groupChatText: string;
  source: 'llm' | 'cache' | 'fallback';
};

export type RoomPhase = 'lobby' | 'profiles' | 'storylines' | 'live' | 'halftime' | 'final' | 'recap';

export type RoomSnapshot = {
  code: string;
  phase: RoomPhase;
  settings: Settings;
  game: { id: string; title: string; home: TeamInfo; away: TeamInfo };
  players: { id: string; name: string; color: string; role: 'fan' | 'learner'; connected: boolean; points: number; profileDone: boolean; lockedIn: boolean }[];
  scorebug: {
    qtr: number; clock: string; home: number; away: number; possession: TeamSide | null;
    downDistance: string | null; ballOn: string | null; timeouts: { home: number; away: number } | null;
    flag: boolean; review: boolean;
  } | null;
  field: { losAbs: number | null; firstDownAbs: number | null; ballAbs: number | null; possession: TeamSide | null; animateMs: number } | null;
  ticker: string | null;
  prompt: SnapshotPrompt | null;
  card: SnapshotCard | null;
  storylines: { playerId: string; title: string; hook: string; watchFor: string }[];
  storylineReveal: number; // how many storyline cards the TV has revealed (storylines phase)
  presetLabel: string | null;
  recap: FamilyRecap | null;
  halftime: { score: string; facts: string[] } | null;
  explaining: { playerId: string; name: string } | null;
  demo: {
    segments: { id: string; label: string }[]; moments: { id: string; label: string }[];
    idx: number; total: number; paused: boolean; mode: string; pacing: string;
  };
  status: string | null; // short engine status line, e.g. "Whistle. Flag before the snap."
};

export type PlayerPrompt =
  | { id: string; kind: 'predict' | 'callit'; question: string; options: PromptOption[]; closesAt: number; lockedOptionId: string | null }
  | { id: string; kind: 'takeit'; title: string; cheat: string; closesAt: number }
  | { id: string; kind: 'handoff'; title: string; cheat: string; others: string; closesAt: number }
  | { id: string; kind: 'done'; title: string; cheat: string; closesAt: number }
  | { id: string; kind: 'feedback'; title: string; by: string; closesAt: number };

export type PlayerView = {
  code: string;
  phase: RoomPhase;
  me: { id: string; name: string; color: string; role: 'fan' | 'learner'; profileDone: boolean; points: number; rank: number; profile: ProfileAnswers | null };
  storyline: { title: string; hook: string; watchFor: string } | null;
  prompt: PlayerPrompt | null;
  lastResult: { id: string; correct: boolean; points: number; label: string } | null;
  buzz: { id: string; text: string } | null;
  recap: { me: PersonRecap | null; family: FamilyRecap } | null;
};

export type AiLogEntry = { at: number; task: string; source: 'llm' | 'cache' | 'fallback'; ms: number; note?: string };

export type HostAction =
  | 'start_profiles' | 'start_game' | 'play' | 'pause' | 'next' | 'jump' | 'mode' | 'pacing'
  | 'talkativeness' | 'voice' | 'preset' | 'reroll_storyline' | 'advance' | 'set_role';

// Socket payloads
export type ClientToServer = {
  'tv:join': (p: { code: string; hostToken?: string }, ack?: (r: { ok: boolean; error?: string; host?: boolean }) => void) => void;
  'tv:spoken': (p: { lineId: string }) => void;
  'host:control': (p: { action: HostAction; value?: unknown }) => void;
  'player:join': (p: { code: string; name: string; color: string; playerId?: string }, ack?: (r: { ok: boolean; error?: string; playerId?: string }) => void) => void;
  'player:profile': (p: { answers: ProfileAnswers }) => void;
  'player:answer': (p: { promptId: string; optionId: string }) => void;
  'player:takeit': (p: { promptId: string; accept: boolean }) => void;
  'player:handoff': (p: { promptId: string; accept: boolean }) => void;
  'player:done': (p: { promptId: string }) => void;
  'player:feedback': (p: { promptId: string; value: 'got_it' | 'confused' }) => void;
};

export type SpeakLine = { lineId: string; text: string; priority: number };

export type ServerToClient = {
  'room:snapshot': (s: RoomSnapshot) => void;
  'player:view': (v: PlayerView) => void;
  'tv:speak': (l: SpeakLine) => void;
  'tv:mute': (p: { muted: boolean }) => void;
  'host:ailog': (log: AiLogEntry[]) => void;
};
