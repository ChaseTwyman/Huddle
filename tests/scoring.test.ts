import { describe, expect, it } from 'vitest';
import { explainPoints, rank, scoreCallIt, scorePredict } from '../server/game/scoring';

const players = [
  { id: 'fan', role: 'fan' as const },
  { id: 'mom', role: 'learner' as const },
  { id: 'sis', role: 'learner' as const },
  { id: 'dad', role: 'learner' as const },
];

describe('F9 scoring', () => {
  it('Predict: +100 correct, no bonus when the majority picked it', () => {
    const r = scorePredict([
      { playerId: 'mom', optionId: 'go', at: 1 },
      { playerId: 'sis', optionId: 'go', at: 2 },
      { playerId: 'dad', optionId: 'punt', at: 3 },
    ], 'go', players, true);
    expect(r).toEqual([
      { playerId: 'mom', correct: true, points: 100 },
      { playerId: 'sis', correct: true, points: 100 },
      { playerId: 'dad', correct: false, points: 0 },
    ]);
  });

  it('Predict: +50 contrarian bonus when fewer than half picked the right answer', () => {
    const r = scorePredict([
      { playerId: 'mom', optionId: 'go', at: 1 },
      { playerId: 'sis', optionId: 'punt', at: 2 },
      { playerId: 'dad', optionId: 'punt', at: 3 },
    ], 'go', players, true);
    expect(r[0]).toEqual({ playerId: 'mom', correct: true, points: 150 });
    // Exactly half is not "fewer than half".
    const half = scorePredict([
      { playerId: 'mom', optionId: 'go', at: 1 },
      { playerId: 'sis', optionId: 'punt', at: 2 },
    ], 'go', players, true);
    expect(half[0].points).toBe(100);
  });

  it('Call It: +150 correct, +25 for the earliest correct lock-in', () => {
    const r = scoreCallIt([
      { playerId: 'sis', optionId: 'b', at: 5 },
      { playerId: 'mom', optionId: 'a', at: 3 },
      { playerId: 'dad', optionId: 'a', at: 4 },
    ], 'a', players, true);
    expect(r).toEqual([
      { playerId: 'sis', correct: false, points: 0 },
      { playerId: 'mom', correct: true, points: 175 },
      { playerId: 'dad', correct: true, points: 150 },
    ]);
  });

  it('fan handicap halves the fan\'s points, and can be turned off', () => {
    const answers = [{ playerId: 'fan', optionId: 'a', at: 1 }];
    expect(scoreCallIt(answers, 'a', players, true)[0].points).toBe(88); // (150 + 25) / 2 rounded
    expect(scoreCallIt(answers, 'a', players, false)[0].points).toBe(175);
    expect(scorePredict([{ playerId: 'fan', optionId: 'go', at: 1 }], 'go', players, true)[0].points).toBe(50);
  });

  it('explaining: learners +100, the fan gets an assist', () => {
    expect(explainPoints('learner')).toEqual({ points: 100, assist: false });
    expect(explainPoints('fan')).toEqual({ points: 0, assist: true });
  });

  it('ranks by points and breaks ties with correct Call Its', () => {
    const r = rank([
      { id: 'a', points: 300, callItCorrect: 1 },
      { id: 'b', points: 300, callItCorrect: 2 },
      { id: 'c', points: 500, callItCorrect: 0 },
      { id: 'd', points: 300, callItCorrect: 1 },
    ]);
    expect(r.map((x) => `${x.id}${x.rank}`)).toEqual(['c1', 'b2', 'a3', 'd3']);
  });
});
