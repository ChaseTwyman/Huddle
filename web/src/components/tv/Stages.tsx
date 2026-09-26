import { useEffect, useState, type CSSProperties } from 'react';
import QRCode from 'qrcode';
import type { RoomSnapshot } from '../../../../shared/types';
import { Avatar } from './Avatar';
import { Scoreboard } from './Rail';

export function Lobby({ snap }: { snap: RoomSnapshot }) {
  const [base, setBase] = useState<string>('');
  const [qr, setQr] = useState<string>('');
  useEffect(() => {
    fetch('/api/lan').then((r) => r.json()).then((j: { phoneUrlBase: string }) => setBase(j.phoneUrlBase)).catch(() => setBase(window.location.origin));
  }, []);
  const url = base ? `${base}/play/${snap.code}` : '';
  useEffect(() => {
    if (url) QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: '#0B120E', light: '#FFFFFF' } }).then(setQr).catch(() => setQr(''));
  }, [url]);
  return (
    <div className="stage">
      <div className="hint">Scan to join · {snap.game.title}</div>
      <div className="lobby-grid">
        <div>
          <div className="room-code" aria-label={`Room code ${snap.code.split('').join(' ')}`}>{snap.code}</div>
          <div className="url">{url || '…'}</div>
        </div>
        <div className="qr">{qr ? <img src={qr} alt={`QR code for ${url}`} /> : null}</div>
      </div>
      <div className="joined">
        {snap.players.map((p) => (
          <div key={p.id} className="who"><Avatar name={p.name} color={p.color} off={!p.connected} />{p.name}</div>
        ))}
      </div>
      <div className="hint">{snap.players.length ? 'Press Enter to start' : 'Waiting for phones…'}</div>
    </div>
  );
}

export function Profiles({ snap }: { snap: RoomSnapshot }) {
  return (
    <div className="stage">
      <h1>Three quick taps</h1>
      <div className="muted">What you watch, who you root for, and your vibe.</div>
      <div className="joined">
        {snap.players.map((p) => (
          <div key={p.id} className="who"><Avatar name={p.name} color={p.color} locked={p.profileDone} off={!p.profileDone} />{p.name}{p.role === 'fan' ? ' · fan' : ''}</div>
        ))}
      </div>
      <div className="hint">Press Enter to continue</div>
    </div>
  );
}

export function Storylines({ snap }: { snap: RoomSnapshot }) {
  const byId = new Map(snap.players.map((p) => [p.id, p]));
  return (
    <div className="stage">
      <h1>Who to watch tonight</h1>
      <div className="story-cards">
        {snap.storylines.map((s, i) => {
          const p = byId.get(s.playerId);
          return (
            <div key={s.playerId} className={`story-card ${i < snap.storylineReveal ? '' : 'hidden'}`} style={{ '--c': p?.color } as CSSProperties}>
              <div className="who">{p?.name}</div>
              <h2>{s.title}</h2>
              {i < snap.storylineReveal ? (<><div className="hook">{s.hook}</div><div className="watch">Watch for: {s.watchFor}</div></>) : null}
            </div>
          );
        })}
      </div>
      <div className="hint">Press Enter to kick off</div>
    </div>
  );
}

export function Halftime({ snap }: { snap: RoomSnapshot }) {
  const sb = snap.scorebug;
  return (
    <div className="stage">
      <div className="hint">Halftime</div>
      <div className="big-score">{snap.game.away.abbr} {sb?.away ?? 0} · {snap.game.home.abbr} {sb?.home ?? 0}</div>
      {snap.halftime?.facts.length ? <div className="facts">{snap.halftime.facts.map((f) => <p key={f}>{f}</p>)}</div> : null}
      <div style={{ width: 'min(520px, 60%)' }}><Scoreboard snap={snap} /></div>
    </div>
  );
}

export function Recap({ snap }: { snap: RoomSnapshot }) {
  const r = snap.recap;
  if (!r) {
    return (
      <div className="stage">
        <div className="hint">Final</div>
        <div className="big-score">{snap.game.away.abbr} {snap.scorebug?.away ?? 0} · {snap.game.home.abbr} {snap.scorebug?.home ?? 0}</div>
        <div className="muted">Writing your recap…</div>
      </div>
    );
  }
  return (
    <div className="stage">
      <div className="hint">{r.finalScore}</div>
      <h1>{r.title}</h1>
      <div className="facts">{r.momentOfTheNight}</div>
      <div className="recap-grid">
        {[...r.people].sort((a, b) => a.rank - b.rank).map((p) => (
          <div key={p.playerId} className="recap-card" style={{ '--c': p.color } as CSSProperties}>
            <span className="rank">#{p.rank}</span>
            <h3>{p.name}</h3>
            <div>{p.headline}</div>
            <div className="stat">{p.points} pts · Call It {p.callIt.correct}/{p.callIt.total} · Predict {p.predict.correct}/{p.predict.total}{p.explanationsGiven ? ` · explained ${p.explanationsGiven}` : ''}</div>
            <div className="learned">{p.bestMoment}</div>
            {p.role === 'learner' ? <div className="stat">Rules you know: {p.rulesKnown}{p.learnedTonight.length ? ` · new tonight: ${p.learnedTonight.join(', ')}` : ''}</div> : null}
          </div>
        ))}
      </div>
      <div className="muted">{r.nextTime}</div>
    </div>
  );
}
