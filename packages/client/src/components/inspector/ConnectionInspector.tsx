import { useMemo, useRef } from 'react';
import {
  connectionModeLabel,
  findPort,
  getFlowKind,
  parseRules,
  RULE_DIRECTIVES,
  type Connection,
  type ConnectionMode,
  type Project,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';

const MODES: ConnectionMode[] = ['suggest', 'apply', 'reference'];

export function ConnectionInspector({
  project,
  connection,
}: {
  project: Project;
  connection: Connection;
}): JSX.Element {
  const { patchConnection, removeConnection, focusFlow, registry } = useStudio();
  const rulesRef = useRef<HTMLTextAreaElement | null>(null);

  const sourceNode = project.nodes.find((node) => node.id === connection.from.nodeId);
  const targetNode = project.nodes.find((node) => node.id === connection.to.nodeId);
  const sourcePort = sourceNode ? findPort(sourceNode.kind, connection.from.portId, 'outputs') : undefined;
  const targetPort = targetNode ? findPort(targetNode.kind, connection.to.portId, 'inputs') : undefined;

  const parsed = useMemo(() => parseRules(connection.rules), [connection.rules]);
  const relevant = useMemo(() => {
    const kind = targetNode?.kind;
    const directives = registry?.ruleDirectives ?? RULE_DIRECTIVES;
    return directives.filter(
      (directive) => directive.appliesTo.includes('*') || (kind && directive.appliesTo.includes(kind)),
    );
  }, [registry, targetNode?.kind]);

  const settings = connection.settings;

  const insert = (text: string) => {
    const next = connection.rules.trim() ? `${connection.rules.replace(/\n+$/, '')}\n${text}` : text;
    patchConnection(connection.id, { rules: next });
    requestAnimationFrame(() => {
      const element = rulesRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    });
  };

  return (
    <>
      <div className="vt-section">
        <dl className="vt-kv">
          <dt>From</dt>
          <dd>
            {sourceNode?.name ?? '?'} <span className="vt-faint">· {sourcePort?.label ?? connection.from.portId}</span>
          </dd>
          <dt>To</dt>
          <dd>
            {targetNode?.name ?? '?'} <span className="vt-faint">· {targetPort?.label ?? connection.to.portId}</span>
          </dd>
          <dt>Carries</dt>
          <dd>
            <code>{sourcePort?.fileName ?? sourcePort?.kinds.join('/')}</code>
          </dd>
        </dl>
        <div className="vt-row" style={{ marginTop: 8, gap: 6 }}>
          <button type="button" className="vt-btn is-small" onClick={() => focusFlow(connection.from.nodeId)}>
            Open {getFlowKind(sourceNode?.kind ?? '')?.label ?? 'source'}
          </button>
          <button type="button" className="vt-btn is-small" onClick={() => focusFlow(connection.to.nodeId)}>
            Open {getFlowKind(targetNode?.kind ?? '')?.label ?? 'target'}
          </button>
        </div>
      </div>

      <div className="vt-section vt-rules-editor">
        <h3>
          <span>Rules</span>
          <span className="vt-faint">{parsed.directives.length} directive(s)</span>
        </h3>
        <textarea
          ref={rulesRef}
          className="vt-mono"
          value={connection.rules}
          placeholder={'panel per: beat\nshot for line: MCU\nkeep the reaction in the same panel'}
          onChange={(event) => patchConnection(connection.id, { rules: event.target.value })}
        />
        <div className="vt-hint">
          One rule per line. <code>key: value</code> lines listed below are interpreted; anything else is
          kept as guidance and shown to whoever (or whatever) does the work.
        </div>

        {parsed.directives.length > 0 ? (
          <div className="vt-rules-summary">
            {parsed.directives.map((directive, index) => (
              <div
                key={`${directive.key}-${index}`}
                className={`vt-rule-line${directive.known ? '' : ' is-unknown'}`}
                title={directive.known ? 'Interpreted' : 'Not a known directive — kept as guidance'}
              >
                <code>{directive.key}</code>
                <span className="vt-muted">{directive.value}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="vt-directive-help">
          <div className="vt-faint" style={{ fontSize: 11, marginBottom: 4 }}>
            Directives this connection understands — click to add:
          </div>
          {relevant.map((directive) => (
            <button
              key={directive.key}
              type="button"
              className="vt-directive"
              onClick={() => insert(`${directive.key}: ${directive.example}`)}
              title={directive.description}
            >
              <code>
                {directive.key}: {directive.example}
              </code>{' '}
              — {directive.description.replace(/`/g, '')}
            </button>
          ))}
        </div>
      </div>

      <div className="vt-section">
        <h3>Mode</h3>
        <div className="vt-mode-picker">
          {MODES.map((mode) => {
            const [title, ...rest] = connectionModeLabel(mode).split(' — ');
            return (
              <button
                key={mode}
                type="button"
                className={`vt-mode${settings.mode === mode ? ' is-active' : ''}`}
                onClick={() => patchConnection(connection.id, { settings: { ...settings, mode } })}
              >
                <div>
                  <strong>{title}</strong>
                  <span>{rest.join(' — ')}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="vt-section">
        <Field label={`Weight — ${settings.weight.toFixed(2)}`} hint="How hard this input should push the result.">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.weight}
            onChange={(event) =>
              patchConnection(connection.id, {
                settings: { ...settings, weight: Number(event.target.value) },
              })
            }
          />
        </Field>
        <Field label="Connection notes" hint="Why this wire exists. Travels with the rules.">
          <textarea
            rows={2}
            value={settings.notes}
            onChange={(event) =>
              patchConnection(connection.id, { settings: { ...settings, notes: event.target.value } })
            }
          />
        </Field>
        <label className="vt-row" style={{ gap: 6, marginTop: 4 }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            style={{ width: 'auto' }}
            onChange={(event) =>
              patchConnection(connection.id, { settings: { ...settings, enabled: event.target.checked } })
            }
          />
          <span>Enabled</span>
        </label>
      </div>

      <div className="vt-section">
        <button
          type="button"
          className="vt-btn is-danger"
          onClick={() => removeConnection(connection.id)}
        >
          Remove connection
        </button>
      </div>
    </>
  );
}
