import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { espnToRows, gameMeta, normalizeCollegePenalty, teamResolver, type EspnSummary } from '../server/live/espn';
import { buildTimeline } from '../server/data/timeline';
import { concept } from '../server/data/concepts';
import { buildCallIt, catalogFor, penaltyCatalog } from '../server/game/callit';
import { teamOf } from '../shared/teams';
import { VirtualClock } from '../server/room/clock';
import { Room } from '../server/room/Room';
import { LLM } from '../server/ai/llm';
import { Bots, BotTransport, DEFAULT_BOTS } from '../server/sim/bots';
import { LiveGame, ReplaySource } from '../server/live/feed';

const load = (f: string) => JSON.parse(fs.readFileSync(`data/fixtures/${f}.json`, 'utf8')) as EspnSummary;
const build = (s: EspnSummary) => {
  const m = gameMeta(s);
  return { meta: m, ...buildTimeline(espnToRows(s, 'college'), { gameId: 'x', title: m.title, date: m.date, league: 'college', teams: m.teams }, []) };
};

describe('College football: ESPN feed mapping (real 2026 games)', () => {
  for (const [file, final, home, away] of [
    ['espn_cfb_2026_tex_tenn', { home: 17, away: 20 }, 'Tennessee', 'Texas'],
    ['espn_cfb_2026_ill_osu', { home: 42, away: 19 }, 'Ohio State', 'Illinois'],
  ] as const) {
    it(`${file}: final score, school names and colors, touchdowns and tries`, () => {
      const { timeline, meta } = build(load(file));
      expect(timeline.finalScore).toEqual(final);
      expect(timeline.league).toBe('college');
      expect(teamOf(meta.home, timeline.teams).city).toBe(home);
      expect(teamOf(meta.away, timeline.teams).city).toBe(away);
      expect(teamOf(meta.home, timeline.teams).primary).toMatch(/^#[0-9a-f]{6}$/i);
      for (const p of timeline.plays) {
        const gained = p.scoreAfter.home - p.scoreBefore.home + p.scoreAfter.away - p.scoreBefore.away;
        if (p.result.touchdown) expect(gained, `TD #${p.idx}: ${p.desc.slice(0, 60)}`).toBe(6);
        if (p.kind === 'extra_point') expect([0, 1]).toContain(gained);
        if (p.kind === 'two_point') expect([0, 2]).toContain(gained);
      }
    });

    it(`${file}: every penalty parses with the school name, and public text never names it`, () => {
      const { timeline, unknownPenalties } = build(load(file));
      const flagged = timeline.plays.filter((p) => p.penalty);
      expect(flagged.length).toBeGreaterThanOrEqual(10);
      expect(unknownPenalties.filter((u) => u !== 'Chop Block')).toEqual([]);
      for (const p of flagged) {
        if (p.penalty!.status !== 'offsetting') expect(p.penalty!.announcement, p.desc).toMatch(new RegExp(`${home}|${away}`));
        expect(p.publicDesc).not.toMatch(/penalty/i);
        expect(p.publicDesc).not.toMatch(/#\d/);
      }
    });
  }

  it('reads college field goals from the feed\'s play type', () => {
    const tenn = build(load('espn_cfb_2026_tex_tenn')).timeline.plays.filter((p) => p.kind === 'field_goal');
    expect(tenn.map((p) => p.result.fieldGoal)).toEqual(['made', 'made', 'made']);
  });

  it('finds the failed two-point try hidden in a summary line', () => {
    const two = build(load('espn_cfb_2026_ill_osu')).timeline.plays.find((p) => p.kind === 'two_point')!;
    expect(two.result.twoPoint).toBe('failure');
    expect(two.decision).toEqual({ kind: 'two_point' });
  });
});

describe('College penalty text', () => {
  const resolve = teamResolver([
    { id: '1', abbreviation: 'OSU', location: 'Ohio State', name: 'Buckeyes' },
    { id: '2', abbreviation: 'ILL', location: 'Illinois', name: 'Fighting Illini' },
  ]);
  it('resolves the feed\'s team nicknames', () => {
    expect(resolve('OhioSt')).toBe('OSU');
    expect(resolve('Illini')).toBe('ILL');
    expect(resolve('ILL')).toBe('ILL');
  });
  it('turns generic names into specific ones by who committed it', () => {
    const d = normalizeCollegePenalty('Shotgun #4 K.Houser pass incomplete PENALTY OhioSt Holding (#6 D.Sanchez) 10 yards from Illini49 to Illini39. NO PLAY', resolve, 'ILL');
    expect(d.text).toBe('Shotgun #4 K.Houser pass incomplete. PENALTY on OSU-D.Sanchez, Defensive Holding, 10 yards, enforced at Illini49 - No Play.');
    const o = normalizeCollegePenalty('PENALTY Illini Pass Interference (#1 A.B) 15 yards from OhioSt30 to OhioSt45', resolve, 'ILL');
    expect(o.text).toContain('Offensive Pass Interference');
    expect(normalizeCollegePenalty('PENALTY Illini UNS: Unsportsmanlike Conduct (#83 K.Feagin) 15 yards from X11 to X26, 1ST DOWN. NO PLAY', resolve, 'OSU'))
      .toEqual({ text: 'PENALTY on ILL-K.Feagin, Unsportsmanlike Conduct, 15 yards, enforced at X11 - No Play.', firstDown: true });
    expect(normalizeCollegePenalty('X rush for 8 yards PENALTY OhioSt Holding declined', resolve, 'OSU').text).toBe('X rush for 8 yards. PENALTY on OSU, Offensive Holding, declined.');
    expect(normalizeCollegePenalty('X for 3 yards. PENALTY on KC-24-J.Bradberry, Defensive Holding, 4 yards', resolve, 'KC').text).toContain('PENALTY on KC-24-J.Bradberry'); // NFL text untouched
  });
});

describe('College rule cards and Call It', () => {
  it('uses college rules where they differ', () => {
    expect(concept('holding_defensive', 'college').autoFirstDown).toBe(false);
    expect(concept('holding_defensive', 'college').full).toMatch(/10 yards/);
    expect(concept('holding_defensive', 'nfl').autoFirstDown).toBe(true);
    expect(concept('pass_interference_defensive', 'college').full).toMatch(/15 yards/);
    expect(concept('pass_interference_defensive', 'nfl').full).toMatch(/spot of the foul/);
  });

  it('never offers an NFL-only rule in college (or targeting in the NFL)', () => {
    expect(penaltyCatalog('college')).toContain('targeting');
    expect(penaltyCatalog('college')).not.toContain('illegal_contact');
    expect(penaltyCatalog('nfl')).not.toContain('targeting');
    expect(penaltyCatalog('nfl')).toContain('illegal_contact');
    const { timeline } = build(load('espn_cfb_2026_tex_tenn'));
    for (const p of timeline.plays.filter((x) => x.penalty)) {
      expect(catalogFor(p, 'college')).not.toContain('illegal_contact');
      const round = buildCallIt(p, null, 'fallback', 'college');
      expect(round.options.map((o) => o.label)).not.toContain('Illegal contact');
      expect(round.options).toHaveLength(4);
    }
  });
});

describe('College football live room (replayed as if live)', () => {
  it('plays a whole college game with school names on the scorebug and reaches the recap', async () => {
    const summary = load('espn_cfb_2026_ill_osu');
    const clock = new VirtualClock();
    const transport = new BotTransport(() => clock.now(), false);
    const llm = new LLM(clock, { provider: 'mock' });
    llm.quiet = true;
    const live = new LiveGame(summary, new ReplaySource(summary, clock, 1), clock, 4000, 'college');
    live.delayMs = 30_000;
    const room = new Room('CFB', { familyName: null, gameId: 'replay:cfb:401858465', mode: 'full', pacing: 'live', talkativeness: 'normal', voice: true, fanHandicap: true },
      { clock, transport, llm, game: live.data, live });
    live.start();
    const bots = new Bots(room, clock, transport, 4);
    bots.join(DEFAULT_BOTS);
    room.startProfiles();
    bots.submitProfiles();
    await clock.run({ until: () => room.phase === 'recap', maxSteps: 4_000_000 });
    const snap = room.snapshot();
    expect(snap.phase).toBe('recap');
    expect(snap.game.home.city).toBe('Ohio State');
    expect(snap.game.away.city).toBe('Illinois');
    expect(snap.scorebug).toMatchObject({ home: 42, away: 19 });
    expect([...room.players.values()].reduce((n, p) => n + p.callItTotal, 0)).toBeGreaterThan(0);
  }, 90_000);
});
