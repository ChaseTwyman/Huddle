import { describe, expect, it } from 'vitest';
import { loadFixture, loadGame } from '../server/data/loadGame';
import { concept, hasConcept } from '../server/data/concepts';
import { lastName } from '../server/data/timeline';
import { fourthDownAdvice, makeSituation, situationIntel } from '../server/intel/situation';
import type { TimelinePlay } from '../shared/types';

const P = loadFixture().timeline.plays;
const byId = (id: number) => P.find((p) => p.playId === id)!;
const SB = loadGame('2022_22_KC_PHI').timeline;
const texts = (plays: TimelinePlay[], idx: number, stage: 'result' | 'announced') => situationIntel(plays, idx, stage, SB.teams).facts.map((f) => f.text);

describe('Game intelligence: situation', () => {
  it('a 4th & 7 punt from the own 45 is obvious, not a surprise', () => {
    const punt = byId(80);
    const r = situationIntel(P, punt.idx, 'result');
    expect(r.obvious).toBe(true);
    expect(r.surprise).toBe(false);
    expect(r.facts.find((f) => f.id === `sit:decision:${punt.idx}`)!.text).toBe('A simple 4th-down model says punt here, and Dallas did.');
  });

  it('the same spot turned into a go-for-it is a surprise', () => {
    const punt = byId(80);
    const plays = [...P];
    plays[punt.idx] = { ...punt, kind: 'run', players: { rusher: 'T.Pollard' } };
    const r = situationIntel(plays, punt.idx, 'result');
    expect(r.surprise).toBe(true);
    expect(r.obvious).toBe(false);
    expect(r.facts.some((f) => f.kind === 'decision' && /went for it instead/.test(f.text) && f.weight >= 0.8)).toBe(true);
  });

  it("flags Philadelphia's 4th & 5 go from the KC 44 in Super Bowl LVII as aggressive", () => {
    const i = SB.plays.findIndex((p) => p.qtr === 2 && p.decision?.kind === 'fourth_down' && p.posteam === 'PHI' && p.kind === 'run');
    const r = situationIntel(SB.plays, i, 'result', SB.teams);
    expect(r.surprise).toBe(true);
    expect(texts(SB.plays, i, 'result')).toContain('A simple 4th-down model says punt here, but Philadelphia went for it instead.');
  });

  it('short yardage in field-goal range is a go, and a tied game with seconds left is a kick', () => {
    const base = byId(130);
    expect(fourthDownAdvice({ ...base, ydstogo: 1, yardline100: 20 }, 0)).toEqual({ recommend: 'go', strength: 'lean' });
    expect(fourthDownAdvice({ ...base, qtr: 4, gameSecondsRemaining: 11, ydstogo: 8, yardline100: 9 }, 0)!.recommend).toBe('field_goal');
    expect(fourthDownAdvice({ ...base, qtr: 4, gameSecondsRemaining: 60, ydstogo: 10, yardline100: 70 }, -7)!.recommend).toBe('go');
    expect(fourthDownAdvice({ ...base, ydstogo: 12, yardline100: 70 }, 0)).toEqual({ recommend: 'punt', strength: 'strong' });
  });

  it('reports a big win-probability swing', () => {
    const i = SB.plays.findIndex((p) => p.qtr === 4 && p.clock === '2:55' && p.kind === 'run');
    const r = situationIntel(SB.plays, i, 'result', SB.teams);
    const wp = r.facts.find((f) => f.id === `sit:wp:${i}`)!;
    expect(wp.text).toBe("That play swung Kansas City's win chances from 57% to 74%, by a win-probability model.");
    expect(wp.weight).toBeGreaterThan(0.7);
    // No wp in the data: no win-probability fact.
    expect(situationIntel(P, byId(130).idx, 'announced').facts.some((f) => f.kind === 'win_prob')).toBe(false);
  });

  it('counts stats only from plays up to idx', () => {
    const i = byId(70).idx; // Prescott: 8-yd catch, a no-play (wiped), incomplete, 8-yd catch
    const stat = situationIntel(P, i, 'announced').facts.find((f) => f.kind === 'game_stat' && f.about.includes('D.Prescott'))!;
    expect(stat.text).toBe('Prescott is 2 of 3 for 16 yards so far.');
    // Later plays never change the answer.
    for (let k = 0; k < P.length; k++) {
      for (const stage of ['result', 'announced'] as const) {
        expect(situationIntel(P.slice(0, k + 1), k, stage)).toEqual(situationIntel(P, k, stage));
      }
    }
    for (let k = 0; k < SB.plays.length; k += 7) {
      expect(situationIntel(SB.plays.slice(0, k + 1), k, 'result', SB.teams)).toEqual(situationIntel(SB.plays, k, 'result', SB.teams));
    }
  });

  it('never names or uses a flag at the result stage', () => {
    for (const [plays, teams] of [[P, undefined], [SB.plays, SB.teams]] as const) {
      for (const p of plays) {
        if (!p.penalty) continue;
        const r = situationIntel(plays, p.idx, 'result', teams);
        const banned = [p.penalty.conceptId, p.penalty.rawType, 'penalty', 'flag'];
        if (hasConcept(p.penalty.conceptId)) banned.push(concept(p.penalty.conceptId).name);
        const pp = p.penalty.player;
        const inPlay = [p.players.passer, p.players.rusher, p.players.receiver];
        if (pp && !inPlay.includes(pp)) banned.push(lastName(pp));
        for (const f of r.facts) {
          for (const b of banned) expect(f.text.toLowerCase(), `${p.idx} ${f.id}`).not.toContain(b.toLowerCase());
          if (pp && !inPlay.includes(pp)) expect(f.about).not.toContain(pp);
        }
        // The swing includes the penalty's effect, so it waits for the announcement.
        expect(r.facts.some((f) => /swung/.test(f.text))).toBe(false);
      }
    }
    // Bradberry's hold: the 3rd-down conversion only counts once announced.
    const b = SB.plays.findIndex((p) => p.momentKeys.includes('bradberry-flag'));
    expect(texts(SB.plays, b, 'result')).toContain('Kansas City has converted 4 of 7 third downs so far.');
    expect(texts(SB.plays, b, 'announced')).toContain('Kansas City has converted 5 of 8 third downs so far.');
  });

  it('covers the 2-point try and repeated 4th-down tries', () => {
    const t = SB.plays.findIndex((p) => p.momentKeys.includes('hurts-2pt'));
    expect(texts(SB.plays, t, 'result')).toContain('Down 2 late, a simple 2-point chart says go for two, and Philadelphia did.');
    const f = SB.plays.findIndex((p) => p.qtr === 3 && p.decision?.kind === 'fourth_down' && p.kind === 'run');
    expect(texts(SB.plays, f, 'result')).toContain("That's Philadelphia's second fourth-down try today; they converted 1 of the first 1.");
    const k = SB.plays.findIndex((p) => p.momentKeys.includes('butker-fg'));
    expect(situationIntel(SB.plays, k, 'result', SB.teams).obvious).toBe(true);
  });

  it('gives every fact a unique, stable sit: id and a weight in 0..1', () => {
    const sit = makeSituation(SB.teams);
    for (const stage of ['result', 'announced'] as const) {
      const ids = new Set<string>();
      for (let i = 0; i < SB.plays.length; i++) {
        const facts = sit(SB.plays, i, stage).facts;
        expect(sit(SB.plays, i, stage).facts.map((f) => f.id)).toEqual(facts.map((f) => f.id));
        for (const f of facts) {
          expect(f.id.startsWith('sit:')).toBe(true);
          expect(ids.has(f.id), f.id).toBe(false);
          ids.add(f.id);
          expect(f.weight).toBeGreaterThanOrEqual(0);
          expect(f.weight).toBeLessThanOrEqual(1);
          expect(f.about.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
