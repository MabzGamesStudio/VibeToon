import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addBone,
  bindShapes,
  bindState,
  centroid,
  containsPoint,
  deleteBone,
  emptyBindFlowData,
  fitRigTo,
  imageOfBinding,
  inputsForPort,
  moveImage,
  moveJoint,
  moveRig,
  placedImage,
  readVectorImage,
  restPose,
  shapePath,
  shapesInRegion,
  summariseBinding,
  unbindShapes,
  zoomImage,
  zoomRig,
  type BindFlowData,
  type FlowNode,
  type Project,
  type RigFlowData,
  type VectorLine,
  type VectorPoint,
  type VectorShape,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { onScreen } from '../common/handles';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';

/**
 * What a click does.
 *
 * Adding and taking away are separate tools rather than one tool with a
 * modifier, because binding a character is hundreds of clicks in a row and
 * holding a key down for half of them is not a thing anyone should be asked to
 * do. Each tool does its one thing on every click.
 */
type Tool = 'add' | 'remove' | 'area' | 'moveImage' | 'moveRig' | 'moveJoint' | 'addBone';

const TOOLS: Array<[Tool, string, string]> = [
  ['add', 'Add', 'Click a shape to put it in this part. Drag across several.'],
  ['remove', 'Take out', 'Click a shape to take it out of whatever it is in.'],
  ['area', 'Area', 'Click round a group of shapes. Enter finishes it; Esc abandons it.'],
  ['moveImage', 'Move drawing', 'Drag the drawing. Scroll to make it bigger or smaller.'],
  ['moveRig', 'Move skeleton', 'Drag the whole skeleton. Scroll to make it bigger or smaller.'],
  ['moveJoint', 'Move joint', 'Drag any joint where you want it. What hangs off it comes along.'],
  ['addBone', 'Add bone', 'Click where a new bone should end. It hangs off the selected one.'],
];

/**
 * Binding a drawing to a skeleton.
 *
 * The two arrive knowing nothing about each other: a pile of shapes and a
 * hierarchy of bones. This is where the map between them is made, and it is a
 * job of pointing rather than of typing, so they are shown on top of one another
 * and everything is done on them.
 *
 * Two things make it workable rather than merely possible. The drawing and the
 * skeleton are **placed separately** — no automatic fit knows where this
 * drawing's shoulders are, so lining them up is the work and it needs both to be
 * movable. And the drawing is **faded back except the part being worked on**,
 * because a character is a hundred shapes and picking the arm out of all of them
 * at once is the thing that makes this flow feel impossible.
 */
export function BindFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'bind' ? (node.data as BindFlowData) : emptyBindFlowData();

  const rigInput = inputsForPort(project, node.id, 'rig')[0];
  const vectorInput = inputsForPort(project, node.id, 'vector')[0];

  const [tool, setTool] = useState<Tool>('add');
  const [area, setArea] = useState<VectorPoint[]>([]);
  const [held, setHeld] = useState<{ what: Tool; at: VectorPoint; joint?: string } | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);

  const raw = imageOfBinding(data);
  const image = useMemo(() => placedImage(data), [data]);
  const rig = data.rig;
  const summary = useMemo(() => summariseBinding(data), [data]);
  const bones = useMemo(() => (rig ? restPose(rig) : new Map()), [rig]);
  const state = bindState(data, rigInput?.artifact?.hash, vectorInput?.artifact?.hash);

  const patch = useCallback(
    (over: Partial<BindFlowData> | BindFlowData) => setFlowData(node.id, { ...data, ...over }),
    [data, node.id, setFlowData],
  );

  /* ---------------- taking them in ---------------- */

  const takeIn = useCallback(async () => {
    if (!rigInput?.artifact || !vectorInput?.artifact) return;
    try {
      const [rigBody, vectorBody] = await Promise.all([
        fetch(api.artifactUrl(project.id, rigInput.artifact.path)).then((response) => response.json()),
        fetch(api.artifactUrl(project.id, vectorInput.artifact.path)).then((response) => response.json()),
      ]);
      const drawing = readVectorImage(vectorBody);
      const skeleton = readRig(rigBody);
      if (!skeleton) {
        notify('error', 'That rig file has no bones in it that this editor can read.');
        return;
      }
      if (drawing.shapes.length === 0) {
        notify('error', 'That drawing has no shapes in it.');
        return;
      }
      patch({
        // Laid over the drawing to begin with, or there is no bone to aim at.
        // Where it really goes is then a matter for the Move tools.
        rig: fitRigTo(skeleton, drawing),
        image: drawing,
        binding: {},
        selected: [],
        boneId: skeleton.bones[0]?.id ?? null,
        placement: { x: 0, y: 0, scale: 1 },
        rigHash: rigInput.artifact.hash,
        vectorHash: vectorInput.artifact.hash,
        edits: 0,
      });
      notify('success', `Took in ${skeleton.bones.length} bone(s) and ${drawing.shapes.length} shape(s).`);
    } catch (error) {
      notify('error', `Could not read those: ${(error as Error).message}`);
    }
  }, [notify, patch, project.id, rigInput, vectorInput]);

  /* ---------------- pointing at things ---------------- */

  /**
   * Where a click landed, in the picture's own pixels.
   *
   * Through the element's box rather than through an assumed scale, so it stays
   * right however the stage has been zoomed or panned around it.
   */
  const locate = (event: React.MouseEvent): VectorPoint | null => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || box.width === 0 || raw.width === 0) return null;
    const scale = Math.min(box.width / raw.width, box.height / raw.height);
    if (scale === 0) return null;
    const left = box.x + (box.width - raw.width * scale) / 2;
    const top = box.y + (box.height - raw.height * scale) / 2;
    return { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale };
  };

  /**
   * The shape under a point.
   *
   * Inside it, for anything filled — the shapes tile the picture, so a click
   * lands in exactly one of them and that one is the answer. Nearest middle is
   * the fallback, for strokes and for a click that fell in a gap.
   */
  const shapeAt = (point: VectorPoint): string | null => {
    for (const shape of image.shapes) {
      if (shape.kind === 'polygon' && containsPoint(shape, point)) return shape.id;
    }
    let best: string | null = null;
    let nearest = Infinity;
    for (const shape of image.shapes) {
      const middle = centroid(shape);
      const distance = Math.hypot(middle.x - point.x, middle.y - point.y);
      if (distance < nearest) {
        nearest = distance;
        best = shape.id;
      }
    }
    return nearest < 24 ? best : null;
  };

  const jointAt = (point: VectorPoint): string | null => {
    let best: string | null = null;
    let nearest = Infinity;
    for (const [id, place] of bones.entries()) {
      const distance = Math.hypot(place.to.x - point.x, place.to.y - point.y);
      if (distance < nearest) {
        nearest = distance;
        best = id;
      }
    }
    return nearest < 18 ? best : null;
  };

  const claim = (id: string) => {
    if (!data.boneId) {
      notify('error', 'Pick a part to put it in first.');
      return;
    }
    if (data.binding[id] === data.boneId) return;
    patch(bindShapes({ ...data, selected: [id] }, [id], data.boneId));
  };

  /* ---------------- dragging ---------------- */

  const onDown = (event: React.MouseEvent) => {
    const point = locate(event);
    if (!point) return;

    if (tool === 'moveJoint') {
      const joint = jointAt(point);
      if (!joint) return;
      patch({ boneId: joint });
      setHeld({ what: tool, at: point, joint });
      return;
    }
    if (tool === 'moveImage' || tool === 'moveRig') {
      setHeld({ what: tool, at: point });
      return;
    }
    if (tool === 'add' || tool === 'remove') {
      // A press is already a click on the shape under it, so dragging across a
      // run of them keeps adding rather than needing a click each.
      setHeld({ what: tool, at: point });
      apply(point);
    }
  };

  const apply = (point: VectorPoint) => {
    const id = shapeAt(point);
    if (!id) return;
    if (tool === 'add') claim(id);
    else if (tool === 'remove' && id in data.binding) patch(unbindShapes({ ...data, selected: [id] }, [id]));
  };

  const onMove = (event: React.MouseEvent) => {
    if (!held) return;
    const point = locate(event);
    if (!point) return;
    const by = { x: point.x - held.at.x, y: point.y - held.at.y };

    if (held.what === 'moveImage') {
      patch(moveImage(data, by));
      setHeld({ ...held, at: point });
    } else if (held.what === 'moveRig') {
      patch(moveRig(data, by));
      setHeld({ ...held, at: point });
    } else if (held.what === 'moveJoint' && held.joint) {
      patch(moveJoint(data, held.joint, point));
    } else {
      apply(point);
      setHeld({ ...held, at: point });
    }
  };

  const onUp = () => setHeld(null);

  /**
   * Scrolling sizes whichever of the two the current tool is about.
   *
   * Non-passive, because it has to stop the stage zooming as well — zooming the
   * drawing *and* the view at once is two things happening for one gesture, and
   * neither ends up where it was aimed.
   */
  useEffect(() => {
    const element = frame.current;
    if (!element || (tool !== 'moveImage' && tool !== 'moveRig')) return undefined;
    const onWheel = (event: WheelEvent) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || raw.width === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const scale = Math.min(box.width / raw.width, box.height / raw.height);
      const about = {
        x: (event.clientX - (box.x + (box.width - raw.width * scale) / 2)) / scale,
        y: (event.clientY - (box.y + (box.height - raw.height * scale) / 2)) / scale,
      };
      const by = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setFlowData(node.id, tool === 'moveImage' ? zoomImage(data, by, about) : zoomRig(data, by, about));
    };
    element.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => element.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  }, [data, node.id, raw.height, raw.width, setFlowData, tool]);

  /* ---------------- the area tool ---------------- */

  const finishArea = useCallback(() => {
    if (area.length >= 3) {
      const inside = shapesInRegion(image, area);
      if (inside.length === 0) notify('error', 'Nothing inside that area.');
      else if (!data.boneId) notify('error', 'Pick a part to put them in first.');
      else {
        patch(bindShapes({ ...data, selected: inside }, inside, data.boneId));
        notify('success', `Put ${inside.length} shape(s) in this part.`);
      }
    }
    setArea([]);
  }, [area, data, image, notify, patch]);

  useEffect(() => {
    if (tool !== 'area') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finishArea();
      } else if (event.key === 'Escape' && area.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        setArea([]);
      } else if ((event.key === 'Backspace' || event.key === 'z') && area.length > 0) {
        event.preventDefault();
        setArea(area.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [area, finishArea, tool]);

  const onClick = (event: React.MouseEvent) => {
    const point = locate(event);
    if (!point) return;
    if (tool === 'area') setArea([...area, point]);
    else if (tool === 'addBone') {
      patch(addBone(data, data.boneId ?? undefined, 'New bone', point));
      setTool('moveJoint');
    }
  };

  /* ---------------- what is shown ---------------- */

  const blocked = !rigInput
    ? 'Wire a Skeletal Rig flow into the Rig input.'
    : !vectorInput
      ? 'Wire a vectorized drawing into the Vector input.'
      : !rigInput.artifact || !vectorInput.artifact
        ? 'Generate both inputs first.'
        : null;

  const colorForBone = (boneId: string | undefined) => {
    if (!boneId) return null;
    const list = rig?.bones ?? [];
    const index = list.findIndex((bone) => bone.id === boneId);
    return index < 0 ? null : `hsl(${(index * 47) % 360} 75% 60%)`;
  };

  /**
   * How plainly a shape is drawn.
   *
   * The part being worked on is the picture; everything else is background for
   * it. Binding an arm means finding the arm's shapes among a hundred others,
   * and the only way that is anything other than miserable is for the hundred
   * others to get out of the way.
   *
   * In its own colors, not the part's. Recoloring an assigned shape tells you
   * which part it is in and hides the one thing you are looking at — whether
   * this really is the arm. The part's color goes round the edge instead, where
   * it says the same thing without painting over the drawing.
   */
  const showing = (shape: VectorShape): { opacity: number; edge: string | null } | null => {
    const bone = data.binding[shape.id];
    const mine = bone !== undefined && bone === data.boneId;
    if (mine) return { opacity: 1, edge: colorForBone(bone) };
    if (bone !== undefined) return data.hideOthers ? null : { opacity: 0.16, edge: colorForBone(bone) };
    return { opacity: 0.4, edge: null };
  };

  const boneName = data.boneId ? rig?.bones.find((bone) => bone.id === data.boneId)?.name : undefined;

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
              Take them in
            </button>
          </div>
        ) : state === 'stale' ? (
          <div className="vt-sync-banner">
            <span>The rig or the drawing has changed. Taking them in again replaces this binding.</span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take in the new ones
            </button>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Tool</h3>
          <div className="vt-facet-values">
            {TOOLS.map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                className={`vt-chip${tool === value ? ' is-on' : ''}`}
                title={hint}
                onClick={() => {
                  setTool(value);
                  setArea([]);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
            {TOOLS.find(([value]) => value === tool)?.[2]}
          </p>
        </div>

        <div className="vt-section">
          <h3>Where they sit</h3>
          <div className="vt-row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="vt-btn is-small"
              title="Put the drawing back where it arrived"
              onClick={() => patch({ placement: { x: 0, y: 0, scale: 1 }, edits: data.edits + 1 })}
            >
              Drawing back
            </button>
            <button
              type="button"
              className="vt-btn is-small"
              title="Lay the skeleton over the drawing again, at the size it started"
              disabled={!rig}
              onClick={() => {
                if (!rig) return;
                // Fitting measures the rig's current spread and scales it to the
                // room, so doing it to an already-fitted rig lands in the same
                // place rather than shrinking it again.
                patch({ rig: fitRigTo(rig, image), edits: data.edits + 1 });
              }}
            >
              Skeleton back
            </button>
          </div>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
            Dragging and scrolling can put either of them somewhere you cannot see. These put them
            back without touching what is already bound.
          </p>
        </div>

        <div className="vt-section">
          <h3>What is shown</h3>
          <label className="vt-row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={data.hideOthers}
              onChange={(event) => patch({ hideOthers: event.target.checked })}
            />
            Hide shapes other parts have taken
          </label>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
            The part being worked on is drawn plainly and the rest is faded back. Hiding what is
            already taken leaves only what is still to do.
          </p>
        </div>

        <div className="vt-section">
          <h3>Parts ({rig?.bones.length ?? 0})</h3>
          <div className="vt-object-list">
            {(rig?.bones ?? []).map((bone) => {
              const count = raw.shapes.filter((shape) => data.binding[shape.id] === bone.id).length;
              return (
                <button
                  key={bone.id}
                  type="button"
                  className={`vt-object${data.boneId === bone.id ? ' is-selected' : ''}`}
                  onClick={() => patch({ boneId: bone.id })}
                >
                  <span className="vt-object-dot" style={{ background: colorForBone(bone.id) ?? undefined }} />
                  <strong>{bone.name}</strong>
                  <span className="vt-faint">{count === 0 ? 'nothing' : `${count} shape(s)`}</span>
                </button>
              );
            })}
          </div>
          {data.boneId ? (
            <div className="vt-row" style={{ gap: 4, marginTop: 6 }}>
              <button
                type="button"
                className="vt-btn is-small"
                title="Take everything out of this part"
                onClick={() => {
                  const mine = raw.shapes
                    .filter((shape) => data.binding[shape.id] === data.boneId)
                    .map((shape) => shape.id);
                  if (mine.length > 0) patch(unbindShapes(data, mine));
                }}
              >
                Empty it
              </button>
              <button
                type="button"
                className="vt-btn is-small is-danger"
                onClick={() => patch(deleteBone(data, data.boneId!))}
              >
                Delete bone
              </button>
            </div>
          ) : null}
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>
            Deleting a bone hangs its children on its parent where they are, and moves its shapes
            there too — so nothing collapses onto the origin.
          </p>
        </div>

        <div className="vt-section">
          <h3>How it is going</h3>
          <dl className="vt-kv">
            <dt>Shapes</dt>
            <dd>{summary.shapes}</dd>
            <dt>Bound</dt>
            <dd>{summary.bound}</dd>
            <dt>Unbound</dt>
            <dd>{summary.unbound}</dd>
            <dt>Empty parts</dt>
            <dd>{summary.empty}</dd>
            <dt>Drawing at</dt>
            <dd>
              {data.placement.x.toFixed(0)}, {data.placement.y.toFixed(0)} ·{' '}
              {(data.placement.scale * 100).toFixed(0)}%
            </dd>
          </dl>
          {summary.problems.length > 0 ? (
            <ul className="vt-hints">
              {summary.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title="The drawing and its skeleton"
          tools={
            <>
              <span className="vt-faint" style={{ fontSize: 11 }}>
                {raw.shapes.length > 0 ? `${summary.bound}/${summary.shapes} bound` : 'nothing yet'}
              </span>
              {boneName ? (
                <span className="vt-chip is-on" style={{ pointerEvents: 'none' }}>
                  {boneName}
                </span>
              ) : null}
            </>
          }
          banner={
            tool === 'area' && area.length > 0 ? (
              <div className="vt-hint vt-zoom-hint">
                {area.length} point(s) — Enter to put what is inside into{' '}
                <strong>{boneName ?? 'this part'}</strong>, Backspace to undo one, Esc to abandon it.
              </div>
            ) : undefined
          }
        >
          {({ scale }) => (
          <div className="vt-vector-stage">
            {raw.shapes.length > 0 ? (
              <div
                className="vt-vector-frame"
                ref={frame}
                onClick={onClick}
                onMouseDown={onDown}
                onMouseMove={onMove}
                onMouseUp={onUp}
                onMouseLeave={onUp}
                style={{
                  aspectRatio: `${raw.width} / ${raw.height}`,
                  cursor: held ? 'grabbing' : tool.startsWith('move') ? 'grab' : 'crosshair',
                }}
              >
                <svg
                  className="vt-vector-svg"
                  viewBox={`0 0 ${raw.width} ${raw.height}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {image.shapes.map((shape) => {
                    const how = showing(shape);
                    if (!how) return null;
                    return shape.kind === 'polygon' ? (
                      <path
                        key={shape.id}
                        d={shapePath(shape)}
                        fill={shape.color}
                        stroke={how.edge ?? shape.color}
                        strokeWidth={how.edge ? 1.2 : 0.5}
                        opacity={how.opacity}
                      />
                    ) : (
                      <path
                        key={shape.id}
                        d={shapePath(shape)}
                        fill="none"
                        stroke={how.edge ?? (shape as VectorLine).color}
                        strokeWidth={Math.max((shape as VectorLine).width, how.edge ? 1.2 : 0)}
                        strokeLinecap="round"
                        opacity={how.opacity}
                      />
                    );
                  })}

                  {/*
                    * The skeleton over the top, so a bone can be aimed at —
                    * sized in screen pixels rather than in the picture's.
                    *
                    * A joint drawn at a fixed size in the picture's own units
                    * grows with the zoom, and zooming in is exactly what you do
                    * when you want to put one somewhere precise: at eight times
                    * the dot is eight times wider than the thing you are aiming
                    * at, and it covers the place you were trying to see.
                    */}
                  {[...bones.entries()].map(([id, place]) => (
                    <line
                      key={id}
                      x1={place.from.x}
                      y1={place.from.y}
                      x2={place.to.x}
                      y2={place.to.y}
                      strokeWidth={onScreen(data.boneId === id ? 3 : 2, scale)}
                      className={`vt-bone${data.boneId === id ? ' is-selected' : ''}`}
                    />
                  ))}
                  {[...bones.entries()].map(([id, place]) => (
                    <circle
                      key={`${id}-joint`}
                      cx={place.to.x}
                      cy={place.to.y}
                      r={onScreen(tool === 'moveJoint' ? 4 : 2.5, scale)}
                      strokeWidth={onScreen(1, scale)}
                      className={`vt-joint${data.boneId === id ? ' is-selected' : ''}`}
                    />
                  ))}

                  {area.length >= 2 ? (
                    <polygon
                      className="vt-region is-drafting"
                      points={area.map((point) => `${point.x},${point.y}`).join(' ')}
                      strokeWidth={onScreen(1, scale)}
                    />
                  ) : null}
                  {area.map((point, index) => (
                    <circle
                      key={index}
                      cx={point.x}
                      cy={point.y}
                      r={onScreen(2, scale)}
                      strokeWidth={onScreen(1, scale)}
                      className="vt-anchor"
                    />
                  ))}
                </svg>
              </div>
            ) : (
              <div className="vt-empty">{blocked ?? 'Nothing taken in yet.'}</div>
            )}
          </div>
          )}
        </Stage>

        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summary.bound} of {summary.shapes} shape(s) bound
          {boneName ? ` · working on ${boneName}` : ' · no part picked'}
          {data.hideOthers ? ' · what other parts have taken is hidden' : ''}
        </p>
      </div>
    </EditorShell>
  );
}

/** A rig file, read back as the rig flow wrote it. */
function readRig(json: unknown): RigFlowData | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  const bones = record.bones;
  if (!Array.isArray(bones) || bones.length === 0) return null;
  return {
    editor: 'rig',
    kind: (record.kind as RigFlowData['kind']) ?? 'human',
    bones: bones as RigFlowData['bones'],
    chains: (Array.isArray(record.chains) ? record.chains : []) as RigFlowData['chains'],
    options: (record.options ?? {
      squashAndStretch: 1,
      looseness: 1,
      mirror: true,
    }) as RigFlowData['options'],
  };
}
