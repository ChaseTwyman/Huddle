import type { PlayerPrompt } from '../../../../shared/types';

function Countdown({ closesAt, now, totalMs }: { closesAt: number; now: number; totalMs: number }) {
  const frac = Math.max(0, Math.min(1, (closesAt - now) / totalMs));
  return <div className="countdown" aria-hidden><div style={{ width: `${frac * 100}%` }} /></div>;
}

type Send = {
  answer: (promptId: string, optionId: string) => void;
  takeit: (promptId: string, accept: boolean) => void;
  handoff: (promptId: string, accept: boolean) => void;
  done: (promptId: string) => void;
  feedback: (promptId: string, value: 'got_it' | 'confused') => void;
};

const TOTAL: Record<PlayerPrompt['kind'], number> = { predict: 12000, callit: 15000, takeit: 4000, handoff: 6000, done: 20000, feedback: 8000 };

/** One prompt at a time, big stacked buttons (BUILD_PROMPT 11.4). */
export function PromptScreen({ prompt: p, now, send }: { prompt: PlayerPrompt; now: number; send: Send }) {
  const cd = <Countdown closesAt={p.closesAt} now={now} totalMs={TOTAL[p.kind]} />;
  switch (p.kind) {
    case 'predict':
    case 'callit':
      return (
        <div className="stack">
          {cd}
          <div className="step">{p.kind === 'callit' ? 'Flag! Call it' : 'Predict'}</div>
          <h2>{p.question}</h2>
          {p.options.map((o) => {
            const locked = p.lockedOptionId === o.id;
            return (
              <button key={o.id} className={`big-btn ${locked ? 'locked' : ''}`} disabled={!!p.lockedOptionId} onClick={() => send.answer(p.id, o.id)}>
                {p.kind === 'callit' ? <span className="letter">{o.id}</span> : null}{o.label}
              </button>
            );
          })}
          {p.lockedOptionId ? <div className="muted" style={{ textAlign: 'center' }}>Locked in. Eyes on the TV.</div> : null}
        </div>
      );
    case 'takeit':
      return (
        <div className="stack">
          {cd}
          <div className="step">You know this one</div>
          <h2>Take it? Explain “{p.title}” to the room.</h2>
          <div className="cheat"><span className="label">CHEAT LINE</span>{p.cheat}</div>
          <button className="big-btn good" onClick={() => send.takeit(p.id, true)}>Take it</button>
          <button className="big-btn ghost" onClick={() => send.takeit(p.id, false)}>Not now</button>
        </div>
      );
    case 'handoff':
      return (
        <div className="stack">
          {cd}
          <div className="step">Your turn to teach</div>
          <h2>You know this one. Explain {p.title} to {p.others}?</h2>
          <div className="cheat"><span className="label">CHEAT LINE</span>{p.cheat}</div>
          <button className="big-btn good" onClick={() => send.handoff(p.id, true)}>I'll explain</button>
          <button className="big-btn ghost" onClick={() => send.handoff(p.id, false)}>Pass</button>
        </div>
      );
    case 'done':
      return (
        <div className="stack">
          <div className="step">You're explaining · {p.title}</div>
          <div className="cheat" style={{ fontSize: 28 }}><span className="label">SAY SOMETHING LIKE</span>{p.cheat}</div>
          <button className="big-btn primary" onClick={() => send.done(p.id)}>Done</button>
          {cd}
        </div>
      );
    case 'feedback':
      return (
        <div className="stack">
          {cd}
          <div className="step">{p.by} explained {p.title}</div>
          <h2>Did that make sense?</h2>
          <button className="big-btn good" onClick={() => send.feedback(p.id, 'got_it')}>Got it</button>
          <button className="big-btn" style={{ justifyContent: 'center' }} onClick={() => send.feedback(p.id, 'confused')}>Still confused</button>
        </div>
      );
  }
}
