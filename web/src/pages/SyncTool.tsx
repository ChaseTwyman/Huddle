import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import '../styles/setup.css';
import { getVideoFile } from '../lib/videoStore';

type SyncPlay = { idx: number; qtr: number; clock: string; posteam: string | null; situation: string; text: string };

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;

/**
 * F12 sync tool: play the game video and press Space at every snap. Each press records the video time for the
 * selected play and moves to the next one. Save writes data/games/<id>/video_sync.json.
 */
export function SyncTool() {
  const { gameId = '' } = useParams();
  const [plays, setPlays] = useState<SyncPlay[]>([]);
  const [snaps, setSnaps] = useState<Record<string, number>>({});
  const [sel, setSel] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/games/${gameId}/sync-plays`).then((r) => r.json()).then(setPlays).catch(() => setMsg('Could not load plays'));
    fetch(`/api/games/${gameId}/video-sync`).then((r) => r.json()).then((j) => setSnaps(j.snaps ?? {})).catch(() => undefined);
    const f = getVideoFile();
    if (f) setUrl(URL.createObjectURL(f));
  }, [gameId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.key !== 'Backspace' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      e.preventDefault();
      const play = plays[sel];
      if (!play) return;
      if (e.key === ' ') {
        const t = video.current?.currentTime ?? 0;
        setSnaps((s) => ({ ...s, [String(play.idx)]: Math.round(t * 10) / 10 }));
        setSel((i) => Math.min(plays.length - 1, i + 1));
      } else if (e.key === 'Backspace') {
        setSnaps((s) => { const n = { ...s }; delete n[String(play.idx)]; return n; });
      } else if (e.key === 'ArrowDown') setSel((i) => Math.min(plays.length - 1, i + 1));
      else setSel((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [plays, sel]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'center' });
  }, [sel]);

  const save = async () => {
    const res = await fetch(`/api/games/${gameId}/video-sync`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameId, snaps }) });
    const j = await res.json();
    setMsg(res.ok ? `Saved ${j.count} snaps.` : j.error);
  };

  return (
    <main className="setup" style={{ placeItems: 'stretch' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)', gap: 16, height: 'calc(100vh - 64px)' }}>
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 12, minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 32 }}>Sync tool · {gameId}</h2>
            <label className="btn">Choose video<input type="file" accept="video/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) setUrl(URL.createObjectURL(f)); }} /></label>
            <button className="btn primary" onClick={save}>Save</button>
            {msg ? <span className="muted">{msg}</span> : null}
          </div>
          {url ? <video ref={video} src={url} controls style={{ width: '100%', maxHeight: '100%', background: '#000', borderRadius: 12 }} /> : <div className="muted">Choose the game video (it stays on this computer).</div>}
          <div className="muted" style={{ fontSize: 14 }}>Space = mark the selected play's snap at the current video time, then select the next play · Backspace = clear · ↑/↓ = select. {Object.keys(snaps).length} of {plays.length} plays synced.</div>
        </div>
        <div ref={listRef} style={{ overflow: 'auto', background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--line)' }}>
          {plays.map((p, i) => (
            <button key={p.idx} data-i={i} onClick={() => setSel(i)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', borderBottom: '1px solid var(--line)', background: i === sel ? 'var(--surface-2)' : 'transparent', outline: i === sel ? '2px solid var(--flag)' : 'none' }}>
              <div className="mono" style={{ fontSize: 12, color: snaps[String(p.idx)] !== undefined ? 'var(--good)' : 'var(--muted)' }}>
                #{p.idx} · Q{p.qtr} {p.clock} · {p.posteam ?? ''} {p.situation}{snaps[String(p.idx)] !== undefined ? ` · snap ${fmt(snaps[String(p.idx)])}` : ''}
              </div>
              <div style={{ fontSize: 14 }}>{p.text}</div>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
