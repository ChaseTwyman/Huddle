import type { RoomSnapshot } from '../../../../shared/types';
import { Avatar } from './Avatar';

function Ring({ remainingMs, totalMs }: { remainingMs: number; totalMs: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, remainingMs / totalMs));
  const secs = Math.ceil(remainingMs / 1000);
  return (
    <svg className="ring" viewBox="0 0 100 100" aria-label={`${secs} seconds left`}>
      <circle cx="50" cy="50" r={r} fill="none" stroke="var(--line)" strokeWidth="8" />
      <circle cx="50" cy="50" r={r} fill="none" stroke={secs <= 3 ? 'var(--bad)' : 'var(--flag)'} strokeWidth="8" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 50 50)" style={{ transition: 'stroke-dashoffset 200ms linear' }} />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="34">{secs}</text>
    </svg>
  );
}

/** Predict / Call It over the field: question, tiles, countdown, who's locked in (never what they picked). */
export function PromptOverlay({ snap, now, windowMs }: { snap: RoomSnapshot; now: number; windowMs: number }) {
  const p = snap.prompt;
  if (!p) return null;
  // After the reveal, get out of the way once an explanation or storyline card takes over.
  if (p.reveal && snap.card && snap.card.kind !== 'announcement' && snap.card.kind !== 'summary') return null;
  const reveal = p.reveal;
  const remaining = p.closesAt - now;
  const open = !reveal && remaining > 0;
  const results = new Map(reveal?.results.map((r) => [r.playerId, r]) ?? []);
  return (
    <div className={`prompt-overlay ${p.kind}`} role="dialog" aria-label={p.question}>
      <div className="prompt-head">
        <div style={{ flex: 1 }}>
          <div className="prompt-kind">{/^Practice/.test(p.question) ? 'Practice round · no points' : p.kind === 'callit' ? 'Flag on the play · Call it' : 'Predict'}</div>
          <div className="prompt-q">{p.voided ? 'No play. Prediction voided.' : p.question}</div>
        </div>
        {open ? <Ring remainingMs={remaining} totalMs={windowMs} /> : null}
      </div>
      <div className={`options ${p.options.length === 3 ? 'n3' : ''}`}>
        {p.options.map((o) => {
          const isCorrect = !!reveal && !p.voided && o.id === reveal.correctOptionId;
          const cls = ['option', isCorrect && 'correct', reveal && !isCorrect && 'dim'].filter(Boolean).join(' ');
          return (
            <div key={o.id} className={cls}>
              <span className="letter">{p.kind === 'callit' ? o.id : ''}</span>
              <span>{o.label}</span>
            </div>
          );
        })}
      </div>
      <div className="lockrow">
        <span className="label">{reveal ? (p.voided ? 'Voided' : 'Results') : open ? 'Locked in' : 'Waiting for the call…'}</span>
        {snap.players.filter((pl) => pl.connected).map((pl) => {
          const r = results.get(pl.id);
          return (
            <Avatar key={pl.id} name={pl.name} color={pl.color}
              locked={!reveal && pl.lockedIn} off={!reveal && !pl.lockedIn && open}
              bounce={!!r?.correct} floatText={r?.correct ? `+${r.points}` : null} />
          );
        })}
      </div>
    </div>
  );
}
