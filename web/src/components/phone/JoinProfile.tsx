import { useState } from 'react';
import { PLAYER_COLORS } from '../../../../shared/constants';
import type { ProfileAnswers } from '../../../../shared/types';

export function Join({ code, onJoin, error, busy }: { code: string; onJoin: (name: string, color: string) => void; error: string | null; busy: boolean }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]);
  return (
    <div className="stack">
      <div className="step">Room {code}</div>
      <h1>Join the huddle</h1>
      <div className="muted" style={{ marginTop: -6 }}>Your phone is your buzzer. Everything happens on the TV.</div>
      <input className="name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" maxLength={24} autoFocus aria-label="Your first name" />
      <div className="swatches" role="radiogroup" aria-label="Pick a color">
        {PLAYER_COLORS.map((c) => (
          <button key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Color ${c}`} aria-checked={c === color} role="radio" />
        ))}
      </div>
      {error ? <div style={{ color: 'var(--bad)' }} role="alert">{error}</div> : null}
      <button className="big-btn primary" disabled={!name.trim() || busy} onClick={() => onJoin(name.trim(), color)}>{busy ? 'Joining…' : 'Join'}</button>
    </div>
  );
}

const Q1: [ProfileAnswers['watch'], string][] = [
  ['reality', 'Reality and competition shows'], ['dramas', 'Dramas'], ['documentaries', 'Documentaries and true crime'],
  ['comedies', 'Comedies'], ['music', 'Music and pop culture'], ['sports', 'Sports'],
];
const Q2: [ProfileAnswers['rootFor'], string][] = [['favorite', 'Favorite'], ['underdog', 'Underdog']];
const Q3: [ProfileAnswers['vibe'], string][] = [['drama', 'Drama'], ['numbers', 'Numbers'], ['chaos', 'Chaos']];

export function Profile({ onDone }: { onDone: (a: ProfileAnswers) => void }) {
  const [watch, setWatch] = useState<ProfileAnswers['watch'] | null>(null);
  const [rootFor, setRootFor] = useState<ProfileAnswers['rootFor'] | null>(null);
  const step = !watch ? 1 : !rootFor ? 2 : 3;
  return (
    <div className="stack">
      <div className="progress" aria-label={`Question ${step} of 3`}>{[1, 2, 3].map((i) => <i key={i} className={i <= step ? 'on' : ''} />)}</div>
      {step === 1 ? (
        <>
          <h2>What do you usually watch?</h2>
          {Q1.map(([v, l]) => <button key={v} className="big-btn" onClick={() => setWatch(v)}>{l}</button>)}
        </>
      ) : null}
      {step === 2 ? (
        <>
          <h2>Root for the favorite or the underdog?</h2>
          {Q2.map(([v, l]) => <button key={v} className="big-btn" onClick={() => setRootFor(v)}>{l}</button>)}
        </>
      ) : null}
      {step === 3 ? (
        <>
          <h2>Pick a vibe.</h2>
          {Q3.map(([v, l]) => <button key={v} className="big-btn" onClick={() => onDone({ watch: watch!, rootFor: rootFor!, vibe: v })}>{l}</button>)}
        </>
      ) : null}
      <button className="big-btn ghost" onClick={() => onDone({ watch: 'sports', rootFor: 'favorite', vibe: 'numbers', fan: true })}>I already know football</button>
    </div>
  );
}
