import { useStudio } from '../../state/store';
import { ConnectionInspector } from './ConnectionInspector';
import { NodeInspector } from './NodeInspector';
import { ProjectInspector } from './ProjectInspector';

export function Inspector(): JSX.Element {
  const { project, selection, select } = useStudio();
  if (!project) return <></>;

  const node = selection.type === 'node' ? project.nodes.find((n) => n.id === selection.id) : undefined;
  const connection =
    selection.type === 'connection' ? project.connections.find((c) => c.id === selection.id) : undefined;

  const title = node ? node.name : connection ? 'Connection' : project.name;

  return (
    <aside className="vt-inspector">
      <header>
        <h2>{title}</h2>
        <span className="vt-spacer" />
        {selection.type !== 'none' ? (
          <button type="button" className="vt-btn is-ghost is-small" onClick={() => select({ type: 'none' })}>
            Project
          </button>
        ) : null}
      </header>
      <div className="vt-inspector-body">
        {node ? (
          <NodeInspector project={project} node={node} />
        ) : connection ? (
          <ConnectionInspector project={project} connection={connection} />
        ) : (
          <ProjectInspector project={project} />
        )}
      </div>
    </aside>
  );
}
