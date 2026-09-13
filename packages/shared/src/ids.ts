const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short, readable, collision-resistant-enough id for graph objects. */
export function newId(prefix: string): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return `${prefix}_${out}`;
}

/**
 * FNV-1a over UTF-16 code units, hex encoded. Deterministic in node and the
 * browser with no dependency, which is all we need for change detection.
 */
export function hashString(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable stringify so object key order cannot change a signature. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function hashValue(value: unknown): string {
  return hashString(stableStringify(value));
}

/** `INT. WORKSHOP - NIGHT` -> `int-workshop-night`, for file names. */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'untitled'
  );
}
