const PREFERRED = ['Google US English', 'Samantha', 'Microsoft Aria Online (Natural)'];
const WPS = 2.6;

type Line = { lineId: string; text: string; priority: number };

/**
 * TV voice (BUILD_PROMPT 11.3): speechSynthesis, one line at a time, lower-priority queued lines are
 * dropped when a higher one arrives, and `onDone(lineId)` fires when each line ends (or is skipped).
 * Without speech support, the duration is estimated at 2.6 words per second.
 */
export class Speaker {
  private queue: Line[] = [];
  private current: Line | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  muted = false;
  onDone: (lineId: string) => void = () => undefined;
  onSpeaking: (line: Line | null) => void = () => undefined;

  get supported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  /** Call from a user gesture (the Start overlay) so browsers allow speech. */
  unlock() {
    if (!this.supported) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      this.voice = PREFERRED.map((n) => voices.find((v) => v.name === n)).find(Boolean)
        ?? voices.find((v) => v.lang === 'en-US') ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }

  get voiceName() { return this.voice?.name ?? (this.supported ? 'default voice' : 'no speech (captions only)'); }

  say(line: Line) {
    if (this.current && line.priority > this.current.priority) {
      // Higher priority interrupts the current line.
      this.queue = [line];
      this.stopCurrent();
      return;
    }
    this.queue = this.queue.filter((q) => q.priority >= line.priority);
    this.queue.push(line);
    if (!this.current) this.next();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (m) {
      const pending = [...this.queue];
      this.queue = [];
      pending.forEach((l) => this.onDone(l.lineId));
      this.stopCurrent();
    }
  }

  private stopCurrent() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.supported) window.speechSynthesis.cancel();
    const cur = this.current;
    this.current = null;
    if (cur) this.onDone(cur.lineId);
    this.onSpeaking(null);
    this.next();
  }

  private finish(lineId: string) {
    if (this.current?.lineId !== lineId) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    this.onDone(lineId);
    this.onSpeaking(null);
    this.next();
  }

  private next() {
    const line = this.queue.shift();
    if (!line) return;
    this.current = line;
    this.onSpeaking(line);
    const estimate = (line.text.split(/\s+/).length / WPS) * 1000 + 400;
    if (this.muted || !this.supported) {
      this.timer = setTimeout(() => this.finish(line.lineId), this.muted ? 0 : estimate);
      return;
    }
    const u = new SpeechSynthesisUtterance(line.text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? 'en-US';
    u.rate = 1.05;
    u.onend = () => this.finish(line.lineId);
    u.onerror = () => this.finish(line.lineId);
    // Safety net: some browsers never fire onend.
    this.timer = setTimeout(() => this.finish(line.lineId), estimate * 1.6 + 2000);
    window.speechSynthesis.speak(u);
  }
}
