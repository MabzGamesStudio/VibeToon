import { useEffect, useMemo, useRef, useState } from 'react';
import { explainLinePixel, type Bitmap, type LineOptions, type LineTrace, type LineTraceDirection, type Run } from '@vibetoon/shared';

/** Each walk's colour, in the magnifier and on its tab. */
export const WALK_COLOURS = ['#6ea8fe', '#56c271', '#e8b04b', '#c678dd'];

const css = (colour: readonly number[]) => `rgba(${Math.round(colour[0]!)}, ${Math.round(colour[1]!)}, ${Math.round(colour[2]!)}, ${(colour[3] ?? 255) / 255})`;
const pct = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Why a pixel is, or is not, on a line — shown.
 *
 * The detection is run again with a note kept of the pixel (`explainLinePixel`),
 * so everything here is what actually happened: the four walks through it,
 * where each was cut into runs and why, the tests the pixel's run passed or
 * failed, the patch it joined and how long that is for its width, and the
 * arithmetic of the confidence.
 */
export function LineDebugger({
  source,
  options,
  pick,
  onClose,
  onGuide,
}: {
  source: Bitmap;
  options: LineOptions;
  pick: { x: number; y: number };
  onClose(): void;
  onGuide?(): void;
}): JSX.Element {
  const [trace, setTrace] = useState<LineTrace | null>(null);
  const [working, setWorking] = useState(false);
  const optionsKey = JSON.stringify(options);
  useEffect(() => {
    setWorking(true);
    // A frame to paint "Working…" first: the whole picture is read again.
    const timer = window.setTimeout(() => {
      setTrace(explainLinePixel(source, options, pick.x, pick.y));
      setWorking(false);
    }, 20);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, optionsKey, pick.x, pick.y]);

  // The walk to look at: the one that gave the most, or failing that the one that got furthest.
  const [chosen, setChosen] = useState<number | null>(null);
  useEffect(() => setChosen(null), [pick.x, pick.y]);
  const best = useMemo(() => {
    if (!trace) return 0;
    let at = 0;
    let furthest = -1;
    trace.directions.forEach((direction, index) => {
      const progress = direction.score > 0 ? 100 + direction.score : direction.patch ? 50 : (direction.walk?.checks.filter((check) => check.pass).length ?? 0);
      if (progress > furthest) {
        furthest = progress;
        at = index;
      }
    });
    return at;
  }, [trace]);
  const shown = chosen ?? best;

  return (
    <div className="vt-line-debug" aria-label="Why this pixel">
      <div className="vt-row vt-line-debug-head">
        <strong>
          Pixel ({pick.x}, {pick.y})
        </strong>
        {trace ? <span className="vt-line-swatch" style={{ background: css(trace.colour) }} title={`rgba(${trace.colour.join(', ')})`} /> : null}
        <span className="vt-spacer" />
        {onGuide ? (
          <button type="button" className="vt-btn is-small" onClick={onGuide}>
            How it works
          </button>
        ) : null}
        <button type="button" className="vt-btn is-ghost is-small" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {!trace || working ? (
        <p className="vt-faint">Reading the picture again with a note kept of this pixel…</p>
      ) : (
        <>
          <Verdict trace={trace} />
          <div className="vt-line-debug-top">
            <Magnifier source={source} trace={trace} shown={shown} />
            <DirectionSummary trace={trace} shown={shown} onChoose={setChosen} />
          </div>
          <Pipeline direction={trace.directions[shown]!} />
          <WalkStages source={source} trace={trace} direction={trace.directions[shown]!} colour={WALK_COLOURS[shown]!} />
        </>
      )}
    </div>
  );
}

/* ---------------- the answer ---------------- */

function Verdict({ trace }: { trace: LineTrace }): JSX.Element {
  const scoring = trace.directions.filter((direction) => direction.score > 0);
  if (trace.confidence > 0) {
    return (
      <p className="vt-line-verdict is-line">
        <strong>On a line</strong>, {pct(trace.confidence)} sure and {trace.width.toFixed(1)} px wide. {scoring.length === 1 ? 'One walk' : `${scoring.length} walks`} crossed it as a
        line: {scoring.map((direction) => direction.name.toLowerCase()).join(', ')}. The confidence is the best of them; the width, the narrowest.
      </p>
    );
  }
  // Why not: how far the furthest walk got.
  const reasons = trace.directions.map((direction) => {
    const failed = direction.walk?.checks.find((check) => !check.pass);
    if (direction.walk?.crossing && direction.patch && !direction.patch.pass) return `${direction.name}: crossed, but only ${direction.patch.ratio.toFixed(1)}× longer than wide`;
    if (failed) return `${direction.name}: ${failed.failed}`;
    return `${direction.name}: —`;
  });
  return (
    <p className="vt-line-verdict">
      <strong>Not on a line.</strong> No walk through it found a line that is long enough. {reasons.join('; ')}.
    </p>
  );
}

/* ---------------- the neighbourhood, magnified ---------------- */

function Magnifier({ source, trace, shown }: { source: Bitmap; trace: LineTrace; shown: number }): JSX.Element {
  const radius = Math.max(8, Math.min(16, trace.options.maxWidth + 6));
  const side = radius * 2 + 1;
  const cell = Math.max(8, Math.floor(300 / side));
  const size = side * cell;
  const left = trace.x - radius;
  const top = trace.y - radius;
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    element.width = side;
    element.height = side;
    const context = element.getContext('2d')!;
    const image = context.createImageData(side, side);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const sx = left + x;
        const sy = top + y;
        const to = (y * side + x) * 4;
        if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
        const from = (sy * source.width + sx) * 4;
        image.data[to] = source.data[from]!;
        image.data[to + 1] = source.data[from + 1]!;
        image.data[to + 2] = source.data[from + 2]!;
        image.data[to + 3] = source.data[from + 3]!;
      }
    }
    context.putImageData(image, 0, 0);
  }, [source, left, top, side]);

  const inView = (x: number, y: number) => x >= left && x < left + side && y >= top && y < top + side;
  const centre = (x: number, y: number) => ({ x: (x - left + 0.5) * cell, y: (y - top + 0.5) * cell });
  const direction = trace.directions[shown]!;
  const walk = direction.walk;
  const run = walk ? walk.runs[walk.run] : undefined;
  const chunk = trace.chunk;

  return (
    <div className="vt-line-magnifier-wrap">
      <div className="vt-line-magnifier" style={{ width: size, height: size }} title="The pixels round it, magnified">
        <canvas ref={canvas} style={{ width: size, height: size, imageRendering: 'pixelated' }} />
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* The chunk it was read in. */}
          <rect
            className="vt-line-chunk"
            x={(chunk.x0 - left) * cell}
            y={(chunk.y0 - top) * cell}
            width={(chunk.x1 - chunk.x0) * cell}
            height={(chunk.y1 - chunk.y0) * cell}
          />
          {/* The patch this walk's crossing joined. */}
          {direction.patch
            ? direction.patch.pixels.map((at) => {
                const px = at % source.width;
                const py = Math.floor(at / source.width);
                if (!inView(px, py)) return null;
                return <rect key={at} className={`vt-line-patch${direction.patch!.pass ? '' : ' is-short'}`} x={(px - left) * cell} y={(py - top) * cell} width={cell} height={cell} />;
              })
            : null}
          {/* The run the pixel is in, along the shown walk. */}
          {walk && run
            ? walk.points.slice(run.start, run.end).map((point, k) =>
                inView(point.x, point.y) ? (
                  <rect key={`run-${k}`} className="vt-line-run-cell" x={(point.x - left) * cell + 1} y={(point.y - top) * cell + 1} width={cell - 2} height={cell - 2} style={{ stroke: WALK_COLOURS[shown] }} />
                ) : null,
              )
            : null}
          {/* Every walk through it. */}
          {trace.directions.map((one, index) => {
            if (!one.walk) return null;
            const points = one.walk.points.filter((point) => inView(point.x, point.y));
            if (points.length < 2) return null;
            const a = centre(points[0]!.x, points[0]!.y);
            const b = centre(points[points.length - 1]!.x, points[points.length - 1]!.y);
            return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={WALK_COLOURS[index]} strokeWidth={index === shown ? 2.5 : 1} strokeOpacity={index === shown ? 0.95 : 0.45} strokeDasharray={index === shown ? undefined : '3 3'} />;
          })}
          <rect className="vt-line-target" x={radius * cell} y={radius * cell} width={cell} height={cell} />
        </svg>
      </div>
      <div className="vt-line-magnifier-legend">
        {side} × {side} px round it, magnified. Lines: the four walks through it (the one shown, solid). Outlined: the pixel’s run. Amber: the patch it joined (red if too
        short). Dashed: the chunk it is read in.
      </div>
    </div>
  );
}

/* ---------------- the four walks at a glance ---------------- */

function DirectionSummary({ trace, shown, onChoose }: { trace: LineTrace; shown: number; onChoose(index: number): void }): JSX.Element {
  return (
    <div className="vt-line-directions">
      <div className="vt-faint" style={{ fontSize: 11, marginBottom: 4 }}>
        Four walks cross the pixel. Each can find a line; the pixel takes the best.
      </div>
      {trace.directions.map((direction, index) => {
        const failed = direction.walk?.checks.find((check) => !check.pass);
        const status = direction.score > 0 ? pct(direction.score) : direction.walk?.crossing ? (direction.patch?.pass ? '—' : 'too short') : failed ? failed.failed : '—';
        return (
          <button
            key={direction.name}
            type="button"
            className={`vt-line-direction${index === shown ? ' is-on' : ''}${direction.score > 0 ? ' is-line' : ''}`}
            onClick={() => onChoose(index)}
            style={{ borderLeftColor: WALK_COLOURS[index] }}
          >
            <span className="vt-line-direction-name">{direction.name}</span>
            <span className="vt-line-direction-bar">
              <i style={{ width: pct(direction.score), background: WALK_COLOURS[index] }} />
            </span>
            <span className="vt-line-direction-status">{status}</span>
          </button>
        );
      })}
      <div className="vt-line-direction is-total">
        <span className="vt-line-direction-name">
          <strong>The pixel</strong>
        </span>
        <span className="vt-line-direction-bar">
          <i style={{ width: pct(trace.confidence), background: '#fff' }} />
        </span>
        <span className="vt-line-direction-status">{trace.confidence > 0 ? `${pct(trace.confidence)} · ${trace.width.toFixed(1)} px` : 'no line'}</span>
      </div>
    </div>
  );
}

/* ---------------- how far the shown walk got ---------------- */

function Pipeline({ direction }: { direction: LineTraceDirection }): JSX.Element {
  const walk = direction.walk;
  const stages: Array<{ label: string; state: 'ok' | 'no' | 'skip' }> = [
    { label: 'Walk through it', state: walk ? 'ok' : 'no' },
    { label: 'Cut into runs', state: walk ? 'ok' : 'skip' },
    { label: 'Its run a crossing?', state: !walk ? 'skip' : walk.crossing ? 'ok' : 'no' },
    { label: 'Longer than wide?', state: !walk?.crossing ? 'skip' : direction.patch?.pass ? 'ok' : 'no' },
    { label: 'Score', state: direction.score > 0 ? 'ok' : 'skip' },
  ];
  return (
    <div className="vt-line-pipeline" aria-label="How far this walk got">
      {stages.map((stage, index) => (
        <span key={stage.label} className="vt-row" style={{ gap: 4 }}>
          {index > 0 ? <span className="vt-faint">→</span> : null}
          <span className={`vt-line-stage is-${stage.state}`}>
            {stage.state === 'ok' ? '✓ ' : stage.state === 'no' ? '✗ ' : ''}
            {stage.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function WalkStages({ source, trace, direction, colour }: { source: Bitmap; trace: LineTrace; direction: LineTraceDirection; colour: string }): JSX.Element {
  const walk = direction.walk;
  const options = trace.options;
  if (!walk) return <p className="vt-faint">No walk in this direction reached the pixel.</p>;
  const failed = walk.checks.find((check) => !check.pass);
  const patch = direction.patch;
  return (
    <div className="vt-line-stages">
      <section>
        <h4>
          <span style={{ color: colour }}>●</span> 1. Walk {direction.name.toLowerCase()}, and cut the walk into runs
        </h4>
        <p className="vt-hint">
          Along the walk, a new run starts wherever the colour <b>jumps</b> — one step of {options.contrast} or more (▲) — or has <b>drifted</b> from the run’s average by
          more than {options.flatness} (┊), which is how a gradient becomes many runs with no jump between them. A run of one or two pixels that is only a{' '}
          <b>blend</b> of its neighbours is folded into the edge it softens.
        </p>
        <WalkStrip source={source} walk={walk} options={options} />
      </section>

      <section>
        <h4>2. Is the pixel’s run a line crossing?</h4>
        <ol className="vt-line-checks">
          {walk.checks.map((check) => (
            <li key={check.label} className={check.pass ? 'is-pass' : 'is-fail'}>
              <span className="vt-line-check-mark">{check.pass ? '✓' : '✗'}</span>
              <span>
                <b>{check.label}</b> — {check.detail}
              </span>
            </li>
          ))}
        </ol>
        {failed ? (
          <p className="vt-line-because is-no">This walk stops here: its run is not a line crossing, so it gives the pixel nothing.</p>
        ) : (
          <p className="vt-line-because is-yes">
            A crossing, {walk.across} px across, with edges {walk.sharp?.toFixed(0)} sharp (the softer of the two).
          </p>
        )}
      </section>

      {walk.crossing ? (
        <section>
          <h4>3. Longer than wide?</h4>
          {patch ? (
            <>
              <p className="vt-hint">
                A crossing on its own could be a speck. So the pixels this walk found crossings at are joined up with their neighbours of the same colour (8-connected, within
                half a chunk) into a <b>patch</b> — amber in the magnifier — and the patch must reach along the line at least {options.ratio}× its width.
              </p>
              <dl className="vt-kv vt-line-numbers">
                <dt>Patch</dt>
                <dd>{patch.pixels.length} pixel(s)</dd>
                <dt>Along the line</dt>
                <dd>{patch.length.toFixed(1)} px</dd>
                <dt>Mean width</dt>
                <dd>{patch.meanWidth.toFixed(2)} step(s)</dd>
                <dt>Longer than wide</dt>
                <dd>
                  {patch.length.toFixed(1)} ÷ {Math.max(1, patch.meanWidth).toFixed(2)} = <b>{patch.ratio.toFixed(2)}×</b> (needs {patch.needed}×)
                </dd>
                {patch.minArea !== null ? (
                  <>
                    <dt>Fills</dt>
                    <dd>
                      {patch.pixels.length} px (needs {patch.minArea})
                    </dd>
                  </>
                ) : null}
              </dl>
              <RatioBar ratio={patch.ratio} needed={patch.needed} />
              <p className={`vt-line-because ${patch.pass ? 'is-yes' : 'is-no'}`}>
                {patch.pass
                  ? 'Long enough, and big enough: a stroke, not a speck.'
                  : patch.ratio >= patch.needed && patch.minArea !== null && patch.pixels.length < patch.minArea
                    ? `It fills only ${patch.pixels.length} pixel(s), fewer than ${patch.minArea}: a dot, not a line.`
                    : 'Too short for its width — a speck or a dash — so this walk gives the pixel nothing.'}
              </p>
            </>
          ) : (
            <p className="vt-faint">The crossing was not joined into a patch in this pixel’s chunk.</p>
          )}
        </section>
      ) : null}

      {patch?.pass ? (
        <section>
          <h4>4. How sure</h4>
          <p className="vt-hint">Half from how sharp the edges are, half from how far past the ratio the patch reaches; never below 20% once it is a line.</p>
          <dl className="vt-kv vt-line-numbers">
            <dt>Sharpness</dt>
            <dd>
              min(1, {walk.sharp?.toFixed(0)} ÷ ({options.contrast} × 2.5)) = <b>{pct(patch.sharpScore)}</b>
            </dd>
            <dt>Reach</dt>
            <dd>
              min(1, {patch.ratio.toFixed(2)} ÷ ({options.ratio} × 2)) = <b>{pct(patch.reachScore)}</b>
            </dd>
            <dt>This walk</dt>
            <dd>
              max(20%, ½ × {pct(patch.sharpScore)} + ½ × {pct(patch.reachScore)}) = <b>{pct(direction.score)}</b>
            </dd>
            <dt>Width</dt>
            <dd>
              {walk.across} step(s){direction.step[0] !== 0 && direction.step[1] !== 0 ? ' × √2 (a diagonal step)' : ''} = <b>{direction.width.toFixed(2)} px</b>
            </dd>
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function RatioBar({ ratio, needed }: { ratio: number; needed: number }): JSX.Element {
  const most = Math.max(needed * 2.5, ratio * 1.1, 1);
  return (
    <div className="vt-line-ratio" title={`${ratio.toFixed(2)}× of ${needed}× needed`}>
      <i className={ratio >= needed ? 'is-pass' : 'is-fail'} style={{ width: `${Math.min(100, (ratio / most) * 100)}%` }} />
      <span className="vt-line-ratio-mark" style={{ left: `${(needed / most) * 100}%` }}>
        needs {needed}×
      </span>
    </div>
  );
}

/**
 * The walk as a strip of its pixels round the one asked about: where runs
 * start and why, the blends folded away, and the pixel's run.
 */
function WalkStrip({ source, walk, options }: { source: Bitmap; walk: NonNullable<LineTraceDirection['walk']>; options: LineOptions }): JSX.Element {
  const reach = options.maxWidth + 6;
  const from = Math.max(0, walk.index - reach);
  const to = Math.min(walk.points.length, walk.index + reach + 1);
  const cell = 16;
  const width = (to - from) * cell;
  const rawStarts = new Map(walk.rawRuns.map((run) => [run.start, run]));
  const keptStarts = new Set(walk.runs.map((run) => run.start));
  // The raw runs folded away: blends.
  const folded = walk.rawRuns.filter((run) => !keptStarts.has(run.start));
  const letter = (index: number) => String.fromCharCode(65 + (index % 26));
  const pixelColour = (run: Run | undefined) => (run ? css(run.colour) : 'transparent');
  return (
    <div className="vt-line-strip-wrap">
      <svg width={width} height={96} viewBox={`0 0 ${width} 96`} className="vt-line-strip">
        {/* Runs, after folding: a bar in the run's average colour, lettered. */}
        {walk.runs.map((run, index) => {
          const a = Math.max(run.start, from);
          const b = Math.min(run.end, to);
          if (b <= a) return null;
          return (
            <g key={`run-${run.start}`}>
              <rect x={(a - from) * cell + 1} y={4} width={(b - a) * cell - 2} height={14} rx={3} fill={pixelColour(run)} stroke={index === walk.run ? '#fff' : 'rgba(255,255,255,0.25)'} strokeWidth={index === walk.run ? 2 : 1} />
              <text x={((a + b) / 2 - from) * cell} y={30} textAnchor="middle" className="vt-line-strip-label">
                {index === walk.run ? `${letter(index)} · this run · ${run.end - run.start}px` : `${letter(index)} · ${run.end - run.start}px`}
              </text>
            </g>
          );
        })}
        {/* The pixels themselves, as they are in the picture. */}
        {walk.points.slice(from, to).map((point, k) => {
          const at = (point.y * source.width + point.x) * 4;
          return <rect key={`px-${from + k}`} x={k * cell} y={36} width={cell - 1} height={cell - 1} fill={css([source.data[at]!, source.data[at + 1]!, source.data[at + 2]!, source.data[at + 3]!])} />;
        })}
        <rect x={(walk.index - from) * cell - 1} y={35} width={cell + 1} height={cell + 1} fill="none" stroke="#fff" strokeWidth={2} />
        {/* Blends folded into an edge. */}
        {folded.map((run) => {
          const a = Math.max(run.start, from);
          const b = Math.min(run.end, to);
          if (b <= a) return null;
          return (
            <g key={`blend-${run.start}`}>
              <rect x={(a - from) * cell} y={36} width={(b - a) * cell - 1} height={cell - 1} fill="url(#vt-blend-hatch)" />
              <text x={((a + b) / 2 - from) * cell} y={70} textAnchor="middle" className="vt-line-strip-note">
                blend
              </text>
            </g>
          );
        })}
        {/* Why each run starts: a jump or a drift. */}
        {walk.runs.map((run) => {
          if (run.start <= from || run.start >= to || run.start === 0) return null;
          const x = (run.start - from) * cell;
          const raw = rawStarts.get(run.start);
          const jump = run.sharpIn > 0;
          return (
            <g key={`cut-${run.start}`}>
              <line x1={x - 0.5} y1={34} x2={x - 0.5} y2={54} stroke={jump ? '#e8b04b' : '#9aa4b4'} strokeWidth={jump ? 2 : 1} strokeDasharray={jump ? undefined : '2 2'} />
              <text x={x} y={84} textAnchor="middle" className={jump ? 'vt-line-strip-jump' : 'vt-line-strip-note'}>
                {jump ? `▲${run.sharpIn.toFixed(0)}` : raw ? '┊drift' : '┊'}
              </text>
            </g>
          );
        })}
        <text x={(walk.index - from + 0.5) * cell} y={62} textAnchor="middle" className="vt-line-strip-you">
          ▲ it
        </text>
        <defs>
          <pattern id="vt-blend-hatch" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={2} height={4} fill="rgba(0,0,0,0.45)" />
          </pattern>
        </defs>
      </svg>
      <div className="vt-faint" style={{ fontSize: 10 }}>
        Top: the runs, in their average colour. Middle: the pixels along the walk. ▲n: a jump of n into the run after it; ┊: the colour drifted. Hatched: a blend folded
        into the edge.
      </div>
    </div>
  );
}
