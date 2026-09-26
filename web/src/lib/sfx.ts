/**
 * Small UI sounds, synthesized with Web Audio (no asset files): a soft two-note chime before Huddle
 * explains, a referee whistle before an announcement, a pop when someone joins, a tick when someone
 * locks in, and a rising reveal. All quiet by design; `setEnabled(false)` silences them with the voice.
 */
type Tone = { f: number; at: number; dur: number; type?: OscillatorType; gain?: number; slideTo?: number };

class Sfx {
  private ctx: AudioContext | null = null;
  enabled = true;

  /** Call from a user gesture (the Start overlay) so the browser allows audio. */
  unlock() {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx ??= new AC();
      void this.ctx.resume();
    } catch { this.ctx = null; }
  }

  setEnabled(on: boolean) { this.enabled = on; }

  private play(tones: Tone[], volume = 0.18) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.02;
    for (const t of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = t.type ?? 'sine';
      o.frequency.setValueAtTime(t.f, t0 + t.at);
      if (t.slideTo) o.frequency.exponentialRampToValueAtTime(t.slideTo, t0 + t.at + t.dur);
      const peak = t.gain ?? 1;
      g.gain.setValueAtTime(0.0001, t0 + t.at);
      g.gain.exponentialRampToValueAtTime(peak, t0 + t.at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + t.at + t.dur);
      o.connect(g).connect(master);
      o.start(t0 + t.at);
      o.stop(t0 + t.at + t.dur + 0.05);
    }
  }

  /** Before Huddle explains: two soft bell notes (E6, B5). */
  chime() {
    this.play([
      { f: 1318.5, at: 0, dur: 0.55, gain: 0.8 }, { f: 2637, at: 0, dur: 0.25, gain: 0.12 },
      { f: 987.8, at: 0.16, dur: 0.7, gain: 0.9 }, { f: 1975.5, at: 0.16, dur: 0.3, gain: 0.12 },
    ], 0.14);
  }

  /** Before the referee's announcement: a short two-blast whistle. */
  whistle() {
    this.play([
      { f: 2750, at: 0, dur: 0.14, type: 'triangle', gain: 0.7 }, { f: 2830, at: 0, dur: 0.14, type: 'triangle', gain: 0.4 },
      { f: 2750, at: 0.2, dur: 0.32, type: 'triangle', gain: 0.8 }, { f: 2830, at: 0.2, dur: 0.32, type: 'triangle', gain: 0.45 },
    ], 0.08);
  }

  /** Someone joined: a quick upward pop. */
  join() {
    this.play([{ f: 520, at: 0, dur: 0.12, slideTo: 880, gain: 0.9 }, { f: 1320, at: 0.08, dur: 0.22, gain: 0.35 }], 0.16);
  }

  /** Someone locked in an answer. */
  tick() {
    this.play([{ f: 1760, at: 0, dur: 0.06, type: 'triangle', gain: 0.6 }], 0.08);
  }

  /** The answer is revealed: three rising notes. */
  reveal() {
    this.play([{ f: 784, at: 0, dur: 0.18 }, { f: 988, at: 0.1, dur: 0.18 }, { f: 1318.5, at: 0.2, dur: 0.4 }], 0.13);
  }

  /** A prompt opened. */
  open() {
    this.play([{ f: 660, at: 0, dur: 0.1, gain: 0.7 }, { f: 990, at: 0.09, dur: 0.18, gain: 0.7 }], 0.12);
  }
}

export const sfx = new Sfx();

/** How long the cue plays before the voice starts. */
export const CUE_LEAD_MS = { chime: 650, whistle: 600 } as const;
