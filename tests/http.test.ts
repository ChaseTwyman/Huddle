import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createHttpApp } from '../server/http';
import { RoomManager } from '../server/room/RoomManager';
import { RealClock } from '../server/room/clock';
import { RecordingTransport } from '../server/room/transport';
import type { EspnSummary } from '../server/live/espn';

const full = JSON.parse(fs.readFileSync('data/fixtures/espn_2026_w3_atl_gb.json', 'utf8')) as EspnSummary;
const realFetch = globalThis.fetch;

async function post(summary: EspnSummary, gameId: string) {
  // ESPN is stubbed; requests to our own test server go through.
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => (String(url).includes('espn.com')
    ? Promise.resolve(new Response(JSON.stringify(summary), { status: 200 }))
    : realFetch(url, init)));
  const clock = new RealClock();
  const manager = new RoomManager({ clock, transport: new RecordingTransport(() => clock.now()), llmConfig: { provider: 'mock' } });
  const server = createHttpApp(manager, { prod: false, port: 0, clock }).listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await realFetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameId }),
    });
    return { status: res.status, body: await res.json() as { error?: string; code?: string } };
  } finally {
    server.close();
    for (const r of manager.rooms.values()) r.dispose();
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('F14 live room creation', () => {
  it('refuses a live game ESPN posts no play-by-play for, with a clear message', async () => {
    const comp = full.header.competitions[0];
    const noPbp = { header: { ...full.header, competitions: [{ ...comp, status: { type: { ...comp.status.type, state: 'in' as const, completed: false } } }] } } as EspnSummary;
    const r = await post(noPbp, 'live:cfb:401858466');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/play-by-play/);
  });

  it('creates a room for a live game that has plays', async () => {
    const comp = full.header.competitions[0];
    const inProgress = { ...full, header: { ...full.header, competitions: [{ ...comp, status: { type: { ...comp.status.type, state: 'in' as const, completed: false } } }] } } as EspnSummary;
    const r = await post(inProgress, 'live:401872948');
    expect(r.status).toBe(200);
    expect(r.body.code).toMatch(/^[A-Z]{4}$/);
  });
});
