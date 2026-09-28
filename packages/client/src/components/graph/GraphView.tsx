import { useCallback, useState } from 'react';
import { staleNodes, type Vec2 } from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { useView } from '../../state/view';
import { Inspector } from '../inspector/Inspector';
import { CustomFlowDialog } from './CustomFlowDialog';
import { FlowPalette } from './FlowPalette';
import { GraphCanvas } from './GraphCanvas';

export function GraphView(): JSX.Element {
  const { project, busyFlows, generateAll } = useStudio();
  const { view, toggle } = useView();
  const paletteOpen = view.palette;
  const [dropPoint, setDropPoint] = useState<Vec2>({ x: 160, y: 120 });
  const onViewportCentre = useCallback((point: Vec2) => setDropPoint(point), []);
  const [making, setMaking] = useState(false);
  if (!project) return <></>;

  const stale = staleNodes(project);

  return (
    <div className="vt-graph">
      <div className="vt-graph-toolbar">
        <button
          type="button"
          className={`vt-btn is-small${paletteOpen ? ' is-active' : ''}`}
          onClick={() => toggle('palette')}
        >
          {paletteOpen ? '◀ Flows' : 'Flows ▶'}
        </button>
        <span className="vt-faint">
          {project.nodes.length} flow{project.nodes.length === 1 ? '' : 's'} ·{' '}
          {project.connections.length} connection{project.connections.length === 1 ? '' : 's'}
        </span>
        <span className="vt-spacer" />
        <button
          type="button"
          className="vt-btn is-small"
          title="Save some flows, wired as they are, as one flow you can use again"
          onClick={() => setMaking(true)}
        >
          Make a custom flow
        </button>
        {stale.length > 0 ? (
          <button
            type="button"
            className="vt-btn is-small"
            disabled={busyFlows.length > 0}
            onClick={() => void generateAll()}
          >
            {stale.length} flow{stale.length === 1 ? '' : 's'} need generating
          </button>
        ) : (
          <span className="vt-pill is-ready">all up to date</span>
        )}
      </div>

      <div className="vt-graph-body">
        {paletteOpen ? <FlowPalette dropPoint={dropPoint} /> : null}
        <GraphCanvas onViewportCentre={onViewportCentre} />
        {view.inspector ? <Inspector /> : null}
      </div>
      {making ? <CustomFlowDialog onClose={() => setMaking(false)} /> : null}
    </div>
  );
}
