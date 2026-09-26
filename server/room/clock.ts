export type TimerHandle = { id: number };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle | null | undefined): void;
}

/** Wall-clock implementation. */
export class RealClock implements Clock {
  private next = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  now() { return Date.now(); }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.next++;
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); fn(); }, Math.max(0, ms)));
    return { id };
  }
  clearTimeout(h: TimerHandle | null | undefined) {
    if (!h) return;
    const t = this.timers.get(h.id);
    if (t) clearTimeout(t);
    this.timers.delete(h.id);
  }
}

/** Real timers divided by `speed` (smoke test: 20x). now() still advances at the scaled rate. */
export class ScaledClock implements Clock {
  private inner = new RealClock();
  private start = Date.now();
  constructor(private speed: number) {}
  now() { return this.start + (Date.now() - this.start) * this.speed; }
  setTimeout(fn: () => void, ms: number) { return this.inner.setTimeout(fn, ms / this.speed); }
  clearTimeout(h: TimerHandle | null | undefined) { this.inner.clearTimeout(h); }
}

type VTimer = { id: number; at: number; seq: number; fn: () => void };

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

/**
 * Virtual time for tests, simulate and smoke: timers fire in order without real waiting.
 * Call `run()` to advance until no timers remain (or a limit is hit).
 */
export class VirtualClock implements Clock {
  private t: number;
  private seq = 0;
  private nextId = 1;
  private timers: VTimer[] = [];
  constructor(start = 1_700_000_000_000) { this.t = start; }
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), seq: this.seq++, fn });
    return { id };
  }
  clearTimeout(h: TimerHandle | null | undefined) {
    if (!h) return;
    this.timers = this.timers.filter((x) => x.id !== h.id);
  }
  get pending() { return this.timers.length; }
  elapsedSince(start: number) { return this.t - start; }

  /** Fire the next timer (after flushing pending microtasks). Returns false when idle. */
  async step(): Promise<boolean> {
    for (let i = 0; i < 5; i++) await flushMicrotasks();
    if (!this.timers.length) return false;
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = this.timers.shift()!;
    this.t = Math.max(this.t, next.at);
    next.fn();
    return true;
  }

  /** Run until idle, until `until()` is true, or until maxMs of virtual time pass. */
  async run(opts: { until?: () => boolean; maxMs?: number; maxSteps?: number } = {}): Promise<void> {
    const start = this.t;
    let steps = 0;
    while (true) {
      if (opts.until?.()) return;
      if (opts.maxMs !== undefined && this.t - start > opts.maxMs) return;
      if (opts.maxSteps !== undefined && steps++ > opts.maxSteps) throw new Error('VirtualClock: step limit hit');
      const more = await this.step();
      if (!more) {
        for (let i = 0; i < 5; i++) await flushMicrotasks();
        if (!this.timers.length) return;
      }
    }
  }

  /** Advance virtual time by ms, firing due timers. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    while (true) {
      for (let i = 0; i < 5; i++) await flushMicrotasks();
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = target;
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  }
}

/** Promise that resolves after ms on the given clock. */
export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((r) => clock.setTimeout(r, ms));
}
