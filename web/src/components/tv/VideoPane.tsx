import { useEffect, useRef, type ReactNode } from 'react';
import type { HostAction, RoomSnapshot } from '../../../../shared/types';
import { toJpegDataUrl } from '../../lib/image';

export type VisionChip = { text: string; warning: string | null; source: string } | null;

type Props = {
  url: string;
  snap: RoomSnapshot;
  now: number;
  isHost: boolean;
  control: (a: HostAction, v?: unknown) => void;
  onVision: (chip: VisionChip) => void;
  /** Huddle is talking: duck the broadcast audio under the voice. */
  speaking?: boolean;
  children?: ReactNode;
};

const ord = (d: number) => (d === 1 ? '1st' : d === 2 ? '2nd' : d === 3 ? '3rd' : `${d}th`);

/**
 * F12/F13 video mode: the local video replaces the drawn field. The host TV reports the video time so the engine
 * follows it, pauses the video while a Predict or Call It window is open (so the broadcast can't announce the call
 * first), captures the frame at each flag for the Call It model, and reads the scorebug every 2 s.
 */
export function VideoPane({ url, snap, now, isHost, control, onVision, speaking = false, children }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  // Duck: fade the broadcast to 20% while Huddle speaks, back to full after.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const target = speaking ? 0.2 : 1;
    const step = setInterval(() => {
      const d = target - v.volume;
      if (Math.abs(d) < 0.04) { v.volume = target; clearInterval(step); return; }
      v.volume = Math.min(1, Math.max(0, v.volume + Math.sign(d) * 0.08));
    }, 30);
    return () => clearInterval(step);
  }, [speaking]);
  const lastSeek = useRef<string | null>(null);
  const flagSent = useRef(false);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const windowOpen = !!snap.prompt && !snap.prompt.reveal && snap.prompt.closesAt > now;
  const holdForCall = !!snap.scorebug?.flag; // from the flag until the announcement
  const shouldPause = snap.demo.paused || windowOpen || holdForCall;

  // Report time.
  useEffect(() => {
    if (!isHost) return;
    const t = setInterval(() => {
      const v = ref.current;
      if (v && !v.paused) control('video_time', v.currentTime);
    }, 500);
    return () => clearInterval(t);
  }, [isHost, control]);

  // Pause for windows and host pause.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (shouldPause && !v.paused) v.pause();
    if (!shouldPause && v.paused && v.currentTime > 0) void v.play().catch(() => undefined);
  }, [shouldPause]);

  // Seek after host jumps.
  useEffect(() => {
    const seek = snap.video.seek;
    const v = ref.current;
    if (!seek || !v || seek.id === lastSeek.current) return;
    lastSeek.current = seek.id;
    v.currentTime = seek.t;
    if (isHost) control('video_time', seek.t);
  }, [snap.video.seek, isHost, control]);

  // Flag frame for the Call It distractor call.
  useEffect(() => {
    const flag = !!snap.scorebug?.flag;
    if (!flag) { flagSent.current = false; return; }
    if (flagSent.current || !isHost || !ref.current) return;
    flagSent.current = true;
    try { control('frame', { kind: 'flag', image: toJpegDataUrl(ref.current) }); } catch { /* video not ready */ }
  }, [snap.scorebug?.flag, isHost, control]);

  // Scorebug reader every 2 s while playing.
  useEffect(() => {
    if (!isHost) return;
    let busy = false;
    const t = setInterval(async () => {
      const v = ref.current;
      if (!v || v.paused || busy) return;
      busy = true;
      try {
        const res = await fetch('/api/vision/scorebug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: toJpegDataUrl(v) }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error);
        const seen = j.value as { visible: boolean; down: number | string | null; distance: number | string | null; flag: boolean };
        const sb = snapRef.current.scorebug;
        let warning: string | null = null;
        if (seen.visible && sb) {
          const dd = seen.down != null && seen.distance != null ? `${ord(Number(seen.down))} & ${seen.distance}` : null;
          if (dd && sb.downDistance && dd.replace(/\s/g, '').toLowerCase() !== sb.downDistance.replace(/\s/g, '').toLowerCase()) warning = `timeline says ${sb.downDistance}`;
          else if (seen.flag !== sb.flag) warning = seen.flag ? 'video shows a FLAG the timeline hasn\'t reached' : null;
        }
        onVision({ text: j.chip, warning, source: j.source });
      } catch {
        onVision({ text: 'scorebug reader unavailable', warning: null, source: 'error' });
      } finally {
        busy = false;
      }
    }, 2000);
    return () => clearInterval(t);
  }, [isHost, onVision]);

  return (
    <div className="field-wrap">
      <video ref={ref} src={url} controls={isHost} playsInline style={{ width: '100%', maxHeight: '100%', borderRadius: 'var(--radius-lg)', background: '#000' }} />
      {children}
    </div>
  );
}
