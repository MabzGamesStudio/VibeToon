import { useCallback, useMemo, useState } from 'react';
import {
  SHOT_SIZES,
  SHOT_SIZE_LABEL,
  boardDuration,
  inputsForPort,
  newPanel,
  newStoryboardScene,
  panelImageName,
  timePanels,
  upstreamSignature,
  type DialogFlowData,
  type FlowNode,
  type Project,
  type ShotSize,
  type StoryboardFlowData,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { formatSeconds } from '../common/format';
import { EditorShell } from './EditorShell';
import { Playblast } from './Playblast';
import { SketchPad } from './SketchPad';
import { SyncDialog } from './SyncDialog';
import { rasterizePanel } from './sketch';

const MAX_RASTER_WIDTH = 1920;

export function StoryboardEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, acceptSync, notify } = useStudio();
  const data = node.data as StoryboardFlowData;
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [playing, setPlaying] = useState(false);

  const timed = useMemo(() => timePanels(data.scenes, project.settings), [data.scenes, project.settings]);

  const source = inputsForPort(project, node.id, 'dialog').find(
    (input) => input.sourceNode.data.editor === 'dialog',
  );
  const expectedSignature = source
    ? upstreamSignature(source.sourceNode.data as DialogFlowData, source.connection.rules)
    : null;
  const inSync = expectedSignature !== null && expectedSignature === data.syncSignature;

  const mutate = useCallback(
    (change: (draft: StoryboardFlowData) => void) => {
      const draft = structuredClone(data);
      change(draft);
      setFlowData(node.id, draft);
    },
    [data, node.id, setFlowData],
  );

  /**
   * Generating a board also hands the server a PNG per panel, drawn from the
   * same strokes at the project's frame size. That is what makes an animatic or
   * an mp4 possible without any extra tooling in the browser.
   */
  const generateWithPanels = useCallback(async () => {
    const scale = Math.min(1, MAX_RASTER_WIDTH / Math.max(1, project.settings.width));
    const width = Math.round(project.settings.width * scale);
    const height = Math.round(project.settings.height * scale);
    const attachments = timed.map((entry) => ({
      name: panelImageName(entry.index),
      data: rasterizePanel(entry.panel.sketch, { width, height }, {
        index: entry.index,
        shot: entry.panel.shot,
        text: entry.panel.action || entry.panel.dialog || entry.panel.sound,
      }),
    }));
    if (attachments.length === 0) {
      notify('warn', 'There are no panels to render yet.');
    }
    await generateFlow(node.id, attachments);
  }, [generateFlow, node.id, notify, project.settings, timed]);

  const scenes = data.scenes;

  return (
    <>
      <EditorShell
        project={project}
        node={node}
        onGenerate={generateWithPanels}
        actions={
          <>
            <button
              type="button"
              className="vt-btn is-small"
              disabled={timed.length === 0}
              onClick={() => setPlaying(true)}
              title="Play the board in the browser at its own timing"
            >
              ▶ Playblast
            </button>
            <button
              type="button"
              className="vt-btn is-small"
              onClick={() =>
                mutate((draft) => {
                  draft.scenes.push(newStoryboardScene(draft.scenes.length));
                })
              }
            >
              + Scene
            </button>
          </>
        }
        banner={
          source ? (
            <div className={`vt-sync-banner${inSync ? ' is-clean' : ''}`}>
              <span>
                {inSync
                  ? `In sync with ${source.sourceNode.name}.`
                  : data.syncSignature
                    ? `${source.sourceNode.name} has changed since the last sync.`
                    : `Not synced from ${source.sourceNode.name} yet.`}
              </span>
              <span className="vt-faint">
                mode: {source.connection.settings.mode}
                {source.connection.settings.enabled ? '' : ' (disabled)'}
              </span>
              <span className="vt-spacer" />
              <button type="button" className="vt-btn is-small" onClick={() => setSyncOpen(true)}>
                Review sync
              </button>
            </div>
          ) : (
            <div className="vt-sync-banner">
              <span>
                Nothing is wired into the Dialog input, so panels have to be added by hand. Connect a
                dialog flow on the graph to break a script down automatically.
              </span>
            </div>
          )
        }
      >
        <div className="vt-editor-main">
          <div className="vt-row" style={{ marginBottom: 10 }}>
            <strong>Board</strong>
            <span className="vt-faint">
              {timed.length} panel{timed.length === 1 ? '' : 's'} ·{' '}
              {formatSeconds(boardDuration(scenes, project.settings))} ·{' '}
              {timed.filter((entry) => entry.panel.sketch).length} drawn
            </span>
          </div>

          {scenes.length === 0 ? (
            <div className="vt-empty">
              No panels yet. Review the sync to break the dialog down, or add a scene by hand.
            </div>
          ) : null}

          {scenes.map((scene, sceneIndex) => (
            <section key={scene.id} style={{ marginBottom: 18 }}>
              <div className="vt-row" style={{ marginBottom: 8 }}>
                <input
                  value={scene.title}
                  aria-label="Scene title"
                  style={{ fontWeight: 600, maxWidth: 420 }}
                  onChange={(event) =>
                    mutate((draft) => {
                      const target = draft.scenes[sceneIndex];
                      if (target) target.title = event.target.value;
                    })
                  }
                />
                <input
                  value={scene.setName}
                  placeholder="set"
                  aria-label="Set name"
                  style={{ maxWidth: 180 }}
                  onChange={(event) =>
                    mutate((draft) => {
                      const target = draft.scenes[sceneIndex];
                      if (target) target.setName = event.target.value;
                    })
                  }
                />
                <span className="vt-spacer" />
                <button
                  type="button"
                  className="vt-btn is-small"
                  onClick={() =>
                    mutate((draft) => {
                      draft.scenes[sceneIndex]?.panels.push(newPanel());
                    })
                  }
                >
                  + Panel
                </button>
                <button
                  type="button"
                  className="vt-btn is-small is-danger"
                  onClick={() => {
                    if (!window.confirm(`Remove “${scene.title}” and its panels?`)) return;
                    mutate((draft) => {
                      draft.scenes.splice(sceneIndex, 1);
                    });
                  }}
                >
                  Remove scene
                </button>
              </div>

              <div className="vt-panels">
                {scene.panels.map((panel, panelIndex) => {
                  const entry = timed.find((candidate) => candidate.panel.id === panel.id);
                  const active = activePanelId === panel.id;
                  return (
                    <article
                      key={panel.id}
                      className={`vt-panel${panel.pinned ? ' is-pinned' : ''}`}
                      onFocus={() => setActivePanelId(panel.id)}
                    >
                      <header>
                        <span className="vt-panel-no">{(entry?.index ?? panelIndex) + 1}</span>
                        <select
                          className="vt-panel-shot"
                          value={panel.shot}
                          aria-label="Shot size"
                          title={SHOT_SIZE_LABEL[panel.shot]}
                          onChange={(event) =>
                            mutate((draft) => {
                              const target = draft.scenes[sceneIndex]?.panels[panelIndex];
                              if (!target) return;
                              target.shot = event.target.value as ShotSize;
                              target.pinned = true;
                            })
                          }
                        >
                          {SHOT_SIZES.map((shot) => (
                            <option key={shot} value={shot}>
                              {shot}
                            </option>
                          ))}
                        </select>
                        <input
                          className="vt-panel-dur"
                          type="number"
                          min={0.1}
                          step={0.1}
                          value={panel.durationSec}
                          aria-label="Duration in seconds"
                          onChange={(event) =>
                            mutate((draft) => {
                              const target = draft.scenes[sceneIndex]?.panels[panelIndex];
                              if (!target) return;
                              target.durationSec = Number(event.target.value) || 0.1;
                              target.pinned = true;
                            })
                          }
                        />
                        <span className="vt-faint" style={{ fontSize: 11 }}>
                          {entry ? `${entry.startSec.toFixed(1)}s` : ''}
                        </span>
                        <span className="vt-spacer" />
                        <button
                          type="button"
                          className={`vt-btn is-ghost is-small${panel.pinned ? ' is-active' : ''}`}
                          title={
                            panel.pinned
                              ? 'Pinned: a sync will not change this panel’s text'
                              : 'Pin so a sync leaves this panel alone'
                          }
                          onClick={() =>
                            mutate((draft) => {
                              const target = draft.scenes[sceneIndex]?.panels[panelIndex];
                              if (target) target.pinned = !target.pinned;
                            })
                          }
                        >
                          {panel.pinned ? '📌' : '📍'}
                        </button>
                      </header>

                      <SketchPad
                        sketch={panel.sketch}
                        showTools={active}
                        onActivate={() => setActivePanelId(panel.id)}
                        label={`panel ${(entry?.index ?? panelIndex) + 1} — draw here`}
                        onChange={(sketch) =>
                          mutate((draft) => {
                            const target = draft.scenes[sceneIndex]?.panels[panelIndex];
                            if (target) target.sketch = sketch;
                          })
                        }
                      />

                      <div className="vt-panel-fields">
                        <textarea
                          rows={2}
                          value={panel.dialog}
                          placeholder="dialog in this panel"
                          aria-label="Dialog"
                          onChange={(event) =>
                            mutate((draft) => {
                              const target = draft.scenes[sceneIndex]?.panels[panelIndex];
                              if (!target) return;
                              target.dialog = event.target.value;
                              target.pinned = true;
                            })
                          }
                        />
                        <textarea
                          rows={2}
                          value={panel.action}
                          placeholder="action"
                          aria-label="Action"
                          onChange={(event) =>
                            mutate((draft) => {
                              const target = draft.scenes[sceneIndex]?.panels[panelIndex];
                              if (!target) return;
                              target.action = event.target.value;
                              target.pinned = true;
                            })
                          }
                        />
                        <input
                          value={panel.camera}
                          placeholder="camera"
                          aria-label="Camera"
                          onChange={(event) =>
                            mutate((draft) => {
                              const target = draft.scenes[sceneIndex]?.panels[panelIndex];
                              if (!target) return;
                              target.camera = event.target.value;
                              target.pinned = true;
                            })
                          }
                        />
                        <input
                          value={panel.sound}
                          placeholder="sound"
                          aria-label="Sound"
                          onChange={(event) =>
                            mutate((draft) => {
                              const target = draft.scenes[sceneIndex]?.panels[panelIndex];
                              if (!target) return;
                              target.sound = event.target.value;
                              target.pinned = true;
                            })
                          }
                        />
                        <textarea
                          rows={1}
                          value={panel.notes}
                          placeholder="notes for whoever animates this"
                          aria-label="Notes"
                          onChange={(event) =>
                            mutate((draft) => {
                              const target = draft.scenes[sceneIndex]?.panels[panelIndex];
                              if (target) target.notes = event.target.value;
                            })
                          }
                        />
                      </div>

                      <footer>
                        <span className="vt-faint" style={{ fontSize: 11 }}>
                          {panel.sourceBeatIds.length > 0
                            ? `from ${panel.sourceBeatIds.length} beat(s)`
                            : 'hand-made'}
                        </span>
                        <span className="vt-spacer" />
                        <button
                          type="button"
                          className="vt-btn is-ghost is-small"
                          title="Insert a panel after this one"
                          onClick={() =>
                            mutate((draft) => {
                              draft.scenes[sceneIndex]?.panels.splice(panelIndex + 1, 0, newPanel());
                            })
                          }
                        >
                          + after
                        </button>
                        <button
                          type="button"
                          className="vt-btn is-ghost is-small"
                          title="Move left"
                          disabled={panelIndex === 0}
                          onClick={() =>
                            mutate((draft) => {
                              const panels = draft.scenes[sceneIndex]?.panels;
                              if (!panels) return;
                              const [moved] = panels.splice(panelIndex, 1);
                              if (moved) panels.splice(panelIndex - 1, 0, moved);
                            })
                          }
                        >
                          ←
                        </button>
                        <button
                          type="button"
                          className="vt-btn is-ghost is-small"
                          title="Move right"
                          disabled={panelIndex === scene.panels.length - 1}
                          onClick={() =>
                            mutate((draft) => {
                              const panels = draft.scenes[sceneIndex]?.panels;
                              if (!panels) return;
                              const [moved] = panels.splice(panelIndex, 1);
                              if (moved) panels.splice(panelIndex + 1, 0, moved);
                            })
                          }
                        >
                          →
                        </button>
                        <button
                          type="button"
                          className="vt-btn is-ghost is-small is-danger"
                          title="Remove panel"
                          onClick={() => {
                            if (panel.sketch && !window.confirm('This panel has a sketch. Remove it?')) return;
                            mutate((draft) => {
                              draft.scenes[sceneIndex]?.panels.splice(panelIndex, 1);
                            });
                          }}
                        >
                          ×
                        </button>
                      </footer>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </EditorShell>

      {syncOpen ? (
        <SyncDialog
          projectId={project.id}
          flowId={node.id}
          connectionId={source?.connection.id}
          onClose={() => setSyncOpen(false)}
          onAccept={() => void acceptSync(node.id, source?.connection.id)}
        />
      ) : null}

      {playing ? (
        <Playblast panels={timed} settings={project.settings} onClose={() => setPlaying(false)} />
      ) : null}
    </>
  );
}
