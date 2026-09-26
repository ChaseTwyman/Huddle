import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient } from '../../../shared/types';

export type HuddleSocket = Socket<ServerToClient, ClientToServer>;

/** One socket per page load. Same origin: Vite proxies /socket.io in dev; the server serves it in prod. */
export function connect(): HuddleSocket {
  return io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 500 });
}

export const storage = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string) {
    try { window.localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
  },
  remove(key: string) {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  },
  session: {
    get(key: string): string | null {
      try { return window.sessionStorage.getItem(key); } catch { return null; }
    },
    set(key: string, value: string) {
      try { window.sessionStorage.setItem(key, value); } catch { /* ignore */ }
    },
  },
};
