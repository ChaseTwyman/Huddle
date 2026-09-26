import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import '../styles/setup.css';
import type { GameIndexEntry, Mode, Pacing, Talkativeness } from '../../../shared/types';
import { team } from '../../../shared/teams';
import { storage } from '../lib/socket';
import { setVideoFile } from '../lib/videoStore';
import { sfx } from '../lib/sfx';
import { Mark } from '../components/Mark';

function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label?: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button type="button" key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

type LiveGameRow = { eventId: string; name: string; shortName: string; state: 'pre' | 'in' | 'post'; detail: string; date: string };

const fmtDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

/** A classic game as a tile: team colors and names, never the final score (that would spoil it). */
function GameTile({ g, on, onPick }: { g: GameIndexEntry; on: boolean; onPick: () => void }) {
  const a = team(g.away);
  const h = team(g.home);
  return (
    <button type="button" className={`game-tile ${on ? 'on' : ''}`} onClick={onPick} aria-pressed={on}
      style={{ '--a': a.primary, '--h': h.primary } as CSSProperties}>
      <span className="stripe" aria-hidden />
      <span className="gt-title">{g.title}</span>
      <span className="gt-teams">{a.city} {a.name} <span className="muted">at</span> {h.city} {h.name}</span>
      <span className="gt-date muted">{fmtDate(g.date)}</span>
    </button>
  );
}

/**
 * Host setup. One tap: the first classic game is picked, "Start game night" creates the room and opens the TV
 * lobby with sound already unlocked (the tap counts as the browser's required gesture). Everything else is
 * under Options.
 */
export function HostSetup() {
  const nav = useNavigate();
  const [games, setGames] = useState<GameIndexEntry[]>([]);
  const [familyName, setFamilyName] = useState(storage.get('huddle:family') ?? '');
  const [gameId, setGameId] = useState('');
  const [mode, setMode] = useState<Mode>('condensed');
  const [pacing, setPacing] = useState<Pacing>('gameNight');
  const [talk, setTalk] = useState<Talkativeness>('normal');
  const [voice, setVoice] = useState(true);
  const [fanHandicap, setFanHandicap] = useState(true);
  const [practice, setPractice] = useState(true);
  const [video, setVideo] = useState<File | null>(null);
  const [source, setSource] = useState<'classic' | 'live'>('classic');
  const [liveGames, setLiveGames] = useState<LiveGameRow[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [livePick, setLivePick] = useState<string>('');
  const [delaySec, setDelaySec] = useState(0);
  const [league, setLeague] = useState<'nfl' | 'cfb'>('nfl');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/games').then((r) => r.json()).then((g: GameIndexEntry[]) => {
      setGames(g);
      if (g[0]) setGameId(g[0].id);
    }).catch(() => setError('Could not reach the Huddle server.'));
  }, []);

  useEffect(() => {
    if (source !== 'live' || liveGames) return;
    // Ignore a response for a league the user has already switched away from.
    let current = true;
    fetch(`/api/live/games?league=${league}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'ESPN unavailable');
      if (!current) return;
      setLiveGames(j);
      const first = (j as LiveGameRow[]).find((g) => g.state === 'in') ?? (j as LiveGameRow[]).find((g) => g.state === 'post');
      if (first) setLivePick(`${first.state === 'post' ? 'replay' : 'live'}:${league === 'cfb' ? 'cfb:' : ''}${first.eventId}`);
    }).catch((e) => { if (current) setLiveError((e as Error).message); });
    return () => { current = false; };
  }, [source, liveGames, league]);

  const create = async () => {
    // This tap is the gesture browsers require before a page may play sound.
    sfx.unlock();
    setBusy(true);
    setError(null);
    try {
      storage.set('huddle:family', familyName);
      const res = await fetch('/api/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(source === 'live'
          ? { familyName: familyName || null, gameId: livePick, mode: 'full', pacing: 'live', talkativeness: talk, voice, fanHandicap, practice, ...(livePick.startsWith('live:') ? { delaySec } : {}) }
          : { familyName: familyName || null, gameId, mode, pacing, talkativeness: talk, voice, fanHandicap, practice }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'Could not create room');
      storage.session.set(`huddle:host:${j.code}`, j.hostToken);
      storage.session.set(`huddle:autostart:${j.code}`, '1');
      setVideoFile(video);
      nav(`/tv/${j.code}?host=${j.hostToken}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const ready = source === 'live' ? !!livePick : !!gameId;

  return (
    <main className="setup">
      <header className="setup-top">
        <span className="wordmark"><Mark />Huddle</span>
        <a className="top-link" href="/play">Join on a phone</a>
      </header>

      <section className="hero">
        <h1>Football night, with a co&#8209;host.</h1>
        <p>Everyone plays along on their phone. Huddle explains the rules as they come up, and talks less as your family learns.</p>
      </section>

      <div className="setup-card">
        <Seg label="What to watch" value={source} onChange={setSource} options={[['classic', 'Classic games'], ['live', 'This week']]} />

        {source === 'classic' ? (
          <div className="tiles">
            {games.map((g) => <GameTile key={g.id} g={g} on={g.id === gameId} onPick={() => setGameId(g.id)} />)}
            {!games.length && !error ? <div className="skeleton" /> : null}
          </div>
        ) : (
          <div className="live-pick">
            <Seg label="League" value={league} onChange={(v) => { setLeague(v); setLiveGames(null); setLivePick(''); setLiveError(null); }} options={[['nfl', 'NFL'], ['cfb', 'College']]} />
            {liveError ? <div className="error">{liveError}</div> : null}
            {!liveGames && !liveError ? <div className="muted small">Loading this week's games from ESPN…</div> : null}
            <div className="live-list">
              {(liveGames ?? []).map((g) => {
                const id = `${g.state === 'post' ? 'replay' : 'live'}:${league === 'cfb' ? 'cfb:' : ''}${g.eventId}`;
                const badge = g.state === 'in' ? 'Live' : g.state === 'post' ? 'Replay' : 'Soon';
                return (
                  <button type="button" key={g.eventId} className={`live-row ${livePick === id ? 'on' : ''}`} onClick={() => setLivePick(id)} disabled={g.state === 'pre'}>
                    <span className={`badge ${g.state}`}>{badge}</span>
                    <span className="name">{g.shortName}</span>
                    <span className="muted small">{g.state === 'pre' ? new Date(g.date).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : g.detail}</span>
                  </button>
                );
              })}
            </div>
            {livePick.startsWith('live:') ? (
              <label className="slider">
                <span>Your TV is <b>{delaySec} s</b> behind live</span>
                <input type="range" min={0} max={90} step={5} value={delaySec} onChange={(e) => setDelaySec(Number(e.target.value))} />
                <span className="muted small">Cable or antenna: 0–10 s. Streaming apps: 30–60 s. Fine-tune later with Sync (press H on the TV).</span>
              </label>
            ) : livePick.startsWith('replay:') ? (
              <div className="muted small">Finished game: Huddle replays it on the original timing, as if it were live.</div>
            ) : null}
          </div>
        )}

        <label className="field">
          <span>Family name <span className="muted">(optional, remembers what everyone learns)</span></span>
          <input value={familyName} onChange={(e) => setFamilyName(e.target.value)} placeholder="The Riveras" maxLength={40} />
        </label>

        {error ? <div className="error" role="alert">{error}</div> : null}
        <button className="btn primary cta" disabled={!ready || busy} onClick={create}>{busy ? 'Setting up…' : 'Start game night'}</button>

        <details className="more">
          <summary>Options</summary>
          <div className="more-body">
            {source === 'classic' ? (
              <>
                <div className="opt"><span>Length</span><Seg value={mode} onChange={setMode} options={[['condensed', 'Highlights (~25 min)'], ['full', 'Every play'], ['demo', 'Demo moments']]} /></div>
                <div className="opt"><span>Pace</span><Seg value={pacing} onChange={setPacing} options={[['gameNight', 'Relaxed'], ['demo', 'Quick']]} /></div>
              </>
            ) : null}
            <div className="opt"><span>How much Huddle talks</span><Seg value={talk} onChange={setTalk} options={[['quiet', 'Quiet'], ['normal', 'Normal'], ['chatty', 'Chatty']]} /></div>
            <div className="switches">
              <Switch on={voice} onChange={setVoice} label="Voice" hint="Huddle speaks through the TV" />
              <Switch on={practice} onChange={setPractice} label="Practice round" hint="A warm-up guess before kickoff" />
              <Switch on={fanHandicap} onChange={setFanHandicap} label="Fan handicap" hint="The football fan scores half" />
            </div>
            {source === 'classic' ? (
              <label className="field">
                <span>Game video <span className="muted">(optional; stays on this laptop)</span></span>
                <input type="file" accept="video/*" onChange={(e) => setVideo(e.target.files?.[0] ?? null)} />
              </label>
            ) : null}
          </div>
        </details>
      </div>

      <footer className="setup-foot muted">
        Open this on the laptop connected to the TV. Phones join by scanning the code. <a href="/lab/vision">Vision lab</a>
      </footer>
    </main>
  );
}

function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="switch-row" onClick={() => onChange(!on)}>
      <span className="sw-text"><b>{label}</b><span className="muted small">{hint}</span></span>
      <span className={`switch ${on ? 'on' : ''}`} aria-hidden><span /></span>
    </button>
  );
}
