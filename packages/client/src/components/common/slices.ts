/**
 * Run work a slice at a time, letting the page draw and take clicks between
 * slices: comparing a few seconds of frames takes a second or two, and must
 * not freeze the screen while it does. The work is a generator that yields
 * how far it has got; each slice runs for about 24 ms. Null if it was called
 * off.
 */
export async function inSlices<P, T>(work: Generator<P, T>, onProgress: (progress: P) => void, cancelled: () => boolean): Promise<T | null> {
  let began = performance.now();
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
    if (performance.now() - began > 24) {
      onProgress(next.value);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (cancelled()) return null;
      began = performance.now();
    }
  }
}

/** Base64 of a UTF-8 string, for a text attachment. */
export function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A text attachment's data URL. */
export function textDataUrl(text: string, type = 'text/markdown'): string {
  return `data:${type};base64,${utf8Base64(text)}`;
}
