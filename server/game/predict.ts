import type { PromptOption, TimelinePlay } from '../../shared/types';
import { team } from '../../shared/teams';
import { ballOn } from '../data/timeline';

export type PredictQuestion = { kind: 'fourth_down' | 'two_point' | 'field_goal'; question: string; options: PromptOption[] };

/** F4: build the Predict question for a decision play from pre-snap information only. */
export function buildPredict(play: TimelinePlay): PredictQuestion | null {
  if (!play.decision) return null;
  const city = team(play.posteam).city;
  switch (play.decision.kind) {
    case 'fourth_down': {
      const options: PromptOption[] = [
        { id: 'go', label: 'Go for it' },
        { id: 'punt', label: 'Punt' },
      ];
      if ((play.yardline100 ?? 100) <= 45) options.push({ id: 'fg', label: 'Kick a field goal' });
      const dist = play.goalToGo ? 'Goal' : String(play.ydstogo ?? '?');
      return { kind: 'fourth_down', question: `4th & ${dist} at the ${ballOn(play) ?? 'line'}. What will ${city} do?`, options };
    }
    case 'two_point':
      return { kind: 'two_point', question: `Two-point try. Will ${city} get in?`, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] };
    case 'field_goal': {
      // Distance known before the kick: line of scrimmage + 17 yards (end zone + holder spot).
      const distance = (play.yardline100 ?? 0) + 17;
      return { kind: 'field_goal', question: `${distance}-yard field goal. Good?`, options: [{ id: 'good', label: 'Good' }, { id: 'nogood', label: 'No good' }] };
    }
  }
}

export type PredictResolution = { voided: true } | { voided: false; correctOptionId: string };

/** A play wiped out by an accepted pre-snap or no-play penalty voids the prediction. */
export function isVoided(play: TimelinePlay): boolean {
  const p = play.penalty;
  return !!p && p.status === 'accepted' && (p.noPlay || p.preSnap || play.kind === 'penalty_only');
}

export function resolvePredict(play: TimelinePlay): PredictResolution {
  if (isVoided(play) || !play.decision) return { voided: true };
  switch (play.decision.kind) {
    case 'fourth_down':
      if (play.kind === 'punt') return { voided: false, correctOptionId: 'punt' };
      if (play.kind === 'field_goal') return { voided: false, correctOptionId: 'fg' };
      return { voided: false, correctOptionId: 'go' };
    case 'two_point':
      return { voided: false, correctOptionId: play.result.twoPoint === 'success' ? 'yes' : 'no' };
    case 'field_goal':
      return { voided: false, correctOptionId: play.result.fieldGoal === 'made' ? 'good' : 'nogood' };
  }
}
