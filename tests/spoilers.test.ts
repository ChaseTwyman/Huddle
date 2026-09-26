import { beforeAll, describe, expect, it } from 'vitest';
import { VirtualClock } from '../server/room/clock';
import { Room } from '../server/room/Room';
import { LLM, type LlmCallRecord } from '../server/ai/llm';
import { Bots, BotTransport, DEFAULT_BOTS } from '../server/sim/bots';
import { concept } from '../server/data/concepts';
import type { EngineEvent, TimelinePlay } from '../shared/types';
import type { Recorded } from '../server/room/transport';

/**
 * PRD F5 / BUILD_PROMPT 2.3: no spoilers. Runs every play of Super Bowl LVII through a real room with
 * the virtual clock, the mock LLM, a recording transport and bot players, then scans everything that left
 * the server: snapshots, phone views, speech, and model inputs.
 */
type Ev = { ev: EngineEvent; at: number };
let messages: Recorded[] = [];
let events: Ev[] = [];
let llmCalls: LlmCallRecord[] = [];
let room: Room;

/** Text a message exposes. Call It option labels are allowed (the answer is one of four); they are removed. */
function exposed(m: Recorded): string {
  if (m.kind === 'speak') return m.payload.text;
  if (m.kind === 'snapshot') {
    const s = m.payload;
    const prompt = s.prompt ? { ...s.prompt, options: s.prompt.kind === 'callit' && !s.prompt.reveal ? [] : s.prompt.options } : null;
    return JSON.stringify({ ...s, prompt });
  }
  if (m.kind === 'playerView') {
    const v = m.payload;
    const prompt = v.prompt && v.prompt.kind === 'callit' ? { ...v.prompt, options: [] } : v.prompt;
    return JSON.stringify({ ...v, prompt });
  }
  return '';
}

const firstAt = (type: EngineEvent['type'], idx?: number) =>
  events.find((e) => e.ev.type === type && (idx === undefined || ('play' in e.ev && e.ev.play.idx === idx)))?.at;

beforeAll(async () => {
  const clock = new VirtualClock();
  const transport = new BotTransport(() => clock.now());
  const llm = new LLM(clock, { provider: 'mock' });
  llm.quiet = true;
  llm.onCall = (c) => llmCalls.push(c);
  room = new Room('SPOL', {
    familyName: null, gameId: '2022_22_KC_PHI', mode: 'full', pacing: 'demo', talkativeness: 'chatty', voice: true, fanHandicap: true,
  }, { clock, transport, llm, events: { onEngineEvent: (ev, at) => events.push({ ev, at }) } });
  room.tvJoined();
  const bots = new Bots(room, clock, transport, 3);
  bots.join(DEFAULT_BOTS.slice(0, 3)); // fan + two learners (drama, underdog/chaos)
  room.startProfiles();
  bots.submitProfiles();
  await clock.run({ until: () => room.phase === 'recap', maxSteps: 5_000_000 });
  messages = transport.messages;
}, 120_000);

describe('F5 no spoilers (automated check of every message)', () => {
  it('ran the whole game', () => {
    expect(room.phase).toBe('recap');
    expect(events.filter((e) => e.ev.type === 'penalty_announced')).toHaveLength(10);
    expect(messages.length).toBeGreaterThan(1000);
  });

  it('never names a penalty before its announcement (messages, speech, non-Call It model inputs)', () => {
    const flagged = room.game.timeline.plays.filter((p) => p.penalty);
    let checked = 0;
    for (const play of flagged) {
      const pen = play.penalty!;
      const start = firstAt('pre_snap', play.idx)!;
      const end = firstAt('penalty_announced', play.idx)!;
      expect(start, `#${play.idx} pre_snap`).toBeDefined();
      expect(end, `#${play.idx} announced`).toBeGreaterThan(start);
      const needles = [pen.rawType, pen.conceptId, concept(pen.conceptId).name].map((s) => s.toLowerCase());
      for (const m of messages) {
        if (m.at < start || m.at >= end) continue;
        const text = exposed(m).toLowerCase();
        for (const n of needles) expect(text.includes(n), `#${play.idx} ${m.kind} leaks "${n}"`).toBe(false);
        checked++;
      }
      for (const c of llmCalls) {
        if (c.at < start || c.at >= end || c.task === 'callit') continue;
        const text = (c.system + c.user).toLowerCase();
        for (const n of needles) expect(text.includes(n), `#${play.idx} ${c.task} input leaks "${n}"`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('Call It prompts never carry the answer before the reveal', () => {
    for (const m of messages) {
      if (m.kind === 'snapshot' && m.payload.prompt?.kind === 'callit' && !m.payload.prompt.reveal) {
        expect(JSON.stringify(m.payload.prompt)).not.toMatch(/correct/i);
      }
      if (m.kind === 'playerView' && m.payload.prompt?.kind === 'callit') {
        expect(Object.keys(m.payload.prompt).sort()).toEqual(['closesAt', 'id', 'kind', 'lockedOptionId', 'options', 'question']);
      }
    }
  });

  it('jump-list labels never mention penalties or results', () => {
    const snap = messages.find((m) => m.kind === 'snapshot');
    expect(snap).toBeDefined();
    if (snap?.kind !== 'snapshot') return;
    const labels = JSON.stringify(snap.payload.demo).toLowerCase();
    for (const p of room.game.timeline.plays.filter((x) => x.penalty)) {
      expect(labels).not.toContain(p.penalty!.rawType.toLowerCase());
      expect(labels).not.toContain(concept(p.penalty!.conceptId).name.toLowerCase());
    }
    expect(labels).not.toMatch(/touchdown|flag|score|turnover|interception/);
  });

  it('sends no play result before that play\'s snap', () => {
    const count = new Map<string, number>();
    for (const p of room.game.timeline.plays) count.set(p.publicDesc, (count.get(p.publicDesc) ?? 0) + 1);
    const plays: TimelinePlay[] = room.game.timeline.plays.filter((p) => p.kind !== 'penalty_only' && p.kind !== 'timeout' && p.kind !== 'end_of_period');
    for (const play of plays) {
      const pre = firstAt('pre_snap', play.idx);
      const snap = firstAt('snap', play.idx);
      if (pre === undefined || snap === undefined) continue;
      const desc = play.publicDesc.toLowerCase();
      for (const m of messages) {
        if (m.at >= snap) break;
        if (m.kind !== 'snapshot' && m.kind !== 'speak') continue;
        if (desc.length > 25 && count.get(play.publicDesc) === 1) expect(exposed(m).toLowerCase().includes(desc), `#${play.idx} result text before snap`).toBe(false);
        if (m.kind === 'snapshot' && m.at >= pre && m.payload.scorebug) {
          expect(m.payload.scorebug.home, `#${play.idx} home score before snap`).toBe(play.scoreBefore.home);
          expect(m.payload.scorebug.away, `#${play.idx} away score before snap`).toBe(play.scoreBefore.away);
        }
      }
    }
  });

  it('never reveals a storyline fact before its revealAfter moment, and never an unverified one', () => {
    const file = room.game.storylines;
    const keys = room.game.moments.keys;
    const revealTime = (key: string): number => {
      if (key === 'halftime') return firstAt('halftime')!;
      if (key === 'final') return firstAt('final')!;
      const play = room.game.timeline.plays[keys[key]];
      return play.penalty ? firstAt('penalty_announced', play.idx)! : firstAt('play_result', play.idx)!;
    };
    const facts = [...file.gameFacts, ...file.storylines.flatMap((s) => s.facts)];
    let timed = 0;
    for (const f of facts) {
      const needle = f.text.toLowerCase();
      if (!f.verified) {
        for (const m of messages) expect(exposed(m).toLowerCase().includes(needle), `unverified fact sent: ${f.text}`).toBe(false);
        for (const c of llmCalls) expect(c.user.toLowerCase().includes(needle), `unverified fact in ${c.task} input`).toBe(false);
        continue;
      }
      if (!f.revealAfter) continue;
      const t = revealTime(f.revealAfter);
      expect(t, f.revealAfter).toBeDefined();
      timed++;
      for (const m of messages) if (m.at < t) expect(exposed(m).toLowerCase().includes(needle), `early fact: ${f.text}`).toBe(false);
      for (const c of llmCalls) if (c.at < t) expect(c.user.toLowerCase().includes(needle), `early fact in ${c.task} input`).toBe(false);
    }
    expect(timed).toBeGreaterThanOrEqual(8);
  });

  it('did use the facts once they unlocked (the check can fail)', () => {
    const all = messages.map(exposed).join('\n');
    expect(all).toContain('Philadelphia led 24–14 at halftime.');
    expect(llmCalls.some((c) => c.task === 'director' && c.user.includes('I tugged his jersey'))).toBe(true);
  });
});
