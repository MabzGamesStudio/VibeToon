import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bodyBounds,
  confidenceLabel,
  dragJoint,
  emptyRigMatchFlowData,
  fittedBones,
  fittedImage,
  inputsForPort,
  jointLimits,
  moveBody,
  placeInPicture,
  readBoundRig,
  reportIsCurrent,
  resetPart,
  restFit,
  rigMatchState,
  rotateBody,
  scaleBody,
  shapePath,
  sizePart,
  summariseRigMatch,
  turnPart,
  wrapAngle,
  type Bitmap,
  type FlowNode,
  type Project,
  type RigFit,
  type RigMatchFlowData,
  type RigMatchOptions,
  type VectorLine,
  type VectorPoint,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { InfoTip } from '../common/InfoTip';
import { Slider } from '../common/Slider';
import { onScreen } from '../common/handles';
import { readBitmap } from '../common/pixels';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';
import type { MatchReply, MatchRequest } from './rigMatch/matchWorker';

type Tool = 'joints' | 'body';

type Drag =
  | { kind: 'joint'; bone: string }
  | { kind: 'move'; from: VectorPoint; start: RigFit }
  | { kind: 'scale'; start: RigFit; reach: number }
  | { kind: 'turn'; start: RigFit; angle: number };

/** A confidence as a color: red for none, amber in the middle, green for sure. */
function confidenceColor(value: number | null | undefined): string {
  if (value === null || value === undefined) return '#8a93a6';
  const hue = Math.round(Math.max(0, Math.min(1, value)) * 120);
  return `hsl(${hue} 75% 50%)`;
}

/**
 * Finding a bound rig in a picture.
 *
 * Take the body in, press Match, and the body is placed, sized and turned into
 * the picture and each part fitted to it — with a confidence for each part,
 * so it is clear which to trust and which to look at. Then anything can be put
 * right by hand: drag a joint to turn and size its part, drag the whole body,
 * size it and turn it, or place it roughly first and let "Refine from here"
 * finish the job.
 */
export function RigMatchFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'rigMatch' ? (node.data as RigMatchFlowData) : emptyRigMatchFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback(
    (over: Partial<RigMatchFlowData> | ((was: RigMatchFlowData) => RigMatchFlowData)) => {
      const was = dataRef.current;
      const next = typeof over === 'function' ? over(was) : { ...was, ...over };
      dataRef.current = next;
      setFlowData(node.id, next);
    },
    [node.id, setFlowData],
  );

  const boundInput = inputsForPort(project, node.id, 'bound')[0];
  const imageInput = inputsForPort(project, node.id, 'image')[0];
  const boundArtifact = boundInput?.artifact;
  const imageArtifact = imageInput?.artifact;
  const imageUrl = imageArtifact ? api.artifactUrl(project.id, imageArtifact.path) : null;
  const bound = data.bound;
  const state = rigMatchState(data, boundArtifact?.hash, imageArtifact?.hash);

  /* ---------------- the picture ---------------- */

  const [bitmap, setBitmap] = useState<Bitmap | null>(null);
  const [pictureError, setPictureError] = useState<string | null>(null);
  useEffect(() => {
    setBitmap(null);
    setPictureError(null);
    if (!imageUrl) return undefined;
    let cancelled = false;
    readBitmap(imageUrl, { maxPixels: 24_000_000 })
      .then((read) => {
        if (!cancelled) setBitmap(read);
      })
      .catch((error: Error) => {
        if (!cancelled) setPictureError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);
  const picture = bitmap ? { width: bitmap.width, height: bitmap.height } : (data.picture ?? null);

  /* ---------------- taking the body in ---------------- */

  const takeIn = useCallback(async () => {
    if (!boundArtifact) return;
    try {
      const read = readBoundRig(await (await fetch(api.artifactUrl(project.id, boundArtifact.path))).json());
      if (!read) {
        notify('error', 'That file is not a bound rig this editor can read.');
        return;
      }
      // A fit is kept — its angles still apply to the bones that remain — but
      // what it was scored as is not, now the body is a different one.
      patch({ bound: read, boundHash: boundArtifact.hash, report: null });
      notify('success', `Took in ${read.rig.bones.length} bone(s). Press Match to find the body in the picture.`);
    } catch (error) {
      notify('error', `Could not read that: ${(error as Error).message}`);
    }
  }, [boundArtifact, notify, patch, project.id]);

  /* ---------------- the match, in a worker ---------------- */

  const worker = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const [running, setRunning] = useState<{ stage: string; fraction: number; kind: 'match' | 'refine' | 'score' } | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);

  const start = useCallback(
    (kind: 'match' | 'refine' | 'score') => {
      const now = dataRef.current;
      if (!now.bound || !bitmap || !imageArtifact) return;
      if (kind !== 'match' && !now.fit) return;
      if (!worker.current) {
        worker.current = new Worker(new URL('./rigMatch/matchWorker.ts', import.meta.url), { type: 'module' });
      }
      const id = (requestId.current += 1);
      const pixels = bitmap.data.slice().buffer;
      const key = `${now.boundHash ?? ''}|${imageArtifact.hash}`;
      const size = { width: bitmap.width, height: bitmap.height };
      const request: MatchRequest =
        kind === 'score'
          ? { type: 'score', id, key, bound: now.bound, picture: { ...size, pixels }, options: now.options, fit: now.fit! }
          : { type: 'match', id, key, bound: now.bound, picture: { ...size, pixels }, options: now.options, ...(kind === 'refine' ? { from: now.fit! } : {}) };
      setRunning({ stage: 'Starting', fraction: 0, kind });
      worker.current.onmessage = (event: MessageEvent<MatchReply>) => {
        const reply = event.data;
        if (reply.id !== requestId.current) return;
        if (reply.type === 'progress') {
          setRunning({ stage: reply.stage, fraction: reply.fraction, kind });
          return;
        }
        setRunning(null);
        if (reply.type === 'error') {
          notify('error', `The match stopped: ${reply.message}`);
        } else if (reply.type === 'done') {
          patch({ fit: reply.fit, report: reply.report, picture: size, imageHash: imageArtifact.hash });
          notify(reply.report.confidence >= 0.45 ? 'success' : 'warn', `Matched in ${(reply.report.ms / 1000).toFixed(1)}s — confidence ${confidenceLabel(reply.report.confidence)}.`);
        } else {
          patch({ report: reply.report, picture: size, imageHash: imageArtifact.hash });
        }
      };
      worker.current.postMessage(request, [pixels]);
    },
    [bitmap, imageArtifact, notify, patch],
  );

  const stop = () => {
    worker.current?.terminate();
    worker.current = null;
    setRunning(null);
  };

  /* ---------------- what is shown ---------------- */

  // Before a match, the body stands where a match would start looking, faded,
  // so it can be placed by hand first.
  const guess = useMemo(() => (bound && picture ? restFit(bound, picture) : null), [bound, picture?.width, picture?.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const fit = data.fit ?? guess;
  const bones = useMemo(() => (bound && fit ? fittedBones(bound.rig, fit) : new Map()), [bound, fit]);
  const drawing = useMemo(() => (bound && fit && picture ? fittedImage(bound, fit, picture) : null), [bound, fit, picture]);
  const current = reportIsCurrent(data);
  const report = data.report;
  const selected = bound && data.selected ? bound.rig.bones.find((bone) => bone.id === data.selected) : undefined;

  /**
   * Set the fit. The picture's size goes with it, so a body placed by hand
   * before any match still comes out at the picture's size.
   */
  const setFit = (next: RigFit) => patch({ fit: next, ...(picture ? { picture: { width: picture.width, height: picture.height } } : {}) });

  /** Change the fit — starting from the guess when nothing has been matched yet. */
  const changeFit = (change: (was: RigFit) => RigFit) => {
    const was = dataRef.current.fit ?? guess;
    if (!was) return;
    setFit(change(was));
  };

  /* ---------------- pointing ---------------- */

  const frame = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<Tool>('joints');
  const drag = useRef<Drag | null>(null);

  const locate = (event: { clientX: number; clientY: number }): VectorPoint | null => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !picture || box.width === 0 || picture.width === 0) return null;
    const scale = Math.min(box.width / picture.width, box.height / picture.height);
    const left = box.x + (box.width - picture.width * scale) / 2;
    const top = box.y + (box.height - picture.height * scale) / 2;
    return { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale };
  };
  const screenScale = () => {
    const box = frame.current?.getBoundingClientRect();
    return box && picture ? Math.min(box.width / picture.width, box.height / picture.height) : 1;
  };

  /** The body's frame in the picture: where the size and turn handles go. */
  const handles = useMemo(() => {
    if (!bound || !fit) return null;
    const box = bodyBounds(bound);
    const middle = placeInPicture(fit, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const corner = placeInPicture(fit, { x: box.x + box.width, y: box.y + box.height });
    const top = placeInPicture(fit, { x: box.x + box.width / 2, y: box.y - box.height * 0.08 });
    const corners = [
      placeInPicture(fit, { x: box.x, y: box.y }),
      placeInPicture(fit, { x: box.x + box.width, y: box.y }),
      corner,
      placeInPicture(fit, { x: box.x, y: box.y + box.height }),
    ];
    return { middle, corner, top, corners };
  }, [bound, fit]);

  const onDown = (event: React.PointerEvent) => {
    // The middle button and Shift-drag move the view; they are the stage's.
    if (event.button !== 0 || event.shiftKey) return;
    if (!bound || !fit || running) return;
    const point = locate(event);
    if (!point) return;
    const reach = 12 / screenScale();
    if (tool === 'body' && handles) {
      if (Math.hypot(point.x - handles.corner.x, point.y - handles.corner.y) <= reach) {
        drag.current = { kind: 'scale', start: fit, reach: Math.hypot(point.x - handles.middle.x, point.y - handles.middle.y) };
      } else if (Math.hypot(point.x - handles.top.x, point.y - handles.top.y) <= reach) {
        drag.current = { kind: 'turn', start: fit, angle: Math.atan2(point.y - handles.middle.y, point.x - handles.middle.x) };
      } else {
        drag.current = { kind: 'move', from: point, start: fit };
      }
    } else {
      // The nearest joint within reach, or the nearest part to select.
      let nearest: string | null = null;
      let best = reach;
      for (const [id, bone] of bones) {
        const distance = Math.hypot(bone.to.x - point.x, bone.to.y - point.y);
        if (distance <= best) {
          best = distance;
          nearest = id;
        }
      }
      if (nearest) {
        drag.current = { kind: 'joint', bone: nearest };
        patch({ selected: nearest });
      } else {
        let part: string | null = null;
        let closest = Infinity;
        for (const [id, bone] of bones) {
          const dx = bone.to.x - bone.from.x;
          const dy = bone.to.y - bone.from.y;
          const length = dx * dx + dy * dy;
          const t = length > 0 ? Math.max(0, Math.min(1, ((point.x - bone.from.x) * dx + (point.y - bone.from.y) * dy) / length)) : 0;
          const distance = Math.hypot(point.x - (bone.from.x + t * dx), point.y - (bone.from.y + t * dy));
          if (distance < closest) {
            closest = distance;
            part = id;
          }
        }
        if (part) patch({ selected: part });
      }
    }
    if (drag.current) (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };

  const onMove = (event: React.PointerEvent) => {
    const held = drag.current;
    if (!held || !bound || !handles) return;
    const point = locate(event);
    if (!point) return;
    if (held.kind === 'joint') changeFit((was) => dragJoint(bound.rig, was, held.bone, point, dataRef.current.options.keepLimits));
    else if (held.kind === 'move') setFit(moveBody(held.start, { x: point.x - held.from.x, y: point.y - held.from.y }));
    else if (held.kind === 'scale') {
      const reach = Math.hypot(point.x - handles.middle.x, point.y - handles.middle.y);
      if (held.reach > 0) setFit(scaleBody(held.start, held.start.scale * (reach / held.reach), handles.middle));
    } else {
      const angle = Math.atan2(point.y - handles.middle.y, point.x - handles.middle.x);
      setFit(rotateBody(held.start, held.start.rotation + ((angle - held.angle) * 180) / Math.PI, handles.middle));
    }
  };

  const onUp = () => {
    drag.current = null;
  };

  /* ---------------- options ---------------- */

  const setOption = <K extends keyof RigMatchOptions>(key: K, value: RigMatchOptions[K]) =>
    patch((was) => ({ ...was, options: { ...was.options, [key]: value } }));

  const blocked = !boundInput
    ? 'Wire a Rig Binding flow into the Bound rig input.'
    : !imageInput
      ? 'Wire a picture into the Picture input.'
      : !boundArtifact
        ? `Press Generate on ${boundInput.sourceNode.name} first.`
        : !imageArtifact
          ? `Press Generate on ${imageInput.sourceNode.name} first.`
          : null;

  const partsByConfidence = useMemo(() => {
    if (!bound) return [];
    return bound.rig.bones
      .map((bone) => ({ bone, score: report?.parts[bone.id] }))
      .sort((a, b) => (b.score?.confidence ?? -1) - (a.score?.confidence ?? -1));
  }, [bound, report]);

  const limits = selected && bound ? jointLimits(bound.rig, selected) : null;

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
            <span>{blocked}</span>
          </div>
        ) : state === 'none' ? (
          <div className="vt-sync-banner">
            <span>Nothing taken in yet.</span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take it in
            </button>
          </div>
        ) : state === 'stale' ? (
          <div className="vt-sync-banner">
            <span>
              {boundArtifact && data.boundHash !== boundArtifact.hash
                ? 'The bound rig has changed since it was taken in.'
                : 'The picture has changed since the match. Match again to find the body in the new one.'}
            </span>
            {boundArtifact && data.boundHash !== boundArtifact.hash ? (
              <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
                Take in the new one
              </button>
            ) : null}
          </div>
        ) : pictureError ? (
          <div className="vt-sync-banner">
            <span>The picture could not be read: {pictureError}</span>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Find the body</h3>
          <Slider
            range="rigMatch.features"
            label="Features per part"
            tip="rigMatch.features"
            value={data.options.features}
            format={(value) => `${Math.round(value)} per part`}
            hint="Small patches of each part to look for. Bigger parts give more."
            onChange={(value) => setOption('features', Math.round(value))}
          />
          <Slider
            range="rigMatch.scaleRange"
            label="Range in size"
            tip="rigMatch.scaleRange"
            value={data.options.scaleRange}
            format={(value) => (value <= 1.001 ? 'as guessed' : `×${(1 / value).toFixed(2)} to ×${value.toFixed(1)}`)}
            onChange={(value) => setOption('scaleRange', Math.round(value * 100) / 100)}
          />
          <Slider
            range="rigMatch.angleRange"
            label="Range in angle"
            tip="rigMatch.angleRange"
            value={data.options.angleRange}
            format={(value) => (value < 1 ? 'upright only' : `±${Math.round(value)}°`)}
            onChange={(value) => setOption('angleRange', Math.round(value))}
          />
          <Field label="Joints" tip="rigMatch.keepLimits">
            <label className="vt-row" style={{ gap: 6 }}>
              <input type="checkbox" checked={data.options.keepLimits} onChange={(event) => setOption('keepLimits', event.target.checked)} />
              Keep to each joint’s range of motion
            </label>
          </Field>
          <div className="vt-row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" className="vt-btn is-primary" disabled={!bound || !bitmap || Boolean(running)} onClick={() => start('match')}>
              Match
            </button>
            <button
              type="button"
              className="vt-btn"
              disabled={!bound || !bitmap || !data.fit || Boolean(running)}
              title="Look for the body only near where it is now — for after placing it roughly by hand"
              onClick={() => start('refine')}
            >
              Refine from here
            </button>
          </div>
          {running ? (
            <div className="vt-match-progress" role="status">
              <div className="vt-match-bar">
                <span style={{ width: `${Math.round(running.fraction * 100)}%` }} />
              </div>
              <div className="vt-row" style={{ gap: 6 }}>
                <span className="vt-faint">
                  {running.stage}… {Math.round(running.fraction * 100)}%
                </span>
                <span className="vt-spacer" />
                <button type="button" className="vt-btn is-small is-ghost" onClick={stop}>
                  Stop
                </button>
              </div>
            </div>
          ) : !bitmap && imageArtifact && !pictureError ? (
            <p className="vt-faint" style={{ fontSize: 11 }}>
              Reading the picture…
            </p>
          ) : report ? (
            <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
              {report.rigFeatures} features of the body against {report.imageFeatures.toLocaleString('en')} of the picture
              {report.agreeing ? `; ${report.agreeing} agreed on where the body is` : ''} · {(report.ms / 1000).toFixed(1)}s
            </p>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>
            Confidence
            <InfoTip tip="rigMatch.confidence" label="Confidence" />
          </h3>
          {report ? (
            <>
              <div className="vt-match-overall" style={{ color: confidenceColor(report.confidence) }}>
                {Math.round(report.confidence * 100)}%<span className="vt-faint"> {confidenceLabel(report.confidence).split(' · ')[1]}</span>
              </div>
              {!current ? (
                <div className="vt-hint" style={{ marginBottom: 6 }}>
                  Adjusted by hand since this was measured.{' '}
                  <button type="button" className="vt-btn is-small" disabled={Boolean(running) || !bitmap} onClick={() => start('score')}>
                    Measure this pose
                  </button>
                </div>
              ) : null}
              {report.notes.map((note) => (
                <p key={note} className="vt-hint">
                  {note}
                </p>
              ))}
              <div className="vt-match-parts">
                {partsByConfidence.map(({ bone, score }) => (
                  <button
                    key={bone.id}
                    type="button"
                    className={`vt-match-part${data.selected === bone.id ? ' is-selected' : ''}`}
                    onClick={() => patch({ selected: bone.id })}
                  >
                    <span className="vt-match-part-name">{bone.name}</span>
                    <span className="vt-match-part-bar">
                      <span style={{ width: `${Math.round((score?.confidence ?? 0) * 100)}%`, background: confidenceColor(score?.confidence) }} />
                    </span>
                    <span className="vt-faint">{score?.confidence === null || score === undefined ? '—' : `${Math.round(score.confidence * 100)}%`}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="vt-faint" style={{ fontSize: 11 }}>
              Match to see how sure the fit is, part by part.
            </p>
          )}
        </div>

        <div className="vt-section">
          <h3>Show</h3>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.showBody} aria-label="Show the body" onChange={(event) => patch({ showBody: event.target.checked })} />
            The body
          </label>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.showSkeleton} aria-label="Show the skeleton" onChange={(event) => patch({ showSkeleton: event.target.checked })} />
            The skeleton
          </label>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.showFeatures} aria-label="Show the features" onChange={(event) => patch({ showFeatures: event.target.checked })} />
            The features, colored by how well each matched
          </label>
          {data.showFeatures ? <p className="vt-hint">A selected part also shows the patch each of its features compared.</p> : null}
          {data.showBody ? (
            <Slider
              range="rigMatch.bodyOpacity"
              label="Body over the picture"
              value={data.bodyOpacity}
              format={(value) => `${Math.round(value * 100)}%`}
              onChange={(bodyOpacity) => patch({ bodyOpacity })}
            />
          ) : null}
        </div>

        {bound && fit ? (
          <div className="vt-section">
            <h3>Adjust by hand</h3>
            <Slider
              range="rigMatch.rotation"
              label="Whole body turned"
              value={fit.rotation}
              format={(value) => `${Math.round(value)}°`}
              onChange={(rotation) => changeFit((was) => rotateBody(was, rotation, handles?.middle))}
            />
            <Field label="Whole body size" hint="Picture pixels to each unit of the rig.">
              <div className="vt-row" style={{ gap: 4 }}>
                <button type="button" className="vt-btn is-small" aria-label="Smaller" onClick={() => changeFit((was) => scaleBody(was, was.scale / 1.05, handles?.middle))}>
                  −
                </button>
                <input
                  type="number"
                  step={0.01}
                  min={0.001}
                  value={Math.round(fit.scale * 1000) / 1000}
                  aria-label="Whole body size"
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (value > 0) changeFit((was) => scaleBody(was, value, handles?.middle));
                  }}
                />
                <button type="button" className="vt-btn is-small" aria-label="Bigger" onClick={() => changeFit((was) => scaleBody(was, was.scale * 1.05, handles?.middle))}>
                  +
                </button>
              </div>
            </Field>
            {selected && limits ? (
              <>
                <h4 className="vt-match-subhead">{selected.name}</h4>
                <Slider
                  range="rigMatch.partAngle"
                  within={data.options.keepLimits ? limits : undefined}
                  label="Turned"
                  value={fit.angles[selected.id] ?? 0}
                  format={(value) => `${Math.round(value)}°`}
                  hint={data.options.keepLimits ? `This joint turns from ${limits.min}° to ${limits.max}°.` : undefined}
                  onChange={(angle) => changeFit((was) => turnPart(bound.rig, was, selected.id, angle, dataRef.current.options.keepLimits))}
                />
                <Slider
                  range="rigMatch.partSize"
                  label="Size"
                  hint="Dragging its joint can size it further, from a quarter to four times as drawn."
                  value={fit.sizes[selected.id] ?? 1}
                  format={(value) => `×${value.toFixed(2)}`}
                  onChange={(size) => changeFit((was) => sizePart(was, selected.id, size))}
                />
                <button type="button" className="vt-btn is-small" onClick={() => changeFit((was) => resetPart(was, selected.id))}>
                  Put this part back as drawn
                </button>
              </>
            ) : (
              <p className="vt-faint" style={{ fontSize: 11 }}>
                Click a part to turn or size it here, or drag its joint.
              </p>
            )}
            <button
              type="button"
              className="vt-btn is-small is-ghost"
              style={{ marginTop: 8 }}
              disabled={!guess}
              onClick={() => guess && patch({ fit: guess, report: null })}
            >
              Back to the first guess
            </button>
          </div>
        ) : null}
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title="Body in the picture"
          tools={
            <div className="vt-facet-values" role="toolbar" aria-label="Rig match tools">
              {(
                [
                  ['joints', 'Joints', 'Drag a joint to turn and size its part; click a part to select it.'],
                  ['body', 'Whole body', 'Drag to move the body; drag the corner square to size it and the round handle to turn it.'],
                ] as Array<[Tool, string, string]>
              ).map(([id, label, title]) => (
                <button key={id} type="button" title={title} className={`vt-chip${tool === id ? ' is-on' : ''}`} aria-pressed={tool === id} onClick={() => setTool(id)}>
                  {label}
                </button>
              ))}
            </div>
          }
        >
          {({ scale }) => (
            <div className="vt-vector-stage vt-match-stage">
              {picture && imageUrl ? (
                <div
                  className={`vt-vector-frame vt-match-frame is-${tool}`}
                  ref={frame}
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                  style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
                >
                  <svg className="vt-vector-svg" viewBox={`0 0 ${picture.width} ${picture.height}`} preserveAspectRatio="xMidYMid meet">
                    <image href={imageUrl} x={0} y={0} width={picture.width} height={picture.height} preserveAspectRatio="none" />
                    {data.showBody && drawing ? (
                      <g opacity={data.fit ? data.bodyOpacity : data.bodyOpacity * 0.6} className="vt-match-body">
                        {drawing.shapes.map((shape) =>
                          shape.kind === 'polygon' ? (
                            <path key={shape.id} d={shapePath(shape)} fill={shape.color} fillRule="evenodd" />
                          ) : (
                            <path
                              key={shape.id}
                              d={shapePath(shape)}
                              fill="none"
                              stroke={(shape as VectorLine).color}
                              strokeWidth={(shape as VectorLine).width}
                              strokeLinecap="round"
                            />
                          ),
                        )}
                      </g>
                    ) : null}
                    {data.showFeatures && report && current
                      ? report.features.map((feature, index) =>
                          // Every feature a dot in its confidence's color; the
                          // selected part's also the patch it compared.
                          <g key={index}>
                            {feature.bone === data.selected ? (
                              <circle
                                cx={feature.x}
                                cy={feature.y}
                                r={feature.r}
                                className="vt-match-feature"
                                stroke={confidenceColor(feature.confidence)}
                                strokeWidth={onScreen(1.2, scale)}
                              />
                            ) : null}
                            <circle
                              cx={feature.x}
                              cy={feature.y}
                              r={onScreen(3.2, scale)}
                              className="vt-match-feature-dot"
                              fill={confidenceColor(feature.confidence)}
                              strokeWidth={onScreen(0.8, scale)}
                            >
                              <title>{`${bound?.rig.bones.find((bone) => bone.id === feature.bone)?.name ?? feature.bone}: ${Math.round(feature.confidence * 100)}%`}</title>
                            </circle>
                          </g>,
                        )
                      : null}
                    {data.showSkeleton
                      ? [...bones.entries()].map(([id, bone]) => {
                          const partScore = report && current ? report.parts[id]?.confidence : undefined;
                          const isSelected = data.selected === id;
                          return (
                            <g key={id}>
                              <line
                                x1={bone.from.x}
                                y1={bone.from.y}
                                x2={bone.to.x}
                                y2={bone.to.y}
                                strokeWidth={onScreen(isSelected ? 4 : 2.5, scale)}
                                className={`vt-bone${isSelected ? ' is-selected' : ''}`}
                                style={partScore !== undefined ? { stroke: confidenceColor(partScore) } : undefined}
                              />
                              <circle
                                cx={bone.to.x}
                                cy={bone.to.y}
                                r={onScreen(isSelected ? 6 : 4.5, scale)}
                                strokeWidth={onScreen(1.5, scale)}
                                className={`vt-joint${isSelected ? ' is-selected' : ''}`}
                              />
                            </g>
                          );
                        })
                      : null}
                    {tool === 'body' && handles ? (
                      <g className="vt-match-handles">
                        <polygon points={handles.corners.map((point) => `${point.x},${point.y}`).join(' ')} strokeWidth={onScreen(1.2, scale)} strokeDasharray={`${onScreen(5, scale)} ${onScreen(4, scale)}`} />
                        <line x1={handles.middle.x} y1={handles.middle.y} x2={handles.top.x} y2={handles.top.y} strokeWidth={onScreen(1.2, scale)} />
                        <rect
                          x={handles.corner.x - onScreen(6, scale)}
                          y={handles.corner.y - onScreen(6, scale)}
                          width={onScreen(12, scale)}
                          height={onScreen(12, scale)}
                          strokeWidth={onScreen(1.5, scale)}
                        />
                        <circle cx={handles.top.x} cy={handles.top.y} r={onScreen(6, scale)} strokeWidth={onScreen(1.5, scale)} />
                      </g>
                    ) : null}
                  </svg>
                </div>
              ) : (
                <div className="vt-empty">{blocked ?? (pictureError ? 'The picture could not be read.' : 'Reading the picture…')}</div>
              )}
            </div>
          )}
        </Stage>
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summariseRigMatch(data)}
          {!data.fit && bound ? ' · shown where a match would start looking' : ''}
          {selected ? ` · ${selected.name} selected` : ''}
          {fit && selected ? ` · ${wrapAngle((fit.angles[selected.id] ?? 0)).toFixed(0)}°, ×${(fit.sizes[selected.id] ?? 1).toFixed(2)}` : ''}
        </p>
      </div>
    </EditorShell>
  );
}
