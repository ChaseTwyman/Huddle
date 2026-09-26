import type { Settings } from '../../shared/types';
import { ROOM_IDLE_MS } from '../../shared/constants';
import type { Clock } from './clock';
import type { Transport } from './transport';
import { Room, type RoomEvents } from './Room';
import { LLM, type LlmConfig } from '../ai/llm';
import type { FamilyStore } from '../persistence/families';
import type { TtsService } from '../ai/tts';

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, O, L

export function makeCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += LETTERS[Math.floor(rand() * LETTERS.length)];
  return s;
}

export type ManagerDeps = {
  clock: Clock;
  transport: Transport;
  families?: FamilyStore | null;
  llmConfig?: Partial<LlmConfig>;
  /** Make the LLM client (defaults to one per room, sharing the disk cache). */
  makeLlm?: () => LLM;
  events?: RoomEvents;
  speed?: number;
  /** Print one line per play to the console (the real server). */
  logPlays?: boolean;
  tts?: TtsService | null;
};

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: ManagerDeps) {}

  create(settings: Settings): Room {
    let code = makeCode();
    while (this.rooms.has(code)) code = makeCode();
    const llm = this.deps.makeLlm ? this.deps.makeLlm() : new LLM(this.deps.clock, this.deps.llmConfig);
    const room = new Room(code, settings, {
      clock: this.deps.clock, transport: this.deps.transport, llm,
      families: this.deps.families ?? null, events: this.deps.events, speed: this.deps.speed, tts: this.deps.tts ?? null,
    });
    room.logPlays = !!this.deps.logPlays;
    this.rooms.set(code, room);
    return room;
  }

  get(code: string | undefined | null): Room | undefined {
    return code ? this.rooms.get(code.toUpperCase()) : undefined;
  }

  /** Expire rooms idle for 6 hours (real time). */
  startSweeper() {
    this.sweeper = setInterval(() => {
      const now = this.deps.clock.now();
      for (const [code, room] of this.rooms) {
        if (now - room.lastActivity > ROOM_IDLE_MS) {
          room.dispose();
          this.rooms.delete(code);
        }
      }
    }, 10 * 60 * 1000);
    this.sweeper.unref?.();
    // Stall watchdog: a live, unpaused game should never go a minute without an engine event.
    this.watchdog = setInterval(() => {
      for (const room of this.rooms.values()) {
        const report = room.stallReport(60_000);
        if (report) console.warn(`[room ${room.code}] WARNING engine ${report}`);
      }
    }, 30_000);
    this.watchdog.unref?.();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.watchdog) clearInterval(this.watchdog);
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
  }
}
