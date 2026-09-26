import { useState } from 'react';
import '../styles/setup.css';
import { loadImage, toJpegDataUrl } from '../lib/image';

type Result = { value: Record<string, unknown>; source: string; ms: number; chip: string; provider: string };

/** F13 vision lab: upload any broadcast screenshot and see what Llama 4 Scout reads from the scorebug. */
export function VisionLab() {
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const img = await loadImage(file);
      const dataUrl = toJpegDataUrl(img);
      setPreview(dataUrl);
      const res = await fetch('/api/vision/scorebug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'Request failed');
      setResult(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="setup">
      <div className="setup-card" style={{ width: 'min(1100px, 100%)' }}>
        <div>
          <h1>Vision <span>lab</span></h1>
          <p className="tagline">Upload a frame from a broadcast. Huddle asks Llama 4 Scout to read the scorebug: down, distance, clock, score, FLAG.</p>
        </div>
        <label className="btn primary" style={{ minHeight: 64, fontSize: 20 }}>
          {busy ? 'Reading…' : 'Choose a screenshot'}
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        {error ? <div className="error" role="alert">{error}</div> : null}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, alignItems: 'start' }}>
          {preview ? <img src={preview} alt="Uploaded frame (downscaled to 768 px)" style={{ width: '100%', borderRadius: 12, border: '1px solid var(--line)' }} /> : null}
          {result ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="pill" style={{ fontFamily: 'var(--display)', fontSize: 24, background: 'var(--surface-2)', padding: '8px 16px', borderRadius: 999, width: 'fit-content' }}>Huddle sees: {result.chip}</div>
              <div className="mono muted" style={{ fontSize: 14 }}>{result.provider} · {result.source} · {result.ms} ms{result.source === 'fallback' ? ' (no model configured, or the model failed: set LLM_PROVIDER and LLM_API_KEY in .env)' : ''}</div>
              <pre className="mono" style={{ background: 'var(--surface-2)', padding: 16, borderRadius: 12, overflow: 'auto', fontSize: 14, margin: 0 }}>{JSON.stringify(result.value, null, 2)}</pre>
            </div>
          ) : null}
        </div>
        <div className="foot"><a href="/">Back to Huddle</a></div>
      </div>
    </main>
  );
}
