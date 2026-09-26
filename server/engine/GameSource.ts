import type { EngineEvent, Mode, Pacing } from '../../shared/types';

/**
 * A source of engine events. The room awaits the handler's promise before the source moves on,
 * which is how Predict, Call It and Director windows hold the game. ReplayEngine implements this
 * from a timeline; a future live source (screen capture + speech-to-text) would implement it too.
 */
export type EngineHandler = (ev: EngineEvent) => Promise<void>;

export interface GameSource {
  start(fromIdx?: number): void;
  pause(): void;
  resume(): void;
  /** Skip the current pacing wait. */
  next(): void;
  jumpTo(idx: number): void;
  jumpToSegment(id: string): void;
  setMode(mode: Mode): void;
  setPacing(pacing: Pacing): void;
  stop(): void;
  readonly paused: boolean;
  readonly currentIdx: number;
  readonly done: boolean;
}
