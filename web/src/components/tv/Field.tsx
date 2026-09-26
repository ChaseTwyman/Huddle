import { useEffect, useRef, useState } from 'react';
import { teamColor } from '../../lib/color';
import type { RoomSnapshot, TeamInfo } from '../../../../shared/types';

const W = 1200;
const H = 560;
const x = (abs: number) => 100 + abs * 10;
const NUMS = [10, 20, 30, 40, 50, 40, 30, 20, 10];

function hexA(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function EndZone({ side, team }: { side: 'left' | 'right'; team: TeamInfo }) {
  const x0 = side === 'left' ? 0 : 1100;
  return (
    <g>
      <rect x={x0} y={0} width={100} height={H} fill={hexA(teamColor(team), 0.35)} />
      <text x={x0 + 50} y={H / 2} fill="rgba(242,245,239,0.85)" fontFamily="Inter, system-ui, sans-serif" fontWeight={700}
        fontSize={64} textAnchor="middle" dominantBaseline="middle" transform={`rotate(${side === 'left' ? -90 : 90} ${x0 + 50} ${H / 2})`} letterSpacing={8}>
        {team.abbr}
      </text>
    </g>
  );
}

/**
 * Field view (BUILD_PROMPT 11.3): 10 px per yard, home end zone on the left (home attacks right),
 * blue line of scrimmage, glowing yellow first-down line, animated ball, possession arrow.
 */
export function Field({ snap, children }: { snap: RoomSnapshot; children?: React.ReactNode }) {
  const f = snap.field;
  const { home, away } = snap.game;
  const [ylSeen, setYlSeen] = useState(false);
  const [showYlLabel, setShowYlLabel] = useState(false);
  const labelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (f?.firstDownAbs != null && !ylSeen) {
      setYlSeen(true);
      setShowYlLabel(true);
      labelTimer.current = setTimeout(() => setShowYlLabel(false), 12000);
    }
  }, [f?.firstDownAbs, ylSeen]);
  useEffect(() => () => { if (labelTimer.current) clearTimeout(labelTimer.current); }, []);

  const ballAbs = f?.ballAbs ?? f?.losAbs ?? 50;
  const possTeam = f?.possession === 'home' ? home : f?.possession === 'away' ? away : null;
  const dir = f?.possession === 'away' ? -1 : 1;

  return (
    <div className="field-wrap">
      <svg className="field-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Football field">
        <defs>
          <pattern id="stripes" width="100" height={H} patternUnits="userSpaceOnUse">
            <rect width="50" height={H} fill="var(--turf)" />
            <rect x="50" width="50" height={H} fill="var(--turf-stripe)" />
          </pattern>
        </defs>
        <rect x={100} y={0} width={1000} height={H} fill="url(#stripes)" />
        <EndZone side="left" team={home} />
        <EndZone side="right" team={away} />
        {/* yard lines every 5 */}
        {Array.from({ length: 21 }, (_, i) => i * 5).map((yd) => (
          <line key={yd} x1={x(yd)} x2={x(yd)} y1={0} y2={H} stroke="rgba(242,245,239,0.55)" strokeWidth={yd % 10 === 0 ? 3 : 1.5} />
        ))}
        {/* hash marks */}
        {Array.from({ length: 99 }, (_, i) => i + 1).filter((yd) => yd % 5 !== 0).map((yd) => (
          <g key={yd} stroke="rgba(242,245,239,0.45)" strokeWidth={1.5}>
            <line x1={x(yd)} x2={x(yd)} y1={4} y2={16} />
            <line x1={x(yd)} x2={x(yd)} y1={H * 0.38} y2={H * 0.38 + 10} />
            <line x1={x(yd)} x2={x(yd)} y1={H * 0.62 - 10} y2={H * 0.62} />
            <line x1={x(yd)} x2={x(yd)} y1={H - 16} y2={H - 4} />
          </g>
        ))}
        {/* numbers */}
        {NUMS.map((n, i) => {
          const px = x((i + 1) * 10);
          return (
            <g key={i} fill="rgba(242,245,239,0.7)" fontFamily="Inter, system-ui, sans-serif" fontWeight={700} fontSize={40} textAnchor="middle">
              <text x={px} y={70}>{n}</text>
              <text x={px} y={H - 45} transform={`rotate(180 ${px} ${H - 58})`}>{n}</text>
            </g>
          );
        })}
        {f?.losAbs != null ? <line x1={x(f.losAbs)} x2={x(f.losAbs)} y1={0} y2={H} stroke="var(--los)" strokeWidth={3} /> : null}
        {f?.firstDownAbs != null ? (
          <g>
            <line className="fd-line" x1={x(f.firstDownAbs)} x2={x(f.firstDownAbs)} y1={0} y2={H} stroke="var(--flag)" strokeWidth={4} />
            {showYlLabel ? (
              <g transform={`translate(${x(f.firstDownAbs) + (f.firstDownAbs > 80 ? -12 : 12)} ${H - 110})`}>
                <rect x={f.firstDownAbs > 80 ? -250 : 0} y={-26} width={250} height={40} rx={8} fill="rgba(11,18,14,0.9)" stroke="var(--flag)" />
                <text className="yl-label" x={f.firstDownAbs > 80 ? -125 : 125} y={0} fill="var(--flag)" fontSize={22} textAnchor="middle">yellow line = first down</text>
              </g>
            ) : null}
          </g>
        ) : null}
        {/* ball + possession arrow */}
        <g className="ball-g" style={{ transform: `translateX(${x(ballAbs)}px)`, transitionDuration: `${f?.animateMs ?? 0}ms` }}>
          {possTeam ? (
            <polygon points={dir === 1 ? '28,-12 52,0 28,12' : '-28,-12 -52,0 -28,12'} transform={`translate(0 ${H / 2})`} fill={teamColor(possTeam)} stroke="var(--chalk)" strokeWidth={2} />
          ) : null}
          <g transform={`translate(0 ${H / 2})`}>
            <ellipse rx={20} ry={12} fill="#8B4A2B" stroke="#5A2F1B" strokeWidth={2} />
            <line x1={-8} x2={8} y1={0} y2={0} stroke="#F2F5EF" strokeWidth={2} />
            {[-5, 0, 5].map((d) => <line key={d} x1={d} x2={d} y1={-3} y2={3} stroke="#F2F5EF" strokeWidth={1.5} />)}
          </g>
        </g>
      </svg>
      {children}
    </div>
  );
}
