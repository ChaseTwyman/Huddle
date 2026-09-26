/**
 * F14 camera flag detection: broadcast scorebugs show a bright yellow "FLAG" box when a penalty flag is thrown.
 * Given RGBA pixels from the scorebug region of a camera frame, measure how much of it is flag-yellow, and trigger
 * when that jumps well above the recent baseline for two samples in a row. Pure functions: the camera page runs
 * them on canvas pixels; tests run them on synthetic frames.
 */

/** Hue 38–65°, saturation ≥ 0.55, value ≥ 0.55: broadcast flag yellow under typical camera white balance. */
export function isFlagYellow(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 140) return false;
  const s = max === 0 ? 0 : (max - min) / max;
  if (s < 0.55) return false;
  if (max !== r && max !== g) return false; // blue-dominant is never yellow
  const d = max - min || 1;
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else h = 60 * ((b - r) / d + 2);
  if (h < 0) h += 360;
  return h >= 38 && h <= 65;
}

/** Fraction of pixels (RGBA array) that are flag-yellow. Samples every `step`-th pixel for speed. */
export function yellowRatio(data: ArrayLike<number>, step = 1): number {
  let yellow = 0;
  let total = 0;
  for (let i = 0; i + 3 < data.length; i += 4 * step) {
    total++;
    if (isFlagYellow(data[i], data[i + 1], data[i + 2])) yellow++;
  }
  return total ? yellow / total : 0;
}

export type DetectorState = { ratio: number; baseline: number; threshold: number; armed: boolean; fired: boolean };

/**
 * Trigger logic: after a short warm-up, keeps a baseline (median of the last ~20 s of samples) and fires when the
 * yellow ratio exceeds max(minRatio, baseline × 3 + 0.02) on `confirm` consecutive samples, then stays quiet for
 * `cooldownMs`.
 */
export class FlagDetector {
  private history: number[] = [];
  private hits = 0;
  private lastFire = -Infinity;
  private seen = 0;
  constructor(private opts = { historySize: 40, minRatio: 0.04, confirm: 2, cooldownMs: 45_000, warmup: 6 }) {}

  /** Median of recent samples: a brief FLAG box doesn't move it; a permanently yellow scorebug does. */
  baseline(): number {
    if (!this.history.length) return 0;
    const sorted = [...this.history].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  sample(ratio: number, now: number): DetectorState {
    const baseline = this.baseline();
    const threshold = Math.max(this.opts.minRatio, baseline * 3 + 0.02);
    // Warm-up: learn what this scorebug normally looks like before firing (e.g. a yellow team color).
    const warm = this.seen++ >= this.opts.warmup;
    const armed = warm && now - this.lastFire >= this.opts.cooldownMs;
    let fired = false;
    if (warm && ratio > threshold) {
      this.hits++;
      if (armed && this.hits >= this.opts.confirm) {
        fired = true;
        this.lastFire = now;
        this.hits = 0;
      }
    } else {
      this.hits = 0;
    }
    this.history.push(ratio);
    if (this.history.length > this.opts.historySize) this.history.shift();
    return { ratio, baseline, threshold, armed, fired };
  }
}
