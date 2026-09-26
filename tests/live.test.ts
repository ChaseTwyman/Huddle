import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { VirtualClock } from '../server/room/clock';
import { Room } from '../server/room/Room';
import { LLM } from '../server/ai/llm';
import { Bots, BotTransport, DEFAULT_BOTS } from '../server/sim/bots';
import { LiveGame, ReplaySource } from '../server/live/feed';
import type { EngineEvent } from '../shared/types';
import type { EspnSummary } from '../server/live/espn';

const summary = JSON.parse(fs.readFileSync('data/fixtures/espn_2026_w3_atl_gb.json', 'utf8')) as EspnSummary;

async function runLive(delaySec: number, speed = 1) {
  const clock = new VirtualClock();
  const transport = new BotTransport(() => clock.now(), false);
  const llm = new LLM(clock, { provider: 'mock' });
  llm.quiet = true;
  const live = new LiveGame(summary, new ReplaySource(summary, clock, speed), clock);
  live.delayMs = delaySec * 1000;
  const events: { ev: EngineEvent; at: number }[] = [];
  const room = new Room('LIVE', { familyName: null, gameId: 'replay:401872948', mode: 'full', pacing: 'live', talkativeness: 'normal', voice: true, fanHandicap: true },
    { clock, transport, llm, game: live.data, live, events: { onEngineEvent: (ev, at) => events.push({ ev, at }) } });
  live.start();
  const bots = new Bots(room, clock, transport, 5);
  bots.join(DEFAULT_BOTS);
  room.startProfiles();
  bots.submitProfiles();
  await clock.run({ until: () => room.phase === 'recap', maxSteps: 3_000_000 });
  return { room, events, live, clock };
}

describe('F14 live mode (ESPN feed replayed as if live)', () => {
  it('skips storylines (none for live games), plays every play as it arrives, and reaches the recap', async () => {
    const { room, events } = await runLive(30);
    expect(room.phase).toBe('recap');
    expect(events.some((e) => e.ev.type === 'halftime')).toBe(true);
    const shown = new Set(events.filter((e) => 'play' in e.ev).map((e) => (e.ev as { play: { idx: number } }).play.idx));
    expect(shown.size).toBe(room.game.timeline.plays.length);
    expect(room.snapshot().scorebug).toMatchObject({ home: 14, away: 35 });
    expect(room.snapshot().recap?.people.length).toBe(4);
  }, 60_000);

  it('never shows a play before the family\'s TV would (feed time + delay)', async () => {
    const { room, events, live } = await runLive(30);
    for (const e of events) {
      if (e.ev.type !== 'snap') continue;
      const at = live.showAt(e.ev.play.idx);
      if (at !== null) expect(e.at, `#${e.ev.play.idx}`).toBeGreaterThanOrEqual(at);
    }
    expect(room.phase).toBe('recap');
  }, 60_000);

  it('with a 30 s delay every flag gets Call It and decisions get Predict; with no delay Predict is skipped and Call It windows shrink', async () => {
    const delayed = await runLive(30);
    const count = (r: typeof delayed, kind: 'predict' | 'callit') => [...r.room.players.values()].reduce((n, p) => n + (kind === 'callit' ? p.callItTotal : p.predictTotal), 0);
    const flags = delayed.room.game.timeline.plays.filter((p) => p.penalty).length;
    expect(flags).toBeGreaterThanOrEqual(12);
    // Each of the 4 bots answers each round it sees.
    expect(count(delayed, 'callit')).toBe(flags * 4);
    expect(count(delayed, 'predict')).toBeGreaterThanOrEqual(8 * 4);
    const synced = await runLive(0);
    // Predict must close before the snap, which a synced TV shows as soon as the feed does.
    expect(count(synced, 'predict')).toBe(0);
    // The referee announces ~20 s after the snap, so shorter Call It windows still fit for most flags.
    expect(count(synced, 'callit')).toBeGreaterThan(0);
    expect(count(synced, 'callit')).toBeLessThanOrEqual(flags * 4);
  }, 120_000);

  it('the host calibrates the delay by pressing Sync when the newest feed play snaps on their TV', async () => {
    const clock = new VirtualClock();
    const live = new LiveGame(summary, new ReplaySource(summary, clock, 1), clock, 1000);
    live.begin();
    await clock.advance(60_000);
    const latest = live.latest()!;
    expect(latest.text).toMatch(/^Q1 /);
    const feedAt = live.showAt(latest.idx)!; // delay is 0 so far
    await clock.advance(25_000); // their TV shows that snap 25 s after the feed
    expect(live.syncNow(latest.idx)).toBe(clock.now() - feedAt);
    expect(live.showAt(latest.idx)).toBe(clock.now());
    live.stop();
  });
});

describe('F14 camera flag spotter', () => {
  async function run(opts: { camera: 'at-flags' | 'none' | 'false-alarm' }) {
    const clock = new VirtualClock();
    const transport = new BotTransport(() => clock.now(), false);
    const llm = new LLM(clock, { provider: 'mock' });
    llm.quiet = true;
    // A TV in sync with live, and a feed that posts each play 30 s late (after the referee's announcement).
    const source = new ReplaySource(summary, clock, 1, 3000, 30_000);
    const live = new LiveGame(summary, source, clock);
    const room = new Room('CAM', { familyName: null, gameId: 'replay:401872948', mode: 'full', pacing: 'live', talkativeness: 'quiet', voice: true, fanHandicap: true },
      { clock, transport, llm, game: live.data, live });
    live.start();
    const bots = new Bots(room, clock, transport, 9);
    bots.join(DEFAULT_BOTS);
    room.startProfiles();
    bots.submitProfiles();
    await clock.run({ until: () => room.phase === 'live', maxSteps: 100_000 });
    const flagged = (await import('../server/live/espn')).allPlays(summary).filter((p) => p.isPenalty);
    if (opts.camera === 'at-flags') {
      // The camera sees the FLAG box 3 s after each flagged snap on the (live) TV.
      for (const p of flagged) clock.setTimeout(() => room.control('flag_seen', undefined), source.toLocal(Date.parse(p.wallclock!)) + 3000 - clock.now());
    }
    let falseAlarmStatus: string | null = null;
    if (opts.camera === 'false-alarm') {
      const clean = (await import('../server/live/espn')).allPlays(summary).find((p) => p.type.text === 'Rush' && Number(p.period.number) === 1)!;
      const at = source.toLocal(Date.parse(clean.wallclock!)) + 3000;
      clock.setTimeout(() => room.control('flag_seen', undefined), at - clock.now());
      for (let t = 1000; t <= 90_000; t += 1000) {
        clock.setTimeout(() => { const st = room.snapshot().status; if (st && /No flag|No penalty/.test(st)) falseAlarmStatus ??= st; }, at + t - clock.now());
      }
    }
    await clock.run({ until: () => room.phase === 'recap', maxSteps: 3_000_000 });
    const callIts = [...room.players.values()].reduce((n, p) => n + p.callItTotal, 0);
    return { room, callIts, flags: flagged.length, falseAlarmStatus };
  }

  it('without the camera, a late feed means Call It never fits', async () => {
    const r = await run({ camera: 'none' });
    expect(r.callIts).toBe(0);
  }, 60_000);

  it('with the camera, the family guesses as the flag appears and scoring waits for the feed', async () => {
    const r = await run({ camera: 'at-flags' });
    // Flags less than a minute apart share one round; most flags get their own.
    expect(r.callIts).toBeGreaterThanOrEqual(Math.floor(r.flags * 0.7) * 4);
    const scored = [...r.room.players.values()].some((p) => p.callItCorrect > 0);
    expect(scored).toBe(true);
  }, 60_000);

  it('a false alarm is cancelled when the next clean play comes through', async () => {
    const r = await run({ camera: 'false-alarm' });
    expect(r.falseAlarmStatus).toBe('No flag on that play after all.');
    expect(r.callIts).toBe(0);
  }, 60_000);
});
