import fs from 'node:fs';
import { nanoid } from 'nanoid';
import type {
  EngineEvent, FamilyRecap, HostAction, KnowledgeMap, PlayerPrompt, PlayerView, ProfileAnswers, PromptOption,
  RoomPhase, RoomSnapshot, Settings, SnapshotCard, TimelinePlay, StorylinesFile,
} from '../../shared/types';
import { PACING, PLAYER_COLORS, WINDOWS, WORDS_PER_SECOND } from '../../shared/constants';
import { teamOf } from '../../shared/teams';
import type { Clock, TimerHandle } from './clock';
import { sleep } from './clock';
import type { Transport } from './transport';
import type { LLM } from '../ai/llm';
import { CALLIT_SYSTEM, CALLIT_VIDEO_NOTE } from '../ai/prompts';
import { loadVideoSync, type VideoSync } from '../data/videoSync';
import { CallItOut } from '../ai/schemas';
import { loadGame, type GameData } from '../data/loadGame';
import { concept } from '../data/concepts';
import { ballOn, downDistance, lastName } from '../data/timeline';
import { ReplayEngine } from '../engine/ReplayEngine';
import { buildPredict, resolvePredict } from '../game/predict';
import { buildCallIt, catalogFor, fallbackDistractors, type CallItRound } from '../game/callit';
import { explainPoints, rank, scoreCallIt, scorePredict } from '../game/scoring';
import { addExposure, addRecall, countKnown, handoffCandidates, learnedSince, levelOf, levelRank, markExplained, presetKnowledge, type Preset } from '../game/knowledge';
import { assignStorylines, unlockedFacts, writeBeat, type Assignment } from '../game/storylines';
import { involvement } from '../game/involvement';
import { buildRecap, type PersonStats } from '../game/recap';
import { plainTicker, tickerText } from '../game/ticker';
import { candidatesFor, Scheduler, triggerFor, type Trigger } from '../director/scheduler';
import { directorTurn, situation, templateTurn, type DirectorInput } from '../director/director';
import { sourceLine, type DirectorDecision, type InsightDecision } from '../director/templates';
import type { IntelFact, IntelProvider } from '../intel/types';
import type { FamilyStore, FamilyFile } from '../persistence/families';
import type { TtsService } from '../ai/tts';
import type { LiveGame } from '../live/feed';
import { dataPath } from '../paths';

class Aborted extends Error {
  constructor() { super('aborted'); }
}

export type Player = {
  id: string; name: string; color: string; role: 'fan' | 'learner'; connected: boolean; joinOrder: number;
  profile: ProfileAnswers | null; profileDone: boolean;
  points: number; assists: number;
  predictCorrect: number; predictTotal: number; callItCorrect: number; callItTotal: number; explanations: number;
  knowledge: KnowledgeMap; knowledgeStart: KnowledgeMap; savedKnowledge: KnowledgeMap | null;
  storyline: Assignment | null;
  prompt: PlayerPrompt | null;
  lastResult: PlayerView['lastResult'];
  buzz: PlayerView['buzz'];
  log: { text: string; points: number }[];
};

type Round = {
  id: string; kind: 'predict' | 'callit'; playIdx: number; question: string; options: PromptOption[]; closesAt: number;
  answers: Map<string, { optionId: string; at: number }>;
  correctOptionId?: string;
  reveal?: { correctOptionId: string; results: { playerId: string; correct: boolean; points: number }[] };
  voided?: boolean;
  open: boolean;
  close: () => void;
};

export type SpokenRecord = { lineId: string; text: string; kind: 'explain' | 'short' | 'insight' | 'beat' | 'announcement' | 'storyline' | 'halftime' | 'final' | 'intro'; at: number; endAt?: number; qtr: number; trigger?: Trigger; spoken: boolean;
  /** Huddle's short version after a person's explanation left someone confused (follows the human turn directly). */
  followUp?: boolean;
};

export type RoomEvents = {
  onEngineEvent?: (ev: EngineEvent, at: number) => void;
  onOffer?: (o: { kind: 'takeit' | 'handoff'; playerId: string; conceptId: string; accepted: boolean }) => void;
};

export type RoomDeps = {
  clock: Clock;
  transport: Transport;
  llm: LLM;
  families?: FamilyStore | null;
  events?: RoomEvents;
  /** Divides every pacing wait and window (smoke test). */
  speed?: number;
  /** Server-side voice (ElevenLabs). Absent or disabled = browser speech on the TV. */
  tts?: TtsService | null;
  /** F14 live mode: game data and feed for a live (or replayed-as-live) ESPN game instead of a committed file. */
  game?: GameData;
  live?: LiveGame | null;
  /** Game intelligence (situational numbers, sourced player/team facts) for the Director. Absent = rules only. */
  intel?: IntelProvider | null;
};

/** Entity keys for intel retrieval: both teams and the players named in the play (the flagged player only once announced). */
function playEntities(play: TimelinePlay, stage: 'result' | 'announced'): string[] {
  const people = Object.entries(play.players).filter(([role]) => stage === 'announced' || role !== 'penaltyPlayer').map(([, name]) => name);
  return [...new Set([play.posteam, play.defteam, ...people].filter((e): e is string => !!e))];
}

const first =(n: string) => n.trim().split(/\s+/)[0] || n;
const estimateMs = (text: string) => Math.round((text.trim().split(/\s+/).length / WORDS_PER_SECOND) * 1000) + 400;
const loadPreset = (id: string): Preset => JSON.parse(fs.readFileSync(dataPath('presets', `${id}.json`), 'utf8'));

export class Room {
  readonly code: string;
  readonly hostToken: string;
  settings: Settings;
  phase: RoomPhase = 'lobby';
  readonly game: GameData;
  readonly engine: ReplayEngine;
  readonly players = new Map<string, Player>();
  readonly scheduler: Scheduler;
  readonly spokenLog: SpokenRecord[] = [];
  lastActivity: number;

  private clock: Clock;
  private transport: Transport;
  private llm: LLM;
  private families: FamilyStore | null;
  private events: RoomEvents;
  private speed: number;
  private tts: TtsService | null;
  readonly live: LiveGame | null;
  private intel: IntelProvider | null;
  /** Intel facts already said in this room: never twice. */
  readonly usedFactIds = new Set<string>();
  /** Variety: what kinds of facts Huddle has said, so it doesn't say the same kind of thing again and again. */
  private saidKinds: { kind: IntelFact['kind']; qtr: number; draft: boolean }[] = [];
  private offeredFacts = new Map<string, IntelFact>();

  private gen = 0;
  private tvCount = 0;
  private joinCounter = 0;
  private scorebug: RoomSnapshot['scorebug'] = null;
  private field: RoomSnapshot['field'] = null;
  private ticker: string | null = null;
  private card: SnapshotCard | null = null;
  private status: string | null = null;
  private explaining: RoomSnapshot['explaining'] = null;
  private halftime: RoomSnapshot['halftime'] = null;
  private recap: FamilyRecap | null = null;
  private storylineReveal = 0;
  private round: Round | null = null;
  private pendingPredict: Round | null = null;
  private windowsOpen = 0;
  private revealed = new Set<string>();
  private callItCache = new Map<number, Promise<CallItRound>>();
  private callItRounds = new Map<number, CallItRound>();
  private beatsUsed = new Set<string>();
  private pendingPrompts = new Map<string, (v: unknown) => void>();
  private pendingSpeech = new Map<string, () => void>();
  private presetId: string | null = null;
  private presetLabel: string | null = null;
  private flushTimer: TimerHandle | null = null;
  private familySaveTimer: TimerHandle | null = null;
  private family: FamilyFile | null = null;
  private gameLog: { text: string; weight: number }[] = [];
  private lastQtr = 0;
  private started = false;
  private storylinesRunning = false;
  private aiLogTimer: TimerHandle | null = null;

  constructor(code: string, settings: Settings, deps: RoomDeps) {
    this.code = code;
    this.hostToken = nanoid(16);
    this.settings = settings;
    this.clock = deps.clock;
    this.transport = deps.transport;
    this.llm = deps.llm;
    this.families = deps.families ?? null;
    this.events = deps.events ?? {};
    this.speed = deps.speed ?? 1;
    this.tts = deps.tts ?? null;
    this.lastActivity = this.clock.now();
    this.game = deps.game ?? loadGame(settings.gameId);
    this.live = deps.live ?? null;
    this.intel = deps.intel ?? null;
    this.scheduler = new Scheduler(settings.talkativeness);
    this.engine = new ReplayEngine(this.game.timeline, this.game.moments, this.clock, (ev) => this.onEngineEvent(ev), {
      mode: settings.mode, pacing: settings.pacing,
    });
    this.engine.speed = this.speed;
    if (this.live) {
      const live = this.live;
      this.engine.feed = live;
      // Hold each snap until the family's TV shows it (feed time + their broadcast delay).
      this.engine.beforeSnap = (play) => {
        const at = live.showAt(play.idx);
        const wait = at === null ? 0 : at - this.now();
        return wait > 0 ? sleep(this.clock, wait) : null;
      };
      live.onUpdate = () => this.touch();
    }
    if (settings.familyName && this.families) this.family = this.families.load(settings.familyName);
    const prev = this.llm.onLog;
    this.llm.onLog = (log) => {
      prev?.(log);
      if (!this.aiLogTimer) this.aiLogTimer = this.clock.setTimeout(() => { this.aiLogTimer = null; this.transport.aiLog(this.code, log.slice(-50)); }, 200);
    };
  }

  // ---------------------------------------------------------------- helpers

  private get pace() { return PACING[this.settings.pacing]; }
  private win(ms: number) { return ms / this.speed; }
  private now() { return this.clock.now(); }

  private check(gen: number) { if (gen !== this.gen) throw new Aborted(); }

  private async pause(gen: number, ms: number) {
    await sleep(this.clock, ms);
    this.check(gen);
  }

  get connectedPlayers() { return [...this.players.values()].filter((p) => p.connected); }
  get connectedLearners() { return this.connectedPlayers.filter((p) => p.role === 'learner'); }
  get connectedFan() { return this.connectedPlayers.filter((p) => p.role === 'fan').sort((a, b) => a.joinOrder - b.joinOrder)[0] ?? null; }
  get learnersByJoin() { return [...this.players.values()].filter((p) => p.role === 'learner').sort((a, b) => a.joinOrder - b.joinOrder); }
  get revealedKeys() { return new Set(this.revealed); }

  private storylineFile(): StorylinesFile { return this.game.storylines; }
  private get league() { return this.game.timeline.league ?? 'nfl'; }
  private team(abbr: string | null | undefined) { return teamOf(abbr, this.game.timeline.teams); }

  /** Schedule a debounced broadcast (50 ms). */
  touch() {
    this.lastActivity = this.now();
    if (this.flushTimer) return;
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 50);
  }

  flush() {
    this.transport.snapshot(this.code, this.snapshot());
    for (const p of this.players.values()) this.transport.playerView(this.code, p.id, this.playerView(p));
  }

  private standings() {
    return rank([...this.players.values()].map((p) => ({ id: p.id, points: p.points, callItCorrect: p.callItCorrect })));
  }

  snapshot(): RoomSnapshot {
    const g = this.game.timeline;
    const r = this.round;
    return {
      code: this.code,
      phase: this.phase,
      settings: { ...this.settings },
      game: { id: g.gameId, title: g.title, home: this.team(g.home), away: this.team(g.away) },
      players: [...this.players.values()].sort((a, b) => a.joinOrder - b.joinOrder).map((p) => ({
        id: p.id, name: p.name, color: p.color, role: p.role, connected: p.connected, points: p.points,
        profileDone: p.profileDone, lockedIn: !!r && r.open && r.answers.has(p.id),
      })),
      scorebug: this.scorebug,
      field: this.field,
      ticker: this.ticker,
      prompt: r ? {
        id: r.id, kind: r.kind, question: r.question, options: r.options, closesAt: r.closesAt,
        ...(r.reveal ? { reveal: r.reveal } : {}), ...(r.voided ? { voided: true } : {}),
      } : null,
      card: this.card,
      storylines: [...this.players.values()].filter((p) => p.storyline).sort((a, b) => a.joinOrder - b.joinOrder)
        .map((p) => ({ playerId: p.id, title: p.storyline!.title, hook: p.storyline!.hook, watchFor: p.storyline!.watchFor })),
      storylineReveal: this.storylineReveal,
      presetLabel: this.presetLabel,
      recap: this.recap,
      halftime: this.halftime,
      explaining: this.explaining,
      demo: {
        segments: this.game.moments.segments.map((s) => ({ id: s.id, label: s.label })),
        // Opaque ids: internal keys like "bradberry-flag" would spoil the jump list.
        moments: this.game.moments.moments.map((m) => ({ id: `m${m.idx}`, label: m.publicLabel })),
        idx: this.engine.currentIdx, total: g.plays.length, paused: this.engine.paused,
        mode: this.engine.modeName, pacing: this.engine.pacingKey,
      },
      status: this.status,
      live: this.live ? { ...this.live.status(), camera: { connected: this.cameras, lastFlagAgoSec: this.lastCameraFlagAt === null ? null : Math.round((this.now() - this.lastCameraFlagAt) / 1000) } } : null,
      video: { enabled: this.videoMode, synced: this.videoSync ? Object.keys(this.videoSync.snaps).length : 0, seek: this.videoSeek },
      serverNow: this.now(),
    };
  }

  playerView(p: Player): PlayerView {
    const standing = this.standings().find((s) => s.id === p.id);
    const me = this.recap?.people.find((x) => x.playerId === p.id) ?? null;
    return {
      code: this.code,
      phase: this.phase,
      me: { id: p.id, name: p.name, color: p.color, role: p.role, profileDone: p.profileDone, points: p.points, rank: standing?.rank ?? 1, profile: p.profile },
      storyline: p.storyline ? { title: p.storyline.title, hook: p.storyline.hook, watchFor: p.storyline.watchFor } : null,
      prompt: p.prompt,
      lastResult: p.lastResult,
      buzz: p.buzz,
      recap: this.recap ? { me, family: this.recap } : null,
      serverNow: this.now(),
    };
  }

  // ---------------------------------------------------------------- connections

  tvJoined() { this.tvCount++; this.touch(); }
  tvLeft() { this.tvCount = Math.max(0, this.tvCount - 1); }

  joinPlayer(input: { name: string; color?: string; playerId?: string }): Player {
    const existing = input.playerId ? this.players.get(input.playerId) : undefined;
    if (existing) {
      existing.connected = true;
      this.touch();
      return existing;
    }
    const name = input.name.trim().slice(0, 24) || 'Player';
    const id = nanoid(10);
    const saved = this.family?.players[name.toLowerCase()];
    const knowledge: KnowledgeMap = saved ? structuredClone(saved.knowledge) : {};
    const p: Player = {
      id, name, color: input.color || PLAYER_COLORS[this.players.size % PLAYER_COLORS.length], role: 'learner', connected: true,
      joinOrder: this.joinCounter++, profile: null, profileDone: false,
      points: 0, assists: 0, predictCorrect: 0, predictTotal: 0, callItCorrect: 0, callItTotal: 0, explanations: 0,
      knowledge, knowledgeStart: structuredClone(knowledge), savedKnowledge: null,
      storyline: null, prompt: null, lastResult: null, buzz: null, log: [],
    };
    this.players.set(id, p);
    if (this.presetId) this.applyPreset(this.presetId);
    this.touch();
    return p;
  }

  setConnected(id: string, connected: boolean) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    if (!connected && this.round?.open && this.allAnswered(this.round)) this.round.close();
    this.touch();
  }

  setProfile(id: string, answers: ProfileAnswers) {
    const p = this.players.get(id);
    if (!p) return;
    p.profile = answers;
    p.profileDone = true;
    if (answers.fan && p.role !== 'fan') {
      p.role = 'fan';
      // Preset slots follow learner join order, so re-seed when someone turns out to be the fan.
      if (this.presetId) this.applyPreset(this.presetId);
    }
    this.touch();
    if (this.phase === 'profiles') {
      const learners = [...this.players.values()].filter((x) => x.role === 'learner');
      if (learners.length && [...this.players.values()].every((x) => x.profileDone || !x.connected)) void this.finishProfiles();
    } else if (p.role === 'learner' && !p.storyline && this.phase !== 'lobby') {
      void this.assignOne(p);
    }
  }

  // ---------------------------------------------------------------- prompts

  private allAnswered(r: Round) {
    const c = this.connectedPlayers;
    return c.length > 0 && c.every((p) => r.answers.has(p.id));
  }

  answer(playerId: string, promptId: string, optionId: string) {
    const r = this.round;
    const p = this.players.get(playerId);
    if (!r || !p || !r.open || r.id !== promptId || r.answers.has(playerId)) return;
    if (!r.options.some((o) => o.id === optionId)) return;
    r.answers.set(playerId, { optionId, at: this.now() });
    if (p.prompt && (p.prompt.kind === 'predict' || p.prompt.kind === 'callit')) p.prompt = { ...p.prompt, lockedOptionId: optionId };
    this.touch();
    if (this.allAnswered(r)) r.close();
  }

  private respond(playerId: string, promptId: string, value: unknown) {
    const p = this.players.get(playerId);
    if (!p || !p.prompt || p.prompt.id !== promptId) return;
    const resolve = this.pendingPrompts.get(promptId);
    if (resolve) resolve(value);
  }

  takeIt(playerId: string, promptId: string, accept: boolean) { this.respond(playerId, promptId, accept); }
  handoff(playerId: string, promptId: string, accept: boolean) { this.respond(playerId, promptId, accept); }
  done(playerId: string, promptId: string) { this.respond(playerId, promptId, true); }
  feedback(playerId: string, promptId: string, value: 'got_it' | 'confused') { this.respond(playerId, promptId, value); }

  /** Put a private prompt on one phone and wait for the answer (null on timeout). */
  private async ask<T>(p: Player, prompt: PlayerPrompt, ms: number): Promise<T | null> {
    this.windowsOpen++;
    p.prompt = prompt;
    p.buzz = null;
    this.touch();
    try {
      return await new Promise<T | null>((resolve) => {
        const t = this.clock.setTimeout(() => { this.pendingPrompts.delete(prompt.id); resolve(null); }, ms);
        this.pendingPrompts.set(prompt.id, (v) => {
          this.clock.clearTimeout(t);
          this.pendingPrompts.delete(prompt.id);
          resolve(v as T);
        });
      });
    } finally {
      this.windowsOpen--;
      if (p.prompt?.id === prompt.id) p.prompt = null;
      this.touch();
    }
  }

  private cancelPrompts() {
    for (const resolve of [...this.pendingPrompts.values()]) resolve(null);
    this.pendingPrompts.clear();
    for (const p of this.players.values()) p.prompt = null;
    if (this.round?.open) this.round.close();
    for (const r of [...this.pendingSpeech.values()]) r();
    this.pendingSpeech.clear();
  }

  /** Open a Predict or Call It round for everyone and resolve when it closes. */
  private async openRound(kind: 'predict' | 'callit', playIdx: number, question: string, options: PromptOption[], windowMs: number): Promise<Round> {
    const id = nanoid(8);
    const ms = this.win(windowMs);
    const closesAt = this.now() + ms;
    let closeFn: () => void = () => undefined;
    const closed = new Promise<void>((r) => { closeFn = r; });
    const round: Round = { id, kind, playIdx, question, options, closesAt, answers: new Map(), open: true, close: () => undefined };
    const t = this.clock.setTimeout(() => round.close(), ms);
    round.close = () => {
      if (!round.open) return;
      round.open = false;
      this.clock.clearTimeout(t);
      closeFn();
    };
    this.round = round;
    this.windowsOpen++;
    for (const p of this.connectedPlayers) {
      p.prompt = { id, kind, question, options, closesAt, lockedOptionId: null };
      p.buzz = null;
    }
    this.touch();
    await closed;
    this.windowsOpen--;
    for (const p of this.players.values()) if (p.prompt?.id === id) p.prompt = null;
    this.touch();
    return round;
  }

  private participants() {
    return [...this.players.values()].map((p) => ({ id: p.id, role: p.role }));
  }

  private revealPredict(play: TimelinePlay) {
    const r = this.pendingPredict;
    this.pendingPredict = null;
    if (!r || r.playIdx !== play.idx) return;
    const res = resolvePredict(play);
    const answers = [...r.answers.entries()].map(([playerId, a]) => ({ playerId, ...a }));
    if (res.voided) {
      r.voided = true;
      r.reveal = { correctOptionId: '', results: [] };
      for (const a of answers) {
        const p = this.players.get(a.playerId);
        if (p) p.lastResult = { id: nanoid(6), correct: false, points: 0, label: 'No play. Prediction voided.' };
      }
      this.status = 'No play. Prediction voided.';
    } else {
      const results = scorePredict(answers, res.correctOptionId, this.participants(), this.settings.fanHandicap);
      r.reveal = { correctOptionId: res.correctOptionId, results };
      const label = r.options.find((o) => o.id === res.correctOptionId)?.label ?? '';
      for (const x of results) {
        const p = this.players.get(x.playerId);
        if (!p) continue;
        p.points += x.points;
        p.predictTotal++;
        if (x.correct) {
          p.predictCorrect++;
          p.log.push({ text: `Predicted "${label}" on ${r.question.split('.')[0]}`, points: x.points });
        }
        p.lastResult = { id: nanoid(6), correct: x.correct, points: x.points, label: x.correct ? `Right: ${label}` : `It was: ${label}` };
      }
    }
    if (this.round?.id === r.id) this.round = r;
    this.touch();
  }

  private revealCallIt(play: TimelinePlay, r: Round) {
    const correctId = r.correctOptionId!;
    const answers = [...r.answers.entries()].map(([playerId, a]) => ({ playerId, ...a }));
    const results = scoreCallIt(answers, correctId, this.participants(), this.settings.fanHandicap);
    r.reveal = { correctOptionId: correctId, results };
    const pen = play.penalty!;
    const label = r.options.find((o) => o.id === correctId)?.label ?? (pen.conceptId === 'penalty_other' ? pen.rawType : concept(pen.conceptId).name);
    const offList = correctId === '__none__';
    for (const x of results) {
      const p = this.players.get(x.playerId);
      if (!p) continue;
      p.points += x.points;
      p.callItTotal++;
      if (x.correct) {
        p.callItCorrect++;
        if (p.role === 'learner') addRecall(p.knowledge, play.penalty!.conceptId);
        p.log.push({ text: `Called ${label} before the referee`, points: x.points });
        this.gameLog.push({ text: `${first(p.name)} called ${label} before the referee said it (Q${play.qtr} ${play.clock}).`, weight: x.points + (play.momentKeys.length ? 100 : 0) });
      }
      p.lastResult = { id: nanoid(6), correct: x.correct, points: x.points, label: x.correct ? `You called it: ${label}` : offList ? `It was ${label}: not on the list this time` : `It was ${label}` };
    }
    this.round = r;
    this.knowledgeChanged();
    this.touch();
  }

  // ---------------------------------------------------------------- speech & cards

  spoken(lineId: string) {
    const r = this.pendingSpeech.get(lineId);
    if (r) { this.pendingSpeech.delete(lineId); r(); }
  }

  private async speak(gen: number, text: string, kind: SpokenRecord['kind'], priority = 1, trigger?: Trigger, followUp = false) {
    this.check(gen);
    const lineId = nanoid(8);
    const est = this.win(estimateMs(text));
    const rec: SpokenRecord = { lineId, text, kind, at: this.now(), qtr: this.scorebug?.qtr ?? 0, trigger, spoken: this.settings.voice, ...(followUp ? { followUp } : {}) };
    this.spokenLog.push(rec);
    if (this.settings.voice && this.tvCount > 0) {
      const audioUrl = this.tts?.register(lineId, text) ?? null;
      const cue = kind === 'announcement' ? 'whistle' : kind === 'intro' || kind === 'storyline' ? undefined : 'chime';
      this.transport.speak(this.code, { lineId, text, priority, ...(audioUrl ? { audioUrl } : {}), ...(cue ? { cue } : {}) });
      // Server-rendered audio adds fetch time before playback starts.
      const slack = this.win(audioUrl ? 5000 : 2500);
      await new Promise<void>((resolve) => {
        const t = this.clock.setTimeout(() => { this.pendingSpeech.delete(lineId); resolve(); }, est + slack);
        this.pendingSpeech.set(lineId, () => { this.clock.clearTimeout(t); resolve(); });
      });
    } else {
      await sleep(this.clock, est);
    }
    rec.endAt = this.now();
    this.check(gen);
    return rec;
  }

  private setCard(card: Omit<SnapshotCard, 'id'>) {
    this.card = { id: nanoid(6), ...card };
    this.touch();
  }

  // ---------------------------------------------------------------- lifecycle

  startProfiles() {
    if (this.phase !== 'lobby') return;
    this.phase = 'profiles';
    this.touch();
    void this.say(this.gen, 'Welcome to game night. Three quick questions are on your phones.');
    const learners = [...this.players.values()].filter((x) => x.role === 'learner');
    if (learners.length && [...this.players.values()].every((p) => p.profileDone)) void this.finishProfiles();
  }

  async finishProfiles() {
    if (this.phase !== 'profiles' || this.storylinesRunning) return;
    this.storylinesRunning = true;
    const gen = this.gen;
    try {
      const learners = this.learnersByJoin.filter((p) => p.connected);
      const { assignments } = await assignStorylines(this.llm, learners.map((l) => ({ id: l.id, name: l.name, profile: l.profile })), this.storylineFile());
      for (const a of assignments) {
        const p = this.players.get(a.playerId);
        if (p) p.storyline = a;
      }
      if (!assignments.length) {
        // No curated storylines (e.g. a live game): go straight to kickoff.
        this.startGame();
        return;
      }
      this.phase = 'storylines';
      this.storylineReveal = 0;
      this.touch();
      const withStory = this.learnersByJoin.filter((p) => p.storyline);
      for (let i = 0; i < withStory.length; i++) {
        if (this.phase !== 'storylines') return;
        this.storylineReveal = i + 1;
        this.touch();
        const started = this.now();
        await this.speak(gen, withStory[i].storyline!.hook, 'storyline');
        const left = this.win(6000) - (this.now() - started);
        if (left > 0) await this.pause(gen, left);
      }
      if (this.phase === 'storylines') {
        await this.pause(gen, this.win(2000));
        this.startGame();
      }
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
    } finally {
      this.storylinesRunning = false;
    }
  }

  private async assignOne(p: Player, exclude: string[] = []) {
    const taken = [...this.players.values()].filter((x) => x.id !== p.id && x.storyline).map((x) => x.storyline!.storylineId);
    const { assignments } = await assignStorylines(this.llm, [{ id: p.id, name: p.name, profile: p.profile }], {
      ...this.storylineFile(),
      storylines: this.storylineFile().storylines.map((s) => (taken.includes(s.id) && this.storylineFile().storylines.filter((x) => x.assignable).length > taken.length ? { ...s, assignable: false } : s)),
    }, { [p.id]: exclude });
    if (assignments[0]) p.storyline = assignments[0];
    this.touch();
  }

  /** Speak a host line (welcome, kickoff) that nothing waits on; a jump or reset silently cancels it. */
  private async say(gen: number, text: string) {
    try { await this.speak(gen, text, 'intro', 1); } catch (e) { if (!(e instanceof Aborted)) throw e; }
  }

  startGame() {
    if (this.started) return;
    this.started = true;
    this.gen++;
    this.phase = 'live';
    this.lastEngine = { at: this.now(), what: 'kickoff' };
    for (const p of this.players.values()) p.knowledgeStart = structuredClone(p.knowledge);
    this.touch();
    void this.kickoff(this.gen);
  }

  private practicing = false;

  /** Before the first play: a practice Call It (no points) so everyone learns the buzzer, then a kickoff line. */
  private async kickoff(gen: number) {
    if (this.live && !this.live.isReplay && this.game.timeline.plays.length > 1) {
      // Joining a game in progress: no practice, no waiting; the game is already going.
      this.beginEngine();
      void this.say(gen, this.kickoffLine());
      return;
    }
    // Replays start their clock now; the family's delay (30 s by default) covers the practice and kickoff lines.
    this.live?.begin();
    try {
      if (this.settings.practice !== false && this.connectedPlayers.length) await this.practiceRound(gen);
      await this.speak(gen, this.kickoffLine(), 'intro', 1);
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
    } finally {
      this.practicing = false;
    }
    // A jump during the kickoff already started the engine from its target.
    if (gen === this.gen) this.beginEngine();
  }

  private kickoffLine(): string {
    const g = this.game.timeline;
    const h = this.team(g.home).city;
    const a = this.team(g.away).city;
    if (this.live && !this.live.isReplay && g.plays.length > 1) {
      const last = g.plays[g.plays.length - 1];
      return `We're joining live. ${this.scoreLine(last.scoreAfter)}. Here we go.`;
    }
    return `${a} at ${h}. When a yellow flag flies, grab your phone and guess the call. Here we go.`;
  }

  private async practiceRound(gen: number) {
    this.practicing = true;
    // Fixed order so the right answer (false start) isn't first.
    const order = ['pass_interference_defensive', 'false_start', 'face_mask', 'holding_offensive'].map((cid, i) => ({ id: 'abcd'[i], label: concept(cid, this.league).name }));
    const roundP = this.openRound('callit', -1, 'Practice: a lineman jumps before the snap. Flag! What was the call?', order, 12_000);
    await this.speak(gen, 'Before kickoff, a practice round. No points. Check your phones.', 'intro', 1);
    const r = await roundP;
    this.check(gen);
    const correct = 'b'; // false start
    const c = concept('false_start', this.league);
    r.reveal = {
      correctOptionId: correct,
      results: [...r.answers.entries()].map(([playerId, a]) => ({ playerId, correct: a.optionId === correct, points: 0 })),
    };
    this.round = r;
    for (const x of r.reveal.results) {
      const p = this.players.get(x.playerId);
      if (p) p.lastResult = { id: nanoid(6), correct: x.correct, points: 0, label: x.correct ? 'Nailed it. Practice only.' : `It was: ${c.name}` };
    }
    this.setCard({ kind: 'explain', title: `Practice · ${c.name}`, body: c.full, by: 'Huddle', source: 'Practice round · no points' });
    // `full` already names the foul ("False start: …"), so it can stand alone.
    await this.speak(gen, `The answer: ${c.full}`, 'intro', 1);
    await this.pause(gen, this.win(1500));
    // Nothing from practice may linger into the real game.
    this.round = null;
    this.card = null;
    for (const p of this.players.values()) p.lastResult = null;
    this.touch();
  }

  private beginEngine() {
    if (this.live) {
      this.live.begin();
      // Joining a game already in progress: start at the latest real play (not a timeout or period end), not the opening kickoff.
      const plays = this.game.timeline.plays;
      let start = plays.length - 1;
      while (start > 0 && (plays[start].kind === 'end_of_period' || plays[start].kind === 'timeout')) start--;
      if (this.live.isReplay || plays.length === 0) this.engine.start();
      else {
        this.live.shownIdx = start - 1;
        this.engine.start(start);
      }
      return;
    }
    this.engine.start();
  }

  /** Host "advance" (Enter): lobby → profiles → storylines → live. */
  advance() {
    if (this.phase === 'lobby') this.startProfiles();
    else if (this.phase === 'profiles') {
      for (const p of this.players.values()) if (!p.profileDone && p.connected) { p.profileDone = true; }
      void this.finishProfiles();
    } else if (this.phase === 'storylines') {
      this.gen++;
      this.cancelPrompts();
      this.startGame();
    }
  }

  // ---------------------------------------------------------------- host controls

  control(action: HostAction, value: unknown) {
    switch (action) {
      case 'start_profiles': this.startProfiles(); break;
      case 'advance': this.advance(); break;
      case 'start_game':
        if (this.phase === 'lobby' || this.phase === 'profiles' || this.phase === 'storylines') { this.gen++; this.cancelPrompts(); this.startGame(); }
        break;
      case 'play': this.engine.resume(); break;
      case 'pause': this.engine.pause(); break;
      case 'next': this.skip(); break;
      case 'jump': this.jump(value); break;
      case 'mode':
        if (value === 'full' || value === 'condensed' || value === 'demo') { this.settings.mode = value; this.engine.setMode(value); }
        break;
      case 'pacing':
        if (value === 'gameNight' || value === 'demo') { this.settings.pacing = value; this.engine.setPacing(value); }
        break;
      case 'talkativeness':
        if (value === 'quiet' || value === 'normal' || value === 'chatty') { this.settings.talkativeness = value; this.scheduler.talkativeness = value; }
        break;
      case 'voice':
        this.settings.voice = typeof value === 'boolean' ? value : !this.settings.voice;
        this.transport.mute(this.code, !this.settings.voice);
        if (!this.settings.voice) for (const r of [...this.pendingSpeech.values()]) r();
        break;
      case 'preset':
        this.applyPreset(value === 'game1' || value === 'game4' ? value : null);
        break;
      case 'reroll_storyline': {
        const p = typeof value === 'string' ? this.players.get(value) : undefined;
        if (p && p.role === 'learner') void this.assignOne(p, p.storyline ? [p.storyline.storylineId] : []);
        break;
      }
      case 'video': this.setVideoMode(value === true); break;
      case 'live_delay':
        if (this.live && typeof value === 'number' && Number.isFinite(value)) this.live.delayMs = Math.max(0, Math.min(180, value)) * 1000;
        break;
      case 'live_sync': this.live?.syncNow(typeof value === 'number' ? value : undefined); break;
      case 'flag_seen': this.onCameraFlag(); break;
      case 'video_time': if (typeof value === 'number' && Number.isFinite(value)) this.onVideoTime(value); break;
      case 'frame': {
        const f = value as { kind?: string; image?: string } | undefined;
        if (f?.kind === 'flag' && typeof f.image === 'string' && f.image.startsWith('data:image/') && f.image.length < 1_500_000) {
          this.flagFrame = f.image;
          this.flagFrameWaiter?.();
        }
        break;
      }
      case 'set_role': {
        const v = value as { playerId?: string; role?: string } | undefined;
        const p = v?.playerId ? this.players.get(v.playerId) : undefined;
        if (p && (v?.role === 'fan' || v?.role === 'learner')) {
          p.role = v.role;
          if (this.presetId) this.applyPreset(this.presetId);
        }
        break;
      }
    }
    this.touch();
  }

  /** Skip: close any open window early and cut the current pacing wait. */
  private skips = 0;

  skip() {
    this.skips++;
    if (this.practicing) {
      if (this.round?.open) this.round.close();
      for (const r of [...this.pendingSpeech.values()]) r();
      return;
    }
    for (const resolve of [...this.pendingPrompts.values()]) resolve(null);
    if (this.round?.open) this.round.close();
    for (const r of [...this.pendingSpeech.values()]) r();
    this.engine.next();
  }

  jump(value: unknown) {
    const v = (value ?? {}) as { idx?: number; segment?: string; moment?: string; fromVideo?: boolean };
    let idx: number | undefined;
    if (v.segment) idx = this.game.moments.segments.find((s) => s.id === v.segment)?.startIdx;
    else if (v.moment) {
      const opaque = /^m(\d+)$/.exec(v.moment);
      idx = opaque ? Number(opaque[1]) : this.game.moments.keys[v.moment] ?? this.game.moments.moments.find((m) => m.id === v.moment)?.idx;
    }
    else if (typeof v.idx === 'number') idx = v.idx;
    if (idx === undefined) return;
    this.gen++;
    this.cancelPrompts();
    this.round = null;
    this.pendingPredict = null;
    this.card = null;
    this.status = null;
    this.explaining = null;
    this.recap = null;
    this.halftime = null;
    // Moments before the target have "passed".
    this.revealed = new Set(Object.entries(this.game.moments.keys).filter(([k, i]) => i < idx! && k !== 'final').map(([k]) => k));
    if (this.game.timeline.plays[idx].qtr >= 3) this.revealed.add('halftime');
    this.started = true;
    this.phase = 'live';
    if (this.videoMode && !v.fromVideo) {
      // Seek the TV's video a few seconds before the nearest synced snap at or before the target.
      let t: number | undefined;
      for (let i = idx; i >= 0 && t === undefined; i--) t = this.snapTime(i);
      if (t !== undefined) this.videoSeek = { id: nanoid(6), t: Math.max(0, t - 4) };
    }
    for (const w of this.videoWaiters.splice(0)) w.resolve();
    if (v.segment && !this.videoMode) this.engine.jumpToSegment(v.segment);
    else this.engine.jumpTo(idx);
    this.settings.mode = this.engine.modeName;
    this.touch();
  }

  applyPreset(id: string | null) {
    if (!id) {
      for (const p of this.players.values()) if (p.savedKnowledge) { p.knowledge = p.savedKnowledge; p.savedKnowledge = null; }
      this.presetId = null;
      this.presetLabel = null;
      this.touch();
      return;
    }
    const preset = loadPreset(id);
    this.presetId = id;
    this.presetLabel = preset.label;
    this.learnersByJoin.forEach((p, slot) => {
      if (!p.savedKnowledge) p.savedKnowledge = p.knowledge;
      p.knowledge = presetKnowledge(preset, slot);
      p.knowledgeStart = structuredClone(p.knowledge);
    });
    this.touch();
  }

  // ---------------------------------------------------------------- F12 video mode

  private videoMode = false;
  private videoSync: VideoSync | null = null;
  private videoTime = 0;
  private videoWaiters: { t: number; resolve: () => void }[] = [];
  private videoSeek: { id: string; t: number } | null = null;
  private flagFrame: string | null = null;
  private flagFrameWaiter: (() => void) | null = null;

  private snapTime(idx: number): number | undefined {
    return this.videoSync?.snaps[String(idx)];
  }

  /** Video mode: the engine waits for the video to reach each synced snap; the whole game plays (full mode). */
  setVideoMode(on: boolean, sync?: VideoSync) {
    this.videoMode = on;
    if (on) {
      this.videoSync = sync ?? loadVideoSync(this.game.timeline.gameId);
      this.settings.mode = 'full';
      this.engine.setMode('full');
      this.engine.beforeSnap = (play) => this.videoHold(play);
    } else {
      this.engine.beforeSnap = null;
      for (const w of this.videoWaiters.splice(0)) w.resolve();
    }
    this.touch();
  }

  private videoHold(play: TimelinePlay): Promise<void> | null {
    const t = this.snapTime(play.idx);
    if (!this.videoMode || t === undefined) return null;
    if (this.videoTime >= t - 0.3) return Promise.resolve();
    return new Promise<void>((resolve) => this.videoWaiters.push({ t, resolve }));
  }

  /** The TV reports the video's current time (host only, about twice a second). */
  onVideoTime(t: number) {
    const prev = this.videoTime;
    this.videoTime = t;
    const ready = this.videoWaiters.filter((w) => t >= w.t - 0.3);
    this.videoWaiters = this.videoWaiters.filter((w) => t < w.t - 0.3);
    ready.forEach((w) => w.resolve());
    if (!this.videoMode || !this.videoSync || !this.started) return;
    // Someone scrubbed the video: follow it to the play at that time.
    if (Math.abs(t - prev) > 20) {
      const entries = Object.entries(this.videoSync.snaps).map(([i, v]) => [Number(i), v] as const).sort((a, b) => a[1] - b[1]);
      const at = entries.filter(([, v]) => v <= t + 1).pop();
      if (at && Math.abs(at[0] - this.engine.currentIdx) > 1) this.jump({ idx: at[0], fromVideo: true });
    }
  }

  private async waitFlagFrame(ms: number): Promise<string | null> {
    if (this.flagFrame) return this.flagFrame;
    await new Promise<void>((resolve) => {
      const t = this.clock.setTimeout(() => { this.flagFrameWaiter = null; resolve(); }, ms);
      this.flagFrameWaiter = () => { this.clock.clearTimeout(t); this.flagFrameWaiter = null; resolve(); };
    });
    return this.flagFrame;
  }

  // ---------------------------------------------------------------- F14 camera flag spotter

  /** Most common NFL penalties: the Call It options when the camera sees a flag before the feed says which. */
  static readonly CAMERA_OPTIONS = ['holding_offensive', 'false_start', 'pass_interference_defensive', 'holding_defensive'];

  cameras = 0;
  private lastCameraFlagAt: number | null = null;
  private cameraFlag: { round: Round; done: Promise<Round>; seenAt: number; resolved: boolean; timer: TimerHandle | null } | null = null;

  cameraJoined() { this.cameras++; this.touch(); }
  cameraLeft() { this.cameras = Math.max(0, this.cameras - 1); this.touch(); }

  /**
   * The camera saw the broadcast's FLAG box. The feed won't say which penalty until after the referee announces it,
   * so open Call It right away with the four most common penalties; the round is tied to the flagged play when the
   * feed posts it (revealed with the real answer) or cancelled if no flagged play turns up.
   */
  onCameraFlag() {
    if (!this.live || this.phase !== 'live') return;
    const now = this.now();
    this.lastCameraFlagAt = now;
    if (this.cameraFlag && !this.cameraFlag.resolved && now - this.cameraFlag.seenAt < 60_000) return;
    if (this.round?.open) return; // a Predict window is open: it wins
    const options = Room.CAMERA_OPTIONS.map((id, i) => ({ id: 'abcd'[i], label: concept(id).name }));
    if (this.scorebug) this.scorebug = { ...this.scorebug, flag: true };
    this.status = 'Flag on the play! (spotted on your TV)';
    const done = this.openRound('callit', -1, 'Flag! What was the call?', options, WINDOWS.callItMs); // not tied to a play yet
    const round = this.round!;
    const timer = this.clock.setTimeout(() => this.cancelCameraRound('No penalty came through: maybe a flag was picked up.'), 90_000);
    this.cameraFlag = { round, done, seenAt: now, resolved: false, timer };
    this.touch();
  }

  private cancelCameraRound(status: string) {
    const c = this.cameraFlag;
    if (!c || c.resolved) return;
    c.resolved = true;
    this.clock.clearTimeout(c.timer);
    if (c.round.open) c.round.close();
    c.round.voided = true;
    c.round.reveal = { correctOptionId: '', results: [] };
    if (this.scorebug) this.scorebug = { ...this.scorebug, flag: false };
    this.status = status;
    this.touch();
  }

  /** The feed posted a flagged play: adopt the camera round if the flag was seen around this play's snap on TV. */
  private async adoptCameraRound(play: TimelinePlay): Promise<Round | null> {
    const c = this.cameraFlag;
    if (!c || c.resolved) return null;
    const showAt = this.live?.showAt(play.idx) ?? null;
    if (showAt !== null && Math.abs(c.seenAt - showAt) > 75_000) return null;
    c.resolved = true;
    this.clock.clearTimeout(c.timer);
    const r = await c.done;
    const name = play.penalty?.conceptId === 'penalty_other' ? play.penalty.rawType : concept(play.penalty!.conceptId).name;
    r.playIdx = play.idx;
    r.correctOptionId = r.options.find((o) => o.label === name)?.id ?? '__none__';
    return r;
  }

  // ---------------------------------------------------------------- engine events

  /** Last engine event (time and a short description): the watchdog uses it to spot a stalled game. */
  lastEngine = { at: 0, what: 'not started' };
  /** Log one line per play to the server console (off in tests and simulate). */
  logPlays = false;

  async onEngineEvent(ev: EngineEvent): Promise<void> {
    const gen = this.gen;
    this.events.onEngineEvent?.(ev, this.now());
    const what = 'play' in ev ? `${ev.type} #${ev.play.idx} Q${ev.play.qtr} ${ev.play.clock}` : ev.type;
    this.lastEngine = { at: this.now(), what };
    if (this.logPlays && (ev.type === 'pre_snap' || ev.type === 'flag' || ev.type === 'summary' || ev.type === 'halftime' || ev.type === 'final')) {
      console.log(`[room ${this.code}] ${ev.type === 'summary' ? `summary: ${ev.text}` : what}${ev.type === 'pre_snap' && ev.play.decision ? ' (Predict)' : ''}`);
    }
    try {
      switch (ev.type) {
        case 'pre_snap': return await this.onPreSnap(gen, ev.play);
        case 'snap': this.status = null; this.touch(); return;
        case 'play_result': return this.onPlayResult(ev.play);
        case 'flag': return await this.onFlag(gen, ev.play);
        case 'penalty_announced': return await this.onAnnounced(gen, ev.play);
        case 'dead_time': return await this.onDeadTime(gen, ev.play);
        case 'summary':
          this.setCard({ kind: 'summary', title: 'Meanwhile', body: ev.text, by: 'Huddle' });
          this.ticker = ev.text;
          this.touch();
          return;
        case 'halftime': return await this.onHalftime(gen);
        case 'final': return await this.onFinal(gen);
      }
    } catch (e) {
      if (e instanceof Aborted) return;
      console.error('[room] event error', ev.type, e);
    }
  }

  private scorebugFor(play: TimelinePlay, score: { home: number; away: number }): NonNullable<RoomSnapshot['scorebug']> {
    const home = this.game.timeline.home;
    return {
      qtr: play.qtr, clock: play.clock, home: score.home, away: score.away,
      possession: play.posteam ? (play.posteam === home ? 'home' : 'away') : null,
      downDistance: downDistance(play), ballOn: ballOn(play),
      timeouts: play.timeoutsBefore ?? this.scorebug?.timeouts ?? null,
      flag: false, review: false,
    };
  }

  private situationTicker(play: TimelinePlay): string {
    const city = play.posteam ? this.team(play.posteam).city : '';
    if (play.kind === 'kickoff') return `${play.defteam ? this.team(play.defteam).city : 'Kickoff'} kicks off.`;
    if (play.kind === 'extra_point') return `${city}: extra point try.`;
    if (play.kind === 'two_point') return `${city}: two-point try.`;
    const dd = downDistance(play);
    const on = ballOn(play);
    return dd && on ? `${city} ball · ${dd} at ${on}` : `${city} ball`;
  }

  private async onPreSnap(gen: number, play: TimelinePlay) {
    if (this.phase === 'halftime' || this.phase === 'storylines') this.phase = 'live';
    if (play.qtr !== this.lastQtr) this.lastQtr = play.qtr;
    const cameraPending = !!this.cameraFlag && !this.cameraFlag.resolved;
    if (!cameraPending) this.round = null;
    this.card = null;
    if (!cameraPending) this.status = null;
    this.explaining = null;
    this.scorebug = this.scorebugFor(play, play.scoreBefore);
    if (cameraPending) this.scorebug = { ...this.scorebug, flag: true }; // the flag is still out on the family's TV
    const home = this.game.timeline.home;
    this.field = {
      losAbs: play.field.losAbs, firstDownAbs: play.field.firstDownAbs, ballAbs: play.field.losAbs,
      possession: play.posteam ? (play.posteam === home ? 'home' : 'away') : null, animateMs: this.win(500),
    };
    this.ticker = this.situationTicker(play);
    if (this.live) this.live.shownIdx = Math.max(this.live.shownIdx, play.idx);
    this.scheduler.notePlay();
    this.prefetchCallIt(play);
    this.prefetchTicker(play);
    this.touch();
    if (play.decision) {
      const q = buildPredict(play, this.game.timeline.teams);
      // Live: the window must close before the family's TV shows the snap; skip it if there isn't time.
      const window = this.liveWindow(this.live?.showAt(play.idx) ?? null, WINDOWS.predictMs, 0);
      if (q && window) {
        this.pendingPredict = await this.openRound('predict', play.idx, q.question, q.options, window);
        this.check(gen);
      }
    }
  }

  private onPlayResult(play: TimelinePlay) {
    const c = this.cameraFlag;
    if (c && !c.resolved && !play.penalty) {
      const showAt = this.live?.showAt(play.idx) ?? null;
      if (showAt !== null && showAt > c.seenAt + 5000) this.cancelCameraRound('No flag on that play after all.');
    }
    const f = this.field;
    if (f) this.field = { ...f, ballAbs: play.field.ballEndAbs ?? f.losAbs, animateMs: this.win(this.pace.playMs * 0.8) };
    this.scorebug = { ...this.scorebugFor(play, play.scoreAfter), review: !!play.challenge };
    this.ticker = tickerText(play, false);
    this.prefetchDirector(play);
    // F11: swap in the plain-English sentence when it's ready (unless the call has been announced since).
    const pending = this.tickerCache.get(play.idx);
    if (pending) {
      const gen = this.gen;
      void pending.then((text) => {
        if (gen !== this.gen || this.announcedIdx === play.idx || this.engine.currentIdx !== play.idx) return;
        if (text && text !== this.ticker) { this.ticker = text; this.touch(); }
      });
    }
    if (!play.penalty) {
      for (const k of play.momentKeys) this.revealed.add(k);
      this.revealPredict(play);
    }
    this.touch();
  }

  private tickerCache = new Map<number, Promise<string>>();
  private announcedIdx = -1;

  /** F11: rewrite this play and the next one ahead of time; results stay on the server until play_result. */
  private prefetchTicker(play: TimelinePlay) {
    const plays = this.game.timeline.plays;
    const g = this.game.timeline;
    for (const p of [play, plays[play.idx + 1]]) {
      if (!p || this.tickerCache.has(p.idx)) continue;
      this.tickerCache.set(p.idx, plainTicker(this.llm, p, g.home, g.away, g.teams).catch(() => p.publicDesc));
    }
  }

  /**
   * Window length for Predict / Call It. Replays: the full window. Live: whatever fits before `deadline`
   * (local ms) minus `reserve`, or null (skip the round) if under 5 s remain: the TV would give it away.
   */
  private liveWindow(deadline: number | null, full: number, reserve: number): number | null {
    if (!this.live || deadline === null) return full;
    const left = deadline - this.now() - reserve - 500;
    if (left < 5000 / this.speed) return null;
    return Math.min(full, left);
  }

  private prefetchCallIt(play: TimelinePlay) {
    const plays = this.game.timeline.plays;
    for (const p of [play, plays[play.idx + 1]]) {
      if (p?.penalty && !this.callItCache.has(p.idx)) this.callItCache.set(p.idx, this.fetchCallIt(p));
    }
  }

  private async fetchCallIt(play: TimelinePlay, frame?: string): Promise<CallItRound> {
    const pen = play.penalty!;
    const catalog = catalogFor(play, this.league);
    const user = JSON.stringify({
      situation: {
        quarter: play.qtr, clock: play.clock, possession: play.posteam ? this.team(play.posteam).city : null,
        downAndDistance: downDistance(play), ballOn: ballOn(play),
        playType: play.kind === 'penalty_only' ? 'before the snap' : play.kind,
      },
      whatHappened: play.publicDesc,
      correctPenalty: { id: pen.conceptId, name: pen.conceptId === 'penalty_other' ? pen.rawType : concept(pen.conceptId).name },
      catalog: catalog.map((id) => ({ id, name: concept(id).name })),
    }, null, 1);
    const res = await this.llm.json({
      task: 'callit', model: frame ? 'vision' : 'fast', system: CALLIT_SYSTEM,
      user: frame ? `${user}\n\n${CALLIT_VIDEO_NOTE}` : user, ...(frame ? { images: [frame] } : {}),
      schema: CallItOut, timeoutMs: 2500, temperature: 0.3,
      fallback: () => ({ distractors: fallbackDistractors(play, pen.conceptId, this.league) }),
    });
    return buildCallIt(play, res.value.distractors, res.source, this.league);
  }

  private async onFlag(gen: number, play: TimelinePlay) {
    const camera = await this.adoptCameraRound(play);
    this.check(gen);
    if (camera) {
      // The family already guessed when the flag appeared on their TV; now we know the answer.
      this.round = camera;
      if (this.scorebug) this.scorebug = { ...this.scorebug, flag: true };
      this.status = 'The referee is announcing…';
      this.touch();
      return;
    }
    if (this.scorebug) this.scorebug = { ...this.scorebug, flag: true };
    this.status = play.kind === 'penalty_only' ? 'Whistle. Flag before the snap.' : 'Flag on the play!';
    if (play.kind === 'penalty_only') this.ticker = 'Flag on the play.';
    this.touch();
    this.flagFrame = null;
    if (this.videoMode) {
      // F13: the TV captures the frame at the flag; include it in the distractor call when it arrives in time.
      const frame = await this.waitFlagFrame(this.win(1200));
      this.check(gen);
      if (frame) this.callItCache.set(play.idx, this.fetchCallIt(play, frame));
    }
    if (!this.callItCache.has(play.idx)) this.callItCache.set(play.idx, this.fetchCallIt(play));
    const callit = await this.callItCache.get(play.idx)!;
    this.check(gen);
    this.callItRounds.set(play.idx, callit);
    // Live: the referee announces roughly 20 s after the snap on the family's TV; close the window before that.
    const showAt = this.live?.showAt(play.idx) ?? null;
    const window = this.liveWindow(showAt === null ? null : showAt + 20_000, WINDOWS.callItMs, this.pace.announceMs);
    if (!window) {
      this.status = 'Flag on the play!';
      this.touch();
      return;
    }
    const r = await this.openRound('callit', play.idx, 'Flag! What was the call?', callit.options, window);
    this.check(gen);
    r.correctOptionId = callit.correctOptionId;
    this.status = 'The referee is announcing…';
    this.touch();
  }

  private async onAnnounced(gen: number, play: TimelinePlay) {
    const pen = play.penalty!;
    if (this.scorebug) this.scorebug = { ...this.scorebug, flag: false };
    this.status = null;
    for (const k of play.momentKeys) this.revealed.add(k);
    this.announcedIdx = play.idx;
    this.ticker = tickerText(play, true);
    this.setCard({ kind: 'announcement', title: 'The call', body: pen.announcement, by: 'Referee', source: 'Referee announcement' });
    const r = this.round;
    if (r && r.kind === 'callit' && r.playIdx === play.idx && r.correctOptionId) this.revealCallIt(play, r);
    if (this.pendingPredict) this.revealPredict(play);
    this.touch();
    await this.speak(gen, pen.announcement, 'announcement', 2);
  }

  private async onDeadTime(gen: number, play: TimelinePlay) {
    if (play.kind === 'timeout' || play.kind === 'end_of_period') {
      this.ticker = play.publicDesc;
      if (play.kind === 'timeout' && this.scorebug && play.timeoutsBefore) this.scorebug = { ...this.scorebug, timeouts: play.timeoutsBefore };
      this.touch();
      return;
    }
    if (this.pendingPredict) this.revealPredict(play);
    const beat = await this.maybeBeat(gen, play);
    await this.runDirector(gen, play, beat);
  }

  // ---------------------------------------------------------------- storyline beats

  private async maybeBeat(gen: number, play: TimelinePlay): Promise<boolean> {
    const file = this.storylineFile();
    for (const p of this.connectedLearners) {
      if (!p.storyline) continue;
      const s = file.storylines.find((x) => x.id === p.storyline!.storylineId);
      if (!s) continue;
      const inv = involvement(play, s);
      if (!inv) continue;
      const key = `${p.id}:${play.qtr}`;
      if (this.beatsUsed.has(key)) continue;
      if (!this.scheduler.gapOk(this.now())) return false;
      this.beatsUsed.add(key);
      const facts = unlockedFacts(s, this.revealed);
      const newly = s.facts.filter((f) => f.revealAfter && play.momentKeys.includes(f.revealAfter) && facts.includes(f.text)).map((f) => f.text);
      const beat = await writeBeat(this.llm, p.name, play, inv, facts, newly);
      this.check(gen);
      this.setCard({ kind: 'storyline', title: `${first(p.name)}'s player`, body: beat.cardBody, by: 'Huddle', source: `Storyline · ${s.title}` });
      p.buzz = { id: nanoid(6), text: beat.line };
      p.log.push({ text: beat.cardBody, points: 50 });
      this.gameLog.push({ text: `${first(p.name)}'s player: ${beat.cardBody}`, weight: play.momentKeys.length ? 180 : 60 });
      this.touch();
      await this.speak(gen, beat.line, 'beat');
      this.scheduler.spoke({ now: this.now(), qtr: play.qtr, countsToBudget: false });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- Director

  private playerFacts(play: TimelinePlay): string[] {
    const names = new Set(Object.values(play.players));
    const out: string[] = [];
    for (const s of this.storylineFile().storylines) {
      if (!s.players.some((p) => p.pbpNames.some((n) => names.has(n)))) continue;
      out.push(...unlockedFacts(s, this.revealed));
    }
    return out.slice(0, 4);
  }

  /**
   * Game intelligence for this play's Director turn. Producers compute only from revealed data; the room still
   * drops facts it already said, and (defense in depth) anything naming an unannounced penalty.
   */
  private intelFor(play: TimelinePlay): DirectorInput['intel'] {
    if (!this.intel) return undefined;
    const stage = this.announcedIdx === play.idx ? 'announced' : 'result';
    const needles = stage === 'result' && play.penalty
      ? [play.penalty.rawType, play.penalty.conceptId, concept(play.penalty.conceptId, this.league).name].map((s) => s.toLowerCase())
      : [];
    const safe = (f: IntelFact) => !this.usedFactIds.has(f.id) && !needles.some((n) => f.text.toLowerCase().includes(n)) && this.fresh(f, play.qtr);
    try {
      const sit = this.intel.situation(this.game.timeline.plays, play.idx, stage);
      const facts = this.intel.retrieve({ entities: playEntities(play, stage), limit: 6, exclude: this.usedFactIds });
      const out = { situation: { ...sit, facts: sit.facts.filter(safe) }, facts: facts.filter(safe) };
      for (const f of [...out.situation.facts, ...out.facts]) this.offeredFacts.set(f.id, f);
      return out;
    } catch (e) {
      // Intel is an enhancement: a producer bug must not cost the family the rule explanation.
      console.error('[room] intel failed', e);
      return undefined;
    }
  }

  /**
   * Variety rules (the family found repetition tiresome): never two facts of the same kind in a row, at most one
   * win-probability swing per quarter, and at most two "was drafted by" bios per game, unless the fact is
   * exceptional (weight ≥ 0.9).
   */
  private fresh(f: IntelFact, qtr: number): boolean {
    if (f.weight >= 0.9) return true;
    const last = this.saidKinds[this.saidKinds.length - 1];
    if (last && last.kind === f.kind) return false;
    if (f.kind === 'win_prob' && this.saidKinds.some((k) => k.kind === 'win_prob' && k.qtr === qtr)) return false;
    if (/\bdrafted\b/i.test(f.text) && this.saidKinds.filter((k) => k.draft).length >= 2) return false;
    return true;
  }

  /** The Director's input for a play, or null when there is nobody to talk to or nothing to consider. */
  private directorInput(play: TimelinePlay): DirectorInput | null {
    const trigger = triggerFor(play);
    const learners = this.connectedLearners;
    if (!learners.length) return null;
    const candidates = candidatesFor(play, learners.map((l) => l.knowledge), trigger);
    // With intel, a play with no open rules can still earn an insight; directorTurn decides (without a model call
    // when nothing qualifies).
    if (!candidates.length && !this.intel) return null;
    const handoffs: Record<string, string[]> = {};
    for (const c of candidates) {
      const ids = handoffCandidates(learners.map((l) => ({ id: l.id, knowledge: l.knowledge })), c.conceptId);
      if (ids.length) handoffs[c.conceptId] = ids;
    }
    const names = Object.fromEntries([...this.players.values()].map((p) => [p.id, first(p.name)]));
    return {
      play, trigger, candidates, handoffs, names,
      playerFacts: this.playerFacts(play),
      recentLines: this.spokenLog.filter((l) => l.kind === 'explain' || l.kind === 'short' || l.kind === 'beat' || l.kind === 'insight').slice(-5).map((l) => l.text),
      budget: { remainingThisQuarter: this.scheduler.remaining(play.qtr), exempt: trigger !== 'play' },
      announced: true,
      league: this.league, teams: this.game.timeline.teams,
      intel: this.intelFor(play),
    };
  }

  /**
   * With a real model and game intelligence, the Director needs ~5-6 s (it reasons over the facts). Start its call
   * when the play's result is shown, so it runs during the field animation; dead time then waits at most 4 s (F6).
   * Flagged plays wait for the announcement instead (the call must not happen before it).
   */
  private directorPrefetch: { idx: number; promise: Promise<DirectorDecision> } | null = null;

  /** Resolve with `p`, or with `fallback()` if it takes longer than `ms` (on the room's clock). */
  private within<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
      const t = this.clock.setTimeout(() => resolve(fallback()), ms);
      p.then((v) => { this.clock.clearTimeout(t); resolve(v); }, () => { this.clock.clearTimeout(t); resolve(fallback()); });
    });
  }

  private prefetchDirector(play: TimelinePlay) {
    this.directorPrefetch = null;
    if (!this.intel || this.llm.isMock || play.penalty) return;
    const input = this.directorInput(play);
    if (!input) return;
    const promise = directorTurn(this.llm, input, this.game.timeline.home, this.game.timeline.away, 10_000);
    promise.catch(() => undefined);
    this.directorPrefetch = { idx: play.idx, promise };
  }

  private async runDirector(gen: number, play: TimelinePlay, afterBeat: boolean) {
    const trigger = triggerFor(play);
    const pre = this.directorPrefetch?.idx === play.idx ? this.directorPrefetch.promise : null;
    this.directorPrefetch = null;
    // Live: when the feed is running ahead of us, keep up rather than explain everyday plays.
    if (this.live && trigger === 'play' && this.live.status().queued >= 3) return;
    const verdict = this.scheduler.canSpeak({ trigger, now: this.now(), qtr: play.qtr, windowOpen: this.windowsOpen > 0 });
    if (!verdict.ok) return;
    // Flags and decisions always get their explanation (F4, F5); they wait out the minimum gap instead
    // (e.g. after a storyline beat on the same play, like Hurts' two-point try).
    void afterBeat;
    const input = this.directorInput(play);
    if (!input) return;
    const { home, away } = this.game.timeline;
    const decision = pre
      ? await this.within(pre, this.win(4000), () => templateTurn({ ...input, home, away }))
      : await directorTurn(this.llm, input, home, away);
    this.check(gen);
    if (decision.action === 'silent') return;
    // A cited fact is never said twice in this room, whoever ends up saying the line.
    for (const id of decision.cites ?? []) {
      this.usedFactIds.add(id);
      const f = this.offeredFacts.get(id);
      if (f) this.saidKinds.push({ kind: f.kind, qtr: play.qtr, draft: /\bdrafted\b/i.test(f.text) });
    }
    // Re-check after the model call: the remaining gap has shrunk while it was thinking.
    const again = this.scheduler.canSpeak({ trigger, now: this.now(), qtr: play.qtr, windowOpen: this.windowsOpen > 0 });
    if (again.ok && again.waitMs > 0) await this.pause(gen, again.waitMs);

    if (decision.action === 'insight') {
      await this.flowInsight(gen, play, trigger, decision);
      this.touch();
      return;
    }

    // Grounded detail: after a flag, the card may carry one unlocked quote about the flagged player
    // (e.g. Bradberry's), whether the card came from the model or the template.
    if (trigger === 'penalty' && play.penalty?.player) {
      const fact = this.playerFacts(play).find((f) => f.includes(lastName(play.penalty!.player!)) && f.includes('"'));
      if (fact && !decision.card.body.includes(fact) && decision.card.body.length + fact.length < 279) decision.card = { ...decision.card, body: `${decision.card.body} ${fact}` };
    }

    const target = decision.action === 'handoff' && decision.handoffTo ? this.players.get(decision.handoffTo) : undefined;
    if (target && target.connected) await this.flowHandoff(gen, play, trigger, decision, target);
    else await this.flowExplain(gen, play, trigger, decision);
    // Everyone connected now (after the explanation) was in the room for it.
    for (const p of this.connectedLearners) addExposure(p.knowledge, decision.conceptId);
    this.knowledgeChanged();
    this.touch();
  }

  /**
   * An insight is color, not a rule: Huddle says it directly (no take-it offer, nothing for the fan to teach) and
   * nobody gets a concept exposure. It uses the talk budget and gap exactly like an explanation.
   */
  private async flowInsight(gen: number, play: TimelinePlay, trigger: Trigger, decision: InsightDecision) {
    this.setCard({ kind: 'explain', title: decision.card.title, body: decision.card.body, by: 'Huddle', source: decision.sourceNote });
    await this.speak(gen, decision.spoken, 'insight', 1, trigger);
    this.scheduler.spoke({ now: this.now(), qtr: play.qtr, countsToBudget: trigger === 'play' });
  }

  private explainCard(decision: Extract<DirectorDecision, { action: 'explain' | 'handoff' }>, by: string, kind: SnapshotCard['kind'] = 'explain'): Omit<SnapshotCard, 'id'> {
    const c = concept(decision.conceptId, this.league);
    return { kind, title: decision.card.title, body: decision.card.body, by, source: sourceLine(c) };
  }

  private async huddleSays(gen: number, play: TimelinePlay, trigger: Trigger, text: string, decision: Extract<DirectorDecision, { action: 'explain' | 'handoff' }>, kind: 'explain' | 'short', followUp = false) {
    this.setCard(this.explainCard(decision, 'Huddle'));
    await this.speak(gen, text, kind, 1, trigger, followUp);
    this.scheduler.spoke({ now: this.now(), qtr: play.qtr, countsToBudget: trigger === 'play' && !followUp });
  }

  private async flowExplain(gen: number, play: TimelinePlay, trigger: Trigger, decision: Extract<DirectorDecision, { action: 'explain' | 'handoff' }>) {
    const fan = this.connectedFan;
    if (fan) {
      const id = nanoid(8);
      const accepted = await this.ask<boolean>(fan, { id, kind: 'takeit', title: decision.card.title, cheat: decision.cheat, closesAt: this.now() + this.win(WINDOWS.takeItMs) }, this.win(WINDOWS.takeItMs));
      this.check(gen);
      this.events.onOffer?.({ kind: 'takeit', playerId: fan.id, conceptId: decision.conceptId, accepted: accepted === true });
      if (accepted === true) {
        await this.humanExplain(gen, play, trigger, fan, decision);
        return;
      }
    }
    await this.huddleSays(gen, play, trigger, decision.spoken, decision, 'explain');
  }

  private async flowHandoff(gen: number, play: TimelinePlay, trigger: Trigger, decision: Extract<DirectorDecision, { action: 'explain' | 'handoff' }>, learner: Player) {
    const c = concept(decision.conceptId);
    const others = this.connectedLearners.filter((l) => l.id !== learner.id && levelRank(levelOf(l.knowledge, decision.conceptId)) < levelRank(levelOf(learner.knowledge, decision.conceptId)));
    const othersText = others.map((o) => first(o.name)).join(' and ') || 'the room';
    const id = nanoid(8);
    const accepted = await this.ask<boolean>(learner, { id, kind: 'handoff', title: c.name, cheat: decision.cheat, others: othersText, closesAt: this.now() + this.win(WINDOWS.handoffMs) }, this.win(WINDOWS.handoffMs));
    this.check(gen);
    this.events.onOffer?.({ kind: 'handoff', playerId: learner.id, conceptId: decision.conceptId, accepted: accepted === true });
    if (accepted === true) {
      await this.humanExplain(gen, play, trigger, learner, decision);
      return;
    }
    await this.huddleSays(gen, play, trigger, decision.shortSpoken, decision, 'short');
  }

  private async humanExplain(gen: number, play: TimelinePlay, trigger: Trigger, who: Player, decision: Extract<DirectorDecision, { action: 'explain' | 'handoff' }>) {
    const skipsAtStart = this.skips;
    this.explaining = { playerId: who.id, name: first(who.name) };
    this.setCard(this.explainCard(decision, first(who.name), 'human'));
    await this.ask<boolean>(who, { id: nanoid(8), kind: 'done', title: decision.card.title, cheat: decision.cheat, closesAt: this.now() + this.win(WINDOWS.humanExplainMaxMs) }, this.win(WINDOWS.humanExplainMaxMs));
    this.check(gen);
    this.explaining = null;
    const { points, assist } = explainPoints(who.role);
    who.points += points;
    if (assist) who.assists++;
    who.explanations++;
    if (who.role === 'learner') {
      markExplained(who.knowledge, decision.conceptId);
      addRecall(who.knowledge, decision.conceptId);
    }
    const cname = concept(decision.conceptId).name;
    who.log.push({ text: `Explained ${cname} to the family`, points: points || 100 });
    this.gameLog.push({ text: `${first(who.name)} explained ${cname} to the family (Q${play.qtr} ${play.clock}).`, weight: who.role === 'learner' ? 220 : 120 });
    this.scheduler.spoke({ now: this.now(), qtr: play.qtr, countsToBudget: trigger === 'play' });
    this.touch();

    // Host pressed Next during the explanation: don't open a second round of prompts.
    if (this.skips !== skipsAtStart) return;
    const listeners = this.connectedLearners.filter((l) => l.id !== who.id);
    const answers = await Promise.all(listeners.map((l) =>
      this.ask<'got_it' | 'confused'>(l, { id: nanoid(8), kind: 'feedback', title: decision.card.title, by: first(who.name), closesAt: this.now() + this.win(WINDOWS.feedbackMs) }, this.win(WINDOWS.feedbackMs))));
    this.check(gen);
    if (answers.includes('confused')) {
      await this.huddleSays(gen, play, trigger, decision.shortSpoken, decision, 'short', true);
    }
  }

  // ---------------------------------------------------------------- halftime, final, recap

  private scoreLine(score: { home: number; away: number }): string {
    const g = this.game.timeline;
    const h = this.team(g.home).city;
    const a = this.team(g.away).city;
    if (score.home === score.away) return `${a} and ${h} are tied ${score.home} to ${score.away}`;
    return score.home > score.away ? `${h} leads ${score.home} to ${score.away}` : `${a} leads ${score.away} to ${score.home}`;
  }

  private async onHalftime(gen: number) {
    this.phase = 'halftime';
    this.revealed.add('halftime');
    const score = this.scorebug ? { home: this.scorebug.home, away: this.scorebug.away } : { home: 0, away: 0 };
    const facts = this.storylineFile().gameFacts.filter((f) => (f.verified || process.env.ALLOW_UNVERIFIED_FACTS === 'true') && (f.revealAfter === null || this.revealed.has(f.revealAfter))).map((f) => f.text);
    this.halftime = { score: this.scoreLine(score), facts };
    this.setCard({ kind: 'halftime', title: 'Halftime', body: `${this.scoreLine(score)}.`, by: 'Huddle' });
    const leader = this.standings()[0];
    const lp = leader ? this.players.get(leader.id) : undefined;
    const line = `Halftime. ${this.scoreLine(score)}.${lp && lp.points > 0 ? ` In the family, ${first(lp.name)} is in front.` : ''}`;
    await this.speak(gen, line, 'halftime');
  }

  private async onFinal(gen: number) {
    this.phase = 'final';
    this.revealed.add('final');
    this.round = null;
    const last = this.game.timeline.plays[this.game.timeline.plays.length - 1];
    if (last) this.scorebug = { ...this.scorebugFor(last, last.scoreAfter), clock: '0:00', possession: null, downDistance: null, ballOn: null };
    const f = this.game.timeline.finalScore;
    const g = this.game.timeline;
    const winner = f.home === f.away ? null : f.home > f.away ? this.team(g.home).city : this.team(g.away).city;
    const hi = Math.max(f.home, f.away);
    const lo = Math.min(f.home, f.away);
    this.ticker = winner ? `Final: ${winner} wins ${hi}–${lo}.` : `Final: tied ${hi}–${lo}.`;
    this.setCard({ kind: 'summary', title: 'Final', body: this.ticker, by: 'Huddle' });
    this.touch();
    const started = this.now();
    const recapPromise = this.makeRecap();
    await this.speak(gen, winner ? `That's the game! ${winner} wins, ${hi} to ${lo}.` : `That's the game. It ends in a tie.`, 'final');
    this.recap = await recapPromise;
    this.check(gen);
    this.recapMs = this.now() - started;
    this.phase = 'recap';
    this.saveFamily(true);
    this.touch();
  }

  recapMs = 0;

  private async makeRecap(): Promise<FamilyRecap> {
    const f = this.game.timeline.finalScore;
    const g = this.game.timeline;
    const finalScore = `${g.away} ${f.away}, ${g.home} ${f.home}`;
    const standings = this.standings();
    const people: PersonStats[] = [...this.players.values()].map((p) => ({
      playerId: p.id, name: p.name, color: p.color, role: p.role,
      points: p.points, rank: standings.find((s) => s.id === p.id)?.rank ?? 1,
      predict: { correct: p.predictCorrect, total: p.predictTotal },
      callIt: { correct: p.callItCorrect, total: p.callItTotal },
      explanationsGiven: p.explanations,
      learnedTonight: p.role === 'learner' ? learnedSince(p.knowledgeStart, p.knowledge).map((id) => concept(id).name) : [],
      rulesKnown: p.role === 'learner' ? countKnown(p.knowledge) : 0,
      assists: p.assists, log: p.log,
    }));
    return buildRecap(this.llm, { familyName: this.settings.familyName, gameTitle: g.title, finalScore, people, gameLog: this.gameLog });
  }

  // ---------------------------------------------------------------- season memory

  private knowledgeChanged() {
    if (!this.family || !this.families || this.presetId) return;
    if (this.familySaveTimer) this.clock.clearTimeout(this.familySaveTimer);
    this.familySaveTimer = this.clock.setTimeout(() => { this.familySaveTimer = null; this.saveFamily(false); }, 2000);
  }

  private saveFamily(final: boolean) {
    if (!this.family || !this.families || this.presetId) return;
    for (const p of this.players.values()) {
      if (p.role !== 'learner') continue;
      const key = p.name.toLowerCase();
      const prev = this.family.players[key] ?? { knowledge: {}, lifetimePoints: 0, games: 0 };
      this.family.players[key] = {
        knowledge: p.knowledge,
        lifetimePoints: final ? prev.lifetimePoints + p.points : prev.lifetimePoints,
        games: final ? prev.games + 1 : prev.games,
      };
    }
    if (final) this.family.games.push({ gameId: this.game.timeline.gameId, date: new Date(this.now()).toISOString().slice(0, 10) });
    this.families.save(this.family);
  }

  // ---------------------------------------------------------------- misc

  /** Watchdog: describe a live game whose engine has been quiet for longer than `ms` (null if healthy). */
  stallReport(ms: number): string | null {
    if (this.phase !== 'live' || this.engine.paused || !this.started) return null;
    if (this.live && this.game.timeline.plays.length === 0) return null; // waiting for the feed's first play, not stalled
    const quiet = this.now() - this.lastEngine.at;
    if (quiet < ms) return null;
    return `quiet ${Math.round(quiet / 1000)}s after "${this.lastEngine.what}"; windows open ${this.windowsOpen}; prompts pending ${this.pendingPrompts.size}; speech pending ${this.pendingSpeech.size}; TVs ${this.tvCount}`;
  }

  /** Simulation only: the concept behind the open Call It round. Never sent to clients. */
  simRoundConcept(promptId: string): string | null {
    const r = this.round;
    if (!r || r.id !== promptId || r.kind !== 'callit' || r.playIdx < 0) return null; // camera rounds: answer not known yet
    return this.game.timeline.plays[r.playIdx].penalty?.conceptId ?? null;
  }

  /** Simulation only (server-side bots): the correct option of the open round, if known. Never sent to clients. */
  simCorrectOption(promptId: string): string | null {
    const r = this.round;
    if (!r || r.id !== promptId || r.playIdx < 0) return null;
    const play = this.game.timeline.plays[r.playIdx];
    if (r.kind === 'callit') return this.callItRounds.get(r.playIdx)?.correctOptionId ?? null;
    const res = resolvePredict(play);
    return res.voided ? null : res.correctOptionId;
  }

  /** For simulate/tests: situation text used by the Director. */
  situationOf(play: TimelinePlay) { return situation(play, this.game.timeline.home, this.game.timeline.away, this.game.timeline.teams); }

  dispose() {
    this.live?.stop();
    this.gen++;
    this.engine.stop();
    this.cancelPrompts();
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer);
    if (this.familySaveTimer) this.clock.clearTimeout(this.familySaveTimer);
  }
}
