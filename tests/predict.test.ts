import { describe, expect, it } from 'vitest';
import { loadFixture, loadGame } from '../server/data/loadGame';
import { buildPredict, resolvePredict } from '../server/game/predict';
import type { TimelinePlay } from '../shared/types';

const P = loadFixture().timeline.plays;
const byId = (id: number) => P.find((p) => p.playId === id)!;

describe('F4 Predict', () => {
  it('asks the 4th-down question with the field goal hidden beyond the 45', () => {
    const punt = buildPredict(byId(80))!; // 4th & 7 at own 45 (yardline100 55)
    expect(punt.question).toBe('4th & 7 at the DAL 45. What will Dallas do?');
    expect(punt.options.map((o) => o.id)).toEqual(['go', 'punt']);
    const go = buildPredict(byId(130))!; // 4th & 2 at DAL 34
    expect(go.options.map((o) => o.id)).toEqual(['go', 'punt', 'fg']);
  });

  it('resolves every decision kind from play data', () => {
    expect(resolvePredict(byId(80))).toEqual({ voided: false, correctOptionId: 'punt' });
    expect(resolvePredict(byId(130))).toEqual({ voided: false, correctOptionId: 'go' });
    expect(resolvePredict(byId(190))).toEqual({ voided: false, correctOptionId: 'fg' });
    expect(buildPredict(byId(170))!.question).toBe('Two-point try. Will Dallas get in?');
    expect(resolvePredict(byId(170))).toEqual({ voided: false, correctOptionId: 'yes' });
  });

  it('resolves field goals on early downs and failed two-point tries', () => {
    const fg: TimelinePlay = { ...byId(190), down: 2, decision: { kind: 'field_goal' }, result: { ...byId(190).result, fieldGoal: 'missed' } };
    expect(buildPredict(fg)!.question).toBe('37-yard field goal. Good?');
    expect(resolvePredict(fg)).toEqual({ voided: false, correctOptionId: 'nogood' });
    const fail: TimelinePlay = { ...byId(170), result: { ...byId(170).result, twoPoint: 'failure' } };
    expect(resolvePredict(fail)).toEqual({ voided: false, correctOptionId: 'no' });
  });

  it('voids a prediction when an accepted no-play penalty wipes the play out', () => {
    const wiped: TimelinePlay = { ...byId(130), penalty: { ...byId(40).penalty!, noPlay: true, status: 'accepted' } };
    expect(resolvePredict(wiped)).toEqual({ voided: true });
    const declined: TimelinePlay = { ...byId(130), penalty: { ...byId(40).penalty!, noPlay: false, status: 'declined' } };
    expect(resolvePredict(declined)).toEqual({ voided: false, correctOptionId: 'go' });
  });

  it('triggers on every qualifying Super Bowl LVII play', () => {
    const g = loadGame('2022_22_KC_PHI');
    const decisions = g.timeline.plays.filter((p) => p.decision);
    expect(decisions.length).toBeGreaterThanOrEqual(10);
    for (const p of decisions) {
      expect(buildPredict(p), `#${p.idx}`).not.toBeNull();
      const r = resolvePredict(p);
      if (!r.voided) expect(buildPredict(p)!.options.map((o) => o.id).concat(['fg'])).toContain(r.correctOptionId);
    }
    const two = g.timeline.plays[g.moments.keys['hurts-2pt']];
    expect(resolvePredict(two)).toEqual({ voided: false, correctOptionId: 'yes' });
    const butker = g.timeline.plays[g.moments.keys['butker-fg']];
    expect(resolvePredict(butker)).toEqual({ voided: false, correctOptionId: 'fg' });
  });
});
