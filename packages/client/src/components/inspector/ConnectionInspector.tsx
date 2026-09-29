import { useMemo, useRef } from 'react';
import {
  canSplit,
  connectionBatchMode,
  connectionItems,
  gathersBatch,
  isBatchNode,
  SET_ITEM_KIND,
  ARTIFACT_KIND_LABEL,
  connectionModeLabel,
  findPort,
  getFlowKind,
  parseRules,
  RULE_DIRECTIVES,
  type Connection,
  type ConnectionMode,
  type Project,
} from '@vibetoon/shared';
import { useSliderRange } from '../../state/sliderRanges';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { InfoTip } from '../common/InfoTip';

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
  const weightRange = useSliderRange('connection.weight');

  const sourceNode = project.nodes.find((node) => node.id === connection.from.nodeId);
  const targetNode = project.nodes.find((node) => node.id === connection.to.nodeId);
  const sourcePort = sourceNode ? findPort(sourceNode.kind, connection.from.portId, 'outputs') : undefined;
  const targetPort = targetNode ? findPort(targetNode.kind, connection.to.portId, 'inputs') : undefined;

  const parsed = useMemo(() => parseRules(connection.rules), [connection.rules]);
  const relevant = useMemo(() => {
    const kind = targetNode?.kind;
    const directives = registry?.ruleDirectives ?? RULE_DIRECTIVES;
    return directives
      .filter((directive) => directive.appliesTo.includes('*') || (kind && directive.appliesTo.includes(kind)))
      // What this particular flow understands comes before the general ones.
      .sort((a, b) => {
        const specific = (directive: typeof a) => (kind && directive.appliesTo.includes(kind) ? 0 : 1);
        return specific(a) - specific(b);
      });
  }, [registry, targetNode?.kind]);

  const settings = connection.settings;

  // A folder into an input that takes one of its files as well as the whole
  // folder can go either way: that is this wire's choice.
  const batchMode = connectionBatchMode(project, connection);
  const fromBatch = sourceNode ? isBatchNode(project, sourceNode) : false;
  const choosable = !fromBatch && sourcePort && targetPort ? canSplit(sourcePort, targetPort) && sourcePort.kinds.some((kind) => targetPort.kinds.includes(kind)) : false;
  const itemCount = batchMode === 'none' ? 0 : connectionItems(project, connection).length;
  const setKind = sourcePort?.kinds.find((kind) => SET_ITEM_KIND[kind]);
  const itemKind = setKind ? SET_ITEM_KIND[setKind] : undefined;

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

      {batchMode !== 'none' || choosable ? (
        <div className="vt-section">
          <h3>Batch</h3>
          {choosable ? (
            <div className="vt-facet-values" role="radiogroup" aria-label="How the folder goes">
              <button
                type="button"
                className={`vt-chip${batchMode === 'none' ? ' is-on' : ''}`}
                aria-pressed={batchMode === 'none'}
                onClick={() => patchConnection(connection.id, { batch: false })}
              >
                The whole folder
              </button>
              <button
                type="button"
                className={`vt-chip${batchMode === 'batch' ? ' is-on' : ''}`}
                aria-pressed={batchMode === 'batch'}
                onClick={() => patchConnection(connection.id, { batch: true })}
              >
                A batch, one {itemKind ? ARTIFACT_KIND_LABEL[itemKind].toLowerCase() : 'file'} each
              </button>
            </div>
          ) : null}
          <p className="vt-hint">
            {batchMode === 'batch'
              ? `A batch of ${itemCount} item(s): ${targetNode?.name ?? 'the next flow'} runs once for each, as though it alone were wired in, and makes a batch of what it makes. Open it to edit all of them at once or one at a time.`
              : batchMode === 'gather'
                ? `A batch of ${itemCount} item(s), gathered: they arrive at ${targetNode?.name ?? 'the next flow'} together, as one folder.`
                : `${targetNode?.name ?? 'The next flow'} takes the folder as it is, all at once.`}
          </p>
          {fromBatch && sourcePort && targetPort && !gathersBatch(sourcePort, targetPort) ? (
            <p className="vt-faint" style={{ fontSize: 11 }}>
              {sourceNode?.name} is a batch, so what it makes goes on as one.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="vt-section vt-rules-editor">
        <h3>
          <span>
            Rules
            <InfoTip tip="connection.rules" label="Rules" />
          </span>
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
        <h3>
          Mode
          <InfoTip tip="connection.mode" label="Mode" />
        </h3>
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
        <Field
          label={`Weight — ${settings.weight.toFixed(2)}`}
          tip="connection.weight"
          hint="How hard this input should push the result."
        >
          <input
            type="range"
            min={weightRange.min}
            max={weightRange.max}
            step={weightRange.step}
            value={settings.weight}
            onChange={(event) =>
              patchConnection(connection.id, {
                settings: { ...settings, weight: Number(event.target.value) },
              })
            }
          />
        </Field>
        <Field label="Connection notes" tip="connection.notes" hint="Why this wire exists. Travels with the rules.">
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
          <InfoTip tip="connection.enabled" label="Enabled" />
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
