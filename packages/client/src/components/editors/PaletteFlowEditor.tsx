import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import {
  COUNTING_VERSION,
  DEFAULT_PALETTE_OPTIONS,
  NO_PALETTE_EDITS,
  addColor,
  applyEdits,
  changeColor,
  derivePalette,
  fromHex,
  histogramOutdated,
  histogramState,
  inputsForPort,
  countColors,
  removeColor,
  restoreColor,
  summarisePalette,
  toHex,
  type FlowNode,
  type ImageHistogram,
  type PaletteEdits,
  type PaletteEntry,
  type PaletteFlowData,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Stage } from '../common/Stage';
import { Field } from '../common/Field';
import { Slider } from '../common/Slider';
import { formatWhen } from '../common/format';
import { readBitmap } from '../common/pixels';
import { EditorShell } from './EditorShell';

/**
 * Roughly how many pixels to look at.
 *
 * A photograph off a phone is a few million pixels and counting all of them in
 * JavaScript takes long enough to notice. Every Nth pixel is taken instead, which
 * is a sample of the real colors rather than a resize — downscaling would
 * interpolate, and interpolation invents colors that are not in the picture,
 * which is exactly what a palette must not contain.
 */
const SAMPLE_TARGET = 400_000;

/**
 * An entry's color without its opacity.
 *
 * `<input type="color">` takes six digits and nothing else — hand it an
 * eight-digit hex and it quietly shows black. The opacity has its own control, so
 * splitting them is what the markup wants anyway.
 */
function solidHex(entry: PaletteEntry): string {
  return toHex({ r: entry.r, g: entry.g, b: entry.b });
}

/** An opacity as something worth reading: `solid`, or a percentage. */
function opacityLabel(a: number): string {
  return a >= 255 ? 'solid' : a <= 0 ? 'transparent' : `${Math.round((a / 255) * 100)}% opaque`;
}

/**
 * Colors out of an image.
 *
 * Reading happens here because this is where an image can be decoded: the browser
 * already knows how to read a PNG, a JPEG, a WebP or a GIF, and the alternative is
 * this project carrying a decoder for each. What is kept in the flow is the tally,
 * so generating is instant and needs neither the picture nor a network.
 */
export function PaletteFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data as PaletteFlowData;
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  const patch = useCallback((next: PaletteFlowData) => setFlowData(node.id, next), [node.id, setFlowData]);
  const options = { ...DEFAULT_PALETTE_OPTIONS, ...data.options };
  const setOption = <K extends keyof typeof options>(key: K, value: (typeof options)[K]) =>
    patch({ ...data, options: { ...options, [key]: value } });

  const imageInput = inputsForPort(project, node.id, 'image')[0];
  const artifact = imageInput?.artifact;
  const state = histogramState(data, artifact?.hash);

  /** An `imageSet` port carries a folder; the first image in it is the one read. */
  const imagePath = useMemo(() => {
    if (!artifact) return '';
    const entry = artifact.entries?.[0];
    return entry ? `${artifact.path}/${entry}` : artifact.path;
  }, [artifact]);

  const edits = data.edits ?? NO_PALETTE_EDITS;
  const palette = useMemo(
    () => (data.histogram ? applyEdits(derivePalette(data.histogram, options), edits) : null),
    [data.histogram, edits, options],
  );
  const summary = useMemo(
    () => (palette ? summarisePalette(palette, data) : null),
    [data, palette],
  );

  /**
   * Decode the image and count its colors.
   *
   * Read byte for byte (`pixels.ts`), not through a canvas, so every entry is a
   * value the file really holds — half-transparent pixels included, which a canvas
   * would move a step. Pixels too transparent to have a color are skipped rather
   * than counted as black, which is what a naive read of a PNG with a cut-out
   * background gives you: a palette whose commonest color is the hole in the
   * middle. They get the clear entry instead.
   */
  const readImage = useCallback(async () => {
    if (!artifact) return;
    setReading(true);
    try {
      const bitmap = await readBitmap(api.artifactUrl(project.id, imagePath));
      const { width, height, data: pixels } = bitmap;
      if (width === 0 || height === 0) throw new Error('the image has no size');

      const total = width * height;
      const stride = Math.max(1, Math.floor(total / SAMPLE_TARGET));
      const { colors, counted, transparent } = countColors(pixels, {
        precision: options.precision,
        alphaFloor: options.alphaFloor,
        stride,
      });

      const histogram: ImageHistogram = {
        source: imagePath.split('/').pop() ?? imagePath,
        hash: artifact.hash,
        width,
        height,
        pixels: counted,
        transparent,
        precision: options.precision,
        colors,
        readAt: new Date().toISOString(),
        counting: COUNTING_VERSION,
      };
      patch({ ...data, histogram });
      notify(
        'success',
        `Counted ${counted.toLocaleString()} pixel(s) of ${width}×${height} as ${colors.length.toLocaleString()} distinct color(s)${
          stride > 1 ? `, sampling every ${stride}${stride === 2 ? 'nd' : stride === 3 ? 'rd' : 'th'} pixel` : ''
        }.`,
      );
    } catch (error) {
      notify('error', `Could not read the image: ${(error as Error).message}`);
    } finally {
      setReading(false);
    }
  }, [artifact, data, imagePath, notify, options.alphaFloor, options.precision, patch, project.id]);

  const edit = (next: PaletteEdits) => patch({ ...data, edits: next });

  /**
   * Which derived buckets were taken out, so they can be offered back.
   *
   * A removal you cannot undo is a removal you have to think about before making,
   * which is the wrong way round for a palette you are still deciding.
   */
  const removed = useMemo(() => {
    if (!data.histogram) return [] as string[];
    const buckets = new Set(derivePalette(data.histogram, options).entries.map((entry) => entry.modeHex));
    return edits.removed.filter((hex) => {
      const rgb = fromHex(hex);
      return rgb !== undefined && buckets.has(toHex(rgb));
    });
  }, [data.histogram, edits.removed, options]);

  /**
   * Set an entry's opacity, keeping its color.
   *
   * Opacity is not a separate kind of edit: an entry is a color and how
   * see-through it is, and both live in the one hex the edit records. So this goes
   * through `changeColor` like any other change, and resetting an entry puts its
   * opacity back along with its color.
   */
  const setOpacity = (entry: PaletteEntry, a: number) =>
    edit(changeColor(edits, entry, toHex({ r: entry.r, g: entry.g, b: entry.b, a })));

  const drop = (entry: PaletteEntry) => {
    edit(removeColor(edits, entry));
    setSelected(null);
  };

  // Taking a color out shortens the list, so a selection made before it can point
  // past the end. Read through the palette rather than trusted.
  const chosen = selected === null ? null : palette?.entries[selected] ?? null;

  const blocked = !imageInput
    ? 'Wire an image into the Image input first.'
    : !artifact
      ? `Press Generate on ${imageInput.sourceNode.name} first — it has not produced an image yet.`
      : null;

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={async () => {
        await generateFlow(node.id);
      }}
      banner={
        blocked ? (
          <div className="vt-sync-banner">
            <span>{blocked} This flow takes the colors out of a picture; it does not make one.</span>
          </div>
        ) : state === 'stale' ? (
          <div className="vt-sync-banner">
            <span>
              The image has changed since it was counted, so the palette below still describes the old one. Read
              it again.
            </span>
          </div>
        ) : state === 'none' ? (
          <div className="vt-sync-banner">
            <span>The image has not been counted yet. Press “Read the image”.</span>
          </div>
        ) : histogramOutdated(data.histogram) ? (
          <div className="vt-sync-banner">
            <span>
              This image was counted before colors were read exactly, so a color below can be a step off the one
              in the picture. Read it again.
            </span>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>The image</h3>
          {artifact ? (
            <>
              {/* Zoomable, and able to fill the screen: a palette is read off the
                  picture's smallest details as much as its big areas, and those
                  are what a sidebar thumbnail cannot show. */}
              <Stage zoomable title="Source" className="vt-palette-source-stage">
                {({ full }) => (
                  <div className={`vt-palette-source${full ? ' is-full' : ''}`}>
                    <img src={api.artifactUrl(project.id, imagePath)} alt="The image the palette is read from" />
                  </div>
                )}
              </Stage>
              <dl className="vt-kv">
                <dt>From</dt>
                <dd>{imageInput?.sourceNode.name}</dd>
                <dt>File</dt>
                <dd>{imagePath.split('/').pop()}</dd>
                {data.histogram ? (
                  <>
                    <dt>Counted</dt>
                    <dd>
                      {data.histogram.width}×{data.histogram.height} ·{' '}
                      {data.histogram.pixels.toLocaleString()} pixel(s)
                    </dd>
                    <dt>Distinct colors</dt>
                    <dd>{data.histogram.colors.length.toLocaleString()}</dd>
                    <dt>Read</dt>
                    <dd>
                      {formatWhen(data.histogram.readAt)}
                      {state === 'stale' ? ' — stale' : ''}
                    </dd>
                  </>
                ) : null}
              </dl>
            </>
          ) : (
            <div className="vt-hint">{blocked}</div>
          )}

          <div className="vt-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="vt-btn is-small"
              disabled={!artifact || reading}
              title={blocked ?? undefined}
              onClick={() => void readImage()}
            >
              {reading ? 'Counting…' : data.histogram ? 'Read the image again' : 'Read the image'}
            </button>
          </div>
          <div className="vt-hint">
            The browser does the decoding, so any format it can show works. Only the tally is kept, which is
            why generating afterwards is instant and needs nothing.
          </div>
        </div>

        <div className="vt-section">
          <h3>The palette</h3>
          <Slider
            range="palette.count"
            label="Colors"
            tip="palette.count"
            value={options.count}
            format={(value) => String(Math.round(value))}
            onChange={(value) => setOption('count', Math.round(value))}
          />
          <Slider
            range="palette.minDistance"
            label="Minimum distance"
            tip="palette.minDistance"
            value={options.minDistance}
            format={(value) => value.toFixed(0)}
            onChange={(value) => setOption('minDistance', value)}
            hint="How far apart two entries must look. Under 2 is a difference you cannot see; 20 is navy against royal blue."
          />
          <Slider
            range="palette.temperature"
            label="Temperature"
            tip="palette.temperature"
            value={options.temperature}
            onChange={(value) => setOption('temperature', value)}
            hint="How far each entry may wander from its group's commonest color — towards another color in the same group, never out of it."
          />
          <Field
            label="Seed"
            tip="palette.seed"
            hint="Same seed, same palette. Only matters above temperature 0."
          >
            <div className="vt-row">
              <input
                value={options.seed}
                aria-label="Seed"
                onChange={(event) => setOption('seed', event.target.value)}
              />
              <button
                type="button"
                className="vt-btn is-small"
                onClick={() => setOption('seed', Math.random().toString(36).slice(2, 8))}
              >
                Reroll
              </button>
            </div>
          </Field>
        </div>

        <div className="vt-section">
          <h3>Counting</h3>
          <Slider
            range="palette.precision"
            label="Color precision"
            tip="palette.precision"
            value={options.precision}
            format={(value) => `${Math.round(value)} bits · ${2 ** Math.round(value)} levels`}
            onChange={(value) => setOption('precision', Math.round(value))}
            hint="How finely colors are rounded together before counting. Read the image again for a change here to take effect."
          />
          {data.histogram && data.histogram.precision !== options.precision ? (
            <div className="vt-hint">
              Counted at {data.histogram.precision} bits. Read the image again to use {options.precision}.
            </div>
          ) : null}
          <Slider
            range="palette.alphaFloor"
            label="Ignore pixels more transparent than"
            tip="palette.alphaFloor"
            value={options.alphaFloor}
            format={(value) => value.toFixed(0)}
            onChange={(value) => setOption('alphaFloor', value)}
            hint="A cut-out background is not a color. 0 counts every pixel, transparent ones included."
          />
          <Field label="Transparent" tip="palette.transparent">
            <label className="vt-row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={options.transparent}
                onChange={(event) => setOption('transparent', event.target.checked)}
              />
              Give transparent pixels an entry of their own
            </label>
          </Field>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
            On top of the colors asked for, so five colors from a cut-out picture come with the clear around
            them. It is what a filter snaps transparent pixels to.
          </p>
          <Slider
            range="palette.minShare"
            label="Drop groups under"
            tip="palette.minShare"
            value={options.minShare}
            format={(value) => `${(value * 100).toFixed(1)}% of the image`}
            onChange={(value) => setOption('minShare', value)}
            hint="Leaves out a color that barely appears. The commonest is always kept."
          />
        </div>

        {summary ? (
          <div className="vt-section">
            <h3>What came out</h3>
            <dl className="vt-kv">
              <dt>Colors</dt>
              <dd>
                {summary.colors} of {options.count} asked for
              </dd>
              <dt>Closest pair</dt>
              <dd>
                {summary.closest.toFixed(1)}
                {summary.closest > 0 && summary.closest < options.minDistance - 0.5
                  ? ' — under the minimum, because the palette ran out of room'
                  : ''}
              </dd>
              <dt>Covers</dt>
              <dd>{(summary.covered * 100).toFixed(1)}% of the image</dd>
              {summary.changed + summary.removed + summary.added > 0 ? (
                <>
                  <dt>Edited by hand</dt>
                  <dd>
                    {[
                      summary.changed > 0 ? `${summary.changed} changed` : '',
                      summary.removed > 0 ? `${summary.removed} removed` : '',
                      summary.added > 0 ? `${summary.added} added` : '',
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </dd>
                </>
              ) : null}
              {summary.waiting > 0 ? (
                <>
                  <dt>Waiting</dt>
                  <dd>
                    {summary.waiting} edit(s) for a color these settings do not produce. Kept, and back
                    when the settings are.
                  </dd>
                </>
              ) : null}
            </dl>
            {palette?.shortfall ? <div className="vt-hint">{palette.shortfall}</div> : null}
          </div>
        ) : null}
      </aside>

      <div className="vt-editor-main">
        {!palette || palette.entries.length === 0 ? (
          <div className="vt-empty">
            {blocked ?? 'Read the image and the palette appears here.'}
          </div>
        ) : (
          <>
            <div className="vt-swatches">
              {palette.entries.map((entry, index) => (
                <button
                  type="button"
                  key={`${entry.modeHex}-${index}`}
                  className={`vt-swatch${selected === index ? ' is-selected' : ''}${
                    entry.byHand || edits.changed[entry.modeHex] ? ' is-pinned' : ''
                  }`}
                  style={
                    {
                      // Laid over the checker the stylesheet draws, so an entry that is
                      // not solid looks like one rather than looking pale.
                      '--vt-swatch': entry.hex,
                      // A color put in by hand has no share to be sized by, so it takes
                      // an even one. Sized by its share it would be a sliver too narrow
                      // to read its own hex, which is the one thing it has to show.
                      flexGrow: entry.byHand ? 1 : Math.max(0.35, entry.share * palette.entries.length),
                    } as CSSProperties
                  }
                  title={
                    entry.byHand
                      ? `${entry.hex} — ${opacityLabel(entry.a)}, put in by hand, so it stands for no pixels of the image. Nearest other entry ${entry.nearest.toFixed(1)} away.`
                      : `${entry.hex} — ${opacityLabel(entry.a)}, ${(entry.share * 100).toFixed(1)}% of the image, ${entry.members} color(s) in its group, nearest other entry ${entry.nearest.toFixed(1)} away`
                  }
                  aria-label={`Color ${index + 1}, ${entry.hex}`}
                  onClick={() => setSelected(selected === index ? null : index)}
                >
                  <span className="vt-swatch-label">
                    <strong>{entry.hex}</strong>
                    <span>
                      {entry.byHand ? 'by hand' : `${(entry.share * 100).toFixed(1)}%`}
                      {entry.clear && entry.a === 0
                        ? ' · transparent'
                        : entry.a < 255
                          ? ` · ${Math.round((entry.a / 255) * 100)}% opaque`
                          : ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <div className="vt-row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <button
                type="button"
                className="vt-btn is-small"
                onClick={() => {
                  const next = addColor(edits, '#808080');
                  edit(next);
                  // Select what was just added, which is always last, so the color
                  // picker is already pointing at it.
                  setSelected(palette.entries.length);
                }}
              >
                Add a color
              </button>
              {removed.length > 0 ? (
                <>
                  <span className="vt-faint" style={{ fontSize: 11 }}>
                    Taken out:
                  </span>
                  {removed.map((hex) => (
                    <button
                      type="button"
                      key={hex}
                      className="vt-btn is-ghost is-small"
                      style={{ borderLeft: `10px solid ${hex}` }}
                      title={`Put ${hex} back in the palette`}
                      onClick={() => edit(restoreColor(edits, hex))}
                    >
                      {hex} ↩
                    </button>
                  ))}
                </>
              ) : null}
            </div>

            {chosen ? (
              <div className="vt-section">
                <h3>
                  <span>
                    Color {selected! + 1}
                    {chosen.byHand ? ' — yours' : chosen.clear ? ' — the transparent pixels' : ''}
                  </span>
                  <span className="vt-faint">{chosen.hex}</span>
                </h3>
                <dl className="vt-kv">
                  {chosen.byHand ? (
                    <>
                      <dt>Where it came from</dt>
                      <dd>
                        You put it in, so it stands for none of the image and adds nothing to the share
                        covered.
                      </dd>
                    </>
                  ) : chosen.clear ? (
                    <>
                      <dt>Where it came from</dt>
                      <dd>
                        The {chosen.count.toLocaleString()} pixel(s) too transparent to have a color —{' '}
                        {(chosen.share * 100).toFixed(1)}% of the image. A filter snaps transparent pixels to it.
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>Share of the image</dt>
                      <dd>
                        {(chosen.share * 100).toFixed(1)}% · {chosen.count.toLocaleString()} pixel(s)
                      </dd>
                      <dt>Colors in its group</dt>
                      <dd>{chosen.members}</dd>
                      <dt>The group's commonest</dt>
                      <dd>
                        <code>{chosen.modeHex}</code>
                        {chosen.shifted > 0
                          ? ` — this entry is ${chosen.shifted.toFixed(1)} away from it`
                          : ' — which is this entry exactly'}
                      </dd>
                    </>
                  )}
                  <dt>Nearest other entry</dt>
                  <dd>{chosen.nearest.toFixed(1)} away</dd>
                  <dt>Opacity</dt>
                  <dd>
                    {opacityLabel(chosen.a)}
                    {chosen.byHand
                      ? ' — yours to set'
                      : chosen.clear
                        ? ''
                        : ' — that of the pixels it is named after, so it is a value the picture holds'}
                  </dd>
                </dl>
                <Field
                  label="This color"
                  tip="palette.edit"
                  hint={
                    chosen.byHand
                      ? 'Yours to set. It survives every change of settings, because no bucket in the image decides it.'
                      : 'Set it to whatever you like and it stays there, whatever the settings do. Clear it to go back to what was counted.'
                  }
                >
                  <div className="vt-row">
                    <input
                      type="color"
                      aria-label="This color"
                      value={solidHex(chosen)}
                      onChange={(event) => {
                        // Keeping the opacity: the picker only has six digits to give,
                        // and dragging it should not quietly make a faded entry solid.
                        const rgb = fromHex(event.target.value);
                        if (rgb) edit(changeColor(edits, chosen, toHex({ ...rgb, a: chosen.a })));
                      }}
                    />
                    <input
                      value={chosen.byHand ? chosen.hex : edits.changed[chosen.modeHex] ?? ''}
                      placeholder={chosen.modeHex}
                      aria-label="Hex"
                      onChange={(event) => edit(changeColor(edits, chosen, event.target.value))}
                    />
                    {!chosen.byHand && edits.changed[chosen.modeHex] ? (
                      <button
                        type="button"
                        className="vt-btn is-ghost is-small"
                        title="Back to the color that was counted"
                        onClick={() => edit(changeColor(edits, chosen, ''))}
                      >
                        Reset
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="vt-btn is-ghost is-small"
                      title={
                        chosen.byHand
                          ? 'Forget this color'
                          : 'Take this color out of the palette. It can be put back.'
                      }
                      onClick={() => drop(chosen)}
                    >
                      {chosen.byHand ? 'Forget' : 'Take out'}
                    </button>
                  </div>
                </Field>
                <Slider
                  range="palette.opacity"
                  label="Opacity"
                  tip="palette.opacity"
                  hint="How much of what is behind this color shows through it. A filter that snaps to the palette fades a pixel by this much, so naming a see-through color is how you fade the part of a picture that is it."
                  value={chosen.a}
                  format={opacityLabel}
                  onChange={(value) => setOpacity(chosen, Math.round(value))}
                />
              </div>
            ) : (
              <div className="vt-hint">
                Each band is one color, as wide as the share of the image it accounts for. Click one to
                change it, take it out, or see where it came from.
              </div>
            )}
          </>
        )}
      </div>
    </EditorShell>
  );
}
