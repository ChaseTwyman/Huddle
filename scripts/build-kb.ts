/**
 * npx tsx scripts/build-kb.ts --game 2022_22_KC_PHI [--no-llm] [--players 30]
 *
 * Builds the replay knowledge base (game intelligence "deep cuts") for one game:
 *  1. the ~30 most involved players from nflverse play-by-play, plus storyline players and both teams;
 *  2. nflverse players.csv → full name, college, draft (deterministic bio facts);
 *  3. Wikipedia pages as of the day before the game (MediaWiki revisions API), stripped to prose;
 *  4. atomic fact extraction with the configured model (LLM_PROVIDER), or lead-sentence heuristics without one;
 *  5. deterministic filters: spoilers, grounding, generic, betting, storyline duplicates, duplicates;
 *  6. head-to-head, coach history and season records from nflverse schedules (games before the game date).
 * Writes data/kb/<game>.json and prints a summary.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import { LLM } from '../server/ai/llm';
import { RealClock } from '../server/room/clock';
import { loadGame } from '../server/data/loadGame';
import { dataPath } from '../server/paths';
import { TEAMS } from '../shared/teams';
import { assemble, extractFacts, mentions, slugify, type Candidate, type KbFile, type Subject } from '../server/intel/kb';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const gameId = arg('game') ?? '2022_22_KC_PHI';
const useLlm = !process.argv.includes('--no-llm');
const maxPlayers = Number(arg('players') ?? 30);

const UA = 'HuddleKB/0.1 (hackathon family game-night app; build-time fact extraction; contact skothari67@gatech.edu)';
const PLAYERS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/players/players.csv';
const SCHEDULES_URL = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';

type Csv = Record<string, string>;

async function cached(url: string, file: string): Promise<string> {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return fs.readFileSync(file, 'utf8');
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

async function gameRows(season: number, id: string): Promise<Csv[]> {
  const file = dataPath('raw', `play_by_play_${season}.csv.gz`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run: npm run fetch-game`);
  const rows: Csv[] = [];
  const parser = fs.createReadStream(file).pipe(zlib.createGunzip()).pipe(parse({ columns: true, relax_column_count: true }));
  for await (const r of parser as AsyncIterable<Csv>) if (r.game_id === id) rows.push(r);
  return rows;
}

// ---------------------------------------------------------------- involvement

type Involved = { id: string; key: string; team: string; score: number; roles: Set<string>; votes?: Map<string, number> };

const ROLES: { col: string; side: 'off' | 'def' | 'ret' | 'pen' | 'col'; w: number; role: string }[] = [
  { col: 'passer_player', side: 'off', w: 1, role: 'passer' },
  { col: 'rusher_player', side: 'off', w: 1, role: 'rusher' },
  { col: 'receiver_player', side: 'off', w: 1.2, role: 'receiver' },
  { col: 'kicker_player', side: 'off', w: 3, role: 'kicker' },
  { col: 'punter_player', side: 'off', w: 1, role: 'punter' },
  { col: 'punt_returner_player', side: 'ret', w: 3, role: 'returner' },
  { col: 'kickoff_returner_player', side: 'ret', w: 3, role: 'returner' },
  { col: 'interception_player', side: 'def', w: 6, role: 'interception' },
  { col: 'sack_player', side: 'def', w: 5, role: 'sack' },
  { col: 'half_sack_1_player', side: 'def', w: 3, role: 'sack' },
  { col: 'half_sack_2_player', side: 'def', w: 3, role: 'sack' },
  { col: 'penalty_player', side: 'pen', w: 4, role: 'penalty' },
  { col: 'td_player', side: 'col', w: 5, role: 'touchdown' },
  { col: 'forced_fumble_player_1_player', side: 'def', w: 4, role: 'forced fumble' },
  { col: 'fumble_recovery_1_player', side: 'col', w: 4, role: 'fumble recovery' },
  { col: 'qb_hit_1_player', side: 'def', w: 1, role: 'qb hit' },
  { col: 'pass_defense_1_player', side: 'def', w: 1.5, role: 'pass defense' },
  { col: 'solo_tackle_1_player', side: 'def', w: 0.4, role: 'tackle' },
  { col: 'tackle_for_loss_1_player', side: 'def', w: 1.5, role: 'tackle for loss' },
];

function involvement(rows: Csv[]): Map<string, Involved> {
  const out = new Map<string, Involved>();
  for (const r of rows) {
    for (const { col, side, w, role } of ROLES) {
      const id = r[`${col}_id`];
      const name = r[`${col}_name`];
      if (!id || id === 'NA' || !name || name === 'NA') continue;
      // nflverse lists the receiving team as posteam on kickoffs, so the kicker is on defteam and the returner on posteam.
      const kickoff = r.play_type === 'kickoff';
      const s = kickoff && side === 'off' ? 'def' : kickoff && side === 'ret' ? 'off' : side;
      const team = s === 'off' ? r.posteam : s === 'def' || s === 'ret' ? r.defteam : s === 'pen' ? r.penalty_team
        : r[col.replace(/_player$/, '_team')] || r.td_team || r.posteam;
      if (!team || team === 'NA') continue;
      const cur = out.get(id) ?? { id, key: name, team, score: 0, roles: new Set<string>(), votes: new Map<string, number>() };
      cur.score += w;
      cur.roles.add(role);
      cur.votes!.set(team, (cur.votes!.get(team) ?? 0) + 1);
      out.set(id, cur);
    }
  }
  // A player's team is the majority over all his roles.
  for (const p of out.values()) p.team = [...p.votes!.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return out;
}

// ---------------------------------------------------------------- wikitext

const POS_WORD: Record<string, string> = {
  QB: 'quarterback', RB: 'running back', FB: 'fullback', WR: 'wide receiver', TE: 'tight end', K: 'kicker', P: 'punter', CB: 'cornerback',
  S: 'safety', SS: 'safety', FS: 'safety', DB: 'cornerback', LB: 'linebacker', ILB: 'linebacker', OLB: 'linebacker', MLB: 'linebacker',
  DE: 'defensive end', DT: 'defensive tackle', NT: 'defensive tackle', T: 'offensive tackle', OT: 'offensive tackle', G: 'guard', OG: 'guard',
  C: 'center', LS: 'long snapper',
};

function renderTemplate(inner: string): string {
  const parts = inner.split('|').map((p) => p.trim());
  const name = parts[0].toLowerCase().replace(/_/g, ' ');
  const pos = parts.slice(1).filter((p) => !/^[\w ]+=/.test(p));
  const named = (k: string) => parts.find((p) => p.toLowerCase().startsWith(`${k}=`))?.split('=').slice(1).join('=').trim();
  if (['nowrap', 'nobr', 'small', 'nbsp', 'lang'].includes(name)) return pos.slice(name === 'lang' ? 1 : 0).join(' ');
  if (name === 'sortname') return pos.slice(0, 2).join(' ');
  if (/^(nfl ?year|nfly|nfl season|nflplayoff year|nfl draft|cfb year|cfby|mlby|nba ?year|sby|super bowl)$/.test(name)) return pos[0] ?? '';
  if (name === 'cfb link') return named('title') ?? named('team') ?? '';
  if (name === 'convert') return pos.slice(0, 2).join(' ');
  if (name === 'frac') return pos.join('/');
  if (/^(birth date|birth date and age|death date|dob|start date)$/.test(name) && pos.length >= 3) {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${months[Number(pos[1]) - 1] ?? ''} ${Number(pos[2])}, ${pos[0]}`;
  }
  if (/^(ill|interlanguage link)$/.test(name)) return pos[0] ?? '';
  return '';
}

/** Wikitext → sections of plain prose (lead plus non-junk sections). */
export function wikiSections(src: string): { heading: string; text: string }[] {
  let t = src.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<gallery[\s\S]*?<\/gallery>/gi, '');
  for (let i = 0; i < 20; i++) {
    const next = t.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => renderTemplate(inner));
    if (next === t) break;
    t = next;
  }
  t = t.replace(/\{\|[\s\S]*?\n\|\}/g, '');
  for (let i = 0; i < 10; i++) {
    const next = t.replace(/\[\[([^[\]]*)\]\]/g, (_, inner: string) => (/^(file|image|category|media):/i.test(inner) ? '' : inner.split('|').pop() ?? ''));
    if (next === t) break;
    t = next;
  }
  t = t.replace(/\[https?:\/\/\S+\s([^\]]*)\]/g, '$1').replace(/\[https?:\/\/\S+\]/g, '')
    .replace(/'''?/g, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&amp;/g, '&');
  const out: { heading: string; text: string }[] = [];
  let heading = 'Lead';
  let buf: string[] = [];
  const flush = () => {
    const text = buf.filter((l) => l.trim() && !/^[*#:;|!{}]/.test(l.trim()) && l.trim().length > 40).join('\n').replace(/\(\s*[;,]?\s*\)/g, '').replace(/ {2,}/g, ' ').replace(/\s+([,.;])/g, '$1').trim();
    if (text) out.push({ heading, text });
    buf = [];
  };
  for (const line of t.split('\n')) {
    const h = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line);
    if (h) { flush(); heading = h[2]; continue; }
    buf.push(line);
  }
  flush();
  return out.filter((s) => !/^(references|external links|see also|notes|further reading|statistics|career statistics|nfl career statistics|college statistics|regular season|postseason statistics|records|bibliography|filmography|awards and highlights|roster|staff|draft|schedule|standings|preseason|team leaders|stats)$/i.test(s.heading));
}

/** Plain text for the model: lead and early/personal/college sections first, then the latest pro sections, capped. */
function textFor(sections: { heading: string; text: string }[], cap = 16000): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/[^.]*$/, '')}` : s);
  const pri = (h: string) => (h === 'Lead' ? 0 : /early|personal|high school|college|family|background|life/i.test(h) ? 1 : /2022|2021|playoff|post/i.test(h) ? 2 : 3);
  const chosen = sections.map((s, i) => ({ ...s, i, text: clip(s.text, s.heading === 'Lead' ? 4000 : 2500) }));
  const ordered = [...chosen].sort((a, b) => pri(a.heading) - pri(b.heading) || (pri(a.heading) === 3 ? b.i - a.i : a.i - b.i));
  const keep: typeof chosen = [];
  let total = 0;
  for (const s of ordered) {
    if (total + s.text.length > cap) continue;
    keep.push(s);
    total += s.text.length;
  }
  return keep.sort((a, b) => a.i - b.i).map((s) => (s.heading === 'Lead' ? s.text : `[${s.heading}]\n${s.text}`)).join('\n\n');
}

type WikiPage = { title: string; revid: number; timestamp: string; content: string };

async function wikiAsOf(title: string, rvstart: string): Promise<WikiPage | null> {
  const file = dataPath('raw', 'wiki', `${slugify(title)}.json`);
  if (fs.existsSync(file)) {
    const hit = JSON.parse(fs.readFileSync(file, 'utf8')) as WikiPage | { missing: true };
    return 'missing' in hit ? null : hit;
  }
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=ids|content|timestamp&rvslots=main&rvlimit=1&rvstart=${encodeURIComponent(rvstart)}&rvdir=older&titles=${encodeURIComponent(title)}&format=json&formatversion=2&redirects=1`;
  let json: { query?: { pages?: { title: string; missing?: boolean; revisions?: { revid: number; timestamp: string; slots?: { main?: { content?: string } } }[] }[] } } | null = null;
  for (let attempt = 0; attempt < 3 && !json; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) json = await res.json();
      else await new Promise((r) => setTimeout(r, 1500));
    } catch { await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (!json) return null; // network trouble: don't cache
  const page = json.query?.pages?.[0];
  const rev = page?.revisions?.[0];
  const result = page && !page.missing && rev?.slots?.main?.content ? { title: page.title, revid: rev.revid, timestamp: rev.timestamp, content: rev.slots.main.content } : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result ?? { missing: true }));
  return result;
}

const isDisambig = (c: string) => /\{\{\s*(disambiguation|hndis|dab|disambig|set index|human name disambiguation)/i.test(c) || /may (also )?refer to:/i.test(c.slice(0, 600));
const redirectTarget = (c: string) => /^#REDIRECT\s*\[\[([^\]|#]+)/i.exec(c.trim())?.[1];

async function findPlayerPage(name: string, pos: string, college: string, rvstart: string): Promise<WikiPage | null> {
  const titles = [name, `${name} (American football)`, `${name} (${POS_WORD[pos] ?? 'American football'})`].filter((t, i, a) => a.indexOf(t) === i);
  const collegeToken = college.split(/[;,]/)[0].trim().split(' ')[0];
  for (const t of titles) {
    let page = await wikiAsOf(t, rvstart);
    const target = page && redirectTarget(page.content);
    if (target) page = await wikiAsOf(target, rvstart);
    if (!page || isDisambig(page.content)) continue;
    const head = page.content.slice(0, 20000);
    if (!/american football|Infobox NFL|Infobox gridiron/i.test(head)) continue;
    if (collegeToken && collegeToken.length > 2 && !head.includes(collegeToken)) continue;
    return page;
  }
  return null;
}

// ---------------------------------------------------------------- schedule facts

const teamName = (a: string) => (TEAMS[a] ? `${TEAMS[a].city} ${TEAMS[a].name}` : a);
const city = (a: string) => TEAMS[a]?.city ?? a;
const longDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function scheduleFacts(games: Csv[], home: string, away: string, gameDate: string, season: number, keyByName: Map<string, string>): Candidate[] {
  const out: Candidate[] = [];
  const src = SCHEDULES_URL;
  const before = games.filter((g) => g.gameday < gameDate && g.home_score !== '' && g.home_score !== 'NA');
  const h2h = before.filter((g) => (g.home_team === home && g.away_team === away) || (g.home_team === away && g.away_team === home));
  const winner = (g: Csv) => (Number(g.home_score) > Number(g.away_score) ? g.home_team : Number(g.home_score) < Number(g.away_score) ? g.away_team : null);
  const score = (g: Csv) => { const a = Number(g.home_score); const b = Number(g.away_score); return `${Math.max(a, b)}–${Math.min(a, b)}`; };
  const asOfOf = (gs: Csv[]) => gs.map((g) => g.gameday).sort().pop() ?? gameDate;
  const qbKey = (name: string) => keyByName.get(name);
  if (h2h.length) {
    const last = h2h[h2h.length - 1];
    const w = winner(last);
    const qbs = [last.away_qb_name, last.home_qb_name].filter((n) => n && n !== 'NA');
    const qbInGame = qbs.filter((n) => qbKey(n));
    out.push({
      slug: 'h2h', kind: 'matchup', weight: 0.75, source: src, asOf: last.gameday,
      about: [home, away, ...qbInGame.map((n) => qbKey(n)!)],
      text: `${city(home)} and ${city(away)} last met on ${longDate(last.gameday)}, when ${w ? `${city(w)} won ${score(last)}` : `they tied ${score(last)}`} in ${city(last.home_team)}${qbInGame.length === 2 ? `, with ${qbs[0]} and ${qbs[1]} at quarterback` : ''}.`,
    });
    const first = h2h[0];
    const wins = (t: string) => h2h.filter((g) => winner(g) === t).length;
    out.push({
      slug: 'h2h', kind: 'matchup', weight: 0.5, source: src, asOf: asOfOf(h2h),
      about: [home, away],
      text: `Since the ${first.season} season, ${city(away)} and ${city(home)} had met ${h2h.length} times before this game: ${city(away)} won ${wins(away)} and ${city(home)} won ${wins(home)}.`,
    });
    if (h2h.every((g) => g.game_type === 'REG')) {
      out.push({ slug: 'h2h', kind: 'matchup', weight: 0.55, source: src, asOf: asOfOf(h2h), about: [home, away], text: `Every meeting between ${city(away)} and ${city(home)} since ${first.season} had been a regular-season game; they had not met in the playoffs in that span.` });
    }
  }
  // Coaches who used to coach the opponent (e.g. Andy Reid in Philadelphia).
  const cur = before.filter((g) => Number(g.season) === season);
  const coachOf = (t: string) => { const g = [...cur].reverse().find((x) => x.home_team === t || x.away_team === t); return g ? (g.home_team === t ? g.home_coach : g.away_coach) : undefined; };
  for (const [team, opp] of [[home, away], [away, home]]) {
    const coach = coachOf(team);
    if (!coach) continue;
    const seasonsWithOpp = [...new Set(before.filter((g) => (g.home_team === opp && g.home_coach === coach) || (g.away_team === opp && g.away_coach === coach)).map((g) => Number(g.season)))].sort((a, b) => a - b);
    if (seasonsWithOpp.length) {
      const firstWithTeam = Math.min(...before.filter((g) => (g.home_team === team && g.home_coach === coach) || (g.away_team === team && g.away_coach === coach)).map((g) => Number(g.season)));
      out.push({
        slug: 'coach', kind: 'rivalry', weight: 0.9, source: src, asOf: asOfOf(before), about: [team, opp],
        text: `${coach} coached ${city(opp)} for ${seasonsWithOpp.length} seasons (${seasonsWithOpp[0]}–${seasonsWithOpp[seasonsWithOpp.length - 1]}) before becoming ${city(team)}'s head coach in ${firstWithTeam}.`,
      });
      const vs = before.filter((g) => Number(g.season) >= firstWithTeam && ((g.home_team === team && g.away_team === opp) || (g.home_team === opp && g.away_team === team)) && (g.home_coach === coach || g.away_coach === coach));
      if (vs.length) {
        const w = vs.filter((g) => winner(g) === team).length;
        out.push({ slug: 'coach', kind: 'rivalry', weight: 0.8, source: src, asOf: asOfOf(vs), about: [team, opp], text: `As ${city(team)}'s coach, ${coach} was ${w}–${vs.length - w} against his old team, ${teamName(opp)}, before this game (${vs.map((g) => g.season).join(', ')}).` });
      }
    }
  }
  // Season records and playoff path.
  const roundName: Record<string, string> = { WC: 'wild-card round', DIV: 'divisional round', CON: 'conference championship game' };
  for (const team of [away, home]) {
    const reg = cur.filter((g) => g.game_type === 'REG' && (g.home_team === team || g.away_team === team));
    const w = reg.filter((g) => winner(g) === team).length;
    const l = reg.filter((g) => winner(g) && winner(g) !== team).length;
    const t = reg.length - w - l;
    if (reg.length) out.push({ slug: slugify(team), kind: 'team', weight: 0.45, source: src, asOf: asOfOf(reg), about: [team], text: `${teamName(team)} went ${w}–${l}${t ? `–${t}` : ''} in the ${season} regular season.` });
    const post = cur.filter((g) => g.game_type !== 'REG' && g.game_type !== 'SB' && (g.home_team === team || g.away_team === team));
    const path2 = post.map((g) => { const o = g.home_team === team ? g.away_team : g.home_team; return `${winner(g) === team ? 'beat' : 'lost to'} ${city(o)} ${score(g)} in the ${roundName[g.game_type] ?? 'playoffs'}`; });
    if (path2.length) out.push({ slug: slugify(team), kind: 'team', weight: 0.55, source: src, asOf: asOfOf(post), about: [team], text: `On the way here, ${city(team)} ${path2.join(', then ')}.` });
  }
  return out;
}

// ---------------------------------------------------------------- main

async function main() {
  const { timeline, storylines } = loadGame(gameId);
  const gameDate = timeline.date;
  const season = Number(gameId.split('_')[0]);
  const eve = new Date(Date.parse(`${gameDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const rvstart = `${eve}T00:00:00Z`;
  const { home, away } = timeline;
  const label = `${timeline.title} (${teamName(away)} vs. ${teamName(home)})`;
  console.log(`Building KB for ${gameId} (${label}); sources as of ${eve}; model: ${useLlm ? process.env.LLM_PROVIDER ?? 'mock' : 'off'}`);

  const rows = await gameRows(season, gameId);
  const inv = involvement(rows);
  const playersCsv = parseSync(await cached(PLAYERS_URL, dataPath('raw', 'players.csv')), { columns: true, relax_column_count: true }) as Csv[];
  const byId = new Map(playersCsv.map((p) => [p.gsis_id, p]));
  const games = parseSync(await cached(SCHEDULES_URL, dataPath('raw', 'games.csv')), { columns: true, relax_column_count: true }) as Csv[];

  // Pick the most involved players, plus storyline players (e.g. Jason Kelce never touches the ball in play text).
  const picked = [...inv.values()].sort((a, b) => b.score - a.score).slice(0, maxPlayers);
  for (const sl of storylines.storylines) for (const sp of sl.players) {
    if (picked.some((p) => p.key === sp.pbpNames[0])) continue;
    const row = playersCsv.find((p) => p.display_name === sp.name && (p.latest_team === sp.team || Number(p.last_season) >= season));
    if (row) picked.push({ id: row.gsis_id, key: sp.pbpNames[0] ?? row.short_name, team: sp.team, score: 0, roles: new Set(['storyline']) });
  }
  console.log(`Players: ${picked.map((p) => `${p.key}/${p.team}`).join(', ')}`);
  const roster = picked.map((p) => ({ key: p.key, names: [byId.get(p.id)?.display_name ?? ''] }));
  const keyByName = new Map(picked.map((p) => [byId.get(p.id)?.display_name ?? p.key, p.key]));
  const teamAllowed = [home, away].flatMap((t) => [TEAMS[t]?.city ?? '', TEAMS[t]?.name ?? '', t]);
  const storylineTexts = [
    ...storylines.gameFacts.map((f) => f.text),
    ...storylines.storylines.flatMap((s) => s.facts.map((f) => ({ text: f.text, about: s.players.flatMap((p) => p.pbpNames) }))),
  ];

  const cands: Candidate[] = [];
  const subjects: (Subject & { about: string[]; url: string; asOf: string; allowed: string[]; slug: string })[] = [];
  const missingWiki: string[] = [];

  // Player sources.
  for (const p of picked) {
    const row = byId.get(p.id);
    if (!row) { console.warn(`  no nflverse player row for ${p.key} (${p.id})`); continue; }
    const name = row.display_name;
    const slug = slugify(row.last_name || name.split(' ').pop() || p.key);
    const about = [p.key, p.team];
    const opp = p.team === home ? away : home;
    const colleges = (row.college_name || '').split(';').map((c) => c.trim()).filter((c) => c && c !== 'NA');
    if (colleges.length) {
      cands.push({ slug, kind: 'bio', about, source: PLAYERS_URL, asOf: eve, weight: colleges.length > 1 ? 0.5 : 0.4,
        text: colleges.length > 1 ? `${name} played college football at ${colleges.slice(0, -1).join(', ')} and then ${colleges[colleges.length - 1]}.` : `${name} played college football at ${colleges[0]}.` });
    }
    const dy = Number(row.draft_year);
    if (dy && dy <= season && row.draft_round && row.draft_pick && row.draft_team) {
      const rd = Number(row.draft_round);
      const other = row.draft_team !== p.team;
      cands.push({ slug, kind: 'bio', about, source: PLAYERS_URL, asOf: eve,
        weight: other ? 0.6 : rd >= 5 ? 0.55 : 0.4,
        text: `${name} was drafted by the ${teamName(row.draft_team)} in round ${rd} (No. ${Number(row.draft_pick)} overall) of the ${dy} NFL Draft${other ? `, before landing with the ${TEAMS[p.team]?.name ?? p.team}` : ''}.` });
    }
    const page = await findPlayerPage(name, row.position, row.college_name || '', rvstart);
    if (!page) { missingWiki.push(name); continue; }
    const text = textFor(wikiSections(page.content));
    subjects.push({ id: p.key, slug, name, team: teamName(p.team), opponent: teamName(opp), text, about, url: `https://en.wikipedia.org/w/index.php?oldid=${page.revid}`, asOf: page.timestamp.slice(0, 10), allowed: [name, ...teamAllowed] });
  }

  // Team, coach and pre-game Super Bowl pages (about = team abbreviations).
  const teamPages: { title: string; slug: string; about: string[]; team: string; name: string }[] = [
    ...[away, home].flatMap((t) => [
      { title: teamName(t), slug: slugify(t), about: [t], team: teamName(t), name: teamName(t) },
      { title: `${season} ${teamName(t)} season`, slug: slugify(t), about: [t], team: teamName(t), name: `the ${season} ${teamName(t)}` },
    ]),
  ];
  const coachOf = (t: string) => { const g = [...games].reverse().find((x) => Number(x.season) === season && x.gameday < gameDate && (x.home_team === t || x.away_team === t)); return g ? (g.home_team === t ? g.home_coach : g.away_coach) : undefined; };
  for (const t of [away, home]) { const c = coachOf(t); if (c) teamPages.push({ title: c, slug: slugify(c.split(' ').pop() ?? c), about: [t], team: teamName(t), name: c }); }
  if (/^Super Bowl/.test(timeline.title)) teamPages.push({ title: timeline.title, slug: 'preview', about: [away, home], team: `${teamName(away)} and ${teamName(home)}`, name: `${timeline.title} (pre-game preview only)` });
  for (const tp of teamPages) {
    let page = await wikiAsOf(tp.title, rvstart);
    const target = page && redirectTarget(page.content);
    if (target) page = await wikiAsOf(target, rvstart);
    if (!page || isDisambig(page.content)) { missingWiki.push(tp.title); continue; }
    subjects.push({ id: tp.title, slug: tp.slug, name: tp.name, team: tp.team, text: textFor(wikiSections(page.content), 14000), about: tp.about, url: `https://en.wikipedia.org/w/index.php?oldid=${page.revid}`, asOf: page.timestamp.slice(0, 10), allowed: [tp.name, ...teamAllowed] });
  }
  console.log(`Sources: ${picked.length} players, ${subjects.length} Wikipedia pages (as of ${eve}); missing: ${missingWiki.join(', ') || 'none'}`);

  // Extraction (one subject per call; the LLM limiter bounds concurrency).
  const llm = new LLM(new RealClock(), useLlm ? {} : { provider: 'mock' });
  llm.quiet = true;
  let llmOk = 0;
  let done = 0;
  await Promise.all(subjects.map(async (s) => {
    const { bySubject, source } = await extractFacts(llm, [s], { gameDate, gameLabel: label, timeoutMs: 180_000 });
    if (source !== 'fallback') llmOk++;
    const facts = bySubject.get(s.id) ?? [];
    for (const f of facts) cands.push({ ...f, slug: s.slug, about: [...s.about, ...mentions(f.text, roster)], source: s.url, asOf: s.asOf, ground: s.text, allowed: s.allowed });
    console.log(`  [${++done}/${subjects.length}] ${s.name}: ${facts.length} facts (${source})`);
  }));

  cands.push(...scheduleFacts(games, home, away, gameDate, season, keyByName));

  // minWeight 0.4: routine career notes (model weight 0.2-0.3) are not worth airtime.
  const { facts, stats } = assemble(cands, { gameDate, storylineTexts, minWeight: 0.4 });
  const kb: KbFile = { gameId, gameDate, builtAt: new Date().toISOString(), facts };
  const out = dataPath('kb', `${gameId}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(kb, null, 1)}\n`);

  const perKind = facts.reduce<Record<string, number>>((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  console.log(`\nWrote ${path.relative(process.cwd(), out)}: ${facts.length} facts from ${cands.length} candidates (model extraction ok for ${llmOk}/${subjects.length} pages)`);
  console.log('Per kind:', perKind);
  console.log('Dropped:', { spoiler: stats.spoiler, ungrounded: stats.ungrounded, generic: stats.generic, policy: stats.policy, storyline: stats.storyline, duplicate: stats.duplicate, lowWeight: stats.lowWeight });
  for (const e of stats.examples) console.log(`  drop ${e.reason}: ${e.text.slice(0, 160)}`);
  console.log('\nTop 10:');
  for (const f of [...facts].sort((a, b) => b.weight - a.weight).slice(0, 10)) console.log(`  ${f.weight.toFixed(2)} ${f.kind.padEnd(7)} [${f.about.join(',')}] ${f.text}  <${f.source}>`);
  if (!facts.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
