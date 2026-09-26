import { POINTS } from '../../shared/constants';

export type Answer = { playerId: string; optionId: string; at: number };
export type Participant = { id: string; role: 'fan' | 'learner' };
export type ScoredResult = { playerId: string; correct: boolean; points: number };

const handicap = (points: number, role: 'fan' | 'learner', fanHandicap: boolean) =>
  role === 'fan' && fanHandicap ? Math.round(points / 2) : points;

/** F9 Predict: +100 correct, +50 more if fewer than half of those who answered picked it. Fan halved. */
export function scorePredict(answers: Answer[], correctOptionId: string, players: Participant[], fanHandicap: boolean): ScoredResult[] {
  const correctCount = answers.filter((a) => a.optionId === correctOptionId).length;
  const contrarian = answers.length > 0 && correctCount < answers.length / 2;
  return answers.map((a) => {
    const role = players.find((p) => p.id === a.playerId)?.role ?? 'learner';
    const correct = a.optionId === correctOptionId;
    const raw = correct ? POINTS.predictCorrect + (contrarian ? POINTS.predictContrarian : 0) : 0;
    return { playerId: a.playerId, correct, points: handicap(raw, role, fanHandicap) };
  });
}

/** F9 Call It: +150 correct, +25 for the earliest correct lock-in. Fan halved. */
export function scoreCallIt(answers: Answer[], correctOptionId: string, players: Participant[], fanHandicap: boolean): ScoredResult[] {
  const correct = answers.filter((a) => a.optionId === correctOptionId).sort((a, b) => a.at - b.at);
  const firstId = correct[0]?.playerId;
  return answers.map((a) => {
    const role = players.find((p) => p.id === a.playerId)?.role ?? 'learner';
    const ok = a.optionId === correctOptionId;
    const raw = ok ? POINTS.callItCorrect + (a.playerId === firstId ? POINTS.callItFirst : 0) : 0;
    return { playerId: a.playerId, correct: ok, points: handicap(raw, role, fanHandicap) };
  });
}

/** Explaining to the room: learners +100; the fan gets 0 points and an assist. */
export function explainPoints(role: 'fan' | 'learner'): { points: number; assist: boolean } {
  return role === 'fan' ? { points: 0, assist: true } : { points: POINTS.explain, assist: false };
}

export type Standing = { id: string; points: number; callItCorrect: number };

/** Sort by points, ties broken by correct Call Its. Returns ids with 1-based ranks (ties share a rank). */
export function rank<T extends Standing>(players: T[]): (T & { rank: number })[] {
  const sorted = [...players].sort((a, b) => b.points - a.points || b.callItCorrect - a.callItCorrect);
  let lastKey = '';
  let lastRank = 0;
  return sorted.map((p, i) => {
    const key = `${p.points}/${p.callItCorrect}`;
    const r = key === lastKey ? lastRank : i + 1;
    lastKey = key;
    lastRank = r;
    return { ...p, rank: r };
  });
}
