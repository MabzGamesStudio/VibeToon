/**
 * Connections carry plain text. Most of it is guidance meant for a human (or a
 * model) to read, but a documented set of `key: value` directives is
 * interpreted directly, which is what makes a connection do something on its
 * own. Anything unrecognised is kept verbatim as guidance rather than dropped,
 * so a connection never silently loses what you wrote.
 */

export interface RuleDirective {
  key: string;
  value: string;
  raw: string;
  line: number;
  known: boolean;
}

export interface ParsedRules {
  directives: RuleDirective[];
  /** Free-text lines, in order, with comments stripped. */
  guidance: string[];
  /** Directives whose key is not in the catalogue; also present in `directives`. */
  unknown: RuleDirective[];
}

export interface RuleDirectiveSpec {
  key: string;
  /** Example value, shown in the editor's help. */
  example: string;
  description: string;
  /** Flow kinds (or `*`) this directive is interpreted for. */
  appliesTo: string[];
}

export const RULE_DIRECTIVES: readonly RuleDirectiveSpec[] = [
  {
    key: 'panel per',
    example: 'beat',
    description: 'Panel granularity: `beat`, `line`, `scene` or `action`.',
    appliesTo: ['animation.storyboard'],
  },
  {
    key: 'merge',
    example: 'consecutive action beats',
    description: 'Merge policy. `consecutive action beats` collapses runs of action into one panel; `none` disables it.',
    appliesTo: ['animation.storyboard'],
  },
  {
    key: 'shot default',
    example: 'MS',
    description: 'Shot size used when no more specific rule matches.',
    appliesTo: ['animation.storyboard'],
  },
  {
    key: 'shot for line',
    example: 'MCU',
    description: 'Shot size for dialog beats.',
    appliesTo: ['animation.storyboard'],
  },
  {
    key: 'shot for action',
    example: 'WS',
    description: 'Shot size for action beats.',
    appliesTo: ['animation.storyboard'],
  },
  {
    key: 'shot for sound',
    example: 'INSERT',
    description: 'Shot size for panels created from a sound cue.',
    appliesTo: ['animation.storyboard'],
  },
  {
    key: 'carry',
    example: 'sound -> notes',
    description: 'Copy a source field into a destination field. Repeatable; `a, b` carries several fields as-is.',
    appliesTo: ['*'],
  },
  {
    key: 'ignore',
    example: 'direction',
    description: 'Drop a source field or beat type: `direction`, `sound`, `parenthetical`, `action`.',
    appliesTo: ['*'],
  },
  {
    key: 'min duration',
    example: '1.2',
    description: 'Floor for a derived panel duration, in seconds.',
    appliesTo: ['animation.storyboard', 'animation.animatic'],
  },
  {
    key: 'max duration',
    example: '6',
    description: 'Ceiling for a derived panel duration, in seconds.',
    appliesTo: ['animation.storyboard', 'animation.animatic'],
  },
  {
    key: 'words per second',
    example: '2.6',
    description: 'Speaking rate used to estimate a line duration when the beat has none.',
    appliesTo: ['animation.storyboard', 'animation.animatic'],
  },
  {
    key: 'scenes',
    example: '1-3',
    description: 'Restrict to a scene range or list, e.g. `1-3`, `2,4`, `all`.',
    appliesTo: ['*'],
  },
  {
    key: 'length',
    example: '+20%',
    description: 'Target length: `keep`, `120 words`, `900 characters`, `+20%` or `-15% characters`.',
    appliesTo: ['text.random'],
  },
  {
    key: 'alter',
    example: '0.3',
    description: 'Share of the incoming words the run may replace, 0 to 1. Setting it switches the flow to altering.',
    appliesTo: ['text.random'],
  },
  {
    key: 'temperature',
    example: '0.45',
    description: 'Randomness of each word pick, 0 to 1. 0 always takes the best candidate.',
    appliesTo: ['text.random'],
  },
  {
    key: 'context window',
    example: '3',
    description: 'How many previous words are allowed to pull on the next one.',
    appliesTo: ['text.random'],
  },
  {
    key: 'length temperature',
    example: '0.25',
    description: 'How far off the target length a run may land, 0 to 1.',
    appliesTo: ['text.random'],
  },
  {
    key: 'seed',
    example: 'rain',
    description: 'Seed for the run. The same seed always produces the same text.',
    appliesTo: ['text.random'],
  },
  {
    key: 'mode',
    example: 'alter',
    description: '`generate` writes new text, `alter` rewrites what arrives.',
    appliesTo: ['text.random'],
  },
  {
    key: 'weight',
    example: '0.7',
    description: 'How strongly this connection should push the downstream result, 0 to 1.',
    appliesTo: ['*'],
  },
  {
    key: 'keep',
    example: 'names, props',
    description: 'Things the downstream flow must preserve. Guidance only.',
    appliesTo: ['*'],
  },
  {
    key: 'never',
    example: 'invent new characters',
    description: 'Hard prohibition. Guidance only.',
    appliesTo: ['*'],
  },
  {
    key: 'always',
    example: 'end a scene on an image',
    description: 'Hard requirement. Guidance only.',
    appliesTo: ['*'],
  },
];

const KNOWN_KEYS = new Set(RULE_DIRECTIVES.map((d) => d.key));

function normaliseKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * `#` starts a comment at the beginning of a line, or mid-line when it is
 * followed by a space. That keeps `palette: #ff8800` intact, which matters
 * because colour values show up in style rules all the time.
 */
function stripComment(rawLine: string): string {
  const trimmed = rawLine.trim();
  if (trimmed.startsWith('#')) return '';
  return trimmed.replace(/\s#(?=\s|$).*$/, '').trim();
}

export function parseRules(text: string): ParsedRules {
  const directives: RuleDirective[] = [];
  const guidance: string[] = [];
  const lines = (text ?? '').split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const withoutComment = stripComment(rawLine);
    if (!withoutComment) return;

    const separator = withoutComment.indexOf(':');
    if (separator > 0) {
      const key = normaliseKey(withoutComment.slice(0, separator));
      const value = withoutComment.slice(separator + 1).trim();
      // A key with spaces but no known match is prose (`note: it must feel...`)
      // only if it does not look like a directive; we keep both paths safe by
      // recording it as a directive and echoing it as guidance when unknown.
      const known = KNOWN_KEYS.has(key);
      directives.push({ key, value, raw: withoutComment, line: index, known });
      if (!known) guidance.push(withoutComment);
      return;
    }
    guidance.push(withoutComment);
  });

  return { directives, guidance, unknown: directives.filter((d) => !d.known) };
}

/** Last value wins, so a later line can override an earlier one. */
export function ruleValue(rules: ParsedRules, key: string): string | undefined {
  const normalised = normaliseKey(key);
  for (let i = rules.directives.length - 1; i >= 0; i -= 1) {
    const directive = rules.directives[i]!;
    if (directive.key === normalised) return directive.value;
  }
  return undefined;
}

export function ruleValues(rules: ParsedRules, key: string): string[] {
  const normalised = normaliseKey(key);
  return rules.directives.filter((d) => d.key === normalised).map((d) => d.value);
}

export function ruleNumber(rules: ParsedRules, key: string, fallback: number): number {
  const raw = ruleValue(rules, key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `ignore: direction, sound` and repeated `ignore:` lines both work. */
export function ruleFlagSet(rules: ParsedRules, key: string): Set<string> {
  const out = new Set<string>();
  for (const value of ruleValues(rules, key)) {
    for (const part of value.split(',')) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) out.add(trimmed);
    }
  }
  return out;
}

/** `carry: sound -> notes` becomes `{ sound: 'notes' }`; `carry: dialog` becomes `{ dialog: 'dialog' }`. */
export function ruleMap(rules: ParsedRules, key: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of ruleValues(rules, key)) {
    for (const clause of value.split(',')) {
      const [left, right] = clause.split('->');
      const from = left?.trim().toLowerCase();
      if (!from) continue;
      out[from] = (right?.trim().toLowerCase() || from);
    }
  }
  return out;
}

/** `scenes: 1-3` / `2,4` / `all` -> a predicate over 1-based scene numbers. */
export function ruleSceneFilter(rules: ParsedRules): (oneBased: number) => boolean {
  const raw = ruleValue(rules, 'scenes');
  if (!raw || raw.toLowerCase() === 'all') return () => true;
  const allowed = new Set<number>();
  for (const part of raw.split(',')) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i += 1) allowed.add(i);
      continue;
    }
    const single = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(single)) allowed.add(single);
  }
  if (allowed.size === 0) return () => true;
  return (oneBased) => allowed.has(oneBased);
}

/**
 * Everything a generator should read as prose: free-text lines plus the
 * guidance-only directives, in the order they were written.
 */
export function guidanceText(rules: ParsedRules): string {
  const guidanceKeys = new Set(['keep', 'never', 'always']);
  const fromDirectives = rules.directives
    .filter((d) => d.known && guidanceKeys.has(d.key))
    .map((d) => d.raw);
  return [...rules.guidance, ...fromDirectives].join('\n');
}
