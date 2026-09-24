# World map

`world.map` · takes **World** (optional) · gives **`map.json`**, **`locations.json`**, **`map.png`** and **`map.md`**

A generated world that can be zoomed from the whole of it down to a harbour wall,
painted over, regenerated in parts, and filled with named places — each with a
description, and each shown at the scales where it makes sense: a city's name from
far off, a street's only close in.

## The ground

The ground is a pure function of position and seed, worked out wherever it is
looked at; nothing is stored but the settings, regions and paint. So there is
detail all the way down: zooming in simply adds finer octaves of noise.

It is built in layers, each read from the one before:

1. **Land and water.** Warped fractal noise, with sea level set from the heights
   actually there so that "40% land" is 40% land whatever the seed. Mountains are
   ridged noise, in belts rather than everywhere.
2. **Climate.** Temperature from latitude (the map's top and bottom latitudes are
   settings) and height (6.5 °C cooler a kilometre up), plus noise; moisture from
   noise and nearness to the sea. Both can be shifted for the whole world.
3. **Vegetation.** A Whittaker-style table of temperature against moisture gives
   the biome: desert, steppe, grass, savanna, woods, forest, taiga, jungle, swamp,
   tundra, snow, rock, beach, sea ice, lakes, sea and ocean.
4. **Land use.** Urban ground round every settlement, farmland beyond it, sized by
   the settlement.

Every biome can be switched off under **What is generated**; ground that would
have been it becomes the nearest sensible thing (no jungle → forest, no desert →
steppe, no water → low land). Close in, the ground is textured by what it is —
street grids, field boundaries, tree cover, dunes.

| Setting | What it does |
| --- | --- |
| Seed | The world. The same seed gives the same ground everywhere. |
| Width, height | Its size in km. |
| Top and bottom latitude | Where on a globe it sits — the climate follows. |
| Land | How much of it is land. |
| Landmass size | How big a typical continent or island is. |
| Roughness | How ragged the coasts and land are. |
| Mountains | How much of the land is ranges, and how high. |
| Temperature, moisture | Shift the climate warmer or colder, wetter or drier. |
| Settlements | How many cities, towns and villages are placed. |

## Features

**Regenerate features** places the things the ground calls for, and names them:
seas and lakes, mountain ranges and their highest peaks, rivers running downhill
to the sea, and cities, towns and villages spaced by the settlements setting. Each
kind can be switched off. Anything placed or edited by hand is kept when
regenerating; a note says when the ground has changed since features were last
placed.

## The catalogue

Elements to place come from the **OpenStreetMap tagging schema** (the
`@openstreetmap/id-tagging-schema` package, version 7.2.0, ISC licence) — 733
kinds of natural feature, water, coast, land use, settlement, transport,
structure and site — plus 50 kinds at continent-to-region scale that OpenStreetMap
does not tag (continent, ocean, mountain range, country, region, district, urban
area…). `scripts/map-catalogue.ts` rebuilds the list from an unpacked copy of the
package. (The OpenStreetMap wiki and taginfo, where tag usage is counted, could not
be reached when this was built, so the schema package is the source.)

Each kind has a **layer** — landform, water, coast, vegetation, land use,
settlement, transport, structure, site — a **shape** (point, line, area), and a
**default size** that puts it on a scale tier:

| Tier | Size | For example |
| --- | --- | --- |
| Continental | 1,000 km and up | continent, ocean |
| Regional | 100 km – 1,000 km | sea, mountain range, desert, country |
| Local | 10 km – 100 km | city, lake, forest, region |
| Neighbourhood | 1 km – 10 km | town, mountain, bay, farmland |
| Site | 100 m – 1 km | village, hill, beach, harbour, street |
| Structure | under 100 m | building, jetty, pier, well |

**Search** by name or by the terms OpenStreetMap lists for each ("wharf" finds the
pier), and narrow by layer.

## Scales

An element is drawn once it is a couple of pixels across and named once it is big
enough for its layer: settlements are named from far off, landforms at ten pixels
across, water at twenty-five, buildings and roads only close in. So zoomed out to a
continent the map reads as seas, ranges and cities; zoomed in to a town, its
streets, jetties and buildings appear with their names. Labels that would collide
give way to the bigger place.

## Editing

- **Zoom** with the wheel about the pointer, or − / **World** / +; **pan** by
  dragging the ground (or shift- or middle-dragging with any tool). Full screen is
  on the stage bar.
- **Select & move.** Click a place to open it: name, description, size (or width
  for a line), turn, what it **lies within** and the ground under it. Drag it to
  move it; drag the handles to resize or turn it, or a line's points to reshape it.
  Clicking bare ground shows what is there — biome, height, temperature.
- **Place.** Pick a kind, then click the map. Lines (rivers, roads, jetties,
  streets) are clicked point by point and finished with Enter, a double-click or a
  right-click.
- **Paint.** Brush any biome — or plain land, which puts land under the sea — with
  a brush sized in screen pixels. **Erase** gives the generated ground back. The
  last stroke is on top.
- **Generate a region.** Drag out a rectangle to generate that stretch again with
  its own seed and its own land, mountains, roughness and climate, blended in at the
  edges. Regions are listed under the map, to rename, reseed (🎲) or remove.

## What comes out

- `map.json` — the settings, regions, paint strokes and every element (position in
  km, size in metres, turn, points for lines, description, whether generated).
- `locations.json` — every named place with its kind and its **path**: the world,
  then each named place it lies within, largest first, then itself
  (`The World / Northmarch / Karth / Old Jetty`). A **Timeline** wired to it offers
  these as event places.
- `map.png` — the whole world, 1200 pixels wide, with rivers, roads and places marked.
- `map.md` — the places by kind, largest kinds first, with where they are and
  their descriptions.

## How it is drawn

The editor draws the ground as 256-pixel tiles at power-of-two scales, on a pool of
Web Workers so the page never stalls, keeping recent tiles in a cache. A paint
stroke or a moved settlement redraws only the tiles under it; a change of settings
or regions redraws everything. While a finer tile is on its way, the coarser one
stands in.
