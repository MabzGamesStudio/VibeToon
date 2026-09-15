import { useCallback, useRef, useState } from 'react';
import {
  getFlowKind,
  isTextualArtifact,
  keyImagePort,
  newPlate,
  plateFileName,
  plateSetPort,
  type DesignFlowData,
  type FlowNode,
  type Project,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { EditorShell } from './EditorShell';
import { SketchPad } from './SketchPad';
import { rasterizeSketch } from './sketch';

/** Design plates are taller than a film frame; a character sheet is a portrait. */
const PLATE_BOX = { width: 720, height: 560 };
const EXPORT_HEIGHT = 1080;

export function DesignEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, patchNode, generateFlow, uploadOutput, notify } = useStudio();
  const def = getFlowKind(node.kind);
  const data = node.data as DesignFlowData;
  const [activePlateId, setActivePlateId] = useState<string | null>(data.plates[0]?.id ?? null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const pendingPort = useRef<string | null>(null);

  const keyPort = def ? keyImagePort(def) : undefined;
  const setPort = def ? plateSetPort(def) : undefined;

  const patch = useCallback(
    (change: Partial<DesignFlowData>) => setFlowData(node.id, { ...data, ...change }),
    [data, node.id, setFlowData],
  );

  const patchPlate = useCallback(
    (id: string, change: Partial<DesignFlowData['plates'][number]>) => {
      patch({ plates: data.plates.map((plate) => (plate.id === id ? { ...plate, ...change } : plate)) });
    },
    [data.plates, patch],
  );

  /**
   * Generating a design sends the drawings along with the run, rasterised from
   * the same strokes: the first plate becomes the key image, every drawn plate
   * becomes a page of the model sheet.
   */
  const generateWithPlates = useCallback(async () => {
    const attachments: Array<{ name: string; data: string }> = [];
    data.plates.forEach((plate, index) => {
      if (!plate.sketch) return;
      const png = rasterizeSketch(plate.sketch, EXPORT_HEIGHT);
      if (!png) return;
      if (index === 0 && keyPort) attachments.push({ name: `${keyPort.id}.png`, data: png });
      if (setPort) {
        attachments.push({ name: `${setPort.id}/${plateFileName(index, plate.label)}`, data: png });
      }
    });

    if (attachments.length === 0) notify('warn', 'Nothing is drawn yet — the run will write the spec only.');
    await generateFlow(node.id, attachments);
  }, [data.plates, generateFlow, keyPort, node.id, notify, setPort]);

  const pickFile = (portId: string) => {
    pendingPort.current = portId;
    fileInput.current?.click();
  };

  const onFile = (file: File | undefined) => {
    const portId = pendingPort.current;
    pendingPort.current = null;
    if (!file || !portId) return;
    const reader = new FileReader();
    reader.onload = () => void uploadOutput(node.id, portId, file.name, String(reader.result));
    reader.readAsDataURL(file);
  };

  const textPorts = (def?.outputs ?? []).filter((port) => isTextualArtifact(port.kinds[0]!));

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={generateWithPlates}
      actions={
        <button
          type="button"
          className="vt-btn is-small"
          onClick={() => {
            const plate = newPlate(`Plate ${data.plates.length + 1}`);
            patch({ plates: [...data.plates, plate] });
            setActivePlateId(plate.id);
          }}
        >
          + Plate
        </button>
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>The written spec</h3>
          <p className="vt-muted" style={{ fontSize: 11 }}>
            Becomes {textPorts.map((port) => port.fileName).join(', ') || 'the spec'} when this flow runs,
            alongside the drawings.
          </p>
        </div>
        {(def?.fields ?? []).map((field) => (
          <Field key={field.id} label={field.label} hint={field.hint}>
            {field.input === 'line' ? (
              <input
                value={data.fields[field.id] ?? ''}
                onChange={(event) => patch({ fields: { ...data.fields, [field.id]: event.target.value } })}
              />
            ) : (
              <textarea
                rows={field.input === 'list' ? 4 : 3}
                value={data.fields[field.id] ?? ''}
                placeholder={field.input === 'list' ? 'one per line' : ''}
                onChange={(event) => patch({ fields: { ...data.fields, [field.id]: event.target.value } })}
              />
            )}
          </Field>
        ))}
        <Field label="Flow notes" hint="Anything the fields above do not cover.">
          <textarea
            rows={3}
            value={node.notes}
            onChange={(event) => patchNode(node.id, { notes: event.target.value })}
          />
        </Field>

        <div className="vt-section">
          <h3>Bring a file in instead</h3>
          <p className="vt-muted" style={{ fontSize: 11 }}>
            Drawn it somewhere else? Upload it onto the port and it replaces what this editor would write.
          </p>
          {(def?.outputs ?? [])
            .filter((port) => !isTextualArtifact(port.kinds[0]!))
            .map((port) => {
              const artifact = node.outputs.find((ref) => ref.port === port.id);
              return (
                <div className="vt-port-row" key={port.id}>
                  <span className="vt-port-name">{port.label}</span>
                  <span className="vt-spacer" />
                  {artifact ? <span className="vt-pill is-ready">{artifact.fileName}</span> : null}
                  <button type="button" className="vt-btn is-small" onClick={() => pickFile(port.id)}>
                    Upload
                  </button>
                </div>
              );
            })}
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={(event) => {
              onFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
      </aside>

      <div className="vt-editor-main">
        <div className="vt-row" style={{ marginBottom: 10 }}>
          <strong>Plates</strong>
          <span className="vt-faint">
            {data.plates.filter((plate) => plate.sketch && plate.sketch.strokes.length > 0).length} of{' '}
            {data.plates.length} drawn
            {keyPort ? ` · the first plate is ${keyPort.fileName}` : ''}
          </span>
        </div>

        {data.plates.length === 0 ? (
          <div className="vt-empty">No plates yet. Add one to start drawing.</div>
        ) : null}

        <div className="vt-plates">
          {data.plates.map((plate, index) => (
            <article
              key={plate.id}
              className={`vt-plate${index === 0 ? ' is-key' : ''}`}
              onFocus={() => setActivePlateId(plate.id)}
            >
              <header>
                <input
                  value={plate.label}
                  aria-label={`Plate ${index + 1} name`}
                  onChange={(event) => patchPlate(plate.id, { label: event.target.value })}
                />
                {index === 0 && keyPort ? <span className="vt-pill is-ready">key</span> : null}
                <span className="vt-spacer" />
                <button
                  type="button"
                  className="vt-btn is-ghost is-small"
                  title="Move earlier"
                  disabled={index === 0}
                  onClick={() => {
                    const plates = [...data.plates];
                    const [moved] = plates.splice(index, 1);
                    if (moved) plates.splice(index - 1, 0, moved);
                    patch({ plates });
                  }}
                >
                  ←
                </button>
                <button
                  type="button"
                  className="vt-btn is-ghost is-small is-danger"
                  title="Remove this plate"
                  onClick={() => {
                    if (plate.sketch && !window.confirm(`Remove “${plate.label}” and its drawing?`)) return;
                    patch({ plates: data.plates.filter((candidate) => candidate.id !== plate.id) });
                  }}
                >
                  ×
                </button>
              </header>

              <SketchPad
                sketch={plate.sketch}
                box={PLATE_BOX}
                showTools={activePlateId === plate.id}
                onActivate={() => setActivePlateId(plate.id)}
                label={`${plate.label} — draw here`}
                onChange={(sketch) => patchPlate(plate.id, { sketch })}
              />

              <input
                className="vt-plate-note"
                value={plate.note}
                placeholder="note on this plate"
                aria-label={`Note for ${plate.label}`}
                onChange={(event) => patchPlate(plate.id, { note: event.target.value })}
              />
            </article>
          ))}
        </div>
      </div>
    </EditorShell>
  );
}
