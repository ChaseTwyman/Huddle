import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { espnToRows, gameMeta, splitTry, type EspnSummary } from '../server/live/espn';
import { buildTimeline } from '../server/data/timeline';

const summary = JSON.parse(fs.readFileSync('data/fixtures/espn_2026_w3_atl_gb.json', 'utf8')) as EspnSummary;
const meta = gameMeta(summary);
const rows = espnToRows(summary);
const { timeline, unknownPenalties } = buildTimeline(rows, { gameId: 'espn_x', title: meta.title, date: meta.date }, []);
const P = timeline.plays;

describe('F14 ESPN feed mapping (real game: ATL 35, GB 14, 2026 week 3)', () => {
  it('reads the teams and ends at the real final score', () => {
    expect(meta).toMatchObject({ home: 'GB', away: 'ATL', state: 'post' });
    expect(timeline.finalScore).toEqual({ home: 14, away: 35 });
  });

  it('splits the try out of the touchdown play, with the right score on each', () => {
    const tds = P.filter((p) => p.result.touchdown);
    expect(tds.length).toBe(6);
    for (const td of tds) {
      const next = P[td.idx + 1];
      expect(['extra_point', 'two_point'], `after #${td.idx}`).toContain(next.kind);
      const scorerHome = td.scoreAfter.home > td.scoreBefore.home;
      expect((scorerHome ? td.scoreAfter.home - td.scoreBefore.home : td.scoreAfter.away - td.scoreBefore.away)).toBe(6);
    }
    const two = P.find((p) => p.kind === 'two_point')!;
    expect(two.decision).toEqual({ kind: 'two_point' });
    expect(two.result.twoPoint).toBe('success'); // "M.Penix pass to C.Blair is complete. ATTEMPT SUCCEEDS."
    expect(two.scoreAfter.away - two.scoreBefore.away).toBe(2);
  });

  it('keeps penalties parseable, spoiler-free in public text, with no unknown types', () => {
    const flagged = P.filter((p) => p.penalty);
    expect(flagged.length).toBeGreaterThanOrEqual(12);
    expect(unknownPenalties).toEqual([]);
    const types = flagged.map((p) => p.penalty!.conceptId);
    expect(types).toEqual(expect.arrayContaining(['false_start', 'holding_offensive', 'pass_interference_defensive', 'roughing_the_passer', 'intentional_grounding']));
    for (const p of flagged) expect(p.publicDesc).not.toMatch(/penalty on/i);
    const fs0 = flagged.find((p) => p.penalty!.conceptId === 'false_start')!;
    expect(fs0.kind).toBe('penalty_only');
  });

  it('finds decisions and field goals, and drops TV timeouts', () => {
    expect(P.filter((p) => p.decision?.kind === 'fourth_down').length).toBeGreaterThanOrEqual(8);
    const fgs = P.filter((p) => p.kind === 'field_goal');
    expect(fgs.map((p) => p.result.fieldGoal).sort()).toEqual(['blocked', 'made', 'made']);
    expect(P.some((p) => /Official Timeout/.test(p.desc))).toBe(false);
    expect(P.filter((p) => p.kind === 'timeout').length).toBe(4);
    expect(P[P.length - 1].kind).toBe('end_of_period');
  });

  it('puts kickoffs on the receiving team from the kicker\'s 35', () => {
    const k = P.find((p) => p.kind === 'kickoff')!;
    expect(k.posteam).toBe('ATL');
    expect(k.yardline100).toBe(35);
  });

  it('carries the wall-clock time of each play', () => {
    expect(rows.every((r) => r.wallclock_ms === '' || Number(r.wallclock_ms) > 1.7e12)).toBe(true);
  });

  it('splits try text', () => {
    expect(splitTry('X for 4 yards, TOUCHDOWN. T.Smack extra point is GOOD, Center-M.Orzech.')).toEqual({ play: 'X for 4 yards, TOUCHDOWN.', tryText: 'T.Smack extra point is GOOD, Center-M.Orzech.', kind: 'extra_point' });
    expect(splitTry('run for 2 yards, TOUCHDOWN. TWO-POINT CONVERSION ATTEMPT. A pass to B is complete. ATTEMPT SUCCEEDS.').kind).toBe('two_point');
    expect(splitTry('J.Love pass incomplete.').tryText).toBeNull();
  });
});
