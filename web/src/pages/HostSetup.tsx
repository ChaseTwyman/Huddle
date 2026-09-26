import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../styles/setup.css';
import type { GameIndexEntry, Mode, Pacing, Talkativeness } from '../../../shared/types';
import { storage } from '../lib/socket';
import { setVideoFile } from '../lib/videoStore';

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button type="button" key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

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
  const [video, setVideo] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/games').then((r) => r.json()).then((g: GameIndexEntry[]) => {
      setGames(g);
      if (g[0]) setGameId(g[0].id);
    }).catch(() => setError('Could not reach the Huddle server. Is npm run dev running?'));
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      storage.set('huddle:family', familyName);
      const res = await fetch('/api/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ familyName: familyName || null, gameId, mode, pacing, talkativeness: talk, voice, fanHandicap }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'Could not create room');
      storage.session.set(`huddle:host:${j.code}`, j.hostToken);
      setVideoFile(video);
      nav(`/tv/${j.code}?host=${j.hostToken}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="setup">
      <div className="setup-card">
        <div>
          <h1>Hud<span>dle</span></h1>
          <p className="tagline">A game-night co-host for the whole family.</p>
        </div>
        <div className="field-row">
          <label htmlFor="family">Family name (optional, remembers what everyone learns)</label>
          <input id="family" value={familyName} onChange={(e) => setFamilyName(e.target.value)} placeholder="e.g. Rivera" maxLength={40} />
        </div>
        <div className="field-row">
          <label htmlFor="game">Game</label>
          <select id="game" value={gameId} onChange={(e) => setGameId(e.target.value)}>
            {games.map((g) => <option key={g.id} value={g.id}>{g.title} · {g.away} {g.finalScore.away}, {g.home} {g.finalScore.home}</option>)}
          </select>
        </div>
        <div className="field-row">
          <label>Mode</label>
          <Seg value={mode} onChange={setMode} options={[['condensed', 'Condensed (~25 min)'], ['full', 'Full game'], ['demo', 'Demo moments']]} />
        </div>
        <div className="field-row">
          <label>Pacing</label>
          <Seg value={pacing} onChange={setPacing} options={[['gameNight', 'Game night'], ['demo', 'Demo']]} />
        </div>
        <div className="field-row">
          <label>How much Huddle talks</label>
          <Seg value={talk} onChange={setTalk} options={[['quiet', 'Quiet'], ['normal', 'Normal'], ['chatty', 'Chatty']]} />
        </div>
        <div className="field-row">
          <label htmlFor="video">Game video (optional, video mode): stays on this laptop, never uploaded</label>
          <input id="video" type="file" accept="video/*" onChange={(e) => setVideo(e.target.files?.[0] ?? null)} style={{ paddingTop: 12 }} />
        </div>
        <div className="toggles">
          <label><input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Voice on</label>
          <label><input type="checkbox" checked={fanHandicap} onChange={(e) => setFanHandicap(e.target.checked)} /> Fan handicap (fan scores half)</label>
        </div>
        {error ? <div className="error" role="alert">{error}</div> : null}
        <button className="btn primary" disabled={!gameId || busy} onClick={create} style={{ minHeight: 64, fontSize: 22 }}>{busy ? 'Creating…' : 'Create room'}</button>
        <div className="foot">Open this on the laptop connected to the TV. Phones join by scanning the code. <a href="/lab/vision">Vision lab</a></div>
      </div>
    </main>
  );
}
