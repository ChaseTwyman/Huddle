export const PACING = {
  // Tuned so a condensed Super Bowl LVII lasts 20–30 minutes (npm run simulate prints the estimate).
  gameNight: { preSnapMs: 7000, playMs: 4000, postPlayMs: 5500, announceMs: 4000, summaryMs: 4000, halftimeMs: 15000 },
  demo: { preSnapMs: 2500, playMs: 2500, postPlayMs: 2500, announceMs: 2500, summaryMs: 2000, halftimeMs: 5000 },
};
export type PacingValues = (typeof PACING)['gameNight'];

export const WINDOWS = { predictMs: 12000, callItMs: 15000, takeItMs: 4000, handoffMs: 6000, humanExplainMaxMs: 20000, feedbackMs: 8000 };

export const BUDGET = {
  normalPerQuarter: 6,
  normalGapMs: 20000,
  chattyGapMs: 12000,
  chattyPlaysPerLine: 2,
};

export const POINTS = {
  predictCorrect: 100,
  predictContrarian: 50,
  callItCorrect: 150,
  callItFirst: 25,
  explain: 100,
};

/** Estimated TTS speaking rate used when timing lines without a browser. */
export const WORDS_PER_SECOND = 2.6;

export const PLAYER_COLORS = ['#FF6B6B', '#F5C518', '#3DDC84', '#3D8BFF', '#C77DFF', '#FF9F43'];

export const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;
