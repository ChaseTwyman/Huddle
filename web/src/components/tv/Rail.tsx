import type { RoomSnapshot } from '../../../../shared/types';
import { Avatar } from './Avatar';

export function Scoreboard({ snap }: { snap: RoomSnapshot }) {
  const rows = [...snap.players].sort((a, b) => b.points - a.points);
  return (
    <div className="panel">
      <h3>Family scoreboard</h3>
      {rows.length === 0 ? <div className="muted">Nobody yet</div> : null}
      {rows.map((p) => (
        <div key={p.id} className="board-row" style={{ opacity: p.connected ? 1 : 0.45 }}>
          <Avatar name={p.name} color={p.color} />
          <span className="name">{p.name}</span>
          {p.role === 'fan' ? <span className="role">fan</span> : null}
          <span className="pts">{p.points}</span>
        </div>
      ))}
    </div>
  );
}

export function CaptionCard({ snap }: { snap: RoomSnapshot }) {
  const c = snap.card;
  if (!c) return null;
  return (
    <div key={c.id} className={`panel caption ${c.kind}`} aria-live="polite">
      <span className="by">{c.by}</span>
      <div className="ctitle">{c.title}</div>
      <div className="cbody">{c.body}</div>
      {c.source ? <div className="csrc">{c.source}</div> : null}
    </div>
  );
}

export function StorylineChips({ snap }: { snap: RoomSnapshot }) {
  if (!snap.storylines.length) return null;
  const byId = new Map(snap.players.map((p) => [p.id, p]));
  return (
    <div className="panel">
      <h3>Who to watch</h3>
      <div className="chips">
        {snap.storylines.map((s) => {
          const p = byId.get(s.playerId);
          return (
            <div key={s.playerId} className="chip-story">
              <span style={{ color: p?.color }}>●</span>
              <b>{p?.name}</b>
              <span className="muted">{s.title}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Ticker({ snap }: { snap: RoomSnapshot }) {
  return (
    <div className="ticker">
      <span className="tag">PLAY</span>
      <span className="text">{snap.ticker ?? (snap.live ? 'Waiting for the first play from ESPN…' : 'Waiting for kickoff')}</span>
      <span className="code">Room {snap.code} · {snap.game.title}</span>
    </div>
  );
}
