import { describe, expect, it } from 'vitest';
import { loadFixture, loadGame } from '../server/data/loadGame';
import { tag } from '../server/data/tagger';
import { cleanDesc } from '../server/game/ticker';
import { mapPenaltyType } from '../server/data/penalties';

const { timeline } = loadFixture();
const P = timeline.plays;
const byId = (playId: number) => P.find((p) => p.playId === playId)!;

describe('F3/F6 concept tagger', () => {
  it('builds the fixture with scores, kinds and decisions', () => {
    expect(P).toHaveLength(20);
    expect(timeline.finalScore).toEqual({ home: 11, away: 7 });
    expect(byId(50).kind).toBe('penalty_only');
    expect(byId(170).kind).toBe('two_point');
    expect(byId(80).decision).toEqual({ kind: 'fourth_down' });
    expect(byId(130).decision).toEqual({ kind: 'fourth_down' });
    expect(byId(170).decision).toEqual({ kind: 'two_point' });
    expect(byId(190).decision).toEqual({ kind: 'fourth_down' });
    expect(byId(20).decision).toBeNull();
  });

  it('tags basics on scrimmage plays, not on kickoffs', () => {
    expect(byId(20).concepts).toEqual(expect.arrayContaining(['downs', 'first_down_line']));
    expect(byId(10).concepts).toEqual(['kickoff', 'touchback']);
  });

  it('tags down-specific concepts', () => {
    expect(byId(70).concepts).toContain('third_down');
    expect(byId(80).concepts).toEqual(expect.arrayContaining(['fourth_down_decision', 'punt', 'punt_return']));
    expect(byId(130).concepts).toContain('fourth_down_decision');
  });

  it('tags scoring', () => {
    expect(byId(140).concepts).toContain('touchdown');
    expect(byId(150).concepts).toEqual(['extra_point']);
    expect(byId(170).concepts).toContain('two_point_conversion');
    expect(byId(190).concepts).toEqual(expect.arrayContaining(['field_goal', 'fourth_down_decision']));
  });

  it('tags penalties with status concepts, highest priority first', () => {
    const hold = byId(40);
    expect(hold.penalty?.conceptId).toBe('holding_defensive');
    expect(hold.penalty?.autoFirstDown).toBe(true);
    expect(hold.concepts[0]).toBe('holding_defensive');
    expect(hold.concepts).toContain('automatic_first_down');
    expect(byId(90).penalty?.status).toBe('declined');
    expect(byId(90).concepts).toEqual(expect.arrayContaining(['offside', 'penalty_declined']));
    expect(byId(50).penalty?.preSnap).toBe(true);
    expect(byId(50).concepts[0]).toBe('false_start');
  });

  it('tags incomplete passes and challenges', () => {
    expect(byId(60).concepts).toContain('incomplete_pass');
    expect(byId(100).concepts).toEqual(expect.arrayContaining(['challenge_flag', 'replay_review']));
  });

  it('fires running_out_the_clock on the late auto-first-down penalty while ahead', () => {
    const late = byId(180);
    expect(late.concepts).toContain('running_out_the_clock');
    expect(late.concepts).toContain('automatic_first_down');
    // Same penalty early in the game does not.
    expect(byId(40).concepts).not.toContain('running_out_the_clock');
  });

  it('is a pure function of (play, prev, ctx)', () => {
    const p = byId(180);
    const prev = P[p.idx - 1];
    expect(tag(p, prev, { home: 'DAL', away: 'NYG' })).toEqual(p.concepts);
    // Trailing team: no clock concept.
    expect(tag({ ...p, scoreBefore: { home: 0, away: 7 } }, prev, { home: 'DAL', away: 'NYG' })).not.toContain('running_out_the_clock');
  });

  it('computes absolute field positions (home attacks right)', () => {
    expect(byId(20).field.losAbs).toBe(25);
    expect(byId(20).field.firstDownAbs).toBe(35);
    expect(byId(90).field.losAbs).toBe(82);
    expect(byId(90).field.firstDownAbs).toBe(72);
    expect(byId(140).field.ballEndAbs).toBe(0);
  });
});

describe('F11 ticker cleaning (P0 version)', () => {
  it('removes clock, formation, jersey numbers and the penalty clause', () => {
    expect(cleanDesc(byId(40).desc)).toBe('D.Prescott pass incomplete deep left to C.Lamb. Flag on the play.');
    expect(cleanDesc(byId(50).desc)).toBe('Flag on the play.');
    expect(byId(90).publicDesc).not.toMatch(/offside/i);
  });
});

describe('penalty mapping', () => {
  it('maps variants case-insensitively and falls back to penalty_other', () => {
    expect(mapPenaltyType('Face Mask (15 Yards)').conceptId).toBe('face_mask');
    expect(mapPenaltyType('defensive too many men on field').conceptId).toBe('too_many_men');
    expect(mapPenaltyType('Taunting').conceptId).toBe('unsportsmanlike_conduct');
    expect(mapPenaltyType('Illegal Block Above the Waist').conceptId).toBe('illegal_block_in_the_back');
    expect(mapPenaltyType('Chop Block')).toEqual({ conceptId: 'penalty_other', side: null, known: false });
  });
});

describe('Super Bowl LVII data', () => {
  const g = loadGame('2022_22_KC_PHI');
  it('validates the final score and required moments', () => {
    expect(g.timeline.home).toBe('PHI');
    expect(g.timeline.finalScore).toEqual({ home: 35, away: 38 });
    for (const k of ['toney-return', 'toney-td', 'hurts-2pt', 'bradberry-flag', 'butker-fg', 'halftime', 'final']) {
      expect(g.moments.keys[k], k).toBeTypeOf('number');
    }
    expect(g.moments.segments.map((s) => s.id)).toEqual(['A', 'B', 'C']);
  });
  it('tags the Bradberry flag with holding, automatic first down, and clock strategy', () => {
    const b = g.timeline.plays[g.moments.keys['bradberry-flag']];
    expect(b.penalty?.conceptId).toBe('holding_defensive');
    expect(b.concepts).toEqual(expect.arrayContaining(['holding_defensive', 'automatic_first_down', 'running_out_the_clock']));
    expect(b.publicDesc).not.toMatch(/holding/i);
  });
});
