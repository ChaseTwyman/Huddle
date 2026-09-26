import type { League, TeamInfo } from '../../shared/types';
import type { LLM } from '../ai/llm';
import type { EspnSummary } from '../live/espn';
import { buildLiveKb, loadKb, makeRetriever } from './kb';
import { makeSituation } from './situation';
import type { IntelProvider, KnowledgeBase, Retriever } from './types';

/**
 * Game intelligence for one room: situational numbers from the play data, plus a knowledge base of sourced
 * player/team facts. Classic games load a prebuilt KB (data/kb/<gameId>.json); ESPN games build one in the
 * background when the room is created, and retrieval returns nothing until it is ready.
 */
export function makeIntel(opts: {
  gameId: string;
  teams?: Record<string, TeamInfo>;
  espn?: { summary: EspnSummary; league: League };
  llm: LLM;
}): IntelProvider {
  let retriever: Retriever = makeRetriever(opts.espn ? null : loadKb(opts.gameId));
  if (opts.espn) {
    void buildLiveKb(opts.espn.summary, opts.espn.league, opts.llm)
      .then((kb: KnowledgeBase) => {
        retriever = makeRetriever(kb);
        console.log(`[intel] knowledge base ready for ${opts.gameId}: ${kb.facts.length} facts`);
      })
      .catch((e: Error) => console.warn(`[intel] knowledge base failed for ${opts.gameId}: ${e.message}`));
  }
  return {
    situation: makeSituation(opts.teams),
    retrieve: (q) => retriever(q),
  };
}
