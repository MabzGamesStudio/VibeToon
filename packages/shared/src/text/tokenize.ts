/**
 * Tokenising and re-rendering text. The generator works on tokens, so the two
 * have to round-trip: whatever comes in must come back out reading the same
 * way, with punctuation hugging the word before it and sentences capitalised.
 */

export type TokenKind = 'word' | 'number' | 'punctuation' | 'break';

export interface TextToken {
  /** The token as written, e.g. `Apple`, `42`, `,`. */
  text: string;
  kind: TokenKind;
  /** Lowercased form used to look the token up in the lexicon. */
  key: string;
}

/** Punctuation that ends a sentence, so the next word is capitalised. */
export const SENTENCE_END = new Set(['.', '!', '?', '…']);

/** True for `.`, `?!` and `...` alike — a run of end marks still ends a sentence. */
export function isSentenceEnd(token: TextToken | undefined): boolean {
  if (!token || token.kind !== 'punctuation') return false;
  return SENTENCE_END.has(token.text[0] ?? '');
}

/** Punctuation that attaches to the word before it, with no space. */
const CLOSING = new Set([
  '.', ',', '!', '?', ';', ':', '…', ')', ']', '}', '’', "'", '”', '%', '"',
]);

/** Punctuation that attaches to the word after it. */
const OPENING = new Set(['(', '[', '{', '“', '$', '#', '@']);

/**
 * Words (with contractions and hyphens), numbers, runs of the same punctuation
 * mark (so `============` and `...` stay whole), and line breaks. Line breaks
 * are tokens of their own because a script or a poem is mostly its shape:
 * rewriting the words should not flatten it into a paragraph.
 */
const TOKEN_PATTERN =
  /[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+(?:[.,]\d+)*|[ \t]*\n[ \t]*(?:\n[ \t]*)+|[ \t]*\n[ \t]*|([^\sA-Za-z\d])\1*/g;

export function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    if (/\n/.test(raw)) {
      // Collapse the run to the newlines themselves; indentation is not content.
      const newlines = raw.replace(/[^\n]/g, '');
      tokens.push({ text: newlines.length > 1 ? '\n\n' : '\n', kind: 'break', key: '\n' });
      continue;
    }
    const kind: TokenKind = /^[A-Za-z]/.test(raw) ? 'word' : /^\d/.test(raw) ? 'number' : 'punctuation';
    tokens.push({ text: raw, kind, key: raw.toLowerCase() });
  }
  return tokens;
}

export function makeToken(text: string, kind: TokenKind): TextToken {
  return { text, kind, key: text.toLowerCase() };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * `a` before a vowel sound becomes `an`, and back again. Swapping words around
 * breaks article agreement constantly, and leaving `a apple` in the output
 * reads as a bug in the generator rather than as randomness.
 */
const SOUNDS_LIKE_CONSONANT = /^(uni|use|user|one|euro|eu)/i;
/** Silent h: `an hour`, not `a hour`. */
const SOUNDS_LIKE_VOWEL = /^(hour|honest|honou?r|heir)/i;
const STARTS_WITH_VOWEL = /^[aeiou]/i;

function agreeArticle(token: TextToken, next: TextToken | undefined): string {
  if (token.key !== 'a' && token.key !== 'an') return token.text;
  if (!next || next.kind === 'punctuation' || next.kind === 'break') return token.text;
  const vowel =
    SOUNDS_LIKE_VOWEL.test(next.text) ||
    (STARTS_WITH_VOWEL.test(next.text) && !SOUNDS_LIKE_CONSONANT.test(next.text));
  const wanted = vowel ? 'an' : 'a';
  if (wanted === token.key) return token.text;
  // Keep whatever capitalisation the token already had.
  return token.text[0] === token.text[0]?.toUpperCase()
    ? wanted.charAt(0).toUpperCase() + wanted.slice(1)
    : wanted;
}

export interface RenderedPart {
  /** Whitespace that goes before this token, if any. */
  lead: string;
  /** The token as it should appear, after capitalisation and article agreement. */
  text: string;
  token: TextToken;
}

/**
 * Rendering, one token at a time. The editor highlights tokens by where they
 * came from, so it needs the pieces rather than the finished string — and both
 * come from here so they can never disagree.
 */
export function renderParts(tokens: readonly TextToken[]): RenderedPart[] {
  const parts: RenderedPart[] = [];
  let startOfSentence = true;
  let attachNext = false;
  let wroteAnything = false;

  for (const [position, token] of tokens.entries()) {
    if (token.kind === 'break') {
      parts.push({ lead: '', text: token.text, token });
      // A line of its own reads as a fresh start, so the next word is
      // capitalised the way it would be in a script or a list.
      startOfSentence = token.text.length > 1 || startOfSentence;
      attachNext = true;
      wroteAnything = true;
      continue;
    }

    const isClosing = token.kind === 'punctuation' && CLOSING.has(token.text[0] ?? '');
    const isOpening = token.kind === 'punctuation' && OPENING.has(token.text[0] ?? '');
    const lead = wroteAnything && !isClosing && !attachNext ? ' ' : '';

    // A quote mark can open or close; `'` between letters never reaches here
    // because the tokeniser keeps contractions inside their word.
    const agreed = agreeArticle(token, tokens[position + 1]);
    const text = startOfSentence && token.kind === 'word' ? capitalize(agreed) : agreed;
    parts.push({ lead, text, token });

    wroteAnything = true;
    attachNext = isOpening;
    if (token.kind === 'word' || token.kind === 'number') startOfSentence = false;
    else if (isSentenceEnd(token)) startOfSentence = true;
  }

  return parts;
}

export function renderTokens(tokens: readonly TextToken[]): string {
  return renderParts(tokens)
    .map((part) => `${part.lead}${part.text}`)
    .join('');
}

export function countWordTokens(tokens: readonly TextToken[]): number {
  return tokens.filter((token) => token.kind === 'word' || token.kind === 'number').length;
}

export function countCharacters(tokens: readonly TextToken[]): number {
  return renderTokens([...tokens]).length;
}

/** Words in a plain string, without going through the lexicon. */
export function wordCount(text: string): number {
  return countWordTokens(tokenize(text));
}
