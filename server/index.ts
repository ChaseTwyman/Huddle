import 'dotenv/config';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientToServer, ServerToClient } from '../shared/types';
import { createHttpApp } from './http';
import { attachSockets } from './sockets';
import { RoomManager } from './room/RoomManager';
import { RealClock, type Clock } from './room/clock';
import { SocketTransport } from './room/transport';
import { FamilyStore } from './persistence/families';
import { configFromEnv } from './ai/llm';
import { registerP1Routes } from './p1';

export type StartOptions = { port?: number; prod?: boolean; speed?: number; clock?: Clock; families?: FamilyStore | null; quiet?: boolean };

export async function startServer(opts: StartOptions = {}): Promise<{ http: HttpServer; manager: RoomManager; port: number; close: () => Promise<void> }> {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const prod = opts.prod ?? process.env.NODE_ENV === 'production';
  // speed (smoke test) divides pacing and windows inside rooms; the clock itself stays real.
  const clock = opts.clock ?? new RealClock();
  const http = createServer();
  const io = new Server<ClientToServer, ServerToClient>(http, { cors: { origin: true } });
  const manager = new RoomManager({
    clock, transport: new SocketTransport(io),
    families: opts.families === undefined ? new FamilyStore() : opts.families,
    speed: opts.speed,
  });
  const app = createHttpApp(manager, { prod, port, extra: (a) => registerP1Routes(a, clock) });
  http.on('request', app);
  attachSockets(io, manager);
  manager.startSweeper();
  await new Promise<void>((resolve) => http.listen(port, resolve));
  const addr = http.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  if (!opts.quiet) {
    const cfg = configFromEnv();
    console.log(`[huddle] server on :${actual} · LLM provider: ${cfg.provider}${cfg.provider === 'mock' ? ' (no key needed)' : ` · ${cfg.baseURL}`}`);
  }
  return {
    http, manager, port: actual,
    close: async () => {
      manager.stop();
      io.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

const isMain = process.argv[1] && /server[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
