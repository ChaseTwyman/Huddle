import type { TeamInfo, TimelinePlay } from '../../shared/types';
import { teamOf } from '../../shared/teams';

const real = (p: TimelinePlay) => p.kind !== 'timeout' && p.kind !== 'end_of_period' && p.kind !== 'kickoff' && p.kind !== 'extra_point';

/**
 * One-line summary of plays skipped in condensed mode, e.g. "Kansas City drove 38 yards in 6 plays."
 * `nextShown` is the play that follows, used to measure how far the ball moved.
 */
export function summarizeSkipped(skipped: TimelinePlay[], nextShown: TimelinePlay | null, home: string, teams?: Record<string, TeamInfo>): string | null {
  const teamTable = teams;
  const plays = skipped.filter(real);
  if (!plays.length) return null;
  const sides = [...new Set(plays.map((p) => p.posteam).filter(Boolean))] as string[];
  if (sides.length > 1) {
    return `${plays.length} plays: ${sides.map((t) => teamOf(t, teamTable).city).join(' and ')} traded possessions.`;
  }
  const t = sides[0];
  const city = t ? teamOf(t, teamTable).city : 'The offense';
  const first = plays[0];
  const endAbs = nextShown && nextShown.posteam === t && nextShown.field.losAbs !== null
    ? nextShown.field.losAbs
    : plays[plays.length - 1].field.ballEndAbs;
  if (first.field.losAbs === null || endAbs === null) return `${city} ran ${plays.length} ${plays.length === 1 ? 'play' : 'plays'}.`;
  const dir = t === home ? 1 : -1;
  const yards = Math.round((endAbs - first.field.losAbs) * dir);
  const n = `${plays.length} ${plays.length === 1 ? 'play' : 'plays'}`;
  if (yards > 0) return `${city} drove ${yards} ${yards === 1 ? 'yard' : 'yards'} in ${n}.`;
  if (yards < 0) return `${city} lost ${-yards} ${yards === -1 ? 'yard' : 'yards'} in ${n}.`;
  return `${city} ran ${n} and stayed put.`;
}
