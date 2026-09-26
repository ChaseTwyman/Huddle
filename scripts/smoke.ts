/**
 * npm run smoke: real server (mock LLM, demo pacing ×20), one TV + three phones over socket.io.
 * Lobby → profiles → storylines → segment C (the Bradberry flag) → final → recap. Exits non-zero on failure.
 */
process.env.LLM_PROVIDER = 'mock';
import { io as ioc, type Socket } from 'socket.io-client';
import type { ClientToServer, PlayerView, RoomSnapshot, ServerToClient } from '../shared/types';
import { startServer } from '../server/index';

type C = Socket<ServerToClient, ClientToServer>;
const SPEED = 20;
const results: { ok: boolean; msg: string }[] = [];
const check = (ok: boolean, msg: string) => { results.push({ ok, msg }); console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, fn: () => T | undefined | null | false, timeoutMs = 30000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function main() {
  const server = await startServer({ port: 0, speed: SPEED, families: null, quiet: true, prod: false });
  const base = `http://localhost:${server.port}`;
  const sockets: C[] = [];
  const connect = () => {
    const s: C = ioc(base, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    return s;
  };
  try {
    const res = await fetch(`${base}/api/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: '2022_22_KC_PHI', mode: 'demo', pacing: 'demo', talkativeness: 'normal', voice: true, fanHandicap: true }),
    });
    const { code, hostToken } = (await res.json()) as { code: string; hostToken: string };
    check(/^[A-HJKMNP-Z]{4}$/.test(code), `room created: ${code} (4 letters, no I/O/L)`);
    const games = await (await fetch(`${base}/api/games`)).json();
    check(Array.isArray(games) && games.some((g: { id: string }) => g.id === '2022_22_KC_PHI'), 'GET /api/games lists Super Bowl LVII');

    // TV
    const tv = connect();
    const snaps: { at: number; s: RoomSnapshot }[] = [];
    let last: RoomSnapshot | null = null;
    tv.on('room:snapshot', (s) => { snaps.push({ at: Date.now(), s }); last = s; });
    tv.on('tv:speak', (l) => { setTimeout(() => tv.emit('tv:spoken', { lineId: l.lineId }), 30); });
    const host = await new Promise<boolean>((resolve) => tv.emit('tv:join', { code, hostToken }, (r) => resolve(!!r.ok && !!r.host)));
    check(host, 'TV joined as host');
    const control = (action: Parameters<ClientToServer['host:control']>[0]['action'], value?: unknown) => tv.emit('host:control', { action, value });

    // Phones
    const people = [
      { name: 'Sam', fan: true },
      { name: 'Mom', fan: false },
      { name: 'Sister', fan: false },
    ];
    const views = new Map<string, PlayerView>();
    const offers: { kind: string; at: number }[] = [];
    const phoneIds: string[] = [];
    for (const [i, p] of people.entries()) {
      const s = connect();
      const handled = new Set<string>();
      s.on('player:view', (v) => {
        views.set(p.name, v);
        const pr = v.prompt;
        if (!pr || handled.has(pr.id)) return;
        handled.add(pr.id);
        const later = (fn: () => void) => setTimeout(fn, 60);
        if (pr.kind === 'predict' || pr.kind === 'callit') later(() => s.emit('player:answer', { promptId: pr.id, optionId: pr.options[i % pr.options.length].id }));
        if (pr.kind === 'takeit') { offers.push({ kind: 'takeit', at: Date.now() }); later(() => s.emit('player:takeit', { promptId: pr.id, accept: false })); }
        if (pr.kind === 'handoff') { offers.push({ kind: 'handoff', at: Date.now() }); later(() => s.emit('player:handoff', { promptId: pr.id, accept: true })); }
        if (pr.kind === 'done') later(() => s.emit('player:done', { promptId: pr.id }));
        if (pr.kind === 'feedback') later(() => s.emit('player:feedback', { promptId: pr.id, value: 'got_it' }));
      });
      const r = await new Promise<{ ok: boolean; playerId?: string }>((resolve) => s.emit('player:join', { code, name: p.name, color: '#3D8BFF' }, resolve));
      if (r.playerId) phoneIds.push(r.playerId);
    }
    await waitFor('3 players on the TV', () => last && (last as RoomSnapshot).players.length === 3);
    check(true, 'three phones joined and show on the TV');

    // Profiles
    control('advance');
    await waitFor('profiles phase', () => last?.phase === 'profiles');
    for (const [i, s] of sockets.slice(1).entries()) {
      s.emit('player:profile', { answers: people[i].fan ? { watch: 'sports', rootFor: 'favorite', vibe: 'numbers', fan: true } : { watch: i === 1 ? 'dramas' : 'reality', rootFor: 'underdog', vibe: i === 1 ? 'drama' : 'chaos' } });
    }
    await waitFor('storylines phase', () => last?.phase === 'storylines', 10000);
    const st = last as unknown as RoomSnapshot;
    check(st.storylines.length === 2, `storyline cards assigned to both learners (${st.storylines.map((x) => x.title).join(', ')})`);
    check(new Set(st.storylines.map((x) => x.title)).size === 2, 'learners got different storylines');
    const leaked = st.storylines.some((x) => /65 yards|38–35|28–27|35–35|tugged|MVP/.test(x.hook));
    check(!leaked, 'storyline hooks contain no spoilers');
    control('advance');
    await waitFor('live phase', () => last?.phase === 'live', 10000);

    // Segment C
    const jumpAt = Date.now();
    control('jump', { segment: 'C' });
    const callit = await waitFor('Call It on the Bradberry flag', () => snaps.find((x) => x.at > jumpAt && x.s.prompt?.kind === 'callit' && x.s.scorebug?.downDistance === '3rd & 8' && x.s.scorebug?.ballOn === 'PHI 15'), 60000);
    check(callit.s.prompt!.options.length === 4, `Call It opened on 3rd & 8 at PHI 15 with 4 options: ${callit.s.prompt!.options.map((o) => o.label).join(' / ')}`);
    check(callit.s.scorebug!.flag, 'FLAG pill shown during the window');
    check(callit.s.prompt!.options.some((o) => o.label === 'Defensive holding'), 'the real penalty is among the options');
    const closesAt = callit.s.prompt!.closesAt;
    const ann = await waitFor('announcement card', () => snaps.find((x) => x.at > jumpAt && x.s.card?.kind === 'announcement' && /Defensive holding/.test(x.s.card.body)), 30000);
    check(ann.s.serverNow >= closesAt || !!ann.s.prompt?.reveal, 'announcement appears only after the Call It window closed');
    const early = snaps.filter((x) => x.at > jumpAt && x.at < ann.at).some((x) => {
      const copy = { ...x.s, prompt: x.s.prompt ? { ...x.s.prompt, options: [] } : null };
      return /defensive holding/i.test(JSON.stringify(copy));
    });
    check(!early, 'no snapshot names the penalty before the announcement (outside the four options)');
    const after = await waitFor('Director explanation or handoff after the call', () => {
      const card = snaps.find((x) => x.at > ann.at && (x.s.card?.kind === 'explain' || x.s.card?.kind === 'human'));
      if (card) return `${card.s.card!.kind} card: ${card.s.card!.title}`;
      const offer = offers.find((o) => o.at > ann.at);
      return offer ? `${offer.kind} offer` : null;
    }, 30000);
    check(!!after, `Director followed the call (${after})`);
    const scored = await waitFor('scoreboard change', () => snaps.find((x) => x.s.players.some((p) => p.points > 0)), 30000);
    check(!!scored, `scoreboard changed (${scored.s.players.map((p) => `${p.name} ${p.points}`).join(', ')})`);

    // Jump to the end
    control('jump', { moment: 'final' });
    await waitFor('final phase', () => last?.phase === 'final' || last?.phase === 'recap', 60000);
    check(true, 'reached final');
    await waitFor('recap phase', () => last?.phase === 'recap' && last.recap, 30000);
    const recap = (last as unknown as RoomSnapshot).recap!;
    check(recap.people.length === 3 && recap.groupChatText.includes('Mom'), `recap ready: "${recap.title}"`);
    const momView = views.get('Mom');
    await waitFor('phone recap', () => views.get('Mom')?.recap, 5000);
    check(!!(views.get('Mom')?.recap ?? momView?.recap), 'phones received their recap cards');

    // Rejoin keeps points and role
    const samId = phoneIds[0];
    const re = connect();
    const rejoin = await new Promise<{ ok: boolean; playerId?: string }>((resolve) => re.emit('player:join', { code, name: '', color: '', playerId: samId }, resolve));
    const reView = await waitFor('rejoin view', () => new Promise<PlayerView>((r) => re.once('player:view', r)), 5000);
    const v = await reView;
    check(rejoin.ok && rejoin.playerId === samId && v.me.role === 'fan', `refresh rejoins as the same player (role ${v.me.role}, ${v.me.points} pts)`);
  } catch (e) {
    check(false, (e as Error).message);
  } finally {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\nSMOKE FAILED (${failed.length})` : `\nSmoke passed (${results.length} checks).`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
