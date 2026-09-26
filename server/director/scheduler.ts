import type { KnowledgeLevel, KnowledgeMap, Talkativeness, TimelinePlay } from '../../shared/types';
import { BUDGET } from '../../shared/constants';
import { levelRank, roomLevel } from '../game/knowledge';

/** Why the Director is being asked. Penalty and decision turns don't count toward the budget. */
export type Trigger = 'penalty' | 'decision' | 'play';

export type Candidate = { conceptId: string; roomLevel: KnowledgeLevel; depth: 'full' | 'short' };

export function triggerFor(play: TimelinePlay): Trigger {
  if (play.penalty) return 'penalty';
  if (play.decision) return 'decision';
  return 'play';
}

/**
 * Candidates (BUILD_PROMPT 8.1): the play's tagged concepts where the room is below Mastered,
 * top 3 by priority; after an announcement the penalty concept is always first.
 */
export function candidatesFor(play: TimelinePlay, learners: KnowledgeMap[], trigger: Trigger): Candidate[] {
  let ids = [...play.concepts];
  if (trigger === 'penalty' && play.penalty) ids = [play.penalty.conceptId, ...ids.filter((id) => id !== play.penalty!.conceptId)];
  const out: Candidate[] = [];
  for (const id of ids) {
    const lvl = roomLevel(learners, id);
    if (levelRank(lvl) >= levelRank('mastered')) continue;
    out.push({ conceptId: id, roomLevel: lvl, depth: lvl === 'new' ? 'full' : 'short' });
    if (out.length === 3) break;
  }
  return out;
}

export type Verdict = { ok: true; waitMs: number } | { ok: false; reason: string };

/**
 * Talk budget. Deterministic and clock-driven; the room records every Huddle line with `spoke()`.
 * - quiet: only after announcements and decision results.
 * - normal: ≤ 6 per quarter (penalty/decision turns not counted); ≥ 20 s between spoken lines.
 * - chatty: ≤ 1 per 2 plays; ≥ 12 s between spoken lines.
 * Budget-exempt turns (penalty/decision) wait out the minimum gap instead of being dropped.
 */
export class Scheduler {
  private lastSpokenAt = -Infinity;
  private perQuarter = new Map<number, number>();
  private playsSinceLine = Infinity;

  constructor(public talkativeness: Talkativeness) {}

  get gapMs() {
    return this.talkativeness === 'chatty' ? BUDGET.chattyGapMs : BUDGET.normalGapMs;
  }

  /** Call once per play shown, before the Director turn. */
  notePlay() { this.playsSinceLine++; }

  usedThisQuarter(qtr: number) { return this.perQuarter.get(qtr) ?? 0; }

  remaining(qtr: number): number {
    if (this.talkativeness === 'normal') return Math.max(0, BUDGET.normalPerQuarter - this.usedThisQuarter(qtr));
    if (this.talkativeness === 'quiet') return 0;
    return this.playsSinceLine >= BUDGET.chattyPlaysPerLine ? 1 : 0;
  }

  canSpeak(opts: { trigger: Trigger; now: number; qtr: number; windowOpen: boolean }): Verdict {
    if (opts.windowOpen) return { ok: false, reason: 'window open' };
    const exempt = opts.trigger !== 'play';
    if (!exempt) {
      if (this.talkativeness === 'quiet') return { ok: false, reason: 'quiet' };
      if (this.remaining(opts.qtr) <= 0) return { ok: false, reason: 'budget' };
    }
    const since = opts.now - this.lastSpokenAt;
    if (since < this.gapMs) {
      if (!exempt) return { ok: false, reason: 'gap' };
      return { ok: true, waitMs: this.gapMs - since };
    }
    return { ok: true, waitMs: 0 };
  }

  /** Record a Huddle line (explanation or storyline beat). Only non-exempt explanations use budget. */
  spoke(opts: { now: number; qtr: number; countsToBudget: boolean }) {
    this.lastSpokenAt = opts.now;
    this.playsSinceLine = 0;
    if (opts.countsToBudget) this.perQuarter.set(opts.qtr, this.usedThisQuarter(opts.qtr) + 1);
  }

  /** Beats respect the minimum gap but don't use the explanation budget. */
  gapOk(now: number) { return now - this.lastSpokenAt >= this.gapMs; }
}
