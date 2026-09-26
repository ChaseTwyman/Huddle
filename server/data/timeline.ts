import type { Moment, MomentsFile, PlayKind, Segment, Storyline, Timeline, TimelinePlay } from '../../shared/types';
import { team } from '../../shared/teams';
import { concept, hasConcept } from './concepts';
import { AUTO_FIRST_DOWN_ON_DEFENSE, mapPenaltyType } from './penalties';
import { tag, type GameCtx } from './tagger';
import { cleanDesc } from '../game/ticker';
import { anyInvolvement } from '../game/involvement';

export type Row = Record<string, string | undefined>;

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const flag = (v: string | undefined) => num(v) === 1;
const str = (v: string | undefined): string | undefined => (v && v !== 'NA' ? v : undefined);

export const lastName = (pbp: string) => {
  const i = pbp.indexOf('.');
  return i >= 0 ? pbp.slice(i + 1) : pbp;
};

export const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

/** "PHI 15" style ball position. */
export function ballOn(play: Pick<TimelinePlay, 'yardline100' | 'posteam' | 'defteam'>): string | null {
  const y = play.yardline100;
  if (y === null || !play.posteam) return null;
  if (y === 50) return '50';
  return y > 50 ? `${play.posteam} ${100 - y}` : `${play.defteam ?? ''} ${y}`.trim();
}

export function downDistance(play: Pick<TimelinePlay, 'down' | 'ydstogo' | 'goalToGo'>): string | null {
  if (play.down === null || play.ydstogo === null) return null;
  return `${ordinal(play.down)} & ${play.goalToGo ? 'Goal' : play.ydstogo}`;
}

function formatClock(time: string | undefined): string {
  if (!time) return '';
  const m = /^(\d+):(\d{2})$/.exec(time.trim());
  return m ? `${Number(m[1])}:${m[2]}` : time;
}

function kindOf(row: Row, desc: string, penalty: boolean): PlayKind {
  const nfl = row.play_type_nfl ?? '';
  const pt = row.play_type ?? '';
  if (nfl === 'TIMEOUT') return 'timeout';
  if (/^END_(QUARTER|GAME|HALF)/.test(nfl)) return 'end_of_period';
  if (flag(row.two_point_attempt) || nfl === 'PAT2') return 'two_point';
  if (flag(row.qb_kneel) || pt === 'qb_kneel') return 'kneel';
  if (flag(row.qb_spike) || pt === 'qb_spike') return 'spike';
  switch (pt) {
    case 'pass': return 'pass';
    case 'run': return 'run';
    case 'punt': return 'punt';
    case 'field_goal': return 'field_goal';
    case 'extra_point': return 'extra_point';
    case 'kickoff': return 'kickoff';
  }
  if (pt === 'no_play' || penalty) {
    const action = cleanDesc(desc).replace(/Flag on the play\.$/, '').trim();
    if (!action) return 'penalty_only';
    if (/\bpass\b|\bsacked\b/i.test(action)) return 'pass';
    if (/\bpunts\b/i.test(action)) return 'punt';
    if (/field goal/i.test(action)) return 'field_goal';
    if (/\bkicks\b/i.test(action)) return 'kickoff';
    return 'run';
  }
  return 'other';
}

function penaltyTypeFromDesc(desc: string): string | null {
  const m = /penalty on [^,]+,\s*([^,]+),/i.exec(desc);
  return m ? m[1].trim() : null;
}

export function buildAnnouncement(p: {
  rawType: string; conceptId: string; team: string; side: 'offense' | 'defense'; yards: number; player?: string;
  autoFirstDown: boolean; status: 'accepted' | 'declined' | 'offsetting'; noPlay: boolean; gainedFirstDown: boolean;
}, down: number | null): string {
  const name = p.conceptId === 'penalty_other' ? p.rawType : concept(p.conceptId).name;
  const city = team(p.team).city;
  if (p.status === 'offsetting') return 'Offsetting fouls. Replay the down.';
  if (p.status === 'declined') return `${name} on ${city}. Declined.`;
  let s = `${name}, ${city}${p.player ? `, ${lastName(p.player)}` : ''}. ${p.yards} ${p.yards === 1 ? 'yard' : 'yards'}`;
  if (p.autoFirstDown) s += ', automatic first down';
  else if (p.gainedFirstDown) s += '. First down';
  else if (p.noPlay && down) s += `. Replay ${ordinal(down)} down`;
  return `${s}.`;
}

export type BuildResult = { timeline: Timeline; moments: MomentsFile; unknownPenalties: string[]; missingColumns: string[] };

export const WANTED_COLUMNS = 'play_id, game_id, home_team, away_team, posteam, defteam, qtr, time, quarter_seconds_remaining, game_seconds_remaining, down, ydstogo, yardline_100, goal_to_go, desc, play_type, play_type_nfl, yards_gained, return_yards, first_down, first_down_penalty, penalty, penalty_team, penalty_player_name, penalty_yards, penalty_type, touchdown, td_team, field_goal_attempt, field_goal_result, kick_distance, extra_point_attempt, extra_point_result, two_point_attempt, two_point_conv_result, fourth_down_converted, fourth_down_failed, punt_attempt, interception, fumble_lost, sack, incomplete_pass, timeout, timeout_team, home_timeouts_remaining, away_timeouts_remaining, total_home_score, total_away_score, replay_or_challenge, replay_or_challenge_result, passer_player_name, receiver_player_name, rusher_player_name, punt_returner_player_name, kickoff_returner_player_name, kicker_player_name, qb_kneel, qb_spike, touchback, safety, wp, wpa, drive'.split(', ');

export function buildTimeline(
  rowsIn: Row[],
  meta: { gameId: string; title: string; date: string },
  storylines: Storyline[] = [],
): BuildResult {
  const present = new Set(Object.keys(rowsIn[0] ?? {}));
  const missingColumns = WANTED_COLUMNS.filter((c) => !present.has(c));
  const rows = rowsIn.filter((r) => r.play_type_nfl !== 'GAME_START' && !/^GAME$/.test((r.desc ?? '').trim()));
  const home = rows[0]?.home_team ?? '';
  const away = rows[0]?.away_team ?? '';
  const ctx: GameCtx = { home, away };

  // Are total_*_score values before or after the play? Find a scoring row and compare to the previous row.
  let scoresAfter = true;
  for (let i = 1; i < rows.length; i++) {
    if (flag(rows[i].touchdown)) {
      const t = (r: Row) => (num(r.total_home_score) ?? 0) + (num(r.total_away_score) ?? 0);
      scoresAfter = t(rows[i]) > t(rows[i - 1]);
      break;
    }
  }
  const scoreOf = (r: Row | undefined) => ({ home: num(r?.total_home_score) ?? 0, away: num(r?.total_away_score) ?? 0 });

  const unknownPenalties = new Set<string>();
  const plays: TimelinePlay[] = [];
  let prevAfter = { home: 0, away: 0 };

  rows.forEach((row, i) => {
    const desc = (row.desc ?? '').trim();
    const hasPenalty = flag(row.penalty) || /\bpenalty on\b/i.test(desc);
    const kind = kindOf(row, desc, hasPenalty);
    const posteam = str(row.posteam) ?? null;
    const defteam = str(row.defteam) ?? null;
    const d = num(row.down);
    const down = d && d >= 1 && d <= 4 ? (d as 1 | 2 | 3 | 4) : null;
    const ydstogo = down ? num(row.ydstogo) : null;
    const yardline100 = kind === 'timeout' || kind === 'end_of_period' ? null : num(row.yardline_100);
    const scoreAfter = scoresAfter ? scoreOf(row) : scoreOf(rows[i + 1] ?? row);
    const scoreBefore = prevAfter;
    prevAfter = scoreAfter;
    const hto = num(row.home_timeouts_remaining);
    const ato = num(row.away_timeouts_remaining);

    const players: TimelinePlay['players'] = {
      passer: str(row.passer_player_name), receiver: str(row.receiver_player_name), rusher: str(row.rusher_player_name),
      returner: str(row.punt_returner_player_name) ?? str(row.kickoff_returner_player_name),
      kicker: str(row.kicker_player_name), penaltyPlayer: str(row.penalty_player_name),
    };
    if (kind === 'two_point' && !players.rusher && !players.receiver) {
      const run = /([A-Z][a-z]*\.[A-Za-z'-]+) rushes/.exec(desc);
      const pass = /([A-Z][a-z]*\.[A-Za-z'-]+) pass to (?:\d+-)?([A-Z][a-z]*\.[A-Za-z'-]+)/.exec(desc);
      if (run) players.rusher = run[1];
      if (pass) { players.passer = pass[1]; players.receiver = pass[2]; }
    }
    for (const k of Object.keys(players) as (keyof typeof players)[]) if (!players[k]) delete players[k];

    const fgr = str(row.field_goal_result);
    const xpr = str(row.extra_point_result);
    const tpr = str(row.two_point_conv_result);
    const result: TimelinePlay['result'] = {
      touchdown: flag(row.touchdown),
      firstDown: flag(row.first_down),
      sack: flag(row.sack),
      incomplete: flag(row.incomplete_pass),
      safety: flag(row.safety),
      touchback: flag(row.touchback),
      fairCatch: /fair catch/i.test(desc),
    };
    if (result.touchdown && str(row.td_team)) result.tdTeam = str(row.td_team);
    if (fgr === 'made' || fgr === 'missed' || fgr === 'blocked') result.fieldGoal = fgr;
    if (kind === 'field_goal' && num(row.kick_distance) !== null) result.kickDistance = num(row.kick_distance)!;
    if (xpr === 'good' || xpr === 'failed' || xpr === 'blocked') result.extraPoint = xpr;
    if (kind === 'two_point') result.twoPoint = tpr === 'success' || /ATTEMPT SUCCEEDS/i.test(desc) ? 'success' : 'failure';
    if (flag(row.interception)) result.turnover = 'interception';
    else if (flag(row.fumble_lost)) result.turnover = 'fumble';
    else if (flag(row.fourth_down_failed) && (kind === 'pass' || kind === 'run')) result.turnover = 'downs';

    let penalty: TimelinePlay['penalty'] = null;
    if (hasPenalty) {
      const rawType = str(row.penalty_type) ?? penaltyTypeFromDesc(desc) ?? 'Penalty';
      const mapped = mapPenaltyType(rawType);
      if (!mapped.known) unknownPenalties.add(rawType);
      const fromDesc = /penalty on ([A-Z]{2,3})(?:-\d+-([A-Z][A-Za-z.'-]+))?,/i.exec(desc);
      const pteam = str(row.penalty_team) ?? fromDesc?.[1] ?? '';
      if (!players.penaltyPlayer && fromDesc?.[2]) players.penaltyPlayer = fromDesc[2];
      const side: 'offense' | 'defense' = pteam && posteam ? (pteam === posteam ? 'offense' : 'defense') : (mapped.side ?? 'defense');
      const status: 'accepted' | 'declined' | 'offsetting' = /offsetting/i.test(desc) ? 'offsetting' : /declined/i.test(desc) ? 'declined' : 'accepted';
      const c = hasConcept(mapped.conceptId) ? concept(mapped.conceptId) : null;
      const autoFirstDown = !!c?.autoFirstDown || (side === 'defense' && AUTO_FIRST_DOWN_ON_DEFENSE.has(mapped.conceptId));
      const yards = num(row.penalty_yards) ?? 0;
      const noPlay = row.play_type === 'no_play';
      const gainedFirstDown = flag(row.first_down_penalty) || (side === 'defense' && ydstogo !== null && yards >= ydstogo);
      const base = {
        rawType, conceptId: mapped.conceptId, team: pteam, side, yards, player: players.penaltyPlayer,
        autoFirstDown, status, noPlay, preSnap: !!c?.preSnap,
      };
      penalty = { ...base, announcement: buildAnnouncement({ ...base, gainedFirstDown }, down) };
      if (!penalty.player) delete penalty.player;
    }

    const losAbs = yardline100 === null || !posteam ? null : posteam === home ? 100 - yardline100 : yardline100;
    const dir = posteam === home ? 1 : -1;
    const firstDownAbs = losAbs === null || ydstogo === null || !down || /* goal to go */ flag(row.goal_to_go) ? null : Math.max(0, Math.min(100, losAbs + dir * ydstogo));

    const play: TimelinePlay = {
      idx: plays.length,
      playId: num(row.play_id) ?? i,
      qtr: num(row.qtr) ?? 1,
      clock: formatClock(row.time),
      gameSecondsRemaining: num(row.game_seconds_remaining) ?? 0,
      posteam: kind === 'timeout' || kind === 'end_of_period' ? null : posteam,
      defteam: kind === 'timeout' || kind === 'end_of_period' ? null : defteam,
      down, ydstogo, yardline100,
      goalToGo: flag(row.goal_to_go),
      scoreBefore, scoreAfter,
      timeoutsBefore: hto !== null && ato !== null ? { home: hto, away: ato } : null,
      kind,
      desc,
      publicDesc: cleanDesc(desc),
      yardsGained: num(row.yards_gained),
      returnYards: num(row.return_yards),
      players,
      result,
      penalty,
      challenge: flag(row.replay_or_challenge) ? { result: str(row.replay_or_challenge_result) ?? 'unknown' } : null,
      decision: null,
      concepts: [],
      momentKeys: [],
      notable: false,
      field: { losAbs, firstDownAbs, ballEndAbs: null },
    };
    const wp = num(row.wp);
    const wpa = num(row.wpa);
    if (wp !== null) play.wp = wp;
    if (wpa !== null) play.wpa = wpa;
    if (kind === 'timeout') {
      const tt = str(row.timeout_team);
      if (tt) play.publicDesc = `Timeout, ${team(tt).city}.`;
    }
    if (kind === 'end_of_period') play.publicDesc = play.qtr >= 4 ? 'End of the game.' : `End of quarter ${play.qtr}.`;

    // Decisions (6.6)
    if (down === 4 && (kind === 'pass' || kind === 'run' || kind === 'punt' || kind === 'field_goal')) {
      play.decision = { kind: 'fourth_down' };
    } else if (kind === 'two_point') {
      play.decision = { kind: 'two_point' };
    } else if (kind === 'field_goal' && down !== null && down <= 3) {
      play.decision = { kind: 'field_goal' };
    }
    plays.push(play);
  });

  // Ball end positions (second pass: needs the next play).
  const home_ = home;
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const f = p.field;
    if (f.losAbs === null) continue;
    const dir = p.posteam === home_ ? 1 : -1;
    if (p.result.touchdown) {
      const scorerHome = (p.result.tdTeam ?? p.posteam) === home_;
      f.ballEndAbs = scorerHome ? 100 : 0;
      continue;
    }
    if (p.penalty?.noPlay) { f.ballEndAbs = f.losAbs; continue; }
    if (p.kind === 'extra_point' || p.kind === 'two_point' || p.kind === 'field_goal') {
      f.ballEndAbs = p.posteam === home_ ? 100 : 0; // the kick or try heads for the goal
      if (p.kind === 'two_point' && p.result.twoPoint === 'failure') f.ballEndAbs = f.losAbs + dir;
      if (p.kind === 'field_goal' && p.result.fieldGoal !== 'made') f.ballEndAbs = f.losAbs;
      continue;
    }
    const next = plays.slice(i + 1).find((q) => q.field.losAbs !== null);
    const sameDrive = next && next.posteam === p.posteam && next.kind !== 'kickoff' && next.kind !== 'extra_point' && next.kind !== 'two_point';
    const changeOfPossession = next && (p.kind === 'punt' || p.kind === 'kickoff' || !!p.result.turnover) && next.kind !== 'kickoff';
    if (next && (sameDrive || changeOfPossession)) f.ballEndAbs = next.field.losAbs;
    else f.ballEndAbs = Math.max(0, Math.min(100, f.losAbs + dir * (p.yardsGained ?? 0)));
  }

  // Tag concepts and notability.
  const assignable = storylines;
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    p.concepts = tag(p, i > 0 ? plays[i - 1] : null, ctx);
    const scored = p.scoreAfter.home !== p.scoreBefore.home || p.scoreAfter.away !== p.scoreBefore.away;
    p.notable = !!p.decision || !!p.penalty || scored || !!p.result.turnover || !!p.challenge
      || Math.abs(p.wpa ?? 0) >= 0.08 || (p.yardsGained ?? 0) >= 20 || (p.returnYards ?? 0) >= 20
      || !!anyInvolvement(p, assignable);
    if (p.kind === 'timeout' || p.kind === 'end_of_period') p.notable = false;
  }

  const moments = detectMoments(plays, storylines);
  const last = plays[plays.length - 1];
  const timeline: Timeline = {
    gameId: meta.gameId, title: meta.title, date: meta.date, home, away,
    finalScore: last ? last.scoreAfter : { home: 0, away: 0 },
    plays,
  };
  return { timeline, moments, unknownPenalties: [...unknownPenalties], missingColumns };
}

const has = (name: string | undefined, needle: string) => !!name && name.includes(needle);

export const REQUIRED_MOMENTS = ['toney-return', 'toney-td', 'hurts-2pt', 'bradberry-flag', 'butker-fg', 'halftime', 'final'] as const;

/** Find the required moment keys (6.6). Missing keys are simply absent. */
export function findMomentKeys(plays: TimelinePlay[]): Record<string, number> {
  const keys: Record<string, number> = {};
  const find = (key: string, pred: (p: TimelinePlay) => boolean) => {
    const p = plays.find(pred);
    if (p) keys[key] = p.idx;
  };
  find('toney-return', (p) => p.kind === 'punt' && has(p.players.returner, 'Toney') && (p.returnYards ?? 0) >= 60);
  find('toney-td', (p) => p.result.touchdown && has(p.players.receiver, 'Toney'));
  find('hurts-2pt', (p) => p.kind === 'two_point' && p.result.twoPoint === 'success' && (has(p.players.rusher, 'Hurts') || /Hurts rushes/.test(p.desc)));
  find('bradberry-flag', (p) => !!p.penalty && has(p.penalty.player, 'Bradberry') && /holding/i.test(p.penalty.rawType));
  find('butker-fg', (p) => p.qtr === 4 && p.kind === 'field_goal' && p.result.kickDistance === 27 && has(p.players.kicker, 'Butker'));
  find('halftime', (p) => p.qtr === 3);
  if (plays.length) keys.final = plays[plays.length - 1].idx;
  return keys;
}

function isRealPlay(p: TimelinePlay) {
  return p.kind !== 'timeout' && p.kind !== 'end_of_period';
}

/** Index `n` real plays before `idx` (timeouts and period ends don't count). */
export function leadIn(plays: TimelinePlay[], idx: number, n: number): number {
  let i = idx;
  let count = 0;
  while (i > 0 && count < n) {
    i--;
    if (isRealPlay(plays[i])) count++;
  }
  return i;
}

/** Spoiler-free label for the TV jump list: time, possession, and down & distance only. */
export function publicMomentLabel(p: TimelinePlay): string {
  const dd = downDistance(p);
  const on = ballOn(p);
  return [`Q${p.qtr} ${p.clock}`, p.posteam, dd && on ? `${dd} at ${on}` : null].filter(Boolean).join(' · ');
}

export function detectMoments(plays: TimelinePlay[], storylines: Storyline[]): MomentsFile {
  const keys = findMomentKeys(plays);
  for (const [k, idx] of Object.entries(keys)) plays[idx].momentKeys.push(k);
  const moments: Moment[] = [];
  for (const p of plays) {
    if (!p.notable && p.momentKeys.length === 0) continue;
    const features: string[] = [];
    if (p.penalty) features.push('Flag');
    if (p.decision) features.push('Decision');
    if (p.scoreAfter.home !== p.scoreBefore.home || p.scoreAfter.away !== p.scoreBefore.away) features.push('Score');
    if (p.result.turnover) features.push('Turnover');
    if (p.challenge) features.push('Review');
    if ((p.yardsGained ?? 0) >= 20 || (p.returnYards ?? 0) >= 20) features.push('Big play');
    const inv = anyInvolvement(p, storylines);
    if (inv) features.push(`Storyline: ${inv.storylineId}`);
    const dd = downDistance(p);
    const on = ballOn(p);
    const label = [`Q${p.qtr} ${p.clock}`, features.filter((f) => !f.startsWith('Storyline')).join(', ') || p.kind, dd && on ? `${dd} at ${on}` : null]
      .filter(Boolean).join(' · ');
    moments.push({ id: p.momentKeys[0] ?? `m${p.idx}`, idx: p.idx, label, publicLabel: publicMomentLabel(p), qtr: p.qtr, clock: p.clock, features });
  }
  const segments: Segment[] = [];
  const seg = (id: string, label: string, start: number | undefined, end: number | undefined) => {
    if (start === undefined || end === undefined) return;
    segments.push({ id, label, startIdx: start, endIdx: end });
  };
  if (keys['toney-return'] !== undefined) {
    const r = keys['toney-return'];
    seg('A', `A · Q${plays[r].qtr} ${plays[leadIn(plays, r, 2)].clock} · ${plays[r].posteam} drive`, leadIn(plays, r, 2), r);
  }
  if (keys['hurts-2pt'] !== undefined) {
    const t = keys['hurts-2pt'];
    seg('B', `B · Q${plays[t].qtr} ${plays[leadIn(plays, t, 2)].clock} · ${plays[t].posteam} drive`, leadIn(plays, t, 2), t);
  }
  if (keys['bradberry-flag'] !== undefined && keys['butker-fg'] !== undefined) {
    const b = keys['bradberry-flag'];
    seg('C', `C · Q${plays[b].qtr} ${plays[leadIn(plays, b, 2)].clock} · Tied, ${plays[b].posteam} ball`, leadIn(plays, b, 2), keys['butker-fg']);
  }
  return { moments, segments, keys };
}
