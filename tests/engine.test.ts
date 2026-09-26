import { describe, expect, it } from 'vitest';
import { loadFixture, loadGame } from '../server/data/loadGame';
import { ReplayEngine } from '../server/engine/ReplayEngine';
import { VirtualClock, sleep } from '../server/room/clock';
import { WINDOWS } from '../shared/constants';
import type { EngineEvent, Mode } from '../shared/types';

type Rec = { type: string; idx?: number; at: number; text?: string };

async function runEngine(mode: Mode, gameId = 'fixture_mini', opts: { jumpSegment?: string } = {}) {
  const game = gameId === 'fixture_mini' ? loadFixture() : loadGame(gameId);
  const clock = new VirtualClock();
  const events: Rec[] = [];
  const callItClosed = new Map<number, number>();
  const handler = async (ev: EngineEvent) => {
    events.push({ type: ev.type, idx: 'play' in ev ? ev.play.idx : undefined, at: clock.now(), text: ev.type === 'summary' ? ev.text : undefined });
    if (ev.type === 'pre_snap' && ev.play.decision) await sleep(clock, WINDOWS.predictMs);
    if (ev.type === 'flag') {
      await sleep(clock, WINDOWS.callItMs);
      callItClosed.set(ev.play.idx, clock.now());
    }
  };
  const engine = new ReplayEngine(game.timeline, game.moments, clock, handler, { mode, pacing: 'demo' });
  if (opts.jumpSegment) engine.jumpToSegment(opts.jumpSegment);
  else engine.start();
  await clock.run({ until: () => engine.done, maxSteps: 100000 });
  return { events, callItClosed, game, engine };
}

const seq = (events: Rec[], idx: number) => events.filter((e) => e.idx === idx).map((e) => e.type);

describe('F3 replay engine', () => {
  it('emits the normal play sequence', async () => {
    const { events } = await runEngine('full');
    expect(seq(events, 1)).toEqual(['pre_snap', 'snap', 'play_result', 'dead_time']);
  });

  it('emits flag → penalty_announced after the result on a flagged play', async () => {
    const { events } = await runEngine('full');
    expect(seq(events, 3)).toEqual(['pre_snap', 'snap', 'play_result', 'flag', 'penalty_announced', 'dead_time']);
  });

  it('skips snap and result for a pre-snap flag', async () => {
    const { events } = await runEngine('full');
    expect(seq(events, 4)).toEqual(['pre_snap', 'flag', 'penalty_announced', 'dead_time']);
  });

  it('never announces a penalty before the Call It window closes', async () => {
    const { events, callItClosed } = await runEngine('full', '2022_22_KC_PHI');
    const announced = events.filter((e) => e.type === 'penalty_announced');
    expect(announced.length).toBe(10);
    for (const a of announced) {
      const closed = callItClosed.get(a.idx!);
      expect(closed, `#${a.idx}`).toBeDefined();
      expect(a.at).toBeGreaterThanOrEqual(closed!);
    }
  });

  it('holds the game for the Predict window on decision plays', async () => {
    const { events } = await runEngine('full');
    const pre = events.find((e) => e.idx === 7 && e.type === 'pre_snap')!; // 4th-down punt
    const snap = events.find((e) => e.idx === 7 && e.type === 'snap')!;
    expect(snap.at - pre.at).toBeGreaterThanOrEqual(WINDOWS.predictMs);
  });

  it('ends with final and emits halftime once in condensed mode with summaries', async () => {
    const { events } = await runEngine('condensed', '2022_22_KC_PHI');
    expect(events.filter((e) => e.type === 'halftime')).toHaveLength(1);
    expect(events[events.length - 1].type).toBe('final');
    const summaries = events.filter((e) => e.type === 'summary');
    expect(summaries.length).toBeGreaterThan(10);
    expect(summaries.some((s) => /Kansas City drove \d+ yards in \d+ plays\./.test(s.text!))).toBe(true);
    // Every notable play is shown; no non-notable play except the first.
    const shown = new Set(events.filter((e) => e.type === 'pre_snap' || e.type === 'dead_time').map((e) => e.idx));
    const sb = loadGame('2022_22_KC_PHI').timeline.plays;
    for (const p of sb) if (p.notable) expect(shown.has(p.idx), `#${p.idx}`).toBe(true);
  });

  it('plays only the demo segments, in order', async () => {
    const { events, game } = await runEngine('demo', '2022_22_KC_PHI');
    const idxs = [...new Set(events.filter((e) => e.idx !== undefined).map((e) => e.idx!))];
    const allowed = new Set(game.moments.segments.flatMap((s) => Array.from({ length: s.endIdx - s.startIdx + 1 }, (_, i) => s.startIdx + i)));
    for (const i of idxs) expect(allowed.has(i)).toBe(true);
    expect(idxs[0]).toBe(game.moments.segments[0].startIdx);
    expect(idxs).toContain(game.moments.keys['bradberry-flag']);
    expect(idxs).toContain(game.moments.keys['butker-fg']);
  });

  it('jumps to a segment and aborts the old loop', async () => {
    const game = loadGame('2022_22_KC_PHI');
    const clock = new VirtualClock();
    const seen: number[] = [];
    const engine = new ReplayEngine(game.timeline, game.moments, clock, async (ev) => {
      if ('play' in ev) seen.push(ev.play.idx);
    }, { mode: 'full', pacing: 'demo' });
    engine.start();
    await clock.advance(20000);
    const before = seen.length;
    expect(before).toBeGreaterThan(0);
    engine.jumpToSegment('C');
    await clock.run({ until: () => engine.done, maxSteps: 100000 });
    const after = seen.slice(before);
    expect(after[0]).toBe(game.moments.segments[2].startIdx);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(game.moments.segments[2].startIdx);
  });

  it('pauses and resumes', async () => {
    const { timeline, moments } = loadFixture();
    const clock = new VirtualClock();
    let count = 0;
    const engine = new ReplayEngine(timeline, moments, clock, async () => { count++; }, { mode: 'full', pacing: 'demo' });
    engine.start();
    await clock.advance(3000);
    engine.pause();
    await clock.advance(5000);
    const frozen = count;
    await clock.advance(60000);
    expect(count).toBe(frozen);
    engine.resume();
    await clock.advance(10000);
    expect(count).toBeGreaterThan(frozen);
  });
});
