import type { Server } from 'socket.io';
import type { AiLogEntry, ClientToServer, PlayerView, RoomSnapshot, ServerToClient, SpeakLine } from '../../shared/types';

/** Everything a room sends goes through a Transport, so tests and simulate can record it. */
export interface Transport {
  snapshot(code: string, s: RoomSnapshot): void;
  playerView(code: string, playerId: string, v: PlayerView): void;
  speak(code: string, line: SpeakLine): void;
  mute(code: string, muted: boolean): void;
  aiLog(code: string, log: AiLogEntry[]): void;
}

export const tvRoom = (code: string) => `tv:${code}`;
export const hostRoom = (code: string) => `host:${code}`;
export const playerRoom = (id: string) => `p:${id}`;

export class SocketTransport implements Transport {
  constructor(private io: Server<ClientToServer, ServerToClient>) {}
  snapshot(code: string, s: RoomSnapshot) { this.io.to(tvRoom(code)).emit('room:snapshot', s); }
  playerView(_code: string, playerId: string, v: PlayerView) { this.io.to(playerRoom(playerId)).emit('player:view', v); }
  speak(code: string, line: SpeakLine) { this.io.to(tvRoom(code)).emit('tv:speak', line); }
  mute(code: string, muted: boolean) { this.io.to(tvRoom(code)).emit('tv:mute', { muted }); }
  aiLog(code: string, log: AiLogEntry[]) { this.io.to(hostRoom(code)).emit('host:ailog', log); }
}

export type Recorded =
  | { kind: 'snapshot'; at: number; payload: RoomSnapshot }
  | { kind: 'playerView'; at: number; playerId: string; payload: PlayerView }
  | { kind: 'speak'; at: number; payload: SpeakLine }
  | { kind: 'mute'; at: number; payload: boolean }
  | { kind: 'aiLog'; at: number; payload: AiLogEntry[] };

/** Records every outgoing message (tests, simulate). Payloads are deep-copied at send time. */
export class RecordingTransport implements Transport {
  readonly messages: Recorded[] = [];
  constructor(private now: () => number, private keepAiLog = false) {}
  private copy<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }
  snapshot(_c: string, s: RoomSnapshot) { this.messages.push({ kind: 'snapshot', at: this.now(), payload: this.copy(s) }); }
  playerView(_c: string, playerId: string, v: PlayerView) { this.messages.push({ kind: 'playerView', at: this.now(), playerId, payload: this.copy(v) }); }
  speak(_c: string, line: SpeakLine) { this.messages.push({ kind: 'speak', at: this.now(), payload: { ...line } }); }
  mute(_c: string, muted: boolean) { this.messages.push({ kind: 'mute', at: this.now(), payload: muted }); }
  aiLog(_c: string, log: AiLogEntry[]) { if (this.keepAiLog) this.messages.push({ kind: 'aiLog', at: this.now(), payload: this.copy(log) }); }
  clear() { this.messages.length = 0; }
}

/** Sends to several transports (e.g. sockets + a recorder). */
export class TeeTransport implements Transport {
  constructor(private targets: Transport[]) {}
  snapshot(c: string, s: RoomSnapshot) { this.targets.forEach((t) => t.snapshot(c, s)); }
  playerView(c: string, id: string, v: PlayerView) { this.targets.forEach((t) => t.playerView(c, id, v)); }
  speak(c: string, l: SpeakLine) { this.targets.forEach((t) => t.speak(c, l)); }
  mute(c: string, m: boolean) { this.targets.forEach((t) => t.mute(c, m)); }
  aiLog(c: string, log: AiLogEntry[]) { this.targets.forEach((t) => t.aiLog(c, log)); }
}
