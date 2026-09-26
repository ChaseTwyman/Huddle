import type { LLM } from './llm';
import { SCOREBUG_SYSTEM } from './prompts';
import { ScorebugOut } from './schemas';

export const EMPTY_SCOREBUG: ScorebugOut = {
  visible: false, awayTeam: null, homeTeam: null, awayScore: null, homeScore: null,
  quarter: null, clock: null, down: null, distance: null, flag: false, replayReview: false, confidence: 0,
};

export const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
export const MAX_IMAGE_CHARS = 3_000_000;

/**
 * F13: read the broadcast scorebug from one frame with Llama 4 Scout (vision). 2 s limit; on any failure the
 * result is "not visible" with confidence 0, so callers fall back to play data.
 */
export async function readScorebug(llm: LLM, image: string, hint?: string) {
  if (!IMAGE_DATA_URL.test(image) || image.length > MAX_IMAGE_CHARS) throw new Error('image must be a JPEG, PNG or WebP data URL under 3 MB');
  return llm.json({
    task: 'scorebug', model: 'vision', system: SCOREBUG_SYSTEM,
    user: hint ? `Read the scorebug in this frame. ${hint}` : 'Read the scorebug in this frame.',
    images: [image], schema: ScorebugOut, timeoutMs: 2000, temperature: 0,
    fallback: () => EMPTY_SCOREBUG,
  });
}

/** One-line summary for the host dock, e.g. "3rd & 8 · 1:54 Q4 · FLAG". */
export function scorebugChip(s: ScorebugOut): string {
  if (!s.visible) return 'no scorebug visible';
  const parts: string[] = [];
  if (s.down != null && s.distance != null) {
    const d = Number(s.down);
    const ord = d === 1 ? '1st' : d === 2 ? '2nd' : d === 3 ? '3rd' : d === 4 ? '4th' : String(s.down);
    parts.push(`${ord} & ${s.distance}`);
  }
  if (s.clock) parts.push(`${s.clock}${s.quarter != null ? ` Q${s.quarter}` : ''}`);
  if (s.awayTeam && s.homeTeam) parts.push(`${s.awayTeam} ${s.awayScore ?? '?'}–${s.homeTeam} ${s.homeScore ?? '?'}`);
  if (s.flag) parts.push('FLAG');
  if (s.replayReview) parts.push('REVIEW');
  return parts.join(' · ') || 'scorebug visible';
}
