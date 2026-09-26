import type { Storyline, StoryPlayer, TimelinePlay } from '../../shared/types';

export type Involvement = {
  storylineId: string;
  player: StoryPlayer;
  reason: 'score' | 'big_gain' | 'return' | 'turnover' | 'field_goal' | 'penalty';
  /** Penalty involvements may only surface after the announcement. */
  afterAnnouncement: boolean;
};

const is = (name: string | undefined, p: StoryPlayer) => !!name && p.pbpNames.includes(name);

/** A storyline player's notable involvement in a play (BUILD_PROMPT 6.7), or null. */
export function involvement(play: TimelinePlay, storyline: Storyline): Involvement | null {
  const pl = play.players;
  for (const p of storyline.players) {
    const base = { storylineId: storyline.id, player: p, afterAnnouncement: false };
    const carrier = is(pl.rusher, p) || is(pl.receiver, p) || is(pl.returner, p);
    if (play.result.touchdown && carrier) return { ...base, reason: 'score' };
    if (play.kind === 'two_point' && play.result.twoPoint === 'success' && carrier) return { ...base, reason: 'score' };
    if ((is(pl.rusher, p) || is(pl.receiver, p)) && (play.yardsGained ?? 0) >= 15 && !play.penalty?.noPlay) return { ...base, reason: 'big_gain' };
    if (is(pl.returner, p) && (play.returnYards ?? 0) >= 20) return { ...base, reason: 'return' };
    if (play.result.turnover === 'interception' && is(pl.passer, p)) return { ...base, reason: 'turnover' };
    if (play.result.turnover === 'fumble' && carrier) return { ...base, reason: 'turnover' };
    if (play.kind === 'field_goal' && is(pl.kicker, p)) return { ...base, reason: 'field_goal' };
    if (play.penalty && play.penalty.status === 'accepted' && is(pl.penaltyPlayer, p)) {
      return { ...base, reason: 'penalty', afterAnnouncement: true };
    }
  }
  return null;
}

export function anyInvolvement(play: TimelinePlay, storylines: Storyline[]): Involvement | null {
  for (const s of storylines) {
    const inv = involvement(play, s);
    if (inv) return inv;
  }
  return null;
}
