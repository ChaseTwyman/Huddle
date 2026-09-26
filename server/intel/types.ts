/**
 * Game intelligence: the grounded context the Director draws on beyond rule cards.
 * Two producers (situational numbers computed from the play data, and a per-game knowledge base of sourced
 * player/team facts) and one consumer (the Director). Every fact has a stable id; the Director must cite the
 * ids it used, and anything uncited is rejected.
 */

export type IntelKind =
  | 'win_prob'      // win probability now / swing on the last play
  | 'decision'      // 4th-down / 2-pt / FG math: what the numbers say vs. what the coach did
  | 'drive'         // this drive so far
  | 'game_stat'     // player or team stats in this game so far
  | 'tendency'      // team tendency in this game (3rd-down rate, run/pass split)
  | 'bio'           // player background (college, draft, trade, hometown, family)
  | 'career'        // career / season stats and milestones before this game
  | 'matchup'       // history vs. this opponent / this defender
  | 'rivalry'       // documented feud or storyline between players/teams
  | 'team';         // team history / season context before this game

export type IntelFact = {
  id: string;            // stable within a room, e.g. "sit:wp:123" or "kb:mahomes:4"
  kind: IntelKind;
  text: string;          // one plain sentence, safe to say aloud
  about: string[];       // entity keys: team abbrs ("KC") and player keys ("P.Mahomes") as they appear in play text
  weight: number;        // 0..1, how interesting / surprising
  source?: string;       // URL or "play-by-play"; required for kb facts
  asOf?: string;         // ISO date the source reflects (kb facts must predate the game for replays)
};

/** Situational context for one play at one stage (computed only from what has already been revealed). */
export type SituationIntel = {
  facts: IntelFact[];
  /** A decision where the numbers disagree with the obvious call, or the coach went against the numbers. */
  surprise: boolean;
  /** The decision was routine (e.g. punt on 4th & 12 at own 30): nothing about it is worth saying. */
  obvious: boolean;
};

export type KnowledgeBase = {
  gameId: string;
  builtAt: string;
  facts: IntelFact[];
};

/** Retrieval: facts about the entities in this play, best first. Never returns facts filtered as spoilers. */
export type Retriever = (q: { entities: string[]; kinds?: IntelKind[]; limit?: number; exclude?: Set<string> }) => IntelFact[];

/**
 * What a Room is given (by RoomManager / http) so the Director can use game intelligence.
 * `stage`: 'result' = after the snap, penalty not yet announced; 'announced' = after the referee's announcement.
 */
export type IntelProvider = {
  situation(plays: import('../../shared/types').TimelinePlay[], idx: number, stage: 'result' | 'announced'): SituationIntel;
  retrieve: Retriever;
};
