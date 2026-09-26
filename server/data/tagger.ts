import type { TimelinePlay } from '../../shared/types';
import { sortByPriority } from './concepts';
import { effectiveDesc } from '../game/ticker';

export type GameCtx = { home: string; away: string };

export function clockSeconds(clock: string): number {
  const m = /^(\d+):(\d{2})$/.exec(clock.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

const SCRIMMAGE = new Set(['pass', 'run', 'punt', 'field_goal', 'kneel', 'spike', 'penalty_only']);

export function isScrimmage(play: TimelinePlay): boolean {
  return SCRIMMAGE.has(play.kind) && play.down !== null;
}

/** Is the possession team ahead or tied before this play? */
export function posteamNotTrailing(play: TimelinePlay, ctx: GameCtx): boolean {
  if (!play.posteam) return false;
  const own = play.posteam === ctx.home ? play.scoreBefore.home : play.scoreBefore.away;
  const opp = play.posteam === ctx.home ? play.scoreBefore.away : play.scoreBefore.home;
  return own >= opp;
}

/** Concept tagger (BUILD_PROMPT 6.5). Pure: returns concept ids sorted by priority, highest first. */
export function tag(play: TimelinePlay, prevPlay: TimelinePlay | null, ctx: GameCtx): string[] {
  const out: string[] = [];
  const r = play.result;
  const fullDesc = play.desc;
  const desc = effectiveDesc(play.desc);

  if (isScrimmage(play)) out.push('downs', 'first_down_line');
  if (play.down === 3) out.push('third_down');
  if (play.down === 4) out.push('fourth_down_decision');
  if (r.turnover === 'downs') out.push('turnover_on_downs');

  if (r.touchdown) out.push('touchdown');
  if (play.kind === 'extra_point') out.push('extra_point');
  if (play.kind === 'two_point') out.push('two_point_conversion');
  if (play.kind === 'field_goal') out.push('field_goal');
  if (r.safety) out.push('safety');

  if (play.kind === 'punt') out.push('punt');
  if (play.kind === 'punt' && play.players.returner && (play.returnYards ?? 0) > 0) out.push('punt_return');
  if (/fair catch/i.test(desc)) out.push('fair_catch');
  if (play.kind === 'kickoff') out.push('kickoff');
  if (r.touchback) out.push('touchback');
  if (r.turnover === 'interception') out.push('interception');
  if (r.turnover === 'fumble' || /\bFUMBLES\b/.test(desc)) out.push('fumble');
  if (r.sack) out.push('sack');
  if (r.incomplete) out.push('incomplete_pass');

  if (play.kind === 'timeout') out.push('timeout');
  if ((play.qtr === 2 || play.qtr === 4) && play.kind !== 'end_of_period') {
    const secs = clockSeconds(play.clock);
    const prevSecs = prevPlay && prevPlay.qtr === play.qtr ? clockSeconds(prevPlay.clock) : Infinity;
    if (secs <= 120 && prevSecs > 120) out.push('two_minute_warning');
  }
  if (play.kind === 'kneel') out.push('kneel_down');
  if (play.kind === 'spike') out.push('spike');

  const lateAhead = play.qtr === 4 && posteamNotTrailing(play, ctx);
  if (lateAhead && play.gameSecondsRemaining <= 300 && (play.kind === 'run' || play.kind === 'kneel')) {
    out.push('running_out_the_clock');
  }
  if (lateAhead && play.gameSecondsRemaining <= 180 && play.penalty?.status === 'accepted' && play.penalty.autoFirstDown) {
    out.push('running_out_the_clock');
  }

  if (/challenged/i.test(fullDesc)) out.push('challenge_flag');
  if (play.challenge || /replay official|reviewed/i.test(fullDesc)) out.push('replay_review');

  if (play.penalty) {
    const p = play.penalty;
    out.push(p.conceptId);
    if (p.status === 'accepted' && p.autoFirstDown) out.push('automatic_first_down');
    if (p.status === 'declined') out.push('penalty_declined');
    if (p.status === 'offsetting') out.push('offsetting_penalties');
    if (/half the distance/i.test(fullDesc)) out.push('half_the_distance');
  }

  if (play.goalToGo && isScrimmage(play)) out.push('goal_to_go');
  if (isScrimmage(play) && play.yardline100 !== null && play.yardline100 <= 20) out.push('red_zone');

  return sortByPriority(out);
}
