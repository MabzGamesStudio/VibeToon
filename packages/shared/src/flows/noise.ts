/**
 * Seeded noise for procedural terrain.
 *
 * Classic 2D gradient (Perlin) noise over a permutation table shuffled from a
 * seed, so a seed is a world: the same seed gives the same terrain on every
 * machine, in the editor and on the server alike. Everything is a pure function
 * of position — nothing is stored — which is what lets the map be zoomed from a
 * continent down to a harbour wall and have detail all the way: each level of
 * zoom simply asks for more octaves.
 */

/** A 32-bit hash of a string, for turning a typed seed into numbers. */
export function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** A small, fast, seeded generator of numbers in [0, 1). */
export function rng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Noise2D {
  (x: number, y: number): number;
}

const GRADIENTS = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
] as const;

/** Gradient noise in about [-1, 1], zero at every integer lattice point, smooth between. */
export function perlin(seed: number): Noise2D {
  const random = rng(seed);
  const table = new Uint8Array(512);
  const order = Array.from({ length: 256 }, (_, index) => index);
  for (let index = 255; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap]!, order[index]!];
  }
  for (let index = 0; index < 512; index += 1) table[index] = order[index & 255]!;
  const gx = new Float64Array(512);
  const gy = new Float64Array(512);
  for (let index = 0; index < 512; index += 1) {
    const gradient = GRADIENTS[table[index]! & 7]!;
    gx[index] = gradient[0];
    gy[index] = gradient[1];
  }

  return (x: number, y: number) => {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const X = fx & 255;
    const Y = fy & 255;
    const dx = x - fx;
    const dy = y - fy;
    const a = table[X]! + Y;
    const b = table[X + 1]! + Y;
    const aa = table[a]!;
    const ab = table[a + 1]!;
    const ba = table[b]!;
    const bb = table[b + 1]!;
    const u = dx * dx * dx * (dx * (dx * 6 - 15) + 10);
    const v = dy * dy * dy * (dy * (dy * 6 - 15) + 10);
    const n00 = gx[aa]! * dx + gy[aa]! * dy;
    const n10 = gx[ba]! * (dx - 1) + gy[ba]! * dy;
    const n01 = gx[ab]! * dx + gy[ab]! * (dy - 1);
    const n11 = gx[bb]! * (dx - 1) + gy[bb]! * (dy - 1);
    const x1 = n00 + u * (n10 - n00);
    const x2 = n01 + u * (n11 - n01);
    return (x1 + v * (x2 - x1)) * 1.1;
  };
}

/**
 * How many octaves are worth adding for a feature scale and a pixel.
 *
 * An octave whose wavelength is under two pixels is noise the screen cannot
 * show — it only aliases — so the sum stops there. Zoomed in, pixels are small
 * and more octaves are added: detail that was always there, now visible.
 */
export function octavesFor(wavelength: number, pixel: number, most = 16): number {
  if (!(pixel > 0)) return most;
  return Math.max(1, Math.min(most, Math.ceil(Math.log2(wavelength / (pixel * 2))) + 1));
}

/**
 * Fractal sum: octaves of noise, each half the wavelength and `gain` the weight
 * of the last. Normalised to about [-1, 1] whatever the octave count, so adding
 * detail does not shift the average height of the land.
 */
export function fbm(noise: Noise2D, x: number, y: number, octaves: number, gain = 0.5, lacunarity = 2): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  const whole = Math.floor(octaves);
  for (let octave = 0; octave < whole; octave += 1) {
    // A different offset each octave, so their lattices do not line up.
    sum += amplitude * noise(x * frequency + octave * 17.13, y * frequency - octave * 31.7);
    total += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return total > 0 ? sum / total : 0;
}

/** Ridged noise in [0, 1]: sharp crests where plain noise crosses zero — mountain ridges. */
export function ridged(noise: Noise2D, x: number, y: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  let weight = 1;
  for (let octave = 0; octave < Math.floor(octaves); octave += 1) {
    let value = 1 - Math.abs(noise(x * frequency + octave * 11.7, y * frequency + octave * 5.3));
    value *= value;
    value *= weight;
    weight = Math.min(1, value * 1.6);
    sum += value * amplitude;
    total += amplitude;
    amplitude *= gain;
    frequency *= 2;
  }
  return total > 0 ? sum / total : 0;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
