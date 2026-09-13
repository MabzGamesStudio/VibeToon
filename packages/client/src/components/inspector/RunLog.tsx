import type { FlowNode, GenerationRun } from '@vibetoon/shared';
import { formatWhen } from '../common/format';

export function RunLog({ node, run }: { node: FlowNode; run?: GenerationRun }): JSX.Element {
  const log = run?.log ?? node.lastRun?.log ?? [];
  const warnings = run?.warnings ?? node.lastRun?.warnings ?? [];
  const error = run?.error ?? node.lastRun?.error;
  const at = run?.startedAt ?? node.lastRun?.at;

  if (!at) return <div className="vt-empty">Not generated yet.</div>;

  return (
    <div className="vt-run-log">
      <div className="vt-faint" style={{ fontSize: 11 }}>
        {formatWhen(at)}
        {run ? ` · ${run.ms}ms` : ''}
      </div>
      {log.map((line, index) => (
        <div key={`log-${index}`} className="vt-log-line">
          {line}
        </div>
      ))}
      {warnings.map((line, index) => (
        <div key={`warn-${index}`} className="vt-log-line is-warn">
          ⚠ {line}
        </div>
      ))}
      {error ? <div className="vt-log-line is-error">✕ {error}</div> : null}
      {log.length === 0 && warnings.length === 0 && !error ? (
        <div className="vt-faint">Ran cleanly with nothing to report.</div>
      ) : null}
    </div>
  );
}
