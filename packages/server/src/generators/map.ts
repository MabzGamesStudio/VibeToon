import { deflateSync } from 'node:zlib';
import {
  MAP_CATALOGUE_SOURCE,
  catalogueEntry,
  compileTerrain,
  encodePng,
  formatSize,
  mapLocations,
  renderGround,
  stampElements,
  summariseMap,
  type WorldMapFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/** How wide the written-out picture of the whole map is, in pixels. */
const IMAGE_WIDTH = 1200;

/**
 * The map, written out: all of it as data, its named places as a list other
 * flows can read, a picture of the whole world, and notes to read.
 *
 * The picture is drawn here from the same functions the editor draws with, so
 * it is the same world — generated from the settings, not copied from a screen.
 */
export async function generateMap(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as WorldMapFlowData;
  const { settings } = data;
  const locations = mapLocations(data);
  if (locations.length === 0) ctx.warn('Nothing on the map is named yet, so there are no locations to hand on.');
  const unknown = data.elements.filter((element) => !catalogueEntry(element.type));
  if (unknown.length > 0) ctx.warn(`${unknown.length} element(s) are of a kind the catalogue does not know, and are written out as they are.`);

  const terrain = compileTerrain(data);
  const width = IMAGE_WIDTH;
  const height = Math.max(1, Math.round((IMAGE_WIDTH * settings.heightKm) / settings.widthKm));
  const pixel = settings.widthKm / width;
  const started = Date.now();
  const pixels = renderGround(terrain, 0, 0, pixel, width, height, data.layers);
  stampElements(pixels, width, height, 0, 0, pixel, data.elements);
  ctx.log(`Drew the map at ${width} × ${height} in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  const png = await encodePng({ width, height, data: pixels }, (bytes) => new Uint8Array(deflateSync(bytes)));

  const byKind = new Map<string, typeof locations>();
  for (const location of locations) byKind.set(location.kindName, [...(byKind.get(location.kindName) ?? []), location]);
  const lines = [
    `# ${settings.name}`,
    '',
    summariseMap(data),
    '',
    `- Seed: \`${settings.seed}\` · latitude ${settings.northLatitude}° at the top to ${settings.southLatitude}° at the bottom`,
    `- Land: ${Math.round(settings.terrain.land * 100)}% · mountains ${Math.round(settings.terrain.mountains * 100)}% · roughness ${Math.round(settings.terrain.roughness * 100)}%`,
    ...(data.patches.length > 0 ? [`- Regions generated apart: ${data.patches.map((patch) => patch.name ?? patch.id).join(', ')}`] : []),
    `- Elements from: ${MAP_CATALOGUE_SOURCE}`,
    '',
    '![The map](map.png)',
    '',
  ];
  for (const [kind, places] of [...byKind].sort((a, b) => (catalogueEntry(b[1][0]!.kind)?.size ?? 0) - (catalogueEntry(a[1][0]!.kind)?.size ?? 0))) {
    lines.push(`## ${kind}`, '');
    for (const place of places.sort((a, b) => a.name.localeCompare(b.name))) {
      const facts = place.facts ? Object.entries(place.facts).map(([key, value]) => `${key} ${value}`).join(', ') : '';
      lines.push(`- **${place.name}** — ${place.path.slice(1, -1).join(' / ') || settings.name}, ${formatSize(place.size)}${facts ? `, ${facts}` : ''}${place.description ? `. ${place.description}` : ''}`);
    }
    lines.push('');
  }

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'map',
      kind: 'json',
      fileName: 'map.json',
      content: `${JSON.stringify({ settings, patches: data.patches, strokes: data.strokes, elements: data.elements }, null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'locations',
      kind: 'json',
      fileName: 'locations.json',
      content: `${JSON.stringify({ world: settings.name, locations }, null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'image',
      kind: 'image',
      fileName: 'map.png',
      content: png,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'doc',
      kind: 'markdown',
      fileName: 'map.md',
      content: `${lines.join('\n').trimEnd()}\n`,
    }),
  ];
  return { outputs };
}
