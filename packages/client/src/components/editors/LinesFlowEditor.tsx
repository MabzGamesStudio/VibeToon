import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_LINE_OPTIONS,
  FULL_BLUE_WIDTH,
  detectLines,
  emptyLinesFlowData,
  inputsForPort,
  lineImage,
  linesReport,
  summariseLines,
  type Bitmap,
  type FlowNode,
  type LineOptions,
  type LineResult,
  type LinesFlowData,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { pngDataUrl, readBitmap } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { paintBitmap } from './CropFlowEditor';
import { EditorShell } from './EditorShell';
import { LineDebugger } from './LineDebugger';

/** Base64 of a UTF-8 string, for a markdown attachment. */
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Finding the lines in a picture. The line image is worked out here as the
 * settings change, and shown in place of the picture or under it.
 */
export function LinesFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify, busyFlows, showGuide } = useStudio();
  const openGuide = () => showGuide(node.kind);
  const data = node.data.editor === 'lines' ? (node.data as LinesFlowData) : emptyLinesFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<LinesFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);
  const setOptions = (over: Partial<LineOptions>) => patch({ options: { ...data.options, ...over } });

  const input = inputsForPort(project, node.id, 'image')[0];
  const artifact = input?.artifact;
  const path = artifact ? (artifact.entries?.[0] ? `${artifact.path}/${artifact.entries[0]}` : artifact.path) : '';

  const [source, setSource] = useState<Bitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSource(null);
    setError(null);
    if (!path) return undefined;
    let cancelled = false;
    readBitmap(api.artifactUrl(project.id, path), { maxPixels: 16_000_000 })
      .then((read) => {
        if (cancelled) return;
        setSource(read);
        const was = dataRef.current.source;
        if (!was || was.width !== read.width || was.height !== read.height || was.hash !== artifact?.hash) {
          patch({ source: { width: read.width, height: read.height, ...(artifact?.hash ? { hash: artifact.hash } : {}) } });
        }
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the file: re-reading it on every setting would be slow for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, project.id, artifact?.hash]);

  // The lines are found when the picture arrives, then on the button — or, with
  // live on, a moment after each setting stops moving.
  const [result, setResult] = useState<{ lines: LineResult; image: Bitmap; key: string } | null>(null);
  const [working, setWorking] = useState(false);
  const optionsKey = JSON.stringify(data.options);
  const find = useCallback((options: LineOptions) => {
    if (!source) return null;
    const lines = detectLines(source, options);
    const found = { lines, image: lineImage(lines), key: JSON.stringify(options) };
    setResult(found);
    return found;
  }, [source]);
  const run = useCallback(() => {
    setWorking(true);
    // A frame to paint "Looking…" before the work holds the page up.
    window.setTimeout(() => {
      find(dataRef.current.options);
      setWorking(false);
    }, 20);
  }, [find]);
  // With Live off nothing is worked out until Generate is pressed: on a big
  // picture finding the lines holds the page up for a while.
  useEffect(() => {
    setResult(null);
    if (source && dataRef.current.live) run();
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!source || !data.live || result?.key === optionsKey) return undefined;
    setWorking(true);
    const timer = window.setTimeout(() => {
      find(dataRef.current.options);
      setWorking(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [source, optionsKey, data.live]); // eslint-disable-line react-hooks/exhaustive-deps
  const behind = Boolean(result && result.key !== optionsKey);

  const [overlay, setOverlay] = useState(false);
  // Explain a pixel: click one, and see why it is or is not on a line.
  const [debug, setDebug] = useState(false);
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const pixelAt = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const element = canvas.current;
    if (!element || !source) return null;
    // The canvas is drawn "contain": letterboxed inside its box, at one scale.
    const box = element.getBoundingClientRect();
    const scale = Math.min(box.width / source.width, box.height / source.height);
    const x = Math.floor((clientX - box.left - (box.width - source.width * scale) / 2) / scale);
    const y = Math.floor((clientY - box.top - (box.height - source.height * scale) / 2) / scale);
    return x >= 0 && y >= 0 && x < source.width && y < source.height ? { x, y } : null;
  };
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const under = useRef<HTMLCanvasElement | null>(null);
  const showing = data.view;
  useEffect(() => {
    if (showing === 'original') paintBitmap(canvas.current, source);
    // Until the lines are found, the picture they will be found in.
    else paintBitmap(canvas.current, result?.image ?? source);
    paintBitmap(under.current, overlay && showing === 'lines' ? source : null);
  }, [result, source, showing, overlay]);

  const onGenerate = async () => {
    // What is written is always for the settings as they are, shown or not.
    let current = result && !behind ? result : null;
    if (!current && source) {
      setWorking(true);
      // A frame to paint "Generating…" before the work holds the page up.
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      current = find(dataRef.current.options);
      setWorking(false);
    }
    if (!current) {
      await generateFlow(node.id);
      return;
    }
    try {
      await generateFlow(node.id, [
        { name: 'lines.png', data: await pngDataUrl(current.image) },
        { name: 'lines.md', data: `data:text/markdown;base64,${utf8Base64(linesReport(current.lines, data.options, input?.sourceNode.name ?? 'the picture'))}` },
      ]);
    } catch (reason) {
      notify('error', `Could not write the lines: ${(reason as Error).message}`);
    }
  };

  const generating = working || busyFlows.includes(node.id);
  const generateButton = (
    <button
      type="button"
      className={`vt-btn is-small${!result || (behind && !data.live) ? ' is-primary' : ''}`}
      disabled={!source || generating}
      title="Find the lines for these settings and write them to the outputs"
      onClick={() => void onGenerate()}
    >
      {generating ? 'Generating…' : 'Generate'}
    </button>
  );
  const liveToggle = (
    <label className={`vt-switch${data.live ? ' is-on' : ''}`} title="Find the lines again whenever a setting changes">
      <input type="checkbox" role="switch" checked={data.live} aria-checked={data.live} onChange={(event) => patch({ live: event.target.checked })} />
      <span className="vt-switch-track" aria-hidden="true" />
      Live
    </label>
  );

  const blocked = !input
    ? 'Wire an image into the Image input.'
    : !artifact
      ? `Press Generate on ${input.sourceNode.name} first — it has not produced an image yet.`
      : error
        ? `The picture could not be read: ${error}.`
        : null;

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={onGenerate}
      banner={blocked ? <div className="vt-sync-banner"><span>{blocked}</span></div> : undefined}
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>What a line is</h3>
          <p className="vt-hint">
            A thin band of one colour, with a sharp change into it and a sharp change out of it, longer than it is wide.
            One colour meeting another is an edge, and a gradient changes gently: neither is a line.
          </p>
          <div className="vt-row" style={{ gap: 8, alignItems: 'center', margin: '4px 0 8px' }}>
            <span className="vt-faint" title="Version 2 is version 1, then lines coloured by the way they run, wide bands between thin lines dropped, and small patches dropped.">Algorithm</span>
            <div className="vt-facet-values" role="radiogroup" aria-label="Algorithm version">
              {([1, 2] as const).map((version) => (
                <button key={version} type="button" className={`vt-chip${(data.options.version ?? 1) === version ? ' is-on' : ''}`} aria-pressed={(data.options.version ?? 1) === version} onClick={() => setOptions({ version })}>
                  Version {version}
                </button>
              ))}
            </div>
          </div>
          <Slider
            range="lines.contrast"
            label="Sharp change"
            tip="lines.contrast"
            value={data.options.contrast}
            format={(value) => `${Math.round(value)}`}
            onChange={(contrast) => setOptions({ contrast: Math.round(contrast) })}
          />
          <Slider
            range="lines.flatness"
            label="Flatness"
            tip="lines.flatness"
            value={data.options.flatness}
            format={(value) => `${Math.round(value)}`}
            onChange={(flatness) => setOptions({ flatness: Math.round(flatness) })}
          />
          <Slider
            range="lines.maxWidth"
            label="Widest line"
            tip="lines.maxWidth"
            value={data.options.maxWidth}
            format={(value) => `${Math.round(value)} px`}
            onChange={(maxWidth) => setOptions({ maxWidth: Math.round(maxWidth) })}
          />
          <Slider
            range="lines.ratio"
            label="Longer than wide by"
            tip="lines.ratio"
            value={data.options.ratio}
            format={(value) => `×${value.toFixed(1)}`}
            onChange={(ratio) => setOptions({ ratio: Math.round(ratio * 10) / 10 })}
          />
          <Slider
            range="lines.joinTolerance"
            label="Patch colour tolerance"
            tip="lines.joinTolerance"
            value={data.options.joinTolerance ?? data.options.contrast}
            format={(value) => `${Math.round(value)}`}
            onChange={(joinTolerance) => setOptions({ joinTolerance: Math.round(joinTolerance) })}
          />
          <Slider
            range="lines.drawWidth"
            label="Drawn width"
            tip="lines.drawWidth"
            value={data.options.drawWidth ?? 0}
            format={(value) => (Math.round(value) === 0 ? 'whole line' : `${Math.round(value)} px`)}
            onChange={(drawWidth) => setOptions({ drawWidth: Math.round(drawWidth) })}
          />
          {data.options.version === 2 ? (
            <>
              <Slider
                range="lines.sandwich"
                label="Wide between thin lines"
                tip="lines.sandwich"
                value={data.options.sandwich ?? 2}
                format={(value) => (value <= 0 ? 'kept' : `×${value.toFixed(1)}`)}
                onChange={(sandwich) => setOptions({ sandwich: Math.round(sandwich * 10) / 10 })}
              />
              <Slider
                range="lines.minArea"
                label="Smallest patch"
                tip="lines.minArea"
                value={data.options.minArea ?? 6}
                format={(value) => `${Math.round(value)} px`}
                onChange={(minArea) => setOptions({ minArea: Math.round(minArea) })}
              />
            </>
          ) : null}
          <Slider
            range="lines.chunk"
            label="Chunk size"
            tip="lines.chunk"
            value={data.options.chunk}
            format={(value) => `${Math.round(value)} px`}
            onChange={(chunk) => setOptions({ chunk: Math.round(chunk) })}
          />
          <div className="vt-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {generateButton}
            {liveToggle}
            <span className="vt-spacer" />
            <button type="button" className="vt-btn is-ghost is-small" onClick={() => patch({ options: { ...DEFAULT_LINE_OPTIONS } })}>
              Defaults
            </button>
          </div>
          <p className="vt-hint">
            {data.live
              ? 'Live: the lines are found again as each setting changes. Generate writes them to the outputs.'
              : behind
                ? 'The settings have changed since these lines were found. Generate to find them again and write them, or turn on Live.'
                : 'Generate finds the lines for these settings and writes them to the outputs. Turn on Live to see them change as you move a setting.'}
          </p>
        </div>

        <div className="vt-section">
          <h3>Found</h3>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
            {working ? 'Looking…' : result ? summariseLines(result.lines) : '—'}
          </p>
          {data.options.version === 2 ? (
            <div className="vt-lines-ways" aria-hidden="true">
              {(
                [
                  ['Horizontal', '#ff0000', '#0000ff'],
                  ['Vertical', '#00ff00', '#0000ff'],
                  ['Diagonal', '#ffff00', '#0000ff'],
                ] as const
              ).map(([label, from, to]) => (
                <div key={label} className="vt-lines-legend">
                  <span style={{ minWidth: 74 }}>{label}</span>
                  <i style={{ background: `linear-gradient(90deg, ${from}, ${to})` }} />
                  <span>{FULL_BLUE_WIDTH} px +</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="vt-lines-legend" aria-hidden="true">
              <span>thin</span>
              <i />
              <span>{FULL_BLUE_WIDTH} px +</span>
            </div>
          )}
          <p className="vt-faint" style={{ fontSize: 11 }}>
            Black is no line. Brighter is surer{data.options.version === 2 ? '; bluer is wider.' : '.'}
          </p>
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title={showing === 'lines' ? 'Lines' : 'The original'}
          tools={
            <>
              {generateButton}
              {liveToggle}
              <button
                type="button"
                className={`vt-chip${debug ? ' is-on' : ''}`}
                aria-pressed={debug}
                title="Click a pixel to see why it is, or is not, on a line"
                onClick={() => setDebug((on) => !on)}
              >
                Explain a pixel
              </button>
              {showing === 'lines' ? (
                <label className="vt-row" style={{ gap: 4, fontSize: 11 }}>
                  <input type="checkbox" checked={overlay} onChange={(event) => setOverlay(event.target.checked)} />
                  over the picture
                </label>
              ) : null}
              <div className="vt-facet-values" role="radiogroup" aria-label="Show">
                {(
                  [
                    ['lines', 'Lines'],
                    ['original', 'Original'],
                  ] as const
                ).map(([value, label]) => (
                  <button key={value} type="button" className={`vt-chip${showing === value ? ' is-on' : ''}`} aria-pressed={showing === value} onClick={() => patch({ view: value })}>
                    {label}
                  </button>
                ))}
              </div>
            </>
          }
        >
          <div className="vt-resize-stage">
            {source ? (
              <div
                className={`vt-crop-frame${debug ? ' is-picking' : ''}`}
                onPointerDown={(event) => {
                  if (debug && event.button === 0 && !event.shiftKey) pressed.current = { x: event.clientX, y: event.clientY };
                }}
                onPointerUp={(event) => {
                  const from = pressed.current;
                  pressed.current = null;
                  // A click, not a drag.
                  if (!debug || !from || Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4) return;
                  const at = pixelAt(event.clientX, event.clientY);
                  if (at) setPick(at);
                }}
              >
                <canvas ref={under} className="vt-lines-under" style={{ display: overlay && showing === 'lines' ? 'block' : 'none' }} />
                <canvas
                  ref={canvas}
                  className={`vt-crop-canvas${overlay && showing === 'lines' ? ' is-screen' : ''}`}
                  style={{ imageRendering: 'pixelated' }}
                />
                {debug && pick ? (
                  <svg className="vt-crop-overlay vt-line-pick" viewBox={`0 0 ${source.width} ${source.height}`} preserveAspectRatio="xMidYMid meet" style={{ pointerEvents: 'none' }}>
                    <rect x={pick.x} y={pick.y} width={1} height={1} className="vt-line-pick-cell" />
                    <line x1={pick.x + 0.5} y1={0} x2={pick.x + 0.5} y2={pick.y - 1} className="vt-line-pick-hair" />
                    <line x1={pick.x + 0.5} y1={pick.y + 2} x2={pick.x + 0.5} y2={source.height} className="vt-line-pick-hair" />
                    <line x1={0} y1={pick.y + 0.5} x2={pick.x - 1} y2={pick.y + 0.5} className="vt-line-pick-hair" />
                    <line x1={pick.x + 2} y1={pick.y + 0.5} x2={source.width} y2={pick.y + 0.5} className="vt-line-pick-hair" />
                  </svg>
                ) : null}
              </div>
            ) : (
              <div className="vt-empty">{blocked ?? 'Reading the picture…'}</div>
            )}
          </div>
        </Stage>
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          Black is no line. A line is red when thin and blue when wide, brighter the surer. Toggle Original to compare, or lay the lines over the picture.
          {debug ? ' Click a pixel to see why it is, or is not, on a line.' : ''}
        </p>
        {debug && source ? (
          pick ? (
            <LineDebugger source={source} options={data.live || !result ? data.options : (JSON.parse(result.key) as LineOptions)} pick={pick} onClose={() => setPick(null)} onGuide={openGuide} />
          ) : (
            <div className="vt-line-debug">
              <p className="vt-hint">
                <b>Explain a pixel</b> is on: click any pixel of the picture above — on a line, beside one, on an edge — and the whole detection is run again with a note
                kept of it, to show every step it went through and the numbers it was decided by.
              </p>
            </div>
          )
        ) : null}
      </div>
    </EditorShell>
  );
}
