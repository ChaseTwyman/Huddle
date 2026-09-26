import type { TimelinePlay } from '../../shared/types';

/**
 * For reviewed plays, keep only the final ruling and note the review, so the ticker doesn't
 * show a touchdown that was taken away.
 */
export function effectiveDesc(desc: string): string {
  const rev = /The Replay Official reviewed [^.]*?, and the play was REVERSED\.\s*(.*)$/i.exec(desc);
  if (rev) return `${rev[1]} (Call reversed after replay review.)`;
  const up = /\s*(?:The Replay Official reviewed|[A-Za-z .]+ challenged) [^.]*?, and the play was Upheld\.(?: The ruling on the field stands\.)?/i.exec(desc);
  if (up) return `${desc.slice(0, up.index)}${desc.slice(up.index + up[0].length)} (Call upheld after review.)`;
  return desc;
}

/**
 * P0 ticker cleaning (BUILD_PROMPT 9.5): drop the leading "(m:ss)", formation tags, jersey numbers
 * and bracketed pressure notes, and replace everything from the penalty clause onward with
 * "Flag on the play." The output is spoiler-safe: it never names the penalty.
 */
export function cleanDesc(desc: string): string {
  let s = effectiveDesc(desc).trim();
  s = s.replace(/^\(\s*\d*:\d{2}\s*\)\s*/, '');
  // Formation / tempo tags such as (Shotgun), (No Huddle, Shotgun), (Run formation).
  for (let i = 0; i < 3; i++) s = s.replace(/^\((?:[^)]*(?:Shotgun|Huddle|formation|Pistol)[^)]*)\)\s*/i, '');
  const pen = s.search(/\bpenalty\b/i);
  let flagged = false;
  if (pen >= 0) {
    s = s.slice(0, pen).trim();
    flagged = true;
  }
  s = s.replace(/\[[^\]]*\]/g, '');
  s = s.replace(/\b\d{1,2}-(?=[A-Z])/g, '');
  s = s.replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1').trim();
  if (flagged) s = s ? `${s.replace(/[.,;]*$/, '.')} Flag on the play.` : 'Flag on the play.';
  return s;
}

/** What the ticker shows for a play at a given stage. */
export function tickerText(play: TimelinePlay, announced: boolean): string {
  if (announced && play.penalty) {
    const base = play.publicDesc.replace(/\s*Flag on the play\.$/, '').trim();
    return base ? `${base} ${play.penalty.announcement}` : play.penalty.announcement;
  }
  return play.publicDesc;
}
