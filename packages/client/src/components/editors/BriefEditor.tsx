import { useCallback, useRef } from 'react';
import {
  getFlowKind,
  isTextualArtifact,
  type BriefFlowData,
  type FlowNode,
  type Project,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { EditorShell } from './EditorShell';

/**
 * The editor for every flow kind that does not have a bespoke one yet. It is
 * not a placeholder: the fields come from the flow's own definition, the text
 * becomes a real markdown brief on generate, and image or audio ports can be
 * filled by uploading a file made in any other tool.
 */
export function BriefEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, patchNode, uploadOutput } = useStudio();
  const def = getFlowKind(node.kind);
  const data = node.data as BriefFlowData;
  const fileInput = useRef<HTMLInputElement | null>(null);
  const pendingPort = useRef<string | null>(null);

  const setField = useCallback(
    (fieldId: string, value: string) => {
      setFlowData(node.id, { ...data, fields: { ...data.fields, [fieldId]: value } });
    },
    [data, node.id, setFlowData],
  );

  const pickFile = (portId: string) => {
    pendingPort.current = portId;
    fileInput.current?.click();
  };

  const onFile = (file: File | undefined) => {
    const portId = pendingPort.current;
    pendingPort.current = null;
    if (!file || !portId) return;
    const reader = new FileReader();
    reader.onload = () => {
      void uploadOutput(node.id, portId, file.name, String(reader.result));
    };
    reader.readAsDataURL(file);
  };

  const uploadable = (def?.outputs ?? []).filter((port) => !isTextualArtifact(port.kinds[0]!));

  return (
    <EditorShell project={project} node={node}>
      <div className="vt-editor-main">
        <div className="vt-brief">
          <p className="vt-muted" style={{ maxWidth: '68ch' }}>
            {def?.summary} On generate, these fields become{' '}
            {(def?.outputs ?? [])
              .filter((port) => isTextualArtifact(port.kinds[0]!))
              .map((port) => port.fileName)
              .join(', ') || 'no text files'}
            , together with everything arriving over this flow's connections.
          </p>

          {(def?.fields ?? []).map((field) => (
            <div className={`vt-brief-field is-${field.input}`} key={field.id}>
              <Field label={field.label} hint={field.hint}>
                {field.input === 'line' ? (
                  <input
                    value={data.fields[field.id] ?? ''}
                    onChange={(event) => setField(field.id, event.target.value)}
                  />
                ) : (
                  <textarea
                    rows={field.input === 'list' ? 5 : 4}
                    value={data.fields[field.id] ?? ''}
                    placeholder={field.input === 'list' ? 'one per line' : ''}
                    onChange={(event) => setField(field.id, event.target.value)}
                  />
                )}
              </Field>
            </div>
          ))}

          {(def?.fields ?? []).length === 0 ? (
            <div className="vt-empty">This flow kind has no fields; use the notes below.</div>
          ) : null}

          <Field label="Flow notes" hint="Anything the fields above do not cover.">
            <textarea
              rows={4}
              value={node.notes}
              onChange={(event) => patchNode(node.id, { notes: event.target.value })}
            />
          </Field>

          {uploadable.length > 0 ? (
            <div className="vt-section">
              <h3>Files to bring in yourself</h3>
              <p className="vt-muted">
                These outputs are pictures or sound. Make them in whatever tool you like, drop them on the
                port, and every flow downstream sees a real file.
              </p>
              {uploadable.map((port) => {
                const artifact = node.outputs.find((ref) => ref.port === port.id);
                return (
                  <div className="vt-port-row" key={port.id}>
                    <span className="vt-port-name">{port.label}</span>
                    <span className="vt-port-file">{port.fileName}</span>
                    <span className="vt-spacer" />
                    {artifact ? <span className="vt-pill is-ready">{artifact.fileName}</span> : null}
                    <button type="button" className="vt-btn is-small" onClick={() => pickFile(port.id)}>
                      {artifact ? 'Replace' : 'Upload'}
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
          ) : null}
        </div>
      </div>
    </EditorShell>
  );
}
