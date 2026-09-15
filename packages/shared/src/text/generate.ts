import { hashString } from '../ids';
import type { Lexeme, Lexicon, RandomTextOptions, WordType } from '../types/text';
import { followWeight, type FollowFrom } from './grammar';
import { buildLexiconIndex, type LexiconIndex } from './lexicon';
import {
  SENTENCE_END,
  countCharacters,
  isSentenceEnd,
  countWordTokens,
  makeToken,
  renderTokens,
  tokenize,
  type TextToken,
} from './tokenize';

/** Tokens the generator may replace, insert or remove. */
function isEditable(token: TextToken): boolean {
  return token.kind === 'word' || token.kind === 'number';
}

/* ------------------------------------------------------------------ *
 * Randomness
 * ------------------------------------------------------------------ */

/**
 * Seeded PRNG (mulberry32). Every run is reproducible from its seed, which is
 * what lets the graph treat this flow like any other: the same inputs and
 * options generate the same text, so it only goes stale when something real
 * changed. Rerolling is changing the seed, which is an edit you can see.
 */
export function createRng(seed: string): () => number {
  let state = Number.parseInt(hashString(seed), 16) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/** How many candidates are scored per pick, once the database is large. */
const POOL_LIMIT = 400;
/** How far back a repeat is still discouraged, and how hard at the nearest step. */
const REPEAT_WINDOW = 6;
const REPEAT_PENALTY = 0.1;

export interface PickContext {
  index: LexiconIndex;
  options: RandomTextOptions;
  /** Resolved lexemes for the preceding tokens, most recent last. */
  history: Array<Lexeme | undefined>;
  /** Type of the token immediately before, or `start` at a sentence boundary. */
  previousType: FollowFrom | undefined;
  /** Words emitted since the last sentence-ending token. */
  wordsInSentence: number;
  /** When set, candidates of this word type are preferred (used when altering). */
  desiredType?: WordType;
  /**
   * The type of the token that will follow. Set when writing into the middle of
   * existing text, so a replacement or an insertion fits on both sides rather
   * than only reading well from the left.
   */
  nextType?: WordType;
  /** Lexeme ids that must not be picked, e.g. the word being replaced. */
  forbid?: Set<string>;
  /**
   * The last few lexemes for the repeat penalty. Separate from `history`
   * because the context window can be shorter than we want to look back for
   * repeats.
   */
  recent?: Array<Lexeme | undefined>;
}

/**
 * The pull the preceding tokens exert on a candidate. Each step back through the
 * window counts for less (`contextDecay`), and a context read backwards —
 * `tree` listing `apple` rather than the other way round — counts for
 * `contextSymmetry` of the forward weight.
 */
export function contextPull(candidate: Lexeme, ctx: PickContext): number {
  const { options, index, history } = ctx;
  const window = Math.max(0, Math.floor(options.contextWindow));
  let pull = 0;
  let norm = 0;

  for (let back = 0; back < window && back < history.length; back += 1) {
    const previous = history[history.length - 1 - back];
    const decay = options.contextDecay ** back;
    norm += decay;
    if (!previous) continue;
    const forward = index.forward.get(previous.id)?.get(candidate.id) ?? 0;
    const reverse = index.forward.get(candidate.id)?.get(previous.id) ?? 0;
    pull += decay * Math.max(forward, reverse * options.contextSymmetry);
  }

  return norm > 0 ? pull / norm : 0;
}

/** Punctuation is shaped by how far into a sentence we are, not by context. */
function punctuationShape(candidate: Lexeme, ctx: PickContext): number {
  if (candidate.type !== 'punctuation') return 1;
  // Never two marks in a row, and never a mark to open a sentence.
  if (ctx.previousType === 'punctuation' || ctx.previousType === 'start') return 0;
  const target = Math.max(3, ctx.options.sentenceLength);
  const progress = ctx.wordsInSentence / target;

  if (SENTENCE_END.has(candidate.spelling[0] ?? '')) {
    if (ctx.wordsInSentence < 3) return 0;
    return Math.min(2.5, progress ** 2.2);
  }
  // A comma wants the middle of a clause.
  return Math.min(1.4, progress * (1 - Math.min(1, progress) * 0.5)) * 0.9;
}

/** Frequency is the prior, context multiplies it, grammar filters it. */
const FREQUENCY_EXPONENT_RANGE = [0.4, 3] as const;
const MAX_CONTEXT_GAIN = 14;
const MAX_GRAMMAR_EXPONENT = 3;

export function scoreCandidate(candidate: Lexeme, ctx: PickContext): number {
  const { options } = ctx;
  if (ctx.forbid?.has(candidate.id)) return 0;

  // `frequencyBias` slides between two readings of the database: at 0 every
  // word is equally likely to be reached and context decides everything; at 1
  // the common words win and context is ignored.
  const exponent =
    FREQUENCY_EXPONENT_RANGE[0] +
    (FREQUENCY_EXPONENT_RANGE[1] - FREQUENCY_EXPONENT_RANGE[0]) * options.frequencyBias;
  const gain = MAX_CONTEXT_GAIN * (1 - options.frequencyBias);

  const prior = Math.max(0.001, candidate.frequency) ** exponent;
  const pull = contextPull(candidate, ctx);
  const grammar =
    followWeight(ctx.previousType, candidate.type) ** (options.grammarBias * MAX_GRAMMAR_EXPONENT);

  let score = prior * (1 + gain * pull) * grammar * punctuationShape(candidate, ctx);

  if (ctx.nextType) {
    score *= followWeight(candidate.type, ctx.nextType) ** (options.grammarBias * MAX_GRAMMAR_EXPONENT);
  }

  if (ctx.desiredType && candidate.type !== ctx.desiredType) {
    // Replacing a word usually wants the same part of speech back.
    score *= (1 - options.grammarBias) ** 2;
  }

  // Saying the same word again so soon is the fastest way to sound generated,
  // so a repeat is penalised on a sliding scale across the last few tokens.
  const recent = ctx.recent ?? ctx.history;
  for (let back = 0; back < REPEAT_WINDOW && back < recent.length; back += 1) {
    if (recent[recent.length - 1 - back]?.id !== candidate.id) continue;
    score *= REPEAT_PENALTY + (1 - REPEAT_PENALTY) * (back / REPEAT_WINDOW);
    break;
  }

  return score;
}

/** Candidates worth scoring: everything the history points at, plus the common words. */
function candidatePool(ctx: PickContext): Lexeme[] {
  const { index, options } = ctx;
  if (index.byId.size <= POOL_LIMIT) return [...index.byId.values()];

  const pool = new Map<string, Lexeme>();
  const window = Math.max(1, Math.floor(options.contextWindow));
  for (const previous of ctx.history.slice(-window)) {
    if (!previous) continue;
    for (const id of index.forward.get(previous.id)?.keys() ?? []) {
      const lexeme = index.byId.get(id);
      if (lexeme) pool.set(id, lexeme);
    }
    for (const id of index.backward.get(previous.id)?.keys() ?? []) {
      const lexeme = index.byId.get(id);
      if (lexeme) pool.set(id, lexeme);
    }
  }
  const common = [...index.byId.values()]
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, POOL_LIMIT - pool.size);
  for (const lexeme of common) pool.set(lexeme.id, lexeme);
  return [...pool.values()];
}

/**
 * Pick the next lexeme. `pickTemperature` reshapes the scores before the draw:
 * at 0 the best candidate always wins, at 1 the draw is straight proportional to
 * score, and in between it is somewhere along that line.
 */
export function pickNext(ctx: PickContext, rng: () => number): Lexeme | undefined {
  const candidates = candidatePool(ctx);
  const exponent = 1 / Math.max(0.02, Math.min(1, ctx.options.pickTemperature));

  let total = 0;
  const weights: number[] = [];
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, ctx);
    const weight = score > 0 ? score ** exponent : 0;
    weights.push(weight);
    total += weight;
  }

  if (total <= 0) {
    // Nothing scored: fall back to the most common word that is allowed here.
    return candidates
      .filter((candidate) => !ctx.forbid?.has(candidate.id) && candidate.type !== 'punctuation')
      .sort((a, b) => b.frequency - a.frequency)[0];
  }

  let roll = rng() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    roll -= weights[i]!;
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/* ------------------------------------------------------------------ *
 * Running the flow
 * ------------------------------------------------------------------ */

export type TokenOrigin = 'kept' | 'replaced' | 'added';

export interface OutputToken extends TextToken {
  origin: TokenOrigin;
}

export interface LengthPlan {
  metric: 'words' | 'characters';
  target: number;
  /** How far either side of the target a run may land. */
  tolerance: number;
}

export interface RunStats {
  mode: RandomTextOptions['mode'];
  seed: string;
  inputWords: number;
  inputCharacters: number;
  outputWords: number;
  outputCharacters: number;
  wordChangePercent: number;
  charChangePercent: number;
  plan: LengthPlan | null;
  /** Whether the result landed inside the tolerance band. */
  onTarget: boolean;
  replaced: number;
  added: number;
  removed: number;
  /** Input words that are not in the database, so nothing could be read from them. */
  unknownWords: string[];
}

export interface RunResult {
  text: string;
  tokens: OutputToken[];
  stats: RunStats;
  warnings: string[];
}

export interface RunInput {
  input: string;
  options: RandomTextOptions;
  lexicon: Lexicon;
}

function resolve(token: TextToken, index: LexiconIndex): Lexeme | undefined {
  return index.bySpelling.get(token.key)?.[0];
}

function measure(tokens: TextToken[], metric: LengthPlan['metric']): number {
  return metric === 'words' ? countWordTokens(tokens) : countCharacters(tokens);
}

/** Turn the five length controls into one target and a tolerance band. */
export function planLength(
  options: RandomTextOptions,
  inputTokens: TextToken[],
  warnings: string[],
): LengthPlan | null {
  const { length } = options;
  const inputWords = countWordTokens(inputTokens);
  const inputCharacters = countCharacters(inputTokens);

  let metric: LengthPlan['metric'] = 'words';
  let target: number;

  switch (length.mode) {
    case 'keep':
      return null;
    case 'words':
      target = Math.max(1, Math.round(length.words));
      break;
    case 'characters':
      metric = 'characters';
      target = Math.max(1, Math.round(length.characters));
      break;
    case 'wordPercent':
      if (inputWords === 0) {
        warnings.push('No input text to take a percentage of — using the word count target instead.');
        target = Math.max(1, Math.round(length.words));
      } else {
        target = Math.max(1, Math.round(inputWords * (1 + length.wordPercent / 100)));
      }
      break;
    default:
      metric = 'characters';
      if (inputCharacters === 0) {
        warnings.push('No input text to take a percentage of — using the character count target instead.');
        target = Math.max(1, Math.round(length.characters));
      } else {
        target = Math.max(1, Math.round(inputCharacters * (1 + length.charPercent / 100)));
      }
      break;
  }

  const tolerance = Math.round(target * Math.max(0, Math.min(1, length.temperature)) * 0.5);
  return { metric, target, tolerance };
}

function buildContext(
  tokens: TextToken[],
  upto: number,
  index: LexiconIndex,
  options: RandomTextOptions,
): Pick<PickContext, 'history' | 'previousType' | 'wordsInSentence' | 'recent'> {
  // Context looks through punctuation: a comma should not use up a slot in the
  // window that a word could have filled.
  const window = Math.max(1, Math.floor(options.contextWindow));
  const history: Array<Lexeme | undefined> = [];
  for (let i = upto - 1; i >= 0 && history.length < window; i -= 1) {
    const token = tokens[i]!;
    if (!isEditable(token)) continue;
    history.unshift(resolve(token, index));
  }

  // Look past a line break for the token that actually precedes this one.
  let previous: TextToken | undefined;
  for (let i = upto - 1; i >= 0; i -= 1) {
    if (tokens[i]!.kind === 'break') continue;
    previous = tokens[i];
    break;
  }

  let wordsInSentence = 0;
  for (let i = upto - 1; i >= 0; i -= 1) {
    const token = tokens[i]!;
    if (isSentenceEnd(token) || token.text === '\n\n') break;
    if (isEditable(token)) wordsInSentence += 1;
  }

  const previousType: FollowFrom | undefined = !previous
    ? 'start'
    : isSentenceEnd(previous)
      ? 'start'
      : previous.kind === 'punctuation'
        ? 'punctuation'
        : (resolve(previous, index)?.type ?? (previous.kind === 'number' ? 'number' : 'noun'));

  const recent: Array<Lexeme | undefined> = [];
  for (let i = upto - 1; i >= 0 && recent.length < REPEAT_WINDOW; i -= 1) {
    const token = tokens[i]!;
    if (!isEditable(token)) continue;
    recent.unshift(resolve(token, index));
  }

  return { history, previousType, wordsInSentence, recent };
}

/** Word type of the token at `at`, for fitting a word into a gap. */
function typeAt(tokens: TextToken[], at: number, index: LexiconIndex): WordType | undefined {
  const token = tokens[at];
  if (!token) return undefined;
  if (token.kind === 'punctuation') return 'punctuation';
  return resolve(token, index)?.type ?? (token.kind === 'number' ? 'number' : undefined);
}

function tokenFor(lexeme: Lexeme): OutputToken {
  const kind = lexeme.type === 'punctuation' ? 'punctuation' : lexeme.type === 'number' ? 'number' : 'word';
  return { ...makeToken(lexeme.spelling, kind), origin: 'added' };
}

/** Write new text until the plan says to stop. */
function generateTokens(
  index: LexiconIndex,
  options: RandomTextOptions,
  plan: LengthPlan | null,
  rng: () => number,
  warnings: string[],
): OutputToken[] {
  const tokens: OutputToken[] = [];
  if (index.byId.size === 0) {
    warnings.push('The word database is empty, so there is nothing to write with.');
    return tokens;
  }

  const target = plan?.target ?? 80;
  const metric = plan?.metric ?? 'words';
  const tolerance = plan?.tolerance ?? 0;
  // `length temperature` buys freedom to land anywhere in the band; the run
  // picks one point in it and writes to that.
  const goal = Math.max(1, target + Math.round((rng() * 2 - 1) * tolerance));
  const ceiling = target + tolerance;

  const next = (): boolean => {
    const before = measure(tokens, metric);
    const ctx: PickContext = {
      index,
      options,
      ...buildContext(tokens, tokens.length, index, options),
    };
    const lexeme = pickNext(ctx, rng);
    if (!lexeme) return false;
    tokens.push(tokenFor(lexeme));
    // A word is several characters, so the last one can overshoot a character
    // goal. Keep it only if stopping short would miss by more.
    if (metric === 'characters') {
      const after = measure(tokens, metric);
      if (after > goal && after - goal > goal - before) {
        tokens.pop();
        return false;
      }
    }
    return true;
  };

  let guard = 0;
  while (measure(tokens, metric) < goal && guard < 4000) {
    guard += 1;
    if (!next()) break;
  }

  // Finish the sentence rather than stopping mid-clause, while there is room.
  while (measure(tokens, metric) < ceiling && guard < 4000) {
    if (isSentenceEnd(tokens[tokens.length - 1])) break;
    guard += 1;
    if (!next()) break;
  }

  closeSentence(tokens);

  // Closing the sentence can tip a tight band; drop trailing words until it fits.
  while (measure(tokens, metric) > ceiling && tokens.length > 1) {
    const withoutFullStop = tokens[tokens.length - 1]?.text === '.' ? 2 : 1;
    tokens.splice(tokens.length - withoutFullStop, withoutFullStop);
    closeSentence(tokens);
  }

  return tokens;
}

function closeSentence(tokens: OutputToken[]): void {
  while (tokens.length > 0 && tokens[tokens.length - 1]!.kind === 'break') tokens.pop();
  const last = tokens[tokens.length - 1];
  if (!last) return;
  if (isSentenceEnd(last)) return;
  if (last.kind === 'punctuation') tokens.pop();
  tokens.push({ ...makeToken('.', 'punctuation'), origin: 'added' });
}

/** Replace some share of the words, in place, reading the context around each one. */
function alterTokens(
  tokens: OutputToken[],
  index: LexiconIndex,
  options: RandomTextOptions,
  rng: () => number,
): number {
  const share = Math.max(0, Math.min(1, options.alterTemperature));
  if (share === 0) return 0;
  let replaced = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!isEditable(token)) continue;
    if (rng() >= share) continue;

    const current = resolve(token, index);
    const nextType = typeAt(tokens, i + 1, index);
    const ctx: PickContext = {
      index,
      options,
      ...buildContext(tokens, i, index, options),
      ...(current ? { desiredType: current.type } : {}),
      ...(current ? { forbid: new Set([current.id]) } : {}),
      ...(nextType ? { nextType } : {}),
    };
    const next = pickNext(ctx, rng);
    if (!next || next.type === 'punctuation') continue;

    tokens[i] = { ...tokenFor(next), origin: 'replaced' };
    replaced += 1;
  }

  return replaced;
}

/** How readily a word can be dropped when the text has to get shorter. */
const DELETION_APPETITE: Record<WordType, number> = {
  adverb: 1,
  adjective: 0.9,
  interjection: 0.8,
  number: 0.5,
  noun: 0.4,
  verb: 0.25,
  preposition: 0.2,
  conjunction: 0.2,
  determiner: 0.15,
  pronoun: 0.15,
  punctuation: 0,
};

function fitLength(
  tokens: OutputToken[],
  index: LexiconIndex,
  options: RandomTextOptions,
  plan: LengthPlan,
  rng: () => number,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  // The tolerance decides where inside the band to aim; the run then goes for
  // that number exactly. Letting it stop anywhere within tolerance *of the
  // goal* would double the band and miss the target the caller asked for.
  const goal = plan.target + Math.round((rng() * 2 - 1) * plan.tolerance);
  let guard = 0;
  let best = Number.POSITIVE_INFINITY;
  let stalled = 0;

  while (guard < 600) {
    guard += 1;
    const current = measure(tokens, plan.metric);
    const distance = goal - current;
    if (distance === 0) break;

    // Words are a coarse unit for a character target, so give up once the
    // distance stops shrinking rather than thrashing around the goal.
    if (Math.abs(distance) < best) {
      best = Math.abs(distance);
      stalled = 0;
    } else if ((stalled += 1) > 24) {
      break;
    }

    if (distance > 0) {
      // Grow: insert a word that fits where it lands.
      const at = Math.max(1, Math.min(tokens.length, Math.floor(rng() * (tokens.length + 1))));
      const nextType = typeAt(tokens, at, index);
      const ctx: PickContext = {
        index,
        options,
        ...buildContext(tokens, at, index, options),
        ...(nextType ? { nextType } : {}),
      };
      const next = pickNext(ctx, rng);
      if (!next || next.type === 'punctuation') continue;
      tokens.splice(at, 0, { ...tokenFor(next), origin: 'added' });
      added += 1;
    } else {
      // Shrink: drop the word that costs the least, modifiers first.
      const candidates = tokens
        .map((token, position) => ({ token, position }))
        .filter(({ token }) => isEditable(token))
        .map(({ token, position }) => {
          const lexeme = resolve(token, index);
          const appetite = lexeme ? DELETION_APPETITE[lexeme.type] : 0.6;
          return { position, weight: appetite };
        })
        .filter((candidate) => candidate.weight > 0);
      if (candidates.length === 0) break;

      const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
      let roll = rng() * total;
      let chosen = candidates[candidates.length - 1]!;
      for (const candidate of candidates) {
        roll -= candidate.weight;
        if (roll <= 0) {
          chosen = candidate;
          break;
        }
      }
      tokens.splice(chosen.position, 1);
      removed += 1;
    }
  }

  return { added, removed };
}

/**
 * Run the flow: either write new text from the database, or rewrite the text
 * that came in — changing some share of its words and pulling its length towards
 * the target.
 */
export function runRandomText({ input, options, lexicon }: RunInput): RunResult {
  const warnings: string[] = [];
  const index = buildLexiconIndex(lexicon);
  const rng = createRng(options.seed || 'vibetoon');

  const inputTokens = tokenize(input);
  const inputWords = countWordTokens(inputTokens);
  const inputCharacters = countCharacters(inputTokens);
  const plan = planLength(options, inputTokens, warnings);

  let tokens: OutputToken[];
  let replaced = 0;
  let added = 0;
  let removed = 0;

  if (options.mode === 'alter' && inputTokens.length > 0) {
    tokens = inputTokens.map((token) => ({ ...token, origin: 'kept' as TokenOrigin }));
    replaced = alterTokens(tokens, index, options, rng);
    if (plan) {
      const fitted = fitLength(tokens, index, options, plan, rng);
      added = fitted.added;
      removed = fitted.removed;
      // Growing or trimming can leave the text hanging mid-clause.
      closeSentence(tokens);
    }
  } else {
    if (options.mode === 'alter') {
      warnings.push('Nothing came in to alter, so this run wrote new text instead.');
    }
    tokens = generateTokens(index, options, plan, rng, warnings);
    added = tokens.length;
  }

  const unknownWords = [
    ...new Set(
      inputTokens
        .filter((token) => token.kind === 'word' && !index.bySpelling.has(token.key))
        .map((token) => token.key),
    ),
  ];

  const text = renderTokens(tokens);
  const outputWords = countWordTokens(tokens);
  const outputCharacters = text.length;
  const finalMeasure = plan ? (plan.metric === 'words' ? outputWords : outputCharacters) : 0;

  if (plan && Math.abs(finalMeasure - plan.target) > plan.tolerance) {
    warnings.push(
      `Landed on ${finalMeasure} ${plan.metric} against a target of ${plan.target} ±${plan.tolerance}.`,
    );
  }
  if (index.byId.size > 0 && index.byId.size < 25) {
    warnings.push(`Only ${index.byId.size} word(s) in the database — the text will repeat itself.`);
  }

  return {
    text,
    tokens,
    warnings,
    stats: {
      mode: options.mode,
      seed: options.seed,
      inputWords,
      inputCharacters,
      outputWords,
      outputCharacters,
      wordChangePercent: inputWords > 0 ? ((outputWords - inputWords) / inputWords) * 100 : 0,
      charChangePercent:
        inputCharacters > 0 ? ((outputCharacters - inputCharacters) / inputCharacters) * 100 : 0,
      plan,
      onTarget: plan ? Math.abs(finalMeasure - plan.target) <= plan.tolerance : true,
      replaced,
      added,
      removed,
      unknownWords,
    },
  };
}
