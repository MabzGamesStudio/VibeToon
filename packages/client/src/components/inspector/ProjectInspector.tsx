import { flowStatus, staleNodes, type Project } from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';

export function ProjectInspector({ project }: { project: Project }): JSX.Element {
  const { update, select, focusFlow, generateAll, busyFlows, registry } = useStudio();
  const stale = staleNodes(project);

  const setSetting = <K extends keyof Project['settings']>(key: K, value: Project['settings'][K]) => {
    update((draft) => {
      draft.settings[key] = value;
    });
  };

  return (
    <>
      <div className="vt-section">
        <Field label="Project name">
          <input
            value={project.name}
            onChange={(event) =>
              update((draft) => {
                draft.name = event.target.value;
              })
            }
          />
        </Field>
        <Field label="Style note" hint="Prepended to every flow's guidance when it generates.">
          <textarea
            rows={3}
            value={project.settings.styleNote}
            onChange={(event) => setSetting('styleNote', event.target.value)}
          />
        </Field>
      </div>

      <div className="vt-section">
        <h3>Frame</h3>
        <div className="vt-row" style={{ gap: 8 }}>
          <Field label="FPS">
            <input
              type="number"
              min={1}
              max={60}
              value={project.settings.fps}
              onChange={(event) => setSetting('fps', Number(event.target.value) || 24)}
            />
          </Field>
          <Field label="Width">
            <input
              type="number"
              min={160}
              step={16}
              value={project.settings.width}
              onChange={(event) => setSetting('width', Number(event.target.value) || 1920)}
            />
          </Field>
          <Field label="Height">
            <input
              type="number"
              min={120}
              step={16}
              value={project.settings.height}
              onChange={(event) => setSetting('height', Number(event.target.value) || 1080)}
            />
          </Field>
        </div>
        <Field label="Default shot length (s)" hint="Used when a beat or panel has no duration of its own.">
          <input
            type="number"
            min={0.2}
            step={0.1}
            value={project.settings.defaultShotSeconds}
            onChange={(event) => setSetting('defaultShotSeconds', Number(event.target.value) || 2)}
          />
        </Field>
        <div className="vt-hint">
          Video render: {registry?.ffmpeg ? 'ffmpeg found on the server' : 'no ffmpeg — timelines and the in-browser playblast only'}.
        </div>
      </div>

      <div className="vt-section">
        <h3>
          <span>Needs generating</span>
          <button
            type="button"
            className="vt-btn is-small"
            disabled={stale.length === 0 || busyFlows.length > 0}
            onClick={() => void generateAll()}
          >
            Run {stale.length > 0 ? stale.length : ''}
          </button>
        </h3>
        {stale.length === 0 ? (
          <div className="vt-empty">Everything is up to date.</div>
        ) : (
          stale.map((node) => (
            <div className="vt-port-row" key={node.id}>
              <button
                type="button"
                className="vt-btn is-ghost is-small"
                onClick={() => {
                  select({ type: 'node', id: node.id });
                  focusFlow(null);
                }}
              >
                {node.name}
              </button>
              <span className="vt-spacer" />
              <span className={`vt-pill is-${flowStatus(project, node)}`}>{flowStatus(project, node)}</span>
            </div>
          ))
        )}
      </div>

      <div className="vt-section">
        <h3>Project</h3>
        <dl className="vt-kv">
          <dt>Flows</dt>
          <dd>{project.nodes.length}</dd>
          <dt>Connections</dt>
          <dd>{project.connections.length}</dd>
          <dt>Revision</dt>
          <dd>{project.revision}</dd>
          <dt>Folder</dt>
          <dd>
            <code>data/projects/{project.id}</code>
          </dd>
        </dl>
      </div>
    </>
  );
}
