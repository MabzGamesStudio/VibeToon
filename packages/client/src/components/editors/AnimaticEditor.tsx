import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearOverrides,
  cutLimitsFromRules,
  fitCutToTarget,
  formatDuration,
  inputsForPort,
  parseDuration,
  resolveAnimaticCut,
  withOverride,
  type AnimaticFlowData,
  type FlowNode,
  type Project,
  type StoryboardPayload,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { EditorShell } from './EditorShell';
import { Playblast } from './Playblast';
import { clipsFromImages, loadImage, type ImageClipSource } from './playClips';
import { blobToDataUrl, extensionFor, recordClips, recordingSupported } from './recordVideo';

interface BoardState {
  board: StoryboardPayload | null;
  /** Panel file name -> decoded image. */
  images: Map<string, HTMLImageElement>;
  panelsPath: string | null;
  sourceName: string | null;
  rules: string;
  loading: boolean;
  error: string | null;
}

/** Reads the board this animatic is cutting, and decodes its panel images. */
function useBoard(project: Project, node: FlowNode): BoardState {
  const [state, setState] = useState<BoardState>({
    board: null,
    images: new Map(),
    panelsPath: null,
    sourceName: null,
    rules: '',
    loading: false,
    error: null,
  });

  const boardInput = inputsForPort(project, node.id, 'storyboard')[0];
  const panelsInput = inputsForPort(project, node.id, 'panels')[0];
  const signature = [
    boardInput?.artifact?.hash ?? '-',
    boardInput?.connection.rules ?? '',
    panelsInput?.artifact?.hash ?? '-',
  ].join('|');

  useEffect(() => {
    let cancelled = false;
    if (!boardInput?.artifact) {
      setState({
        board: null,
        images: new Map(),
        panelsPath: null,
        sourceName: boardInput?.sourceNode.name ?? null,
        rules: boardInput?.connection.rules ?? '',
        loading: false,
        error: null,
      });
      return;
    }

    setState((current) => ({ ...current, loading: true }));
    void (async () => {
      try {
        const board = JSON.parse(
          await api.artifactText(project.id, boardInput.artifact!.path),
        ) as StoryboardPayload;

        const panelsPath = panelsInput?.artifact?.path ?? null;
        const entries = new Set(panelsInput?.artifact?.entries ?? []);
        const images = new Map<string, HTMLImageElement>();
        if (panelsPath) {
          await Promise.all(
            (board.panels ?? []).map(async (panel) => {
              const fileName = panel.image?.split('/').pop();
              if (!fileName || !entries.has(fileName)) return;
              try {
                images.set(fileName, await loadImage(api.artifactUrl(project.id, `${panelsPath}/${fileName}`)));
              } catch {
                // A missing panel image is not fatal: the shot falls back to a
                // labelled card, so the cut still runs to length.
              }
            }),
          );
        }

        if (!cancelled) {
          setState({
            board,
            images,
            panelsPath,
            sourceName: boardInput.sourceNode.name,
            rules: boardInput.connection.rules,
            loading: false,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState((current) => ({ ...current, loading: false, error: (error as Error).message }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, signature]);

  return state;
}

export function AnimaticEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, uploadOutput, notify, generateFlow } = useStudio();
  const data = node.data as AnimaticFlowData;
  const board = useBoard(project, node);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState<{ progress: number } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const limits = useMemo(() => cutLimitsFromRules(board.rules), [board.rules]);
  const effective = useMemo<AnimaticFlowData>(
    () =>
      limits.targetSeconds !== undefined && data.targetSeconds <= 0
        ? { ...data, targetSeconds: limits.targetSeconds }
        : data,
    [data, limits.targetSeconds],
  );
  const cut = useMemo(
    () => resolveAnimaticCut(board.board, effective, project.settings, limits),
    [board.board, effective, limits, project.settings],
  );

  const patch = useCallback((next: AnimaticFlowData) => setFlowData(node.id, next), [node.id, setFlowData]);

  const clips = useMemo(() => {
    const sources: ImageClipSource[] = cut.clips.map((clip) => ({
      id: clip.panelId,
      label: `${clip.index + 1} · ${clip.shot}`,
      caption: [clip.dialog, clip.sound ? `(${clip.sound})` : ''].filter(Boolean).join('\n'),
      durationSec: clip.durationSec,
      image: board.images.get(clip.image?.split('/').pop() ?? '') ?? null,
      placeholderTitle: `Shot ${clip.index + 1} — ${clip.shot}`,
      placeholderSubtitle: clip.action || clip.dialog || 'no panel image yet',
    }));
    return clipsFromImages(sources);
  }, [board.images, cut.clips]);

  const exportVideo = useCallback(async () => {
    if (!recordingSupported()) {
      notify('error', 'This browser cannot record video. Install ffmpeg and press Generate instead.');
      return;
    }
    if (clips.length === 0) {
      notify('warn', 'There is no cut to record yet.');
      return;
    }

    abort.current = new AbortController();
    setRecording({ progress: 0 });
    try {
      const recording = await recordClips(clips, {
        width: cut.width,
        height: cut.height,
        fps: cut.fps,
        captions: true,
        onProgress: (progress) => setRecording({ progress }),
        signal: abort.current.signal,
      });
      const dataUrl = await blobToDataUrl(recording.blob);
      await uploadOutput(node.id, 'preview', `animatic.${extensionFor(recording.mimeType)}`, dataUrl);
      notify(
        'success',
        `Recorded ${formatDuration(recording.durationSec)} (${(recording.blob.size / 1024 / 1024).toFixed(1)} MB) onto the Preview port.`,
      );
    } catch (error) {
      notify('error', `Recording failed: ${(error as Error).message}`);
    } finally {
      setRecording(null);
      abort.current = null;
    }
  }, [clips, cut.fps, cut.height, cut.width, node.id, notify, uploadOutput]);

  const targetInput = data.targetSeconds > 0 ? String(data.targetSeconds) : '';
  const off = cut.offTargetSec;

  return (
    <>
      <EditorShell
        project={project}
        node={node}
        onGenerate={async () => {
          await generateFlow(node.id);
        }}
        actions={
          <>
            <button
              type="button"
              className="vt-btn is-small"
              disabled={clips.length === 0}
              onClick={() => setPlaying(true)}
            >
              ▶ Play
            </button>
            <button
              type="button"
              className="vt-btn is-small"
              disabled={clips.length === 0 || recording !== null}
              title="Record this cut to a video file and put it on the Preview port"
              onClick={() => void exportVideo()}
            >
              {recording ? `Recording ${Math.round(recording.progress * 100)}%` : '⏺ Export video'}
            </button>
            {recording ? (
              <button type="button" className="vt-btn is-small is-danger" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : null}
          </>
        }
        banner={
          board.board ? null : (
            <div className="vt-sync-banner">
              <span>
                {board.loading
                  ? 'Reading the board…'
                  : board.sourceName
                    ? `${board.sourceName} has not generated a storyboard yet — press Generate on it first.`
                    : 'Wire a storyboard flow into this animatic to lay its panels out in time.'}
              </span>
            </div>
          )
        }
      >
        <div className="vt-editor-main">
          <div className="vt-cut-summary">
            <div className="vt-cut-stat">
              <span className="vt-faint">Runtime</span>
              <strong>{formatDuration(cut.durationSec)}</strong>
              <span className="vt-faint">
                {cut.clips.length} shot{cut.clips.length === 1 ? '' : 's'}
                {cut.skipped.length > 0 ? `, ${cut.skipped.length} cut` : ''}
              </span>
            </div>
            <div className="vt-cut-stat">
              <span className="vt-faint">Board</span>
              <strong>{formatDuration(cut.boardDurationSec)}</strong>
              <span className="vt-faint">
                {cut.adjustedCount > 0 ? `${cut.adjustedCount} retimed here` : 'following the board'}
              </span>
            </div>
            <div className="vt-cut-stat">
              <Field
                label="Target"
                hint={
                  limits.targetSeconds !== undefined && data.targetSeconds <= 0
                    ? `Set to ${formatDuration(limits.targetSeconds)} by the rules on the wire.`
                    : 'Leave empty for no target. `90s`, `1m30` and `1:30` all work.'
                }
              >
                <input
                  value={targetInput}
                  placeholder={limits.targetSeconds !== undefined ? formatDuration(limits.targetSeconds) : 'none'}
                  aria-label="Target runtime"
                  onChange={(event) => {
                    const parsed = parseDuration(event.target.value);
                    patch({ ...data, targetSeconds: event.target.value.trim() === '' ? 0 : (parsed ?? 0) });
                  }}
                />
              </Field>
            </div>
            <div className="vt-cut-stat">
              {cut.targetSeconds > 0 ? (
                <>
                  <span className="vt-faint">Against target</span>
                  <strong className={Math.abs(off) <= 0.5 ? 'vt-on-target' : 'vt-off-target'}>
                    {off >= 0 ? '+' : ''}
                    {off.toFixed(1)}s
                  </strong>
                  <button
                    type="button"
                    className="vt-btn is-small"
                    disabled={cut.clips.length === 0}
                    title="Scale every shot so the cut lands on the target"
                    onClick={() => patch(fitCutToTarget(data, cut))}
                  >
                    Fit to target
                  </button>
                </>
              ) : (
                <span className="vt-faint">No target set.</span>
              )}
            </div>
            <span className="vt-spacer" />
            <button
              type="button"
              className="vt-btn is-small"
              disabled={Object.keys(data.overrides).length === 0}
              onClick={() => patch(clearOverrides(data))}
            >
              Reset timing
            </button>
          </div>

          <Field label="Pacing" hint="Written into the cut list for whoever works from it.">
            <textarea
              rows={2}
              value={data.pacing}
              placeholder="Where it should breathe and where it should cut hard…"
              onChange={(event) => patch({ ...data, pacing: event.target.value })}
            />
          </Field>

          {limits.minDuration !== undefined || limits.maxDuration !== undefined ? (
            <div className="vt-hint" style={{ marginBottom: 8 }}>
              Rules on the wire clamp every shot to{' '}
              {limits.minDuration !== undefined ? `at least ${limits.minDuration}s` : ''}
              {limits.minDuration !== undefined && limits.maxDuration !== undefined ? ' and ' : ''}
              {limits.maxDuration !== undefined ? `at most ${limits.maxDuration}s` : ''}.
            </div>
          ) : null}

          {board.error ? <div className="vt-pill is-error">{board.error}</div> : null}

          {cut.clips.length === 0 && !board.loading ? (
            <div className="vt-empty">Nothing in the cut yet.</div>
          ) : null}

          <div className="vt-shots">
            {cut.clips.map((clip) => {
              const image = board.images.get(clip.image?.split('/').pop() ?? '');
              return (
                <div key={clip.panelId} className={`vt-shot${clip.adjusted ? ' is-adjusted' : ''}`}>
                  <span className="vt-shot-index">{clip.index + 1}</span>
                  <div className="vt-shot-thumb">
                    {image ? (
                      <img src={image.src} alt={`Shot ${clip.index + 1}`} />
                    ) : (
                      <span className="vt-faint">no image</span>
                    )}
                  </div>
                  <div className="vt-shot-body">
                    <div className="vt-row" style={{ gap: 6 }}>
                      <strong>{clip.shot}</strong>
                      <span className="vt-faint">{clip.scene}</span>
                      <span className="vt-spacer" />
                      <span className="vt-faint">
                        {clip.startSec.toFixed(1)}s → {clip.endSec.toFixed(1)}s · {clip.frames}f
                      </span>
                    </div>
                    {clip.dialog ? <div className="vt-shot-line">{clip.dialog}</div> : null}
                    {clip.action ? <div className="vt-shot-line vt-faint">{clip.action}</div> : null}
                    <input
                      className="vt-shot-note"
                      value={clip.note}
                      placeholder="note on this shot's timing"
                      aria-label={`Note for shot ${clip.index + 1}`}
                      onChange={(event) =>
                        patch(withOverride(data, clip.panelId, { note: event.target.value }))
                      }
                    />
                  </div>
                  <div className="vt-shot-timing">
                    <label className="vt-faint" style={{ fontSize: 10 }}>
                      hold
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={clip.durationSec}
                        aria-label={`Hold for shot ${clip.index + 1}`}
                        onChange={(event) =>
                          patch(
                            withOverride(data, clip.panelId, {
                              durationSec: Math.max(0.1, Number(event.target.value) || 0.1),
                            }),
                          )
                        }
                      />
                    </label>
                    <span className="vt-faint" style={{ fontSize: 10 }}>
                      board {clip.boardDurationSec.toFixed(1)}s
                    </span>
                    <div className="vt-row" style={{ gap: 4 }}>
                      {clip.adjusted ? (
                        <button
                          type="button"
                          className="vt-btn is-ghost is-small"
                          title="Follow the board again"
                          onClick={() => patch(withOverride(data, clip.panelId, { durationSec: undefined }))}
                        >
                          ↺
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="vt-btn is-ghost is-small is-danger"
                        title="Cut this shot out of the animatic"
                        onClick={() => patch(withOverride(data, clip.panelId, { skip: true }))}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {cut.skipped.length > 0 ? (
            <div className="vt-section">
              <h3>Cut out</h3>
              <div className="vt-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {cut.skipped.map((skip) => (
                  <button
                    key={skip.panelId}
                    type="button"
                    className="vt-btn is-small"
                    title="Put this shot back in"
                    onClick={() => patch(withOverride(data, skip.panelId, { skip: false }))}
                  >
                    + {skip.boardIndex + 1} · {skip.shot}
                    {skip.dialog ? ` — ${skip.dialog.split('\n')[0]?.slice(0, 30)}` : ''}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </EditorShell>

      {playing ? (
        <Playblast
          clips={clips}
          settings={{ width: cut.width, height: cut.height }}
          title={`Animatic — ${formatDuration(cut.durationSec)}`}
          onClose={() => setPlaying(false)}
        />
      ) : null}
    </>
  );
}
