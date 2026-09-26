import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { TimelinePlay } from '../../shared/types';
import type { LLM } from '../ai/llm';
import type { EspnSummary } from '../live/espn';
import { dataPath } from '../paths';
import type { IntelFact, IntelKind, KnowledgeBase, Retriever } from './types';

/**
 * Game intelligence knowledge base: sourced player/team facts ("deep cuts") retrieved per play.
 * Replay KBs are built offline by scripts/build-kb.ts from sources as of the day before the game;
 * live KBs are built at room start by buildLiveKb from ESPN + Wikipedia summaries.
 * Every fact carries a source URL and an asOf date, and passes a deterministic spoiler filter.
 */

export const KB_KINDS = ['bio', 'career', 'matchup', 'rivalry', 'team'] as const satisfies readonly IntelKind[];
export type KbKind = (typeof KB_KINDS)[number];

/** A KB file may carry the game date so loadKb can re-check asOf (extra field; not part of KnowledgeBase). */
export type KbFile = KnowledgeBase & { gameDate?: string };

// ---------------------------------------------------------------- entity keys

const SUFFIX = /^(jr|sr|ii|iii|iv|v)$/;

/** Team abbreviations are all caps with no dot ("KC", "PHI", "TENN"). */
export const isTeamKey = (s: string) => /^[A-Z&]{2,5}$/.test(s.trim());

type NameParts = { first: string | null; last: string };

/**
 * "P.Mahomes" / "Patrick Mahomes" / "Mahomes" / "A.St. Brown" / "Michael Penix Jr." → { first, last } with the
 * last name lowercased and stripped of punctuation, spaces and suffixes; first is the lowercased first name or
 * initial prefix (null when only a surname is given).
 */
export function nameParts(raw: string): NameParts | null {
  const s = raw.trim().replace(/^#?\d+[-\s]+/, '').replace(/\s+/g, ' ');
  if (!s || isTeamKey(s)) return null;
  let first: string | null = null;
  let rest = s;
  const dot = /^([A-Za-z][A-Za-z]{0,3})\.\s?(.+)$/.exec(s);
  if (dot && !/\s/.test(dot[1])) {
    first = dot[1];
    rest = dot[2];
  } else {
    const parts = s.split(' ');
    if (parts.length > 1) {
      first = parts[0];
      rest = parts.slice(1).join(' ');
    }
  }
  const lastTokens = rest.split(/\s+/).map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean);
  while (lastTokens.length > 1 && SUFFIX.test(lastTokens[lastTokens.length - 1])) lastTokens.pop();
  const last = lastTokens.join('').replace(/-/g, '');
  if (!last) return null;
  return { first: first ? first.toLowerCase().replace(/[^a-z]/g, '') || null : null, last };
}

/** True when two entity keys refer to the same team or (probably) the same player. */
export function sameEntity(a: string, b: string): boolean {
  if (isTeamKey(a) || isTeamKey(b)) return a.trim() === b.trim();
  const x = nameParts(a);
  const y = nameParts(b);
  if (!x || !y || x.last !== y.last) return false;
  if (!x.first || !y.first) return true;
  return x.first.startsWith(y.first) || y.first.startsWith(x.first);
}

/** Play-text style key: "Patrick Mahomes" → "P.Mahomes". */
export function shortKey(firstName: string, lastName: string): string {
  const f = firstName.trim().replace(/[^A-Za-z]/g, '');
  return `${f ? f[0].toUpperCase() : ''}.${lastName.trim()}`;
}

// ---------------------------------------------------------------- play entities

const NAME_STOP = new Set(['Shotgun', 'No', 'Huddle', 'Two', 'Point', 'Conversion', 'Replay', 'Official', 'End', 'Zone', 'Kansas', 'City',
  'New', 'York', 'Green', 'Bay', 'Los', 'Angeles', 'San', 'Francisco', 'Las', 'Vegas', 'Tampa', 'Bay', 'New', 'England', 'Orleans',
  'Timeout', 'Penalty', 'Field', 'Goal', 'Extra', 'Kick', 'Touchdown', 'Play', 'Pass', 'Rush', 'Punt', 'Fair', 'Catch', 'The', 'Two-Minute', 'Warning',
  'Quarter', 'Half', 'Game', 'Defensive', 'Offensive', 'Holding', 'Interference', 'Unnecessary', 'Roughness', 'False', 'Start', 'Delay',
  'Illegal', 'Formation', 'Personal', 'Foul', 'Neutral', 'Zone', 'Infraction', 'Encroachment', 'Offside', 'Intentional', 'Grounding']);

/**
 * Entity keys for one play: the two teams, the named players (players fields), and names parsed from the public
 * play text ("P.Mahomes", ESPN college "Jalen Milroe"). The penalty player is left out by default because naming
 * him before the announcement hints at the call; pass includePenalty after the announcement.
 */
export function playEntities(play: TimelinePlay, opts: { includePenalty?: boolean } = {}): string[] {
  const out: string[] = [];
  const add = (k: string | null | undefined) => {
    const v = k?.trim();
    if (!v) return;
    if (!out.some((o) => o === v || sameEntity(o, v))) out.push(v);
  };
  if (play.posteam) add(play.posteam);
  if (play.defteam) add(play.defteam);
  const p = play.players;
  for (const k of [p.passer, p.rusher, p.receiver, p.returner, p.kicker]) add(k);
  if (opts.includePenalty) add(p.penaltyPlayer ?? play.penalty?.player);
  const text = (opts.includePenalty ? play.desc : play.publicDesc) ?? '';
  const clean = text.replace(/\(\d{1,2}:\d{2}\)/g, ' ').replace(/\((?:Shotgun|No Huddle[^)]*)\)/gi, ' ');
  for (const m of clean.matchAll(/\b([A-Z][A-Za-z]{0,3}\.\s?(?:St\.\s)?[A-Z][A-Za-z'-]+(?:\s(?:Jr\.|Sr\.|II|III|IV)(?=[\s,.)]|$))?)/g)) add(m[1].replace(/\.$/, ''));
  for (const m of clean.matchAll(/\b([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s([A-Z][a-zA-Z'-]+(?:\s(?:Jr\.|Sr\.|II|III|IV))?)\b/g)) {
    if (NAME_STOP.has(m[1]) || NAME_STOP.has(m[2])) continue;
    add(`${m[1]} ${m[2]}`);
  }
  return out;
}

// ---------------------------------------------------------------- load + retrieve

/** Reads data/kb/<gameId>.json; null when missing or malformed. Re-applies the spoiler filter as a safety net. */
export function loadKb(gameId: string, dir = dataPath('kb')): KnowledgeBase | null {
  if (!/^[\w-]+$/.test(gameId)) return null;
  const f = path.join(dir, `${gameId}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const kb = JSON.parse(fs.readFileSync(f, 'utf8')) as KbFile;
    if (!kb || !Array.isArray(kb.facts)) return null;
    const facts = kb.facts.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string' && Array.isArray(x.about)
      && !spoilerReason(x.text, kb.gameDate ?? null, x.asOf ?? null));
    return { gameId: kb.gameId ?? gameId, builtAt: kb.builtAt ?? '', facts };
  } catch {
    return null;
  }
}

/**
 * In-memory retriever. A fact that names players matches only when one of those players is in the query (team
 * abbreviations on a player fact are context, not a match); a team-only fact matches its team. Best first:
 * weight, plus a small boost per extra matched entity.
 */
export function makeRetriever(kb: KnowledgeBase | null): Retriever {
  const facts = kb?.facts ?? [];
  return ({ entities, kinds, limit = 5, exclude }) => {
    if (!facts.length || !entities.length) return [];
    const scored: { f: IntelFact; score: number }[] = [];
    for (const f of facts) {
      if (exclude?.has(f.id)) continue;
      if (kinds && kinds.length && !kinds.includes(f.kind)) continue;
      const players = f.about.filter((a) => !isTeamKey(a));
      const teams = f.about.filter(isTeamKey);
      const playerHits = players.filter((a) => entities.some((e) => sameEntity(a, e))).length;
      const teamHits = teams.filter((a) => entities.some((e) => sameEntity(a, e))).length;
      if (players.length ? playerHits === 0 : teamHits === 0) continue;
      const hits = playerHits + (players.length ? 0 : teamHits);
      scored.push({ f, score: f.weight + 0.15 * (hits - 1) + (players.length ? 0.05 : 0) });
    }
    scored.sort((a, b) => b.score - a.score || a.f.id.localeCompare(b.f.id));
    return scored.slice(0, Math.max(0, limit)).map((s) => s.f);
  };
}

// ---------------------------------------------------------------- filters

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Deterministic spoiler check. Returns a reason when the fact must be dropped: it reports the outcome of Super
 * Bowl LVII, its asOf is after the game date, or it mentions a year after the game (or a date in the game's
 * year on/after game day).
 */
export function spoilerReason(text: string, gameDate: string | null, asOf: string | null): string | null {
  if (/super bowl lvii|super bowl 57\b/i.test(text) && /\b(won|wins?|winning|mvp|champion|championship|defeat|defeated|beat|lost|loss|38|35)\b/i.test(text)) return 'LVII outcome';
  if (!gameDate) return null;
  if (asOf && asOf.slice(0, 10) > gameDate) return 'asOf after game';
  const gy = Number(gameDate.slice(0, 4));
  const gm = Number(gameDate.slice(5, 7));
  const gd = Number(gameDate.slice(8, 10));
  for (const m of text.matchAll(/\b(19|20)\d{2}\b/g)) {
    const y = Number(m[0]);
    if (y > gy) return `mentions ${y}`;
    if (y === gy) {
      // Allowed only with an explicit earlier month/day ("January 29, 2023"); a season label like "2023" is not.
      const before = text.slice(Math.max(0, (m.index ?? 0) - 20), m.index).toLowerCase();
      const md = /([a-z]+)\s+(\d{1,2}),?\s*$/.exec(before);
      const mi = md ? MONTHS.indexOf(md[1]) + 1 : 0;
      if (!mi || mi > gm || (mi === gm && Number(md![2]) >= gd)) return `mentions ${y}`;
    }
  }
  return null;
}

const GENERIC = /^[A-Z][\w.' -]+ (is|was) an? (american |professional )?(football )?(quarterback|running back|wide receiver|tight end|kicker|punter|cornerback|safety|linebacker|defensive end|defensive tackle|offensive tackle|guard|center|linebacker|long snapper|return specialist|player|football player)( for the [\w ]+?)?( of the (national football league|nfl))?\.?$/i;

/** Drop "X is an American football quarterback for the Y" style facts: true but not worth saying. */
export const isGeneric = (text: string) => {
  const t = text.replace(/\s*\([^()]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  return GENERIC.test(t) || t.split(/\s+/).length < 6;
};

const CAP_STOP = new Set(['The', 'He', 'His', 'She', 'Her', 'They', 'Their', 'In', 'As', 'After', 'At', 'On', 'During', 'With', 'Before', 'When',
  'While', 'A', 'An', 'It', 'This', 'That', 'Both', 'Since', 'Over', 'From', 'For', 'By', 'Of', 'And', 'But', 'Despite', 'Although', 'Only', 'Also',
  'His', 'Two', 'Three', 'One', 'First', 'Last', 'Along', 'Through', 'Among', 'Growing', 'Born', 'Prior', 'Following', 'Under', 'Later', 'Then',
  'Each', 'Every', 'Its', 'There', 'These', 'Those']);

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/,(?=\d{3})/g, '');

/**
 * Grounding check: every number and every capitalized word in the fact must appear in the source text (or in the
 * allowed names, e.g. the subject's name and team names). Catches most invented details.
 */
export function groundedIn(fact: string, source: string, allowed: string[] = []): boolean {
  const src = norm(`${source} ${allowed.join(' ')}`);
  for (const n of norm(fact).match(/\d+(?:\.\d+)?/g) ?? []) if (!new RegExp(`(^|[^\\d.])${n.replace('.', '\\.')}($|[^\\d])`).test(src)) return false;
  for (const w of fact.match(/\b[A-Z][A-Za-z'’.-]*[A-Za-z]/g) ?? []) {
    const bare = w.replace(/['’]s$/, '');
    if (CAP_STOP.has(bare)) continue;
    if (!src.includes(norm(bare))) return false;
  }
  return true;
}

const words = (s: string) => new Set(norm(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));

/** Jaccard overlap of content words; used to drop duplicates of storylines.json and of each other. */
export function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

// ---------------------------------------------------------------- extraction

export type RawFact = { text: string; kind: KbKind; weight: number };
export type Subject = { id: string; name: string; team: string; text: string; opponent?: string };

const toKind = (k: string): KbKind => ((KB_KINDS as readonly string[]).includes(k.toLowerCase()) ? (k.toLowerCase() as KbKind) : 'bio');
const factSchema = z.object({ text: z.string().min(10).max(400), kind: z.string(), weight: z.number() });
const batchSchema = z.object({ facts: z.array(factSchema.extend({ subject: z.string() })).max(400) });

export const EXTRACT_SYSTEM = `You extract short, sourced facts about football players and teams for a family game-night co-host that says one fact aloud between plays.
Rules:
- Use ONLY facts stated in the provided text for that subject. Never add outside knowledge, guesses, or opinions. No invented feuds: a rivalry fact needs the text to describe the conflict.
- One plain sentence each, under 30 words, safe to say aloud to a family. Name the subject in every sentence (surname is fine), never "he".
- Prefer human-interest and surprising facts: family, hometown, college path and transfers, draft story (late pick, undrafted, traded), injuries and comebacks, records and milestones, history against the opponent, documented rivalries, the team's season story.
- Skip generic facts ("X is a quarterback for Y"), bare height/weight, and bare college/draft lines unless something about them is unusual.
- Nothing about the outcome of the game being watched, and nothing that happened on or after the game date given.
- kind: "bio" (background, family, college, draft, trades), "career" (stats, awards, milestones before this game), "matchup" (history vs. the opponent), "rivalry" (documented feud or storyline between players or teams), "team" (team history or season context).
- weight 0..1: 0.8-1 for genuinely surprising or moving facts, 0.5-0.7 for solid color, 0.2-0.4 for routine career notes.
- Up to 10 facts per subject, best first. Return JSON only: {"facts":[{"subject":"<subject id>","text":"...","kind":"bio","weight":0.7}]}`;

export function extractUser(subjects: Subject[], gameDate: string, gameLabel: string): string {
  return [
    `Game being watched: ${gameLabel}, played ${gameDate}. Facts must predate it.`,
    ...subjects.map((s) => `### subject id: ${s.id}\nName: ${s.name}\nTeam: ${s.team}${s.opponent ? `\nOpponent in this game: ${s.opponent}` : ''}\nText:\n${s.text}`),
  ].join('\n\n');
}

/** Split into sentences, keeping abbreviations like "Jr." and initials together. */
export function sentences(text: string): string[] {
  const guarded = text.replace(/\b(Jr|Sr|St|Mr|Mrs|Dr|No|vs|U\.S|Mt)\./g, '$1\u0000').replace(/\b([A-Z])\./g, '$1\u0000');
  return guarded.split(/(?<=[.!?])\s+(?=[A-Z"“])|\n+/).map((s) => s.replace(/\u0000/g, '.').trim()).filter(Boolean);
}

/** No-model fallback: pick informative lead sentences (skip the generic first one). */
export function heuristicFacts(s: Subject): RawFact[] {
  const out: RawFact[] = [];
  const surname = s.name.split(' ').filter((w) => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(w)).pop() ?? s.name;
  for (const raw of sentences(s.text).slice(0, 12)) {
    if (raw.startsWith('[')) break; // lead only
    const sen = raw.replace(/\s*\([^()]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
    if (sen.length < 40 || sen.length > 240 || isGeneric(sen)) continue;
    if (/\b(he|she|they|it)\b/i.test(sen.split(' ')[0])) continue; // needs a subject name to stand alone
    if (!sen.includes(surname) && !sen.includes(s.name)) continue;
    const kind: KbKind = /\b(born|grew up|high school|college|drafted|traded|signed|father|mother|brother|son|daughter)\b/i.test(sen) ? 'bio'
      : /\b(against|versus|vs\.)\b/i.test(sen) && s.opponent && sen.includes(s.opponent) ? 'matchup'
        : /\bseason|franchise|championship|division\b/i.test(sen) && !s.name.includes(' ') ? 'team' : 'career';
    out.push({ text: sen, kind, weight: /\b(first|only|record|youngest|oldest|longest|brother|father|mother)\b/i.test(sen) ? 0.6 : 0.4 });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Extract facts for a batch of subjects with one model call; subjects the model returns nothing for (or every
 * subject, on fallback/mock) get heuristic lead sentences. Output facts are NOT yet filtered.
 */
export async function extractFacts(llm: LLM, subjects: Subject[], o: { gameDate: string; gameLabel: string; timeoutMs: number }): Promise<{ bySubject: Map<string, RawFact[]>; source: string }> {
  const bySubject = new Map<string, RawFact[]>(subjects.map((s) => [s.id, []]));
  let source = 'fallback';
  if (subjects.length && o.timeoutMs > 500) {
    const res = await llm.json({
      task: 'storylines', model: 'smart', system: EXTRACT_SYSTEM, user: extractUser(subjects, o.gameDate, o.gameLabel),
      schema: batchSchema, timeoutMs: o.timeoutMs, temperature: 0.1, fallback: () => ({ facts: [] }),
    });
    source = res.source;
    const only = subjects.length === 1 ? subjects[0].id : null;
    for (const f of res.value.facts) bySubject.get(only ?? f.subject)?.push({ text: f.text.trim(), kind: toKind(f.kind), weight: Math.min(1, Math.max(0, Number.isFinite(f.weight) ? f.weight : 0.4)) });
  }
  for (const s of subjects) if (!bySubject.get(s.id)!.length) bySubject.set(s.id, heuristicFacts(s));
  return { bySubject, source };
}

// ---------------------------------------------------------------- assembly

export type Candidate = RawFact & { slug: string; about: string[]; source: string; asOf: string; ground?: string; allowed?: string[] };
export type FilterStats = { kept: number; spoiler: number; ungrounded: number; generic: number; policy: number; storyline: number; duplicate: number; lowWeight: number; examples: { reason: string; text: string }[] };

/** Apply the spoiler, grounding, generic, betting, storyline-duplicate and duplicate filters; assign kb:<slug>:<n> ids. */
export type StoryText = string | { text: string; about: string[] };

export function assemble(cands: Candidate[], o: { gameDate: string | null; storylineTexts?: StoryText[]; minWeight?: number }): { facts: IntelFact[]; stats: FilterStats } {
  const stats: FilterStats = { kept: 0, spoiler: 0, ungrounded: 0, generic: 0, policy: 0, storyline: 0, duplicate: 0, lowWeight: 0, examples: [] };
  const drop = (reason: keyof Omit<FilterStats, 'kept' | 'examples'>, text: string) => {
    stats[reason]++;
    if (stats.examples.filter((e) => e.reason.startsWith(reason)).length < 4) stats.examples.push({ reason, text });
  };
  const kept: Candidate[] = [];
  // Best first, so a duplicate keeps its most interesting phrasing.
  for (const c of [...cands].sort((a, b) => b.weight - a.weight)) {
    const text = c.text.replace(/\s+/g, ' ').trim();
    const why = spoilerReason(text, o.gameDate, c.asOf);
    if (why) { drop('spoiler', `${text} [${why}]`); continue; }
    if (c.weight < (o.minWeight ?? 0.15)) { drop('lowWeight', text); continue; }
    if (isGeneric(text)) { drop('generic', text); continue; }
    // PRD non-goal: no betting or odds talk in a family product.
    if (/\b(betting|bettors?|odds|point spread|favou?red by|sportsbooks?|wagers?|moneyline|gambling)\b/i.test(text)) { drop('policy', text); continue; }
    // Tone: warm family co-host. No arrests, charges, conduct suspensions or violence off the field.
    if (/\b(arrest(ed)?|charged|charges|indicted|domestic|assault(ed)?|DUI|police|lawsuit|sued|jail|prison|suspen(ded|sion)|conduct policy|misdemeanor|felony|sexual)\b/i.test(text)) { drop('policy', text); continue; }
    if (c.ground !== undefined && !groundedIn(text, c.ground, c.allowed)) { drop('ungrounded', text); continue; }
    // Storyline facts about the same players are compared loosely (the storyline already tells that story);
    // everything else only drops near-verbatim repeats.
    const subject = c.about[0] ?? '';
    const sameStory = (s: StoryText) => typeof s !== 'string' && !isTeamKey(subject) && s.about.some((a) => sameEntity(a, subject));
    if (o.storylineTexts?.some((s) => overlap(typeof s === 'string' ? s : s.text, text) > (sameStory(s) ? 0.2 : 0.5))) { drop('storyline', text); continue; }
    if (kept.some((k) => (k.slug === c.slug || k.about.some((a) => !isTeamKey(a) && c.about.includes(a))) && overlap(k.text, text) > 0.6)) { drop('duplicate', text); continue; }
    kept.push({ ...c, text: /[.!?]$/.test(text) ? text : `${text}.` });
  }
  const counters = new Map<string, number>();
  const facts = kept.map((c): IntelFact => {
    const n = (counters.get(c.slug) ?? 0) + 1;
    counters.set(c.slug, n);
    return { id: `kb:${c.slug}:${n}`, kind: c.kind, text: c.text, about: [...new Set(c.about)], weight: Math.round(Math.min(1, Math.max(0, c.weight)) * 100) / 100, source: c.source, asOf: c.asOf.slice(0, 10) };
  });
  stats.kept = facts.length;
  return { facts, stats };
}

export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

/** Add keys for other known entities (full names) mentioned in the fact text. */
export function mentions(text: string, roster: { key: string; names: string[] }[]): string[] {
  const t = text.toLowerCase();
  return roster.filter((r) => r.names.some((n) => n && new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))).map((r) => r.key);
}

// ---------------------------------------------------------------- live KB

const UA = 'HuddleKB/0.1 (family game-night co-host; https://github.com/)';

async function getJson<T>(url: string, ms: number): Promise<T | null> {
  if (ms < 300) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type LooseAthlete = { id?: string; displayName?: string; firstName?: string; lastName?: string; shortName?: string };
type LooseSummary = EspnSummary & {
  boxscore?: { players?: { team?: { abbreviation?: string }; statistics?: { name?: string; athletes?: { athlete?: LooseAthlete }[] }[] }[] };
  leaders?: { team?: { abbreviation?: string }; leaders?: { leaders?: { athlete?: LooseAthlete }[] }[] }[];
};
type WikiSummary = { type?: string; title?: string; description?: string; extract?: string; content_urls?: { desktop?: { page?: string } }; timestamp?: string };
type EspnAthlete = { athlete?: { displayName?: string; college?: { name?: string }; displayDraft?: string; displayBirthPlace?: string; links?: { href?: string; rel?: string[] }[] } };

/** Top athletes from the summary's leaders, then boxscore stat groups (deduped by id, capped). */
export function liveAthletes(s: EspnSummary, cap = 20): { id: string; name: string; key: string; team: string }[] {
  const ls = s as LooseSummary;
  const out: { id: string; name: string; key: string; team: string }[] = [];
  const push = (a: LooseAthlete | undefined, team: string | undefined) => {
    if (!a?.id || !a.displayName || !team || out.some((o) => o.id === a.id)) return;
    const parts = a.displayName.split(' ');
    const first = a.firstName ?? parts[0];
    const last = a.lastName ?? parts.slice(1).join(' ');
    out.push({ id: a.id, name: a.displayName, key: shortKey(first, last), team });
  };
  for (const t of ls.leaders ?? []) for (const cat of t.leaders ?? []) for (const l of cat.leaders ?? []) push(l.athlete, t.team?.abbreviation);
  // Round-robin the boxscore groups so both teams and all positions get a share.
  const groups = (ls.boxscore?.players ?? []).flatMap((t) => (t.statistics ?? []).map((g) => ({ team: t.team?.abbreviation, list: (g.athletes ?? []).slice(0, 3) })));
  for (let i = 0; i < 3; i++) for (const g of groups) push(g.list[i]?.athlete, g.team);
  return out.slice(0, cap);
}

/**
 * Live KB from an ESPN summary: both teams plus ~20 top athletes; Wikipedia page summaries (current) and ESPN
 * athlete bios, then one or more batched model extractions. Finishes (or gives up) within budgetMs, returning
 * whatever it has; cached at data/cache/kb/<eventId>.json.
 */
export async function buildLiveKb(summary: EspnSummary, league: 'nfl' | 'college', llm: LLM, opts: { budgetMs?: number; cacheDir?: string; now?: () => number } = {}): Promise<KnowledgeBase> {
  const now = opts.now ?? Date.now;
  const started = now();
  const budget = opts.budgetMs ?? 45_000;
  const left = () => budget - (now() - started);
  const eventId = summary.header.id;
  const cacheDir = opts.cacheDir ?? dataPath('cache', 'kb');
  const cacheFile = path.join(cacheDir, `${String(eventId).replace(/[^\w-]/g, '_')}.json`);
  try {
    if (fs.existsSync(cacheFile)) {
      const kb = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as KnowledgeBase;
      if (Array.isArray(kb.facts) && kb.facts.length) return kb;
    }
  } catch { /* rebuild */ }

  const comp = summary.header.competitions[0];
  const today = new Date(started).toISOString().slice(0, 10);
  const gameDate = (comp.date ?? today).slice(0, 10);
  const teams = comp.competitors.map((c) => ({ abbr: c.team.abbreviation, name: c.team.displayName ?? `${c.team.location ?? ''} ${c.team.name ?? ''}`.trim(), homeAway: c.homeAway, nick: c.team.name ?? '', loc: c.team.location ?? '' }));
  const opp = (abbr: string) => teams.find((t) => t.abbr !== abbr);
  const athletes = liveAthletes(summary);
  const sport = league === 'college' ? 'college-football' : 'nfl';
  const wikiUrl = (t: string) => `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`;
  // Fetching may use the first ~55% of the budget; the rest is reserved for the model.
  const fetchMs = () => Math.min(8000, left() - budget * 0.45);

  const wikiFor = async (titles: string[], must: RegExp): Promise<WikiSummary | null> => {
    for (const t of titles) {
      const w = await getJson<WikiSummary>(wikiUrl(t), fetchMs());
      if (w && w.type !== 'disambiguation' && w.extract && must.test(`${w.description ?? ''} ${w.extract}`)) return w;
    }
    return null;
  };

  const cands: Candidate[] = [];
  const subjects: (Subject & { about: string[]; url: string; asOf: string; allowed: string[] })[] = [];
  const allowedTeams = teams.flatMap((t) => [t.name, t.nick, t.loc, t.abbr]);

  await Promise.all([
    ...teams.map(async (t) => {
      const titles = league === 'college' ? [`${t.name} football`, t.name] : [t.name];
      const w = await wikiFor(titles, /football/i);
      if (w?.extract) subjects.push({ id: t.abbr, name: t.name, team: t.name, opponent: opp(t.abbr)?.name, text: w.extract, about: [t.abbr], url: w.content_urls?.desktop?.page ?? wikiUrl(titles[0]), asOf: (w.timestamp ?? today).slice(0, 10), allowed: allowedTeams });
    }),
    ...athletes.map(async (a) => {
      const team = teams.find((t) => t.abbr === a.team);
      const [bio, wiki] = await Promise.all([
        getJson<EspnAthlete>(`https://site.web.api.espn.com/apis/common/v3/sports/football/${sport}/athletes/${a.id}`, fetchMs()),
        wikiFor([a.name, `${a.name} (American football)`], /american football|football player|quarterback|running back|receiver|linebacker|cornerback|kicker|tight end/i),
      ]);
      const espnUrl = bio?.athlete?.links?.find((l) => l.rel?.includes('playercard'))?.href ?? `https://www.espn.com/${sport}/player/_/id/${a.id}`;
      const about = [a.key, a.team];
      const surname = a.name.split(' ').filter((w) => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(w)).pop() ?? a.name;
      const college = bio?.athlete?.college?.name;
      if (college && league === 'nfl') cands.push({ slug: slugify(surname), kind: 'bio', text: `${a.name} played college football at ${college}.`, weight: 0.35, about, source: espnUrl, asOf: today });
      const draft = /^(\d{4}): Rd (\d+), Pk (\d+) \(([A-Z]{2,4})\)$/.exec(bio?.athlete?.displayDraft ?? '');
      if (draft && league === 'nfl') {
        const other = draft[4] !== a.team;
        cands.push({ slug: slugify(surname), kind: 'bio', text: `${a.name} was a round ${draft[2]} pick (No. ${draft[3]} overall) in the ${draft[1]} NFL Draft${other ? `, taken by ${draft[4]}` : ''}.`, weight: other || Number(draft[2]) >= 5 ? 0.55 : 0.35, about, source: espnUrl, asOf: today });
      }
      if (bio?.athlete?.displayBirthPlace) cands.push({ slug: slugify(surname), kind: 'bio', text: `${a.name} is from ${bio.athlete.displayBirthPlace}.`, weight: 0.3, about, source: espnUrl, asOf: today });
      if (wiki?.extract) subjects.push({ id: a.key, name: a.name, team: team?.name ?? a.team, opponent: opp(a.team)?.name, text: wiki.extract, about, url: wiki.content_urls?.desktop?.page ?? wikiUrl(a.name), asOf: (wiki.timestamp ?? today).slice(0, 10), allowed: [a.name, ...allowedTeams] });
    }),
  ]);

  // Batched extraction: up to 3 parallel calls sharing the remaining budget.
  if (subjects.length) {
    const size = Math.ceil(subjects.length / Math.min(3, subjects.length));
    const batches: typeof subjects[] = [];
    for (let i = 0; i < subjects.length; i += size) batches.push(subjects.slice(i, i + size));
    const label = `${teams.find((t) => t.homeAway === 'away')?.name} at ${teams.find((t) => t.homeAway === 'home')?.name}`;
    const results = await Promise.all(batches.map((b) => extractFacts(llm, b, { gameDate, gameLabel: label, timeoutMs: Math.max(0, left() - 1500) })));
    for (const r of results) {
      for (const [id, facts] of r.bySubject) {
        const s = subjects.find((x) => x.id === id)!;
        const slug = slugify(isTeamKey(id) ? id : s.name.split(' ').filter((w) => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(w)).pop() ?? id);
        const roster = athletes.map((a) => ({ key: a.key, names: [a.name] }));
        for (const f of facts) cands.push({ ...f, slug, about: [...s.about, ...mentions(f.text, roster)], source: s.url, asOf: s.asOf, ground: s.text, allowed: s.allowed });
      }
    }
  }

  // Live: asOf is "now", so only the outcome/year rules of the spoiler filter apply (no game-date cut on asOf).
  const { facts } = assemble(cands, { gameDate: null });
  const kb: KnowledgeBase = { gameId: `espn_${eventId}`, builtAt: new Date(now()).toISOString(), facts };
  if (facts.length) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(kb, null, 1));
    } catch { /* cache is best effort */ }
  }
  return kb;
}
