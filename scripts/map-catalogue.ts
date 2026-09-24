/**
 * Build the world map's catalogue of terrain elements from OpenStreetMap's
 * tagging schema.
 *
 * The schema (`@openstreetmap/id-tagging-schema`, ISC licence) is the preset
 * list the iD map editor is built on: every kind of thing OpenStreetMap maps,
 * with an English name, search terms, and whether it is drawn as a point, a
 * line or an area. That is the large corpus: several hundred real terrain and
 * map elements, from a glacier to a jetty. This script picks the ones a world
 * map wants, gives each a layer and a default size, and writes them out as a
 * data module the studio ships with — so the map works offline and the list is
 * the same every time.
 *
 *   npm pack @openstreetmap/id-tagging-schema && tar xzf openstreetmap-id-tagging-schema-*.tgz
 *   node --import tsx scripts/map-catalogue.ts ./package
 *
 * The largest scales — continents, oceans, mountain ranges, deserts — are not
 * in it (OpenStreetMap maps what can be surveyed), and are added by hand in
 * `mapCatalogue.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node --import tsx scripts/map-catalogue.ts <unpacked id-tagging-schema package>');
  process.exit(1);
}

interface Preset {
  geometry: string[];
  tags: Record<string, string>;
  searchable?: boolean;
}
const presets = JSON.parse(readFileSync(path.join(root, 'dist/presets.json'), 'utf8')) as Record<string, Preset>;
const english = (JSON.parse(readFileSync(path.join(root, 'dist/translations/en.json'), 'utf8')) as {
  en: { presets: { presets: Record<string, { name?: string; terms?: string[] }> } };
}).en.presets.presets;
const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;

type Layer = 'landform' | 'water' | 'coast' | 'vegetation' | 'landuse' | 'settlement' | 'transport' | 'structure' | 'site';

/** Keys taken whole; the rest of the schema is shops, offices and the like, which a map of terrain does not want. */
const KEYS = new Set([
  'natural', 'landuse', 'waterway', 'place', 'man_made', 'leisure', 'highway', 'railway', 'building',
  'historic', 'tourism', 'aeroway', 'power', 'military', 'barrier', 'amenity', 'golf',
]);

/** Of highways, only the ways themselves: not crossings, signs and street furniture. */
const HIGHWAYS = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service',
  'living_street', 'pedestrian', 'track', 'path', 'footway', 'cycleway', 'bridleway', 'steps', 'road', 'busway',
]);

/** Amenities big enough to be a place on a map rather than a thing in one. */
const AMENITIES = new Set([
  'university', 'college', 'school', 'kindergarten', 'hospital', 'place_of_worship', 'marketplace', 'parking',
  'fountain', 'townhall', 'prison', 'fire_station', 'police', 'ferry_terminal', 'bus_station', 'fuel', 'library',
  'theatre', 'cinema', 'grave_yard', 'monastery', 'courthouse', 'post_office', 'bank', 'restaurant', 'cafe', 'pub',
  'bar', 'community_centre', 'arts_centre', 'clock', 'shelter', 'well', 'water_point', 'drinking_water',
  'harbourmaster', 'boat_rental', 'crematorium', 'embassy', 'events_venue', 'planetarium', 'public_bath', 'toilets',
  'recycling', 'waste_disposal', 'car_wash', 'charging_station', 'bicycle_parking', 'animal_shelter', 'nightclub',
  'casino', 'conference_centre', 'exhibition_centre', 'research_institute', 'music_school', 'driving_school',
]);

/** A size, in metres, that says what the thing is: the diameter of a point or area, the length of a line. */
const SIZES: Record<string, number> = {
  // Landforms
  'natural/peak': 3000, 'natural/volcano': 12000, 'natural/ridge': 15000, 'natural/arete': 2000,
  'natural/valley': 20000, 'natural/saddle': 800, 'natural/glacier': 15000, 'natural/cliff': 1500,
  'natural/cave_entrance': 15, 'natural/arch': 40, 'natural/rock': 20, 'natural/stone': 4, 'natural/bare_rock': 2000,
  'natural/scree': 500, 'natural/fell': 4000, 'natural/sinkhole': 60, 'natural/cape': 3000, 'natural/peninsula': 30000,
  'natural/geyser': 20, 'natural/hot_spring': 30, 'natural/spring': 5,
  // Coast and water
  'natural/bay': 25000, 'natural/strait': 30000, 'natural/beach': 600, 'natural/coastline': 50000, 'natural/reef': 3000,
  'natural/sand': 1500, 'natural/shingle': 300, 'natural/mud': 800, 'natural/water': 2000, 'natural/water/lake': 6000,
  'natural/water/pond': 80, 'natural/water/reservoir': 3000, 'natural/water/river': 1500, 'natural/water/basin': 100,
  'natural/water/oxbow': 1000, 'natural/water/canal': 1000, 'natural/water/moat': 200, 'natural/water/stream': 300,
  'natural/water/wastewater': 100,
  'waterway/river': 150000, 'waterway/stream': 6000, 'waterway/stream_intermittent': 3000, 'waterway/canal': 20000,
  'waterway/ditch': 800, 'waterway/drain': 800, 'waterway/tidal_channel': 3000, 'waterway/dam': 400,
  'waterway/weir': 40, 'waterway/waterfall': 60, 'waterway/dock': 150, 'waterway/boatyard': 200,
  // Vegetation
  'natural/wood': 3000, 'landuse/forest': 5000, 'natural/scrub': 1000, 'natural/heath': 1500, 'natural/grassland': 3000,
  'natural/wetland': 2000, 'natural/tree': 12, 'natural/tree_row': 150, 'natural/shrub': 3, 'natural/tree_stump': 1,
  // Land use
  'landuse/farmland': 1500, 'landuse/farmyard': 150, 'landuse/meadow': 600, 'landuse/orchard': 400, 'landuse/vineyard': 500,
  'landuse/residential': 1200, 'landuse/industrial': 800, 'landuse/commercial': 400, 'landuse/retail': 300,
  'landuse/quarry': 600, 'landuse/cemetery': 200, 'landuse/allotments': 150, 'landuse/harbour': 1500,
  'landuse/military': 3000, 'landuse/military/airfield': 3000, 'landuse/military/base': 2500, 'landuse/landfill': 700,
  'landuse/railway': 400, 'landuse/salt_pond': 800, 'landuse/winter_sports': 3000, 'landuse/grass': 100,
  'landuse/flowerbed': 10, 'landuse/greenhouse_horticulture': 300, 'landuse/construction': 200,
  // Settlements
  'place/city': 18000, 'place/town': 4000, 'place/village': 1200, 'place/hamlet': 300, 'place/suburb': 3000,
  'place/quarter': 1500, 'place/neighbourhood': 700, 'place/city_block': 150, 'place/plot': 40,
  'place/isolated_dwelling': 60, 'place/locality': 800, 'place/square': 80, 'place/island': 25000, 'place/islet': 300,
  // Transport
  'highway/motorway': 30000, 'highway/trunk': 20000, 'highway/primary': 12000, 'highway/secondary': 6000,
  'highway/tertiary': 3000, 'highway/unclassified': 2000, 'highway/residential': 500, 'highway/service': 150,
  'highway/living_street': 200, 'highway/pedestrian': 300, 'highway/track': 2000, 'highway/path': 1000,
  'highway/footway': 300, 'highway/cycleway': 1500, 'highway/bridleway': 1500, 'highway/steps': 20, 'highway/road': 1000,
  'highway/busway': 2000, 'railway/rail': 50000, 'railway/subway': 8000, 'railway/tram': 4000,
  'railway/light_rail': 8000, 'railway/narrow_gauge': 10000, 'railway/station': 250, 'railway/platform': 150,
  'aeroway/aerodrome': 3500, 'aeroway/runway': 3000, 'aeroway/taxiway': 800, 'aeroway/apron': 400,
  'aeroway/helipad': 25, 'aeroway/terminal': 250, 'aeroway/hangar': 70,
  // Structures
  'man_made/pier': 150, 'man_made/breakwater': 500, 'man_made/groyne': 80, 'man_made/lighthouse': 15,
  'man_made/tower': 15, 'man_made/bridge': 250, 'man_made/dyke': 3000, 'man_made/embankment': 500,
  'man_made/water_tower': 15, 'man_made/windmill': 12, 'man_made/chimney': 8, 'man_made/mineshaft': 20,
  'man_made/crane': 30, 'man_made/storage_tank': 30, 'man_made/silo': 10, 'man_made/wastewater_plant': 300,
  'man_made/works': 400, 'man_made/quay': 300, 'man_made/cutline': 2000, 'man_made/pipeline': 5000,
  'man_made/obelisk': 5, 'man_made/cross': 3, 'man_made/flagpole': 1, 'man_made/mast': 5,
  'building/house': 12, 'building/hut': 5, 'building/shed': 5, 'building/cabin': 8, 'building/garage': 6,
  'building/garages': 20, 'building/barn': 25, 'building/farm': 20, 'building/greenhouse': 30, 'building/apartments': 40,
  'building/cathedral': 100, 'building/church': 40, 'building/chapel': 15, 'building/mosque': 40, 'building/temple': 30,
  'building/synagogue': 25, 'building/warehouse': 60, 'building/industrial': 80, 'building/hospital': 90,
  'building/school': 50, 'building/university': 100, 'building/train_station': 120, 'building/hangar': 60,
  'building/stadium': 250, 'building/ruins': 20, 'building/castle': 120, 'building/bunker': 12,
  'power/plant': 800, 'power/generator': 40, 'power/line': 20000, 'power/minor_line': 2000, 'power/tower': 10,
  'power/pole': 1, 'power/substation': 100, 'barrier/city_wall': 3000, 'barrier/wall': 100, 'barrier/fence': 100,
  'barrier/hedge': 60, 'barrier/retaining_wall': 50, 'barrier/ditch': 200,
  // Sites
  'leisure/park': 400, 'leisure/nature_reserve': 25000, 'leisure/garden': 60, 'leisure/pitch': 100,
  'leisure/stadium': 250, 'leisure/golf_course': 1500, 'leisure/marina': 400, 'leisure/beach_resort': 1000,
  'leisure/playground': 40, 'leisure/swimming_pool': 25, 'leisure/sports_centre': 120, 'leisure/track': 400,
  'leisure/common': 300, 'leisure/dog_park': 60, 'leisure/fishing': 50, 'leisure/slipway': 30, 'leisure/water_park': 300,
  'leisure/bird_hide': 5, 'leisure/firepit': 2, 'leisure/picnic_table': 2, 'leisure/bandstand': 10,
  'historic/castle': 150, 'historic/fort': 300, 'historic/ruins': 100, 'historic/monument': 20,
  'historic/memorial': 8, 'historic/archaeological_site': 300, 'historic/city_gate': 20, 'historic/battlefield': 3000,
  'historic/manor': 60, 'historic/tomb': 8, 'historic/wayside_cross': 2, 'historic/wayside_shrine': 3,
  'historic/ship': 40, 'historic/wreck': 60, 'historic/boundary_stone': 1, 'historic/pillory': 2,
  'tourism/attraction': 100, 'tourism/viewpoint': 20, 'tourism/camp_site': 200, 'tourism/hotel': 60,
  'tourism/museum': 80, 'tourism/zoo': 400, 'tourism/theme_park': 800, 'tourism/picnic_site': 30,
  'tourism/information': 4, 'tourism/alpine_hut': 20, 'tourism/artwork': 5, 'tourism/caravan_site': 200,
  'tourism/chalet': 12, 'tourism/guest_house': 20, 'tourism/hostel': 30, 'tourism/motel': 60,
  'tourism/wilderness_hut': 8, 'tourism/aquarium': 80,
  'amenity/university': 800, 'amenity/college': 300, 'amenity/school': 120, 'amenity/hospital': 250,
  'amenity/place_of_worship': 40, 'amenity/marketplace': 100, 'amenity/parking': 60, 'amenity/fountain': 8,
  'amenity/townhall': 60, 'amenity/prison': 300, 'amenity/grave_yard': 150, 'amenity/monastery': 200,
  'amenity/ferry_terminal': 150, 'amenity/bus_station': 100, 'amenity/well': 2, 'amenity/clock': 2,
  'golf/course': 1500,
};

/** What each part of the schema is, on a map. */
function layerOf(id: string, key: string, value: string): Layer {
  if (id.startsWith('natural/water') || key === 'waterway') return 'water';
  if (key === 'natural') {
    if (['beach', 'coastline', 'reef', 'shingle', 'mud', 'bay', 'strait', 'cape', 'peninsula', 'sand'].includes(value.split('/')[0]!)) return 'coast';
    if (['wood', 'scrub', 'heath', 'grassland', 'wetland', 'tree', 'tree_row', 'shrub', 'tree_stump'].includes(value.split('/')[0]!)) return 'vegetation';
    return 'landform';
  }
  if (key === 'landuse') return value === 'forest' || value.startsWith('meadow') ? 'vegetation' : 'landuse';
  if (key === 'place') return 'settlement';
  if (['highway', 'railway', 'aeroway'].includes(key)) return 'transport';
  if (['building', 'man_made', 'power', 'barrier'].includes(key)) return 'structure';
  return 'site';
}

/** A size for anything not named above: by what kind of thing it is and how it is drawn. */
function defaultSize(key: string, geometry: string[]): number {
  // Something that can be a point is point-sized by default: a street cabinet can
  // be drawn as its outline, and is still a box, not a neighbourhood.
  const area = geometry.includes('area') && !geometry.includes('point');
  const line = geometry.includes('line') && !area && !geometry.includes('point');
  switch (key) {
    case 'natural':
      return line ? 2000 : area ? 1500 : 60;
    case 'landuse':
      return 800;
    case 'waterway':
      return line ? 2000 : 30;
    case 'building':
      return 20;
    case 'man_made':
      return line ? 200 : area ? 120 : 12;
    case 'power':
      return line ? 2000 : 20;
    case 'barrier':
      return 60;
    case 'highway':
      return 500;
    case 'railway':
      return line ? 5000 : 60;
    case 'aeroway':
      return 300;
    case 'military':
      return 500;
    case 'amenity':
      return area ? 60 : 15;
    default:
      return area ? 200 : 20;
  }
}

/** How wide a line is drawn, in metres. Areas and points have none. */
const WIDTHS: Record<string, number> = {
  'waterway/river': 80, 'waterway/stream': 3, 'waterway/stream_intermittent': 2, 'waterway/canal': 20,
  'waterway/ditch': 2, 'waterway/drain': 2, 'waterway/tidal_channel': 30, 'waterway/dam': 40, 'waterway/weir': 8,
  'highway/motorway': 30, 'highway/trunk': 22, 'highway/primary': 16, 'highway/secondary': 12, 'highway/tertiary': 10,
  'highway/unclassified': 7, 'highway/residential': 8, 'highway/service': 5, 'highway/living_street': 6,
  'highway/pedestrian': 8, 'highway/track': 4, 'highway/path': 2, 'highway/footway': 2, 'highway/cycleway': 3,
  'highway/bridleway': 3, 'highway/steps': 2, 'highway/road': 8, 'highway/busway': 8, 'railway/rail': 8,
  'railway/subway': 6, 'railway/tram': 5, 'railway/light_rail': 6, 'railway/narrow_gauge': 5, 'railway/platform': 6,
  'aeroway/runway': 45, 'aeroway/taxiway': 20, 'man_made/pier': 8, 'man_made/breakwater': 15, 'man_made/groyne': 5,
  'man_made/dyke': 20, 'man_made/embankment': 8, 'man_made/quay': 10, 'man_made/cutline': 10, 'man_made/pipeline': 2,
  'power/line': 10, 'power/minor_line': 4, 'barrier/city_wall': 5, 'barrier/wall': 1, 'barrier/fence': 0.3,
  'barrier/hedge': 2, 'barrier/retaining_wall': 1, 'barrier/ditch': 3, 'natural/ridge': 300, 'natural/arete': 50,
  'natural/cliff': 20, 'natural/coastline': 10, 'natural/tree_row': 6, 'natural/valley': 1500, 'leisure/track': 8,
};

const rows: string[] = [];
let kept = 0;
for (const [id, preset] of Object.entries(presets).sort(([a], [b]) => a.localeCompare(b))) {
  if (preset.searchable === false) continue;
  const [key, ...rest] = id.split('/');
  const value = rest.join('/');
  if (!key || !value || !KEYS.has(key)) continue;
  if (key === 'highway' && !HIGHWAYS.has(value)) continue;
  if (key === 'amenity' && !AMENITIES.has(value.split('/')[0]!)) continue;
  if (key === 'railway' && /crossing|switch|buffer_stop|signal|level|derail|milestone|train_wash|turntable|roundhouse|halt|tram_stop|subway_entrance/.test(value)) continue;
  const geometry = preset.geometry.filter((one) => one === 'point' || one === 'line' || one === 'area');
  if (geometry.length === 0) continue;
  const name = english[id]?.name;
  if (!name) continue;
  const terms = (english[id]?.terms ?? []).slice(0, 8).map((term) => term.replace(/\|/g, ' '));
  const size = SIZES[id] ?? defaultSize(key, geometry);
  const width = geometry.includes('line') && !geometry.includes('area') ? (WIDTHS[id] ?? 4) : (WIDTHS[id] ?? 0);
  const shape = geometry.map((one) => one[0]).join('');
  rows.push(`  [${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(shape)}, ${JSON.stringify(layerOf(id, key, value))}, ${size}, ${width}, ${JSON.stringify(terms.join('|'))}],`);
  kept += 1;
}

const out = `/*
 * Generated by scripts/map-catalogue.ts from @openstreetmap/id-tagging-schema ${version}
 * (ISC licence, https://github.com/openstreetmap/id-tagging-schema). Do not edit by hand:
 * change the script and run it again.
 *
 * [id, name, shape (p point, l line, a area), layer, default size in metres, line width in metres, search terms]
 */
import type { MapLayer } from './mapCatalogue';

export const OSM_SCHEMA_VERSION = ${JSON.stringify(version)};

export const OSM_ELEMENTS: ReadonlyArray<readonly [string, string, string, MapLayer, number, number, string]> = [
${rows.join('\n')}
];
`;
const target = path.resolve(import.meta.dirname, '../packages/shared/src/flows/mapCatalogueData.ts');
writeFileSync(target, out);
console.log(`Wrote ${path.relative(process.cwd(), target)}: ${kept} elements from schema ${version}`);
