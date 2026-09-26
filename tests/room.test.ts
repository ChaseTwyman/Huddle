import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../server/room/clock';
import { Room } from '../server/room/Room';
import { LLM } from '../server/ai/llm';
import { BotTransport } from '../server/sim/bots';
import type { PlayerView, Settings } from '../shared/types';
import { loadGame } from '../server/data/loadGame';

type Policy = (playerId: string, v: PlayerView, room: Room) => void;

function harness(opts: Partial<Settings> = {}, policy?: Policy) {
  const clock = new VirtualClock();
  const transport = new BotTransport(() => clock.now());
  const llm = new LLM(clock, { provider: 'mock' });
  llm.quiet = true;
  const settings: Settings = { familyName: null, gameId: 'fixture_mini', mode: 'full', pacing: 'demo', talkativeness: 'chatty', voice: true, fanHandicap: true, ...opts };
  const offers: { kind: string; accepted: boolean; conceptId: string }[] = [];
  const room = new Room('TEST', settings, { clock, transport, llm, events: { onOffer: (o) => offers.push(o) } });
  const seen = new Set<string>();
  transport.onView = (id, v) => {
    if (!v.prompt || seen.has(`${id}:${v.prompt.id}`)) return;
    seen.add(`${id}:${v.prompt.id}`);
    policy?.(id, v, room);
  };
  room.tvJoined();
  return { clock, transport, room, offers };
}

const learnerProfile = { watch: 'dramas', rootFor: 'underdog', vibe: 'drama' } as const;

describe('F1 rooms and joining', () => {
  it('a refresh (rejoin with playerId) keeps points and role', () => {
    const { room } = harness();
    const p = room.joinPlayer({ name: 'Mom', color: '#FF6B6B' });
    room.setProfile(p.id, { ...learnerProfile, fan: true });
    p.points = 250;
    room.setConnected(p.id, false);
    const again = room.joinPlayer({ name: '', playerId: p.id });
    expect(again.id).toBe(p.id);
    expect(again.points).toBe(250);
    expect(again.role).toBe('fan');
    expect(again.connected).toBe(true);
  });
});

describe('F2 profiles and storylines', () => {
  it('assigns different pregame-safe storylines quickly, and the host can reroll one', async () => {
    const { room, clock } = harness({ gameId: '2022_22_KC_PHI' });
    const ids = ['Mom', 'Sister', 'Dad'].map((n) => room.joinPlayer({ name: n }).id);
    room.startProfiles();
    const t0 = clock.now();
    ids.forEach((id, i) => room.setProfile(id, [
      { watch: 'dramas', rootFor: 'underdog', vibe: 'drama' },
      { watch: 'reality', rootFor: 'underdog', vibe: 'chaos' },
      { watch: 'sports', rootFor: 'favorite', vibe: 'numbers' },
    ][i] as never));
    await clock.run({ until: () => room.phase === 'storylines' });
    expect(clock.now() - t0).toBeLessThan(5000);
    const stories = ids.map((id) => room.players.get(id)!.storyline!);
    expect(new Set(stories.map((s) => s.storylineId)).size).toBe(3);
    const file = loadGame('2022_22_KC_PHI').storylines;
    const laterFacts = file.storylines.flatMap((s) => s.facts).filter((f) => f.revealAfter || !f.verified).map((f) => f.text);
    for (const s of stories) for (const f of laterFacts) expect(s.hook).not.toContain(f);
    expect(stories[0].storylineId).toBe('kelce-brothers');
    const before = stories[1].storylineId;
    room.control('reroll_storyline', ids[1]);
    await clock.advance(1000);
    expect(room.players.get(ids[1])!.storyline!.storylineId).not.toBe(before);
    room.dispose();
  });
});

describe('F7 "I got this" and handoffs', () => {
  it('fan takes it: Huddle stays quiet, TV shows the fan explaining; "Still confused" triggers the short version', async () => {
    const { room, clock, transport, offers } = harness({}, (id, v, r) => {
      const p = v.prompt!;
      if (p.kind === 'takeit') clock.setTimeout(() => r.takeIt(id, p.id, true), 500);
      if (p.kind === 'done') clock.setTimeout(() => r.done(id, p.id), 3000);
      if (p.kind === 'feedback') clock.setTimeout(() => r.feedback(id, p.id, 'confused'), 500);
    });
    const fan = room.joinPlayer({ name: 'Sam' });
    room.setProfile(fan.id, { ...learnerProfile, fan: true });
    const mom = room.joinPlayer({ name: 'Mom' });
    room.setProfile(mom.id, learnerProfile);
    room.control('start_game', undefined);
    await clock.run({ until: () => offers.length > 0, maxSteps: 200000 });
    await clock.run({ until: () => room.spokenLog.some((l) => l.kind === 'short'), maxSteps: 200000 });
    expect(offers[0]).toMatchObject({ kind: 'takeit', accepted: true });
    const human = transport.messages.find((m) => m.kind === 'snapshot' && m.payload.explaining?.name === 'Sam');
    expect(human && human.kind === 'snapshot' && human.payload.card?.kind).toBe('human');
    const short = room.spokenLog.find((l) => l.kind === 'short')!;
    expect(short.followUp).toBe(true);
    expect(fan.assists).toBe(1);
    expect(fan.points).toBe(0);
    room.dispose();
  });

  it('a declined take-it falls back to Huddle within 1 second', async () => {
    let declinedAt = 0;
    const { room, clock } = harness({}, (id, v, r) => {
      const p = v.prompt!;
      if (p.kind === 'takeit') clock.setTimeout(() => { declinedAt = clock.now(); r.takeIt(id, p.id, false); }, 500);
    });
    const fan = room.joinPlayer({ name: 'Sam' });
    room.setProfile(fan.id, { ...learnerProfile, fan: true });
    room.setProfile(room.joinPlayer({ name: 'Mom' }).id, learnerProfile);
    room.control('start_game', undefined);
    await clock.run({ until: () => room.spokenLog.some((l) => l.kind === 'explain'), maxSteps: 200000 });
    const line = room.spokenLog.find((l) => l.kind === 'explain')!;
    expect(line.at - declinedAt).toBeLessThanOrEqual(1000);
    room.dispose();
  });

  it('offers a handoff to a learner who knows the rule; accepting scores +100 and masters it', async () => {
    const { room, clock, offers } = harness({ gameId: '2022_22_KC_PHI', mode: 'demo' }, (id, v, r) => {
      const p = v.prompt!;
      if (p.kind === 'handoff') clock.setTimeout(() => r.handoff(id, p.id, true), 500);
      if (p.kind === 'done') clock.setTimeout(() => r.done(id, p.id), 2000);
      if (p.kind === 'feedback') clock.setTimeout(() => r.feedback(id, p.id, 'got_it'), 500);
    });
    const mom = room.joinPlayer({ name: 'Mom' });
    const sis = room.joinPlayer({ name: 'Sister' });
    room.setProfile(mom.id, learnerProfile);
    room.setProfile(sis.id, learnerProfile);
    mom.knowledge.two_point_conversion = { exposures: 2, recalls: 1, explainedToRoom: false };
    room.control('jump', { segment: 'B' });
    await clock.run({ until: () => offers.some((o) => o.kind === 'handoff'), maxSteps: 500000 });
    const offer = offers.find((o) => o.kind === 'handoff')!;
    expect(offer).toMatchObject({ conceptId: 'two_point_conversion', accepted: true });
    await clock.run({ until: () => mom.explanations > 0, maxSteps: 500000 });
    expect(mom.knowledge.two_point_conversion.explainedToRoom).toBe(true);
    expect(mom.log.some((l) => /Explained/.test(l.text))).toBe(true);
    room.dispose();
  });
});

describe('F6 budgets inside a real room', () => {
  it('every Huddle explanation is recorded by the scheduler (budget and gap), not just by the speech log', async () => {
    const { room, clock } = harness({ gameId: '2022_22_KC_PHI', mode: 'condensed', talkativeness: 'normal' });
    room.setProfile(room.joinPlayer({ name: 'Mom' }).id, learnerProfile);
    room.control('start_game', undefined);
    await clock.run({ until: () => room.phase === 'recap', maxSteps: 2_000_000 });
    const lines = room.spokenLog.filter((l) => (l.kind === 'explain' || l.kind === 'short') && !l.followUp);
    expect(lines.length).toBeGreaterThan(10);
    for (const q of [1, 2, 3, 4]) {
      const budgeted = lines.filter((l) => l.qtr === q && l.trigger === 'play').length;
      expect(room.scheduler.usedThisQuarter(q), `Q${q}`).toBe(budgeted);
      expect(budgeted).toBeLessThanOrEqual(6);
    }
    const huddle = room.spokenLog.filter((l) => (l.kind === 'explain' || l.kind === 'short' || l.kind === 'beat') && !l.followUp);
    for (let i = 1; i < huddle.length; i++) expect(huddle[i].at - huddle[i - 1].endAt!).toBeGreaterThanOrEqual(19_999);
  });
});

describe('F6 mute', () => {
  it('mute takes effect immediately: the TV is told and no further lines are sent to speech', async () => {
    const { room, clock, transport } = harness({ gameId: '2022_22_KC_PHI', mode: 'demo' });
    room.setProfile(room.joinPlayer({ name: 'Mom' }).id, learnerProfile);
    room.control('jump', { segment: 'C' });
    await clock.advance(5000);
    room.control('voice', false);
    const mutedAt = clock.now();
    expect(transport.messages.some((m) => m.kind === 'mute' && m.payload === true && m.at === mutedAt)).toBe(true);
    await clock.run({ until: () => room.phase === 'recap', maxSteps: 500000 });
    expect(transport.messages.filter((m) => m.kind === 'speak' && m.at > mutedAt)).toHaveLength(0);
    // Captions still appear.
    expect(room.spokenLog.some((l) => l.at > mutedAt && !l.spoken)).toBe(true);
  });
});

describe('F9/F10 scoreboard and recap', () => {
  it('updates the scoreboard within 0.5 s of a reveal and has the recap ready within 8 s of the final whistle', async () => {
    const reveals: number[] = [];
    const { room, clock, transport } = harness({}, (id, v, r) => {
      const p = v.prompt!;
      if (p.kind === 'callit' || p.kind === 'predict') {
        const correct = r.simCorrectOption(p.id);
        clock.setTimeout(() => r.answer(id, p.id, correct ?? p.options[0].id), 1000);
      }
    });
    const mom = room.joinPlayer({ name: 'Mom' });
    room.setProfile(mom.id, learnerProfile);
    room.control('start_game', undefined);
    const origin = room.onEngineEvent.bind(room);
    room.onEngineEvent = async (ev) => {
      if (ev.type === 'penalty_announced') reveals.push(clock.now());
      return origin(ev);
    };
    await clock.run({ until: () => room.phase === 'recap', maxSteps: 500000 });
    expect(reveals.length).toBeGreaterThan(0);
    for (const t of reveals) {
      const snap = transport.messages.find((m) => m.kind === 'snapshot' && m.at >= t && m.payload.prompt?.reveal);
      expect(snap, `reveal at ${t}`).toBeDefined();
      expect(snap!.at - t).toBeLessThanOrEqual(500);
    }
    expect(room.recapMs).toBeLessThanOrEqual(8000);
    const recap = room.snapshot().recap!;
    const me = recap.people.find((p) => p.playerId === mom.id)!;
    expect(me.callIt.correct).toBeGreaterThan(0);
    expect(me.learnedTonight.length).toBeGreaterThan(0);
    expect(recap.groupChatText).toContain('Mom');
  });
});
