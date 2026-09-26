import { useEffect, useRef, useState } from 'react';
import type { AiLogEntry, HostAction, RoomSnapshot, SpeakLine } from '../../../shared/types';
import { connect, type HuddleSocket } from './socket';

export type TvConnection = {
  snapshot: RoomSnapshot | null;
  aiLog: AiLogEntry[];
  isHost: boolean;
  error: string | null;
  connected: boolean;
  control: (action: HostAction, value?: unknown) => void;
  spoken: (lineId: string) => void;
};

/** TV-side connection: joins the room, keeps the latest snapshot, forwards speech and mute events. */
export function useTvConnection(code: string, hostToken: string | null, enabled: boolean, handlers: { onSpeak: (l: SpeakLine) => void; onMute: (m: boolean) => void }): TvConnection {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [aiLog, setAiLog] = useState<AiLogEntry[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<HuddleSocket | null>(null);
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const s = connect();
    socketRef.current = s;
    const join = () => {
      s.emit('tv:join', { code, hostToken: hostToken ?? undefined }, (r) => {
        if (!r.ok) setError(r.error ?? 'Could not join');
        else { setError(null); setIsHost(!!r.host); }
      });
    };
    s.on('connect', () => { setConnected(true); join(); });
    s.on('disconnect', () => setConnected(false));
    s.on('room:snapshot', (snap) => setSnapshot(snap));
    s.on('host:ailog', (log) => setAiLog(log));
    s.on('tv:speak', (line) => h.current.onSpeak(line));
    s.on('tv:mute', ({ muted }) => h.current.onMute(muted));
    return () => { s.disconnect(); socketRef.current = null; };
  }, [code, hostToken, enabled]);

  return {
    snapshot, aiLog, isHost, error, connected,
    control: (action, value) => socketRef.current?.emit('host:control', { action, value }),
    spoken: (lineId) => socketRef.current?.emit('tv:spoken', { lineId }),
  };
}

/** Server time is close enough to client time on a LAN; used for countdowns. */
export function useNow(intervalMs = 200): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
