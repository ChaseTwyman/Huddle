import { describe, expect, it } from 'vitest';
import { candidatesFor, Scheduler, triggerFor } from '../server/director/scheduler';
import { templateDecision } from '../server/director/templates';
import { loadFixture } from '../server/data/loadGame';
import type { KnowledgeMap } from '../shared/types';

const P = loadFixture().timeline.plays;
const byId = (id: number) => P.find((p) => p.playId === id)!;
const mastered = (ids: string[]): KnowledgeMap => Object.fromEntries(ids.map((id) => [id, { exposures: 3, recalls: 1, explainedToRoom: false }]));

describe('F6 scheduler', () => {
  it('picks candidates below Mastered, top 3 by priority, penalty first after an announcement', () => {
    const hold = byId(40);
    expect(triggerFor(hold)).toBe('penalty');
    const c = candidatesFor(hold, [{}], 'penalty');
    expect(c.map((x) => x.conceptId)).toEqual(['holding_defensive', 'automatic_first_down', 'downs']);
    expect(c[0].depth).toBe('full');
    const seen: KnowledgeMap = { holding_defensive: { exposures: 1, recalls: 0, explainedToRoom: false } };
    expect(candidatesFor(hold, [seen], 'penalty')[0]).toEqual({ conceptId: 'holding_defensive', roomLevel: 'seen', depth: 'short' });
  });

  it('stays silent (no candidates) when the room has mastered everything', () => {
    const play = byId(20);
    expect(candidatesFor(play, [mastered(play.concepts)], 'play')).toEqual([]);
    // Room level is the lowest learner: one newcomer brings the concept back.
    expect(candidatesFor(play, [mastered(play.concepts), {}], 'play').length).toBeGreaterThan(0);
  });

  it('normal: ≤ 6 budgeted explanations per quarter and ≥ 20 s between lines', () => {
    const s = new Scheduler('normal');
    let t = 0;
    for (let i = 0; i < 6; i++) {
      t += 20_000;
      expect(s.canSpeak({ trigger: 'play', now: t, qtr: 1, windowOpen: false })).toEqual({ ok: true, waitMs: 0 });
      s.spoke({ now: t, qtr: 1, countsToBudget: true });
    }
    t += 60_000;
    expect(s.canSpeak({ trigger: 'play', now: t, qtr: 1, windowOpen: false })).toEqual({ ok: false, reason: 'budget' });
    // Flags and decisions are not counted against the budget.
    expect(s.canSpeak({ trigger: 'penalty', now: t, qtr: 1, windowOpen: false }).ok).toBe(true);
    // A new quarter resets the budget.
    expect(s.canSpeak({ trigger: 'play', now: t, qtr: 2, windowOpen: false }).ok).toBe(true);
    s.spoke({ now: t, qtr: 2, countsToBudget: true });
    expect(s.canSpeak({ trigger: 'play', now: t + 19_000, qtr: 2, windowOpen: false })).toEqual({ ok: false, reason: 'gap' });
    expect(s.canSpeak({ trigger: 'play', now: t + 20_000, qtr: 2, windowOpen: false }).ok).toBe(true);
  });

  it('flag and decision turns wait out the minimum gap instead of being dropped', () => {
    const s = new Scheduler('normal');
    s.spoke({ now: 100_000, qtr: 1, countsToBudget: false });
    expect(s.canSpeak({ trigger: 'penalty', now: 105_000, qtr: 1, windowOpen: false })).toEqual({ ok: true, waitMs: 15_000 });
  });

  it('quiet: only after announcements and decision results', () => {
    const s = new Scheduler('quiet');
    expect(s.canSpeak({ trigger: 'play', now: 1e6, qtr: 1, windowOpen: false })).toEqual({ ok: false, reason: 'quiet' });
    expect(s.canSpeak({ trigger: 'penalty', now: 1e6, qtr: 1, windowOpen: false }).ok).toBe(true);
    expect(s.canSpeak({ trigger: 'decision', now: 1e6, qtr: 1, windowOpen: false }).ok).toBe(true);
  });

  it('chatty: ≤ 1 per 2 plays and a 12 s gap', () => {
    const s = new Scheduler('chatty');
    s.notePlay();
    expect(s.canSpeak({ trigger: 'play', now: 1e6, qtr: 1, windowOpen: false }).ok).toBe(true);
    s.spoke({ now: 1e6, qtr: 1, countsToBudget: true });
    s.notePlay();
    expect(s.canSpeak({ trigger: 'play', now: 1e6 + 30_000, qtr: 1, windowOpen: false })).toEqual({ ok: false, reason: 'budget' });
    s.notePlay();
    expect(s.canSpeak({ trigger: 'play', now: 1e6 + 11_000, qtr: 1, windowOpen: false })).toEqual({ ok: false, reason: 'gap' });
    expect(s.canSpeak({ trigger: 'play', now: 1e6 + 12_000, qtr: 1, windowOpen: false }).ok).toBe(true);
  });

  it('never speaks while a window is open', () => {
    for (const t of ['quiet', 'normal', 'chatty'] as const) {
      const s = new Scheduler(t);
      expect(s.canSpeak({ trigger: 'penalty', now: 1e6, qtr: 1, windowOpen: true })).toEqual({ ok: false, reason: 'window open' });
    }
  });

  it('template fallback explains the top candidate and prefers a handoff', () => {
    const cands = candidatesFor(byId(40), [{}], 'penalty');
    const d = templateDecision(cands, {});
    expect(d.action).toBe('explain');
    if (d.action !== 'silent') {
      expect(d.conceptId).toBe('holding_defensive');
      expect(d.spoken.split(/\s+/).length).toBeLessThanOrEqual(28);
      expect(d.cheat.length).toBeLessThanOrEqual(120);
    }
    const h = templateDecision(cands, { holding_defensive: ['mom'] });
    expect(h.action).toBe('handoff');
    if (h.action !== 'silent') expect(h.handoffTo).toBe('mom');
    expect(templateDecision([], {}).action).toBe('silent');
  });
});
