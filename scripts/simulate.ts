/**
 * npm run simulate            (mock LLM, virtual clock)
 * npm run simulate -- --llm   (real provider from .env for Director/Call It/etc.; still virtual game time)
 * npm run simulate -- --segment C --llm   (only demo segment C, prints sample AI outputs)
 *
 * 1) Full Super Bowl LVII in condensed mode for each talkativeness, with 1 fan + 3 learner bots.
 * 2) Demo segments with the Game 1 preset, then the Game 4 preset: Huddle lines must drop by ≥ 50%.
 */
import 'dotenv/config';
import type { EngineEvent, Mode, Pacing, Settings, Talkativeness } from '../shared/types';
import { BUDGET } from '../shared/constants';
import { VirtualClock, RealClock } from '../server/room/clock';
import { Room, type SpokenRecord } from '../server/room/Room';
import { makeIntel } from '../server/intel';
import { LLM } from '../server/ai/llm';
import { Bots, BotTransport } from '../server/sim/bots';

const args = process.argv.slice(2);
const useLlm = args.includes('--llm');
const segArg = args.includes('--segment') ? args[args.indexOf('--segment') + 1] : null;
const failures: string[] = [];
const fail = (msg: string) => { failures.push(msg); console.log(`  ✗ ${msg}`); };
const pass = (msg: string) => console.log(`  ✓ ${msg}`);

type RunOpts = { talk: Talkativeness; mode: Mode; pacing: Pacing; preset?: 'game1' | 'game4'; segment?: string; seed?: number };

export async function runSim(o: RunOpts) {
  const clock = new VirtualClock();
  const transport = new BotTransport(() => clock.now(), false);
  const llm = useLlm
    ? new LLM(new RealClock(), { provider: 'openai_compatible' }, (p) => clock.track(p))
    : new LLM(clock, { provider: 'mock' });
  llm.quiet = !useLlm;
  const events: { ev: EngineEvent; at: number }[] = [];
  const settings: Settings = { familyName: null, gameId: '2022_22_KC_PHI', mode: o.mode, pacing: o.pacing, talkativeness: o.talk, voice: true, fanHandicap: true };
  const room = new Room('SIMU', settings, { clock, transport, llm, intel: makeIntel({ gameId: settings.gameId, llm }), events: { onEngineEvent: (ev, at) => events.push({ ev, at }) } });
  const bots = new Bots(room, clock, transport, o.seed ?? 7);
  bots.join();
  if (o.preset) room.applyPreset(o.preset);
  room.startProfiles();
  bots.submitProfiles();
  await clock.run({ until: () => room.phase === 'live' || room.phase === 'recap', maxSteps: 1_000_000 });
  if (o.segment) room.control('jump', { segment: o.segment });
  await clock.run({ until: () => room.phase === 'recap', maxSteps: 5_000_000 });
  if (o.segment) {
    // Single-segment runs stop after the segment: the engine goes to final → recap.
  }
  const start = events[0]?.at ?? 0;
  const end = events.filter((e) => e.ev.type === 'final').pop()?.at ?? clock.now();
  const gameLines = room.spokenLog.filter((l) => l.at >= start);
  return { room, events, bots, durationMs: end - start, lines: gameLines, llm };
}

const huddleExplanations = (lines: SpokenRecord[]) => lines.filter((l) => l.kind === 'explain' || l.kind === 'short');
/**
 * Budgets and gaps count every Director line, rule explanations and intel insights alike: an insight is still
 * Huddle talking. The Game 1 vs Game 4 fade metric counts rule explanations only (`huddleExplanations`): the fade
 * measures what the family has learned, and insights don't depend on knowledge (each fact is said at most once
 * per room anyway). Simulate runs without an IntelProvider today, so both definitions currently agree.
 */
const directorLines = (lines: SpokenRecord[]) => lines.filter((l) => l.kind === 'explain' || l.kind === 'short' || l.kind === 'insight');
const fmt = (ms: number) => `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;

function checkBudgets(talk: Talkativeness, lines: SpokenRecord[], shownPlays: number) {
  const budgeted = directorLines(lines).filter((l) => l.trigger === 'play' && !l.followUp);
  const perQ = new Map<number, number>();
  for (const l of budgeted) perQ.set(l.qtr, (perQ.get(l.qtr) ?? 0) + 1);
  if (talk === 'quiet') {
    if (budgeted.length) fail(`quiet: ${budgeted.length} explanations outside flags/decisions`);
    else pass('quiet: only flags and decisions');
  }
  if (talk === 'normal') {
    const over = [...perQ.entries()].filter(([, n]) => n > BUDGET.normalPerQuarter);
    if (over.length) fail(`normal: over budget in ${over.map(([q, n]) => `Q${q}=${n}`).join(', ')}`);
    else pass(`normal: ≤ ${BUDGET.normalPerQuarter} per quarter (${[...perQ.entries()].map(([q, n]) => `Q${q}:${n}`).join(' ')})`);
  }
  if (talk === 'chatty') {
    if (budgeted.length > Math.ceil(shownPlays / 2)) fail(`chatty: ${budgeted.length} lines for ${shownPlays} plays`);
    else pass(`chatty: ${budgeted.length} budgeted lines for ${shownPlays} plays (≤ 1 per 2)`);
  }
  if (talk !== 'quiet') {
    const gap = talk === 'chatty' ? BUDGET.chattyGapMs : BUDGET.normalGapMs;
    const huddle = lines.filter((l) => (l.kind === 'explain' || l.kind === 'short' || l.kind === 'insight' || l.kind === 'beat') && !l.followUp);
    let bad = 0;
    for (let i = 1; i < huddle.length; i++) {
      const prevEnd = huddle[i - 1].endAt ?? huddle[i - 1].at;
      if (huddle[i].at - prevEnd < gap - 1) bad++;
    }
    if (bad) fail(`${talk}: ${bad} lines closer than ${gap / 1000}s`);
    else pass(`${talk}: every Huddle line ≥ ${gap / 1000}s after the previous one`);
  }
}

async function fullGames() {
  console.log('\n=== Full game, condensed mode, gameNight pacing ===');
  for (const talk of ['quiet', 'normal', 'chatty'] as Talkativeness[]) {
    const { room, events, bots, durationMs, lines } = await runSim({ talk, mode: 'condensed', pacing: 'gameNight' });
    const shown = events.filter((e) => e.ev.type === 'pre_snap').length;
    const predicts = events.filter((e) => e.ev.type === 'pre_snap' && e.ev.play.decision).length;
    const callits = events.filter((e) => e.ev.type === 'flag').length;
    const ex = huddleExplanations(lines);
    const perQ = [1, 2, 3, 4].map((q) => ex.filter((l) => l.qtr === q).length);
    console.log(`\n-- talkativeness: ${talk}`);
    console.table({
      'plays shown': shown,
      'estimated duration': fmt(durationMs),
      'Predict rounds': predicts,
      'Call It rounds': callits,
      'Huddle lines Q1/Q2/Q3/Q4': perQ.join(' / '),
      'storyline beats': lines.filter((l) => l.kind === 'beat').length,
      'take-its offered/accepted': `${bots.stats.takeItOffered}/${bots.stats.takeItAccepted}`,
      'handoffs offered/accepted': `${bots.stats.handoffOffered}/${bots.stats.handoffAccepted}`,
      'recap ready (ms after final)': room.recapMs,
    });
    console.table([...room.players.values()].sort((a, b) => b.points - a.points).map((p) => ({
      name: p.name, role: p.role, points: p.points, callIt: `${p.callItCorrect}/${p.callItTotal}`, predict: `${p.predictCorrect}/${p.predictTotal}`, explained: p.explanations,
    })));
    checkBudgets(talk, lines, shown);
    if (callits !== 10) fail(`${talk}: expected 10 Call It rounds, got ${callits}`); else pass(`${talk}: every flag opened Call It (10)`);
    if (predicts < 10) fail(`${talk}: expected ≥ 10 Predict rounds, got ${predicts}`); else pass(`${talk}: ${predicts} Predict rounds`);
    if (!room.snapshot().recap) fail(`${talk}: no recap`); else pass(`${talk}: recap produced (${room.snapshot().recap!.source})`);
    if (room.recapMs > 8000) fail(`${talk}: recap took ${room.recapMs}ms`);
    if (talk === 'normal') {
      const min = durationMs / 60000;
      if (min < 20 || min > 30) fail(`normal: duration ${fmt(durationMs)} outside 20–30 min`);
      else pass(`normal: estimated ${fmt(durationMs)} (target 20–30 min)`);
    }
  }
}

async function presets() {
  console.log('\n=== Demo segments A–C: Game 1 vs Game 4 preset (normal talkativeness, demo pacing) ===');
  // Bot choices are random (take-its, handoffs, Call It accuracy), so compare totals over several seeds.
  const seeds = [7, 11, 23, 42, 99, 101, 202, 303, 404, 505];
  const rows: Record<string, string | number>[] = [];
  let totalA = 0;
  let totalB = 0;
  let shown = false;
  for (const seed of seeds) {
    const g1 = await runSim({ talk: 'normal', mode: 'demo', pacing: 'demo', preset: 'game1', seed });
    const g4 = await runSim({ talk: 'normal', mode: 'demo', pacing: 'demo', preset: 'game4', seed });
    const a = huddleExplanations(g1.lines);
    const b = huddleExplanations(g4.lines);
    totalA += a.length;
    totalB += b.length;
    rows.push({ seed, 'Game 1 lines': a.length, 'Game 4 lines': b.length, 'G4 handoffs offered/accepted': `${g4.bots.stats.handoffOffered}/${g4.bots.stats.handoffAccepted}`, 'G4 label': g4.room.snapshot().presetLabel ?? '(none)' });
    if (!shown) {
      shown = true;
      console.log(`Seed ${seed}, Game 1 lines:`);
      for (const l of a) console.log(`   Q${l.qtr} [${l.kind}] ${l.text}`);
      console.log(`Seed ${seed}, Game 4 lines:`);
      for (const l of b) console.log(`   Q${l.qtr} [${l.kind}] ${l.text}`);
    }
    if (g4.room.snapshot().presetLabel !== 'Simulated: Game 4 knowledge') fail('Game 4 preset label missing from the TV snapshot');
  }
  console.table(rows);
  const reduction = totalA ? 1 - totalB / totalA : 0;
  if (reduction >= 0.5) pass(`Game 4 speaks ${Math.round(reduction * 100)}% fewer Huddle lines over ${seeds.length} runs (${totalA} → ${totalB}, need ≥ 50%)`);
  else fail(`Game 4 reduction only ${Math.round(reduction * 100)}% (${totalA} → ${totalB})`);
}

async function segmentOnly(seg: string) {
  console.log(`\n=== Segment ${seg} (demo pacing, normal) ${useLlm ? 'with live LLM' : 'mock'} ===`);
  const { room, lines, llm } = await runSim({ talk: 'normal', mode: 'demo', pacing: 'demo', segment: seg });
  for (const l of lines) console.log(`   Q${l.qtr} [${l.kind}] ${l.text}`);
  console.log('\nAI log:');
  for (const e of llm.log) console.log(`   ${e.task} · ${e.source} · ${e.ms}ms${e.note ? ` · ${e.note}` : ''}`);
  console.log('\nRecap:\n' + (room.snapshot().recap?.groupChatText ?? '(none)'));
}

async function main() {
  const t0 = Date.now();
  if (segArg) await segmentOnly(segArg);
  else {
    await fullGames();
    await presets();
  }
  console.log(`\nSimulated in ${((Date.now() - t0) / 1000).toFixed(1)}s real time.`);
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}):\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  console.log('\nAll simulate checks passed.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
