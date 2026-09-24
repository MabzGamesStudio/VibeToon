import { OSM_ELEMENTS, OSM_SCHEMA_VERSION } from './mapCatalogueData';

/**
 * Every kind of thing that can be put on a world map.
 *
 * Most of it — several hundred elements, from a glacier to a jetty — comes from
 * OpenStreetMap's tagging schema (see `scripts/map-catalogue.ts`): real map
 * features with real names and the words people search for them by. What
 * OpenStreetMap does not have is the largest scales, because it maps what can be
 * surveyed; continents, oceans, mountain ranges and deserts are added here.
 *
 * Every element has a **default size** — the distance across a point or an
 * area, the length of a line — and from that a **scale tier**. The tier is what
 * lets a map hold a mountain range and a garden shed at once: each is drawn and
 * labelled only once it is big enough on screen to read, so zoomed out you see
 * the range and the city, and zoomed in the street and the jetty.
 */

export type MapLayer =
  | 'landform'
  | 'water'
  | 'coast'
  | 'vegetation'
  | 'landuse'
  | 'settlement'
  | 'transport'
  | 'structure'
  | 'site';

export const MAP_LAYERS: readonly MapLayer[] = [
  'landform',
  'water',
  'coast',
  'vegetation',
  'landuse',
  'settlement',
  'transport',
  'structure',
  'site',
];

export const MAP_LAYER_LABEL: Record<MapLayer, string> = {
  landform: 'Landforms',
  water: 'Water',
  coast: 'Coast',
  vegetation: 'Vegetation',
  landuse: 'Land use',
  settlement: 'Settlements & regions',
  transport: 'Roads, rail & air',
  structure: 'Structures',
  site: 'Sites & places of interest',
};

export type MapShape = 'point' | 'line' | 'area';

export type ScaleTier = 'continent' | 'region' | 'area' | 'district' | 'neighbourhood' | 'site' | 'object';

export const SCALE_TIERS: readonly ScaleTier[] = ['continent', 'region', 'area', 'district', 'neighbourhood', 'site', 'object'];

export const SCALE_TIER_LABEL: Record<ScaleTier, string> = {
  continent: 'Continent — 1000 km and up',
  region: 'Region — 100 to 1000 km',
  area: 'Area — 10 to 100 km',
  district: 'District — 1 to 10 km',
  neighbourhood: 'Neighbourhood — 100 m to 1 km',
  site: 'Site — 10 to 100 m',
  object: 'Object — under 10 m',
};

/** Which tier a size in metres belongs to. */
export function tierOf(size: number): ScaleTier {
  if (size >= 1_000_000) return 'continent';
  if (size >= 100_000) return 'region';
  if (size >= 10_000) return 'area';
  if (size >= 1000) return 'district';
  if (size >= 100) return 'neighbourhood';
  if (size >= 10) return 'site';
  return 'object';
}

export interface CatalogueEntry {
  /** `natural/peak`, `place/city`; `geo/…` for the ones added here. */
  id: string;
  name: string;
  /** How it can be drawn; the first is how it is placed. */
  shapes: MapShape[];
  layer: MapLayer;
  /** Metres across a point or area, or the length of a line. */
  size: number;
  /** For a line: how wide it is drawn, in metres. */
  width: number;
  terms: string[];
  tier: ScaleTier;
  source: 'openstreetmap' | 'geography';
}

/** The largest scales, which OpenStreetMap does not map, and two names people reach for. */
const GEOGRAPHY: ReadonlyArray<readonly [string, string, string, MapLayer, number, number, string]> = [
  ['geo/continent', 'Continent', 'a', 'landform', 4_000_000, 0, 'landmass|mainland'],
  ['geo/ocean', 'Ocean', 'a', 'water', 4_000_000, 0, 'deep sea|main'],
  ['geo/sea', 'Sea', 'a', 'water', 700_000, 0, 'marginal sea|inland sea'],
  ['geo/gulf', 'Gulf', 'a', 'water', 250_000, 0, 'bight|large bay'],
  ['geo/sound', 'Sound', 'a', 'water', 40_000, 0, 'inlet|channel'],
  ['geo/lagoon', 'Lagoon', 'a', 'coast', 6000, 0, 'coastal lake|haff'],
  ['geo/estuary', 'Estuary', 'a', 'coast', 12_000, 0, 'firth|river mouth'],
  ['geo/delta', 'River delta', 'a', 'coast', 60_000, 0, 'distributaries|mouth'],
  ['geo/fjord', 'Fjord', 'l', 'coast', 50_000, 3000, 'fiord|sea loch'],
  ['geo/atoll', 'Atoll', 'a', 'coast', 12_000, 0, 'coral ring|ring island'],
  ['geo/archipelago', 'Archipelago', 'a', 'landform', 250_000, 0, 'island chain|islands'],
  ['geo/isthmus', 'Isthmus', 'a', 'landform', 25_000, 0, 'land bridge|neck'],
  ['geo/mountain_range', 'Mountain range', 'a', 'landform', 400_000, 0, 'mountains|cordillera|sierra|massif'],
  ['geo/mountain', 'Mountain', 'p', 'landform', 8000, 0, 'mount|summit'],
  ['geo/hill', 'Hill', 'p', 'landform', 1200, 0, 'knoll|hillock|mound|down'],
  ['geo/highlands', 'Highlands', 'a', 'landform', 150_000, 0, 'uplands|high country'],
  ['geo/plateau', 'Plateau', 'a', 'landform', 100_000, 0, 'tableland|high plain|mesa land'],
  ['geo/plain', 'Plain', 'a', 'landform', 250_000, 0, 'lowlands|flats|lowland'],
  ['geo/basin', 'Basin', 'a', 'landform', 120_000, 0, 'depression|bowl'],
  ['geo/canyon', 'Canyon', 'l', 'landform', 60_000, 2000, 'gorge|ravine|chasm'],
  ['geo/gorge', 'Gorge', 'l', 'landform', 6000, 200, 'ravine|defile|gulch'],
  ['geo/mesa', 'Mesa', 'a', 'landform', 3000, 0, 'table mountain|tepui'],
  ['geo/butte', 'Butte', 'p', 'landform', 800, 0, 'pinnacle|outlier'],
  ['geo/crater', 'Crater', 'a', 'landform', 2000, 0, 'impact crater|maar'],
  ['geo/caldera', 'Caldera', 'a', 'landform', 15_000, 0, 'collapsed volcano'],
  ['geo/badlands', 'Badlands', 'a', 'landform', 40_000, 0, 'eroded land'],
  ['geo/karst', 'Karst', 'a', 'landform', 25_000, 0, 'limestone country|sinkholes'],
  ['geo/desert', 'Desert', 'a', 'landform', 800_000, 0, 'waste|erg|arid land'],
  ['geo/dune_field', 'Dune field', 'a', 'landform', 30_000, 0, 'erg|sand sea'],
  ['geo/dune', 'Dune', 'p', 'landform', 400, 0, 'sand dune|barchan'],
  ['geo/oasis', 'Oasis', 'a', 'vegetation', 2000, 0, 'spring|palm grove'],
  ['geo/jungle', 'Jungle', 'a', 'vegetation', 300_000, 0, 'tropical forest'],
  ['geo/rainforest', 'Rainforest', 'a', 'vegetation', 500_000, 0, 'tropical rainforest|selva'],
  ['geo/savanna', 'Savanna', 'a', 'vegetation', 400_000, 0, 'savannah|veldt'],
  ['geo/steppe', 'Steppe', 'a', 'vegetation', 500_000, 0, 'grass plain'],
  ['geo/prairie', 'Prairie', 'a', 'vegetation', 400_000, 0, 'grassland|pampas'],
  ['geo/taiga', 'Taiga', 'a', 'vegetation', 800_000, 0, 'boreal forest|snow forest'],
  ['geo/tundra', 'Tundra', 'a', 'vegetation', 800_000, 0, 'arctic plain|barren'],
  ['geo/woods', 'Woods', 'a', 'vegetation', 5000, 0, 'woodland|copse'],
  ['geo/grove', 'Grove', 'a', 'vegetation', 200, 0, 'orchard|stand of trees'],
  ['geo/ice_sheet', 'Ice sheet', 'a', 'landform', 1_500_000, 0, 'ice cap|continental glacier'],
  ['geo/pack_ice', 'Pack ice', 'a', 'water', 300_000, 0, 'sea ice|ice floe'],
  ['geo/iceberg', 'Iceberg', 'p', 'water', 500, 0, 'berg|floe'],
  ['geo/country', 'Country', 'a', 'settlement', 800_000, 0, 'nation|kingdom|realm|state'],
  ['geo/region', 'Region', 'a', 'settlement', 200_000, 0, 'province|shire|territory'],
  ['geo/district', 'District', 'a', 'settlement', 40_000, 0, 'county|canton|parish'],
  ['geo/urban_area', 'Urban area', 'a', 'landuse', 25_000, 0, 'urban|conurbation|built-up area|metropolis'],
  ['geo/port', 'Port', 'a', 'landuse', 3000, 0, 'harbour|seaport|docks'],
  ['geo/jetty', 'Jetty', 'l', 'structure', 60, 4, 'pier|landing stage|wharf'],
  ['geo/street', 'Street', 'l', 'transport', 400, 10, 'road|lane|avenue|alley'],
];

const SHAPE: Record<string, MapShape> = { p: 'point', l: 'line', a: 'area' };

function toEntry(row: readonly [string, string, string, MapLayer, number, number, string], source: CatalogueEntry['source']): CatalogueEntry {
  const [id, name, shapes, layer, size, width, terms] = row;
  return {
    id,
    name,
    shapes: [...shapes].map((letter) => SHAPE[letter]!).filter(Boolean),
    layer,
    size,
    width,
    terms: terms ? terms.split('|') : [],
    tier: tierOf(size),
    source,
  };
}

/** The whole catalogue: the large scales first, then OpenStreetMap's, each group in id order. */
export const MAP_CATALOGUE: readonly CatalogueEntry[] = [
  ...GEOGRAPHY.map((row) => toEntry(row, 'geography')),
  ...OSM_ELEMENTS.map((row) => toEntry(row, 'openstreetmap')),
];

export const MAP_CATALOGUE_SOURCE = `OpenStreetMap tagging schema ${OSM_SCHEMA_VERSION} (ISC licence), with continent-to-region scales added`;

const BY_ID = new Map(MAP_CATALOGUE.map((entry) => [entry.id, entry]));

export function catalogueEntry(id: string): CatalogueEntry | undefined {
  return BY_ID.get(id);
}

/**
 * Search the catalogue by name and terms: "jetty" finds the jetty and the pier,
 * "mountain" the mountain, the range and the peak. Name matches first, then
 * terms; ties by size, biggest first, so a search reads from the scale down.
 */
export function searchCatalogue(query: string, options: { layer?: MapLayer; limit?: number } = {}): CatalogueEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = options.layer ? MAP_CATALOGUE.filter((entry) => entry.layer === options.layer) : MAP_CATALOGUE;
  if (words.length === 0) return pool.slice(0, options.limit ?? pool.length);
  const scored: Array<[number, CatalogueEntry]> = [];
  for (const entry of pool) {
    const name = entry.name.toLowerCase();
    const terms = entry.terms.join(' ').toLowerCase();
    let score = 0;
    for (const word of words) {
      if (name === word) score += 10;
      else if (name.startsWith(word)) score += 6;
      else if (name.includes(word)) score += 4;
      else if (terms.includes(word)) score += 2;
      else {
        score = 0;
        break;
      }
    }
    if (score > 0) scored.push([score, entry]);
  }
  return scored
    .sort((a, b) => b[0] - a[0] || b[1].size - a[1].size)
    .slice(0, options.limit ?? 60)
    .map(([, entry]) => entry);
}

/**
 * How many screen pixels an element has to span before its name is shown.
 *
 * Settlements are named early — a city is a dot you want to read from far off —
 * and structures late, so zoomed out to a country the map reads as cities and
 * ranges rather than a scatter of shed names.
 */
const LABEL_PX: Record<MapLayer, number> = {
  settlement: 3,
  water: 25,
  landform: 10,
  coast: 30,
  vegetation: 60,
  landuse: 50,
  transport: 60,
  structure: 30,
  site: 30,
};

/** Is an element of this size and layer big enough on screen to draw, at this many metres a pixel? */
export function drawnAt(size: number, metresPerPixel: number, layer: MapLayer): boolean {
  const pixels = size / Math.max(1e-6, metresPerPixel);
  return layer === 'settlement' ? pixels >= 1.2 : pixels >= 2;
}

/** Is it big enough to be named? */
export function labelledAt(size: number, metresPerPixel: number, layer: MapLayer): boolean {
  return size / Math.max(1e-6, metresPerPixel) >= LABEL_PX[layer];
}
