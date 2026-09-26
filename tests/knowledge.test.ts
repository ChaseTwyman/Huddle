import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { addExposure, addRecall, handoffCandidates, level, markExplained, presetKnowledge, roomLevel, learnedSince, type Preset } from '../server/game/knowledge';
import type { KnowledgeMap } from '../shared/types';

const e = (exposures: number, recalls = 0, explainedToRoom = false) => ({ exposures, recalls, explainedToRoom });

describe('F8 knowledge levels', () => {
  it('applies every threshold', () => {
    expect(level(undefined)).toBe('new');
    expect(level(e(0))).toBe('new');
    expect(level(e(1))).toBe('seen');
    expect(level(e(2))).toBe('familiar');
    expect(level(e(0, 1))).toBe('familiar');
    expect(level(e(3))).toBe('familiar'); // 3 exposures without a recall is not mastered
    expect(level(e(3, 1))).toBe('mastered');
    expect(level(e(0, 2))).toBe('mastered');
    expect(level(e(0, 0, true))).toBe('mastered');
  });

  it('counts exposures, recalls and explaining', () => {
    const k: KnowledgeMap = {};
    addExposure(k, 'downs');
    expect(level(k.downs)).toBe('seen');
    addRecall(k, 'downs');
    expect(level(k.downs)).toBe('familiar');
    markExplained(k, 'punt');
    expect(level(k.punt)).toBe('mastered');
  });

  it('room level is the lowest among connected learners', () => {
    const a: KnowledgeMap = { downs: e(3, 1) };
    const b: KnowledgeMap = { downs: e(1) };
    expect(roomLevel([a, b], 'downs')).toBe('seen');
    expect(roomLevel([a], 'downs')).toBe('mastered');
    expect(roomLevel([a, b], 'punt')).toBe('new');
    expect(roomLevel([], 'punt')).toBe('mastered');
  });

  it('selects handoff candidates: Familiar+ learners with someone below them', () => {
    const mom = { id: 'mom', knowledge: { holding_defensive: e(2) } };
    const sis = { id: 'sis', knowledge: { holding_defensive: e(1) } };
    const dad = { id: 'dad', knowledge: { holding_defensive: e(3, 1) } };
    expect(handoffCandidates([mom, sis], 'holding_defensive')).toEqual(['mom']);
    expect(handoffCandidates([mom, sis, dad], 'holding_defensive')).toEqual(['mom', 'dad']);
    expect(handoffCandidates([mom], 'holding_defensive')).toEqual([]);
    const twin = { id: 'twin', knowledge: { holding_defensive: e(2) } };
    expect(handoffCandidates([mom, twin], 'holding_defensive')).toEqual([]);
  });

  it('seeds the Game 4 preset by join order', () => {
    const preset = JSON.parse(fs.readFileSync('data/presets/game4.json', 'utf8')) as Preset;
    const slot1 = presetKnowledge(preset, 0);
    expect(level(slot1.downs)).toBe('mastered');
    expect(level(slot1.holding_defensive)).toBe('familiar');
    const slot2 = presetKnowledge(preset, 1);
    expect(level(slot2.holding_defensive)).toBe('seen');
    expect(level(slot2.first_down_line)).toBe('familiar');
    const slot5 = presetKnowledge(preset, 4);
    expect(level(slot5.downs)).toBe('seen');
    expect(level(slot5.holding_defensive)).toBe('new');
  });

  it('reports concepts that reached Familiar or Mastered', () => {
    const before: KnowledgeMap = { downs: e(1), punt: e(2) };
    const now: KnowledgeMap = { downs: e(2), punt: e(3), sack: e(1) };
    expect(learnedSince(before, now)).toEqual(['downs']);
  });
});
