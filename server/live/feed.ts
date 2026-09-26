import type { GameData } from '../data/loadGame';
import { buildTimeline } from '../data/timeline';
import type { Clock, TimerHandle } from '../room/clock';
import { allPlays, espnToRows, gameMeta, type EspnGameMeta, type EspnSummary, type MappedRow } from './espn';

import type { League } from '../../shared/types';

const SPORT: Record<League, string> = { nfl: 'nfl', college: 'college-football' };
const SUMMARY_URL = (id: string, league: League) => `https://site.api.espn.com/apis/site/v2/sports/football/${SPORT[league]}/summary?event=${encodeURIComponent(id)}`;
const SCOREBOARD_URL = (league: League) => `https://site.api.espn.com/apis/site/v2/sports/football/${SPORT[league]}/scoreboard`;

export interface FeedSource {
  fetch(): Promise<EspnSummary>;
  /** Called when the room kicks off (replays start their clock here). */
  begin?(): void;
  /** Convert a feed wall-clock time (epoch ms) to this source's clock (identity for live; scaled for replays). */
  toLocal(wallMs: number): number;
  readonly kind: 'live' | 'replay';
}

export async function fetchSummary(eventId: string, league: League = 'nfl'): Promise<EspnSummary> {
  const res = await fetch(SUMMARY_URL(eventId, league), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN summary HTTP ${res.status}`);
  return (await res.json()) as EspnSummary;
}

export type LiveListing = { eventId: string; name: string; shortName: string; state: 'pre' | 'in' | 'post'; detail: string; date: string };

/** This week's games from ESPN's scoreboard (NFL, or college football's featured games). */
export async function listLiveGames(league: League = 'nfl'): Promise<LiveListing[]> {
  const res = await fetch(SCOREBOARD_URL(league), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN scoreboard HTTP ${res.status}`);
  const j = (await res.json()) as { events?: { id: string; name: string; shortName: string; date: string; status: { type: { state: 'pre' | 'in' | 'post'; shortDetail?: string; detail?: string } } }[] };
  return (j.events ?? []).map((e) => ({
    eventId: e.id, name: e.name, shortName: e.shortName, date: e.date,
    state: e.status.type.state, detail: e.status.type.shortDetail ?? e.status.type.detail ?? '',
  }));
}

/** Polls ESPN for a game in progress. Feed times are real epoch ms, same as the real clock. */
export class EspnSource implements FeedSource {
  readonly kind = 'live' as const;
  constructor(private eventId: string, private league: League = 'nfl') {}
  fetch() { return fetchSummary(this.eventId, this.league); }
  toLocal(wallMs: number) { return wallMs; }
}

/**
 * Plays back a finished game as if it were live: the feed reveals each play at its original wall-clock time
 * (optionally sped up), relative to when the replay started. Used for demos without a live game, and for tests.
 */
export class ReplaySource implements FeedSource {
  readonly kind = 'replay' as const;
  private t0: number | null = null;
  private wall0: number;
  /**
   * @param postLagMs how long after a play happens the feed posts it. Real feeds lag (often until after the
   * referee's announcement); 0 = optimistic. Tests use it to show why the camera flag spotter matters.
   */
  constructor(private full: EspnSummary, private clock: Clock, private speed = 1, private lead = 3000, private postLagMs = 0) {
    const walls = allPlays(full).map((p) => Date.parse(p.wallclock ?? '')).filter(Number.isFinite);
    this.wall0 = walls.length ? Math.min(...walls) : 0;
  }
  /** The replay's kickoff is when the room starts the game, not when the room was created. */
  begin() { if (this.t0 === null) this.t0 = this.clock.now() + this.lead; }
  toLocal(wallMs: number) { return (this.t0 ?? Infinity) + (wallMs - this.wall0) / this.speed; }
  async fetch(): Promise<EspnSummary> {
    const now = this.clock.now();
    const plays = allPlays(this.full);
    const visible = plays.filter((p) => this.toLocal(Date.parse(p.wallclock ?? '')) + this.postLagMs <= now);
    const done = visible.length === plays.length;
    const comp = this.full.header.competitions[0];
    return {
      header: { ...this.full.header, competitions: [{ ...comp, status: { type: { ...comp.status.type, state: done ? 'post' : visible.length ? 'in' : 'pre', completed: done } } }] },
      drives: { previous: [{ plays: visible }] },
    };
  }
}

export type LiveStatus = {
  kind: 'live' | 'replay'; state: 'pre' | 'in' | 'post'; detail: string;
  delaySec: number; lastUpdateAgoSec: number | null; queued: number; error: string | null; latest: string | null; latestIdx: number | null;
};

/**
 * A live game: polls the feed, grows the timeline in place (already-shown plays never change index), and tells the
 * engine when each play should appear so Huddle stays in step with the family's TV, which may lag the feed by
 * `delay` seconds (streaming services often run 30–60 s behind).
 */
export class LiveGame {
  readonly data: GameData;
  readonly meta: EspnGameMeta;
  delayMs = 0;
  ended = false;
  private ids: string[] = [];
  private rowsById = new Map<string, MappedRow>();
  private waiters: (() => void)[] = [];
  private timer: TimerHandle | null = null;
  private lastUpdate: number | null = null;
  private error: string | null = null;
  private state: 'pre' | 'in' | 'post' = 'pre';
  private detail = '';
  private stopped = false;
  /** Called after each poll that added plays. */
  onUpdate: (() => void) | null = null;
  /** How many plays the engine has started (set by the room). */
  shownIdx = -1;

  constructor(first: EspnSummary, private source: FeedSource, private clock: Clock, private pollMs = 4000, readonly league: League = 'nfl') {
    this.meta = gameMeta(first);
    this.data = {
      timeline: {
        gameId: `live_${this.meta.eventId}`, title: this.meta.title, date: this.meta.date, home: this.meta.home, away: this.meta.away,
        finalScore: { home: 0, away: 0 }, plays: [], league, teams: this.meta.teams,
      },
      moments: { moments: [], segments: [], keys: {} },
      storylines: { gameFacts: [], storylines: [] },
    };
  }

  /** The room kicked off: replays start playing back now. */
  begin() {
    this.source.begin?.();
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.start();
  }

  get isReplay() { return this.source.kind === 'replay'; }

  start() {
    if (this.timer || this.stopped) return;
    const loop = async () => {
      if (this.stopped) return;
      await this.poll();
      if (!this.ended && !this.stopped) this.timer = this.clock.setTimeout(() => { this.timer = null; void loop(); }, this.pollMs);
    };
    void loop();
  }

  stop() {
    this.stopped = true;
    this.clock.clearTimeout(this.timer);
    this.ended = true;
    this.wake();
  }

  private wake() {
    const w = this.waiters.splice(0);
    w.forEach((f) => f());
  }

  /** Resolves when new plays arrive or the game ends. */
  waitForMore(): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  async poll(): Promise<void> {
    let summary: EspnSummary;
    try {
      summary = await this.source.fetch();
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
      return;
    }
    this.lastUpdate = this.clock.now();
    const m = gameMeta(summary);
    this.state = m.state;
    this.detail = m.detail;
    const rows = espnToRows(summary, this.league);
    const before = this.ids.length;
    for (const r of rows) {
      if (!this.rowsById.has(r.espn_id)) this.ids.push(r.espn_id);
      this.rowsById.set(r.espn_id, r);
    }
    const added = this.ids.length - before;
    if (added > 0) this.rebuild();
    if (this.state === 'post' && added === 0) this.ended = true;
    if (added > 0 || this.ended) { this.wake(); this.onUpdate?.(); }
  }

  private rebuild() {
    const ordered = this.ids.map((id) => this.rowsById.get(id)!);
    const { timeline } = buildTimeline(ordered, { gameId: this.data.timeline.gameId, title: this.meta.title, date: this.meta.date, league: this.league, teams: this.meta.teams }, []);
    const plays = this.data.timeline.plays;
    for (let i = 0; i < timeline.plays.length; i++) {
      if (i >= plays.length) plays.push(timeline.plays[i]);
      else if (i > this.shownIdx) plays[i] = timeline.plays[i]; // never rewrite a play the room already showed
    }
    this.data.timeline.finalScore = timeline.finalScore;
  }

  /** Local time the TV shows this play's snap (feed time + the family's delay). null if unknown. */
  showAt(idx: number): number | null {
    const id = this.ids[idx];
    const wall = id ? Number(this.rowsById.get(id)?.wallclock_ms) : NaN;
    return Number.isFinite(wall) && wall > 0 ? this.source.toLocal(wall) + this.delayMs : null;
  }

  /** The newest play in the feed (the one the host syncs against). */
  latest(): { idx: number; text: string } | null {
    const plays = this.data.timeline.plays;
    for (let i = plays.length - 1; i >= 0; i--) {
      if (this.showAt(i) !== null && plays[i].kind !== 'end_of_period') return { idx: i, text: `Q${plays[i].qtr} ${plays[i].clock} · ${plays[i].publicDesc}` };
    }
    return null;
  }

  /**
   * Host pressed Sync when their TV showed the snap of the newest feed play (the dock shows its text). The
   * delay is how long after the feed's time that was. If their TV was already past it, delay is 0.
   */
  syncNow(idx?: number): number {
    const l = idx !== undefined && idx >= 0 && idx < this.ids.length ? { idx } : this.latest();
    const id = l ? this.ids[l.idx] : undefined;
    const wall = id ? Number(this.rowsById.get(id)?.wallclock_ms) : NaN;
    if (Number.isFinite(wall)) this.delayMs = Math.max(0, Math.min(180_000, this.clock.now() - this.source.toLocal(wall)));
    return this.delayMs;
  }

  status(): LiveStatus {
    return {
      kind: this.source.kind, state: this.state, detail: this.detail, delaySec: Math.round(this.delayMs / 1000),
      lastUpdateAgoSec: this.lastUpdate === null ? null : Math.round((this.clock.now() - this.lastUpdate) / 1000),
      queued: Math.max(0, this.data.timeline.plays.length - 1 - this.shownIdx), error: this.error, latest: this.latest()?.text ?? null, latestIdx: this.latest()?.idx ?? null,
    };
  }
}
