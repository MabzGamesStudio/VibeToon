import { parseRules, ruleNumber, ruleValue, type ParsedRules } from '../rules/parseRules';
import type { GrammarDataset } from '../text/grammarDatabase';
import { mergeLexicons } from '../text/lexicon';
import { starterLexicon } from './lexicon';
import {
  DEFAULT_RANDOM_TEXT_OPTIONS,
  type Lexicon,
  type RandomTextOptions,
  type TextFlowData,
} from '../types/text';

export function emptyTextData(): TextFlowData {
  return {
    editor: 'text',
    input: '',
    output: '',
    options: { ...DEFAULT_RANDOM_TEXT_OPTIONS, length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length } },
    // Counted out of the bundled sample corpus, so a new flow writes something
    // immediately and its numbers mean the same thing as a database built from
    // a book: frequency is how often the word appeared, and a context is how
    // much more often one word followed another than it turned up at all.
    lexicon: starterLexicon(),
  };
}

/**
 * `length: 120 words` / `900 characters` / `+20%` / `-15% characters` / `keep`.
 * A bare percentage is read as words unless it says otherwise.
 */
export function applyLengthRule(options: RandomTextOptions, raw: string): RandomTextOptions {
  const value = raw.trim().toLowerCase();
  const length = { ...options.length };

  if (value === 'keep') {
    length.mode = 'keep';
    return { ...options, length };
  }

  const percent = value.match(/^([+-]?\d+(?:\.\d+)?)\s*%\s*(characters?|chars?|words?)?$/);
  if (percent) {
    const amount = Number.parseFloat(percent[1] ?? '0');
    const chars = /char/.test(percent[2] ?? '');
    length.mode = chars ? 'charPercent' : 'wordPercent';
    if (chars) length.charPercent = amount;
    else length.wordPercent = amount;
    return { ...options, length };
  }

  const absolute = value.match(/^(?:(characters?|chars?|words?)\s*)?(\d+)\s*(characters?|chars?|words?)?$/);
  if (absolute) {
    const unit = absolute[1] ?? absolute[3] ?? 'words';
    const amount = Number.parseInt(absolute[2] ?? '0', 10);
    if (/char/.test(unit)) {
      length.mode = 'characters';
      length.characters = amount;
    } else {
      length.mode = 'words';
      length.words = amount;
    }
    return { ...options, length };
  }

  return options;
}

/**
 * Rules written on a connection into this flow override its own settings, so a
 * wire can say "take this text and change a third of it, 20% longer" without
 * touching the flow itself.
 */
export function applyRulesToOptions(options: RandomTextOptions, rules: ParsedRules): RandomTextOptions {
  let next: RandomTextOptions = { ...options, length: { ...options.length } };

  const length = ruleValue(rules, 'length');
  if (length !== undefined) next = applyLengthRule(next, length);

  const mode = ruleValue(rules, 'mode');
  if (mode === 'generate' || mode === 'alter') next.mode = mode;

  const seed = ruleValue(rules, 'seed');
  if (seed) next.seed = seed;

  const alter = ruleValue(rules, 'alter');
  if (alter !== undefined) {
    next.alterTemperature = Math.max(0, Math.min(1, ruleNumber(rules, 'alter', next.alterTemperature)));
    // Saying how much to change implies wanting the incoming text changed.
    if (next.alterTemperature > 0) next.mode = 'alter';
  }

  if (ruleValue(rules, 'temperature') !== undefined) {
    next.pickTemperature = Math.max(0.02, Math.min(1, ruleNumber(rules, 'temperature', next.pickTemperature)));
  }
  if (ruleValue(rules, 'context window') !== undefined) {
    next.contextWindow = Math.max(0, Math.round(ruleNumber(rules, 'context window', next.contextWindow)));
  }
  if (ruleValue(rules, 'length temperature') !== undefined) {
    next.length.temperature = Math.max(
      0,
      Math.min(1, ruleNumber(rules, 'length temperature', next.length.temperature)),
    );
  }

  return next;
}

export interface TextRunSource {
  /** What the connection carries: `text`, `lexicon` or `grammar`. */
  port: string;
  label: string;
  rules: string;
  text?: string;
  lexicon?: Lexicon;
  grammar?: GrammarDataset;
}

export interface ResolvedTextRun {
  input: string;
  lexicon: Lexicon;
  /** The sentence shapes to write into, when one is wired in. */
  grammar: GrammarDataset | null;
  options: RandomTextOptions;
  /** Lines for the run log: where the input and the database came from. */
  notes: string[];
}

/**
 * Work out what a run should actually use: the text arriving over the wires (or
 * the flow's own, when nothing is wired in), every lexicon merged into the local
 * one, and the options after the connection rules have had their say.
 */
export function resolveTextRun(data: TextFlowData, sources: TextRunSource[]): ResolvedTextRun {
  const notes: string[] = [];
  // Fill in any option a stored project predates, so an older flow runs with
  // this build's defaults rather than with undefined.
  let options: RandomTextOptions = {
    ...DEFAULT_RANDOM_TEXT_OPTIONS,
    ...data.options,
    length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, ...data.options.length },
  };

  const texts: string[] = [];
  let lexicon: Lexicon = data.lexicon;
  let grammar: GrammarDataset | null = null;

  for (const source of sources) {
    if (source.rules.trim()) {
      options = applyRulesToOptions(options, parseRules(source.rules));
    }
    if (source.text?.trim()) {
      texts.push(source.text.trim());
      notes.push(`Read ${source.text.trim().length} characters from ${source.label}.`);
    }
    if (source.lexicon) {
      const before = lexicon.lexemes.length;
      lexicon = mergeLexicons(lexicon, source.lexicon);
      notes.push(
        `Merged ${source.lexicon.lexemes.length} word(s) from ${source.label}: ${before} → ${lexicon.lexemes.length}.`,
      );
    }
    if (source.grammar) {
      grammar = source.grammar;
      notes.push(
        `Reading ${source.grammar.sentences.length} sentence shape(s) from ${source.label}.`,
      );
    }
  }

  const input = texts.length > 0 ? texts.join('\n\n') : data.input;
  if (texts.length === 0 && data.input.trim()) {
    notes.push('Used the text written in the flow, since nothing is wired into the Text input.');
  }

  return { input, lexicon, grammar, options, notes };
}
