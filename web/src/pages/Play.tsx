import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import '../styles/phone.css';
import type { PlayerView } from '../../../shared/types';
import { connect, storage, type HuddleSocket } from '../lib/socket';
import { useNow } from '../lib/useSnapshot';
import { Join, Profile } from '../components/phone/JoinProfile';
import { PromptScreen } from '../components/phone/Prompts';
import { PhoneRecap } from '../components/phone/PhoneRecap';

const buzz = () => { try { navigator.vibrate?.(30); } catch { /* not supported */ } };

export function Play() {
  const { code: rawCode = '' } = useParams();
  const code = rawCode.toUpperCase();
  const nav = useNavigate();
  const key = `huddle:player:${code}`;
  const sock = useRef<HuddleSocket | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<null | { good: boolean; text: string; points: number }>(null);
  const [skew, setSkew] = useState(0);
  const [storyOpen, setStoryOpen] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const lastResult = useRef<string | null>(null);
  const lastPrompt = useRef<string | null>(null);
  const lastBuzz = useRef<string | null>(null);
  const [buzzText, setBuzzText] = useState<string | null>(null);
  const now = useNow(200) + skew;

  useEffect(() => {
    if (!code) return;
    const s = connect();
    sock.current = s;
    s.on('connect', () => {
      const playerId = storage.get(key);
      if (playerId) {
        s.emit('player:join', { code, name: '', color: '', playerId }, (r) => {
          if (!r.ok) { storage.remove(key); setError(r.error ?? null); }
        });
      }
    });
    s.on('player:view', (v) => {
      setView(v);
      setSkew(v.serverNow - Date.now());
    });
    return () => { s.disconnect(); };
  }, [code, key]);

  // Result flash, buzz on new prompts and storyline beats.
  useEffect(() => {
    if (!view) return;
    if (view.lastResult && view.lastResult.id !== lastResult.current) {
      const first = lastResult.current === null;
      lastResult.current = view.lastResult.id;
      if (!first) {
        setFlash({ good: view.lastResult.correct, text: view.lastResult.label, points: view.lastResult.points });
        setTimeout(() => setFlash(null), 1200);
      }
    }
    if (view.prompt && view.prompt.id !== lastPrompt.current) { lastPrompt.current = view.prompt.id; buzz(); }
    if (view.buzz && view.buzz.id !== lastBuzz.current) {
      lastBuzz.current = view.buzz.id;
      buzz();
      setBuzzText(view.buzz.text);
      setTimeout(() => setBuzzText(null), 8000);
    }
  }, [view]);

  if (!code) {
    return (
      <main className="phone">
        <h1>Join Huddle</h1>
        <input className="name-input" value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} placeholder="Room code" maxLength={4} aria-label="Room code" />
        <button className="big-btn primary" disabled={codeInput.length !== 4} onClick={() => nav(`/play/${codeInput}`)}>Go</button>
      </main>
    );
  }

  const send = {
    answer: (promptId: string, optionId: string) => sock.current?.emit('player:answer', { promptId, optionId }),
    takeit: (promptId: string, accept: boolean) => sock.current?.emit('player:takeit', { promptId, accept }),
    handoff: (promptId: string, accept: boolean) => sock.current?.emit('player:handoff', { promptId, accept }),
    done: (promptId: string) => sock.current?.emit('player:done', { promptId }),
    feedback: (promptId: string, value: 'got_it' | 'confused') => sock.current?.emit('player:feedback', { promptId, value }),
  };

  const join = (name: string, color: string) => {
    setBusy(true);
    sock.current?.emit('player:join', { code, name, color }, (r) => {
      setBusy(false);
      if (r.ok && r.playerId) storage.set(key, r.playerId);
      else setError(r.error ?? 'Could not join');
    });
  };

  const cls = `phone ${flash ? (flash.good ? 'flash-good' : 'flash-bad') : ''}`;
  if (!view) return <main className={cls}><Join code={code} onJoin={join} error={error} busy={busy} /></main>;

  const me = view.me;
  const header = (
    <div className="top">
      <span className="me-dot" style={{ background: me.color }} />
      <b>{me.name}</b>{me.role === 'fan' ? <span className="muted">· fan</span> : null}
      <span className="pts">{me.points} · #{me.rank}</span>
    </div>
  );

  let body: React.ReactNode;
  if (flash) {
    body = <div className="eyes"><div className="result">{flash.points > 0 ? <span className="plus">+{flash.points}</span> : null}{flash.text}</div></div>;
  } else if (view.recap && view.phase === 'recap') {
    body = <PhoneRecap recap={view.recap} />;
  } else if (view.prompt) {
    body = <PromptScreen prompt={view.prompt} now={now} send={send} />;
  } else if (!me.profileDone) {
    body = <Profile onDone={(answers) => sock.current?.emit('player:profile', { answers })} />;
  } else {
    body = (
      <>
        {buzzText ? <div className="buzz">{buzzText}</div> : null}
        <div className="eyes">
          <div>
            <div className="big">Eyes on the TV</div>
            <div className="muted" style={{ marginTop: 12 }}>{view.phase === 'lobby' ? 'Waiting for everyone to join…' : view.phase === 'final' ? 'Final whistle. Recap coming…' : 'Your phone buzzes when it needs you.'}</div>
          </div>
        </div>
        {view.storyline ? (
          <button className="card-sm" style={{ textAlign: 'left', color: 'inherit' }} onClick={() => setStoryOpen((o) => !o)} aria-expanded={storyOpen}>
            <div className="step">Your player {storyOpen ? '▲' : '▼'}</div>
            <div className="title">{view.storyline.title}</div>
            {storyOpen ? <><div style={{ marginTop: 8 }}>{view.storyline.hook}</div><div className="muted" style={{ marginTop: 6 }}>Watch for: {view.storyline.watchFor}</div></> : null}
          </button>
        ) : null}
      </>
    );
  }
  return <main className={cls}>{header}{body}</main>;
}
