import type { TeamInfo, TimelinePlay } from '../../shared/types';
import { teamOf } from '../../shared/teams';
import { lastName } from '../data/timeline';
import type { IntelFact, IntelProvider, SituationIntel } from './types';

/**
 * Situational numbers for the Director, computed only from plays[0..idx] (never later plays: spoilers).
 *
 * Stage 'result': the snap happened, but a flag on this play has not been announced. The current play's
 * penalty (name, concept, player, yardage, enforcement) must stay invisible, so a flagged play is left out of
 * every count at this stage and its win-probability swing (which includes the penalty) is not used.
 * Stage 'announced': the flag is public; the play counts like any other.
 */

export type Stage = 'result' | 'announced';
export type FourthCall = 'go' | 'punt' | 'field_goal';
export type Strength = 'strong' | 'lean' | 'close';
export type FourthDownAdvice = { recommend: FourthCall; strength: Strength };

const pct = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 100);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const nth = (n: number) => (n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : n === 4 ? 'fourth' : n === 5 ? 'fifth' : `${n}th`);

/** Seconds left in the current half (clock decisions are about the half, not the game). */
function halfSecondsLeft(p: TimelinePlay): number {
  return p.qtr <= 2 ? Math.max(0, p.gameSecondsRemaining - 1800) : p.gameSecondsRemaining;
}

/** Offense score minus defense score before the snap. */
function margin(p: TimelinePlay, home: string | null): number {
  const s = p.scoreBefore;
  const mine = p.posteam === home ? s.home : s.away;
  const theirs = p.posteam === home ? s.away : s.home;
  return mine - theirs;
}

/** Home team abbr: the timeline doesn't travel with the plays, so infer it from any play's field geometry. */
function homeOf(plays: TimelinePlay[], idx: number): string | null {
  for (let i = 0; i <= idx; i++) {
    const p = plays[i];
    if (p.posteam && p.yardline100 !== null && p.field.losAbs !== null && p.yardline100 !== 50) {
      // Home drives toward 100: losAbs = 100 - yardline100.
      return p.field.losAbs === 100 - p.yardline100 ? p.posteam : p.defteam;
    }
  }
  return null;
}

/**
 * A small, conservative 4th-down model. Base chart: the longest 4th-down distance worth going for, by field
 * position (yardline100 = yards to the opponent's end zone). Roughly the public analytics consensus
 * (nfl4th / Ben Baldwin's charts), shaded conservative:
 *   own 20 or deeper: never · own 21–40: 4th & 1 · own 41–midfield: up to 2 · opp 49–41: up to 3
 *   opp 40–31: up to 4 · field-goal range (opp 30 and in): up to 2, otherwise kick.
 * The kicking alternative is a field goal from the opp 35 in (a kick of 52 yards or less), else a punt.
 * Late-game adjustments: trailing in the last 8 minutes widens the go range by 2 yards; in the last
 * 2 minutes, trailing by more than a field goal means go, and a field goal that ties or wins means kick.
 * The last 30 seconds of the first half in field-goal range means kick.
 */
export function fourthDownAdvice(p: TimelinePlay, scoreMargin: number): FourthDownAdvice | null {
  const y = p.yardline100;
  const togo = p.ydstogo;
  if (y === null || togo === null) return null;
  const fgRange = y <= 35;
  const kick: FourthCall = fgRange ? 'field_goal' : 'punt';
  const late = p.qtr >= 4 ? p.gameSecondsRemaining : Infinity;
  if (late <= 120) {
    if (scoreMargin < -3) return { recommend: 'go', strength: 'strong' };
    if (fgRange && scoreMargin >= -3) return { recommend: 'field_goal', strength: 'strong' };
  }
  if (p.qtr === 2 && halfSecondsLeft(p) <= 30 && fgRange) return { recommend: 'field_goal', strength: 'strong' };

  let maxGo = y >= 80 ? 0 : y > 60 ? 1 : y > 50 ? 2 : y > 40 ? 3 : y > 30 ? 4 : 2;
  if (late <= 480 && scoreMargin < 0) maxGo += 2;
  const gap = togo - maxGo; // <= 0: go; > 0: kick
  if (gap <= 0) return { recommend: 'go', strength: gap <= -2 ? 'strong' : gap === 0 ? 'close' : 'lean' };
  return { recommend: kick, strength: gap >= 3 ? 'strong' : gap === 1 ? 'close' : 'lean' };
}

/** A simple late-game 2-point chart: go for two when it ties, gets within 3 or 8, or builds a 3- or 7-point lead. */
export function twoPointAdvice(p: TimelinePlay, scoreMargin: number): 'two' | 'kick' {
  const late = p.qtr >= 4;
  return late && [-2, -5, -10, 1, 5].includes(scoreMargin) ? 'two' : 'kick';
}

/** Rough NFL make rates by distance (recent seasons), for field-goal context. */
function fgMakeRate(distance: number): number {
  if (distance < 30) return 97;
  if (distance < 40) return 92;
  if (distance < 50) return 82;
  if (distance < 55) return 70;
  if (distance < 60) return 60;
  return 40;
}

const isScrimmage = (p: TimelinePlay) => ['pass', 'run', 'punt', 'field_goal', 'kneel', 'spike', 'penalty_only'].includes(p.kind) && !!p.posteam;

/** Wiped out by an accepted no-play / pre-snap foul, or offsetting fouls: the down is replayed. */
function wiped(p: TimelinePlay): boolean {
  const pen = p.penalty;
  if (!pen) return false;
  return pen.status === 'offsetting' || (pen.status === 'accepted' && (pen.noPlay || p.kind === 'penalty_only'));
}

type Stat = { att: number; cmp: number; passYds: number; passTd: number; car: number; rushYds: number; rec: number; recYds: number };
const emptyStat = (): Stat => ({ att: 0, cmp: 0, passYds: 0, passTd: 0, car: 0, rushYds: 0, rec: 0, recYds: 0 });

export function situationIntel(plays: TimelinePlay[], idx: number, stage: Stage, teams?: Record<string, TeamInfo>): SituationIntel {
  const play = plays[idx];
  const out: SituationIntel = { facts: [], surprise: false, obvious: false };
  if (!play) return out;
  const seen = plays.slice(0, idx + 1); // never look past idx
  const hidden = stage === 'result' && !!play.penalty; // this play's flag is still secret
  /** May play i feed counts? Earlier plays are all announced; the current one only if its flag is public. */
  const usable = (p: TimelinePlay, i: number) => !(i === idx && hidden);
  const home = homeOf(plays, idx);
  const off = play.posteam;
  const city = (abbr: string | null) => teamOf(abbr, teams).city;
  const fact = (f: IntelFact) => out.facts.push(f);

  // Victory formation and extra points are routine by definition.
  if (play.kind === 'kneel') out.obvious = true;

  // 1. Win probability (nflverse wp is the offense's chance before the snap; wpa is this play's change).
  if (off && play.wp !== undefined && play.kind !== 'timeout' && play.kind !== 'end_of_period') {
    const before = pct(play.wp);
    if (!hidden && play.wpa !== undefined && Math.abs(play.wpa) >= 0.08) {
      const after = pct(play.wp + play.wpa);
      fact({
        id: `sit:wp:${idx}`, kind: 'win_prob', about: [off],
        text: `That play swung ${city(off)}'s win chances from ${before}% to ${after}%, by a win-probability model.`,
        weight: Math.min(1, 0.5 + Math.abs(play.wpa) * 2),
      });
    } else {
      const now = hidden || play.wpa === undefined ? play.wp : play.wp + play.wpa;
      const p100 = pct(now);
      // 0% / 100% reads like a final result; say nothing.
      if (p100 > 1 && p100 < 99) {
        const close = p100 >= 40 && p100 <= 60 && play.qtr >= 4;
        fact({
          id: `sit:wp:${idx}`, kind: 'win_prob', about: [off],
          // A hidden flag can change this play's outcome, so only the pre-snap number is safe to quote.
          text: `A win-probability model puts ${city(off)}'s chances of winning at about ${p100}% ${hidden ? 'before this snap' : 'right now'}.`,
          weight: close ? 0.35 : 0.15,
        });
      }
    }
  }

  // 2. Decision math.
  if (off) {
    const m = margin(play, home);
    if (play.decision?.kind === 'fourth_down') {
      const advice = fourthDownAdvice(play, m);
      const did: FourthCall = play.kind === 'punt' ? 'punt' : play.kind === 'field_goal' ? 'field_goal' : 'go';
      if (advice) {
        const verb = { go: 'go for it', punt: 'punt', field_goal: 'kick the field goal' }[advice.recommend];
        const didText = { go: 'went for it', punt: 'punted', field_goal: 'kicked' }[did];
        const matched = did === advice.recommend;
        const text = advice.strength === 'close'
          ? `It's a close call: a simple 4th-down model narrowly favors ${{ go: 'going for it', punt: 'a punt', field_goal: 'a field goal' }[advice.recommend]}, and ${city(off)} ${matched ? 'agreed' : didText}.`
          : matched
            ? `A simple 4th-down model says ${verb} here, and ${city(off)} did.`
            : `A simple 4th-down model says ${verb} here, but ${city(off)} ${didText} instead.`;
        out.obvious = advice.strength === 'strong' && matched && did !== 'go';
        out.surprise = (!matched && advice.strength !== 'close') || (did === 'go' && advice.strength === 'close');
        fact({
          id: `sit:decision:${idx}`, kind: 'decision', about: [off], text,
          weight: out.surprise ? 0.85 : out.obvious ? 0.1 : advice.strength === 'close' ? 0.6 : 0.4,
        });
      }
    } else if (play.kind === 'two_point' || play.kind === 'extra_point') {
      const chart = twoPointAdvice(play, m);
      const wentForTwo = play.kind === 'two_point';
      const lead = m > 0 ? `up ${m}` : m < 0 ? `down ${-m}` : 'tied';
      if (wentForTwo) {
        out.surprise = chart === 'kick';
        fact({
          id: `sit:decision:${idx}`, kind: 'decision', about: [off],
          text: chart === 'two'
            ? `${lead[0].toUpperCase()}${lead.slice(1)} late, a simple 2-point chart says go for two, and ${city(off)} did.`
            : `A simple 2-point chart would kick the extra point ${lead}, so going for two was aggressive.`,
          weight: out.surprise ? 0.8 : 0.5,
        });
      } else if (chart === 'two') {
        out.surprise = true;
        fact({
          id: `sit:decision:${idx}`, kind: 'decision', about: [off],
          text: `A simple 2-point chart says go for two ${lead} this late, but ${city(off)} kicked.`,
          weight: 0.7,
        });
      } else {
        out.obvious = true;
      }
    }
    if (play.kind === 'field_goal' && play.yardline100 !== null) {
      // The official kick distance once the snap happened (not penalty information); else line of scrimmage + 17.
      const dist = play.result.kickDistance ?? play.yardline100 + 17;
      fact({
        id: `sit:fg:${idx}`, kind: 'decision', about: [off, ...(play.players.kicker ? [play.players.kicker] : [])],
        text: `NFL kickers make about ${fgMakeRate(dist)}% of field goals from ${dist} yards.`,
        weight: dist >= 50 ? 0.5 : 0.2,
      });
    }
  }

  // 3. Drive so far: back to the last change of possession or kickoff.
  if (off && isScrimmage(play)) {
    let start = idx;
    for (let i = idx - 1; i >= 0; i--) {
      const p = plays[i];
      if (p.kind === 'timeout' || p.kind === 'end_of_period') continue;
      if (p.kind === 'kickoff' || p.posteam !== off || !isScrimmage(p)) break;
      start = i;
    }
    let n = 0;
    let yards = 0;
    for (let i = start; i <= idx; i++) {
      const p = plays[i];
      if (!isScrimmage(p) || !usable(p, i)) continue;
      if (p.kind === 'punt' || p.kind === 'field_goal') continue; // kicks end drives; not "drive yards"
      const pen = p.penalty;
      if (pen && pen.status === 'accepted') yards += pen.side === 'defense' ? pen.yards : -pen.yards;
      if (!wiped(p)) { n++; yards += p.yardsGained ?? 0; }
    }
    const used = plays[start].gameSecondsRemaining - play.gameSecondsRemaining;
    if (n >= 3) {
      fact({
        id: `sit:drive:${idx}`, kind: 'drive', about: [off],
        text: `This ${city(off)} drive has ${yards >= 0 ? `gone ${n} plays and ${yards}` : `run ${n} plays and lost ${-yards}`} ${Math.abs(yards) === 1 ? 'yard' : 'yards'} in ${mmss(Math.max(0, used))}.`,
        weight: n >= 10 || used >= 300 ? 0.35 : 0.2,
      });
    }
  }

  // 4. Game stats so far for the players in this play (structured fields only: never the official text).
  const stats = new Map<string, Stat>();
  const get = (k: string) => { let s = stats.get(k); if (!s) { s = emptyStat(); stats.set(k, s); } return s; };
  seen.forEach((p, i) => {
    if (!usable(p, i) || wiped(p)) return;
    const { passer, receiver, rusher } = p.players;
    if (p.kind === 'pass' && passer && !p.result.sack) {
      const s = get(passer);
      s.att++;
      const complete = !p.result.incomplete && p.result.turnover !== 'interception';
      if (complete) {
        s.cmp++;
        s.passYds += p.yardsGained ?? 0;
        if (p.result.touchdown && (p.result.tdTeam ?? p.posteam) === p.posteam) s.passTd++;
        if (receiver) { const r = get(receiver); r.rec++; r.recYds += p.yardsGained ?? 0; }
      }
    }
    if (p.kind === 'run' && rusher) { const s = get(rusher); s.car++; s.rushYds += p.yardsGained ?? 0; }
  });
  const inPlay = [...new Set([play.players.passer, play.players.rusher, play.players.receiver].filter((k): k is string => !!k))];
  for (const key of inPlay) {
    const s = stats.get(key);
    if (!s) continue;
    const name = lastName(key);
    const parts: string[] = [];
    if (s.att >= 3) parts.push(`${s.cmp} of ${s.att} for ${s.passYds} yards${s.passTd ? ` and ${s.passTd} touchdown${s.passTd > 1 ? 's' : ''}` : ''}`);
    if (s.car >= 3) parts.push(`${s.car} carries for ${s.rushYds} yards`);
    if (s.rec >= 2) parts.push(`${s.rec} catches for ${s.recYds} yards`);
    if (!parts.length) continue;
    const verb = s.att >= 3 && parts.length === 1 ? 'is' : 'has';
    const big = s.passYds >= 250 || s.rushYds >= 100 || s.recYds >= 100;
    fact({
      id: `sit:stat:${idx}:${key}`, kind: 'game_stat', about: [...(off ? [off] : []), key],
      text: `${name} ${verb} ${parts.join(', plus ')} so far.`,
      weight: big ? 0.4 : 0.2,
    });
  }

  // 5. Team tendencies so far.
  if (off) {
    let thirdAtt = 0;
    let thirdConv = 0;
    let passN = 0;
    let runN = 0;
    let fourthAtt = 0;
    let fourthConv = 0;
    seen.forEach((p, i) => {
      if (p.posteam !== off || !usable(p, i)) return;
      const w = wiped(p);
      const moved = p.result.firstDown || (p.result.touchdown && (p.result.tdTeam ?? p.posteam) === off);
      const snap = p.kind === 'pass' || p.kind === 'run' || p.kind === 'penalty_only';
      // A replayed down isn't an attempt; a flag that moves the chains counts as a conversion.
      if (snap && (!w || moved)) {
        if (p.down === 3) { thirdAtt++; if (moved) thirdConv++; }
        if (p.down === 4 && p.kind !== 'penalty_only') { fourthAtt++; if (moved) fourthConv++; }
      }
      if (!w && p.kind === 'pass') passN++;
      if (!w && p.kind === 'run') runN++;
    });
    if ((play.down === 3 || play.down === 4) && thirdAtt >= 3) {
      fact({
        id: `sit:third:${idx}`, kind: 'tendency', about: [off],
        text: `${city(off)} has converted ${thirdConv} of ${thirdAtt} third downs so far.`,
        weight: 0.3,
      });
    }
    if (passN + runN >= 10) {
      const share = Math.round((passN / (passN + runN)) * 100);
      fact({
        id: `sit:split:${idx}`, kind: 'tendency', about: [off],
        text: `${city(off)} has thrown on ${share}% of its plays so far (${passN} passes, ${runN} runs).`,
        weight: share >= 65 || share <= 35 ? 0.3 : 0.15,
      });
    }
    const wentNow = play.decision?.kind === 'fourth_down' && (play.kind === 'pass' || play.kind === 'run') && usable(play, idx) && !wiped(play);
    if (wentNow && fourthAtt >= 2) {
      const prior = fourthAtt - 1;
      const priorConv = fourthConv - (play.result.firstDown || play.result.touchdown ? 1 : 0);
      fact({
        id: `sit:fourth:${idx}`, kind: 'tendency', about: [off],
        text: `That's ${city(off)}'s ${nth(fourthAtt)} fourth-down try today; they converted ${priorConv} of the first ${prior}.`,
        weight: 0.45,
      });
    }
  }

  return out;
}

/** The IntelProvider.situation implementation for one game's team table. */
export function makeSituation(teams?: Record<string, TeamInfo>): IntelProvider['situation'] {
  return (plays, idx, stage) => situationIntel(plays, idx, stage, teams);
}
