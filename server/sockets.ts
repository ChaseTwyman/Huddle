import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type { ClientToServer, ServerToClient } from '../shared/types';
import type { RoomManager } from './room/RoomManager';
import { hostRoom, playerRoom, tvRoom } from './room/transport';

type S = Socket<ClientToServer, ServerToClient>;

const Profile = z.object({
  watch: z.enum(['reality', 'dramas', 'documentaries', 'comedies', 'music', 'sports']),
  rootFor: z.enum(['favorite', 'underdog']),
  vibe: z.enum(['drama', 'numbers', 'chaos']),
  fan: z.boolean().optional(),
});

/** Wire socket events to rooms. A socket is either a TV (optionally the host) or one player. */
export function attachSockets(io: Server<ClientToServer, ServerToClient>, manager: RoomManager) {
  io.on('connection', (socket: S) => {
    let tvCode: string | null = null;
    let isHost = false;
    let player: { code: string; id: string } | null = null;

    socket.on('tv:join', (p, ack) => {
      const room = manager.get(p?.code);
      if (!room) { ack?.({ ok: false, error: 'Room not found' }); return; }
      tvCode = room.code;
      isHost = !!p.hostToken && p.hostToken === room.hostToken;
      void socket.join(tvRoom(room.code));
      if (isHost) void socket.join(hostRoom(room.code));
      room.tvJoined();
      socket.emit('room:snapshot', room.snapshot());
      ack?.({ ok: true, host: isHost });
    });

    socket.on('tv:spoken', (p) => {
      manager.get(tvCode)?.spoken(String(p?.lineId ?? ''));
    });

    socket.on('host:control', (p) => {
      const room = manager.get(tvCode);
      if (!room || !isHost || !p?.action) return;
      room.control(p.action, p.value);
    });

    socket.on('player:join', (p, ack) => {
      const room = manager.get(p?.code);
      if (!room) { ack?.({ ok: false, error: 'Room not found. Check the code on the TV.' }); return; }
      const name = String(p.name ?? '').trim();
      const known = !!p.playerId && room.players.has(p.playerId);
      if (!name && !known) { ack?.({ ok: false, error: p.playerId ? 'Please join again' : 'Enter your name' }); return; }
      const pl = room.joinPlayer({ name, color: p.color, playerId: p.playerId });
      player = { code: room.code, id: pl.id };
      void socket.join(playerRoom(pl.id));
      socket.emit('player:view', room.playerView(pl));
      ack?.({ ok: true, playerId: pl.id });
    });

    const withPlayer = (fn: (room: NonNullable<ReturnType<RoomManager['get']>>, id: string) => void) => {
      if (!player) return;
      const room = manager.get(player.code);
      if (room) fn(room, player.id);
    };

    socket.on('player:profile', (p) => {
      const parsed = Profile.safeParse(p?.answers);
      if (parsed.success) withPlayer((room, id) => room.setProfile(id, parsed.data));
    });
    socket.on('player:answer', (p) => withPlayer((room, id) => room.answer(id, String(p?.promptId), String(p?.optionId))));
    socket.on('player:takeit', (p) => withPlayer((room, id) => room.takeIt(id, String(p?.promptId), !!p?.accept)));
    socket.on('player:handoff', (p) => withPlayer((room, id) => room.handoff(id, String(p?.promptId), !!p?.accept)));
    socket.on('player:done', (p) => withPlayer((room, id) => room.done(id, String(p?.promptId))));
    socket.on('player:feedback', (p) => withPlayer((room, id) => room.feedback(id, String(p?.promptId), p?.value === 'confused' ? 'confused' : 'got_it')));

    socket.on('disconnect', () => {
      if (tvCode) manager.get(tvCode)?.tvLeft();
      if (player) {
        const room = manager.get(player.code);
        const id = player.id;
        // Only mark disconnected if no other socket for this player remains.
        void io.in(playerRoom(id)).fetchSockets().then((sockets) => {
          if (!sockets.length) room?.setConnected(id, false);
        });
      }
    });
  });
}
