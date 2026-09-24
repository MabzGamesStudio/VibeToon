import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAP_CATALOGUE,
  catalogueEntry,
  drawnAt,
  labelledAt,
  searchCatalogue,
  tierOf,
} from '../src/flows/mapCatalogue';
import { fbm, hashSeed, octavesFor, perlin, rng } from '../src/flows/noise';
import {
  classify,
  compileTerrain,
  deleteElement,
  elementAt,
  elementVisibility,
  emptyWorldMapFlowData,
  generateFeatures,
  mapLocations,
  placeElement,
  placeName,
  renderGround,
  updateElement,
  type WorldMapFlowData,
} from '../src/flows/worldMap';

const world = emptyWorldMapFlowData();

/* ---------------- the catalogue ---------------- */

test('the catalogue is large, and runs from continents to street furniture', () => {
  assert.ok(MAP_CATALOGUE.length > 700, `${MAP_CATALOGUE.length} elements`);
  const tiers = new Set(MAP_CATALOGUE.map((entry) => entry.tier));
  for (const tier of ['continent', 'region', 'area', 'district', 'neighbourhood', 'site', 'object']) assert.ok(tiers.has(tier as never), tier);
  assert.ok(MAP_CATALOGUE.some((entry) => entry.source === 'openstreetmap'));
  assert.equal(new Set(MAP_CATALOGUE.map((entry) => entry.id)).size, MAP_CATALOGUE.length, 'ids are unique');
});

test('features of different scales have sizes to match', () => {
  const size = (id: string) => catalogueEntry(id)!.size;
  assert.ok(size('geo/mountain_range') > size('geo/mountain') && size('geo/mountain') > size('geo/hill'));
  assert.ok(size('geo/ocean') > size('natural/beach') && size('natural/beach') > size('man_made/pier'));
  assert.ok(size('place/city') > size('place/town') && size('place/town') > size('place/village') && size('place/village') > size('building/house'));
  assert.equal(catalogueEntry('highway/residential')!.shapes[0], 'line');
  assert.ok(catalogueEntry('highway/residential')!.width > 0, 'a road has a width');
  assert.equal(tierOf(18000), 'area');
  assert.equal(tierOf(12), 'site');
});

test('search finds things by name and by the words people use for them', () => {
  const names = (query: string) => searchCatalogue(query).map((entry) => entry.id);
  assert.ok(names('jetty').includes('geo/jetty'));
  assert.ok(names('jetty').includes('man_made/pier'), 'a pier is what OpenStreetMap calls a jetty');
  assert.equal(names('mountain')[0], 'geo/mountain', 'the exact name first');
  assert.ok(names('forest').length > 3);
  assert.deepEqual(searchCatalogue('zzzqqq'), []);
  assert.ok(searchCatalogue('', { layer: 'water' }).every((entry) => entry.layer === 'water'));
});

test('names show at the scale they belong to: a city from far off, a street only close in', () => {
  const city = catalogueEntry('place/city')!;
  const street = catalogueEntry('geo/street')!;
  const far = 4000; // metres a pixel: a continent across a screen
  const near = 4;
  assert.equal(labelledAt(city.size, far, city.layer), true);
  assert.equal(drawnAt(street.size, far, street.layer), false);
  assert.equal(labelledAt(street.size, near, street.layer), true);
});

/* ---------------- noise ---------------- */

test('the same seed is the same world, and another seed another', () => {
  const one = perlin(hashSeed('a'));
  const two = perlin(hashSeed('a'));
  const three = perlin(hashSeed('b'));
  for (const [x, y] of [[0.3, 0.7], [12.1, -4.2], [100.5, 3.3]] as const) assert.equal(one(x, y), two(x, y));
  assert.notEqual(one(0.3, 0.7), three(0.3, 0.7));
  const values = Array.from({ length: 500 }, (_, index) => fbm(one, index * 0.37, index * 0.11, 6));
  assert.ok(values.every((value) => value >= -1.2 && value <= 1.2));
  const random = rng(5);
  assert.ok(Array.from({ length: 100 }, random).every((value) => value >= 0 && value < 1));
});

test('more octaves only where the pixels can show them', () => {
  assert.ok(octavesFor(1600, 5) < octavesFor(1600, 0.01));
  assert.equal(octavesFor(1600, 1e-9, 14), 14, 'capped');
  assert.equal(octavesFor(10, 1000), 1, 'never none');
});

/* ---------------- terrain ---------------- */

test('about the asked-for share of the map is land', () => {
  for (const land of [0.25, 0.6]) {
    const data = { ...world, settings: { ...world.settings, terrain: { ...world.settings.terrain, land } }, elements: [] };
    const terrain = compileTerrain(data);
    let count = 0;
    let total = 0;
    for (let j = 0; j < 30; j += 1) {
      for (let i = 0; i < 48; i += 1) {
        total += 1;
        if (!terrain.sample((i + 0.5) * (data.settings.widthKm / 48), (j + 0.5) * (data.settings.heightKm / 30), 50).water) count += 1;
      }
    }
    assert.ok(Math.abs(count / total - land) < 0.12, `asked ${land}, got ${(count / total).toFixed(2)}`);
  }
});

test('climate: colder towards the pole and up a mountain, and what grows follows it', () => {
  assert.equal(classify(-500, 10, 0.5), 'ocean');
  assert.equal(classify(-50, 10, 0.5), 'sea');
  assert.equal(classify(-500, -10, 0.5), 'sea_ice');
  assert.equal(classify(3500, 10, 0.5), 'snow');
  assert.equal(classify(400, 26, 0.8), 'jungle');
  assert.equal(classify(400, 24, 0.1), 'desert');
  assert.equal(classify(400, 12, 0.7), 'forest');
  assert.equal(classify(400, 12, 0.35), 'grass');
  assert.equal(classify(400, -3, 0.5), 'tundra');
  const terrain = compileTerrain({ ...world, elements: [] });
  const north = terrain.sample(1000, 50, 20).temperature;
  const south = terrain.sample(1000, 2400, 20).temperature;
  assert.ok(north < south - 20, `north ${north}, south ${south}`);
});

test('a switched-off kind of ground becomes its nearest neighbour, and no water means none', () => {
  const noJungle = { ...world, elements: [], settings: { ...world.settings, biomes: { ...world.settings.biomes, jungle: false } } };
  const terrain = compileTerrain(noJungle);
  for (let index = 0; index < 400; index += 1) {
    assert.notEqual(terrain.sample((index * 97) % 4000, (index * 53) % 2500, 10).biome, 'jungle');
  }
  const dry = compileTerrain({ ...world, elements: [], settings: { ...world.settings, biomes: { ...world.settings.biomes, ocean: false } } });
  for (let index = 0; index < 200; index += 1) assert.equal(dry.sample((index * 97) % 4000, (index * 53) % 2500, 10).water, false);
});

test('a region generated apart changes the ground inside it and nowhere else', () => {
  const bounds = { x0: 1000, y0: 1000, x1: 1600, y1: 1500 };
  const patched: WorldMapFlowData = {
    ...world,
    elements: [],
    patches: [{ id: 'p', bounds, seed: 'other', feather: 50, terrain: { ...world.settings.terrain, land: 1, mountains: 1 } }],
  };
  const before = compileTerrain({ ...world, elements: [] });
  const after = compileTerrain(patched);
  assert.equal(after.sample(1300, 1250, 5).water, false, 'all land in the middle of it');
  assert.deepEqual(after.sample(200, 200, 5), before.sample(200, 200, 5), 'untouched outside');
});

test('a region smaller than its blend still has its own middle', () => {
  const bounds = { x0: 2000, y0: 1200, x1: 2019, y1: 1213 };
  const patched: WorldMapFlowData = {
    ...world,
    elements: [],
    patches: [{ id: 'p', bounds, seed: 'other', feather: 60, terrain: { ...world.settings.terrain, land: 1 } }],
  };
  assert.equal(compileTerrain(patched).sample(2009.5, 1206.5, 0.05).water, false, 'all land at its middle, though the blend is 60 km');
});

test('paint wins over what was generated, and erase gives it back', () => {
  const painted: WorldMapFlowData = {
    ...world,
    elements: [],
    strokes: [{ id: 's', paint: 'desert', radius: 30, points: [2000, 1200, 2100, 1200] }],
  };
  const terrain = compileTerrain(painted);
  assert.equal(terrain.sample(2050, 1210, 1).biome, 'desert');
  assert.equal(terrain.sample(2050, 1210, 1).painted, true);
  assert.equal(terrain.sample(2050, 1210, 1).water, false, 'painting ground on the sea makes land');
  const erased = compileTerrain({ ...painted, strokes: [...painted.strokes, { id: 'e', paint: 'erase', radius: 30, points: [2050, 1210] }] });
  assert.equal(erased.sample(2050, 1210, 1).painted, false);
});

test('towns bring streets and farmland with them', () => {
  const terrain = compileTerrain(world);
  const city = world.elements.find((element) => element.type === 'place/city')!;
  assert.equal(terrain.sample(city.x, city.y, 0.01).biome, 'urban');
});

test('the ground renders to pixels of the right size, deterministically', () => {
  const terrain = compileTerrain(world);
  const one = renderGround(terrain, 1000, 1000, 5, 16, 10);
  const two = renderGround(terrain, 1000, 1000, 5, 16, 10);
  assert.equal(one.length, 16 * 10 * 4);
  assert.deepEqual(one, two);
  assert.ok(one.every((value, index) => index % 4 !== 3 || value === 255), 'opaque');
});

/* ---------------- features ---------------- */

test('generation finds waters, ranges, peaks, rivers and settlements, with names', () => {
  const kinds = new Set(world.elements.map((element) => element.type));
  for (const kind of ['geo/ocean', 'geo/mountain_range', 'natural/peak', 'waterway/river', 'place/city', 'place/town', 'place/village']) {
    assert.ok(kinds.has(kind), `no ${kind}`);
  }
  assert.ok(world.elements.every((element) => element.generated && element.name), 'all generated and named');
  const river = world.elements.find((element) => element.type === 'waterway/river')!;
  assert.ok(river.points && river.points.length >= 14, 'a river is a line');
  const cities = world.elements.filter((element) => element.type === 'place/city');
  for (const one of cities) for (const two of cities) if (one !== two) assert.ok(Math.hypot(one.x - two.x, one.y - two.y) > 150, 'cities are spaced');
});

test('generating again gives the same world, and keeps what someone made or edited', () => {
  const again = generateFeatures(world);
  assert.deepEqual(again.map((element) => element.name), world.elements.map((element) => element.name));
  let data = placeElement(world, 'geo/jetty', 100, 100, { name: 'Old Jetty' });
  const city = data.elements.find((element) => element.type === 'place/city')!;
  data = updateElement(data, city.id, { name: 'Capital' });
  const next = generateFeatures(data);
  assert.ok(next.some((element) => element.name === 'Old Jetty'));
  assert.ok(next.some((element) => element.name === 'Capital' && !element.generated), 'an edited one is kept');
  assert.equal(next.filter((element) => element.name === 'Capital').length, 1);
});

test('settlement switches turn their kind off', () => {
  const data = { ...world, settings: { ...world.settings, features: { ...world.settings.features, villages: false, rivers: false } } };
  const elements = generateFeatures(data);
  assert.equal(elements.filter((element) => element.type === 'place/village').length, 0);
  assert.equal(elements.filter((element) => element.type === 'waterway/river').length, 0);
});

test('names are made up the same way every time', () => {
  assert.equal(placeName(42), placeName(42));
  assert.match(placeName(7, 'town'), /^[A-Z][a-z]+$/);
});

/* ---------------- elements and locations ---------------- */

test('placing an element takes its catalogue size, and a line gets points', () => {
  let data = placeElement(world, 'man_made/pier', 10, 20);
  const pier = data.elements.at(-1)!;
  assert.equal(pier.size, catalogueEntry('man_made/pier')!.size);
  assert.equal(data.selected, pier.id);
  data = placeElement(data, 'geo/street', 11, 21);
  const street = data.elements.at(-1)!;
  assert.ok(street.points && street.points.length === 4);
  assert.equal(street.width, 10);
  data = deleteElement(data, street.id);
  assert.equal(data.elements.some((element) => element.id === street.id), false);
  assert.equal(placeElement(world, 'no/such/thing', 0, 0), world);
});

test('what can be seen, and what is under the pointer, depends on the zoom', () => {
  let data = placeElement({ ...world, elements: [] }, 'place/city', 500, 500, { name: 'Big' });
  data = placeElement(data, 'geo/street', 500, 500, { name: 'Long Street' });
  const [city, street] = data.elements;
  assert.equal(elementVisibility(street!, 4).drawn, false, 'a street at 4 km a pixel is nothing');
  assert.equal(elementVisibility(city!, 4).labelled, true);
  assert.equal(elementAt(data.elements, 500.1, 500, 0.002)?.name, 'Long Street', 'close in, the street');
  assert.equal(elementAt(data.elements, 500.1, 500, 4)?.name, 'Big', 'far out, the city');
});

test('each named place knows the named places it lies within', () => {
  let data = { ...world, elements: [] } as WorldMapFlowData;
  data = placeElement(data, 'geo/region', 500, 500, { name: 'Northmarch' });
  data = placeElement(data, 'place/city', 510, 505, { name: 'Karth' });
  data = placeElement(data, 'geo/street', 511, 505, { name: 'Harbour Street', description: 'Where the fish market is.' });
  data = placeElement(data, 'place/town', 900, 900, { name: 'Faraway' });
  const locations = mapLocations(data);
  const street = locations.find((location) => location.name === 'Harbour Street')!;
  assert.deepEqual(street.path, ['The World', 'Northmarch', 'Karth', 'Harbour Street']);
  assert.equal(street.description, 'Where the fish market is.');
  assert.deepEqual(locations.find((location) => location.name === 'Faraway')!.path, ['The World', 'Faraway']);
  assert.equal(locations.find((location) => location.name === 'Karth')!.kindName, 'City');
});
