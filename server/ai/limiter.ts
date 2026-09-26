type Job = { priority: number; seq: number; start: () => void };

/** Concurrency limiter with priorities (higher runs first). */
export class Limiter {
  private running = 0;
  private queue: Job[] = [];
  private seq = 0;
  constructor(private max: number) {}

  async run<T>(priority: number, fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      await new Promise<void>((start) => {
        this.queue.push({ priority, seq: this.seq++, start });
        this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      });
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next.start();
    }
  }

  get pending() { return this.queue.length; }
}
