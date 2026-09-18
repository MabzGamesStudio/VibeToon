import { newId } from '../ids';
import type { Lexeme, Lexicon, LexemeContext, WordType } from '../types/text';
import { formIn, inflects, type Variations } from './forms';

export interface LexiconIndex {
  byId: Map<string, Lexeme>;
  /** Several lexemes can share a spelling (`light` the noun and the adjective). */
  bySpelling: Map<string, Lexeme[]>;
  byType: Map<WordType, Lexeme[]>;
  /** id -> (id -> weight), including the reverse direction of every edge. */
  forward: Map<string, Map<string, number>>;
  backward: Map<string, Map<string, number>>;
}

export function buildLexiconIndex(lexicon: Lexicon): LexiconIndex {
  const byId = new Map<string, Lexeme>();
  const bySpelling = new Map<string, Lexeme[]>();
  const byType = new Map<WordType, Lexeme[]>();
  const forward = new Map<string, Map<string, number>>();
  const backward = new Map<string, Map<string, number>>();

  for (const lexeme of lexicon.lexemes) {
    byId.set(lexeme.id, lexeme);
    const spelling = lexeme.spelling.toLowerCase();
    bySpelling.set(spelling, [...(bySpelling.get(spelling) ?? []), lexeme]);
    byType.set(lexeme.type, [...(byType.get(lexeme.type) ?? []), lexeme]);
  }

  for (const lexeme of lexicon.lexemes) {
    const edges = new Map<string, number>();
    for (const context of lexeme.contexts) {
      // A context pointing at a word that is no longer in the database is
      // ignored rather than treated as a zero-weight edge.
      if (!byId.has(context.id)) continue;
      edges.set(context.id, Math.max(edges.get(context.id) ?? 0, context.weight));
      const reverse = backward.get(context.id) ?? new Map<string, number>();
      reverse.set(lexeme.id, Math.max(reverse.get(lexeme.id) ?? 0, context.weight));
      backward.set(context.id, reverse);
    }
    forward.set(lexeme.id, edges);
  }

  return { byId, bySpelling, byType, forward, backward };
}

export function emptyLexicon(): Lexicon {
  return { lexemes: [] };
}

export function newLexeme(spelling = '', type: WordType = 'noun'): Lexeme {
  return {
    id: newId('lex'),
    spelling,
    type,
    frequency: 0.3,
    description: '',
    contexts: [],
  };
}

export function lexemeLabel(lexeme: Lexeme): string {
  return lexeme.type === 'punctuation' ? `“${lexeme.spelling}”` : lexeme.spelling;
}

export interface LexiconStats {
  total: number;
  byType: Array<{ type: WordType; count: number }>;
  contextEdges: number;
  /** Context references pointing at ids that are not in the database. */
  danglingRefs: Array<{ lexeme: Lexeme; contextId: string }>;
  /** Lexemes nothing points at and which point nowhere. */
  isolated: Lexeme[];
  /** Ids used by more than one entry — only one of them can ever be reached. */
  duplicateIds: string[];
}

export function lexiconStats(lexicon: Lexicon): LexiconStats {
  const index = buildLexiconIndex(lexicon);
  const counts = new Map<WordType, number>();
  const dangling: LexiconStats['danglingRefs'] = [];
  let edges = 0;

  for (const lexeme of lexicon.lexemes) {
    counts.set(lexeme.type, (counts.get(lexeme.type) ?? 0) + 1);
    for (const context of lexeme.contexts) {
      if (index.byId.has(context.id)) edges += 1;
      else dangling.push({ lexeme, contextId: context.id });
    }
  }

  const isolated = lexicon.lexemes.filter(
    (lexeme) =>
      (index.forward.get(lexeme.id)?.size ?? 0) === 0 &&
      (index.backward.get(lexeme.id)?.size ?? 0) === 0 &&
      lexeme.type !== 'punctuation',
  );

  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const lexeme of lexicon.lexemes) {
    if (seen.has(lexeme.id)) duplicateIds.add(lexeme.id);
    seen.add(lexeme.id);
  }

  return {
    total: lexicon.lexemes.length,
    duplicateIds: [...duplicateIds],
    byType: [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    contextEdges: edges,
    danglingRefs: dangling,
    isolated,
  };
}

/** Drop context references whose target has been deleted. */
export function pruneLexicon(lexicon: Lexicon): Lexicon {
  const ids = new Set(lexicon.lexemes.map((lexeme) => lexeme.id));
  return {
    lexemes: lexicon.lexemes.map((lexeme) => ({
      ...lexeme,
      contexts: lexeme.contexts.filter((context) => ids.has(context.id)),
    })),
  };
}

/**
 * Merge a lexicon arriving over a connection into the local one. Entries are
 * matched on spelling plus word type: the incoming version wins on the scalar
 * fields, and their context lists are unioned at the stronger weight, so
 * wiring a shared database in never quietly drops local work.
 */
export function mergeLexicons(base: Lexicon, incoming: Lexicon): Lexicon {
  const keyOf = (lexeme: Lexeme) => `${lexeme.spelling.toLowerCase()}|${lexeme.type}`;
  const result: Lexeme[] = base.lexemes.map((lexeme) => ({ ...lexeme, contexts: [...lexeme.contexts] }));
  const byKey = new Map(result.map((lexeme) => [keyOf(lexeme), lexeme]));

  // Incoming ids that collide with a local entry are rewritten to the local id.
  const idMap = new Map<string, string>();
  for (const lexeme of incoming.lexemes) {
    const existing = byKey.get(keyOf(lexeme));
    if (existing) {
      idMap.set(lexeme.id, existing.id);
    } else {
      const copy: Lexeme = { ...lexeme, contexts: [] };
      result.push(copy);
      byKey.set(keyOf(lexeme), copy);
      idMap.set(lexeme.id, copy.id);
    }
  }

  for (const lexeme of incoming.lexemes) {
    const targetId = idMap.get(lexeme.id);
    const target = result.find((candidate) => candidate.id === targetId);
    if (!target) continue;
    target.type = lexeme.type;
    target.frequency = lexeme.frequency;
    if (lexeme.description.trim()) target.description = lexeme.description;

    const contexts = new Map<string, number>(target.contexts.map((c) => [c.id, c.weight]));
    for (const context of lexeme.contexts) {
      const mapped = idMap.get(context.id);
      if (!mapped) continue;
      contexts.set(mapped, Math.max(contexts.get(mapped) ?? 0, context.weight));
    }
    target.contexts = [...contexts.entries()].map(([id, weight]) => ({ id, weight }));
  }

  return pruneLexicon({ lexemes: result });
}

export function setContextWeight(lexeme: Lexeme, id: string, weight: number): LexemeContext[] {
  const contexts = lexeme.contexts.filter((context) => context.id !== id);
  if (weight > 0) contexts.push({ id, weight });
  return contexts.sort((a, b) => b.weight - a.weight);
}

/* ------------------------------------------------------------------ *
 * The forms a word takes
 * ------------------------------------------------------------------ */

/**
 * Every spelling a lexeme takes, keyed by form — or nothing.
 *
 * Nothing means one of two quite different things, which `formsState` below tells
 * apart: either the word's type has no other forms, or no morphology dataset has
 * been asked about it yet. It deliberately does not fall back to working the
 * forms out from the spelling; that is what `variationsOf` used to do, and it
 * produced `forgived` and `cactu`.
 */
export function variationsOf(lexeme: Lexeme): Variations | undefined {
  const variations = lexeme.variations as Variations | undefined;
  return variations && Object.keys(variations).length > 0 ? variations : undefined;
}

/** Which of its own forms a lexeme's spelling is: `cats` is a `plural`. */
export function formOfLexeme(lexeme: Lexeme): string | undefined {
  return lexeme.form ?? formIn(variationsOf(lexeme), lexeme.spelling);
}

/** Why an entry has no forms to show, which is not the same as having none. */
export type FormsState = 'known' | 'does-not-inflect' | 'not-looked-up';

export function formsState(lexeme: Lexeme): FormsState {
  if (variationsOf(lexeme)) return 'known';
  return inflects(lexeme.type) ? 'not-looked-up' : 'does-not-inflect';
}
