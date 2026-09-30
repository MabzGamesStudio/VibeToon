import { useRef, useState } from 'react';
import { batchConnectionsInto, batchItemStatuses, dropItemData, isBatchNode, itemHasOwnData } from '@vibetoon/shared';
import { hasBatchRunner, waitForRunner } from '../../state/batchRun';
import { useStudio } from '../../state/store';

const STATUS_WORD: Record<string, string> = { ready: 'up to date', stale: 'out of date', empty: 'not generated', error: 'failed' };

/**
 * The strip across a batch flow's editor: which item the editor shows, whether
 * an edit goes to every item or to that one alone, and Generate all.
 */
export function BatchBar({ nodeId }: { nodeId: string }): JSX.Element | null {
  const { project, batchFocus, setBatchFocus, transform, generateFlow, busyFlows, notify, focusFlow } = useStudio();
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const stopping = useRef(false);
  const node = project?.nodes.find((candidate) => candidate.id === nodeId);
  if (!project || !node || !isBatchNode(project, node)) return null;

  const entries = batchItemStatuses(project, node);
  const source = project.nodes.find((candidate) => candidate.id === batchConnectionsInto(project, node)[0]?.from.nodeId);
  const openSource = source ? (
    <button type="button" className="vt-btn is-small" onClick={() => focusFlow(source.id)}>
      Open {source.name}
    </button>
  ) : null;
  // What the flow the batch comes from has to do to make its items.
  const howToMake =
    source?.kind === 'animation.video.shots'
      ? 'Open it and Generate: each shot is recorded as a video, which takes as long as the video.'
      : source?.kind === 'animation.video.edit'
        ? 'Open it, write the edit as a clip each, and Generate.'
        : source?.kind === 'animation.video.match'
          ? 'Open it and Generate: the matched frames are written as pictures.'
          : 'Generate it first.';
  if (entries.length === 0) {
    return (
      <div className="vt-batch-bar">
        <span className="vt-batch-count">batch ×0</span>
        <span className="vt-faint">
          Nothing in this batch yet: {source?.name ?? 'what is wired in'} has made no items
          {source?.kind === 'animation.video.shots' ? ' — find the shots there first' : ''}. {howToMake}
        </span>
        {openSource}
      </div>
    );
  }
  const missing = entries.filter((entry) => !entry.item.artifact).length;

  const chosen = batchFocus[nodeId];
  const index = Math.max(0, entries.findIndex((entry) => entry.item.key === chosen?.key));
  const key = entries[index]!.item.key;
  const only = chosen?.only ?? false;
  const own = itemHasOwnData(node, key);
  const ready = entries.filter((entry) => entry.status === 'ready').length;
  const busy = busyFlows.includes(nodeId) || running !== null;
  const show = (at: number) => setBatchFocus(nodeId, { key: entries[(at + entries.length) % entries.length]!.item.key, only });

  const generateAll = async () => {
    // Made on the server: it runs every item itself.
    if (!hasBatchRunner(nodeId)) {
      await generateFlow(nodeId, [], { all: true });
      return;
    }
    // Made in the editor: show each item in turn and let it do its job. What
    // each item works out is its own, so it goes to that item alone.
    stopping.current = false;
    const back = { key, only };
    setRunning({ done: 0, total: entries.length });
    let done = 0;
    let skipped = 0;
    try {
      for (const entry of entries) {
        if (stopping.current) break;
        // Nothing to work on until the flow before has made it.
        if (!entry.item.artifact) {
          skipped += 1;
          continue;
        }
        setBatchFocus(nodeId, { key: entry.item.key, only: true, quiet: true });
        const run = await waitForRunner(nodeId, entry.item.key);
        if (!run) {
          notify('error', `${entry.item.label} did not open in time; Generate all stopped there.`);
          break;
        }
        await run();
        done += 1;
        setRunning({ done, total: entries.length });
      }
      if (stopping.current) notify('info', `Stopped after ${done} of ${entries.length} item(s).`);
      else if (done === entries.length) notify('success', `${node.name}: all ${done} item(s) generated.`);
      else if (skipped > 0) notify('warn', `${node.name}: ${done} item(s) generated; ${skipped} skipped, not made yet by ${source?.name ?? 'the flow before'}.`);
    } catch (reason) {
      notify('error', `Generate all stopped: ${(reason as Error).message}`);
    } finally {
      setBatchFocus(nodeId, back);
      setRunning(null);
    }
  };

  return (
    <div className="vt-batch-bar">
      <span className="vt-batch-count" title={`${ready} of ${entries.length} item(s) up to date`}>
        batch ×{entries.length}
      </span>
      <button type="button" className="vt-btn is-ghost is-small" aria-label="Previous item" disabled={busy} onClick={() => show(index - 1)}>
        ‹
      </button>
      <div className="vt-batch-items" role="listbox" aria-label="Items">
        {entries.map((entry, at) => (
          <button
            key={entry.item.key}
            type="button"
            role="option"
            aria-selected={at === index}
            disabled={busy && at !== index}
            className={`vt-batch-item is-${entry.status}${at === index ? ' is-on' : ''}${itemHasOwnData(node, entry.item.key) ? ' is-own' : ''}`}
            title={`${entry.item.label}: ${STATUS_WORD[entry.status] ?? entry.status}${itemHasOwnData(node, entry.item.key) ? ' · its own settings' : ''}`}
            onClick={() => show(at)}
          >
            <i />
            {entry.item.label}
          </button>
        ))}
      </div>
      <button type="button" className="vt-btn is-ghost is-small" aria-label="Next item" disabled={busy} onClick={() => show(index + 1)}>
        ›
      </button>

      <div className="vt-facet-values" role="radiogroup" aria-label="Edits go to">
        <button
          type="button"
          className={`vt-chip${only ? '' : ' is-on'}`}
          aria-pressed={!only}
          disabled={busy}
          title="A change is made to every item — and to those with their own settings, keeping the rest of theirs."
          onClick={() => setBatchFocus(nodeId, { key, only: false })}
        >
          Edit every item
        </button>
        <button
          type="button"
          className={`vt-chip${only ? ' is-on' : ''}`}
          aria-pressed={only}
          disabled={busy}
          title="A change is made to this item alone, which then keeps its own settings."
          onClick={() => setBatchFocus(nodeId, { key, only: true })}
        >
          Only this one
        </button>
      </div>
      {own ? (
        <button
          type="button"
          className="vt-btn is-ghost is-small"
          disabled={busy}
          title="Drop this item's own settings: it uses the ones every item shares again."
          onClick={() => transform((current) => ({ ...current, nodes: current.nodes.map((candidate) => (candidate.id === nodeId ? dropItemData(candidate, key) : candidate)) }))}
        >
          Use the shared settings
        </button>
      ) : null}

      {missing > 0 ? (
        <span className="vt-batch-missing" title={howToMake}>
          {missing === entries.length ? `None of the ${entries.length}` : `${missing} of ${entries.length}`} made yet by {source?.name ?? 'the flow before'}.
          {entries[index] && !entries[index]!.item.artifact ? ' Not this one.' : ''}
        </span>
      ) : null}
      {missing > 0 ? openSource : null}
      <span className="vt-spacer" />
      {running ? (
        <>
          <span className="vt-faint">
            {running.done} of {running.total}
          </span>
          <progress max={running.total} value={running.done} style={{ width: 90 }} />
          <button type="button" className="vt-btn is-small" onClick={() => (stopping.current = true)}>
            Stop
          </button>
        </>
      ) : (
        <button
          type="button"
          className="vt-btn is-small"
          disabled={busy}
          title="Generate every item: each as though it alone were wired in."
          onClick={() => void generateAll()}
        >
          Generate all {entries.length}
        </button>
      )}
    </div>
  );
}
