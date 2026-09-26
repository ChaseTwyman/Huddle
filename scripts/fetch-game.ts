/**
 * npm run fetch-game -- --season 2022 --week 22 --teams KC,PHI   (default: Super Bowl LVII)
 * npm run fetch-game -- --game-id 2022_22_KC_PHI
 *
 * Downloads nflverse play-by-play, extracts one game, builds timeline.json + moments.json,
 * validates, and updates data/games/index.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { dataPath } from '../server/paths';
import { buildTimeline, REQUIRED_MOMENTS, WANTED_COLUMNS, type Row } from '../server/data/timeline';
import type { GameIndexEntry, StorylinesFile } from '../shared/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const gameIdArg = arg('game-id');
const season = Number(arg('season') ?? gameIdArg?.split('_')[0] ?? 2022);
const week = Number(arg('week') ?? gameIdArg?.split('_')[1] ?? 22);
const teams = (arg('teams') ?? (gameIdArg ? gameIdArg.split('_').slice(2).join(',') : 'KC,PHI')).split(',').map((t) => t.trim().toUpperCase());
const isDefault = season === 2022 && week === 22 && teams.sort().join(',') === 'KC,PHI';

const url = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;
const rawFile = dataPath('raw', `play_by_play_${season}.csv.gz`);

async function download() {
  if (fs.existsSync(rawFile) && fs.statSync(rawFile).size > 1000) {
    console.log(`Using cached ${path.relative(process.cwd(), rawFile)}`);
    return;
  }
  fs.mkdirSync(path.dirname(rawFile), { recursive: true });
  console.log(`Downloading ${url} ...`);
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(rawFile));
  } catch (err) {
    if (fs.existsSync(rawFile)) fs.rmSync(rawFile);
    console.error(`\nDownload failed: ${(err as Error).message}`);
    console.error(`Download this file manually:\n  ${url}\nand save it as:\n  ${rawFile}\nThen run this command again.`);
    process.exit(1);
  }
}

async function readGameRows(): Promise<{ rows: Row[]; columns: string[] }> {
  const rows: Row[] = [];
  let columns: string[] = [];
  const parser = fs.createReadStream(rawFile).pipe(zlib.createGunzip()).pipe(parse({ columns: (h: string[]) => { columns = h; return h; } }));
  for await (const r of parser as AsyncIterable<Row>) {
    if (gameIdArg && r.game_id !== gameIdArg) continue;
    if (Number(r.season) !== season || Number(r.week) !== week) continue;
    const t = new Set([r.home_team, r.away_team]);
    if (!teams.every((x) => t.has(x))) continue;
    rows.push(r);
  }
  return { rows, columns };
}

function fail(msg: string): never {
  console.error(`\nVALIDATION FAILED: ${msg}`);
  process.exit(1);
}

async function main() {
  await download();
  const { rows, columns } = await readGameRows();
  if (!rows.length) fail(`no rows for season ${season} week ${week} teams ${teams.join(',')}`);
  const ids = [...new Set(rows.map((r) => r.game_id))];
  if (ids.length !== 1) fail(`expected one game, found ${ids.join(', ')}`);
  const gameId = ids[0]!;
  console.log(`Found game ${gameId}: ${rows.length} rows, ${columns.length} columns in file.`);
  if (isDefault && gameId !== '2022_22_KC_PHI') fail(`expected game_id 2022_22_KC_PHI, got ${gameId}`);

  const present = WANTED_COLUMNS.filter((c) => columns.includes(c));
  console.log(`Columns used (${present.length}/${WANTED_COLUMNS.length}): ${present.join(', ')}`);

  const dir = dataPath('games', gameId);
  fs.mkdirSync(dir, { recursive: true });
  const storyPath = path.join(dir, 'storylines.json');
  const storylines: StorylinesFile = fs.existsSync(storyPath) ? JSON.parse(fs.readFileSync(storyPath, 'utf8')) : { gameFacts: [], storylines: [] };

  const first = rows[0]!;
  const title = isDefault ? 'Super Bowl LVII' : `${first.away_team} at ${first.home_team}, ${season} week ${week}`;
  const date = isDefault ? '2023-02-12' : first.game_date ?? '';
  const { timeline, moments, unknownPenalties, missingColumns } = buildTimeline(rows, { gameId, title, date }, storylines.storylines);

  if (missingColumns.length) console.warn(`Missing columns (degraded): ${missingColumns.join(', ')}`);
  if (unknownPenalties.length) console.warn(`Unknown penalty types (mapped to penalty_other): ${unknownPenalties.join(', ')}`);

  // Validation
  if (isDefault) {
    const f = timeline.finalScore;
    const kc = timeline.home === 'KC' ? f.home : f.away;
    const phi = timeline.home === 'PHI' ? f.home : f.away;
    if (kc !== 38 || phi !== 35) fail(`final score should be KC 38, PHI 35; got KC ${kc}, PHI ${phi}`);
    const missing = REQUIRED_MOMENTS.filter((k) => moments.keys[k] === undefined);
    if (missing.length) fail(`missing required moments: ${missing.join(', ')}`);
    for (const s of ['A', 'B', 'C']) if (!moments.segments.find((x) => x.id === s)) fail(`missing segment ${s}`);
  }

  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline, null, 1));
  fs.writeFileSync(path.join(dir, 'moments.json'), JSON.stringify(moments, null, 1));
  fs.writeFileSync(path.join(dir, 'README.md'), gameReadme(gameId, title, present, missingColumns, unknownPenalties));

  const indexPath = dataPath('games', 'index.json');
  const index: GameIndexEntry[] = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : [];
  const entry: GameIndexEntry = { id: gameId, title, date, home: timeline.home, away: timeline.away, finalScore: timeline.finalScore };
  const next = [...index.filter((g) => g.id !== gameId), entry];
  fs.writeFileSync(indexPath, JSON.stringify(next, null, 2));

  // Summary
  const plays = timeline.plays;
  const pens = plays.filter((p) => p.penalty);
  const decisions = plays.filter((p) => p.decision);
  console.log(`\n${title} (${gameId}) · ${timeline.away} ${timeline.finalScore.away} at ${timeline.home} ${timeline.finalScore.home}`);
  console.table({
    plays: plays.length,
    scrimmagePlays: plays.filter((p) => p.down !== null).length,
    notable: plays.filter((p) => p.notable).length,
    penalties: pens.length,
    decisions: decisions.length,
    moments: moments.moments.length,
  });
  console.log('Penalties:');
  for (const p of pens) console.log(`  #${p.idx} Q${p.qtr} ${p.clock} ${p.penalty!.rawType} -> ${p.penalty!.conceptId} (${p.penalty!.status}) | ${p.penalty!.announcement}`);
  console.log('Decisions:');
  for (const p of decisions) console.log(`  #${p.idx} Q${p.qtr} ${p.clock} ${p.decision!.kind} ${p.kind}`);
  console.log('Required moments:');
  for (const k of REQUIRED_MOMENTS) {
    const idx = moments.keys[k];
    console.log(`  ${k.padEnd(15)} #${idx} ${idx !== undefined ? plays[idx].publicDesc.slice(0, 80) : 'MISSING'}`);
  }
  console.log('Segments:');
  for (const s of moments.segments) console.log(`  ${s.label}: #${s.startIdx}..#${s.endIdx}`);
  console.log('\nOK');
}

function gameReadme(gameId: string, title: string, used: string[], missing: string[], unknown: string[]) {
  return `# ${title} (\`${gameId}\`)

Generated by \`npm run fetch-game\` from nflverse play-by-play
(\`https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz\`).

- \`timeline.json\`: one entry per play (the \`GAME_START\` row is dropped; timeouts and period ends are kept).
- \`moments.json\`: notable plays, required moment keys, and demo segments A–C.
- \`storylines.json\`: curated by the team. Set \`verified\` after checking each fact.

## Column mapping

Used columns: ${used.map((c) => `\`${c}\``).join(', ')}.

- \`total_home_score\` / \`total_away_score\` are the score after the play (verified on the first touchdown row); \`scoreBefore\` is the previous play's \`scoreAfter\`.
- Two-point attempts don't fill \`rusher_player_name\`; the rusher or receiver is parsed from \`desc\`.
- Plays with \`play_type == no_play\` and no action in \`desc\` (only the penalty) become \`kind: "penalty_only"\` and are presented as "Whistle. Flag before the snap."
- Absolute field position: 0–100 from the home team's goal line; the home team attacks to the right.

## Gaps

${missing.length ? `Missing columns (features degrade gracefully): ${missing.join(', ')}` : 'No wanted columns were missing.'}

${unknown.length ? `Unknown penalty types mapped to \`penalty_other\`: ${unknown.join(', ')}` : 'Every penalty type mapped to a concept.'}
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
