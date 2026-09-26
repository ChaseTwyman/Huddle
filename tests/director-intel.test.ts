import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../server/room/clock';
import { Room } from '../server/room/Room';
import { LLM } from '../server/ai/llm';
import { BotTransport } from '../server/sim/bots';
import { loadGame } from '../server/data/loadGame';
import { concept } from '../server/data/concepts';
import { candidatesFor, type Trigger } from '../server/director/scheduler';
import { directorTurn, insightPool, ruleCandidates, templateTurn, ungrounded, validateDecision, type DirectorInput } from '../server/director/director';
import type { DirectorOut } from '../server/ai/schemas';
import type { IntelFact, IntelProvider, SituationIntel } from '../server/intel/types';
import type { Settings, TimelinePlay } from '../shared/types';

/**
 * PRD F6 with game intelligence: the Director stays quiet on routine decisions, says grounded insights (cited
 * intel facts) instead of obvious rule lines, never repeats a fact, and still respects the talk budget.
 * Uses a fake IntelProvider (the real producers live in server/intel/situation.ts and kb.ts).
 */
const game = loadGame('2022_22_KC_PHI');
const plays = game.timeline.plays;
const punt = plays[78]; // KC 4th & 12 at their own 34, punt: the routine call the family found obvious
const fg = plays[171]; // Butker's winning kick

const fact = (id: string, text: string, over: Partial<IntelFact> = {}): IntelFact => ({ id, kind: 'decision', text, about: [], weight: 0.8, source: 'play-by-play', ...over });
const sit = (over: Partial<SituationIntel> = {}): SituationIntel => ({ facts: [], surprise: false, obvious: false, ...over });

function inputFor(play: TimelinePlay, trigger: Trigger, intel?: DirectorInput['intel'], over: Partial<DirectorInput> = {}): DirectorInput {
  return {
    play, trigger, candidates: candidatesFor(play, [{}], trigger), handoffs: {}, names: { mom: 'Mom' }, playerFacts: [], recentLines: [],
    budget: { remainingThisQuarter: 6, exempt: trigger !== 'play' }, announced: true, league: 'nfl', teams: game.timeline.teams,
    home: game.timeline.home, away: game.timeline.away, ...(intel ? { intel } : {}), ...over,
  };
}

/** An LLM stand-in that returns one fixed decision as if the model said it, and counts calls. */
function stubLlm(out: DirectorOut) {
  const s = { calls: 0, llm: null as unknown as LLM };
  s.llm = { json: async () => { s.calls++; return { value: out, source: 'llm', ms: 5 }; } } as unknown as LLM;
  return s;
}

async function mockTurn(input: DirectorInput) {
  const clock = new VirtualClock();
  const llm = new LLM(clock, { provider: 'mock' });
  llm.quiet = true;
  const p = directorTurn(llm, input, game.timeline.home, game.timeline.away);
  await clock.run();
  return p;
}

describe('F6 Director with game intelligence', () => {
  it('obvious 4th-down punt: no decision explanation, from the template or the model', async () => {
    const obvious = { situation: sit({ obvious: true, facts: [fact('sit:dec:78', 'Punting is the textbook call on 4th and 12 from your own 34.', { weight: 0.2 })] }), facts: [] };
    const input = inputFor(punt, 'decision', obvious);
    expect(input.candidates.map((c) => c.conceptId)).toContain('fourth_down_decision');
    expect(ruleCandidates(input)).toEqual([]);
    expect(templateTurn(input).action).toBe('silent');
    // Nothing qualifies, so the model isn't even asked.
    const quiet = stubLlm({ action: 'explain', conceptId: 'fourth_down_decision', spoken: 'Teams usually punt here.', card: { title: 'Fourth down', body: 'x' }, cheat: 'x' });
    expect((await directorTurn(quiet.llm, input, 'PHI', 'KC')).action).toBe('silent');
    expect(quiet.calls).toBe(0);
    // With a strong fact on the table the model is asked, but explaining the routine decision is still rejected.
    const withFact = inputFor(punt, 'decision', { ...obvious, facts: [fact('kb:covey:1', 'Britain Covey was a Utah walk-on who went undrafted.', { kind: 'bio', about: ['B.Covey'] })] });
    const explains = stubLlm({ action: 'explain', conceptId: 'fourth_down_decision', spoken: 'Teams usually punt here.', card: { title: 'Fourth down', body: 'x' }, cheat: 'x' });
    const d = await directorTurn(explains.llm, withFact, 'PHI', 'KC');
    expect(explains.calls).toBe(1);
    expect(d).toMatchObject({ action: 'insight', cites: ['kb:covey:1'], source: 'fallback' });
    // On an ordinary play the decision concept drops out but other open rules stay.
    const asPlay = inputFor(punt, 'play', obvious);
    expect(ruleCandidates(asPlay).map((c) => c.conceptId)).not.toContain('fourth_down_decision');
    expect(ruleCandidates(asPlay).length).toBeGreaterThan(0);
  });

  it('surprise fact: the template (mock provider) says it verbatim as a cited insight', async () => {
    const surprise = fact('sit:dec:171', 'The numbers liked a field goal here at 94 percent.', { weight: 0.9 });
    const player = fact('kb:butker:1', 'Harrison Butker went undrafted out of Georgia Tech.', { kind: 'bio', about: ['H.Butker'], weight: 0.7, source: 'https://www.chiefs.com/team/players-roster/harrison-butker/' });
    const input = inputFor(fg, 'play', { situation: sit({ surprise: true, facts: [surprise] }), facts: [player] });
    expect(insightPool(input).map((f) => f.id)).toEqual(['sit:dec:171', 'kb:butker:1']);
    const d = await mockTurn(input);
    expect(d).toMatchObject({ action: 'insight', spoken: surprise.text, cites: ['sit:dec:171'], source: 'fallback' });
    // Without the surprise, a rule the room has never heard comes first (F8: learning is the point)...
    const noSurprise = inputFor(fg, 'play', { situation: sit(), facts: [player, fact('kb:weak', 'Weak.', { about: ['H.Butker'], weight: 0.3 })] });
    expect((await mockTurn(noSurprise)).action).not.toBe('insight');
    // ...but once it would only be a reminder, a fact about a player in the play replaces it; weak facts are never said.
    expect(await mockTurn(asReminders(noSurprise))).toMatchObject({ action: 'insight', cites: ['kb:butker:1'] });
    // A flag still gets its rule first (F5), even with a strong fact available.
    const flagged = plays.find((p) => p.penalty && p.penalty.conceptId === 'holding_defensive')!;
    const pen = inputFor(flagged, 'penalty', { situation: sit({ surprise: true, facts: [surprise] }), facts: [] });
    expect((await mockTurn(pen)).action).not.toBe('insight');
  });

  it('rejects model insights that are uncited, cite unknown facts, or invent numbers or names', () => {
    const f = fact('sit:wp:171', 'Kansas City win probability jumped from 52 to 97 percent on this kick.');
    const input = inputFor(fg, 'play', { situation: sit({ facts: [f] }), facts: [] });
    const good: DirectorOut = { action: 'insight', spoken: 'That kick moved Kansas City from 52 to 97 percent to win.', cites: ['sit:wp:171'] };
    expect(validateDecision(good, input)).toMatchObject({ action: 'insight', cites: ['sit:wp:171'], card: { title: 'By the numbers' } });
    expect(validateDecision({ ...good, cites: [] }, input)).toBeNull();
    expect(validateDecision({ ...good, cites: undefined }, input)).toBeNull();
    expect(validateDecision({ ...good, cites: ['kb:made-up'] }, input)).toBeNull();
    expect(validateDecision({ ...good, spoken: 'That kick moved Kansas City from 52 to 99 percent to win.' }, input)).toBeNull();
    expect(validateDecision({ ...good, spoken: 'Just like Tom Brady, that kick moved Kansas City to 97 percent.' }, input)).toBeNull();
    expect(validateDecision({ ...good, spoken: 'word '.repeat(26) }, input)).toBeNull();
    // An explanation citing a fact that wasn't offered is rejected too.
    expect(validateDecision({ action: 'explain', conceptId: 'field_goal', spoken: 'Three points.', card: { title: 'FG', body: 'x' }, cheat: 'x', cites: ['nope'] }, input)).toBeNull();
    expect(ungrounded('Mom, the 27 yard kick by Butker.', 'H.Butker 27 yard field goal Mom')).toEqual([]);
  });

  it('an invented number from the model falls back to the grounded template', async () => {
    const f = fact('sit:wp:171', 'Kansas City win probability jumped from 52 to 97 percent on this kick.');
    const input = asReminders(inputFor(fg, 'play', { situation: sit({ facts: [f] }), facts: [] }));
    const s = stubLlm({ action: 'insight', spoken: 'Kansas City is now 99 percent to win.', cites: ['sit:wp:171'] });
    const d = await directorTurn(s.llm, input, game.timeline.home, game.timeline.away);
    expect(d).toMatchObject({ action: 'insight', spoken: f.text, source: 'fallback' });
    const ok = stubLlm({ action: 'insight', spoken: 'From 52 to 97 percent on one kick.', cites: ['sit:wp:171'] });
    expect(await directorTurn(ok.llm, input, game.timeline.home, game.timeline.away)).toMatchObject({ action: 'insight', source: 'llm' });
  });
});

/** The same turn for a room that has already heard these rules once (reminders, not first explanations). */
function asReminders(input: DirectorInput): DirectorInput {
  return { ...input, candidates: input.candidates.map((c) => ({ ...c, roomLevel: 'seen' as const, depth: 'short' as const })) };
}

// ------------------------------------------------------------------ inside a real room

function fakeIntel(kb: IntelFact[]) {
  const stages: { idx: number; stage: 'result' | 'announced' }[] = [];
  const provider: IntelProvider = {
    situation(ps, idx, stage) {
      stages.push({ idx, stage });
      const p = ps[idx];
      // Every 4th down is "routine" in this fake, so the decision rule must never be explained.
      if (p.decision?.kind === 'fourth_down') {
        return { facts: [fact(`sit:dec:${idx}`, 'That was the routine call here.', { weight: 0.3 })], surprise: false, obvious: true };
      }
      if (p.result.touchdown) return { facts: [fact(`sit:wp:${idx}`, `After that score it is ${p.scoreAfter.away} to ${p.scoreAfter.home}.`, { kind: 'win_prob', weight: 0.7 })], surprise: false, obvious: false };
      return { facts: [], surprise: false, obvious: false };
    },
    // A sloppy producer that ignores `exclude`: the room must still never repeat a fact.
    retrieve: ({ entities, limit = 6 }) => kb.filter((f) => f.about.some((a) => entities.includes(a))).sort((a, b) => b.weight - a.weight).slice(0, limit),
  };
  return { provider, stages };
}

function roomWith(intel: IntelProvider, opts: Partial<Settings> = {}) {
  const clock = new VirtualClock();
  const transport = new BotTransport(() => clock.now());
  const llm = new LLM(clock, { provider: 'mock' });
  llm.quiet = true;
  const settings: Settings = { familyName: null, gameId: '2022_22_KC_PHI', mode: 'condensed', pacing: 'demo', talkativeness: 'normal', voice: true, fanHandicap: true, ...opts };
  const room = new Room('INTL', settings, { clock, transport, llm, intel });
  room.tvJoined();
  room.setProfile(room.joinPlayer({ name: 'Mom' }).id, { watch: 'dramas', rootFor: 'underdog', vibe: 'drama' });
  return { room, clock };
}

describe('F6 Director with game intelligence (room)', () => {
  const kb = [
    fact('kb:hurts:1', 'Jalen Hurts finished second in MVP voting this season.', { kind: 'career', about: ['J.Hurts'], weight: 0.9, source: 'https://www.nfl.com/' }),
    fact('kb:mahomes:1', 'Patrick Mahomes played this game on a sprained ankle.', { kind: 'bio', about: ['P.Mahomes'], weight: 0.85, source: 'https://www.nfl.com/' }),
    fact('kb:kelce:1', 'Travis Kelce and Jason Kelce are the first brothers to face each other in a Super Bowl.', { kind: 'rivalry', about: ['T.Kelce'], weight: 0.95, source: 'https://www.guinnessworldrecords.com/' }),
    fact('kb:kc:1', 'Kansas City is playing in its third Super Bowl in four seasons.', { kind: 'team', about: ['KC'], weight: 0.9, source: 'https://www.nfl.com/' }),
  ];

  it('says each fact at most once, keeps budgets and gaps, and asks for the right stage', async () => {
    const { provider, stages } = fakeIntel(kb);
    const { room, clock } = roomWith(provider);
    room.control('start_game', undefined);
    await clock.run({ until: () => room.phase === 'recap', maxSteps: 2_000_000 });

    const insights = room.spokenLog.filter((l) => l.kind === 'insight');
    expect(insights.length).toBeGreaterThan(0);
    expect(new Set(insights.map((l) => l.text)).size).toBe(insights.length);
    expect(insights.map((l) => l.text)).toContain(kb[0].text);
    // Team-only facts are left to the model; the template never says them verbatim.
    expect(insights.map((l) => l.text)).not.toContain(kb[3].text);
    // Obvious 4th downs: never the decision rule, never the low-weight "routine" fact.
    const decisionRule = concept('fourth_down_decision');
    expect(room.spokenLog.filter((l) => l.text === decisionRule.full || l.text === decisionRule.short || /routine call/.test(l.text))).toEqual([]);
    expect(room.spokenLog.some((l) => l.trigger === 'decision')).toBe(true);

    // Budget: insights and explanations share the per-quarter budget and the minimum gap.
    const lines = room.spokenLog.filter((l) => (l.kind === 'explain' || l.kind === 'short' || l.kind === 'insight') && !l.followUp);
    for (const q of [1, 2, 3, 4]) {
      const budgeted = lines.filter((l) => l.qtr === q && l.trigger === 'play').length;
      expect(room.scheduler.usedThisQuarter(q), `Q${q}`).toBe(budgeted);
      expect(budgeted).toBeLessThanOrEqual(6);
    }
    const huddle = room.spokenLog.filter((l) => (l.kind === 'explain' || l.kind === 'short' || l.kind === 'beat' || l.kind === 'insight') && !l.followUp);
    for (let i = 1; i < huddle.length; i++) expect(huddle[i].at - huddle[i - 1].endAt!).toBeGreaterThanOrEqual(19_999);

    // Stage: flagged plays are asked about only after the announcement.
    for (const s of stages) expect(s.stage, `#${s.idx}`).toBe(plays[s.idx].penalty ? 'announced' : 'result');
    expect(stages.some((s) => s.stage === 'announced')).toBe(true);
    room.dispose();
  }, 60_000);
});
