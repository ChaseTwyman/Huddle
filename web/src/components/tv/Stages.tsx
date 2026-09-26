import { useEffect, useState, type CSSProperties } from 'react';
import QRCode from 'qrcode';
import type { RoomSnapshot } from '../../../../shared/types';
import { Avatar } from './Avatar';
import { Scoreboard } from './Rail';
import { Mark } from '../Mark';

type StageProps = { snap: RoomSnapshot; onAdvance?: () => void };

function StageTop({ snap }: { snap: RoomSnapshot }) {
  return (
    <div className="stage-top">
      <span className="wordmark"><Mark />Huddle</span>
      <span className="muted">{snap.game.title}</span>
    </div>
  );
}

export function Lobby({ snap, onAdvance }: StageProps) {
  const [base, setBase] = useState<string>('');
  const [qr, setQr] = useState<string>('');
  useEffect(() => {
    fetch('/api/lan').then((r) => r.json()).then((j: { phoneUrlBase: string }) => setBase(j.phoneUrlBase)).catch(() => setBase(window.location.origin));
  }, []);
  const url = base ? `${base}/play/${snap.code}` : '';
  useEffect(() => {
    if (url) QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: '#111214', light: '#FFFFFF' } }).then(setQr).catch(() => setQr(''));
  }, [url]);
  const n = snap.players.length;
  return (
    <div className="stage">
      <StageTop snap={snap} />
      <h1>Grab your phones</h1>
      <div className="sub">Scan the code to join. Your phone is your buzzer tonight.</div>
      <div className="lobby-card surface">
        <div className="qr">{qr ? <img src={qr} alt={`QR code for ${url}`} /> : null}</div>
        <div className="left">
          <div className="step-n">Or open</div>
          <div className="big">{url ? url.replace(/^https?:\/\//, '').replace(/\/play\/.*$/, '/play') : '…'}</div>
          <div className="step-n" style={{ marginTop: 8 }}>and enter</div>
          <div className="room-code" aria-label={`Room code ${snap.code.split('').join(' ')}`}>{snap.code}</div>
        </div>
      </div>
      <div className="joined" aria-live="polite">
        {snap.players.map((p) => (
          <div key={p.id} className="who"><Avatar name={p.name} color={p.color} off={!p.connected} />{p.name}</div>
        ))}
        {!n ? <div className="empty">Waiting for the first phone</div> : null}
      </div>
      {n ? (
        onAdvance
          ? <button className="btn primary" onClick={onAdvance}>{n === 1 ? "Just me, let's go" : `Everyone's in (${n})`}</button>
          : <div className="hint">Waiting for the host to start</div>
      ) : null}
    </div>
  );
}

export function Profiles({ snap, onAdvance }: StageProps) {
  const done = snap.players.filter((p) => p.profileDone).length;
  return (
    <div className="stage">
      <StageTop snap={snap} />
      <h1>Three quick taps</h1>
      <div className="sub">What you watch, who you root for, and your vibe. Huddle picks a player for each of you.</div>
      <div className="joined">
        {snap.players.map((p) => (
          <div key={p.id} className="who"><Avatar name={p.name} color={p.color} locked={p.profileDone} off={!p.profileDone} />{p.name}{p.role === 'fan' ? <span className="muted"> · fan</span> : null}</div>
        ))}
      </div>
      <div className="hint">{done} of {snap.players.length} ready</div>
      {onAdvance ? <button className="btn" onClick={onAdvance}>Continue without waiting</button> : null}
    </div>
  );
}

export function Storylines({ snap, onAdvance }: StageProps) {
  const byId = new Map(snap.players.map((p) => [p.id, p]));
  const shown = snap.storylineReveal;
  return (
    <div className="stage">
      <StageTop snap={snap} />
      <h1>Who to watch tonight</h1>
      <div className="story-cards">
        {snap.storylines.map((s, i) => {
          const p = byId.get(s.playerId);
          const state = i >= shown ? 'hidden' : i === shown - 1 ? 'current' : 'done';
          return (
            <div key={s.playerId} className={`story-card ${state}`} style={{ '--c': p?.color } as CSSProperties}>
              <div className="who">{p ? <Avatar name={p.name} color={p.color} /> : null}{p?.name}</div>
              <h2>{i < shown ? s.title : 'Picking a player…'}</h2>
              {i < shown ? (<><div className="hook">{s.hook}</div><div className="watch">Watch for: {s.watchFor}</div></>) : null}
            </div>
          );
        })}
      </div>
      <div className="dots" aria-hidden>{snap.storylines.map((s, i) => <i key={s.playerId} className={i === shown - 1 ? 'on' : ''} />)}</div>
      {onAdvance ? <button className="btn" onClick={onAdvance}>Skip to kickoff</button> : null}
    </div>
  );
}

export function Halftime({ snap }: { snap: RoomSnapshot }) {
  const sb = snap.scorebug;
  return (
    <div className="stage">
      <StageTop snap={snap} />
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
