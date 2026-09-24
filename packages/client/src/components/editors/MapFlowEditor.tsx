import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BIOME_COLOR,
  BIOME_LABEL,
  GENERATED_BIOMES,
  MAP_CATALOGUE_SOURCE,
  MAP_LAYERS,
  MAP_LAYER_LABEL,
  SCALE_TIER_LABEL,
  catalogueEntry,
  compileTerrain,
  deleteElement,
  emptyWorldMapFlowData,
  formatSize,
  generateFeatures,
  generationKey,
  mapLocations,
  nextMapId,
  placeElement,
  searchCatalogue,
  summariseMap,
  updateElement,
  type FeatureToggles,
  type FlowNode,
  type KmRect,
  type MapLayer,
  type MapLayers,
  type MapView,
  type PaintKind,
  type Project,
  type TerrainSettings,
  type WorldMapFlowData,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';
import { MapCanvas, clampPixel, type MapToolState } from './MapCanvas';

const FEATURE_LABEL: Record<keyof FeatureToggles, string> = {
  waters: 'Oceans, seas and lakes',
  mountainRanges: 'Mountain ranges',
  peaks: 'Peaks',
  rivers: 'Rivers',
  cities: 'Cities',
  towns: 'Towns',
  villages: 'Villages',
};

const TERRAIN_SLIDERS: Array<{ key: keyof TerrainSettings; label: string; min: number; max: number; step: number; format(value: number): string }> = [
  { key: 'land', label: 'Land', min: 0, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}% of the map` },
  { key: 'continentSize', label: 'Landmass size', min: 200, max: 5000, step: 50, format: (value) => `about ${Math.round(value).toLocaleString('en')} km` },
  { key: 'roughness', label: 'Roughness', min: 0, max: 1, step: 0.01, format: (value) => value.toFixed(2) },
  { key: 'mountains', label: 'Mountains', min: 0, max: 1, step: 0.01, format: (value) => value.toFixed(2) },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, format: (value) => `${value >= 0 ? '+' : ''}${Math.round(value * 15)} °C` },
  { key: 'moisture', label: 'Moisture', min: -1, max: 1, step: 0.01, format: (value) => (value === 0 ? 'as the climate gives' : value > 0 ? `wetter ${value.toFixed(2)}` : `drier ${(-value).toFixed(2)}`) },
];

const randomSeed = () => Math.random().toString(36).slice(2, 8);

/**
 * A world, generated and then made by hand.
 *
 * The ground comes from the settings on the left — how much land, how
 * mountainous, how hot and wet — and any stretch can be generated differently
 * by dragging out a region. Paint puts down a kind of ground where you want it.
 * On top go elements from a catalogue of several hundred, from continents to
 * jetties, each at its own size; they are named, described, and shown when the
 * zoom is right for them.
 */
export function MapFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData } = useStudio();
  const data = node.data.editor === 'map' ? (node.data as WorldMapFlowData) : emptyWorldMapFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback(
    (next: Partial<WorldMapFlowData> | ((was: WorldMapFlowData) => WorldMapFlowData)) => {
      const was = dataRef.current;
      const value = typeof next === 'function' ? next(was) : { ...was, ...next };
      dataRef.current = value;
      setFlowData(node.id, value);
    },
    [node.id, setFlowData],
  );

  const { settings } = data;
  const [view, setView] = useState<MapView>(
    () => data.view ?? { cx: settings.widthKm / 2, cy: settings.heightKm / 2, pixel: settings.widthKm / 900 },
  );
  const saveTimer = useRef<number | undefined>(undefined);
  const moveView = useCallback(
    (next: MapView) => {
      const clamped = { ...next, pixel: clampPixel(next.pixel, dataRef.current) };
      setView(clamped);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => patch({ view: clamped }), 500);
    },
    [patch],
  );
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const [tool, setTool] = useState<MapToolState>({ tool: 'select', paint: 'forest', brush: 18 });
  const [query, setQuery] = useState('');
  const [layerFilter, setLayerFilter] = useState<MapLayer | ''>('');
  const [nextRegion, setNextRegion] = useState<TerrainSettings & { feather: number }>({ ...settings.terrain, land: 0.6, mountains: 0.8, feather: 60 });
  const [inspected, setInspected] = useState<{ x: number; y: number } | null>(null);
  const strokeId = useRef<string | null>(null);

  const terrain = useMemo(() => compileTerrain(data), [data.settings, data.patches, data.strokes, data.elements]);
  const results = useMemo(() => searchCatalogue(query, { layer: layerFilter || undefined, limit: 80 }), [query, layerFilter]);
  const selected = data.elements.find((element) => element.id === data.selected);
  const locations = useMemo(() => mapLocations(data), [data.elements, data.settings.name]);
  // The features were placed for other ground, and may no longer fit it.
  const stale = data.generatedFor !== undefined && data.generatedFor !== generationKey(data);

  const setSettings = (change: Partial<typeof settings>) => patch({ settings: { ...settings, ...change } });
  const setTerrain = (change: Partial<TerrainSettings>) => setSettings({ terrain: { ...settings.terrain, ...change } });
  const setLayers = (change: Partial<MapLayers>) => patch({ layers: { ...data.layers, ...change } });
  const regenerate = () =>
    patch((was) => ({ ...was, elements: generateFeatures(was), generatedFor: generationKey(was) }));

  /** A world terrain slider's props, less its tip — which is written out where it is used. */
  const terrainSlider = (key: keyof TerrainSettings) => {
    const slider = TERRAIN_SLIDERS.find((one) => one.key === key)!;
    return {
      label: slider.label,
      min: slider.min,
      max: slider.max,
      step: slider.step,
      value: settings.terrain[key],
      format: slider.format,
      onChange: (value: number) => setTerrain({ [key]: value }),
    };
  };

  const zoomBy = (factor: number) => moveView({ ...view, pixel: view.pixel * factor });
  const fit = () => moveView({ cx: settings.widthKm / 2, cy: settings.heightKm / 2, pixel: settings.widthKm / 900 });

  return (
    <EditorShell project={project} node={node}>
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>The world</h3>
          <Field label="Name" hint="The root of every place’s path.">
            <input type="text" value={settings.name} aria-label="World name" onChange={(event) => setSettings({ name: event.target.value })} />
          </Field>
          <Field label="Seed" tip="map.seed">
            <div className="vt-row" style={{ gap: 4 }}>
              <input type="text" value={settings.seed} aria-label="Seed" onChange={(event) => setSettings({ seed: event.target.value })} />
              <button type="button" className="vt-btn is-small" title="A new random world" onClick={() => setSettings({ seed: randomSeed() })}>
                🎲
              </button>
            </div>
          </Field>
          <div className="vt-row" style={{ gap: 6 }}>
            <Field label="Width, km">
              <input
                type="number"
                min={50}
                max={40000}
                value={settings.widthKm}
                aria-label="Width in km"
                onChange={(event) => setSettings({ widthKm: Math.max(50, Number(event.target.value) || 50) })}
              />
            </Field>
            <Field label="Height, km">
              <input
                type="number"
                min={50}
                max={40000}
                value={settings.heightKm}
                aria-label="Height in km"
                onChange={(event) => setSettings({ heightKm: Math.max(50, Number(event.target.value) || 50) })}
              />
            </Field>
          </div>
          <div className="vt-row" style={{ gap: 6 }}>
            <Field label="Top latitude" tip="map.latitude">
              <input type="number" min={-90} max={90} value={settings.northLatitude} aria-label="Top latitude" onChange={(event) => setSettings({ northLatitude: Number(event.target.value) })} />
            </Field>
            <Field label="Bottom latitude">
              <input type="number" min={-90} max={90} value={settings.southLatitude} aria-label="Bottom latitude" onChange={(event) => setSettings({ southLatitude: Number(event.target.value) })} />
            </Field>
          </div>
          <Slider {...terrainSlider('land')} tip="map.land" />
          <Slider {...terrainSlider('continentSize')} tip="map.continentSize" />
          <Slider {...terrainSlider('roughness')} tip="map.roughness" />
          <Slider {...terrainSlider('mountains')} tip="map.mountains" />
          <Slider {...terrainSlider('temperature')} tip="map.temperature" />
          <Slider {...terrainSlider('moisture')} tip="map.moisture" />
          <Slider label="Settlements" tip="map.density" value={settings.density} format={(value) => `${Math.round(value * 100)}%`} onChange={(density) => setSettings({ density })} />
          <button type="button" className="vt-btn is-primary" style={{ width: '100%', marginTop: 6 }} onClick={regenerate}>
            Regenerate features
          </button>
          <div className="vt-hint">
            {stale
              ? 'The ground has changed since the features were placed — regenerate to put rivers, peaks and towns where the new ground wants them. Anything you placed or edited is kept.'
              : 'Rivers, peaks, ranges, waters and settlements are placed to fit the ground. Anything you place or edit is kept when regenerating.'}
          </div>
        </div>

        <div className="vt-section">
          <h3>What is generated</h3>
          <div className="vt-map-toggles">
            {GENERATED_BIOMES.map((biome) => (
              <label key={biome} className="vt-row" style={{ gap: 5 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={settings.biomes[biome] !== false}
                  onChange={(event) => setSettings({ biomes: { ...settings.biomes, [biome]: event.target.checked } })}
                />
                <span className="vt-map-swatch" style={{ background: `rgb(${BIOME_COLOR[biome].join(',')})` }} aria-hidden="true" />
                <span>{BIOME_LABEL[biome]}</span>
              </label>
            ))}
          </div>
          <div className="vt-hint">A kind switched off becomes its nearest neighbour: no jungle means forest there.</div>
          <div className="vt-map-toggles" style={{ marginTop: 8 }}>
            {(Object.keys(FEATURE_LABEL) as Array<keyof FeatureToggles>).map((feature) => (
              <label key={feature} className="vt-row" style={{ gap: 5 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={settings.features[feature]}
                  onChange={(event) => setSettings({ features: { ...settings.features, [feature]: event.target.checked } })}
                />
                <span>{FEATURE_LABEL[feature]}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="vt-section">
          <h3>Layers</h3>
          <div className="vt-map-toggles">
            {(
              [
                ['relief', 'Relief shading'],
                ['climate', 'Climate (temperature)'],
                ['elements', 'Elements'],
                ['labels', 'Names'],
                ['regions', 'Region outlines'],
              ] as Array<[keyof MapLayers, string]>
            ).map(([key, label]) => (
              <label key={key} className="vt-row" style={{ gap: 5 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={data.layers[key]} onChange={(event) => setLayers({ [key]: event.target.checked })} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      </aside>

      <div className="vt-editor-main">
        <div className="vt-map-tools" role="toolbar" aria-label="Map tools">
          {(
            [
              ['select', 'Select & move', 'Click a place to see it; drag it to move it; drag the ground to pan.'],
              ['place', 'Place', 'Put an element from the catalogue on the map.'],
              ['paint', 'Paint', 'Paint a kind of ground.'],
              ['region', 'Generate a region', 'Drag out a rectangle to generate that stretch differently.'],
            ] as Array<[MapToolState['tool'], string, string]>
          ).map(([id, label, title]) => (
            <button key={id} type="button" title={title} className={`vt-btn is-small${tool.tool === id ? ' is-active' : ''}`} aria-pressed={tool.tool === id} onClick={() => setTool({ ...tool, tool: id })}>
              {label}
            </button>
          ))}
          <span className="vt-spacer" />
          <span className="vt-faint" style={{ fontSize: 11 }}>
            1 px = {formatSize(view.pixel * 1000)}
          </span>
        </div>

        {tool.tool === 'paint' ? (
          <div className="vt-map-toolbar">
            <Field label="Paint" tip="map.paint">
              <select value={tool.paint} aria-label="Paint" onChange={(event) => setTool({ ...tool, paint: event.target.value as PaintKind })}>
                {GENERATED_BIOMES.map((biome) => (
                  <option key={biome} value={biome}>
                    {BIOME_LABEL[biome]}
                  </option>
                ))}
                <option value="land">Plain land (let the climate decide)</option>
                <option value="erase">Erase paint (back to generated)</option>
              </select>
            </Field>
            <Slider label="Brush" min={3} max={80} step={1} value={tool.brush} format={(value) => `${formatSize(value * view.pixel * 1000)} across ${value}px`} onChange={(brush) => setTool({ ...tool, brush })} />
          </div>
        ) : null}

        {tool.tool === 'region' ? (
          <div className="vt-map-toolbar">
            <span className="vt-faint" style={{ fontSize: 11 }}>
              The next region you drag out:
            </span>
            {(['land', 'mountains', 'roughness', 'temperature', 'moisture'] as const).map((key) => {
              const slider = TERRAIN_SLIDERS.find((one) => one.key === key)!;
              return (
                <Slider key={key} label={slider.label} min={slider.min} max={slider.max} step={slider.step} value={nextRegion[key]} format={slider.format} onChange={(value) => setNextRegion({ ...nextRegion, [key]: value })} />
              );
            })}
            <Slider label="Blend at its edges" tip="map.feather" min={0} max={400} step={5} value={nextRegion.feather} format={(value) => `${value} km`} onChange={(feather) => setNextRegion({ ...nextRegion, feather })} />
          </div>
        ) : null}

        {tool.tool === 'place' ? (
          <div className="vt-map-toolbar vt-map-catalogue">
            <div className="vt-row" style={{ gap: 6 }}>
              <input type="search" value={query} placeholder="Search 780 kinds: jetty, mountain, city…" aria-label="Search the catalogue" onChange={(event) => setQuery(event.target.value)} />
              <select value={layerFilter} aria-label="Layer" onChange={(event) => setLayerFilter(event.target.value as MapLayer | '')}>
                <option value="">Every layer</option>
                {MAP_LAYERS.map((layer) => (
                  <option key={layer} value={layer}>
                    {MAP_LAYER_LABEL[layer]}
                  </option>
                ))}
              </select>
            </div>
            <div className="vt-map-results">
              {results.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`vt-map-result${tool.placing === entry.id ? ' is-active' : ''}`}
                  title={`${SCALE_TIER_LABEL[entry.tier]} · ${entry.terms.join(', ')}`}
                  onClick={() => setTool({ ...tool, placing: entry.id })}
                >
                  <span>{entry.name}</span>
                  <span className="vt-faint">
                    {entry.shapes[0]} · {formatSize(entry.size)}
                  </span>
                </button>
              ))}
            </div>
            <div className="vt-hint">
              {tool.placing
                ? catalogueEntry(tool.placing)?.shapes[0] === 'line'
                  ? `Click the points of the ${catalogueEntry(tool.placing)?.name.toLowerCase()}; double-click or press Enter to finish.`
                  : `Click the map to place a ${catalogueEntry(tool.placing)?.name.toLowerCase()} — ${formatSize(catalogueEntry(tool.placing)!.size)} across by default.`
                : 'Pick what to place.'}{' '}
              From the {MAP_CATALOGUE_SOURCE}.
            </div>
          </div>
        ) : null}

        <Stage
          title={settings.name}
          tools={
            <span className="vt-zoom-controls">
              <button type="button" className="vt-btn is-small" aria-label="Zoom out" onClick={() => zoomBy(1.6)}>
                −
              </button>
              <button type="button" className="vt-btn is-small" title="The whole world" onClick={fit}>
                World
              </button>
              <button type="button" className="vt-btn is-small" aria-label="Zoom in" onClick={() => zoomBy(1 / 1.6)}>
                +
              </button>
            </span>
          }
        >
          <div className="vt-map-stage">
            <MapCanvas
              data={data}
              view={view}
              tool={tool}
              onView={moveView}
              onSelect={(id) => {
                patch({ selected: id });
                if (id) setInspected(null);
              }}
              onPlace={(type, x, y, points) =>
                patch((was) => placeElement(was, type, x, y, points ? { points, ...(lengthKm(points) > 0 ? { size: Math.round(lengthKm(points) * 1000) } : {}) } : {}))
              }
              onStroke={({ id, points }) =>
                patch((was) => {
                  if (!id || !strokeId.current) {
                    const taken = nextMapId(was, 'paint');
                    strokeId.current = taken.id;
                    return { ...taken.data, strokes: [...taken.data.strokes, { id: taken.id, paint: tool.paint, radius: tool.brush * view.pixel, points }] };
                  }
                  return { ...was, strokes: was.strokes.map((stroke) => (stroke.id === strokeId.current ? { ...stroke, points } : stroke)) };
                })
              }
              onRegion={(bounds: KmRect) =>
                patch((was) => {
                  const taken = nextMapId(was, 'region');
                  const { feather, ...terrainSettings } = nextRegion;
                  return {
                    ...taken.data,
                    patches: [...taken.data.patches, { id: taken.id, name: `Region ${taken.data.patches.length + 1}`, bounds, seed: randomSeed(), terrain: terrainSettings, feather }],
                  };
                })
              }
              onChangeElement={(id, change) => patch((was) => updateElement(was, id, change))}
              onInspect={(x, y) => setInspected({ x, y })}
            />
          </div>
        </Stage>
        <p className="vt-faint" style={{ marginTop: 6, fontSize: 11 }}>
          {summariseMap(data)} · scroll to zoom, drag to pan
        </p>

        {data.patches.length > 0 ? (
          <div className="vt-section">
            <h3>Regions generated apart</h3>
            {data.patches.map((region) => (
              <div key={region.id} className="vt-row" style={{ gap: 6, marginBottom: 4 }}>
                <input
                  type="text"
                  value={region.name ?? ''}
                  aria-label="Region name"
                  onChange={(event) => patch({ patches: data.patches.map((one) => (one.id === region.id ? { ...one, name: event.target.value } : one)) })}
                />
                <span className="vt-faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                  {Math.round(region.bounds.x1 - region.bounds.x0)} × {Math.round(region.bounds.y1 - region.bounds.y0)} km
                </span>
                <button type="button" className="vt-btn is-small" title="Generate it again, differently" onClick={() => patch({ patches: data.patches.map((one) => (one.id === region.id ? { ...one, seed: randomSeed() } : one)) })}>
                  🎲
                </button>
                <button type="button" className="vt-btn is-small is-danger is-ghost" onClick={() => patch({ patches: data.patches.filter((one) => one.id !== region.id) })}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {selected ? (
          <ElementPanel
            key={selected.id}
            data={data}
            id={selected.id}
            locationPath={locations.find((location) => location.id === selected.id)?.path}
            ground={terrain.sample(selected.x, selected.y, 0.01)}
            onChange={(change) => patch((was) => updateElement(was, selected.id, change))}
            onDelete={() => patch((was) => deleteElement(was, selected.id))}
            onZoom={() => moveView({ cx: selected.x, cy: selected.y, pixel: Math.max(0.0005, selected.size / 1000 / 200) })}
          />
        ) : inspected ? (
          <GroundPanel data={data} at={inspected} ground={terrain.sample(inspected.x, inspected.y, 0.01)} />
        ) : (
          <div className="vt-hint">Click a place to see and edit it, or anywhere on the ground to see what is there.</div>
        )}
      </div>
    </EditorShell>
  );
}

function lengthKm(points: number[]): number {
  let total = 0;
  for (let index = 0; index + 3 < points.length; index += 2) total += Math.hypot(points[index + 2]! - points[index]!, points[index + 3]! - points[index + 1]!);
  return total;
}

function ElementPanel({
  data,
  id,
  locationPath,
  ground,
  onChange,
  onDelete,
  onZoom,
}: {
  data: WorldMapFlowData;
  id: string;
  locationPath?: string[];
  ground: ReturnType<ReturnType<typeof compileTerrain>['sample']>;
  onChange(change: Parameters<typeof updateElement>[2]): void;
  onDelete(): void;
  onZoom(): void;
}): JSX.Element {
  const element = data.elements.find((one) => one.id === id)!;
  const entry = catalogueEntry(element.type);
  const isLine = Boolean(element.points && element.points.length >= 4);
  return (
    <div className="vt-section vt-map-panel" aria-label={`Place: ${element.name ?? entry?.name ?? element.type}`}>
      <h3>
        <span>
          {entry?.name ?? element.type}
          {element.generated ? <span className="vt-faint"> · generated</span> : null}
        </span>
        <span className="vt-row" style={{ gap: 4 }}>
          <button type="button" className="vt-btn is-small is-ghost" onClick={onZoom}>
            Zoom to it
          </button>
          <button type="button" className="vt-btn is-small is-danger is-ghost" onClick={onDelete}>
            Delete
          </button>
        </span>
      </h3>
      <div className="vt-timeline-panel-grid">
        <div>
          <Field label="Name" tip="map.name">
            <input type="text" value={element.name ?? ''} aria-label="Place name" placeholder="Unnamed" onChange={(event) => onChange({ name: event.target.value || undefined })} />
          </Field>
          <Field label="Description">
            <textarea rows={4} value={element.description ?? ''} aria-label="Description" onChange={(event) => onChange({ description: event.target.value || undefined })} />
          </Field>
        </div>
        <div>
          <Field label={isLine ? 'Length, m' : 'Size across, m'} tip="map.size" hint={`${formatSize(element.size)}${entry ? ` · default ${formatSize(entry.size)} · ${SCALE_TIER_LABEL[entry.tier]}` : ''}`}>
            <input type="number" min={1} value={Math.round(element.size)} aria-label="Size in metres" onChange={(event) => onChange({ size: Math.max(1, Number(event.target.value) || 1) })} />
          </Field>
          {isLine ? (
            <Field label="Width, m">
              <input type="number" min={0.1} step={0.5} value={element.width ?? 1} aria-label="Width in metres" onChange={(event) => onChange({ width: Math.max(0.1, Number(event.target.value) || 1) })} />
            </Field>
          ) : (
            <Slider label="Turned" min={-180} max={180} step={1} value={element.rotation} format={(value) => `${value}°`} onChange={(rotation) => onChange({ rotation })} />
          )}
        </div>
        <div>
          <dl className="vt-kv">
            <dt>Lies within</dt>
            <dd>{locationPath ? locationPath.slice(0, -1).join(' / ') : 'Name it to place it'}</dd>
            <dt>Where</dt>
            <dd>
              {element.x.toFixed(2)}, {element.y.toFixed(2)} km
            </dd>
            <dt>Ground</dt>
            <dd>
              {BIOME_LABEL[ground.biome]} · {ground.elevation.toLocaleString('en')} m · {ground.temperature} °C
            </dd>
            {Object.entries(element.facts ?? {}).map(([key, value]) => (
              <FactRow key={key} name={key} value={value} />
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

function FactRow({ name, value }: { name: string; value: string | number }): JSX.Element {
  return (
    <>
      <dt>{name.charAt(0).toUpperCase() + name.slice(1)}</dt>
      <dd>{typeof value === 'number' ? `${value.toLocaleString('en')}${name === 'elevation' || name === 'highest' ? ' m' : ''}` : value}</dd>
    </>
  );
}

function GroundPanel({ data, at, ground }: { data: WorldMapFlowData; at: { x: number; y: number }; ground: ReturnType<ReturnType<typeof compileTerrain>['sample']> }): JSX.Element {
  const latitude = data.settings.northLatitude + (data.settings.southLatitude - data.settings.northLatitude) * (at.y / data.settings.heightKm);
  const around = mapLocations({ settings: data.settings, elements: [...data.elements, { id: '_here', type: 'geo/dune', name: 'here', x: at.x, y: at.y, size: 0.001, rotation: 0 }] }).find((location) => location.id === '_here');
  return (
    <div className="vt-section vt-map-panel" aria-label="The ground here">
      <h3>
        <span>{BIOME_LABEL[ground.biome]}</span>
        <span className="vt-faint">{ground.painted ? 'painted' : 'generated'}</span>
      </h3>
      <dl className="vt-kv">
        <dt>Where</dt>
        <dd>
          {at.x.toFixed(2)}, {at.y.toFixed(2)} km · latitude {latitude.toFixed(1)}°
        </dd>
        <dt>{ground.water ? 'Depth' : 'Height'}</dt>
        <dd>{Math.abs(ground.elevation).toLocaleString('en')} m</dd>
        <dt>Climate</dt>
        <dd>
          {ground.temperature} °C on average · moisture {Math.round(ground.moisture * 100)}%
        </dd>
        <dt>Within</dt>
        <dd>{around ? around.path.slice(0, -1).join(' / ') : data.settings.name}</dd>
      </dl>
    </div>
  );
}
