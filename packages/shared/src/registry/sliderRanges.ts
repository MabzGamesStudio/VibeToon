/**
 * Every slider in the studio, with the range it covers.
 *
 * A slider's ends are a guess at what is useful: wide enough to reach what
 * anyone would want, narrow enough that a small movement does something small.
 * For a particular piece of work the guess is often wrong — a world map that
 * is all archipelago wants "land" between 0 and 0.2 with room to be fine about
 * it, and a rig for a rubber hose character wants stretch to go past ×3. So the
 * ends are settings too, kept for this installation rather than for a project,
 * and every slider reads them from here.
 *
 * Each slider is named by a key. A slider in the client carries its key as
 * `range="…"` (or `useSliderRange('…')` for a bare range input), and a test
 * holds this list and the client to each other: no slider without an entry,
 * no entry without a slider.
 */

export interface SliderRangeDef {
  key: string;
  label: string;
  /** The flow kinds whose editors show it; empty for sliders outside any flow. */
  flows: string[];
  /** Where in the editor it sits. */
  section: string;
  min: number;
  max: number;
  step: number;
  /** What the numbers are in, when it is not obvious. */
  unit?: string;
}

const def = (
  key: string,
  label: string,
  flows: string[],
  section: string,
  min: number,
  max: number,
  step: number,
  unit?: string,
): SliderRangeDef => ({ key, label, flows, section, min, max, step, ...(unit ? { unit } : {}) });

const VECTORIZE = ['art.vectorize'];
const RIG = ['animation.rig'];
const PALETTE = ['art.palette'];
const MAP = ['world.map'];
const CUTOUT = ['art.cutout'];
const TEXT = ['text.random'];

export const SLIDER_RANGES: SliderRangeDef[] = [
  // Random Text
  def('text.length.wordPercent', 'Change in words', TEXT, 'Length', -90, 200, 5, '%'),
  def('text.length.charPercent', 'Change in characters', TEXT, 'Length', -90, 200, 5, '%'),
  def('text.length.temperature', 'Length temperature', TEXT, 'Length', 0, 1, 0.05),
  def('text.alterTemperature', 'Alter temperature', TEXT, 'Choosing words', 0, 1, 0.05),
  def('text.pickTemperature', 'Pick temperature', TEXT, 'Choosing words', 0.02, 1, 0.05),
  def('text.contextWindow', 'Context window', TEXT, 'Context', 0, 8, 1, 'tokens'),
  def('text.contextDecay', 'Context decay', TEXT, 'Context', 0, 1, 0.05),
  def('text.frequencyBias', 'Frequency bias', TEXT, 'Context', 0, 1, 0.05),
  def('text.contextSymmetry', 'Context symmetry', TEXT, 'Context', 0, 1, 0.05),
  def('text.grammarBias', 'Grammar bias', TEXT, 'Grammar', 0, 1, 0.05),
  def('text.grammarWeight', 'Grammar database', TEXT, 'Grammar', 0, 1, 0.05),
  def('text.sentenceLength', 'Sentence length', TEXT, 'Grammar', 3, 40, 1, 'words'),
  def('lexicon.frequency', 'Word frequency', TEXT, 'Word list', 0, 1, 0.01),
  def('lexicon.contextWeight', 'Context link weight', TEXT, 'Word list', 0, 1, 0.05),

  // Timeline
  def('timeline.placeLevel', 'Place level', ['story.timeline'], 'Color', 1, 5, 1, 'levels'),

  // World Map
  def('map.land', 'Land', MAP, 'World', 0, 1, 0.01, 'share of the map'),
  def('map.continentSize', 'Landmass size', MAP, 'World', 200, 5000, 50, 'km'),
  def('map.roughness', 'Roughness', MAP, 'World', 0, 1, 0.01),
  def('map.mountains', 'Mountains', MAP, 'World', 0, 1, 0.01),
  def('map.temperature', 'Temperature', MAP, 'World', -1, 1, 0.01, '×15 °C'),
  def('map.moisture', 'Moisture', MAP, 'World', -1, 1, 0.01),
  def('map.density', 'Settlements', MAP, 'World', 0, 1, 0.05),
  def('map.brush', 'Paint brush', MAP, 'Paint', 3, 80, 1, 'px'),
  def('map.feather', 'Region blend at its edges', MAP, 'Regions', 0, 400, 5, 'km'),
  def('map.rotation', 'Place turned', MAP, 'Places', -180, 180, 1, '°'),

  // Skeletal Rig
  def('rig.squashAndStretch', 'Squash and stretch', RIG, 'Whole rig', 0, 4, 0.1, '×'),
  def('rig.looseness', 'Looseness', RIG, 'Whole rig', 0, 2, 0.05, '×'),
  def('rig.floppiness', 'Floppiness', RIG, 'Chain', 0, 1, 0.05),
  def('rig.taper', 'Taper', RIG, 'Chain', 0, 1, 0.05),
  def('rig.span', 'Span at full floppiness', RIG, 'Chain', 5, 120, 1, '°'),
  def('rig.angleMin', 'Turns anticlockwise to', RIG, 'Bone', -180, 0, 1, '°'),
  def('rig.angleMax', 'Turns clockwise to', RIG, 'Bone', 0, 180, 1, '°'),
  def('rig.angleStiffness', 'Angle stiffness', RIG, 'Bone', 0, 1, 0.05),
  def('rig.stretchMin', 'Squashes to', RIG, 'Bone', 0.3, 1, 0.01, '×'),
  def('rig.stretchMax', 'Stretches to', RIG, 'Bone', 1, 3, 0.01, '×'),
  def('rig.stretchStiffness', 'Stretch stiffness', RIG, 'Bone', 0, 1, 0.05),
  def('rigPreview.gravity', 'Gravity', RIG, 'Preview', 0, 3, 0.05, 'g'),
  def('rigPreview.wind', 'Wind', RIG, 'Preview', -1.5, 1.5, 0.05, 'g'),
  def('rigPreview.gust', 'Gusts', RIG, 'Preview', 0, 1, 0.05),
  def('rigPreview.damping', 'Air', RIG, 'Preview', 0, 1, 0.05),
  def('rigPreview.motionSize', 'Movement: how far', RIG, 'Preview', 0, 0.6, 0.01, 'of its height'),
  def('rigPreview.motionSpeed', 'Movement: how fast', RIG, 'Preview', 0.1, 4, 0.05, 'a second'),

  // Rig Binding
  def('bind.brush', 'Brush', ['animation.bind'], 'Tools', 4, 60, 1, 'px'),

  // Pose
  def('pose.turn', 'Turn (within the joint’s own limits)', ['animation.pose'], 'Joint', -180, 180, 1, '°'),
  def('pose.chainLength', 'Joints that may move', ['animation.pose'], 'Reaching', 1, 8, 1, 'joints'),

  // Rig Match
  def('rigMatch.features', 'Features per part', ['animation.match'], 'Finding the body', 2, 40, 1, 'features'),
  def('rigMatch.scaleRange', 'Range in size', ['animation.match'], 'Finding the body', 1, 4, 0.1, '×'),
  def('rigMatch.angleRange', 'Range in angle', ['animation.match'], 'Finding the body', 0, 180, 5, '°'),
  def('rigMatch.bodyOpacity', 'Body over the picture', ['animation.match'], 'Showing', 0, 1, 0.05),
  def('rigMatch.rotation', 'Whole body turned', ['animation.match'], 'Adjusting by hand', -180, 180, 1, '°'),
  def('rigMatch.partAngle', 'Part turned (within the joint’s limits)', ['animation.match'], 'Adjusting by hand', -180, 180, 1, '°'),
  def('rigMatch.partSize', 'Part size', ['animation.match'], 'Adjusting by hand', 0.5, 2, 0.01, '×'),

  // Image Extraction
  def('cutout.tolerance', 'Tolerance', CUTOUT, 'Fill', 0, 60, 0.5),
  def('cutout.grow', 'Grow', CUTOUT, 'Fill', -8, 8, 1, 'px'),
  def('cutout.feather', 'Feather', CUTOUT, 'Fill', 0, 12, 1, 'px'),
  def('cutout.minIsland', 'Drop islands under', CUTOUT, 'Fill', 0, 400, 10, 'px'),
  def('cutout.seedTolerance', 'A fill’s own tolerance', CUTOUT, 'Fills', 0, 60, 0.5),
  def('cutout.lineWidth', 'Cut width', CUTOUT, 'Cuts', 1, 24, 1, 'px'),

  // Color Palette
  def('palette.count', 'Colors', PALETTE, 'Extraction', 1, 24, 1),
  def('palette.minDistance', 'Minimum distance', PALETTE, 'Extraction', 0, 60, 1),
  def('palette.temperature', 'Temperature', PALETTE, 'Extraction', 0, 1, 0.05),
  def('palette.precision', 'Color precision', PALETTE, 'Reading', 2, 8, 1, 'bits'),
  def('palette.alphaFloor', 'Ignore pixels more transparent than', PALETTE, 'Reading', 0, 255, 1),
  def('palette.minShare', 'Drop groups under', PALETTE, 'Reading', 0, 0.2, 0.005, 'share of the image'),
  def('palette.opacity', 'Opacity', PALETTE, 'Color', 0, 255, 1),

  // Palette Filter
  def('paletteFilter.minChunk', 'Smallest chunk', ['art.palette.filter'], 'Snap', 0, 200, 1, 'px'),
  def('paletteFilter.tolerance', 'Tolerance', ['art.palette.filter'], 'Keep', 0, 80, 0.5),

  // Polygon Decomposition
  def('vectorize.lineWidth', 'Widest a stroke may be', VECTORIZE, 'Shapes', 1, 24, 0.5, 'px'),
  def('vectorize.edgeThreshold', 'Contrast that counts', VECTORIZE, 'Edges', 2, 40, 0.5),
  def('vectorize.edgeFloor', '…and to keep one going', VECTORIZE, 'Edges', 0, 20, 0.5),
  def('vectorize.minArea', 'Drop regions under', VECTORIZE, 'Edges', 0, 200, 4, 'px'),
  def('vectorize.refineRounds', 'Rounds of refinement', VECTORIZE, 'Refinement', 0, 4, 1, 'rounds'),
  def('vectorize.hotspotBlock', 'Measured over blocks of', VECTORIZE, 'Refinement', 4, 64, 4, 'px'),
  def('vectorize.hotspotShare', 'Worst blocks to work on', VECTORIZE, 'Refinement', 0.05, 1, 0.05, 'share'),
  def('vectorize.detail', 'Simplify to within', VECTORIZE, 'Outlines', 0, 6, 0.1, 'px'),
  def('vectorize.maxPoints', 'At most, per shape', VECTORIZE, 'Outlines', 0, 80, 1, 'points'),
  def('vectorize.curveThreshold', 'Curved if bent by', VECTORIZE, 'Outlines', 0, 0.3, 0.01, 'of its length'),
  def('vectorize.minNodeGap', 'Nodes at least', VECTORIZE, 'Cleanup', 0, 6, 0.5, 'px'),
  def('vectorize.minPolygonArea', 'Smallest polygon', VECTORIZE, 'Cleanup', 0, 100, 1, 'px²'),
  def('vectorize.minLineLength', 'Shortest line', VECTORIZE, 'Cleanup', 0, 40, 1, 'px'),
  def('vectorize.joinGap', 'Join line ends within', VECTORIZE, 'Cleanup', 0, 12, 0.5, 'px'),

  // Outside any flow
  def('connection.weight', 'Connection weight', [], 'Connections', 0, 1, 0.05),
];

const BY_KEY = new Map(SLIDER_RANGES.map((range) => [range.key, range]));

export function sliderRange(key: string): SliderRangeDef | undefined {
  return BY_KEY.get(key);
}

export function sliderRangeKeys(): string[] {
  return SLIDER_RANGES.map((range) => range.key);
}

/** A changed end, or step. Anything left out is the default. */
export interface SliderRangeOverride {
  min?: number;
  max?: number;
  step?: number;
}

export type SliderRangeOverrides = Record<string, SliderRangeOverride>;

export interface EffectiveRange {
  min: number;
  max: number;
  step: number;
}

/** The ends a slider uses: its defaults with any saved change over them. */
export function effectiveRange(key: string, overrides: SliderRangeOverrides | undefined): EffectiveRange {
  const base = BY_KEY.get(key);
  const fallback = { min: 0, max: 1, step: 0.05 };
  if (!base) return fallback;
  const change = overrides?.[key] ?? {};
  const min = change.min ?? base.min;
  const max = change.max ?? base.max;
  const step = change.step ?? base.step;
  // A saved pair that no longer makes sense (a default moved under it) falls
  // back rather than drawing a slider that cannot move.
  if (!(max > min)) return { min: base.min, max: base.max, step };
  return { min, max, step };
}

const LIMIT = 1e9;

/**
 * Check a set of changes before it is stored. Unknown sliders, numbers that are
 * not numbers, and ends the wrong way round are refused, with the reason.
 * Changes equal to the default are dropped, so the file holds only changes.
 */
export function validateSliderOverrides(input: unknown): { ok: true; value: SliderRangeOverrides } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, error: 'Expected an object of slider ranges.' };
  const value: SliderRangeOverrides = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const base = BY_KEY.get(key);
    if (!base) return { ok: false, error: `No slider called “${key}”.` };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: `${base.label}: expected min, max and step.` };
    const change: SliderRangeOverride = {};
    for (const field of ['min', 'max', 'step'] as const) {
      const number = (raw as Record<string, unknown>)[field];
      if (number === undefined || number === null) continue;
      if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > LIMIT) {
        return { ok: false, error: `${base.label}: ${field} must be a number.` };
      }
      if (number !== base[field]) change[field] = number;
    }
    const min = change.min ?? base.min;
    const max = change.max ?? base.max;
    if (!(max > min)) return { ok: false, error: `${base.label}: the lowest (${min}) must be under the highest (${max}).` };
    if (change.step !== undefined && !(change.step > 0)) return { ok: false, error: `${base.label}: the step must be more than 0.` };
    if (change.step !== undefined && change.step > max - min) return { ok: false, error: `${base.label}: the step is wider than the whole range.` };
    if (Object.keys(change).length > 0) value[key] = change;
  }
  return { ok: true, value };
}
