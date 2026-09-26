import { useState } from 'react';
import type { PlayerView } from '../../../../shared/types';

export function PhoneRecap({ recap }: { recap: NonNullable<PlayerView['recap']> }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const me = recap.me;
  const fam = recap.family;
  const copy = () => {
    // Called directly inside the click handler so the browser allows clipboard access.
    const p = navigator.clipboard?.writeText(fam.groupChatText);
    if (!p) { setCopied('failed'); return; }
    p.then(() => setCopied('yes')).catch(() => setCopied('failed'));
  };
  return (
    <div className="stack">
      <div className="step">Final · {fam.finalScore}</div>
      {me ? (
        <div className="card-sm" style={{ borderTop: `6px solid ${me.color}` }}>
          <div className="title">#{me.rank} · {me.headline}</div>
          <div className="muted" style={{ fontSize: 15, margin: '6px 0', fontVariantNumeric: 'tabular-nums' }}>
            {me.points} pts · Call It {me.callIt.correct}/{me.callIt.total} · Predict {me.predict.correct}/{me.predict.total}
          </div>
          <div>{me.bestMoment}</div>
          {me.role === 'learner' ? (
            <div style={{ marginTop: 8 }}>Rules you know: <b>{me.rulesKnown}</b>{me.learnedTonight.length ? <><br />New tonight: {me.learnedTonight.join(', ')}</> : null}</div>
          ) : null}
        </div>
      ) : null}
      <div className="card-sm">
        <div className="title">{fam.title}</div>
        <div style={{ marginTop: 6 }}>{fam.momentOfTheNight}</div>
        <div className="muted" style={{ marginTop: 6 }}>{fam.nextTime}</div>
      </div>
      <button className="big-btn primary" onClick={copy}>{copied === 'yes' ? 'Copied!' : 'Copy for group chat'}</button>
      {copied === 'failed' ? (
        <>
          <div className="muted">Copy didn't work here. Select the text and copy it:</div>
          <textarea className="copy-area" readOnly value={fam.groupChatText} onFocus={(e) => e.currentTarget.select()} />
        </>
      ) : null}
    </div>
  );
}
