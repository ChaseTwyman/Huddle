import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import '../styles/phone.css';
import { FlagDetector, yellowRatio } from '../../../shared/flagDetect';
import { connect, storage, type HuddleSocket } from '../lib/socket';
import { toJpegDataUrl } from '../lib/image';

type Roi = { x: number; y: number; w: number; h: number }; // normalized 0..1 on the video frame
const ROI_KEY = 'huddle:cam:roi';

/**
 * F14 camera flag spotter (/cam/:code?host=TOKEN): point a phone or webcam at the TV, drag a box around the
 * broadcast scorebug, and this page watches for the yellow FLAG box. When it appears it tells the room, which opens
 * Call It on everyone's phone right away, before the play-by-play feed knows which penalty it was.
 */
export function Camera() {
  const { code = '' } = useParams();
  const [params] = useSearchParams();
  const upper = code.toUpperCase();
  const hostToken = useMemo(() => params.get('host') ?? storage.session.get(`huddle:host:${upper}`), [params, upper]);
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const sock = useRef<HuddleSocket | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [roi, setRoi] = useState<Roi | null>(() => { try { return JSON.parse(storage.get(ROI_KEY) ?? 'null'); } catch { return null; } });
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [meter, setMeter] = useState({ ratio: 0, threshold: 0.04 });
  const [events, setEvents] = useState<string[]>([]);
  const [confirmWithAi, setConfirmWithAi] = useState(true);
  const secure = typeof window !== 'undefined' && window.isSecureContext;

  const log = (s: string) => setEvents((e) => [`${new Date().toLocaleTimeString()} · ${s}`, ...e].slice(0, 8));

  // Join the room as the camera (host token required).
  useEffect(() => {
    const s = connect();
    sock.current = s;
    s.on('connect', () => {
      s.emit('tv:join', { code: upper, hostToken: hostToken ?? undefined, role: 'camera' }, (r) => setJoined(r.ok ? null : r.error ?? 'Could not join'));
    });
    return () => { s.disconnect(); };
  }, [upper, hostToken]);

  // Start the rear camera and keep the screen awake.
  useEffect(() => {
    if (!secure) return;
    let stream: MediaStream | null = null;
    let lock: { release(): Promise<void> } | null = null;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false })
      .then((st) => { stream = st; if (video.current) { video.current.srcObject = st; void video.current.play(); } })
      .catch((e) => setCamError((e as Error).message));
    (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => undefined);
    return () => { stream?.getTracks().forEach((t) => t.stop()); void lock?.release(); };
  }, [secure]);

  const sendFlag = (why: string) => {
    sock.current?.emit('host:control', { action: 'flag_seen' });
    log(`FLAG sent (${why})`);
    try { navigator.vibrate?.(60); } catch { /* ignore */ }
  };

  // Detection loop.
  useEffect(() => {
    if (!roi) return;
    const det = new FlagDetector();
    const canvas = document.createElement('canvas');
    let busy = false;
    const t = setInterval(async () => {
      const v = video.current;
      if (!v || !v.videoWidth || busy) return;
      const sx = roi.x * v.videoWidth, sy = roi.y * v.videoHeight, sw = roi.w * v.videoWidth, sh = roi.h * v.videoHeight;
      const W = 160;
      canvas.width = W;
      canvas.height = Math.max(8, Math.round((W * sh) / sw));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const s = det.sample(yellowRatio(px, 2), Date.now());
      setMeter({ ratio: s.ratio, threshold: s.threshold });
      if (!s.fired) return;
      if (!confirmWithAi) { sendFlag('yellow box'); return; }
      // Optional double-check with the vision model (only counts if a model is configured).
      busy = true;
      try {
        const res = await fetch('/api/vision/scorebug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: toJpegDataUrl(canvas, 768), hint: 'This is a crop of the scorebug.' }) });
        const j = await res.json();
        if (res.ok && j.source === 'llm' && j.value?.flag === false) log('Yellow seen, but the AI says no FLAG box: ignored');
        else sendFlag(res.ok && j.source === 'llm' ? 'AI confirmed' : 'yellow box');
      } catch {
        sendFlag('yellow box');
      } finally {
        busy = false;
      }
    }, 400);
    return () => clearInterval(t);
  }, [roi, confirmWithAi]);

  // Drag a box over the scorebug.
  const rel = (e: React.PointerEvent) => {
    const r = overlay.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: React.PointerEvent) => { const p = rel(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); (e.target as Element).setPointerCapture?.(e.pointerId); };
  const onMove = (e: React.PointerEvent) => { if (drag) { const p = rel(e); setDrag({ ...drag, x1: p.x, y1: p.y }); } };
  const onUp = () => {
    if (!drag) return;
    const r = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
    setDrag(null);
    if (r.w < 0.03 || r.h < 0.02) return;
    setRoi(r);
    storage.set(ROI_KEY, JSON.stringify(r));
    log('Scorebug box set');
  };
  const box = drag ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : roi;

  return (
    <main className="phone" style={{ maxWidth: 900 }}>
      <div className="step">Room {upper} · flag camera</div>
      <h2>Point this at the TV</h2>
      {joined ? <div style={{ color: 'var(--bad)' }} role="alert">{joined}</div> : null}
      {!secure ? (
        <div className="card-sm" role="alert">
          <div className="title">The camera needs a secure page</div>
          Browsers only allow the camera on https or on the laptop itself. Either open this page on the laptop with a webcam
          pointed at the TV, or restart Huddle with <code>npm run dev:https</code> and scan the camera QR again (accept the
          certificate warning once).
        </div>
      ) : null}
      {camError ? <div style={{ color: 'var(--bad)' }}>Camera: {camError}</div> : null}
      <div ref={overlay} style={{ position: 'relative', touchAction: 'none', borderRadius: 12, overflow: 'hidden', background: '#000' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <video ref={video} playsInline muted style={{ width: '100%', display: 'block' }} />
        {box ? (
          <div style={{ position: 'absolute', left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`, border: '3px solid var(--flag)', boxShadow: '0 0 0 2000px rgba(0,0,0,0.35)', pointerEvents: 'none' }} />
        ) : null}
      </div>
      <div className="muted">{roi ? 'Watching the yellow box area. Drag again to move it.' : 'Drag a box around the score graphic (the scorebug) on the TV.'}</div>
      <div aria-label="yellow level" style={{ position: 'relative', height: 14, background: 'var(--line)', borderRadius: 7, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, meter.ratio * 250)}%`, height: '100%', background: meter.ratio > meter.threshold ? 'var(--flag)' : 'var(--muted)' }} />
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${Math.min(100, meter.threshold * 250)}%`, width: 2, background: 'var(--bad)' }} />
      </div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input type="checkbox" checked={confirmWithAi} onChange={(e) => setConfirmWithAi(e.target.checked)} style={{ width: 22, height: 22 }} />
        Double-check with the vision AI when a model is configured
      </label>
      <button className="big-btn" style={{ justifyContent: 'center' }} onClick={() => sendFlag('test button')}>Test: send a flag</button>
      <div className="card-sm" style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
        {events.length ? events.map((e) => <div key={e}>{e}</div>) : <span className="muted">No flags yet.</span>}
      </div>
    </main>
  );
}
