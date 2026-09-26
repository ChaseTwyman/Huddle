import type { RoomSnapshot, TeamInfo } from '../../../../shared/types';

function Team({ t, score, hasBall, timeouts }: { t: TeamInfo; score: number; hasBall: boolean; timeouts: number | null }) {
  return (
    <div className="sb-team">
      <span className="chip" style={{ background: t.primary }} />
      <span className="abbr">{t.abbr}</span>
      {hasBall ? <span className="ball" aria-label="has the ball" /> : null}
      <span className="score">{score}</span>
      {timeouts !== null ? (
        <span className="pips" aria-label={`${timeouts} timeouts left`}>
          {[0, 1, 2].map((i) => <span key={i} className={`pip ${i < timeouts ? '' : 'used'}`} />)}
        </span>
      ) : null}
    </div>
  );
}

const qtrLabel = (q: number) => (q <= 4 ? `Q${q}` : 'OT');

export function Scorebug({ snap }: { snap: RoomSnapshot }) {
  const sb = snap.scorebug;
  const { home, away } = snap.game;
  return (
    <div className="scorebug">
      <Team t={away} score={sb?.away ?? 0} hasBall={sb?.possession === 'away'} timeouts={sb?.timeouts ? sb.timeouts.away : null} />
      <Team t={home} score={sb?.home ?? 0} hasBall={sb?.possession === 'home'} timeouts={sb?.timeouts ? sb.timeouts.home : null} />
      <div className="sb-mid">
        <span className="qtr">{sb ? qtrLabel(sb.qtr) : snap.game.title}</span>
        {sb ? <span className="clock">{sb.clock}</span> : null}
      </div>
      {sb?.downDistance ? <span className="pill dd">{sb.downDistance}</span> : null}
      {sb?.ballOn ? <span className="pill">{sb.ballOn}</span> : null}
      <div className="sb-status">
        {snap.presetLabel ? <span className="preset-label">{snap.presetLabel}</span> : null}
        {sb?.flag ? <span className="pill flag">FLAG</span> : null}
        {sb?.review ? <span className="pill review">REVIEW</span> : null}
      </div>
    </div>
  );
}
