import { describe, expect, it } from 'vitest';
import { loadFixture, loadGame } from '../server/data/loadGame';
import { buildCallIt, fallbackDistractors, penaltyCatalog, playCategory, validDistractors } from '../server/game/callit';
import { concept } from '../server/data/concepts';

const P = loadFixture().timeline.plays;
const byId = (id: number) => P.find((p) => p.playId === id)!;
const sb = loadGame('2022_22_KC_PHI').timeline.plays.filter((p) => p.penalty);

describe('F5 Call It', () => {
  it('always includes the real penalty among 4 distinct catalog options', () => {
    for (const play of [...P.filter((p) => p.penalty), ...sb]) {
      const round = buildCallIt(play, null);
      expect(round.options).toHaveLength(4);
      expect(new Set(round.options.map((o) => o.label)).size).toBe(4);
      const correct = round.options.find((o) => o.id === round.correctOptionId)!;
      expect(correct.label).toBe(concept(play.penalty!.conceptId).name);
      for (const d of round.distractors) expect(penaltyCatalog()).toContain(d);
    }
  });

  it('uses valid LLM distractors and falls back on junk', () => {
    const play = byId(40); // defensive holding on a pass
    const good = buildCallIt(play, ['illegal_contact', 'pass_interference_defensive', 'roughing_the_passer'], 'llm');
    expect(good.source).toBe('llm');
    expect(good.distractors).toEqual(['illegal_contact', 'pass_interference_defensive', 'roughing_the_passer']);
    const junks: unknown[] = [
      null, 'holding', ['a', 'b', 'c'], ['illegal_contact', 'illegal_contact', 'face_mask'],
      ['holding_defensive', 'face_mask', 'tripping'], ['face_mask', 'tripping'], ['downs', 'face_mask', 'tripping'],
    ];
    for (const junk of junks) {
      expect(validDistractors(junk, 'holding_defensive')).toBe(false);
      const r = buildCallIt(play, junk, 'llm');
      expect(r.source).toBe('fallback');
      expect(r.distractors).not.toContain('holding_defensive');
      expect(r.distractors).toHaveLength(3);
    }
  });

  it('is deterministic for the same seed (play idx)', () => {
    const play = byId(40);
    expect(buildCallIt(play, null)).toEqual(buildCallIt(play, null));
    expect(fallbackDistractors(play, 'holding_defensive')).toEqual(fallbackDistractors(play, 'holding_defensive'));
  });

  it('picks distractors by play type', () => {
    expect(playCategory(byId(50))).toBe('preSnap');
    expect(playCategory(byId(40))).toBe('pass');
    const pre = buildCallIt(byId(50), null);
    const preSnapIds = ['false_start', 'offside', 'neutral_zone_infraction', 'encroachment', 'delay_of_game', 'illegal_formation', 'illegal_shift'];
    for (const d of pre.distractors) expect(preSnapIds).toContain(d);
  });

  it('uses opaque option ids and labels penalty_other with the raw name', () => {
    const play = { ...byId(40), penalty: { ...byId(40).penalty!, conceptId: 'penalty_other', rawType: 'Chop Block' } };
    const r = buildCallIt(play, null);
    expect(r.options.map((o) => o.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(r.options.find((o) => o.id === r.correctOptionId)!.label).toBe('Chop Block');
  });
});
