import { useCallback, useMemo, useRef, useState } from 'react';
import {
  addBone,
  bindShapes,
  bindState,
  centroid,
  deleteBone,
  emptyBindFlowData,
  fitRigTo,
  imageOfBinding,
  inputsForPort,
  readVectorImage,
  restPose,
  shapePath,
  shapesInRegion,
  summariseBinding,
  unbindShapes,
  type BindFlowData,
  type FlowNode,
  type Project,
  type RigFlowData,
  type VectorLine,
  type VectorPoint,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';

/** What a click does. */
type Tool = 'assign' | 'region' | 'addBone';

/**
 * Binding a drawing to a skeleton.
 *
 * The two arrive knowing nothing about each other: a pile of shapes and a
 * hierarchy of bones. This is where the map between them is made, and it is a
 * job of selecting and pointing rather than of typing, so the drawing and the
 * skeleton are shown on top of one another and everything is done on them.
 */
export function BindFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'bind' ? (node.data as BindFlowData) : emptyBindFlowData();

  const rigInput = inputsForPort(project, node.id, 'rig')[0];
  const vectorInput = inputsForPort(project, node.id, 'vector')[0];

  const [tool, setTool] = useState<Tool>('assign');
  const [lasso, setLasso] = useState<VectorPoint[]>([]);
  const frame = useRef<HTMLDivElement | null>(null);

  const image = imageOfBinding(data);
  const rig = data.rig;
  const summary = useMemo(() => summariseBinding(data), [data]);
  const bones = useMemo(() => (rig ? restPose(rig) : new Map()), [rig]);
  const state = bindState(data, rigInput?.artifact?.hash, vectorInput?.artifact?.hash);

  const patch = useCallback(
    (over: Partial<BindFlowData>) => setFlowData(node.id, { ...data, ...over }),
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
        // Laid over the drawing, or there is no bone to aim at.
        rig: fitRigTo(skeleton, drawing),
        image: drawing,
        binding: {},
        selected: [],
        boneId: skeleton.bones[0]?.id ?? null,
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

  const locate = (event: React.MouseEvent): VectorPoint | null => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || box.width === 0 || image.width === 0) return null;
    const scale = Math.min(box.width / image.width, box.height / image.height);
    if (scale === 0) return null;
    const left = box.x + (box.width - image.width * scale) / 2;
    const top = box.y + (box.height - image.height * scale) / 2;
    return { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale };
  };

  /** The shape nearest a point, by which one's middle is closest. */
  const shapeAt = (point: VectorPoint): string | null => {
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
    return best;
  };

  const onClick = (event: React.MouseEvent) => {
    const point = locate(event);
    if (!point) return;

    if (tool === 'addBone') {
      patch(addBone(data, data.boneId ?? undefined, 'New bone', point));
      setTool('assign');
      return;
    }
    if (tool === 'region') {
      setLasso([...lasso, point]);
      return;
    }
    const id = shapeAt(point);
    if (!id) return;
    patch({ selected: event.shiftKey ? [...new Set([...data.selected, id])] : [id] });
  };

  const finishLasso = () => {
    if (lasso.length >= 3) {
      const inside = shapesInRegion(image, lasso);
      if (inside.length === 0) notify('error', 'Nothing inside that region.');
      else patch({ selected: inside });
    }
    setLasso([]);
  };

  const assign = () => {
    if (!data.boneId || data.selected.length === 0) return;
    patch(bindShapes(data, data.selected, data.boneId));
  };

  const blocked = !rigInput
    ? 'Wire a Skeletal Rig flow into the Rig input.'
    : !vectorInput
      ? 'Wire a vectorized drawing into the Vector input.'
      : !rigInput.artifact || !vectorInput.artifact
        ? 'Generate both inputs first.'
        : null;

  const boneOf = (shapeId: string) => data.binding[shapeId];
  const colorForBone = (boneId: string | undefined) => {
    if (!boneId) return null;
    const list = rig?.bones ?? [];
    const index = list.findIndex((bone) => bone.id === boneId);
    return index < 0 ? null : `hsl(${(index * 47) % 360} 75% 60%)`;
  };

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
            {(
              [
                ['assign', 'Pick', 'Click a shape to select it; shift-click to add.'],
                ['region', 'Region', 'Draw round a group of shapes to select them all. Double-click to finish.'],
                ['addBone', 'Add bone', 'Click where the new bone should end. It hangs off the selected bone.'],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                className={`vt-chip${tool === value ? ' is-on' : ''}`}
                title={hint}
                onClick={() => {
                  setTool(value);
                  setLasso([]);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {data.selected.length > 0 ? (
            <div className="vt-row" style={{ gap: 4, marginTop: 8 }}>
              <button type="button" className="vt-btn is-small is-primary" onClick={assign} disabled={!data.boneId}>
                Bind {data.selected.length} to this bone
              </button>
              <button
                type="button"
                className="vt-btn is-small"
                onClick={() => patch(unbindShapes(data, data.selected))}
              >
                Unbind
              </button>
            </div>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>Bones ({rig?.bones.length ?? 0})</h3>
          <div className="vt-object-list">
            {(rig?.bones ?? []).map((bone) => {
              const held = image.shapes.filter((shape) => boneOf(shape.id) === bone.id).length;
              return (
                <button
                  key={bone.id}
                  type="button"
                  className={`vt-object${data.boneId === bone.id ? ' is-selected' : ''}`}
                  onClick={() => patch({ boneId: bone.id })}
                >
                  <span
                    className="vt-object-dot"
                    style={{ background: colorForBone(bone.id) ?? undefined }}
                  />
                  <strong>{bone.name}</strong>
                  <span className="vt-faint">{held === 0 ? 'nothing' : `${held} shape(s)`}</span>
                </button>
              );
            })}
          </div>
          {data.boneId ? (
            <button
              type="button"
              className="vt-btn is-small is-danger"
              style={{ marginTop: 6 }}
              onClick={() => patch(deleteBone(data, data.boneId!))}
            >
              Delete this bone
            </button>
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
            <dt>Empty bones</dt>
            <dd>{summary.empty}</dd>
            <dt>Edits</dt>
            <dd>{data.edits}</dd>
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
            <span className="vt-faint" style={{ fontSize: 11 }}>
              {image.shapes.length > 0 ? `${summary.bound}/${summary.shapes} bound` : 'nothing yet'}
            </span>
          }
        >
          <div className="vt-vector-stage">
            {image.shapes.length > 0 ? (
              <div
                className="vt-vector-frame"
                ref={frame}
                onClick={onClick}
                onDoubleClick={finishLasso}
                style={{ aspectRatio: `${image.width} / ${image.height}`, cursor: 'crosshair' }}
              >
                <svg
                  className="vt-vector-svg"
                  viewBox={`0 0 ${image.width} ${image.height}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {image.shapes.map((shape) => {
                    const tint = colorForBone(boneOf(shape.id));
                    const picked = data.selected.includes(shape.id);
                    return shape.kind === 'polygon' ? (
                      <path
                        key={shape.id}
                        d={shapePath(shape)}
                        fill={tint ?? shape.color}
                        opacity={tint ? 0.85 : 0.45}
                        className={`vt-vector-shape${picked ? ' is-selected' : ''}`}
                      />
                    ) : (
                      <path
                        key={shape.id}
                        d={shapePath(shape)}
                        fill="none"
                        stroke={tint ?? (shape as VectorLine).color}
                        strokeWidth={(shape as VectorLine).width}
                        strokeLinecap="round"
                        opacity={tint ? 1 : 0.45}
                        className={`vt-vector-shape${picked ? ' is-selected' : ''}`}
                      />
                    );
                  })}

                  {/* The skeleton over the top, so a bone can be aimed at. */}
                  {[...bones.entries()].map(([id, place]) => (
                    <line
                      key={id}
                      x1={place.from.x}
                      y1={place.from.y}
                      x2={place.to.x}
                      y2={place.to.y}
                      className={`vt-bone${data.boneId === id ? ' is-selected' : ''}`}
                    />
                  ))}

                  {lasso.length >= 2 ? (
                    <polygon
                      className="vt-region is-drafting"
                      points={lasso.map((point) => `${point.x},${point.y}`).join(' ')}
                      strokeWidth={1}
                    />
                  ) : null}
                </svg>
              </div>
            ) : (
              <div className="vt-empty">{blocked ?? 'Nothing taken in yet.'}</div>
            )}
          </div>
        </Stage>

        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {tool === 'region' && lasso.length > 0
            ? `${lasso.length} point(s) — double-click to finish the region.`
            : `${summary.bound} of ${summary.shapes} shape(s) bound · ${data.selected.length} selected`}
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
