import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLM } from '../server/ai/llm';
import { loadGame } from '../server/data/loadGame';
import { RealClock } from '../server/room/clock';
import { dataPath } from '../server/paths';
import { assemble, buildLiveKb, groundedIn, loadKb, makeRetriever, playEntities, sameEntity, spoilerReason, type Candidate } from '../server/intel/kb';
import type { IntelFact, KnowledgeBase } from '../server/intel/types';
import type { EspnSummary } from '../server/live/espn';

const fact = (id: string, about: string[], weight: number, kind: IntelFact['kind'] = 'bio'): IntelFact =>
  ({ id, kind, text: `${id} text`, about, weight, source: 'https://example.org', asOf: '2023-02-11' });

const kb: KnowledgeBase = {
  gameId: 't', builtAt: '2023-02-11',
  facts: [
    fact('kb:mahomes:1', ['P.Mahomes', 'KC'], 0.5, 'bio'),
    fact('kb:mahomes:2', ['Patrick Mahomes', 'KC'], 0.9, 'career'),
    fact('kb:kelce:1', ['T.Kelce', 'KC'], 0.8, 'bio'),
    fact('kb:jkelce:1', ['J.Kelce', 'PHI'], 0.7, 'bio'),
    fact('kb:kc:1', ['KC'], 0.6, 'team'),
    fact('kb:h2h:1', ['KC', 'PHI', 'P.Mahomes', 'J.Hurts'], 0.75, 'matchup'),
  ],
};

describe('Game intelligence: knowledge base', () => {
  describe('retriever', () => {
    const retrieve = makeRetriever(kb);

    it('normalizes player keys across play-text, full-name and surname forms', () => {
      expect(sameEntity('P.Mahomes', 'Patrick Mahomes')).toBe(true);
      expect(sameEntity('Mahomes', 'P.Mahomes')).toBe(true);
      expect(sameEntity('T.Kelce', 'Jason Kelce')).toBe(false);
      expect(sameEntity('A.St. Brown', 'Amon-Ra St. Brown')).toBe(true);
      expect(sameEntity('M.Penix Jr.', 'Michael Penix Jr.')).toBe(true);
      expect(sameEntity('KC', 'KC')).toBe(true);
      expect(sameEntity('KC', 'PHI')).toBe(false);
      const ids = (q: string[]) => retrieve({ entities: q, limit: 10 }).map((f) => f.id);
      expect(ids(['Patrick Mahomes'])).toEqual(expect.arrayContaining(['kb:mahomes:1', 'kb:mahomes:2', 'kb:h2h:1']));
      expect(ids(['P.Mahomes'])).toEqual(ids(['Patrick Mahomes']));
      expect(ids(['J.Kelce'])).toEqual(['kb:jkelce:1']);
    });

    it('orders by weight, and player facts need a player match (team abbr alone only reaches team facts)', () => {
      expect(retrieve({ entities: ['KC', 'P.Mahomes'], limit: 10 }).map((f) => f.id)).toEqual(['kb:mahomes:2', 'kb:h2h:1', 'kb:kc:1', 'kb:mahomes:1']);
      expect(retrieve({ entities: ['KC'], limit: 10 }).map((f) => f.id)).toEqual(['kb:kc:1']);
      expect(retrieve({ entities: ['KC', 'P.Mahomes'], limit: 2 })).toHaveLength(2);
    });

    it('filters by kind and honors the exclude set', () => {
      expect(retrieve({ entities: ['P.Mahomes'], kinds: ['career'] }).map((f) => f.id)).toEqual(['kb:mahomes:2']);
      expect(retrieve({ entities: ['P.Mahomes'], exclude: new Set(['kb:mahomes:2', 'kb:h2h:1']) }).map((f) => f.id)).toEqual(['kb:mahomes:1']);
    });

    it('returns [] for an empty or missing KB', () => {
      expect(makeRetriever(null)({ entities: ['P.Mahomes'] })).toEqual([]);
      expect(makeRetriever({ gameId: 'x', builtAt: '', facts: [] })({ entities: ['KC'] })).toEqual([]);
      expect(loadKb('no_such_game')).toBeNull();
    });
  });

  describe('filters', () => {
    it('drops Super Bowl LVII outcomes and anything after the game date', () => {
      expect(spoilerReason('Mahomes was named Super Bowl LVII MVP.', '2023-02-12', '2023-02-11')).not.toBeNull();
      expect(spoilerReason('Kelce signed an extension in 2024.', '2023-02-12', '2023-02-11')).not.toBeNull();
      expect(spoilerReason('Butker made a kick on February 12, 2023.', '2023-02-12', '2023-02-11')).not.toBeNull();
      expect(spoilerReason('Mahomes sprained his ankle on January 21, 2023.', '2023-02-12', '2023-02-11')).toBeNull();
      expect(spoilerReason('Mahomes was drafted in 2017.', '2023-02-12', '2023-03-01')).not.toBeNull();
      expect(spoilerReason('Mahomes was drafted in 2017.', '2023-02-12', '2023-02-11')).toBeNull();
    });

    it('rejects facts with numbers or names not in the source', () => {
      const src = 'Patrick Mahomes played college football at Texas Tech. He was drafted 10th overall in 2017.';
      expect(groundedIn('Mahomes played college football at Texas Tech.', src)).toBe(true);
      expect(groundedIn('Mahomes was drafted 12th overall in 2017.', src)).toBe(false);
      expect(groundedIn('Mahomes played baseball at Stanford.', src)).toBe(false);
    });

    it('assemble drops generic, betting, storyline-duplicate and ungrounded facts and assigns kb ids', () => {
      const c = (text: string, extra: Partial<Candidate> = {}): Candidate => ({ slug: 'mahomes', kind: 'bio', text, weight: 0.6, about: ['P.Mahomes', 'KC'], source: 's', asOf: '2023-02-11', ...extra });
      const { facts, stats } = assemble([
        c('Patrick Mahomes is an American football quarterback for the Kansas City Chiefs of the National Football League (NFL).'),
        c('The Chiefs were favored by 1.5 points in the betting line for this game.'),
        c('Patrick Mahomes is Kansas City\'s quarterback and leads the offense.'),
        c('Mahomes played baseball at Stanford before switching sports.', { ground: 'Mahomes played at Texas Tech.' }),
        c('Mahomes\'s father, Pat Mahomes, pitched in Major League Baseball.', { weight: 0.9 }),
      ], { gameDate: '2023-02-12', storylineTexts: ['Patrick Mahomes is Kansas City\'s quarterback.'] });
      expect(facts.map((f) => f.text)).toEqual(['Mahomes\'s father, Pat Mahomes, pitched in Major League Baseball.']);
      expect(facts[0].id).toBe('kb:mahomes:1');
      expect(stats).toMatchObject({ generic: 1, policy: 1, storyline: 1, ungrounded: 1 });
    });
  });

  describe('committed Super Bowl LVII KB', () => {
    const loaded = loadKb('2022_22_KC_PHI');

    it('loads with sourced, pre-game, uniquely identified facts', () => {
      expect(loaded).not.toBeNull();
      const facts = loaded!.facts;
      expect(facts.length).toBeGreaterThanOrEqual(80);
      expect(new Set(facts.map((f) => f.id)).size).toBe(facts.length);
      for (const f of facts) {
        expect(f.id).toMatch(/^kb:[a-z0-9-]+:\d+$/);
        expect(f.source, f.id).toMatch(/^https:\/\//);
        expect(f.asOf, f.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(f.asOf! <= '2023-02-12', `${f.id} asOf ${f.asOf}`).toBe(true);
        expect(['bio', 'career', 'matchup', 'rivalry', 'team']).toContain(f.kind);
        expect(f.weight).toBeGreaterThanOrEqual(0);
        expect(f.weight).toBeLessThanOrEqual(1);
        expect(f.about.length).toBeGreaterThan(0);
      }
    });

    it('contains no Super Bowl LVII result', () => {
      const bad = loaded!.facts.filter((f) => /super bowl lvii/i.test(f.text) && /won|win|mvp|champion|38|defeat/i.test(f.text));
      expect(bad).toEqual([]);
      const raw = JSON.parse(fs.readFileSync(dataPath('kb', '2022_22_KC_PHI.json'), 'utf8')) as KnowledgeBase;
      expect(raw.facts.length).toBe(loaded!.facts.length); // nothing in the committed file needed the load-time safety net
      for (const f of raw.facts) for (const m of f.text.matchAll(/\b(20\d{2})\b/g)) expect(Number(m[1]), f.text).toBeLessThanOrEqual(2023);
    });

    it('retrieves facts for the players in a real play', () => {
      const plays = loadGame('2022_22_KC_PHI').timeline.plays;
      const retrieve = makeRetriever(loaded);
      const got = retrieve({ entities: playEntities(plays[44]), limit: 5 });
      expect(got.length).toBeGreaterThan(0);
      for (const f of got) expect(f.about.some((a) => ['P.Mahomes', 'J.Smith-Schuster', 'KC', 'PHI'].includes(a))).toBe(true);
    });
  });

  describe('playEntities', () => {
    const plays = loadGame('2022_22_KC_PHI').timeline.plays;

    it('lists teams and players from the players fields and the play text', () => {
      const e = playEntities(plays[1]); // M.Sanders run, tackled by T.McDuffie
      expect(e.slice(0, 2)).toEqual(['PHI', 'KC']);
      expect(e).toEqual(expect.arrayContaining(['M.Sanders', 'T.McDuffie']));
      expect(new Set(e).size).toBe(e.length);
    });

    it('keeps the flagged player out until the announcement', () => {
      const flag = plays[164]; // the Bradberry holding call
      expect(flag.penalty).not.toBeNull();
      const before = playEntities(flag);
      expect(before).toEqual(expect.arrayContaining(['KC', 'PHI', 'P.Mahomes', 'J.Smith-Schuster']));
      expect(before.some((k) => /Bradberry/.test(k))).toBe(false);
      expect(playEntities(flag, { includePenalty: true })).toContain('J.Bradberry');
    });
  });

  describe('buildLiveKb', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('builds a sourced KB from an ESPN summary without a model, within budget, and caches it', async () => {
      const summary = {
        header: {
          id: 'test123',
          competitions: [{
            date: '2025-09-14T20:25Z', status: { type: { state: 'in' } },
            competitors: [
              { homeAway: 'home', team: { id: '12', abbreviation: 'KC', displayName: 'Kansas City Chiefs', location: 'Kansas City', name: 'Chiefs' } },
              { homeAway: 'away', team: { id: '21', abbreviation: 'PHI', displayName: 'Philadelphia Eagles', location: 'Philadelphia', name: 'Eagles' } },
            ],
          }],
        },
        leaders: [{ team: { abbreviation: 'PHI' }, leaders: [{ leaders: [{ athlete: { id: '4040715', displayName: 'Jalen Hurts', firstName: 'Jalen', lastName: 'Hurts' } }] }] }],
        boxscore: { players: [{ team: { abbreviation: 'KC' }, statistics: [{ athletes: [{ athlete: { id: '3139477', displayName: 'Patrick Mahomes', firstName: 'Patrick', lastName: 'Mahomes' } }] }] }] },
      } as unknown as EspnSummary;
      const fetchMock = vi.fn(async (url: string) => {
        const body = url.includes('/athletes/4040715') ? { athlete: { college: { name: 'Oklahoma' }, displayDraft: '2020: Rd 2, Pk 53 (PHI)', displayBirthPlace: 'Houston, TX' } }
          : url.includes('Jalen_Hurts') ? { type: 'standard', description: 'American football player (born 1998)', extract: 'Jalen Hurts is an American football quarterback for the Philadelphia Eagles of the National Football League (NFL). Hurts transferred from Alabama to Oklahoma for his final college season, where he was the Heisman Trophy runner-up.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Jalen_Hurts' } }, timestamp: '2025-09-01T00:00:00Z' }
            : null;
        return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{}', { status: 404 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-kb-'));
      const llm = new LLM(new RealClock(), { provider: 'mock' });
      llm.quiet = true;
      const t0 = Date.now();
      const built = await buildLiveKb(summary, 'nfl', llm, { cacheDir: dir, budgetMs: 10_000 });
      expect(Date.now() - t0).toBeLessThan(10_000);
      const hurts = makeRetriever(built)({ entities: ['J.Hurts'], limit: 10 });
      expect(hurts.map((f) => f.text)).toEqual(expect.arrayContaining([
        'Jalen Hurts played college football at Oklahoma.',
        expect.stringContaining('Heisman Trophy runner-up'),
      ]));
      for (const f of built.facts) {
        expect(f.source).toMatch(/^https:\/\//);
        expect(f.id).toMatch(/^kb:[a-z0-9-]+:\d+$/);
      }
      expect(fs.existsSync(path.join(dir, 'test123.json'))).toBe(true);
      fetchMock.mockClear();
      const again = await buildLiveKb(summary, 'nfl', llm, { cacheDir: dir });
      expect(again.facts).toEqual(built.facts);
      expect(fetchMock).not.toHaveBeenCalled();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
