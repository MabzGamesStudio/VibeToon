import { catalogueEntry, drawnAt, labelledAt, type CatalogueEntry, type MapLayer } from './mapCatalogue';
import { fbm, hashSeed, octavesFor, perlin, ridged, rng, smoothstep, type Noise2D } from './noise';

/**
 * A world map: terrain generated from a seed, repainted and built on by hand.
 *
 * **Nothing about the terrain is stored as pixels.** Height, climate and what
 * grows are functions of position — seeded noise, a latitude, the settings —
 * so the map has detail at every zoom, from a continent to a harbour wall, and
 * the editor, the server and any later run all draw exactly the same world.
 * What is stored is only what someone decided: the settings, the regions they
 * asked to be generated differently, the paint they put down, and the elements
 * they placed and named.
 *
 * Distances are in kilometres, sizes of elements in metres, heights in metres
 * above sea level, temperatures in °C. y runs south, as it does on a screen.
 */

/* ------------------------------------------------------------------ *
 * What the ground is
 * ------------------------------------------------------------------ */

export type Biome =
  | 'ocean'
  | 'sea'
  | 'sea_ice'
  | 'lake'
  | 'beach'
  | 'desert'
  | 'steppe'
  | 'grass'
  | 'savanna'
  | 'woods'
  | 'forest'
  | 'taiga'
  | 'jungle'
  | 'swamp'
  | 'tundra'
  | 'snow'
  | 'rock'
  | 'farmland'
  | 'urban'
  | 'bare';

/** The kinds of ground that can be switched on and off, in the order the editor lists them. */
export const GENERATED_BIOMES: readonly Exclude<Biome, 'bare' | 'sea'>[] = [
  'ocean',
  'lake',
  'sea_ice',
  'beach',
  'grass',
  'woods',
  'forest',
  'jungle',
  'taiga',
  'savanna',
  'steppe',
  'desert',
  'swamp',
  'tundra',
  'snow',
  'rock',
  'farmland',
  'urban',
];

export const BIOME_LABEL: Record<Biome, string> = {
  ocean: 'Water (oceans and seas)',
  sea: 'Shallow sea',
  sea_ice: 'Sea ice',
  lake: 'Lakes',
  beach: 'Beach',
  desert: 'Desert',
  steppe: 'Steppe',
  grass: 'Grass',
  savanna: 'Savanna',
  woods: 'Woods',
  forest: 'Forest',
  taiga: 'Taiga',
  jungle: 'Jungle',
  swamp: 'Swamp',
  tundra: 'Tundra',
  snow: 'Snow and ice',
  rock: 'Bare mountain',
  farmland: 'Farmland',
  urban: 'Urban',
  bare: 'Bare ground',
};

export const BIOME_COLOR: Record<Biome, [number, number, number]> = {
  ocean: [38, 78, 128],
  sea: [58, 118, 168],
  sea_ice: [214, 230, 240],
  lake: [66, 128, 176],
  beach: [226, 210, 160],
  desert: [222, 196, 138],
  steppe: [190, 186, 120],
  grass: [142, 178, 92],
  savanna: [196, 184, 104],
  woods: [104, 150, 78],
  forest: [62, 118, 64],
  taiga: [70, 104, 82],
  jungle: [34, 108, 52],
  swamp: [86, 110, 82],
  tundra: [168, 172, 150],
  snow: [242, 246, 250],
  rock: [138, 128, 120],
  farmland: [196, 190, 110],
  urban: [150, 140, 140],
  bare: [160, 150, 132],
};

/** Where a switched-off kind of ground goes instead: the nearest thing that is still on. */
const FALLBACK: Partial<Record<Biome, Biome>> = {
  jungle: 'forest',
  taiga: 'forest',
  forest: 'woods',
  woods: 'grass',
  swamp: 'grass',
  savanna: 'grass',
  grass: 'steppe',
  steppe: 'desert',
  desert: 'bare',
  tundra: 'steppe',
  snow: 'tundra',
  rock: 'bare',
  beach: 'desert',
  sea_ice: 'ocean',
  lake: 'ocean',
  sea: 'ocean',
};

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/** How a stretch of terrain is generated. The world has one; a region can have its own. */
export interface TerrainSettings {
  /** How much of it is land, 0..1. */
  land: number;
  /** How big a landmass typically is, in km. */
  continentSize: number;
  /** 0..1 — smooth coasts and rolling land, to ragged coasts and broken ground. */
  roughness: number;
  /** 0..1 — how mountainous the land is. */
  mountains: number;
  /** -1..1 — colder to hotter, about 15 °C either way. */
  temperature: number;
  /** -1..1 — drier to wetter. */
  moisture: number;
}

export const DEFAULT_TERRAIN: TerrainSettings = {
  land: 0.4,
  continentSize: 1600,
  roughness: 0.5,
  mountains: 0.5,
  temperature: 0,
  moisture: 0,
};

/** Generated features that can be switched off. */
export interface FeatureToggles {
  mountainRanges: boolean;
  peaks: boolean;
  rivers: boolean;
  waters: boolean;
  cities: boolean;
  towns: boolean;
  villages: boolean;
}

export const DEFAULT_FEATURES: FeatureToggles = {
  mountainRanges: true,
  peaks: true,
  rivers: true,
  waters: true,
  cities: true,
  towns: true,
  villages: true,
};

export interface MapSettings {
  /** What the world is called: the root of every place's path. */
  name: string;
  seed: string;
  widthKm: number;
  heightKm: number;
  /** Latitude at the top and bottom edges, which is what the climate hangs on. */
  northLatitude: number;
  southLatitude: number;
  terrain: TerrainSettings;
  /** Kinds of ground on or off. A switched-off one becomes its nearest neighbour. */
  biomes: Record<string, boolean>;
  features: FeatureToggles;
  /** 0..1 — how many settlements. */
  density: number;
}

export function defaultMapSettings(): MapSettings {
  return {
    name: 'The World',
    seed: 'vibetoon',
    widthKm: 4000,
    heightKm: 2500,
    northLatitude: 70,
    southLatitude: -20,
    terrain: { ...DEFAULT_TERRAIN },
    biomes: Object.fromEntries(GENERATED_BIOMES.map((biome) => [biome, true])),
    features: { ...DEFAULT_FEATURES },
    density: 0.5,
  };
}

/** A rectangle, in km. */
export interface KmRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A region generated differently from the rest: its own seed, its own settings, blended in at its edges. */
export interface GenerationPatch {
  id: string;
  name?: string;
  bounds: KmRect;
  seed: string;
  terrain: TerrainSettings;
  /** How far in from its edges it blends from the world's terrain to its own, in km. */
  feather: number;
}

/** What paint can put down: a kind of ground, plain land, or nothing (back to what was generated). */
export type PaintKind = Biome | 'land' | 'erase';

export interface PaintStroke {
  id: string;
  paint: PaintKind;
  /** Brush radius, km. */
  radius: number;
  /** Flat x, y, x, y… in km. */
  points: number[];
}

/* ------------------------------------------------------------------ *
 * The terrain itself
 * ------------------------------------------------------------------ */

export interface GroundSample {
  /** Metres above sea level; negative is depth. */
  elevation: number;
  /** °C, a yearly average. */
  temperature: number;
  /** 0..1. */
  moisture: number;
  water: boolean;
  biome: Biome;
  /** Put there by paint rather than generated. */
  painted: boolean;
}

interface Generator {
  warp: Noise2D;
  base: Noise2D;
  mask: Noise2D;
  ridge: Noise2D;
  heat: Noise2D;
  wet: Noise2D;
  settings: TerrainSettings;
  /** The base value at the shoreline, and the extremes, found by sampling. */
  sea: number;
  low: number;
  high: number;
}

const WARP = 0.18;

function makeGenerator(seed: string, settings: TerrainSettings, bounds: KmRect): Generator {
  const root = hashSeed(seed);
  const generator: Generator = {
    warp: perlin(root ^ 0x51ed27),
    base: perlin(root),
    mask: perlin(root ^ 0x2545f4),
    ridge: perlin(root ^ 0x9e3779),
    heat: perlin(root ^ 0x7f4a7c),
    wet: perlin(root ^ 0x1b8736),
    settings,
    sea: 0,
    low: -1,
    high: 1,
  };
  // Sea level is set by where the land share falls among the heights actually
  // there, so "40% land" is 40% land whatever the seed happens to give.
  const values: number[] = [];
  const steps = 48;
  for (let j = 0; j < steps; j += 1) {
    for (let i = 0; i < steps; i += 1) {
      const x = bounds.x0 + ((i + 0.5) / steps) * (bounds.x1 - bounds.x0);
      const y = bounds.y0 + ((j + 0.5) / steps) * (bounds.y1 - bounds.y0);
      values.push(baseValue(generator, x, y, 6));
    }
  }
  values.sort((a, b) => a - b);
  const land = Math.max(0, Math.min(1, settings.land));
  generator.sea = values[Math.min(values.length - 1, Math.floor((1 - land) * values.length))]!;
  generator.low = values[0]! - 0.05;
  generator.high = values[values.length - 1]! + 0.05;
  if (land >= 1) generator.sea = generator.low - 0.01;
  if (land <= 0) generator.sea = generator.high + 0.01;
  return generator;
}

function baseValue(generator: Generator, x: number, y: number, octaves: number): number {
  const size = Math.max(50, generator.settings.continentSize);
  const u = x / size;
  const v = y / size;
  const wx = u + WARP * fbm(generator.warp, u * 1.7, v * 1.7, Math.min(4, octaves));
  const wy = v + WARP * fbm(generator.warp, u * 1.7 + 40, v * 1.7 + 40, Math.min(4, octaves));
  const gain = 0.38 + 0.3 * Math.max(0, Math.min(1, generator.settings.roughness));
  return fbm(generator.base, wx, wy, octaves, gain);
}

/** Height in metres for one generator at a point, with detail down to `pixel` km. */
function heightOf(generator: Generator, x: number, y: number, pixel: number): { height: number; landness: number } {
  const size = Math.max(50, generator.settings.continentSize);
  const value = baseValue(generator, x, y, octavesFor(size, pixel, 14));
  const landness = value - generator.sea;
  if (landness <= 0) {
    const depth = landness / Math.max(1e-6, generator.sea - generator.low);
    return { height: Math.max(-6000, depth * 5000 - 10), landness };
  }
  const rise = landness / Math.max(1e-6, generator.high - generator.sea);
  let height = 4 + rise * 1100;
  const mountains = Math.max(0, Math.min(1, generator.settings.mountains));
  if (mountains > 0) {
    // Ranges in belts rather than everywhere: a slow mask says where, ridged
    // noise gives the crests.
    const mask = smoothstep(-0.12, 0.3, fbm(generator.mask, x / (size * 0.7), y / (size * 0.7), 3));
    if (mask > 0) {
      const ridge = ridged(generator.ridge, x / 380, y / 380, octavesFor(380, pixel, 12));
      height += mask * (0.35 + mountains) * Math.pow(ridge, 1.6) * 5600 * smoothstep(0, 0.04, landness);
    }
  }
  return { height, landness };
}

interface Compiled {
  settings: MapSettings;
  world: Generator;
  patches: Array<{ patch: GenerationPatch; generator: Generator }>;
  strokes: PaintStroke[];
  /** Settlements, for the towns and fields around them. */
  settlements: Array<{ x: number; y: number; urban: number; fields: number }>;
}

/** The map's terrain, ready to be asked about any point. Build once per change and reuse. */
export interface Terrain {
  sample(x: number, y: number, pixel?: number): GroundSample;
  settings: MapSettings;
}

export function compileTerrain(data: Pick<WorldMapFlowData, 'settings' | 'patches' | 'strokes' | 'elements'>): Terrain {
  const settings = data.settings;
  const whole = { x0: 0, y0: 0, x1: settings.widthKm, y1: settings.heightKm };
  const compiled: Compiled = {
    settings,
    world: makeGenerator(settings.seed, settings.terrain, whole),
    patches: data.patches.map((patch) => ({ patch, generator: makeGenerator(patch.seed, patch.terrain, patch.bounds) })),
    strokes: data.strokes,
    settlements: data.elements
      .filter((element) => SETTLEMENT_LAND.has(element.type))
      .map((element) => {
        const radius = element.size / 2000;
        return { x: element.x, y: element.y, urban: radius, fields: radius * SETTLEMENT_LAND.get(element.type)! };
      }),
  };
  return { settings, sample: (x, y, pixel = 1) => sampleGround(compiled, x, y, pixel) };
}

/** Settlement kinds that bring farmland round them, and how far out, as a multiple of their own radius. */
const SETTLEMENT_LAND = new Map<string, number>([
  ['place/city', 3],
  ['place/town', 4],
  ['place/village', 5],
  ['place/hamlet', 5],
  ['geo/urban_area', 2],
]);

function latitudeAt(settings: MapSettings, y: number): number {
  return settings.northLatitude + (settings.southLatitude - settings.northLatitude) * (y / Math.max(1, settings.heightKm));
}

function sampleGround(compiled: Compiled, x: number, y: number, pixel: number): GroundSample {
  const { settings, world } = compiled;
  let { height, landness } = heightOf(world, x, y, pixel);
  let generator = world;
  let heatShift = settings.terrain.temperature;
  let wetShift = settings.terrain.moisture;

  // Regions generated differently, blended in from their edges.
  for (const { patch, generator: own } of compiled.patches) {
    const { x0, y0, x1, y1 } = patch.bounds;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const inside = Math.min(x - x0, x1 - x, y - y0, y1 - y);
    // A blend wider than the region itself would never reach full strength:
    // keep at least the middle fifth of a small region wholly its own.
    const feather = Math.min(patch.feather, Math.min(x1 - x0, y1 - y0) * 0.4);
    const weight = smoothstep(0, Math.max(1e-6, feather), inside);
    const theirs = heightOf(own, x, y, pixel);
    height = height + (theirs.height - height) * weight;
    landness = landness + (theirs.landness - landness) * weight;
    heatShift = heatShift + (own.settings.temperature - heatShift) * weight;
    wetShift = wetShift + (own.settings.moisture - wetShift) * weight;
    if (weight > 0.5) generator = own;
  }

  // Paint, last stroke on top.
  let painted: PaintKind | null = null;
  for (let index = compiled.strokes.length - 1; index >= 0 && painted === null; index -= 1) {
    const stroke = compiled.strokes[index]!;
    if (touches(stroke, x, y)) painted = stroke.paint;
  }
  if (painted === 'erase') painted = null;

  const enabled = (biome: Biome) => biome === 'bare' || settings.biomes[biome] !== false;
  if (!enabled('ocean') && height <= 0) height = 2 + Math.abs(height) * 0.05;
  if (painted === 'land' || (painted && !['ocean', 'sea', 'lake', 'sea_ice'].includes(painted) && height <= 0)) {
    height = Math.max(height, 8);
  }
  if (painted && ['ocean', 'sea', 'lake', 'sea_ice'].includes(painted) && height > 0) height = -20;

  // Climate: latitude, height, and a little weather.
  const latitude = latitudeAt(settings, y);
  const land = height > 0;
  let temperature =
    28 - 0.0085 * latitude * latitude - (land ? (height / 1000) * 6.5 : 0) + 4 * fbm(generator.heat, x / 900, y / 900, 3) + 15 * heatShift;
  let moisture =
    0.5 +
    0.42 * fbm(generator.wet, x / 650, y / 650, 4) +
    0.14 * Math.cos((latitude * Math.PI) / 30) +
    0.22 * (1 - smoothstep(0, 0.12, landness)) -
    (land ? Math.min(0.2, height / 12000) : 0) +
    0.35 * wetShift;
  moisture = Math.max(0, Math.min(1, moisture));
  temperature = Math.round(temperature * 10) / 10;

  let biome = classify(height, temperature, moisture);
  if (land && biome !== 'snow' && biome !== 'rock') {
    const human = humanLand(compiled, x, y, height, biome, generator);
    if (human) biome = human;
  }
  if (painted && painted !== 'land') biome = painted;
  while (!enabled(biome)) biome = FALLBACK[biome] ?? 'bare';
  return { elevation: Math.round(height), temperature, moisture, water: height <= 0, biome, painted: painted !== null };
}

/** The ground a height and a climate make, like a Whittaker chart. */
export function classify(height: number, temperature: number, moisture: number): Biome {
  if (height <= 0) {
    if (temperature < -4) return 'sea_ice';
    return height < -200 ? 'ocean' : 'sea';
  }
  if (height < 5 && temperature > 2) return 'beach';
  if (height > 3300 || temperature < -14) return 'snow';
  if (height > 2400) return 'rock';
  if (temperature < 1) return 'tundra';
  if (temperature < 6) return moisture > 0.35 ? 'taiga' : 'tundra';
  if (moisture < 0.2) return temperature > 12 ? 'desert' : 'steppe';
  if (temperature > 21) {
    if (moisture > 0.66) return 'jungle';
    if (moisture > 0.52) return 'woods';
    if (moisture > 0.3) return 'savanna';
    return 'steppe';
  }
  if (moisture > 0.82 && height < 120) return 'swamp';
  if (moisture > 0.6) return 'forest';
  if (moisture > 0.46) return 'woods';
  if (moisture > 0.3) return 'grass';
  return 'steppe';
}

/** Towns and the fields round them, where the ground allows. */
function humanLand(compiled: Compiled, x: number, y: number, height: number, natural: Biome, generator: Generator): Biome | null {
  let best: Biome | null = null;
  for (const place of compiled.settlements) {
    const dx = x - place.x;
    const dy = y - place.y;
    const reach = place.fields;
    if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
    const distance = Math.hypot(dx, dy);
    // A ragged edge rather than a circle.
    const wobble = 1 + 0.35 * fbm(generator.warp, x / Math.max(0.5, place.urban), y / Math.max(0.5, place.urban), 2);
    if (distance < place.urban * wobble) return 'urban';
    if (
      distance < reach * wobble &&
      height < 1600 &&
      ['grass', 'woods', 'steppe', 'savanna', 'forest'].includes(natural) &&
      fbm(generator.mask, x / 3, y / 3, 2) > -0.25
    ) {
      best = 'farmland';
    }
  }
  return best;
}

function touches(stroke: PaintStroke, x: number, y: number): boolean {
  const radius = stroke.radius;
  const points = stroke.points;
  if (points.length === 2) return Math.hypot(x - points[0]!, y - points[1]!) <= radius;
  for (let index = 0; index + 3 < points.length; index += 2) {
    const ax = points[index]!;
    const ay = points[index + 1]!;
    const bx = points[index + 2]!;
    const by = points[index + 3]!;
    if (x < Math.min(ax, bx) - radius || x > Math.max(ax, bx) + radius || y < Math.min(ay, by) - radius || y > Math.max(ay, by) + radius) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
    if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= radius) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Drawing it
 * ------------------------------------------------------------------ */

export interface MapLayers {
  /** Shade the ground by its slope, as if lit from the north-west. */
  relief: boolean;
  /** Color by temperature instead of by what grows. */
  climate: boolean;
  elements: boolean;
  labels: boolean;
  /** Show generated regions' outlines. */
  regions: boolean;
}

export const DEFAULT_LAYERS: MapLayers = { relief: true, climate: false, elements: true, labels: true, regions: true };

function temperatureColor(temperature: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (temperature + 25) / 60));
  const stops: Array<[number, [number, number, number]]> = [
    [0, [70, 90, 200]],
    [0.35, [120, 200, 230]],
    [0.55, [150, 210, 120]],
    [0.75, [240, 200, 80]],
    [1, [220, 70, 50]],
  ];
  for (let index = 1; index < stops.length; index += 1) {
    const [at, color] = stops[index]!;
    const [before, previous] = stops[index - 1]!;
    if (t <= at) {
      const k = (t - before) / (at - before);
      return [0, 1, 2].map((c) => Math.round(previous[c]! + (color[c]! - previous[c]!) * k)) as [number, number, number];
    }
  }
  return stops[stops.length - 1]![1];
}

/** A cheap hash of a grid cell to [0, 1): texture needs to be fast more than it needs to be good noise. */
function cellHash(i: number, j: number, salt = 0): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * What the ground looks like close up: a factor to multiply its color by.
 *
 * Only once pixels are small enough for it to mean something — a street grid
 * at a few metres a pixel, fields at a few hundred — so zooming in on a town
 * shows its blocks and streets, and on farmland its fields and hedges, rather
 * than one flat color a city across. Hashes of position, so it is free to draw
 * and the same every time.
 */
function texture(biome: Biome, x: number, y: number, pixel: number): number {
  switch (biome) {
    case 'urban': {
      if (pixel > 0.4) return 1;
      const block = 0.12;
      const i = Math.floor(x / block);
      const j = Math.floor(y / block);
      const u = x / block - i;
      const v = y / block - j;
      const street = 0.14;
      if (pixel < 0.03 && (u < street || v < street)) return 1.28; // streets, pale
      return 0.8 + cellHash(i, j, 1) * 0.3; // blocks of different roofs
    }
    case 'farmland': {
      if (pixel > 0.5) return 1;
      const row = Math.floor(y / 0.28);
      const shift = cellHash(row, 0, 2) * 0.4;
      const i = Math.floor((x + shift) / 0.42);
      const u = (x + shift) / 0.42 - i;
      const v = y / 0.28 - row;
      if (pixel < 0.02 && (u < 0.04 || v < 0.05)) return 0.72; // hedgerows
      return 0.82 + cellHash(i, row, 3) * 0.32;
    }
    case 'forest':
    case 'jungle':
    case 'taiga':
    case 'woods': {
      if (pixel > 0.06) return 1;
      const size = biome === 'woods' ? 0.014 : 0.009;
      const i = Math.floor(x / size);
      const j = Math.floor(y / size);
      const crowded = biome === 'woods' ? 0.45 : 0.75;
      return cellHash(i, j, 4) < crowded ? 0.78 + cellHash(i, j, 5) * 0.12 : 1.08;
    }
    case 'desert':
    case 'beach':
      if (pixel > 0.15) return 1;
      return 0.94 + 0.06 * Math.sin((x * 0.8 + y * 0.6) / 0.05);
    default:
      return 1;
  }
}

/** A pixel's color for a sample; `east` and `south` are the heights one pixel over, for relief. */
export function groundColor(
  sample: GroundSample,
  layers: Pick<MapLayers, 'relief' | 'climate'>,
  east?: number,
  south?: number,
  pixel = 1,
  x = 0,
  y = 0,
): [number, number, number] {
  let color: [number, number, number];
  if (layers.climate && !sample.water) color = temperatureColor(sample.temperature);
  else {
    const base = BIOME_COLOR[sample.biome];
    const shade = texture(sample.biome, x, y, pixel);
    color = [base[0] * shade, base[1] * shade, base[2] * shade].map((c) => Math.min(255, Math.round(c))) as [number, number, number];
  }
  if (sample.water && sample.biome !== 'sea_ice') {
    // Deeper is darker.
    const depth = Math.min(1, -sample.elevation / 5000);
    color = color.map((c) => Math.round(c * (1 - depth * 0.45))) as [number, number, number];
  } else if (!sample.water) {
    const lift = Math.min(1, sample.elevation / 4000);
    color = color.map((c) => Math.round(c * (0.92 + lift * 0.18))) as [number, number, number];
    if (layers.relief && east !== undefined && south !== undefined) {
      const run = Math.max(1e-6, pixel * 1000);
      const dzdx = (east - sample.elevation) / run;
      const dzdy = (south - sample.elevation) / run;
      // Lit from the north-west: slopes facing it brighter.
      const shade = Math.max(-0.45, Math.min(0.45, (-dzdx - dzdy) * 1.6));
      color = color.map((c) => Math.max(0, Math.min(255, Math.round(c * (1 + shade))))) as [number, number, number];
    }
  }
  return color;
}

/**
 * Draw a stretch of the map into RGBA pixels: `width` × `height` pixels, the
 * top-left pixel's corner at (x0, y0) km, `pixel` km each.
 */
export function renderGround(
  terrain: Terrain,
  x0: number,
  y0: number,
  pixel: number,
  width: number,
  height: number,
  layers: Pick<MapLayers, 'relief' | 'climate'> = DEFAULT_LAYERS,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  // One row of heights ahead, so relief costs one extra sample a pixel, not two.
  let next: number[] = [];
  const rowOf = (j: number) => {
    const row: GroundSample[] = [];
    for (let i = 0; i <= width; i += 1) row.push(terrain.sample(x0 + (i + 0.5) * pixel, y0 + (j + 0.5) * pixel, pixel));
    return row;
  };
  let current = rowOf(0);
  for (let j = 0; j < height; j += 1) {
    const below = layers.relief ? rowOf(j + 1) : current;
    next = below.map((sample) => sample.elevation);
    for (let i = 0; i < width; i += 1) {
      const sample = current[i]!;
      const color = groundColor(sample, layers, current[i + 1]!.elevation, next[i], pixel, x0 + (i + 0.5) * pixel, y0 + (j + 0.5) * pixel);
      const at = (j * width + i) * 4;
      out[at] = color[0];
      out[at + 1] = color[1];
      out[at + 2] = color[2];
      out[at + 3] = 255;
    }
    current = below;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Elements: what is put on the map
 * ------------------------------------------------------------------ */

export interface MapElement {
  id: string;
  /** A catalogue id: `place/city`, `man_made/pier`, `geo/mountain_range`. */
  type: string;
  name?: string;
  description?: string;
  /** Where it is, km: its middle, or for a line its first point. */
  x: number;
  y: number;
  /** How big, in metres: across for a point or area, long for a line. */
  size: number;
  /** Degrees clockwise. */
  rotation: number;
  /** For a line or a drawn outline: flat x, y… in km. */
  points?: number[];
  /** For a line: how wide, metres. */
  width?: number;
  /** Made by generation, and replaced by the next one — until someone edits it. */
  generated?: boolean;
  /** Anything measured when it was made: a peak's height, a river's length. */
  facts?: Record<string, string | number>;
}

export interface MapView {
  /** The middle of the screen, km. */
  cx: number;
  cy: number;
  /** Km a screen pixel. */
  pixel: number;
}

export interface WorldMapFlowData {
  editor: 'map';
  settings: MapSettings;
  patches: GenerationPatch[];
  strokes: PaintStroke[];
  elements: MapElement[];
  view?: MapView;
  layers: MapLayers;
  selected?: string;
  seq: number;
  /** The settings and regions the generated features were last placed for (`generationKey`). */
  generatedFor?: string;
}

/** What generated features depend on: when this changes, they may no longer fit the ground. */
export function generationKey(data: Pick<WorldMapFlowData, 'settings' | 'patches'>): string {
  return JSON.stringify([data.settings, data.patches]);
}

export function emptyWorldMapFlowData(): WorldMapFlowData {
  const settings = defaultMapSettings();
  const data: WorldMapFlowData = {
    editor: 'map',
    settings,
    patches: [],
    strokes: [],
    elements: [],
    layers: { ...DEFAULT_LAYERS },
    seq: 0,
  };
  return { ...data, elements: generateFeatures(data), generatedFor: generationKey(data) };
}

export function nextMapId(data: WorldMapFlowData, prefix: string): { id: string; data: WorldMapFlowData } {
  const seq = (data.seq ?? 0) + 1;
  return { id: `${prefix}_${seq}`, data: { ...data, seq } };
}

/** An element as its catalogue says it should be, placed at a point. */
export function placeElement(data: WorldMapFlowData, type: string, x: number, y: number, over: Partial<MapElement> = {}): WorldMapFlowData {
  const entry = catalogueEntry(type);
  if (!entry) return data;
  const taken = nextMapId(data, 'el');
  const element: MapElement = {
    id: taken.id,
    type,
    x,
    y,
    size: entry.size,
    rotation: 0,
    ...(entry.shapes[0] === 'line' ? { width: entry.width, points: [x, y, x + entry.size / 1000, y] } : {}),
    ...over,
  };
  return { ...taken.data, elements: [...taken.data.elements, element], selected: element.id };
}

/** Change an element. Editing a generated one keeps it: it is now someone's, and the next generation leaves it be. */
export function updateElement(data: WorldMapFlowData, id: string, change: Partial<MapElement>): WorldMapFlowData {
  return {
    ...data,
    elements: data.elements.map((element) => (element.id === id ? { ...element, ...change, id, generated: false } : element)),
  };
}

export function deleteElement(data: WorldMapFlowData, id: string): WorldMapFlowData {
  return { ...data, elements: data.elements.filter((element) => element.id !== id), ...(data.selected === id ? { selected: undefined } : {}) };
}

/** An element's layer, from its catalogue entry. */
export function layerOfElement(element: MapElement): MapLayer {
  return catalogueEntry(element.type)?.layer ?? 'site';
}

/** Should this element be drawn at this zoom — and named? */
export function elementVisibility(element: MapElement, pixel: number): { drawn: boolean; labelled: boolean } {
  const layer = layerOfElement(element);
  const metresPerPixel = pixel * 1000;
  return {
    drawn: drawnAt(element.size, metresPerPixel, layer),
    labelled: Boolean(element.name) && labelledAt(element.size, metresPerPixel, layer),
  };
}

/** The element under a point, smallest first — a street before the city it is in. */
export function elementAt(elements: readonly MapElement[], x: number, y: number, pixel: number, reachPx = 8): MapElement | undefined {
  const reach = reachPx * pixel;
  const hits: Array<[number, MapElement]> = [];
  for (const element of elements) {
    if (!elementVisibility(element, pixel).drawn) continue;
    const radius = element.size / 2000;
    let distance: number;
    if (element.points && element.points.length >= 4) {
      distance = Infinity;
      for (let index = 0; index + 3 < element.points.length; index += 2) {
        distance = Math.min(distance, segmentDistance(x, y, element.points[index]!, element.points[index + 1]!, element.points[index + 2]!, element.points[index + 3]!));
      }
      distance -= (element.width ?? 0) / 2000;
    } else distance = Math.max(0, Math.hypot(x - element.x, y - element.y) - radius);
    if (distance <= reach) hits.push([element.size, element]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits[0]?.[1];
}

function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/* ------------------------------------------------------------------ *
 * Generating the features
 * ------------------------------------------------------------------ */

const SYLLABLES = ['ar', 'bel', 'cor', 'dun', 'el', 'fen', 'gal', 'har', 'is', 'kar', 'lor', 'mar', 'nor', 'or', 'pel', 'quin', 'ros', 'sel', 'tor', 'ul', 'val', 'wen', 'yr', 'zan', 'ash', 'bri', 'cal', 'dra', 'eth', 'thal', 'mir', 'ven', 'sol', 'ka', 'ri', 'na', 'lo', 'te'];
const ENDINGS = ['', '', 'ia', 'on', 'en', 'ar', 'is', 'um', 'eth', 'or'];
const TOWN_ENDINGS = ['ton', 'ford', 'burg', 'wick', 'mouth', 'stead', 'holm', 'by', 'field', 'haven', 'port', 'bridge'];

/** A name for a place, the same for the same seed and index. */
export function placeName(seed: number, kind: 'land' | 'town' | 'water' = 'land'): string {
  const random = rng(seed);
  const count = 2 + Math.floor(random() * (kind === 'town' ? 1.4 : 2));
  let name = '';
  for (let index = 0; index < count; index += 1) name += SYLLABLES[Math.floor(random() * SYLLABLES.length)]!;
  name += kind === 'town' && random() < 0.55 ? TOWN_ENDINGS[Math.floor(random() * TOWN_ENDINGS.length)]! : ENDINGS[Math.floor(random() * ENDINGS.length)]!;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The features that go with the terrain: waters, mountain ranges, peaks, rivers
 * and settlements, found on a coarse grid of samples over the whole map.
 *
 * Deterministic in the settings, so regenerating an unchanged map gives the same
 * places with the same names. User-made and user-edited elements are kept; the
 * generated ones are replaced.
 */
export function generateFeatures(data: Pick<WorldMapFlowData, 'settings' | 'patches' | 'strokes' | 'elements'>): MapElement[] {
  const { settings } = data;
  const kept = data.elements.filter((element) => !element.generated);
  // Settlements first: the ground round them depends on them, so the grid is
  // sampled without the old ones' fields.
  const terrain = compileTerrain({ ...data, elements: kept });
  const columns = 200;
  const cell = settings.widthKm / columns;
  const rows = Math.max(1, Math.round(settings.heightKm / cell));
  const grid: GroundSample[] = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < columns; i += 1) grid.push(terrain.sample((i + 0.5) * cell, (j + 0.5) * cell, cell));
  }
  const at = (i: number, j: number) => grid[j * columns + i]!;
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < columns && j < rows;
  const seed = hashSeed(settings.seed);
  let serial = 0;
  const out: MapElement[] = [];
  const id = () => `gen_${(serial += 1)}`;
  const toKm = (i: number, j: number) => ({ x: (i + 0.5) * cell, y: (j + 0.5) * cell });

  // Connected pieces of the grid where a test holds.
  const components = (test: (sample: GroundSample) => boolean) => {
    const label = new Int32Array(grid.length).fill(-1);
    const found: number[][] = [];
    for (let start = 0; start < grid.length; start += 1) {
      if (label[start] !== -1 || !test(grid[start]!)) continue;
      const cells: number[] = [];
      const stack = [start];
      label[start] = found.length;
      while (stack.length > 0) {
        const index = stack.pop()!;
        cells.push(index);
        const i = index % columns;
        const j = (index - i) / columns;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ni = i + di;
          const nj = j + dj;
          if (!inside(ni, nj)) continue;
          const next = nj * columns + ni;
          if (label[next] !== -1 || !test(grid[next]!)) continue;
          label[next] = found.length;
          stack.push(next);
        }
      }
      found.push(cells);
    }
    return found;
  };
  const middle = (cells: number[]) => {
    let sx = 0;
    let sy = 0;
    for (const index of cells) {
      const i = index % columns;
      sx += i;
      sy += (index - i) / columns;
    }
    return toKm(sx / cells.length, sy / cells.length);
  };
  const across = (cells: number[]) => Math.sqrt(cells.length) * cell * 1000;

  if (settings.features.waters) {
    for (const cells of components((sample) => sample.water)) {
      if (cells.length < 3) continue;
      const touchesEdge = cells.some((index) => {
        const i = index % columns;
        const j = (index - i) / columns;
        return i === 0 || j === 0 || i === columns - 1 || j === rows - 1;
      });
      const size = across(cells);
      const place = middle(cells);
      const name = placeName(seed + 1000 + serial, 'water');
      const type = touchesEdge ? (size > 1_200_000 ? 'geo/ocean' : 'geo/sea') : size > 150_000 ? 'geo/sea' : 'natural/water/lake';
      out.push({
        id: id(),
        type,
        name: type === 'geo/ocean' ? `${name} Ocean` : type === 'geo/sea' ? `${name} Sea` : `Lake ${name}`,
        ...place,
        size,
        rotation: 0,
        generated: true,
      });
    }
  }

  if (settings.features.mountainRanges) {
    for (const cells of components((sample) => !sample.water && sample.elevation > 1500)) {
      if (cells.length < 5) continue;
      out.push({
        id: id(),
        type: 'geo/mountain_range',
        name: `${placeName(seed + 2000 + serial)} Mountains`,
        ...middle(cells),
        size: across(cells) * 1.4,
        rotation: 0,
        generated: true,
        facts: { highest: Math.max(...cells.map((index) => grid[index]!.elevation)) },
      });
    }
  }

  if (settings.features.peaks) {
    const peaks: Array<{ i: number; j: number; height: number }> = [];
    for (let j = 2; j < rows - 2; j += 1) {
      for (let i = 2; i < columns - 2; i += 1) {
        const height = at(i, j).elevation;
        if (at(i, j).water || height < 1800) continue;
        let top = true;
        for (let dj = -2; dj <= 2 && top; dj += 1) for (let di = -2; di <= 2 && top; di += 1) if ((di || dj) && at(i + di, j + dj).elevation > height) top = false;
        if (top) peaks.push({ i, j, height });
      }
    }
    peaks.sort((a, b) => b.height - a.height);
    for (const peak of peaks.slice(0, 30)) {
      out.push({
        id: id(),
        type: 'natural/peak',
        name: `Mount ${placeName(seed + 3000 + serial)}`,
        ...toKm(peak.i, peak.j),
        size: 4000,
        rotation: 0,
        generated: true,
        facts: { elevation: Math.round(peak.height) },
      });
    }
  }

  // Rivers: from wet high ground, downhill to the sea.
  const riverCells = new Set<number>();
  if (settings.features.rivers) {
    const random = rng(seed + 77);
    const sources: number[] = [];
    grid.forEach((sample, index) => {
      if (!sample.water && sample.elevation > 500 && sample.moisture > 0.5 && sample.biome !== 'snow' && random() < 0.05) sources.push(index);
    });
    for (const source of sources.slice(0, 80)) {
      const path: number[] = [source];
      let current = source;
      for (let step = 0; step < 400; step += 1) {
        const i = current % columns;
        const j = (current - i) / columns;
        let lowest = current;
        for (let dj = -1; dj <= 1; dj += 1) {
          for (let di = -1; di <= 1; di += 1) {
            if (!inside(i + di, j + dj)) continue;
            const next = (j + dj) * columns + (i + di);
            if (grid[next]!.elevation < grid[lowest]!.elevation) lowest = next;
          }
        }
        if (lowest === current) break; // a hollow: the river ends in it
        path.push(lowest);
        current = lowest;
        if (grid[lowest]!.water || riverCells.has(lowest)) break;
      }
      const reachesWater = grid[current]!.water || riverCells.has(current);
      if (path.length < 7 || !reachesWater) continue;
      for (const index of path) riverCells.add(index);
      const jitter = rng(seed + source);
      const points = path.flatMap((index) => {
        const i = index % columns;
        const j = (index - i) / columns;
        const place = toKm(i + (jitter() - 0.5) * 0.6, j + (jitter() - 0.5) * 0.6);
        return [place.x, place.y];
      });
      const length = path.length * cell * 1000;
      out.push({
        id: id(),
        type: 'waterway/river',
        name: `${placeName(seed + 4000 + serial, 'water')} River`,
        x: points[0]!,
        y: points[1]!,
        size: length,
        rotation: 0,
        points,
        width: Math.min(400, 20 + path.length * 4),
        generated: true,
        facts: { length: `${Math.round(length / 1000)} km` },
      });
    }
  }

  // Settlements: the best ground first, spaced by how big they are.
  const density = Math.max(0, Math.min(1, settings.density));
  const scored: Array<{ index: number; score: number }> = [];
  const scoreRandom = rng(seed + 99);
  grid.forEach((sample, index) => {
    if (sample.water || sample.elevation > 1400 || sample.temperature < -2 || ['snow', 'rock', 'sea_ice'].includes(sample.biome)) return;
    const i = index % columns;
    const j = (index - i) / columns;
    let coast = false;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (inside(i + di, j + dj) && at(i + di, j + dj).water) coast = true;
    let score = 1 - sample.elevation / 1400;
    if (coast) score += 0.8;
    if (riverCells.has(index)) score += 0.9;
    if (sample.biome === 'desert') score -= 0.8;
    if (sample.biome === 'swamp' || sample.biome === 'jungle') score -= 0.4;
    score += scoreRandom() * 0.6;
    scored.push({ index, score });
  });
  scored.sort((a, b) => b.score - a.score);
  const placed: Array<{ x: number; y: number }> = [];
  const tiers: Array<[keyof FeatureToggles, string, number, number]> = [
    ['cities', 'place/city', 420 - density * 220, 3 + Math.round(density * 14)],
    ['towns', 'place/town', 160 - density * 80, 8 + Math.round(density * 50)],
    ['villages', 'place/village', 70 - density * 35, 20 + Math.round(density * 130)],
  ];
  for (const [toggle, type, spacing, most] of tiers) {
    if (!settings.features[toggle]) continue;
    let count = 0;
    for (const { index } of scored) {
      if (count >= most) break;
      const i = index % columns;
      const j = (index - i) / columns;
      const offset = rng(seed + index);
      const place = toKm(i + (offset() - 0.5) * 0.8, j + (offset() - 0.5) * 0.8);
      if (placed.some((other) => Math.hypot(other.x - place.x, other.y - place.y) < spacing)) continue;
      placed.push(place);
      count += 1;
      const entry = catalogueEntry(type)!;
      out.push({
        id: id(),
        type,
        name: placeName(seed + 5000 + index, 'town'),
        ...place,
        size: entry.size * (0.7 + offset() * 0.7),
        rotation: 0,
        generated: true,
      });
    }
  }

  return [...kept, ...out];
}

/* ------------------------------------------------------------------ *
 * Locations: named places, for reading and for other flows
 * ------------------------------------------------------------------ */

export interface MapLocation {
  id: string;
  name: string;
  kind: string;
  kindName: string;
  layer: MapLayer;
  /** Broad to narrow: the world, then every named place it lies within, then itself. */
  path: string[];
  x: number;
  y: number;
  size: number;
  description?: string;
  facts?: Record<string, string | number>;
}

/** Layers whose named areas can contain other places. */
const CONTAINERS = new Set<MapLayer>(['settlement', 'landform', 'water', 'coast', 'vegetation', 'landuse']);

/**
 * Every named element, with the path of named places it lies within: a street
 * in a city in a region in the world. Containment is by extent — within half
 * an element's size of its middle — and only something bigger can contain.
 */
export function mapLocations(data: Pick<WorldMapFlowData, 'settings' | 'elements'>): MapLocation[] {
  const named = data.elements.filter((element) => element.name?.trim());
  return named.map((element) => {
    const entry: CatalogueEntry | undefined = catalogueEntry(element.type);
    const containers = named
      .filter((other) => {
        if (other === element || other.size <= element.size) return false;
        const layer = catalogueEntry(other.type)?.layer;
        if (!layer || !CONTAINERS.has(layer)) return false;
        if (other.points && other.points.length >= 4 && !catalogueEntry(other.type)?.shapes.includes('area')) return false;
        return Math.hypot(element.x - other.x, element.y - other.y) <= other.size / 2000;
      })
      .sort((a, b) => b.size - a.size);
    return {
      id: element.id,
      name: element.name!.trim(),
      kind: element.type,
      kindName: entry?.name ?? element.type,
      layer: entry?.layer ?? 'site',
      path: [data.settings.name, ...containers.map((other) => other.name!.trim()), element.name!.trim()],
      x: Math.round(element.x * 1000) / 1000,
      y: Math.round(element.y * 1000) / 1000,
      size: Math.round(element.size),
      ...(element.description ? { description: element.description } : {}),
      ...(element.facts ? { facts: element.facts } : {}),
    };
  });
}

/** A distance in metres as it would be said: `350 m`, `4.2 km`, `1,200 km`. */
export function formatSize(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString('en')} km`;
}

export function summariseMap(data: WorldMapFlowData): string {
  const named = data.elements.filter((element) => element.name).length;
  return [
    `${data.settings.widthKm.toLocaleString('en')} × ${data.settings.heightKm.toLocaleString('en')} km`,
    `${data.elements.length} element(s), ${named} named`,
    ...(data.patches.length > 0 ? [`${data.patches.length} region(s) generated apart`] : []),
    ...(data.strokes.length > 0 ? [`${data.strokes.length} paint stroke(s)`] : []),
  ].join(' · ');
}

/* ------------------------------------------------------------------ *
 * Features onto pixels, for an image without a browser
 * ------------------------------------------------------------------ */

/**
 * Draw the elements big enough to see onto rendered ground: lines as lines in
 * their layer's color, points and areas as a marker scaled to their size.
 * Names are for the editor, which has text; this is for a picture of the whole
 * map written out by the server.
 */
export function stampElements(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  pixel: number,
  elements: readonly MapElement[],
): void {
  const put = (px: number, py: number, color: readonly number[], alpha = 1) => {
    const i = Math.round(px);
    const j = Math.round(py);
    if (i < 0 || j < 0 || i >= width || j >= height) return;
    const at = (j * width + i) * 4;
    for (let c = 0; c < 3; c += 1) pixels[at + c] = Math.round(pixels[at + c]! * (1 - alpha) + color[c]! * alpha);
  };
  const toPx = (x: number, y: number) => [(x - x0) / pixel, (y - y0) / pixel] as const;
  const colors: Partial<Record<MapLayer, readonly number[]>> = {
    water: [52, 108, 170],
    transport: [110, 90, 70],
    settlement: [40, 34, 36],
    structure: [70, 70, 76],
  };
  for (const element of elements) {
    if (!elementVisibility(element, pixel).drawn) continue;
    const layer = layerOfElement(element);
    const color = colors[layer] ?? [60, 60, 60];
    if (element.points && element.points.length >= 4) {
      const thick = Math.max(1, (element.width ?? 0) / 1000 / pixel);
      for (let index = 0; index + 3 < element.points.length; index += 2) {
        const [ax, ay] = toPx(element.points[index]!, element.points[index + 1]!);
        const [bx, by] = toPx(element.points[index + 2]!, element.points[index + 3]!);
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
        for (let step = 0; step <= steps; step += 1) {
          const cx = ax + ((bx - ax) * step) / steps;
          const cy = ay + ((by - ay) * step) / steps;
          const reach = Math.max(0, Math.floor(thick / 2));
          for (let dy = -reach; dy <= reach; dy += 1) for (let dx = -reach; dx <= reach; dx += 1) put(cx + dx, cy + dy, color);
        }
      }
      continue;
    }
    if (layer !== 'settlement' && layer !== 'structure' && layer !== 'site') continue;
    const [cx, cy] = toPx(element.x, element.y);
    const reach = Math.max(1, Math.min(6, Math.round(element.size / 1000 / pixel / 2)));
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        const edge = Math.max(Math.abs(dx), Math.abs(dy)) === reach;
        put(cx + dx, cy + dy, edge ? [250, 248, 240] : color, edge ? 0.9 : 1);
      }
    }
  }
}
