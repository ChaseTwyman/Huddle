import type { AiLogEntry, HostAction, RoomSnapshot } from '../../../../shared/types';
import type { VisionChip } from './VideoPane';

type Props = {
  snap: RoomSnapshot;
  aiLog: AiLogEntry[];
  control: (a: HostAction, v?: unknown) => void;
  showJump: boolean;
  voiceName: string;
  hasVideo: boolean;
  onVideo: (f: File | null) => void;
  vision: VisionChip;
};

/** Host controls (toggle with H). Everything here also has a hotkey. */
export function HostDock({ snap, aiLog, control, showJump, voiceName, hasVideo, onVideo, vision }: Props) {
  const s = snap.settings;
  const d = snap.demo;
  const opt = <T extends string>(label: string, action: HostAction, current: T, values: [T, string][]) => (
    <div className="row"><span className="muted" style={{ width: 96 }}>{label}</span>
      {values.map(([v, text]) => <button key={v} className={current === v ? 'on' : ''} onClick={() => control(action, v)}>{text}</button>)}
    </div>
  );
  const preset = snap.presetLabel?.includes('Game 4') ? 'game4' : snap.presetLabel?.includes('Game 1') ? 'game1' : 'none';
  return (
    <aside className="dock" aria-label="Host controls">
      <h4>Host · room {snap.code}</h4>
      <div className="row">
        {snap.phase === 'lobby' || snap.phase === 'profiles' || snap.phase === 'storylines'
          ? <button className="on" onClick={() => control('advance')}>Advance <kbd>Enter</kbd></button> : null}
        <button onClick={() => control(d.paused ? 'play' : 'pause')}>{d.paused ? 'Play' : 'Pause'} <kbd>Space</kbd></button>
        <button onClick={() => control('next')}>Next <kbd>N</kbd></button>
        <button className={s.voice ? '' : 'on'} onClick={() => control('voice', !s.voice)}>{s.voice ? 'Mute' : 'Unmute'} <kbd>M</kbd></button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Play {d.idx + 1}/{d.total} · {d.mode} · {d.pacing} · voice: {voiceName}</div>
      {opt('Mode', 'mode', s.mode, [['condensed', 'Condensed'], ['full', 'Full'], ['demo', 'Demo']])}
      {opt('Pacing', 'pacing', s.pacing, [['gameNight', 'Game night'], ['demo', 'Demo']])}
      {opt('Talk', 'talkativeness', s.talkativeness, [['quiet', 'Quiet'], ['normal', 'Normal'], ['chatty', 'Chatty']])}
      <div className="row"><span className="muted" style={{ width: 96 }}>Preset</span>
        <button className={preset === 'none' ? 'on' : ''} onClick={() => control('preset', null)}>Off</button>
        <button className={preset === 'game1' ? 'on' : ''} onClick={() => control('preset', 'game1')}>Game 1</button>
        <button className={preset === 'game4' ? 'on' : ''} onClick={() => control('preset', 'game4')}>Game 4 <kbd>G</kbd></button>
      </div>
      <h4>Video mode</h4>
      <div className="row">
        <label style={{ display: 'inline-flex' }}><span className="btn" style={{ minHeight: 36, padding: '0 12px', fontSize: 14 }}>{hasVideo ? 'Change video' : 'Load game video'}</span>
          <input type="file" accept="video/*" style={{ display: 'none' }} onChange={(e) => onVideo(e.target.files?.[0] ?? null)} /></label>
        {hasVideo ? <button onClick={() => onVideo(null)}>Back to drawn field</button> : null}
        <a href={`/sync/${snap.game.id}`} target="_blank" rel="noreferrer" style={{ color: 'var(--muted)', fontSize: 13 }}>Sync tool</a>
      </div>
      {snap.video.enabled ? (
        <div className="muted" style={{ fontSize: 13 }}>
          {snap.video.synced} snaps synced{snap.video.synced === 0 ? ' (plays use normal pacing until you sync)' : ''}
          {vision ? <div style={{ marginTop: 6, color: vision.warning ? 'var(--flag)' : 'var(--chalk)' }}>Huddle sees: {vision.text}{vision.warning ? ` ⚠ ${vision.warning}` : ''} <span className="muted">({vision.source})</span></div> : null}
        </div>
      ) : null}
      <h4>Segments</h4>
      <div className="row">
        {d.segments.map((seg, i) => <button key={seg.id} onClick={() => control('jump', { segment: seg.id })} title={seg.label}><kbd>{i + 1}</kbd> {seg.label}</button>)}
      </div>
      <h4>Jump to moment <kbd>J</kbd></h4>
      <div className="jump" style={{ maxHeight: showJump ? 360 : 140 }}>
        {d.moments.map((m) => <button key={m.id} onClick={() => control('jump', { moment: m.id })}>{m.label}</button>)}
      </div>
      <h4>Players</h4>
      <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        {snap.players.map((p) => (
          <div key={p.id} className="row">
            <span style={{ color: p.color, flex: 1 }}>{p.name}{p.connected ? '' : ' (away)'}</span>
            <button onClick={() => control('set_role', { playerId: p.id, role: p.role === 'fan' ? 'learner' : 'fan' })}>{p.role === 'fan' ? 'Fan → learner' : 'Learner → fan'}</button>
            {p.role === 'learner' ? <button onClick={() => control('reroll_storyline', p.id)}>Reroll story</button> : null}
          </div>
        ))}
      </div>
      <h4>AI log</h4>
      <div className="log">
        {aiLog.length === 0 ? <span>No model calls yet.</span> : null}
        {[...aiLog].reverse().slice(0, 30).map((e, i) => (
          <span key={i} className={e.source}>{e.task} · {e.source} · {e.ms}ms{e.note ? ` · ${e.note}` : ''}</span>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12 }}><kbd>H</kbd> dock · <kbd>T</kbd> talkativeness · <kbd>1</kbd>–<kbd>9</kbd> segments</div>
    </aside>
  );
}
