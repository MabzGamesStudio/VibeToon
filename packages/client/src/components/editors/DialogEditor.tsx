import { useCallback } from 'react';
import {
  BEAT_TYPE_LABEL,
  DEFAULT_DURATION_OPTIONS,
  beatDuration,
  dialogDuration,
  newBeat,
  newCharacter,
  newScene,
  newSet,
  sceneDuration,
  type DialogBeat,
  type DialogFlowData,
  type FlowNode,
  type Project,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { formatSeconds } from '../common/format';

const BEAT_TYPES: DialogBeat['type'][] = ['line', 'action', 'sound', 'direction'];

export function DialogEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData } = useStudio();
  const data = node.data as DialogFlowData;
  const durationOptions = {
    ...DEFAULT_DURATION_OPTIONS,
    defaultSeconds: project.settings.defaultShotSeconds || DEFAULT_DURATION_OPTIONS.defaultSeconds,
  };

  const mutate = useCallback(
    (change: (draft: DialogFlowData) => void) => {
      const draft = structuredClone(data);
      change(draft);
      setFlowData(node.id, draft);
    },
    [data, node.id, setFlowData],
  );

  const moveBeat = (sceneIndex: number, beatIndex: number, delta: number) => {
    mutate((draft) => {
      const beats = draft.scenes[sceneIndex]?.beats;
      if (!beats) return;
      const target = beatIndex + delta;
      if (target < 0 || target >= beats.length) return;
      const [beat] = beats.splice(beatIndex, 1);
      if (beat) beats.splice(target, 0, beat);
    });
  };

  return (
    <>
      <aside className="vt-editor-side">
        <Field label="Logline" hint="One sentence. Everything downstream reads it.">
          <textarea
            rows={3}
            value={data.logline}
            onChange={(event) =>
              mutate((draft) => {
                draft.logline = event.target.value;
              })
            }
          />
        </Field>

        <div className="vt-section">
          <h3>
            <span>Cast</span>
            <button
              type="button"
              className="vt-btn is-small"
              onClick={() =>
                mutate((draft) => {
                  draft.characters.push(newCharacter(draft.characters.length));
                })
              }
            >
              + Character
            </button>
          </h3>
          {data.characters.length === 0 ? (
            <div className="vt-empty">No characters yet.</div>
          ) : (
            data.characters.map((character, index) => (
              <div className="vt-character" key={character.id}>
                <div className="vt-character-head">
                  <input
                    className="vt-swatch"
                    type="color"
                    value={character.color}
                    aria-label={`${character.name} colour`}
                    onChange={(event) =>
                      mutate((draft) => {
                        const target = draft.characters[index];
                        if (target) target.color = event.target.value;
                      })
                    }
                  />
                  <input
                    value={character.name}
                    aria-label="Character name"
                    onChange={(event) =>
                      mutate((draft) => {
                        const target = draft.characters[index];
                        if (target) target.name = event.target.value;
                      })
                    }
                  />
                  <button
                    type="button"
                    className="vt-btn is-ghost is-small is-danger"
                    title="Remove character"
                    onClick={() =>
                      mutate((draft) => {
                        draft.characters.splice(index, 1);
                        for (const scene of draft.scenes) {
                          for (const beat of scene.beats) {
                            if (beat.characterId === character.id) delete beat.characterId;
                          }
                        }
                      })
                    }
                  >
                    ×
                  </button>
                </div>
                <textarea
                  rows={2}
                  placeholder="Personality — how they behave under pressure"
                  value={character.personality}
                  onChange={(event) =>
                    mutate((draft) => {
                      const target = draft.characters[index];
                      if (target) target.personality = event.target.value;
                    })
                  }
                />
                <textarea
                  rows={2}
                  placeholder="Voice — rhythm, vocabulary, delivery"
                  value={character.voice}
                  onChange={(event) =>
                    mutate((draft) => {
                      const target = draft.characters[index];
                      if (target) target.voice = event.target.value;
                    })
                  }
                />
              </div>
            ))
          )}
        </div>

        <div className="vt-section">
          <h3>
            <span>Sets</span>
            <button
              type="button"
              className="vt-btn is-small"
              onClick={() =>
                mutate((draft) => {
                  draft.sets.push(newSet(draft.sets.length));
                })
              }
            >
              + Set
            </button>
          </h3>
          {data.sets.length === 0 ? (
            <div className="vt-empty">No sets yet.</div>
          ) : (
            data.sets.map((set, index) => (
              <div className="vt-character" key={set.id}>
                <div className="vt-character-head">
                  <input
                    value={set.name}
                    aria-label="Set name"
                    onChange={(event) =>
                      mutate((draft) => {
                        const target = draft.sets[index];
                        if (target) target.name = event.target.value;
                      })
                    }
                  />
                  <input
                    value={set.timeOfDay}
                    placeholder="Night"
                    style={{ width: 78 }}
                    aria-label="Time of day"
                    onChange={(event) =>
                      mutate((draft) => {
                        const target = draft.sets[index];
                        if (target) target.timeOfDay = event.target.value;
                      })
                    }
                  />
                  <button
                    type="button"
                    className="vt-btn is-ghost is-small is-danger"
                    title="Remove set"
                    onClick={() =>
                      mutate((draft) => {
                        draft.sets.splice(index, 1);
                        for (const scene of draft.scenes) {
                          if (scene.setId === set.id) delete scene.setId;
                        }
                      })
                    }
                  >
                    ×
                  </button>
                </div>
                <textarea
                  rows={2}
                  placeholder="What the place looks and sounds like"
                  value={set.description}
                  onChange={(event) =>
                    mutate((draft) => {
                      const target = draft.sets[index];
                      if (target) target.description = event.target.value;
                    })
                  }
                />
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="vt-editor-main">
        <div className="vt-row" style={{ marginBottom: 10 }}>
          <strong>Scenes</strong>
          <span className="vt-faint">
            {data.scenes.length} scene{data.scenes.length === 1 ? '' : 's'} ·{' '}
            {formatSeconds(dialogDuration(data, durationOptions))} estimated
          </span>
          <span className="vt-spacer" />
          <button
            type="button"
            className="vt-btn"
            onClick={() =>
              mutate((draft) => {
                draft.scenes.push(newScene());
              })
            }
          >
            + Scene
          </button>
        </div>

        {data.scenes.length === 0 ? (
          <div className="vt-empty">No scenes yet. Add one to start writing.</div>
        ) : null}

        {data.scenes.map((scene, sceneIndex) => (
          <section className="vt-scene" key={scene.id}>
            <header>
              <span className="vt-scene-no">{sceneIndex + 1}</span>
              <input
                className="vt-slug"
                value={scene.slug}
                aria-label="Scene heading"
                onChange={(event) =>
                  mutate((draft) => {
                    const target = draft.scenes[sceneIndex];
                    if (target) target.slug = event.target.value;
                  })
                }
              />
              <select
                value={scene.setId ?? ''}
                aria-label="Set"
                onChange={(event) =>
                  mutate((draft) => {
                    const target = draft.scenes[sceneIndex];
                    if (!target) return;
                    if (event.target.value) target.setId = event.target.value;
                    else delete target.setId;
                  })
                }
              >
                <option value="">— no set —</option>
                {data.sets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                  </option>
                ))}
              </select>
              <span className="vt-faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                {formatSeconds(sceneDuration(scene, durationOptions))}
              </span>
              <button
                type="button"
                className="vt-btn is-ghost is-small"
                title="Move scene up"
                disabled={sceneIndex === 0}
                onClick={() =>
                  mutate((draft) => {
                    const [moved] = draft.scenes.splice(sceneIndex, 1);
                    if (moved) draft.scenes.splice(sceneIndex - 1, 0, moved);
                  })
                }
              >
                ↑
              </button>
              <button
                type="button"
                className="vt-btn is-ghost is-small is-danger"
                title="Remove scene"
                onClick={() => {
                  if (!window.confirm(`Remove scene ${sceneIndex + 1}?`)) return;
                  mutate((draft) => {
                    draft.scenes.splice(sceneIndex, 1);
                  });
                }}
              >
                ×
              </button>
            </header>

            <div className="vt-scene-summary">
              <input
                value={scene.summary}
                placeholder="What happens in this scene, in one line"
                onChange={(event) =>
                  mutate((draft) => {
                    const target = draft.scenes[sceneIndex];
                    if (target) target.summary = event.target.value;
                  })
                }
              />
            </div>

            <div className="vt-beats">
              {scene.beats.map((beat, beatIndex) => (
                <div className={`vt-beat is-${beat.type}`} key={beat.id}>
                  <select
                    className="vt-beat-type"
                    value={beat.type}
                    aria-label="Beat type"
                    onChange={(event) =>
                      mutate((draft) => {
                        const target = draft.scenes[sceneIndex]?.beats[beatIndex];
                        if (target) target.type = event.target.value as DialogBeat['type'];
                      })
                    }
                  >
                    {BEAT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {BEAT_TYPE_LABEL[type]}
                      </option>
                    ))}
                  </select>

                  {beat.type === 'line' ? (
                    <select
                      value={beat.characterId ?? ''}
                      aria-label="Character"
                      onChange={(event) =>
                        mutate((draft) => {
                          const target = draft.scenes[sceneIndex]?.beats[beatIndex];
                          if (!target) return;
                          if (event.target.value) target.characterId = event.target.value;
                          else delete target.characterId;
                        })
                      }
                      style={{
                        borderLeft: `3px solid ${
                          data.characters.find((c) => c.id === beat.characterId)?.color ?? 'transparent'
                        }`,
                      }}
                    >
                      <option value="">— who? —</option>
                      {data.characters.map((character) => (
                        <option key={character.id} value={character.id}>
                          {character.name}
                        </option>
                      ))}
                    </select>
                  ) : null}

                  <textarea
                    rows={1}
                    value={beat.type === 'sound' ? (beat.sound ?? '') : beat.text}
                    placeholder={
                      beat.type === 'line'
                        ? 'What they say'
                        : beat.type === 'action'
                          ? 'What happens on screen'
                          : beat.type === 'sound'
                            ? 'The sound cue'
                            : 'Camera or staging direction'
                    }
                    onChange={(event) =>
                      mutate((draft) => {
                        const target = draft.scenes[sceneIndex]?.beats[beatIndex];
                        if (!target) return;
                        if (target.type === 'sound') target.sound = event.target.value;
                        else target.text = event.target.value;
                      })
                    }
                  />

                  <div className="vt-beat-tools">
                    <button
                      type="button"
                      className="vt-btn is-ghost is-small"
                      title="Move up"
                      disabled={beatIndex === 0}
                      onClick={() => moveBeat(sceneIndex, beatIndex, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="vt-btn is-ghost is-small"
                      title="Move down"
                      disabled={beatIndex === scene.beats.length - 1}
                      onClick={() => moveBeat(sceneIndex, beatIndex, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="vt-btn is-ghost is-small is-danger"
                      title="Remove beat"
                      onClick={() =>
                        mutate((draft) => {
                          draft.scenes[sceneIndex]?.beats.splice(beatIndex, 1);
                        })
                      }
                    >
                      ×
                    </button>
                  </div>

                  <div className="vt-beat-extras">
                    {beat.type === 'line' ? (
                      <input
                        value={beat.parenthetical ?? ''}
                        placeholder="(delivery note)"
                        aria-label="Parenthetical"
                        onChange={(event) =>
                          mutate((draft) => {
                            const target = draft.scenes[sceneIndex]?.beats[beatIndex];
                            if (target) target.parenthetical = event.target.value;
                          })
                        }
                      />
                    ) : null}
                    {beat.type !== 'sound' ? (
                      <input
                        value={beat.sound ?? ''}
                        placeholder="sound cue on this beat"
                        aria-label="Sound cue"
                        onChange={(event) =>
                          mutate((draft) => {
                            const target = draft.scenes[sceneIndex]?.beats[beatIndex];
                            if (target) target.sound = event.target.value;
                          })
                        }
                      />
                    ) : null}
                    <input
                      className="vt-beat-duration"
                      type="number"
                      min={0}
                      step={0.1}
                      value={beat.durationSec ?? ''}
                      placeholder={`${beatDuration(beat, durationOptions)}s`}
                      aria-label="Duration in seconds"
                      onChange={(event) =>
                        mutate((draft) => {
                          const target = draft.scenes[sceneIndex]?.beats[beatIndex];
                          if (!target) return;
                          const value = Number(event.target.value);
                          if (event.target.value === '' || !Number.isFinite(value) || value <= 0) {
                            delete target.durationSec;
                          } else {
                            target.durationSec = value;
                          }
                        })
                      }
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="vt-scene-foot">
              {BEAT_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="vt-btn is-small"
                  onClick={() =>
                    mutate((draft) => {
                      draft.scenes[sceneIndex]?.beats.push(newBeat(type));
                    })
                  }
                >
                  + {BEAT_TYPE_LABEL[type]}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
