import { useState } from 'react';
import { formatWhen } from './common/format';
import { useStudio } from '../state/store';

export function ProjectPicker(): JSX.Element {
  const { projects, newProject, openProject, removeProject, loading } = useStudio();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<'starter' | 'empty'>('starter');

  return (
    <div className="vt-picker vt-scroll">
      <header>
        <h1>VibeToon</h1>
        <p>
          Build an animated clip out of flows: a flow takes inputs, produces files, and wires into the
          next one. The graph is the overview; each flow has its own editor when you focus it.
        </p>
      </header>

      <form
        className="vt-new"
        onSubmit={(event) => {
          event.preventDefault();
          void newProject(name.trim() || 'Untitled clip', template);
          setName('');
        }}
      >
        <input
          value={name}
          placeholder="New project name"
          onChange={(event) => setName(event.target.value)}
          aria-label="New project name"
        />
        <select
          value={template}
          onChange={(event) => setTemplate(event.target.value as 'starter' | 'empty')}
          aria-label="Template"
          style={{ width: 190 }}
        >
          <option value="starter">Dialog → Storyboard</option>
          <option value="empty">Empty graph</option>
        </select>
        <button type="submit" className="vt-btn is-primary" disabled={loading}>
          Create
        </button>
      </form>

      <div className="vt-project-list">
        {projects.length === 0 ? (
          <div className="vt-empty">No projects yet. Make one above.</div>
        ) : (
          projects.map((summary) => (
            <div key={summary.id} className="vt-project">
              <button
                type="button"
                style={{ flex: 1, background: 'none', border: 0, textAlign: 'left', padding: 0 }}
                onClick={() => void openProject(summary.id)}
              >
                <div className="vt-project-name">{summary.name}</div>
                <div className="vt-project-meta">
                  {summary.nodeCount} flow{summary.nodeCount === 1 ? '' : 's'} ·{' '}
                  {summary.connectionCount} connection{summary.connectionCount === 1 ? '' : 's'} · saved{' '}
                  {formatWhen(summary.updatedAt)} · rev {summary.revision}
                </div>
              </button>
              <button
                type="button"
                className="vt-btn is-ghost is-small is-danger"
                onClick={() => {
                  if (window.confirm(`Delete “${summary.name}” and everything it generated?`)) {
                    void removeProject(summary.id);
                  }
                }}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
