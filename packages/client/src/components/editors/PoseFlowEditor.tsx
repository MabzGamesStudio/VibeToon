import { useCallback, useMemo, useRef, useState } from 'react';
import {
  POSE_MODE_HINT,
  POSE_MODE_LABEL,
  boneById,
  chainById,
  clearPose,
  effectiveAngles,
  emptyPoseFlowData,
  inputsForPort,
  poseState,
  posedBones,
  posedImage,
  readBoundRig,
  shapePath,
  solveIk,
  summarisePose,
  turnBone,
  type FlowNode,
  type PoseFlowData,
  type PoseMode,
  type Project,
  type VectorLine,
  type VectorPoint,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { Slider } from '../common/Slider';
import { onScreen } from '../common/handles';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';

/**
 * Moving a bound rig.
 *
 * Two ways, because there are two things people mean by posing. **Turning a
 * joint** is what a skeleton is for: the shoulder moves and the whole arm comes
 * with it. **Dragging a tip** is what a person means when they say where they
 * want a hand — and the joints above it have to work out how to get there, which
 * is the harder question and the one worth having a solver for.
 */
export function PoseFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'pose' ? (node.data as PoseFlowData) : emptyPoseFlowData();

  const input = inputsForPort(project, node.id, 'bound')[0];
  const artifact = input?.artifact;
  const [dragging, setDragging] = useState(false);
  const [reach, setReach] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);

  const bound = data.bound;
  const state = poseState(data, artifact?.hash);

  const patch = useCallback(
    (over: Partial<PoseFlowData>) => setFlowData(node.id, { ...data, ...over }),
    [data, node.id, setFlowData],
  );

  const placed = useMemo(
    () => (bound ? posedBones(bound.rig, data.pose) : new Map()),
    [bound, data.pose],
  );
  const drawing = useMemo(() => (bound ? posedImage(bound, data.pose) : null), [bound, data.pose]);

  const takeIn = useCallback(async () => {
    if (!artifact) return;
    try {
      const read = readBoundRig(await (await fetch(api.artifactUrl(project.id, artifact.path))).json());
      if (!read) {
        notify('error', 'That file is not a bound rig this editor can read.');
        return;
      }
      patch({
        bound: read,
        pose: {},
        selected: read.rig.bones[read.rig.bones.length - 1]?.id ?? null,
        sourceHash: artifact.hash,
      });
      notify('success', `Took in ${read.rig.bones.length} bone(s).`);
    } catch (error) {
      notify('error', `Could not read that: ${(error as Error).message}`);
    }
  }, [artifact, notify, patch, project.id]);

  /* ---------------- pointing ---------------- */

  const locate = (event: React.MouseEvent): VectorPoint | null => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !drawing || box.width === 0 || drawing.width === 0) return null;
    const scale = Math.min(box.width / drawing.width, box.height / drawing.height);
    if (scale === 0) return null;
    const left = box.x + (box.width - drawing.width * scale) / 2;
    const top = box.y + (box.height - drawing.height * scale) / 2;
    return { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale };
  };

  const boneNear = (point: VectorPoint): string | null => {
    let best: string | null = null;
    let nearest = Infinity;
    for (const [id, place] of placed.entries()) {
      const distance = Math.hypot(place.to.x - point.x, place.to.y - point.y);
      if (distance < nearest) {
        nearest = distance;
        best = id;
      }
    }
    return best;
  };

  const onDown = (event: React.MouseEvent) => {
    const point = locate(event);
    if (!point || !bound) return;
    const id = boneNear(point);
    if (!id) return;
    patch({ selected: id });
    if (data.mode === 'inverse') setDragging(true);
  };

  const onMove = (event: React.MouseEvent) => {
    if (!dragging || !bound || !data.selected) return;
    const point = locate(event);
    if (!point) return;
    const solved = solveIk(bound.rig, data.pose, data.selected, point, data.ik);
    setReach(
      solved.reached
        ? null
        : `That is ${solved.distance.toFixed(1)} units out of reach — the chain is as far as it goes.`,
    );
    patch({ pose: solved.pose });
  };

  const onUp = () => setDragging(false);

  const selected = bound && data.selected ? boneById(bound.rig, data.selected) : undefined;
  const limits = selected
    ? effectiveAngles(
        selected,
        selected.chain ? chainById(bound!.rig, selected.chain) : undefined,
        bound!.rig.options,
      )
    : null;

  const blocked = !input
    ? 'Wire a Rig Binding flow into the Bound rig input.'
    : !artifact
      ? `Press Generate on ${input.sourceNode.name} first.`
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
            <span>The bound rig has changed. The angles are kept and still apply to the bones that remain.</span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take in the new one
            </button>
          </div>
        ) : reach ? (
          <div className="vt-sync-banner">
            <span>{reach}</span>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>How to move it</h3>
          <div className="vt-facet-values">
            {(['forward', 'inverse'] as PoseMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`vt-chip${data.mode === mode ? ' is-on' : ''}`}
                title={POSE_MODE_HINT[mode]}
                onClick={() => patch({ mode })}
              >
                {POSE_MODE_LABEL[mode]}
              </button>
            ))}
          </div>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
            {POSE_MODE_HINT[data.mode]}
          </p>
        </div>

        {selected && limits ? (
          <div className="vt-section">
            <h3>{selected.name}</h3>
            <Slider
              range="pose.turn"
              within={limits}
              label="Turn"
              value={data.pose[selected.id] ?? 0}
              format={(value) => `${value.toFixed(0)}°`}
              hint={`This joint may turn from ${limits.min}° to ${limits.max}°.`}
              onChange={(angle) => patch(turnBone(data, selected.id, angle))}
            />
            {limits.min === 0 && limits.max === 0 ? (
              <p className="vt-faint" style={{ fontSize: 11 }}>
                This joint is welded, so it cannot turn at all.
              </p>
            ) : null}
          </div>
        ) : null}

        {data.mode === 'inverse' ? (
          <div className="vt-section">
            <h3>Solving</h3>
            <Slider
              range="pose.chainLength"
              label="Joints that may move"
              value={data.ik.chainLength}
              tip="pose.chainLength"
              hint="Counted back from the one you are dragging."
              onChange={(chainLength) => patch({ ik: { ...data.ik, chainLength } })}
            />
            <Field label="Limits" tip="pose.respectLimits">
              <label className="vt-row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={data.ik.respectLimits}
                  onChange={(event) =>
                    patch({ ik: { ...data.ik, respectLimits: event.target.checked } })
                  }
                />
                Obey each joint's range of motion
              </label>
            </Field>
          </div>
        ) : null}

        <div className="vt-section">
          <h3>Bones ({bound?.rig.bones.length ?? 0})</h3>
          <div className="vt-object-list">
            {(bound?.rig.bones ?? []).map((bone) => {
              const angle = data.pose[bone.id] ?? 0;
              return (
                <button
                  key={bone.id}
                  type="button"
                  className={`vt-object${data.selected === bone.id ? ' is-selected' : ''}`}
                  onClick={() => patch({ selected: bone.id })}
                >
                  <strong>{bone.name}</strong>
                  <span className="vt-faint">{Math.abs(angle) < 0.01 ? 'at rest' : `${angle.toFixed(0)}°`}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="vt-btn is-small"
            style={{ marginTop: 6 }}
            onClick={() => patch(clearPose(data))}
          >
            Back to rest
          </button>
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title="The pose"
          tools={
            <span className="vt-faint" style={{ fontSize: 11 }}>
              {summarisePose(data)}
            </span>
          }
        >
          {({ scale }) => (
          <div className="vt-vector-stage">
            {drawing && drawing.shapes.length > 0 ? (
              <div
                className="vt-vector-frame"
                ref={frame}
                onMouseDown={onDown}
                onMouseMove={onMove}
                onMouseUp={onUp}
                onMouseLeave={onUp}
                style={{
                  aspectRatio: `${drawing.width} / ${drawing.height}`,
                  cursor: data.mode === 'inverse' ? 'grab' : 'pointer',
                }}
              >
                <svg
                  className="vt-vector-svg"
                  viewBox={`0 0 ${drawing.width} ${drawing.height}`}
                  preserveAspectRatio="xMidYMid meet"
                >
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

                  {[...placed.entries()].map(([id, place]) => (
                    <g key={id}>
                      <line
                        x1={place.from.x}
                        y1={place.from.y}
                        x2={place.to.x}
                        y2={place.to.y}
                        strokeWidth={onScreen(data.selected === id ? 3 : 2, scale)}
                        className={`vt-bone${data.selected === id ? ' is-selected' : ''}`}
                      />
                      <circle
                        cx={place.to.x}
                        cy={place.to.y}
                        r={onScreen(Math.max(1, (drawing.width ?? 100) / 180), scale)}
                        strokeWidth={onScreen(1, scale)}
                        className={`vt-joint${data.selected === id ? ' is-selected' : ''}`}
                      />
                    </g>
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
          {summarisePose(data)}
          {selected ? ` · ${selected.name} selected` : ''}
        </p>
      </div>
    </EditorShell>
  );
}
