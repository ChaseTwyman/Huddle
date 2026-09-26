import type { Row } from '../data/timeline';

/**
 * F14 live mode: map ESPN's public NFL game feed (site.api.espn.com .../summary?event=ID) onto the nflverse
 * row shape, so the existing timeline builder, tagger, penalty parser and decisions work unchanged.
 * Only the fields Huddle reads are typed here.
 */
export type EspnTeam = { id: string; abbreviation: string; displayName?: string; location?: string; name?: string };
export type EspnSide = { down?: number; distance?: number; yardLine?: number; yardsToEndzone?: number; downDistanceText?: string; team?: { id: string } };
export type EspnPlay = {
  id: string; sequenceNumber: string; type: { id?: string; text: string }; text: string;
  awayScore: number; homeScore: number; period: { number: number }; clock: { displayValue: string };
  scoringPlay?: boolean; wallclock?: string; isPenalty?: boolean; statYardage?: number; isTurnover?: boolean;
  start: EspnSide; end: EspnSide;
};
export type EspnSummary = {
  header: {
    id: string;
    competitions: {
      date?: string;
      status: { type: { state: 'pre' | 'in' | 'post'; completed?: boolean; detail?: string; shortDetail?: string } };
      competitors: { homeAway: 'home' | 'away'; score?: string; team: EspnTeam }[];
    }[];
  };
  drives?: { previous?: { plays?: EspnPlay[] }[]; current?: { plays?: EspnPlay[] } };
};

export type EspnGameMeta = { eventId: string; home: string; away: string; title: string; date: string; state: 'pre' | 'in' | 'post'; detail: string };

export function gameMeta(s: EspnSummary): EspnGameMeta {
  const comp = s.header.competitions[0];
  const home = comp.competitors.find((c) => c.homeAway === 'home')!.team;
  const away = comp.competitors.find((c) => c.homeAway === 'away')!.team;
  return {
    eventId: s.header.id, home: home.abbreviation, away: away.abbreviation,
    title: `${away.abbreviation} at ${home.abbreviation} (live)`, date: (comp.date ?? '').slice(0, 10),
    state: comp.status.type.state, detail: comp.status.type.shortDetail ?? comp.status.type.detail ?? '',
  };
}

/** All plays in feed order (previous drives, then the current drive), de-duplicated by id. */
export function allPlays(s: EspnSummary): EspnPlay[] {
  const out: EspnPlay[] = [];
  const seen = new Set<string>();
  const push = (p: EspnPlay) => { if (!seen.has(p.id)) { seen.add(p.id); out.push(p); } };
  for (const d of s.drives?.previous ?? []) for (const p of d.plays ?? []) push(p);
  for (const p of s.drives?.current?.plays ?? []) push(p);
  return out.sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber));
}

const SKIP_TYPES = /^(Official Timeout|Timeout - Injury)$/i;

function playType(t: string): { play_type?: string; play_type_nfl?: string } {
  if (/^Timeout$/i.test(t)) return { play_type: 'no_play', play_type_nfl: 'TIMEOUT' };
  if (/^End of Game$/i.test(t)) return { play_type_nfl: 'END_GAME' };
  if (/^End (Period|of Half)$/i.test(t)) return { play_type_nfl: 'END_QUARTER' };
  if (/Two-minute warning/i.test(t)) return { play_type_nfl: 'TWO_MINUTE_WARNING' };
  if (/^Penalty$/i.test(t)) return { play_type: 'no_play', play_type_nfl: 'PENALTY' };
  if (/Kickoff/i.test(t)) return { play_type: 'kickoff', play_type_nfl: 'KICK_OFF' };
  if (/Punt/i.test(t)) return { play_type: 'punt', play_type_nfl: 'PUNT' };
  if (/Field Goal/i.test(t)) return { play_type: 'field_goal', play_type_nfl: 'FIELD_GOAL' };
  if (/Pass|Sack|Interception/i.test(t)) return { play_type: 'pass', play_type_nfl: 'PASS' };
  if (/Rush|Fumble/i.test(t)) return { play_type: 'run', play_type_nfl: 'RUSH' };
  return { play_type: 'no_play', play_type_nfl: 'OTHER' };
}

const clockSecs = (c: string) => {
  const m = /^(\d+):(\d{2})$/.exec(c.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

/** Split "…, TOUCHDOWN. X extra point is GOOD…" / "TWO-POINT CONVERSION ATTEMPT…" into the play and its try. */
export function splitTry(text: string): { play: string; tryText: string | null; kind: 'extra_point' | 'two_point' | null } {
  const two = text.search(/TWO-POINT CONVERSION ATTEMPT/i);
  if (two > 0) return { play: text.slice(0, two).trim(), tryText: text.slice(two).trim(), kind: 'two_point' };
  const xp = /\s+([A-Z][\w.'-]*\.[\w'-]+ extra point .*)$/i.exec(text);
  if (xp && /TOUCHDOWN/i.test(text.slice(0, xp.index))) return { play: text.slice(0, xp.index).trim(), tryText: xp[1].trim(), kind: 'extra_point' };
  return { play: text, tryText: null, kind: null };
}

export type MappedRow = Row & { espn_id: string; wallclock_ms: string };

/**
 * ESPN plays → nflverse-style rows. Scores in the feed are after the play, including the try that ESPN folds into
 * the touchdown play, so the touchdown row gets the score minus the try and the synthetic try row gets the full score.
 */
export function espnToRows(s: EspnSummary): MappedRow[] {
  const meta = gameMeta(s);
  const comp = s.header.competitions[0];
  const abbr = new Map(comp.competitors.map((c) => [c.team.id, c.team.abbreviation]));
  const other = (a: string | undefined) => (a === meta.home ? meta.away : a === meta.away ? meta.home : undefined);
  const rows: MappedRow[] = [];

  for (const p of allPlays(s)) {
    const t = p.type.text;
    if (SKIP_TYPES.test(t)) continue;
    const pt = playType(t);
    if (pt.play_type_nfl === 'TWO_MINUTE_WARNING') continue; // the tagger derives it from the clock
    const kickoff = pt.play_type === 'kickoff';
    const posteam = kickoff ? abbr.get(p.end?.team?.id ?? '') ?? other(abbr.get(p.start?.team?.id ?? '')) : abbr.get(p.start?.team?.id ?? '');
    const qtr = p.period.number;
    const secs = clockSecs(p.clock.displayValue);
    const gsr = Math.max(0, (4 - Math.min(qtr, 4)) * 900 + secs);
    const { play: mainText, tryText, kind: tryKind } = splitTry(p.text);
    const down = p.start?.down && p.start.down >= 1 && p.start.down <= 4 ? p.start.down : null;
    let yl100 = p.start?.yardsToEndzone;
    if (kickoff) {
      const m = /kicks .* from ([A-Z]{2,3}) (\d+)/.exec(mainText);
      yl100 = m ? Number(m[2]) : 35;
    }
    const tdInMain = /TOUCHDOWN/i.test(mainText) && !/REVERSED/i.test(mainText.split('TOUCHDOWN').pop() ?? '');
    const tryPts = !tryText ? 0 : tryKind === 'extra_point' ? (/is GOOD/i.test(tryText) ? 1 : 0) : (/ATTEMPT SUCCEEDS/i.test(tryText) ? 2 : 0);
    const prev = rows[rows.length - 1];
    const prevHome = Number(prev?.total_home_score ?? 0);
    const prevAway = Number(prev?.total_away_score ?? 0);
    // Which side scored the try: whoever's score rose.
    const homeRose = p.homeScore > prevHome;
    const mainHome = tryPts && homeRose ? p.homeScore - tryPts : p.homeScore;
    const mainAway = tryPts && !homeRose ? p.awayScore - tryPts : p.awayScore;
    const scorer = p.homeScore > prevHome ? meta.home : p.awayScore > prevAway ? meta.away : undefined;
    const fg = pt.play_type === 'field_goal' ? (/is GOOD/i.test(mainText) ? 'made' : /BLOCKED/i.test(mainText) ? 'blocked' : 'missed') : undefined;
    const pen = /PENALTY on/i.test(mainText);
    const penYards = /PENALTY on [^,]+,[^,]+, (\d+) yards?/i.exec(mainText);
    const firstDown = !!p.end?.down && p.end.down === 1 && p.end?.team?.id === p.start?.team?.id && !tdInMain && !kickoff;
    const base: Row = {
      play_id: p.sequenceNumber, game_id: `espn_${meta.eventId}`,
      home_team: meta.home, away_team: meta.away,
      posteam, defteam: other(posteam),
      qtr: String(qtr), time: p.clock.displayValue, game_seconds_remaining: String(gsr),
      down: down ? String(down) : '', ydstogo: down && p.start?.distance != null ? String(p.start.distance) : '',
      yardline_100: yl100 != null ? String(yl100) : '',
      goal_to_go: /Goal/i.test(p.start?.downDistanceText ?? '') ? '1' : '0',
      desc: mainText, ...pt,
      yards_gained: p.statYardage != null ? String(p.statYardage) : '',
      touchdown: tdInMain ? '1' : '0', td_team: tdInMain ? scorer ?? posteam : undefined,
      field_goal_result: fg, kick_distance: fg ? (/(\d+) yard field goal/i.exec(mainText)?.[1] ?? '') : undefined,
      first_down: firstDown ? '1' : '0',
      penalty: pen ? '1' : '0', penalty_yards: penYards?.[1],
      incomplete_pass: /Incompletion/i.test(t) || /pass incomplete/i.test(mainText) ? '1' : '0',
      sack: /Sack/i.test(t) || /\bsacked\b/i.test(mainText) ? '1' : '0',
      interception: /Interception/i.test(t) ? '1' : '0',
      fumble_lost: p.isTurnover && /FUMBLE/i.test(mainText) ? '1' : '0',
      safety: /\bSAFETY\b/.test(mainText) ? '1' : '0',
      touchback: /Touchback/i.test(mainText) ? '1' : '0',
      two_point_attempt: '0', qb_kneel: /\bkneels\b/i.test(mainText) ? '1' : '0', qb_spike: /\bspiked\b/i.test(mainText) ? '1' : '0',
      total_home_score: String(mainHome), total_away_score: String(mainAway),
      replay_or_challenge: /challenged|Replay Official|reviewed/i.test(mainText) ? '1' : '0',
    };
    if (pt.play_type_nfl === 'TIMEOUT') base.timeout_team = /by ([A-Z]{2,3})/.exec(mainText)?.[1];
    if (base.qb_kneel === '1') base.play_type = 'qb_kneel';
    const wall = p.wallclock ? String(Date.parse(p.wallclock)) : '';
    rows.push({ ...base, espn_id: p.id, wallclock_ms: wall });
    if (tryText && tryKind && posteam) {
      const tryRow: Row = {
        ...base, play_id: `${p.sequenceNumber}.5`, desc: tryText, down: '', ydstogo: '', goal_to_go: '0',
        touchdown: '0', td_team: undefined, first_down: '0', penalty: /PENALTY on/i.test(tryText) ? '1' : '0', penalty_yards: undefined,
        total_home_score: String(p.homeScore), total_away_score: String(p.awayScore), yards_gained: '',
        field_goal_result: undefined, kick_distance: undefined, incomplete_pass: '0', sack: '0', interception: '0', fumble_lost: '0',
        ...(tryKind === 'extra_point'
          ? { play_type: 'extra_point', play_type_nfl: 'XP_KICK', yardline_100: '15', extra_point_result: /is GOOD/i.test(tryText) ? 'good' : /BLOCKED/i.test(tryText) ? 'blocked' : 'failed' }
          : { play_type: /\bpass\b/i.test(tryText) ? 'pass' : 'run', play_type_nfl: 'PAT2', yardline_100: '2', two_point_attempt: '1', two_point_conv_result: /ATTEMPT SUCCEEDS/i.test(tryText) ? 'success' : 'failure' }),
      };
      rows.push({ ...tryRow, espn_id: `${p.id}.try`, wallclock_ms: wall });
    }
  }
  return rows;
}
