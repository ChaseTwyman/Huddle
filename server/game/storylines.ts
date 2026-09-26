import type { ProfileAnswers, Storyline, StoryFact, StorylinesFile, TimelinePlay } from '../../shared/types';
import type { LLM } from '../ai/llm';
import { BEAT_SYSTEM, STORYLINES_SYSTEM } from '../ai/prompts';
import { BeatOut, StorylinesOut, words } from '../ai/schemas';
import { concept } from '../data/concepts';
import type { Involvement } from './involvement';

export const allowUnverified = () => process.env.ALLOW_UNVERIFIED_FACTS === 'true';

/** A fact is usable once its revealAfter moment has passed, and only if verified (unless allowed). */
export function factUnlocked(f: StoryFact, revealed: Set<string>, unverifiedOk = allowUnverified()): boolean {
  if (!f.verified && !unverifiedOk) return false;
  return f.revealAfter === null || revealed.has(f.revealAfter);
}

export function unlockedFacts(s: Storyline, revealed: Set<string>): string[] {
  return s.facts.filter((f) => factUnlocked(f, revealed)).map((f) => f.text);
}

export type Assignment = { playerId: string; storylineId: string; title: string; hook: string; watchFor: string };
export type Learner = { id: string; name: string; profile: ProfileAnswers | null };

const WATCH_TAGS: Record<ProfileAnswers['watch'], string[]> = {
  reality: ['drama', 'chaos'],
  dramas: ['drama', 'family', 'relationships'],
  documentaries: ['numbers', 'underdog'],
  comedies: ['chaos'],
  music: ['star'],
  sports: ['numbers', 'star'],
};
const ROOT_TAGS: Record<ProfileAnswers['rootFor'], string[]> = { favorite: ['favorite', 'star'], underdog: ['underdog', 'comeback'] };
const VIBE_TAGS: Record<ProfileAnswers['vibe'], string[]> = { drama: ['drama', 'family'], numbers: ['numbers', 'pressure'], chaos: ['chaos', 'comeback'] };

export function profileTags(p: ProfileAnswers | null): string[] {
  if (!p) return [];
  return [...WATCH_TAGS[p.watch], ...ROOT_TAGS[p.rootFor], ...VIBE_TAGS[p.vibe]];
}

const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

function templateCopy(learner: Learner, s: Storyline): { hook: string; watchFor: string } {
  const fact = s.facts.find((f) => factUnlocked(f, new Set()))?.text ?? '';
  const p = s.players[0];
  return {
    hook: `${firstName(learner.name)}, watch ${s.title}. ${fact}`.trim(),
    watchFor: p ? `${p.name}, the ${p.position}.` : s.title,
  };
}

/** Tag-overlap scoring, greedy assignment without repeats (BUILD_PROMPT 10.4). */
export function assignFallback(learners: Learner[], file: StorylinesFile, exclude: Record<string, string[]> = {}): Assignment[] {
  const pool = file.storylines.filter((s) => s.assignable);
  const used = new Set<string>();
  const out: Assignment[] = [];
  for (const l of learners) {
    const tags = profileTags(l.profile);
    const scored = pool
      .filter((s) => !(exclude[l.id] ?? []).includes(s.id))
      .map((s, i) => ({ s, i, score: s.tags.reduce((n, t) => n + tags.filter((x) => x === t).length, 0) }))
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const pick = scored.find((x) => !used.has(x.s.id)) ?? scored[0];
    if (!pick) continue;
    used.add(pick.s.id);
    out.push({ playerId: l.id, storylineId: pick.s.id, title: pick.s.title, ...templateCopy(l, pick.s) });
  }
  return out;
}

/** Pregame-safe view of storylines for the model: only unlocked-at-kickoff, verified facts. */
function pregameStorylines(file: StorylinesFile) {
  return file.storylines.filter((s) => s.assignable).map((s) => ({
    id: s.id, title: s.title, tags: s.tags,
    players: s.players.map((p) => ({ name: p.name, team: p.team, position: p.position })),
    facts: unlockedFacts(s, new Set()),
  }));
}

/** F2: LLM storyline matching with validation; falls back to tag-based assignment. */
export async function assignStorylines(llm: LLM, learners: Learner[], file: StorylinesFile, exclude: Record<string, string[]> = {}): Promise<{ assignments: Assignment[]; source: string }> {
  const fallback = assignFallback(learners, file, exclude);
  if (!learners.length) return { assignments: [], source: 'fallback' };
  const user = JSON.stringify({
    learners: learners.map((l) => ({ playerId: l.id, firstName: firstName(l.name), answers: l.profile, avoidStorylines: exclude[l.id] ?? [] })),
    storylines: pregameStorylines(file),
  }, null, 1);
  const res = await llm.json({
    task: 'storylines', model: 'smart', system: STORYLINES_SYSTEM, user, schema: StorylinesOut, timeoutMs: 5000, temperature: 0.7,
    fallback: () => ({ assignments: [] }),
  });
  if (res.source === 'fallback') return { assignments: fallback, source: 'fallback' };
  const byId = new Map(file.storylines.filter((s) => s.assignable).map((s) => [s.id, s]));
  const out: Assignment[] = [];
  const used = new Set<string>();
  for (const l of learners) {
    const a = res.value.assignments.find((x) => x.playerId === l.id);
    const s = a && byId.get(a.storylineId);
    const ok = a && s && !(exclude[l.id] ?? []).includes(s.id) && words(a.hook) <= 22 && words(a.watchFor) <= 12 && a.hook.trim() && a.watchFor.trim()
      && (!used.has(s.id) || used.size >= byId.size);
    if (ok) {
      used.add(s!.id);
      out.push({ playerId: l.id, storylineId: s!.id, title: s!.title, hook: a!.hook.trim(), watchFor: a!.watchFor.trim() });
    } else {
      const fb = fallback.find((f) => f.playerId === l.id);
      if (fb) out.push(fb);
    }
  }
  return { assignments: out, source: res.source };
}

// ---------- Storyline beats ----------

const surname = (full: string) => full.trim().split(/\s+/).slice(-1)[0] ?? full;

/** Play description for a beat, from structured data only. */
export function beatReason(play: TimelinePlay, inv: Involvement): string {
  const who = inv.player.name;
  switch (inv.reason) {
    case 'score':
      return play.kind === 'two_point' ? `${who} just converted the two-point try.` : `${who} just scored a touchdown.`;
    case 'big_gain':
      return `${who} just gained ${play.yardsGained} yards.`;
    case 'return':
      return `${who} just returned a ${play.kind === 'punt' ? 'punt' : 'kick'} ${play.returnYards} yards.`;
    case 'turnover':
      return `${who} was part of a turnover.`;
    case 'field_goal':
      return play.result.fieldGoal === 'made' ? `${who} just made a ${play.result.kickDistance ?? ''}-yard field goal.`.replace(' -yard', '') : `${who}'s field goal try didn't go in.`;
    case 'penalty':
      return `${who} was flagged for ${play.penalty ? concept(play.penalty.conceptId).name.toLowerCase() : 'a penalty'}.`;
  }
}

export type Beat = { line: string; cardBody: string; source: string };

export async function writeBeat(llm: LLM, learnerName: string, play: TimelinePlay, inv: Involvement, facts: string[], newlyRevealed: string[]): Promise<Beat> {
  const reason = beatReason(play, inv);
  const first = firstName(learnerName);
  const fallbackLine = `${first}, your player! ${reason}`;
  const fact = newlyRevealed[0];
  const cardBody = [reason, fact].filter(Boolean).join(' ').slice(0, 280);
  const res = await llm.json({
    task: 'beat', model: 'fast', system: BEAT_SYSTEM,
    user: JSON.stringify({
      familyMember: first, player: inv.player.name,
      play: reason, playText: play.publicDesc,
      ...(inv.reason === 'penalty' && play.penalty ? { refereeAnnouncement: play.penalty.announcement } : {}),
      facts,
    }, null, 1),
    schema: BeatOut, timeoutMs: 3000, temperature: 0.6,
    fallback: () => ({ line: fallbackLine }),
  });
  let line = res.value.line.trim();
  if (!line || words(line) > 20 || !line.toLowerCase().startsWith(first.toLowerCase())) line = fallbackLine;
  return { line, cardBody, source: res.source };
}

export { surname };
