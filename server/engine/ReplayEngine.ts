import type { EngineEvent, Mode, MomentsFile, Pacing, Timeline, TimelinePlay } from '../../shared/types';
import { PACING, type PacingValues } from '../../shared/constants';
import type { Clock, TimerHandle } from '../room/clock';
import type { EngineHandler, GameSource } from './GameSource';
import { summarizeSkipped } from './condense';

class Aborted extends Error {
  constructor() { super('aborted'); }
}

/**
 * Replays a timeline as engine events (BUILD_PROMPT 7.2). Runs as one async loop per "generation";
 * jumping or stopping bumps the generation, which aborts the old loop at its next await.
 *
 * Per play: pre_snap → (decision: handler holds for Predict) → snap → play_result → [flag → handler holds
 * for Call It → announceMs → penalty_announced] → dead_time (handler holds for the Director) → postPlayMs.
 * Pre-snap flags (kind penalty_only) skip snap and play_result.
 */
export class ReplayEngine implements GameSource {
  private gen = 0;
  private abortReject: ((e: Error) => void) | null = null;
  private abortPromise: Promise<never> | null = null;
  private waitTimer: TimerHandle | null = null;
  private waitResolve: (() => void) | null = null;
  private resumeWaiters: (() => void)[] = [];
  private _paused = false;
  private _idx = 0;
  private _done = false;
  private mode: Mode;
  private pacingName: Pacing;
  private demoSegmentIdx = 0;
  /** Multiplier applied to every pacing wait (smoke test speeds demo pacing up). */
  speed = 1;

  constructor(
    private timeline: Timeline,
    private moments: MomentsFile,
    private clock: Clock,
    private handler: EngineHandler,
    opts: { mode: Mode; pacing: Pacing },
  ) {
    this.mode = opts.mode;
    this.pacingName = opts.pacing;
  }

  get paused() { return this._paused; }
  get currentIdx() { return this._idx; }
  get done() { return this._done; }
  get plays(): TimelinePlay[] { return this.timeline.plays; }
  get pacing(): PacingValues { return PACING[this.pacingName]; }
  get modeName() { return this.mode; }
  get pacingKey() { return this.pacingName; }

  start(fromIdx?: number) {
    const start = fromIdx ?? (this.mode === 'demo' ? this.moments.segments[0]?.startIdx ?? 0 : 0);
    if (this.mode === 'demo') this.demoSegmentIdx = Math.max(0, this.segmentIndexFor(start));
    this.launch(start, fromIdx !== undefined);
  }

  stop() {
    this.bumpGeneration();
    this._done = true;
  }

  pause() { this._paused = true; }

  resume() {
    this._paused = false;
    const w = this.resumeWaiters;
    this.resumeWaiters = [];
    w.forEach((f) => f());
  }

  next() {
    if (this.waitResolve) {
      this.clock.clearTimeout(this.waitTimer);
      const r = this.waitResolve;
      this.waitResolve = null;
      r();
    }
  }

  jumpTo(idx: number) {
    const i = Math.max(0, Math.min(this.plays.length - 1, idx));
    if (this.mode === 'demo') {
      const s = this.segmentIndexFor(i);
      if (s < 0) this.mode = 'full';
      else this.demoSegmentIdx = s;
    }
    this.launch(i, true);
  }

  jumpToSegment(id: string) {
    const s = this.moments.segments.findIndex((x) => x.id === id);
    if (s < 0) return;
    if (this.mode !== 'demo') this.mode = 'demo';
    this.demoSegmentIdx = s;
    this.launch(this.moments.segments[s].startIdx, true);
  }

  setMode(mode: Mode) { this.mode = mode; }
  setPacing(p: Pacing) { this.pacingName = p; }

  private segmentIndexFor(idx: number) {
    return this.moments.segments.findIndex((s) => idx >= s.startIdx && idx <= s.endIdx);
  }

  private bumpGeneration() {
    this.gen++;
    this.next();
    if (this.abortReject) this.abortReject(new Aborted());
    this.abortPromise = new Promise<never>((_, rej) => { this.abortReject = rej; });
    this.abortPromise.catch(() => undefined);
  }

  private launch(idx: number, jumped: boolean) {
    this.bumpGeneration();
    this._done = false;
    const gen = this.gen;
    this.loop(gen, idx, jumped).catch((e) => {
      if (!(e instanceof Aborted)) console.error('[engine] loop error', e);
    });
  }

  private check(gen: number) {
    if (gen !== this.gen) throw new Aborted();
  }

  private async guard<T>(gen: number, p: Promise<T>): Promise<T> {
    this.check(gen);
    const r = await Promise.race([p, this.abortPromise!]);
    this.check(gen);
    return r as T;
  }

  private async gate(gen: number) {
    this.check(gen);
    while (this._paused) {
      await this.guard(gen, new Promise<void>((r) => this.resumeWaiters.push(r)));
    }
  }

  private async wait(gen: number, ms: number) {
    await this.gate(gen);
    const scaled = ms / this.speed;
    await this.guard(gen, new Promise<void>((r) => {
      this.waitResolve = r;
      this.waitTimer = this.clock.setTimeout(() => { this.waitResolve = null; r(); }, scaled);
    }));
    await this.gate(gen);
  }

  private async emit(gen: number, ev: EngineEvent) {
    await this.gate(gen);
    await this.guard(gen, this.handler(ev));
  }

  private shouldShow(p: TimelinePlay, isFirst: boolean): boolean {
    if (this.mode === 'full' || this.mode === 'demo') return true;
    return isFirst || p.notable || p.momentKeys.length > 0;
  }

  private async loop(gen: number, startIdx: number, jumped: boolean) {
    const plays = this.plays;
    let i = startIdx;
    let lastShown = startIdx - 1;
    let first = true;
    let halftimeDone = jumped ? plays[startIdx]?.qtr >= 3 : false;
    while (i < plays.length) {
      this.check(gen);
      if (this.mode === 'demo') {
        const segs = this.moments.segments;
        const seg = segs[this.demoSegmentIdx];
        if (!seg) break;
        if (i < seg.startIdx) { i = seg.startIdx; lastShown = i - 1; }
        if (i > seg.endIdx) {
          this.demoSegmentIdx++;
          const nextSeg = segs[this.demoSegmentIdx];
          if (!nextSeg) break;
          i = nextSeg.startIdx;
          lastShown = i - 1;
          halftimeDone = plays[i].qtr >= 3;
          continue;
        }
      }
      const p = plays[i];
      if (!this.shouldShow(p, first)) { i++; continue; }

      if (this.mode === 'condensed' && lastShown + 1 < i) {
        const text = summarizeSkipped(plays.slice(lastShown + 1, i), p, this.timeline.home);
        if (text) {
          await this.emit(gen, { type: 'summary', text, skipped: i - lastShown - 1 });
          await this.wait(gen, this.pacing.summaryMs);
        }
      }
      if (!halftimeDone && p.qtr >= 3) {
        halftimeDone = true;
        await this.emit(gen, { type: 'halftime' });
        await this.wait(gen, this.pacing.halftimeMs);
      }
      this._idx = i;
      await this.runPlay(gen, p);
      lastShown = i;
      first = false;
      i++;
    }
    this.check(gen);
    this._idx = plays.length - 1;
    await this.emit(gen, { type: 'final' });
    this._done = true;
  }

  private async runPlay(gen: number, play: TimelinePlay) {
    const pace = this.pacing;
    if (play.kind === 'timeout' || play.kind === 'end_of_period') {
      await this.emit(gen, { type: 'dead_time', play });
      await this.wait(gen, pace.postPlayMs / 2);
      return;
    }
    await this.emit(gen, { type: 'pre_snap', play });
    await this.wait(gen, play.decision ? 1000 : pace.preSnapMs);

    if (play.kind === 'penalty_only') {
      await this.emit(gen, { type: 'flag', play });
      await this.wait(gen, pace.announceMs);
      await this.emit(gen, { type: 'penalty_announced', play });
    } else {
      await this.emit(gen, { type: 'snap', play });
      await this.emit(gen, { type: 'play_result', play });
      await this.wait(gen, pace.playMs);
      if (play.penalty) {
        await this.emit(gen, { type: 'flag', play });
        await this.wait(gen, pace.announceMs);
        await this.emit(gen, { type: 'penalty_announced', play });
      }
    }
    await this.emit(gen, { type: 'dead_time', play });
    await this.wait(gen, pace.postPlayMs);
  }
}
