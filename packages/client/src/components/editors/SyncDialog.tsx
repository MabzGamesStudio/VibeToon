import { useEffect, useState } from 'react';
import type { SyncResponse } from '@vibetoon/shared';
import { api } from '../../api/client';
import { Modal } from '../common/Modal';

export interface SyncDialogProps {
  projectId: string;
  flowId: string;
  connectionId?: string;
  onClose(): void;
  onAccept(): void;
}

const ORDER = ['add', 'update', 'remove', 'orphan', 'pinned', 'unchanged'] as const;

/** Shows what a sync would do before it touches the board. */
export function SyncDialog({
  projectId,
  flowId,
  connectionId,
  onClose,
  onAccept,
}: SyncDialogProps): JSX.Element {
  const [response, setResponse] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .syncPreview(projectId, flowId, connectionId)
      .then((result) => {
        if (!cancelled) setResponse(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, flowId, projectId]);

  const counts = response?.plan.counts;
  const changes = [...(response?.plan.changes ?? [])].sort(
    (a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type),
  );

  return (
    <Modal
      title="Sync from upstream"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="vt-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="vt-btn is-primary"
            disabled={!response}
            onClick={() => {
              onAccept();
              onClose();
            }}
          >
            Apply to board
          </button>
        </>
      }
    >
      {error ? <div className="vt-pill is-error">{error}</div> : null}
      {!response && !error ? <div className="vt-empty">Working out what changed…</div> : null}

      {response ? (
        <>
          <p className="vt-muted">
            Breaking <strong>{response.sourceFlowName}</strong> down with the rules on the connection.
            Sketches, panel notes and pinned panels are kept.
          </p>
          <div className="vt-row" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {ORDER.map((type) =>
              counts && counts[type] > 0 ? (
                <span key={type} className="vt-pill">
                  {counts[type]} {type}
                </span>
              ) : null,
            )}
          </div>
          {response.plan.warnings.map((warning) => (
            <div key={warning} className="vt-pill is-stale" style={{ marginBottom: 6 }}>
              {warning}
            </div>
          ))}
          <div className="vt-sync-changes">
            {changes.map((change) => (
              <div key={`${change.panelId}-${change.type}`} className={`vt-change is-${change.type}`}>
                <span className="vt-change-type">{change.type}</span>
                <span style={{ flex: 1 }}>{change.detail}</span>
                <span className="vt-change-scene">{change.sceneTitle}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}
