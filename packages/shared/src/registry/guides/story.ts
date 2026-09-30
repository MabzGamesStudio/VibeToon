import type { AlgorithmGuide } from '../guides';

export const TIMELINE_GUIDE: AlgorithmGuide = {
  kinds: ['story.timeline'],
  title: 'Partial times, laid out in lanes',
  summary:
    'A timeline holds events whose times and places may be known only in part. A time stores only the fields that are known: "March 2004" is a year and a month, and it stands for the whole of that month. Each event is drawn as the stretch of time it could cover, with a solid core for the part it certainly covers. Events are packed into lanes greedily so they never overlap on screen. Axis ticks fall on calendar boundaries at whatever unit fits the zoom.',
  steps: [
    { kind: 'input', title: 'Events', detail: 'Typed, or read from a brief; names and places suggested from wired character and map flows.' },
    { kind: 'step', title: 'Read typed times', detail: '"2004", "March 2004", "15 Mar 2004 14:30", "500 BC", "c. 1999". Anything else stays undated rather than being misread.' },
    { kind: 'step', title: 'Each time → a range', detail: 'From its first possible instant up to the first instant after it: "2004" is the whole year.' },
    { kind: 'step', title: 'Each event → from, to, and the sure part', detail: 'Sure = from the latest its start could be to the earliest its end could be.' },
    { kind: 'decision', title: 'Does it match the filter?', detail: 'Text, characters, places (at any level of the path), tags.', no: 'Hidden.' },
    { kind: 'step', title: 'Map to pixels for the current view' },
    {
      kind: 'loop',
      title: 'Lanes: for each event, left to right',
      steps: [
        { kind: 'step', title: 'Put it in the first lane whose last event (label included) ends before it starts' },
        { kind: 'decision', title: 'Found one?', no: 'Open a new lane underneath.' },
      ],
    },
    { kind: 'step', title: 'Colour it', detail: 'Its own colour, else the colour chosen for its character / place / tag / keyword, else a hash of that name.' },
    { kind: 'output', title: 'timeline.json and a readable summary' },
  ],
  pseudocode: `range(time):                       # time = {year, month?, day?, hour?, ...}
    p = finest known field, reading from the year and stopping at the first gap
    from = utc(known fields, the rest at their start)
    to   = from + one unit of p        # a month is a calendar month
    return [from, to)

event_range(e):
    s = range(e.start); t = range(e.end) or s
    whole = [min(s.from, t.from), max(s.to, t.to))
    sure  = [s.to, t.from) if s.to < t.from else None
    return whole, sure

lanes(items sorted by x0):
    ends = []
    for item in items:
        lane = first i with ends[i] + gap <= item.x0, else new lane
        ends[lane] = item.x1                    # x1 includes the label
        item.lane = lane

ticks(view, width):
    step = smallest calendar step (century .. second) giving >= 90 px apart
    place ticks on its boundaries: 1 Jan, the 1st of the month, Mondays, :00`,
  sections: [
    {
      heading: 'Partial is the ordinary case',
      body: 'A story’s history is full of "sometime in 2004" and "the winter after the war". Storing such a time as an exact date would draw a dot on 1 January that pretends to be precise. Instead only the known fields are stored, and the event is drawn as a bar as long as what is unknown: a year-long bar for "2004", a month-long bar for "March 2004".\n\n`circa` marks a known field that is itself a guess. A field known below a missing one (a day with no month) cannot be placed, so reading stops at the first gap.',
    },
    {
      heading: 'The sure part',
      body: 'A span with vague ends, such as "from 2001 to 2004", could cover anything from the start of 2001 to the end of 2004. It certainly covers only the end of 2001 to the start of 2004. The editor draws the whole extent faintly and the sure part solidly, so you can see both how long it lasted and how much of that is known.',
    },
    {
      heading: 'Greedy lanes',
      body: 'Events are packed into lanes in start order, each into the first lane that is free by then. This is the classic greedy interval-partitioning algorithm, and it uses the fewest lanes possible for the given intervals.\n\nThe intervals are in pixels and include the label. So two events a day apart share a lane when zoomed out to centuries, and do not when zoomed in to the day.',
    },
    {
      heading: 'Places are paths',
      body: 'A place is a path from broad to narrow, such as `Europe / France / Paris`, cut off where knowledge runs out. Filtering by `France` finds everything in France at any depth. Colouring by place uses one level of the path, so events can be coloured by country or by city.',
    },
    {
      heading: 'Stable colours',
      body: 'A name with no chosen colour gets one from a hash of the name, stepped round the colour wheel by the golden angle (137.5°) so similar hashes land far apart. The same name always gets the same colour, in every project.',
    },
  ],
  settings: [
    { name: 'Span', effect: 'The whole stretch the timeline covers; an empty end means today.' },
    { name: 'Colour by', effect: 'Character, place (at a chosen level), tag, keyword, or none.' },
    { name: 'Filter', effect: 'Show only events matching text, characters, places or tags.' },
  ],
  cost: 'Lanes are O(events × lanes) on each redraw; parsing is per keystroke.',
  resources: [
    { title: 'Interval scheduling / partitioning (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Interval_scheduling#Interval_partitioning', note: 'Why greedy in start order uses the fewest lanes.' },
    { title: 'ISO 8601 reduced precision', url: 'https://en.wikipedia.org/wiki/ISO_8601#Calendar_dates', note: 'The standard way of writing "2004-03" to mean the whole month.' },
    { title: 'Extended Date/Time Format (EDTF)', url: 'https://www.loc.gov/standards/datetime/', note: 'A fuller standard for uncertain and approximate dates.' },
  ],
  source: ['packages/shared/src/flows/timeline.ts', 'packages/client/src/components/editors/TimelineCanvas.tsx'],
  tryIt: 'Type "March 2004" as a start and zoom in: the bar covers the whole month.',
};

export const WORLD_MAP_GUIDE: AlgorithmGuide = {
  kinds: ['world.map'],
  title: 'Terrain from noise, climate from latitude',
  summary:
    'The map’s terrain is not stored as pixels. Height, temperature, moisture and ground type are all functions of position, computed from seeded Perlin noise, latitude and the settings. So the map has detail at any zoom, and the editor and server draw exactly the same world. Height is domain-warped fractal noise, with sea level set so the chosen share is land, plus ridged noise in mountain belts. Climate comes from latitude, height and more noise. A Whittaker-style chart turns height, temperature and moisture into a biome. Lakes, ranges, peaks, rivers and towns are found on a coarse grid of samples.',
  steps: [
    { kind: 'input', title: 'Seed and settings', detail: 'Plus regions generated differently, paint strokes and placed elements.' },
    { kind: 'step', title: 'Set sea level', detail: 'Sample 48×48 heights over the map, sort them, and cut at the land share. 40% land is 40% land for any seed.' },
    {
      kind: 'loop',
      title: 'For each point (each pixel drawn)',
      steps: [
        { kind: 'step', title: 'Height = warped fBm − sea level', detail: 'Octaves added until a wavelength is under 2 pixels, so zooming in adds detail.' },
        { kind: 'step', title: 'Mountains: + mask × ridged noise', detail: 'A slow mask puts ranges in belts; ridged noise makes the crests.' },
        { kind: 'step', title: 'Blend in any region with its own settings', detail: 'Feathered in from its edges with a smoothstep.' },
        { kind: 'step', title: 'Paint on top, last stroke wins' },
        { kind: 'step', title: 'Temperature = 28 − 0.0085·lat² − 6.5 °C/km of height + noise' },
        { kind: 'step', title: 'Moisture = noise + latitude bands + near the coast − height' },
        { kind: 'step', title: 'Biome from (height, temperature, moisture)', detail: 'Towns and fields round settlements; a switched-off biome falls back to its nearest neighbour.' },
      ],
    },
    {
      kind: 'loop',
      title: 'Generate features on a 200-column grid',
      steps: [
        { kind: 'step', title: 'Waters: connected water cells', detail: 'Touching the edge: sea or ocean by size. Enclosed: a lake.' },
        { kind: 'step', title: 'Ranges: connected land above 1500 m; peaks: highest in a 5×5 block' },
        { kind: 'step', title: 'Rivers: from wet high ground, step to the lowest neighbour', detail: 'Kept only if it reaches water or another river.' },
        { kind: 'step', title: 'Settlements: best-scored cells first, spaced by size', detail: 'Low, by the coast or a river, not desert: cities, then towns, then villages.' },
      ],
    },
    { kind: 'output', title: 'map.json, locations.json, map.png, map.md' },
  ],
  pseudocode: `noise = perlin(hash(seed))           # permutation table shuffled by the seed

fbm(p, octaves, gain):
    sum = 0; amp = 1; freq = 1
    for o in 0..octaves-1:
        sum += amp * noise(p * freq + offset[o]); amp *= gain; freq *= 2
    return sum / total_amp

octaves_for(wavelength, pixel) = ceil(log2(wavelength / (2 * pixel))) + 1

height(p, pixel):
    q = p / continent_size
    q += 0.18 * (fbm(warp, q), fbm(warp, q + 40))          # domain warp
    v = fbm(base, q, octaves_for(continent_size, pixel), gain = 0.38 + 0.3*roughness)
    land = v - sea_level                                      # sea_level: quantile
    if land <= 0: return depth(land)
    h = 4 + 1100 * land / (high - sea_level)
    h += belt_mask(p) * (0.35 + mountains) * ridged(p / 380)^1.6 * 5600
    return h

temperature = 28 - 0.0085*lat^2 - 6.5*h/1000 + 4*fbm(heat) + 15*temp_shift
moisture    = 0.5 + 0.42*fbm(wet) + 0.14*cos(lat*pi/30) + coast_bonus - h/12000
biome       = whittaker(h, temperature, moisture)

river(from):
    while not water:
        next = lowest of 8 neighbours
        if next == here: break                                # a hollow
        path.append(next)`,
  sections: [
    {
      heading: 'Nothing is stored as pixels',
      body: 'Everything about the ground is a pure function of position: seeded noise, latitude and the settings. That is what lets the map zoom from a continent to a harbour wall and still have detail. Each zoom level asks for more octaves, the detail that was always there. It also means the editor, the server and any later run all draw the same world.\n\nWhat is stored is only what someone decided: settings, regions, paint and elements.',
    },
    {
      heading: 'Perlin noise and fBm',
      body: 'Perlin noise is smooth random hills on a grid. At each lattice point a random gradient is chosen from a seeded shuffle, and the value between points blends those gradients with a smooth fade curve (6t⁵ − 15t⁴ + 10t³).\n\nOne layer looks like blobs. Fractal Brownian motion (fBm) adds octaves, each at twice the frequency and `gain` times the weight of the last, which gives coastlines that stay ragged at every scale. Roughness raises the gain.\n\nOctaves finer than two pixels would only alias, so the sum stops there. Zooming in makes pixels smaller and adds octaves.',
    },
    {
      heading: 'Domain warping',
      body: 'Before the height is read, the position is pushed around by another noise field. This bends the blobby shapes of plain fBm into more natural, swirled coasts and continents.',
    },
    {
      heading: 'Sea level as a quantile',
      body: 'Noise does not give a fixed share of values above zero. So 2,304 heights are sampled across the map and sorted, and sea level is set at the value (1 − land share) of the way up. The Land setting then means what it says for every seed.',
    },
    {
      heading: 'Ridged noise for mountains',
      body: 'Ridged noise is `1 − |noise|`, squared: sharp crests wherever plain noise crosses zero. Each octave is weighted by the one before, so detail gathers on the ridges and the valleys stay smooth. A slow mask puts ranges in belts rather than everywhere.',
    },
    {
      heading: 'Climate and biomes',
      body: 'Temperature falls with latitude (about 28 °C at the equator) and with height, at the lapse rate of 6.5 °C per km. Moisture is noise, plus bands by latitude, more near the coast, and less up high.\n\nA Whittaker-style chart then names the ground: hot and wet is jungle, hot and dry is desert, cold is tundra or taiga, very high is rock and then snow. Towns and fields are laid round settlements where the ground allows.',
    },
    {
      heading: 'Finding features',
      body: 'Features are found on a 200-column grid of samples:\n\n- **Waters** are connected components of water cells, found by flood fill. One touching the edge is a sea or ocean; an enclosed one is a lake.\n- **Ranges** are components of land above 1500 m. **Peaks** are cells highest in their 5×5 block.\n- **Rivers** start at random wet high cells and step to the lowest neighbour until they reach water. A river that ends in a hollow is dropped.\n- **Settlements** go on the best-scored cells (low ground, coast, river, not desert or swamp), each spaced from the others by its size: cities first, then towns, then villages.\n\nEverything is seeded, so regenerating an unchanged map gives the same places with the same names. Elements you placed or edited are kept.',
    },
  ],
  settings: [
    { name: 'Seed', effect: 'A seed is a world: same seed, same map.' },
    { name: 'Land', effect: 'The share of the map above sea level.' },
    { name: 'Continent size', effect: 'The base wavelength of the height noise, in km.' },
    { name: 'Roughness', effect: 'fBm gain: smooth coasts at 0, ragged at 1.' },
    { name: 'Mountains', effect: 'How much ridged noise is added in the mountain belts.' },
    { name: 'Temperature / moisture', effect: 'Shift the whole climate, about 15 °C either way.' },
    { name: 'North / south latitude', effect: 'What latitudes the top and bottom edges are at.' },
    { name: 'Density', effect: 'How many settlements, and how closely spaced.' },
  ],
  cost: 'A few noise calls per octave per pixel, so a screen of map is a few million noise calls. Feature generation samples a 200-column grid once.',
  resources: [
    { title: 'Making maps with noise (Red Blob Games)', url: 'https://www.redblobgames.com/maps/terrain-from-noise/', note: 'An interactive walk through noise, octaves, and elevation plus moisture to biome.' },
    { title: 'fBm (Inigo Quilez)', url: 'https://iquilezles.org/articles/fbm/', note: 'What fractal noise is, and what gain does.' },
    { title: 'Domain warping (Inigo Quilez)', url: 'https://iquilezles.org/articles/warp/', note: 'The warp used for continent shapes.' },
    { title: 'Improved Noise reference (Ken Perlin)', url: 'https://mrl.nyu.edu/~perlin/noise/', note: 'The original gradient noise, with the fade curve used here.' },
    { title: 'Whittaker biome diagram', url: 'https://en.wikipedia.org/wiki/Biome#Whittaker_(1962,_1970,_1975)_biome-types', note: 'Temperature and rainfall to biome.' },
    { title: 'Lapse rate (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Lapse_rate', note: 'Why it gets colder by about 6.5 °C per km of height.' },
  ],
  source: ['packages/shared/src/flows/worldMap.ts', 'packages/shared/src/flows/noise.ts', 'packages/shared/src/flows/mapCatalogue.ts'],
  tryIt: 'Turn on the Climate layer and zoom from a continent to a town.',
};

export const STORYBOARD_GUIDE: AlgorithmGuide = {
  kinds: ['animation.storyboard'],
  title: 'A board from a script, merged without losing sketches',
  summary:
    'A storyboard can be drafted from a dialog flow. The rules written on the connection decide how: one panel per beat, per line, per action or per scene; which shot size each kind of beat gets; what to ignore; and which fields to carry. Each panel’s duration is the sum of its beats: spoken lines at a words-per-second rate, everything else a default, clamped to a range. When the script changes, the new draft is merged into the board you have been drawing on. Panels are matched by the beats they cover, and a sketch is never lost.',
  steps: [
    { kind: 'input', title: 'A dialog flow, and the rules on its connection' },
    { kind: 'step', title: 'Read the rules', detail: 'panel per, merge, shot for line/action/sound, ignore, carry, words per second, min/max duration, scenes.' },
    {
      kind: 'loop',
      title: 'For each allowed scene',
      steps: [
        { kind: 'step', title: 'Drop ignored beats' },
        { kind: 'step', title: 'Group beats into panels', detail: 'Per line or action: other beats attach to the next anchor. Per beat: optionally merge runs of actions. Per scene: one panel.' },
        { kind: 'step', title: 'Shot size from the group’s lead beat' },
        { kind: 'step', title: 'Duration = Σ beat durations, clamped', detail: 'A line: words ÷ words per second. Others: the default.' },
      ],
    },
    {
      kind: 'loop',
      title: 'Merge into the current board',
      steps: [
        { kind: 'decision', title: 'Does an existing panel cover one of its beats?', no: 'Add it as a new panel.' },
        { kind: 'decision', title: 'Is that panel pinned?', no: 'Take the new text, shot and duration; keep its notes and sketch.', detail: 'Pinned: text left alone.' },
      ],
    },
    { kind: 'step', title: 'Panels whose beats are gone', detail: 'With a sketch: kept and flagged as orphaned. Empty: removed. Hand-made panels stay.' },
    { kind: 'step', title: 'Time the panels', detail: 'Start frame = round(start seconds × fps).' },
    { kind: 'output', title: 'storyboard.json, shotlist.csv, boards.md, panel images' },
  ],
  pseudocode: `config = parse(rules_on_connection)
for scene in dialog.scenes if config.scene_allowed(scene):
    beats = [b for b in scene.beats if b.type not in config.ignore]
    groups = group(beats, config.panel_per)     # beat | line | action | scene
    for g in groups:
        panel.shot     = config.shot_for[g.lead.type] or config.shot_default
        panel.dialog   = lines of g as "NAME (parenthetical): text"
        panel.action, panel.sound, panel.camera = from g's beats
        panel.duration = clamp(Σ duration(b), min, max)
            duration(line) = words / words_per_second
            duration(other) = default_seconds
        carry(config.carry, into=panel)

# merge
index existing panels by each beat id they cover
for derived panel d:
    e = first existing panel covering any of d's beats, not yet used
    if not e:        add d
    elif e.pinned:   keep e, update its beat ids only
    else:            e.text, shot, duration = d's;  keep e.notes, e.sketch
for existing panel e not matched:
    if e.hand_made:        keep
    elif e.sketch:         keep, flag orphaned
    else:                  remove`,
  sections: [
    {
      heading: 'The rules live on the connection',
      body: 'The same script can be boarded many ways, and the choice belongs to the link between script and board, not to either flow. The rules are plain text lines such as `panel per: line`, `shot for action: WS`, `ignore: parenthetical` and `words per second: 2.5`. Change them and the draft changes.',
    },
    {
      heading: 'Grouping beats',
      body: 'With `panel per: line`, every spoken line is an anchor. Actions, sounds and directions before it attach to it, and any trailing at the end of a scene join the last panel, so nothing in the script is lost.\n\nWith `panel per: beat`, each beat is a panel, and `merge: actions` folds runs of actions together. With `panel per: scene`, the whole scene is one panel.\n\nThe lead beat of a group decides the shot size.',
    },
    {
      heading: 'Durations',
      body: 'A spoken line lasts as long as it takes to say: words ÷ words per second. Every other beat gets the project’s default shot length. A beat with its own duration keeps it. The total is clamped between the minimum and maximum, so a one-word line still gets a readable panel and a long speech does not become a 40-second hold.\n\nPanel timings then add up in order. Start frames are rounded from seconds × fps, so the animatic and the edit agree on every cut.',
    },
    {
      heading: 'Merging without losing work',
      body: 'Drawing a board takes hours, and scripts change. The merge rules, in order of what matters most:\n\n- **Sketches are never lost.** A panel whose beats vanished upstream is kept and flagged as orphaned if it has artwork, and dropped only if it is empty.\n- **Pinned panels keep their text.**\n- **Hand-made panels** (no beats upstream) stay where they are.\n\nPanels are matched by the beat ids they cover, not by position. Inserting a line early in a scene therefore does not shift every later sketch onto the wrong panel.\n\nThe editor shows the plan (adds, updates, orphans, removals) before anything is applied.',
    },
  ],
  settings: [
    { name: 'panel per', effect: 'beat, line, action or scene.' },
    { name: 'merge: actions', effect: 'Fold runs of action beats into one panel.' },
    { name: 'shot default / for line / for action / for sound', effect: 'Shot size by the lead beat’s kind.' },
    { name: 'ignore', effect: 'Beat kinds or fields to leave out (sound, camera, parenthetical…).' },
    { name: 'carry', effect: 'Copy one field into another, such as the scene summary into notes.' },
    { name: 'words per second, min / max duration', effect: 'How panel durations are worked out.' },
    { name: 'scenes', effect: 'Which scenes to board, such as 1-3, 5.' },
  ],
  cost: 'Linear in the number of beats; merging indexes existing panels by beat once.',
  resources: [
    { title: 'Storyboard (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Storyboard', note: 'What a board is for, and how it becomes an animatic.' },
    { title: 'Shot sizes (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Shot_(filmmaking)#Shot_size', note: 'What WS, MS, CU and INSERT mean.' },
    { title: 'Three-way merge (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Merge_(version_control)#Three-way_merge', note: 'The same problem as merging a changed script into a drawn board: keep both sides’ work.' },
  ],
  source: ['packages/shared/src/flows/storyboard.ts', 'packages/shared/src/flows/dialog.ts', 'packages/server/src/generators/storyboard.ts'],
  tryIt: 'Change "panel per" on the connection from the dialog flow, and look at the merge plan before applying it.',
};
