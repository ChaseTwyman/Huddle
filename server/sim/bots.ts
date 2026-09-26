import type { PlayerView, ProfileAnswers } from '../../shared/types';
import type { Clock } from '../room/clock';
import type { Room } from '../room/Room';
import { RecordingTransport } from '../room/transport';
import { rng } from '../game/rng';
import { levelOf, levelRank } from '../game/knowledge';
import { concepts } from '../data/concepts';

export type BotSpec = {
  name: string; role: 'fan' | 'learner'; accuracy: number;
  acceptTakeIt?: number; acceptHandoff?: number; confusedRate?: number;
  profile?: ProfileAnswers;
};

export const DEFAULT_BOTS: BotSpec[] = [
  { name: 'Sam', role: 'fan', accuracy: 0.9, acceptTakeIt: 0.5 },
  { name: 'Mom', role: 'learner', accuracy: 0.4, acceptHandoff: 0.7, confusedRate: 0.2, profile: { watch: 'dramas', rootFor: 'underdog', vibe: 'drama' } },
  { name: 'Sister', role: 'learner', accuracy: 0.6, acceptHandoff: 0.7, confusedRate: 0.2, profile: { watch: 'reality', rootFor: 'underdog', vibe: 'chaos' } },
  { name: 'Dad', role: 'learner', accuracy: 0.8, acceptHandoff: 0.7, confusedRate: 0.2, profile: { watch: 'sports', rootFor: 'favorite', vibe: 'numbers' } },
];

export type BotStats = { takeItOffered: number; takeItAccepted: number; handoffOffered: number; handoffAccepted: number; answers: number };

/** A transport that records everything and lets bots react to their phone views. */
export class BotTransport extends RecordingTransport {
  onView: ((playerId: string, v: PlayerView) => void) | null = null;
  constructor(now: () => number, private keep = true) { super(now); }
  playerView(code: string, playerId: string, v: PlayerView) {
    if (this.keep) super.playerView(code, playerId, v);
    this.onView?.(playerId, v);
  }
}

/** Server-side bot players that answer prompts with a given accuracy after human-ish delays. */
export class Bots {
  readonly stats: BotStats = { takeItOffered: 0, takeItAccepted: 0, handoffOffered: 0, handoffAccepted: 0, answers: 0 };
  private handled = new Set<string>();
  private specs = new Map<string, BotSpec>();
  private r: () => number;

  constructor(private room: Room, private clock: Clock, transport: BotTransport, seed = 42) {
    this.r = rng(seed);
    transport.onView = (id, v) => this.onView(id, v);
  }

  join(specs: BotSpec[] = DEFAULT_BOTS): string[] {
    const ids: string[] = [];
    for (const s of specs) {
      const p = this.room.joinPlayer({ name: s.name });
      this.specs.set(p.id, s);
      ids.push(p.id);
    }
    return ids;
  }

  submitProfiles() {
    for (const [id, s] of this.specs) {
      this.room.setProfile(id, s.role === 'fan' ? { watch: 'sports', rootFor: 'favorite', vibe: 'numbers', fan: true } : s.profile ?? { watch: 'comedies', rootFor: 'underdog', vibe: 'chaos' });
    }
  }

  private later(ms: number, fn: () => void) {
    this.clock.setTimeout(fn, ms);
  }

  /** A learner who is Familiar or better with a concept plays like it: calls it right, isn't confused. */
  private knows(playerId: string, conceptId: string | null): boolean {
    const pl = this.room.players.get(playerId);
    if (!conceptId || !pl || pl.role !== 'learner') return false;
    return levelRank(levelOf(pl.knowledge, conceptId)) >= levelRank('familiar');
  }

  private between(a: number, b: number) { return a + this.r() * (b - a); }

  private onView(playerId: string, v: PlayerView) {
    const spec = this.specs.get(playerId);
    const p = v.prompt;
    if (!spec || !p || this.handled.has(`${playerId}:${p.id}`)) return;
    this.handled.add(`${playerId}:${p.id}`);
    const room = this.room;
    switch (p.kind) {
      case 'predict':
      case 'callit': {
        const correct = room.simCorrectOption(p.id);
        const accuracy = this.knows(playerId, room.simRoundConcept(p.id)) ? Math.max(spec.accuracy, 0.9) : spec.accuracy;
        const right = correct && this.r() < accuracy;
        const wrong = p.options.filter((o) => o.id !== correct);
        const pick = right ? correct! : (wrong[Math.floor(this.r() * wrong.length)] ?? p.options[0]).id;
        this.stats.answers++;
        this.later(this.between(1500, 7000), () => room.answer(playerId, p.id, pick));
        break;
      }
      case 'takeit': {
        this.stats.takeItOffered++;
        const accept = this.r() < (spec.acceptTakeIt ?? 0.5);
        if (accept) this.stats.takeItAccepted++;
        this.later(this.between(800, 2500), () => room.takeIt(playerId, p.id, accept));
        break;
      }
      case 'handoff': {
        this.stats.handoffOffered++;
        const accept = this.r() < (spec.acceptHandoff ?? 0.7);
        if (accept) this.stats.handoffAccepted++;
        this.later(this.between(1000, 3000), () => room.handoff(playerId, p.id, accept));
        break;
      }
      case 'done':
        this.later(this.between(5000, 9000), () => room.done(playerId, p.id));
        break;
      case 'feedback': {
        const cid = [...concepts().values()].find((c) => c.name === p.title)?.id ?? null;
        const confused = !this.knows(playerId, cid) && this.r() < (spec.confusedRate ?? 0.2);
        this.later(this.between(1000, 3000), () => room.feedback(playerId, p.id, confused ? 'confused' : 'got_it'));
        break;
      }
    }
  }
}
