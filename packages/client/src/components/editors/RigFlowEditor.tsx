import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RIG_OPTIONS,
  RIG_KINDS,
  RIG_KIND_LABEL,
  boneById,
  boneLength,
  chainById,
  changeRigKind,
  effectiveAngles,
  effectiveStretch,
  emptyRigFlowData,
  inputsForPort,
  mirrorIdOf,
  moveRigJoint,
  resetBone,
  restPose,
  rigProblems,
  rigTemplate,
  setBoneLimits,
  setChain,
  summariseRig,
  type FlowNode,
  type Project,
  type RigFlowData,
  type RigKind,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { Slider } from '../common/Slider';
import { onScreen } from '../common/handles';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';
import { RigPreview } from './RigPreview';

/** Padding round the skeleton in the drawing, in rig units. */
const PAD = 12;

/**
 * The skeleton, and what each joint is allowed to do.
 *
 * Two things are worth seeing at once and neither is a number: the shape of the
 * hierarchy, and how far the selected joint can actually turn. So the skeleton is
 * drawn, and the joint's range is drawn on it as an arc — a knee whose limits are
 * the wrong way round is obvious as a picture and invisible as `min: 0, max: -140`.
 */
export function RigFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow } = useStudio();
  const data = node.data as RigFlowData;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showReference, setShowReference] = useState(true);
  /** Editing the skeleton, or watching it move under forces. */
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  /** The joint being dragged: the far end of this bone. */
  const [dragging, setDragging] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const patch = useCallback((next: RigFlowData) => setFlowData(node.id, next), [node.id, setFlowData]);
  const options = { ...DEFAULT_RIG_OPTIONS, ...data.options };

  const posed = useMemo(() => restPose(data), [data]);
  const problems = useMemo(() => rigProblems(data), [data]);
  const summary = useMemo(() => summariseRig(data), [data]);

  const selected = selectedId ? boneById(data, selectedId) : undefined;
  const selectedChain = chainById(data, selected?.chain);
  const twin = selected && options.mirror ? mirrorIdOf(selected.id) : undefined;

  const designInput = inputsForPort(project, node.id, 'design')[0];
  const design = designInput?.artifact;
  const designPath = design
    ? design.entries?.[0]
      ? `${design.path}/${design.entries[0]}`
      : design.path
    : '';

  /** The box the skeleton occupies, so the drawing fits whatever the rig is. */
  const box = useMemo(() => {
    const points = [...posed.values()].flatMap((place) => [place.from, place.to]);
    if (points.length === 0) return { minX: -50, minY: -50, width: 100, height: 100 };
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs) - PAD;
    const minY = Math.min(...ys) - PAD;
    return {
      minX,
      minY,
      width: Math.max(1, Math.max(...xs) - minX + PAD),
      height: Math.max(1, Math.max(...ys) - minY + PAD),
    };
  }, [posed]);

  /*
   * Held still while a joint is dragged. The drawing fits itself to the
   * skeleton, and a skeleton that changes shape under the pointer would refit
   * every frame — the joint would slide away from the cursor dragging it.
   */
  const [heldBox, setHeldBox] = useState<typeof box | null>(null);
  const view = heldBox ?? box;

  /** Where a pointer is, in rig units — through the stage's zoom and the fit. */
  const rigPoint = (event: React.PointerEvent): { x: number; y: number } | null => {
    const surface = svg.current;
    const matrix = surface?.getScreenCTM();
    if (!surface || !matrix) return null;
    const point = surface.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  };

  const onDragMove = (event: React.PointerEvent) => {
    if (!dragging) return;
    const at = rigPoint(event);
    if (at) patch(moveRigJoint(data, dragging, at));
  };

  const onDragEnd = () => {
    setDragging(null);
    setHeldBox(null);
  };

  /**
   * The selected joint's range, as a wedge at the joint.
   *
   * The angles are measured from the bone's own rest direction, so the wedge
   * shows where the bone may swing to rather than where north is.
   */
  const arc = useMemo(() => {
    if (!selected) return null;
    const place = posed.get(selected.id);
    if (!place) return null;
    const angles = effectiveAngles(selected, selectedChain, options);
    if (angles.max - angles.min === 0) return null;

    const length = Math.max(6, Math.hypot(selected.offset.x, selected.offset.y) * 0.8);
    const rest = Math.atan2(selected.offset.y, selected.offset.x);
    const at = (degrees: number) => ({
      x: place.from.x + Math.cos(rest + (degrees * Math.PI) / 180) * length,
      y: place.from.y + Math.sin(rest + (degrees * Math.PI) / 180) * length,
    });
    const start = at(angles.min);
    const end = at(angles.max);
    const sweep = angles.max - angles.min;
    return {
      path: `M ${place.from.x} ${place.from.y} L ${start.x} ${start.y} A ${length} ${length} 0 ${
        Math.abs(sweep) > 180 ? 1 : 0
      } 1 ${end.x} ${end.y} Z`,
      angles,
    };
  }, [options, posed, selected, selectedChain]);

  const swapKind = (kind: RigKind) => {
    patch(changeRigKind(data, kind));
    setSelectedId(null);
  };

  /*
   * How thick a bone is drawn, before the stage's zoom.
   *
   * Everything on the skeleton is sized off this, so dividing it once inside the
   * stage keeps bones, joints and their hit targets the size they are at fit
   * however far in the stage is zoomed — which is what makes zooming in to aim
   * at a joint worth doing.
   */
  const baseStroke = Math.max(box.width, box.height) / 160;

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={async () => {
        await generateFlow(node.id);
      }}
      banner={
        problems.length > 0 ? (
          <div className="vt-sync-banner">
            <span>
              {problems.length} problem{problems.length === 1 ? '' : 's'} with this rig — see the list below the
              settings.
            </span>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Character type</h3>
          <Field
            label="Skeleton"
            tip="rig.kind"
            hint="The type is the structure: how many bones there are and how they connect. Everything else is editing limits."
          >
            <select
              value={data.kind}
              aria-label="Skeleton"
              onChange={(event) => swapKind(event.target.value as RigKind)}
            >
              {RIG_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {RIG_KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </Field>
          <div className="vt-hint">{rigTemplate(data.kind).note}</div>
          <dl className="vt-kv">
            <dt>Bones</dt>
            <dd>
              {summary.bones}
              {summary.chained > 0 ? ` · ${summary.chained} in ${summary.chains} chain(s)` : ''}
            </dd>
            <dt>Rest pose</dt>
            <dd>
              {summary.height} units tall, {summary.span} of bone
            </dd>
            <dt>Welded joints</dt>
            <dd>{summary.welded}</dd>
            <dt>Can change length</dt>
            <dd>{summary.stretchy}</dd>
          </dl>
          <div className="vt-hint">
            Swapping type keeps the limits of any bone that exists in both skeletons — a head stays the head you
            tuned. Everything else comes fresh from the new type.
          </div>
        </div>

        <div className="vt-section">
          <h3>The whole rig</h3>
          <label className="vt-row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={options.mirror}
              onChange={(event) => patch({ ...data, options: { ...options, mirror: event.target.checked } })}
            />
            <span>Mirror an edit onto the other side</span>
          </label>
          <div className="vt-hint" style={{ marginTop: 0 }}>
            A character with a loose left elbow and a tight right one is almost always a slip, and it is hard to
            see in a still pose.
          </div>
          <Slider
            range="rig.squashAndStretch"
            label="Squash and stretch"
            tip="rig.squashAndStretch"
            value={options.squashAndStretch}
            format={(value) => `×${value.toFixed(1)}`}
            onChange={(value) => patch({ ...data, options: { ...options, squashAndStretch: value } })}
            hint="Scales every bone's length range at once. 0 makes the whole rig rigid."
          />
          <Slider
            range="rig.looseness"
            label="Looseness"
            tip="rig.looseness"
            value={options.looseness}
            format={(value) => `×${value.toFixed(2)}`}
            onChange={(value) => patch({ ...data, options: { ...options, looseness: value } })}
            hint="Scales every angle range. Below 1 is a tighter, more controlled character."
          />
          <div className="vt-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="vt-btn is-small is-danger is-ghost"
              onClick={() => {
                patch({ ...emptyRigFlowData(data.kind), options });
                setSelectedId(null);
              }}
            >
              Reset every bone
            </button>
          </div>
        </div>

        {problems.length > 0 ? (
          <div className="vt-section">
            <h3>
              <span>Problems</span>
              <span className="vt-faint">{problems.length}</span>
            </h3>
            {problems.slice(0, 12).map((problem, index) => (
              <button
                key={`${problem.boneId ?? problem.chainId ?? 'rig'}-${index}`}
                type="button"
                className="vt-context-row"
                onClick={() => problem.boneId && setSelectedId(problem.boneId)}
              >
                <span className="vt-lexeme-word">{problem.boneId ?? problem.chainId ?? 'the rig'}</span>
                <span className="vt-faint">{problem.message}</span>
              </button>
            ))}
          </div>
        ) : null}
      </aside>

      <div className="vt-editor-main">
        {mode === 'preview' ? (
          <RigPreview
            data={data}
            selectedId={selectedId}
            onSelect={setSelectedId}
            tools={<ModeSwitch mode={mode} onChange={setMode} />}
          />
        ) : (
        <Stage
          zoomable
          title={selected ? selected.name : 'The skeleton'}
          tools={
            <>
              <span className="vt-faint" style={{ fontSize: 11 }}>
                {selected ? 'Drag a joint to move it' : 'Click a bone to edit its limits, drag a joint to move it'}
              </span>
              <label className="vt-row vt-faint" style={{ gap: 4, fontSize: 11 }} title="Dragging a joint moves its twin on the other side the matching way">
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={options.mirrorMoves}
                  aria-label="Move the matching joint on the other side too"
                  onChange={(event) => patch({ ...data, options: { ...options, mirrorMoves: event.target.checked } })}
                />
                Symmetric moves
              </label>
              {design ? (
                <button
                  type="button"
                  className={`vt-btn is-small${showReference ? ' is-active' : ''}`}
                  onClick={() => setShowReference(!showReference)}
                >
                  Reference
                </button>
              ) : null}
              <ModeSwitch mode={mode} onChange={setMode} />
            </>
          }
        >
          {({ scale }) => {
          const stroke = onScreen(baseStroke, scale);
          return (
          <div className="vt-rig-stage">
            {design && showReference ? (
              <img className="vt-rig-reference" src={api.artifactUrl(project.id, designPath)} alt="" />
            ) : null}
            <svg
              ref={svg}
              className={`vt-rig${dragging ? ' is-dragging' : ''}`}
              viewBox={`${view.minX} ${view.minY} ${view.width} ${view.height}`}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
              role="group"
              aria-label={`${RIG_KIND_LABEL[data.kind]} skeleton, ${summary.bones} bones`}
            >
              {arc ? <path className="vt-rig-arc" d={arc.path} /> : null}

              {data.bones.map((bone) => {
                const place = posed.get(bone.id);
                if (!place) return null;
                const isSelected = bone.id === selectedId;
                const isTwin = bone.id === twin;
                return (
                  <g key={bone.id}>
                    <line
                      className={[
                        'vt-rig-bone',
                        bone.chain ? 'is-chained' : '',
                        isSelected ? 'is-selected' : '',
                        isTwin ? 'is-twin' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      x1={place.from.x}
                      y1={place.from.y}
                      x2={place.to.x}
                      y2={place.to.y}
                      strokeWidth={stroke * (isSelected ? 3 : 2)}
                    />
                    {/* A wide transparent copy takes the clicks, so a thin bone is
                        still easy to hit. */}
                    <line
                      className="vt-rig-hit"
                      x1={place.from.x}
                      y1={place.from.y}
                      x2={place.to.x}
                      y2={place.to.y}
                      strokeWidth={stroke * 8}
                      onClick={() => setSelectedId(bone.id === selectedId ? null : bone.id)}
                    >
                      <title>{`${bone.name} — ${boneLength(bone).toFixed(1)} units`}</title>
                    </line>
                    <circle
                      className={`vt-rig-joint${isSelected ? ' is-selected' : ''}`}
                      cx={place.from.x}
                      cy={place.from.y}
                      r={stroke * (isSelected ? 3 : 2)}
                    />
                  </g>
                );
              })}

              {/* The joints to drag, over every bone: drawn with their own bones,
                  the next bone's click target — which starts at the same joint —
                  was on top of them and took the press. Every joint is some bone's
                  far end, so this is every joint and every tip. */}
              {data.bones.map((bone) => {
                const place = posed.get(bone.id);
                if (!place) return null;
                return (
                  <circle
                    key={`handle-${bone.id}`}
                    className={`vt-rig-handle${dragging === bone.id ? ' is-held' : ''}${
                      dragging && dragging !== bone.id && mirrorIdOf(dragging) === bone.id && options.mirrorMoves
                        ? ' is-twin'
                        : ''
                    }`}
                    cx={place.to.x}
                    cy={place.to.y}
                    r={stroke * 3.2}
                    strokeWidth={stroke * 0.8}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || event.shiftKey) return;
                      event.stopPropagation();
                      event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                      setHeldBox(box);
                      setDragging(bone.id);
                      setSelectedId(bone.id);
                    }}
                  >
                    <title>{`Drag to move the end of ${bone.name}`}</title>
                  </circle>
                );
              })}
            </svg>
          </div>
          );
          }}
        </Stage>
        )}

        {selected ? (
          <div className="vt-section">
            <h3>
              <span>{selected.name}</span>
              <span className="vt-faint">
                {boneLength(selected).toFixed(1)} units
                {selected.parent ? ` · hangs off ${boneById(data, selected.parent)?.name ?? selected.parent}` : ' · the root'}
                {twin ? ' · mirrored' : ''}
              </span>
            </h3>

            {selectedChain ? (
              <>
                <div className="vt-hint" style={{ marginTop: 0 }}>
                  This bone is part of the <strong>{selectedChain.name}</strong> chain — {selectedChain.bones.length}{' '}
                  bones moving as one behaviour. Its angles come from the chain's floppiness unless you give it
                  its own below.
                </div>
                <Slider
                  range="rig.floppiness"
                  label="Floppiness"
                  tip="rig.floppiness"
                  value={selectedChain.floppiness}
                  onChange={(value) => patch(setChain(data, selectedChain.id, { floppiness: value }))}
                  hint="One number for the whole chain. 0 welds it solid; 1 is as loose as the span allows."
                />
                <Slider
                  range="rig.taper"
                  label="Taper"
                  tip="rig.taper"
                  value={selectedChain.taper}
                  onChange={(value) => patch(setChain(data, selectedChain.id, { taper: value }))}
                  hint="How much of that floppiness the base gives up. The tip always keeps all of it, which is what makes a tentacle read as a tentacle."
                />
                <Slider
                  range="rig.span"
                  label="Span at full floppiness"
                  tip="rig.span"
                  value={selectedChain.span}
                  format={(value) => `±${value.toFixed(0)}°`}
                  onChange={(value) => patch(setChain(data, selectedChain.id, { span: value }))}
                />
                <div className="vt-row" style={{ marginTop: 6 }}>
                  <span className="vt-faint">
                    This joint: {arc ? `${arc.angles.min}° to ${arc.angles.max}°` : 'welded'}
                    {selected.angles ? ' — its own' : ` — from the ${selectedChain.name} chain`}
                  </span>
                  <span className="vt-spacer" />
                  {selected.angles ? (
                    <button
                      type="button"
                      className="vt-btn is-small is-ghost"
                      onClick={() => patch(setBoneLimits(data, selected.id, { angles: null }))}
                    >
                      Follow the chain again
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="vt-btn is-small"
                      onClick={() =>
                        patch(
                          setBoneLimits(data, selected.id, {
                            angles: effectiveAngles(selected, selectedChain, options),
                          }),
                        )
                      }
                    >
                      Give this joint its own angles
                    </button>
                  )}
                </div>
              </>
            ) : null}

            {selected.angles ? (
              <>
                <Slider
                  range="rig.angleMin"
                  label="Turns anticlockwise to"
                  tip="rig.angleRange"
                  value={selected.angles.min}
                  format={(value) => `${value.toFixed(0)}°`}
                  onChange={(value) => patch(setBoneLimits(data, selected.id, { angles: { min: value } }))}
                  hint="A hard stop, measured from the rest pose. Both ends at 0 welds the joint."
                />
                <Slider
                  range="rig.angleMax"
                  label="Turns clockwise to"
                  tip="rig.angleRange"
                  value={selected.angles.max}
                  format={(value) => `${value.toFixed(0)}°`}
                  onChange={(value) => patch(setBoneLimits(data, selected.id, { angles: { max: value } }))}
                />
                <Slider
                  range="rig.angleStiffness"
                  label="Angle stiffness"
                  tip="rig.angleStiffness"
                  value={selected.angles.stiffness}
                  onChange={(value) =>
                    patch(setBoneLimits(data, selected.id, { angles: { stiffness: value } }))
                  }
                  hint="Not a stop but a cost: how hard the joint pulls back to rest. This is most of the difference between a person and a puppet."
                />
              </>
            ) : null}

            <Slider
              range="rig.stretchMin"
              label="Squashes to"
              tip="rig.stretchRange"
              value={selected.stretch.min}
              format={(value) => `×${value.toFixed(2)}`}
              onChange={(value) => patch(setBoneLimits(data, selected.id, { stretch: { min: value } }))}
              hint="A multiple of the bone's rest length. 1 cannot shorten at all."
            />
            <Slider
              range="rig.stretchMax"
              label="Stretches to"
              tip="rig.stretchRange"
              value={selected.stretch.max}
              format={(value) => `×${value.toFixed(2)}`}
              onChange={(value) => patch(setBoneLimits(data, selected.id, { stretch: { max: value } }))}
            />
            <Slider
              range="rig.stretchStiffness"
              label="Stretch stiffness"
              tip="rig.stretchStiffness"
              value={selected.stretch.stiffness}
              onChange={(value) => patch(setBoneLimits(data, selected.id, { stretch: { stiffness: value } }))}
            />

            <div className="vt-row" style={{ marginTop: 8 }}>
              <span className="vt-faint">
                With the rig's own multipliers: ×{effectiveStretch(selected, options).min} to ×
                {effectiveStretch(selected, options).max}
              </span>
              <span className="vt-spacer" />
              <button
                type="button"
                className="vt-btn is-small is-ghost"
                onClick={() => patch(resetBone(data, selected.id))}
              >
                Reset this bone
              </button>
            </div>
          </div>
        ) : (
          <div className="vt-hint">
            Chained bones are drawn in a lighter color — those read their angles off their chain rather than
            one at a time. Selecting a joint draws the wedge it can turn through.
          </div>
        )}
      </div>
    </EditorShell>
  );
}

/** Editing the skeleton, or watching it move. */
function ModeSwitch({
  mode,
  onChange,
}: {
  mode: 'edit' | 'preview';
  onChange(mode: 'edit' | 'preview'): void;
}): JSX.Element {
  return (
    <span className="vt-segmented" role="group" aria-label="Mode">
      <button
        type="button"
        className={`vt-btn is-small${mode === 'edit' ? ' is-active' : ''}`}
        aria-pressed={mode === 'edit'}
        onClick={() => onChange('edit')}
      >
        Edit
      </button>
      <button
        type="button"
        className={`vt-btn is-small${mode === 'preview' ? ' is-active' : ''}`}
        aria-pressed={mode === 'preview'}
        onClick={() => onChange('preview')}
      >
        ▶ Preview
      </button>
    </span>
  );
}
