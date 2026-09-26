import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import '../styles/tv.css';
import { WINDOWS } from '../../../shared/constants';
import type { Talkativeness } from '../../../shared/types';
import { Speaker } from '../lib/tts';
import { storage } from '../lib/socket';
import { useNow, useTvConnection } from '../lib/useSnapshot';
import { Scorebug } from '../components/tv/Scorebug';
import { Field } from '../components/tv/Field';
import { PromptOverlay } from '../components/tv/PromptOverlay';
import { CaptionCard, Scoreboard, StorylineChips, Ticker } from '../components/tv/Rail';
import { Halftime, Lobby, Profiles, Recap, Storylines } from '../components/tv/Stages';
import { HostDock } from '../components/tv/HostDock';

const TALK: Talkativeness[] = ['quiet', 'normal', 'chatty'];

export function Tv() {
  const { code = '' } = useParams();
  const [params] = useSearchParams();
  const upper = code.toUpperCase();
  const hostToken = useMemo(() => {
    const fromUrl = params.get('host');
    if (fromUrl) storage.session.set(`huddle:host:${upper}`, fromUrl);
    return fromUrl ?? storage.session.get(`huddle:host:${upper}`);
  }, [params, upper]);

  const [started, setStarted] = useState(false);
  const [dock, setDock] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const speaker = useRef(new Speaker());
  const conn = useTvConnection(upper, hostToken, started, {
    onSpeak: (l) => speaker.current.say(l),
    onMute: (m) => speaker.current.setMuted(m),
  });
  const { snapshot: snap, control, isHost } = conn;

  useEffect(() => { speaker.current.onDone = (id) => conn.spoken(id); });

  // Clock skew between server and this screen, for countdowns.
  const [skew, setSkew] = useState(0);
  useEffect(() => { if (snap) setSkew(snap.serverNow - Date.now()); }, [snap]);
  const now = useNow(200) + skew;

  useEffect(() => { if (snap) speaker.current.setMuted(!snap.settings.voice); }, [snap?.settings.voice]);

  useEffect(() => {
    if (!started) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isHost || !snap) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); control(snap.demo.paused ? 'play' : 'pause'); }
      else if (k === 'n' || k === 'N') control('next');
      else if (k === 'Enter') control('advance');
      else if (k === 'm' || k === 'M') control('voice', !snap.settings.voice);
      else if (k === 't' || k === 'T') control('talkativeness', TALK[(TALK.indexOf(snap.settings.talkativeness) + 1) % TALK.length]);
      else if (k === 'g' || k === 'G') control('preset', snap.presetLabel?.includes('Game 4') ? null : 'game4');
      else if (k === 'h' || k === 'H') setDock((d) => !d);
      else if (k === 'j' || k === 'J') { setDock(true); setJumpOpen((j) => !j); }
      else if (/^[1-9]$/.test(k)) {
        const seg = snap.demo.segments[Number(k) - 1];
        if (seg) control('jump', { segment: seg.id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [started, isHost, snap, control]);

  if (!started) {
    return (
      <div className="start-overlay">
        <div style={{ textAlign: 'center', display: 'grid', gap: 24 }}>
          <div className="room-code" style={{ fontSize: 96 }}>{upper}</div>
          <button className="btn primary" onClick={() => { speaker.current.unlock(); setStarted(true); }}>Start Huddle</button>
          <div className="muted">Starting lets the TV speak. Put this window on the TV, full screen.</div>
        </div>
      </div>
    );
  }
  if (conn.error) return <div className="tv"><div className="stage"><h1>{conn.error}</h1><a className="btn" href="/">Create a new room</a></div></div>;
  if (!snap) return <div className="tv"><div className="stage"><div className="hint">Connecting…</div></div></div>;

  const windowMs = snap.prompt?.kind === 'callit' ? WINDOWS.callItMs : WINDOWS.predictMs;
  const liveLike = snap.phase === 'live';

  return (
    <div className="tv">
      {snap.phase === 'lobby' ? <Lobby snap={snap} /> : null}
      {snap.phase === 'profiles' ? <Profiles snap={snap} /> : null}
      {snap.phase === 'storylines' ? <Storylines snap={snap} /> : null}
      {snap.phase === 'halftime' ? <Halftime snap={snap} /> : null}
      {snap.phase === 'final' || snap.phase === 'recap' ? <Recap snap={snap} /> : null}
      {liveLike ? (
        <>
          <Scorebug snap={snap} />
          <Field snap={snap}>
            {snap.status && !snap.prompt ? <div className="status-banner">{snap.status}</div> : null}
            <PromptOverlay snap={snap} now={now} windowMs={windowMs} />
            {snap.explaining ? (
              <div className="explaining-banner">
                <span className="dot" style={{ background: snap.players.find((p) => p.id === snap.explaining!.playerId)?.color ?? 'var(--good)' }} />
                {snap.explaining.name} is explaining
              </div>
            ) : null}
          </Field>
          <div className="rail">
            <Scoreboard snap={snap} />
            <CaptionCard snap={snap} />
            <StorylineChips snap={snap} />
          </div>
          <Ticker snap={snap} />
        </>
      ) : null}
      {isHost && dock ? <HostDock snap={snap} aiLog={conn.aiLog} control={control} showJump={jumpOpen} voiceName={speaker.current.voiceName} /> : null}
      {!conn.connected ? <div className="status-banner" style={{ position: 'fixed', top: 12 }}>Reconnecting…</div> : null}
    </div>
  );
}
