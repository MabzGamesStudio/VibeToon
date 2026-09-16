/**
 * Public-domain books the word database can be built from. Only the address is
 * kept here — the text is fetched when you ask for it and counted into your own
 * project, so nothing large or borrowed lives in this repository.
 */
export interface CorpusSourceOption {
  id: string;
  title: string;
  author: string;
  /** Why it is worth counting: what kind of English it is. */
  note: string;
  url: string;
}

export const DEFAULT_CORPUS_SOURCES: readonly CorpusSourceOption[] = [
  {
    id: 'gutenberg-1727',
    title: 'The Odyssey',
    author: 'Homer, translated by Samuel Butler',
    note: 'Formal, repetitive, full of epithets — strong, unusual word pairs.',
    url: 'https://www.gutenberg.org/cache/epub/1727/pg1727.txt',
  },
  {
    id: 'gutenberg-64317',
    title: 'The Great Gatsby',
    author: 'F. Scott Fitzgerald',
    note: 'Twentieth-century American prose; modern sentence shapes.',
    url: 'https://www.gutenberg.org/cache/epub/64317/pg64317.txt',
  },
  {
    id: 'gutenberg-1342',
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    note: 'Dialogue-heavy, long clauses, plenty of social vocabulary.',
    url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
  },
  {
    id: 'gutenberg-11',
    title: "Alice's Adventures in Wonderland",
    author: 'Lewis Carroll',
    note: 'Short sentences and concrete nouns; a good first corpus.',
    url: 'https://www.gutenberg.org/cache/epub/11/pg11.txt',
  },
  {
    id: 'gutenberg-84',
    title: 'Frankenstein',
    author: 'Mary Shelley',
    note: 'Nineteenth-century narration, weather and landscape vocabulary.',
    url: 'https://www.gutenberg.org/cache/epub/84/pg84.txt',
  },
  {
    id: 'gutenberg-2701',
    title: 'Moby Dick',
    author: 'Herman Melville',
    note: 'Very large and very varied; slow to count, rich to write from.',
    url: 'https://www.gutenberg.org/cache/epub/2701/pg2701.txt',
  },
];

const START_MARKER = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;
const END_MARKER = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;

/**
 * Trim a Project Gutenberg file down to the book. Their licence header and
 * footer are several thousand words of legal English that would otherwise be
 * counted as part of the author's vocabulary.
 */
export function stripGutenbergBoilerplate(text: string): string {
  let body = text;
  const start = body.match(START_MARKER);
  if (start?.index !== undefined) body = body.slice(start.index + start[0].length);
  const end = body.match(END_MARKER);
  if (end?.index !== undefined) body = body.slice(0, end.index);
  return body.trim();
}

/** A readable name for a corpus fetched from a URL. */
export function nameFromUrl(url: string): string {
  const known = DEFAULT_CORPUS_SOURCES.find((source) => source.url === url);
  if (known) return known.title;
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname;
    return last.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') || parsed.hostname;
  } catch {
    return 'Corpus';
  }
}
