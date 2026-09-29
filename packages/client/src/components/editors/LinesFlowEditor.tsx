import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_LINE_OPTIONS,
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
  const { setFlowData, generateFlow, notify } = useStudio();
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

  // Worked out a moment after the settings stop moving.
  const [result, setResult] = useState<{ lines: LineResult; image: Bitmap } | null>(null);
  const [working, setWorking] = useState(false);
  const optionsKey = JSON.stringify(data.options);
  useEffect(() => {
    if (!source) {
      setResult(null);
      return undefined;
    }
    setWorking(true);
    const timer = window.setTimeout(() => {
      const lines = detectLines(source, data.options);
      setResult({ lines, image: lineImage(lines) });
      setWorking(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [source, optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [overlay, setOverlay] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const under = useRef<HTMLCanvasElement | null>(null);
  const showing = data.view;
  useEffect(() => {
    if (showing === 'original') paintBitmap(canvas.current, source);
    else paintBitmap(canvas.current, result?.image ?? null);
    paintBitmap(under.current, overlay && showing === 'lines' ? source : null);
  }, [result, source, showing, overlay]);

  const onGenerate = async () => {
    if (!result) {
      await generateFlow(node.id);
      return;
    }
    try {
      await generateFlow(node.id, [
        { name: 'lines.png', data: await pngDataUrl(result.image) },
        { name: 'lines.md', data: `data:text/markdown;base64,${utf8Base64(linesReport(result.lines, data.options, input?.sourceNode.name ?? 'the picture'))}` },
      ]);
    } catch (reason) {
      notify('error', `Could not write the lines: ${(reason as Error).message}`);
    }
  };

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
            range="lines.chunk"
            label="Chunk size"
            tip="lines.chunk"
            value={data.options.chunk}
            format={(value) => `${Math.round(value)} px`}
            onChange={(chunk) => setOptions({ chunk: Math.round(chunk) })}
          />
          <button type="button" className="vt-btn is-small" onClick={() => patch({ options: { ...DEFAULT_LINE_OPTIONS } })}>
            Back to the defaults
          </button>
        </div>

        <div className="vt-section">
          <h3>Found</h3>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
            {working ? 'Looking…' : result ? summariseLines(result.lines) : '—'}
          </p>
          <div className="vt-lines-legend" aria-hidden="true">
            <span>no line</span>
            <i />
            <span>sure</span>
          </div>
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title={showing === 'lines' ? 'Lines' : 'The original'}
          tools={
            <>
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
              <div className="vt-crop-frame">
                <canvas ref={under} className="vt-lines-under" style={{ display: overlay && showing === 'lines' ? 'block' : 'none' }} />
                <canvas
                  ref={canvas}
                  className={`vt-crop-canvas${overlay && showing === 'lines' ? ' is-screen' : ''}`}
                  style={{ imageRendering: 'pixelated' }}
                />
              </div>
            ) : (
              <div className="vt-empty">{blocked ?? 'Reading the picture…'}</div>
            )}
          </div>
        </Stage>
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          Black is no line; red is a line, and the redder the surer. Toggle Original to compare, or lay the lines over the picture.
        </p>
      </div>
    </EditorShell>
  );
}
