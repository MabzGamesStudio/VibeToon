import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_VECTOR_BRUSH,
  FACE_FEATURES,
  FACE_FEATURE_COLOR,
  FACE_FEATURE_LABEL,
  assignShapes,
  composeFeature,
  composeHead,
  emptyFaceFlowData,
  featureShapes,
  headById,
  headView,
  inputsForPort,
  makeHead,
  readRigParts,
  readVectorImage,
  reidentify,
  setFeature,
  setHeadImage,
  settingOf,
  shapePath,
  summariseFace,
  swapChoices,
  type FaceFeature,
  type FaceFlowData,
  type FaceHead,
  type FlowNode,
  type Project,
  type VectorImage,
  type VectorShape,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { InfoTip } from '../common/InfoTip';
import { onScreen } from '../common/handles';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';
import { useVectorWorkbench } from './vector/useVectorWorkbench';

type Mode = 'features' | 'result' | 'edit';

/** A part of an upstream file that could be taken in as a head. */
interface Candidate {
  id: string;
  name: string;
  image: VectorImage;
  source: FaceHead['source'];
}

const HEAD_NAME = /head|face|skull/i;

/**
 * Heads, taken apart into the features of a face.
 *
 * The features are found when a head is taken in; here they are checked and put
 * right (click a shape to give it to a feature), and then each can be hidden,
 * looked at alone, nudged, or swapped for the same feature of another head.
 */
export function FaceFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'face' ? (node.data as FaceFlowData) : emptyFaceFlowData();
  const patch = useCallback((over: Partial<FaceFlowData> | FaceFlowData) => setFlowData(node.id, { ...data, ...over }), [data, node.id, setFlowData]);

  const inputs = inputsForPort(project, node.id, 'heads').filter((input) => input.artifact);
  const [mode, setMode] = useState<Mode>('features');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [opened, setOpened] = useState<FaceFeature | null>(null);

  const head = headById(data, data.current) ?? data.heads[0];

  /* ---------------- taking heads in ---------------- */

  const takeIn = useCallback(async () => {
    const found: Candidate[] = [];
    for (const input of inputs) {
      try {
        const json = await (await fetch(api.artifactUrl(project.id, input.artifact!.path))).json();
        const parts = readRigParts(json);
        if (parts) {
          for (const part of parts.parts) {
            found.push({ id: `${input.sourceNode.id}:${part.id}`, name: part.name, image: part.image, source: { node: input.sourceNode.id, part: part.id, hash: input.artifact!.hash } });
          }
          continue;
        }
        const image = readVectorImage(json);
        if (image.shapes.length > 0) found.push({ id: input.sourceNode.id, name: input.sourceNode.name, image, source: { node: input.sourceNode.id, part: null, hash: input.artifact!.hash } });
      } catch (error) {
        notify('error', `Could not read ${input.sourceNode.name}: ${(error as Error).message}`);
      }
    }
    setCandidates(found);
    // A parts file gives its head parts; a drawing is a head.
    const chosen = found.filter((one) => one.source.part === null || HEAD_NAME.test(one.name) || HEAD_NAME.test(one.source.part ?? ''));
    if (chosen.length === 0) {
      notify('warn', found.length > 0 ? 'No part is called a head. Pick the parts to use under “Add a part as a head”.' : 'Nothing wired in has shapes to read.');
      return;
    }
    // A head taken in again keeps what was set for its features.
    const heads = chosen.map((one) => {
      const was = data.heads.find((head) => head.id === one.id);
      const fresh = makeHead(one.id, one.name, one.image, one.source);
      return was ? { ...fresh, settings: was.settings } : fresh;
    });
    const kept = data.heads.filter((head) => !heads.some((one) => one.id === head.id) && !found.some((one) => one.id === head.id));
    patch({ heads: [...heads, ...kept], current: heads[0]!.id, selected: [], edits: data.edits + 1 });
    notify('success', `Took in ${heads.length} head(s).`);
  }, [data, inputs, notify, patch, project.id]);

  const addCandidate = (id: string) => {
    const one = candidates.find((candidate) => candidate.id === id);
    if (!one || data.heads.some((head) => head.id === id)) return;
    patch({ heads: [...data.heads, makeHead(one.id, one.name, one.image, one.source)], current: one.id, edits: data.edits + 1 });
  };

  /* ---------------- what is drawn ---------------- */

  const result = useMemo(() => (head ? composeHead(data, head) : null), [data, head]);
  const view = head ? headView(head) : { x: 0, y: 0, width: 100, height: 100 };
  const featureOf = (shape: VectorShape): FaceFeature | undefined => head?.assign[shape.id];

  /** In the result, a shape's feature: its own, or the one it was swapped in for. */
  const resultFeature = useMemo(() => {
    const map = new Map<string, FaceFeature>();
    if (!head) return map;
    for (const feature of FACE_FEATURES) for (const shape of composeFeature(data, head, feature)) map.set(shape.id, feature);
    return map;
  }, [data, head]);

  const dim = (feature: FaceFeature | undefined) => (data.isolate && feature !== data.isolate ? 0.1 : 1);

  const bench = useVectorWorkbench({
    image: head?.image ?? { width: 100, height: 100, shapes: [] },
    selected: data.selected,
    brush: DEFAULT_VECTOR_BRUSH,
    onEdit: (next, selected) => head && patch({ ...setHeadImage(data, head.id, next), selected }),
    onLive: (next) => head && setFlowData(node.id, { ...data, heads: data.heads.map((one) => (one.id === head.id ? { ...one, image: next } : one)) }),
    onSettle: () => patch({ edits: data.edits + 1 }),
    onSelect: (selected) => patch({ selected }),
    onBrush: () => undefined,
    view,
    decorate: (shape) => {
      const feature = featureOf(shape);
      return { ...(feature ? { outline: FACE_FEATURE_COLOR[feature] } : {}), opacity: dim(feature) };
    },
    title: head ? `${head.name} — edit shapes` : 'Edit shapes',
    empty: 'No head taken in yet.',
    keys: mode === 'edit',
  });

  const onShapeClick = (shape: VectorShape) => {
    if (!head) return;
    if (data.paint !== null) {
      patch(assignShapes(data, head.id, [shape.id], data.paint === 'none' ? null : data.paint));
      return;
    }
    patch({ selected: [shape.id] });
  };

  const drawShapes = (shapes: readonly VectorShape[], featureFor: (shape: VectorShape) => FaceFeature | undefined, clickable: boolean, scale: number) => (
    <>
      {shapes.map((shape) => {
        const feature = featureFor(shape);
        const props = {
          d: shapePath(shape),
          opacity: dim(feature),
          ...(clickable ? { onClick: () => onShapeClick(shape), className: `vt-face-shape${data.selected.includes(shape.id) ? ' is-selected' : ''}` } : {}),
        };
        return shape.kind === 'polygon' ? (
          <path key={shape.id} {...props} fill={shape.color} fillRule="evenodd" />
        ) : (
          <path key={shape.id} {...props} fill="none" stroke={shape.color} strokeWidth={shape.width} strokeLinecap="round" />
        );
      })}
      {mode === 'features'
        ? shapes.map((shape) => {
            const feature = featureFor(shape);
            return feature ? (
              <path key={`o:${shape.id}`} d={shapePath(shape)} fill="none" stroke={FACE_FEATURE_COLOR[feature]} strokeWidth={onScreen(1.6, scale)} opacity={dim(feature)} className="vt-shape-tag" />
            ) : null;
          })
        : null}
    </>
  );

  const selectedShape = head && data.selected.length === 1 ? head.image.shapes.find((shape) => shape.id === data.selected[0]) : undefined;

  /* ---------------- the page ---------------- */

  const blocked = inputs.length === 0 ? 'Wire a Rig Parts flow, or a vector drawing of a head, into the Heads input.' : null;

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
        ) : data.heads.length === 0 ? (
          <div className="vt-sync-banner">
            <span>No heads taken in yet.</span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take them in
            </button>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Heads ({data.heads.length})</h3>
          <div className="vt-object-list">
            {data.heads.map((one) => (
              <button key={one.id} type="button" className={`vt-object${head?.id === one.id ? ' is-selected' : ''}`} onClick={() => patch({ current: one.id, selected: [] })}>
                <strong>{one.name}</strong>
                <span className="vt-faint">{FACE_FEATURES.filter((feature) => featureShapes(one, feature).length > 0).length} features</span>
              </button>
            ))}
          </div>
          <div className="vt-row" style={{ gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
            <button type="button" className="vt-btn is-small" disabled={inputs.length === 0} onClick={() => void takeIn()}>
              {data.heads.length > 0 ? 'Take them in again' : 'Take them in'}
            </button>
            {head ? (
              <button type="button" className="vt-btn is-small" title="Forget what was given by hand and find the features afresh" onClick={() => patch(reidentify(data, head.id))}>
                Find the features again
              </button>
            ) : null}
          </div>
          {candidates.filter((one) => !data.heads.some((head) => head.id === one.id)).length > 0 ? (
            <select value="" aria-label="Add a part as a head" style={{ marginTop: 6 }} onChange={(event) => addCandidate(event.target.value)}>
              <option value="">Add a part as a head…</option>
              {candidates
                .filter((one) => !data.heads.some((head) => head.id === one.id))
                .map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
            </select>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>View</h3>
          <div className="vt-facet-values" role="radiogroup" aria-label="View">
            {(
              [
                ['features', 'Features', 'Each shape outlined in its feature’s color; click one to give it to a feature.'],
                ['result', 'Result', 'The face as it comes out: hidden features left out, swaps fitted in, nudges applied.'],
                ['edit', 'Edit shapes', 'The head’s own shapes, with every tool of the Vector Editor.'],
              ] as const
            ).map(([value, label, hint]) => (
              <button key={value} type="button" title={hint} className={`vt-chip${mode === value ? ' is-on' : ''}`} aria-pressed={mode === value} onClick={() => setMode(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {mode === 'features' && head ? (
          <div className="vt-section">
            <h3>
              Give a shape to
              <InfoTip tip="face.identify" label="How features are found" />
            </h3>
            <div className="vt-facet-values">
              <button type="button" className={`vt-chip${data.paint === null ? ' is-on' : ''}`} onClick={() => patch({ paint: null })} title="Clicking a shape selects it">
                Just select
              </button>
              {FACE_FEATURES.map((feature) => (
                <button key={feature} type="button" className={`vt-chip vt-face-chip${data.paint === feature ? ' is-on' : ''}`} style={{ borderColor: FACE_FEATURE_COLOR[feature] }} onClick={() => patch({ paint: feature })}>
                  {FACE_FEATURE_LABEL[feature]}
                </button>
              ))}
              <button type="button" className={`vt-chip${data.paint === 'none' ? ' is-on' : ''}`} onClick={() => patch({ paint: 'none' })}>
                None
              </button>
            </div>
            <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
              {data.paint === null
                ? selectedShape
                  ? `Selected: ${featureOf(selectedShape) ? FACE_FEATURE_LABEL[featureOf(selectedShape)!] : 'none of the features'}. Pick a feature above, then click shapes to give them to it.`
                  : 'Pick a feature, then click shapes to give them to it.'
                : `Click shapes to give them to ${data.paint === 'none' ? 'no feature' : FACE_FEATURE_LABEL[data.paint]}.`}
            </p>
          </div>
        ) : null}

        {mode === 'edit' ? bench.toolPanel : null}
        {mode === 'edit' ? bench.selectionPanel : null}

        {head ? (
          <div className="vt-section">
            <h3>Features</h3>
            <div className="vt-face-list">
              {FACE_FEATURES.map((feature) => {
                const setting = settingOf(head, feature);
                const count = featureShapes(head, feature).length;
                const choices = swapChoices(data, head.id, feature);
                return (
                  <div key={feature} className={`vt-face-row${opened === feature ? ' is-open' : ''}${setting.hidden ? ' is-hidden' : ''}`}>
                    <div className="vt-face-row-head">
                      <button type="button" className="vt-face-name" onClick={() => setOpened(opened === feature ? null : feature)} title="Nudge it">
                        <span className="vt-object-dot" style={{ background: FACE_FEATURE_COLOR[feature] }} />
                        {FACE_FEATURE_LABEL[feature]}
                        <span className="vt-faint">{setting.swap ? 'swapped' : count === 0 ? 'none found' : `${count}`}</span>
                      </button>
                      <button type="button" className={`vt-btn is-small${setting.hidden ? ' is-active' : ''}`} aria-pressed={Boolean(setting.hidden)} title={setting.hidden ? 'Put it back' : 'Leave it out of the face'} onClick={() => patch(setFeature(data, head.id, feature, { hidden: !setting.hidden }))}>
                        {setting.hidden ? 'Hidden' : 'Hide'}
                      </button>
                      <button type="button" className={`vt-btn is-small${data.isolate === feature ? ' is-active' : ''}`} aria-pressed={data.isolate === feature} title="Show only this" onClick={() => patch({ isolate: data.isolate === feature ? null : feature })}>
                        Alone
                      </button>
                    </div>
                    {choices.length > 0 || setting.swap ? (
                      <label className="vt-row vt-face-swap" style={{ gap: 6 }}>
                        <span className="vt-faint">Swap</span>
                        <select
                          value={setting.swap ? `${setting.swap.head}|${setting.swap.feature}` : ''}
                          aria-label={`Swap ${FACE_FEATURE_LABEL[feature]}`}
                          onChange={(event) => {
                            const [otherHead, otherFeature] = event.target.value.split('|');
                            patch(setFeature(data, head.id, feature, { swap: otherHead ? { head: otherHead, feature: otherFeature as FaceFeature } : null }));
                          }}
                        >
                          <option value="">its own</option>
                          {choices.map((choice) => (
                            <option key={`${choice.head}|${choice.feature}`} value={`${choice.head}|${choice.feature}`}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                        <InfoTip tip="face.swap" label="Swapping" />
                      </label>
                    ) : null}
                    {opened === feature ? (
                      <div className="vt-face-nudge">
                        <Slider range="face.offsetX" label="Across" value={setting.dx} format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)} px`} onChange={(dx) => patch(setFeature(data, head.id, feature, { dx }))} />
                        <Slider range="face.offsetY" label="Down" value={setting.dy} format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)} px`} onChange={(dy) => patch(setFeature(data, head.id, feature, { dy }))} />
                        <Slider range="face.scale" label="Size" value={setting.scale} format={(value) => `×${value.toFixed(2)}`} onChange={(scale) => patch(setFeature(data, head.id, feature, { scale }))} />
                        <button type="button" className="vt-btn is-small" onClick={() => patch(setFeature(data, head.id, feature, { dx: 0, dy: 0, scale: 1 }))}>
                          Back where it was
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </aside>

      <div className="vt-editor-main">
        {mode === 'edit' ? (
          bench.stage
        ) : (
          <Stage
            zoomable
            title={head ? `${head.name} — ${mode === 'result' ? 'the result' : 'its features'}` : 'The face'}
            tools={
              data.isolate ? (
                <button type="button" className="vt-btn is-small" onClick={() => patch({ isolate: null })}>
                  Show all ({FACE_FEATURE_LABEL[data.isolate]} alone)
                </button>
              ) : undefined
            }
          >
            {({ scale }) => (
              <div className="vt-vector-stage">
                {head && result ? (
                  <div className="vt-vector-frame" style={{ aspectRatio: `${view.width} / ${view.height}` }}>
                    <svg className="vt-vector-svg" viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} preserveAspectRatio="xMidYMid meet">
                      {mode === 'features'
                        ? drawShapes(head.image.shapes, featureOf, true, scale)
                        : drawShapes(result.shapes, (shape) => resultFeature.get(shape.id), false, scale)}
                    </svg>
                  </div>
                ) : (
                  <div className="vt-empty">{blocked ?? 'No head taken in yet.'}</div>
                )}
              </div>
            )}
          </Stage>
        )}
        <div className="vt-face-legend">
          {FACE_FEATURES.map((feature) => (
            <span key={feature} className="vt-face-legend-item">
              <span className="vt-object-dot" style={{ background: FACE_FEATURE_COLOR[feature] }} />
              {FACE_FEATURE_LABEL[feature]}
            </span>
          ))}
        </div>
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summariseFace(data)}
        </p>
      </div>
    </EditorShell>
  );
}
