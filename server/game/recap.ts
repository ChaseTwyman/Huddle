import type { FamilyRecap, PersonRecap } from '../../shared/types';
import type { LLM } from '../ai/llm';
import { RECAP_SYSTEM } from '../ai/prompts';
import { RecapOut } from '../ai/schemas';

export type PersonStats = Omit<PersonRecap, 'headline' | 'bestMoment'> & { assists: number; log: { text: string; points: number }[] };

export type RecapInput = {
  familyName: string | null;
  gameTitle: string;
  finalScore: string;
  people: PersonStats[];
  /** Notable things that happened tonight, in order (e.g. "Mom called Defensive holding on the Bradberry flag"). */
  gameLog: { text: string; weight: number }[];
};

const first = (n: string) => n.trim().split(/\s+/)[0] || n;

function templateHeadline(p: PersonStats): string {
  if (p.rank === 1 && p.points > 0) return `${first(p.name)} takes the family crown`;
  if (p.callIt.correct > 0) return `${first(p.name)} called ${p.callIt.correct} ${p.callIt.correct === 1 ? 'flag' : 'flags'}`;
  if (p.explanationsGiven > 0) return `${first(p.name)} became the teacher`;
  if (p.learnedTonight.length > 0) return `${first(p.name)} learned ${p.learnedTonight.length} ${p.learnedTonight.length === 1 ? 'rule' : 'rules'}`;
  return `${first(p.name)} was in the huddle`;
}

function templateBest(p: PersonStats): string {
  const best = [...p.log].sort((a, b) => b.points - a.points)[0];
  return (best?.text ?? 'Watched every snap with the family.').slice(0, 140);
}

export function templateRecap(input: RecapInput): Omit<FamilyRecap, 'groupChatText' | 'source'> {
  const moment = [...input.gameLog].sort((a, b) => b.weight - a.weight)[0]?.text ?? `${input.finalScore}.`;
  const learners = input.people.filter((p) => p.role === 'learner').sort((a, b) => b.rulesKnown - a.rulesKnown);
  const star = learners[0];
  return {
    title: `${input.familyName ? `The ${input.familyName}s'` : 'Family'} night: ${input.gameTitle}`.slice(0, 60),
    momentOfTheNight: moment.slice(0, 200),
    nextTime: (star ? `Next game, can ${first(star.name)} explain the next flag before Huddle does?` : 'Next game, Huddle will say even less.').slice(0, 120),
    finalScore: input.finalScore,
    people: input.people.map((p) => ({ ...strip(p), headline: templateHeadline(p), bestMoment: templateBest(p) })),
  };
}

function strip(p: PersonStats): Omit<PersonRecap, 'headline' | 'bestMoment'> {
  const { assists: _a, log: _l, ...rest } = p;
  return rest;
}

export function groupChatText(r: Omit<FamilyRecap, 'groupChatText' | 'source'>, gameTitle: string): string {
  const lines = [`🏈 ${r.title}`, `${gameTitle}: ${r.finalScore}`, ''];
  for (const p of [...r.people].sort((a, b) => a.rank - b.rank)) {
    const bits = [`${p.points} pts`];
    if (p.callIt.total) bits.push(`Call It ${p.callIt.correct}/${p.callIt.total}`);
    if (p.predict.total) bits.push(`Predict ${p.predict.correct}/${p.predict.total}`);
    if (p.explanationsGiven) bits.push(`explained ${p.explanationsGiven}`);
    lines.push(`#${p.rank} ${p.name} (${bits.join(' · ')}): ${p.headline}`);
    if (p.role === 'learner' && p.learnedTonight.length) lines.push(`   Learned tonight: ${p.learnedTonight.join(', ')}`);
  }
  lines.push('', `Moment of the night: ${r.momentOfTheNight}`, r.nextTime, '— sent from Huddle');
  return lines.join('\n');
}

/** F10: code computes the stats; the model writes the words (8 s limit, template fallback). */
export async function buildRecap(llm: LLM, input: RecapInput): Promise<FamilyRecap> {
  const tpl = templateRecap(input);
  const res = await llm.json({
    task: 'recap', model: 'smart', system: RECAP_SYSTEM,
    user: JSON.stringify({
      family: input.familyName, game: input.gameTitle, finalScore: input.finalScore,
      people: input.people.map((p) => ({
        playerId: p.playerId, firstName: first(p.name), role: p.role, points: p.points, rank: p.rank,
        predict: p.predict, callIt: p.callIt, explanationsGiven: p.explanationsGiven,
        conceptsLearnedTonight: p.learnedTonight, log: p.log.map((l) => l.text),
      })),
      gameLog: input.gameLog.map((g) => g.text),
    }, null, 1),
    schema: RecapOut, timeoutMs: 8000, temperature: 0.7,
    fallback: () => ({ people: [], family: { title: '', momentOfTheNight: '', nextTime: '' } }),
  });
  let recap = tpl;
  if (res.source !== 'fallback') {
    const f = res.value.family;
    recap = {
      ...tpl,
      title: f.title && f.title.length <= 60 ? f.title : tpl.title,
      momentOfTheNight: f.momentOfTheNight && f.momentOfTheNight.length <= 200 ? f.momentOfTheNight : tpl.momentOfTheNight,
      nextTime: f.nextTime && f.nextTime.length <= 120 ? f.nextTime : tpl.nextTime,
      people: tpl.people.map((p) => {
        const w = res.value.people.find((x) => x.playerId === p.playerId);
        return {
          ...p,
          headline: w && w.headline && w.headline.length <= 60 ? w.headline : p.headline,
          bestMoment: w && w.bestMoment && w.bestMoment.length <= 140 ? w.bestMoment : p.bestMoment,
        };
      }),
    };
  }
  return { ...recap, groupChatText: groupChatText(recap, input.gameTitle), source: res.source };
}
