import type { TeamInfo } from '../../../shared/types';

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/**
 * The team color to draw on Huddle's dark UI: the primary, unless it is nearly black (navy Ole Miss,
 * Raiders silver-and-black), in which case the secondary when that is brighter.
 */
export function teamColor(t: TeamInfo): string {
  if (luminance(t.primary) >= 0.03) return t.primary;
  return luminance(t.secondary) > luminance(t.primary) ? t.secondary : t.primary;
}
