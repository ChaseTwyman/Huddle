import type { TimelinePlay } from '../../shared/types';
import type { LLM } from '../ai/llm';
import { TICKER_SYSTEM } from '../ai/prompts';
import { TickerOut, words } from '../ai/schemas';
import { concepts } from '../data/concepts';
import { teamOf } from '../../shared/teams';
import type { TeamInfo } from '../../shared/types';

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
  // College feeds: unparenthesized formation ("No Huddle-Shotgun") and jersey numbers ("#11 F.Brandon").
  s = s.replace(/^(?:No Huddle-?)?(?:Shotgun|Pistol|Under Center|Wildcat)\s+/i, '').replace(/^No Huddle\s+/i, '');
  s = s.replace(/#\d{1,2}\s+(?=[A-Z])/g, '');
  // "to the TENN24" -> "to the TENN 24"
  s = s.replace(/\b(the|at|to) ([A-Z][A-Za-z]{1,9})(\d{1,2})\b/g, '$1 $2 $3');
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

// ---------- F11 plain-English ticker (P1) ----------


/** Every penalty name and id Huddle knows, lowercased: a rewrite containing one is rejected. */
function penaltyWords(extra: string[] = []): string[] {
  const out = new Set<string>(extra.map((s) => s.toLowerCase()));
  for (const c of concepts().values()) if (c.category === 'penalty' && c.priority >= 90) { out.add(c.name.toLowerCase()); out.add(c.id.replace(/_/g, ' ')); }
  out.add('holding');
  out.add('interference');
  return [...out];
}

/**
 * Rewrite the spoiler-safe play text as one plain sentence. The input is `publicDesc` (penalty clause already
 * removed), so the model never sees the penalty; the output is still checked and falls back to the cleaned text.
 */
export async function plainTicker(llm: LLM, play: TimelinePlay, home: string, away: string, teams?: Record<string, TeamInfo>): Promise<string> {
  const text = play.publicDesc;
  if (!text || play.kind === 'timeout' || play.kind === 'end_of_period' || text === 'Flag on the play.') return text;
  const res = await llm.json({
    task: 'ticker', model: 'fast', system: TICKER_SYSTEM,
    user: JSON.stringify({ text, teams: { [home]: teamOf(home, teams).city, [away]: teamOf(away, teams).city } }),
    schema: TickerOut, timeoutMs: 3000, temperature: 0.2,
    fallback: () => ({ text }),
  });
  const out = res.value.text.trim();
  if (!out || words(out) > 26) return text;
  const lower = out.toLowerCase();
  if (penaltyWords(play.penalty ? [play.penalty.rawType] : []).some((w) => lower.includes(w))) return text;
  if (/flag on the play/i.test(text) && !/flag/i.test(out)) return `${out.replace(/\.?$/, '.')} Flag on the play.`;
  return out;
}
