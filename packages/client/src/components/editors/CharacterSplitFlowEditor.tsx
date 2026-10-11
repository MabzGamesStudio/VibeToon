import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CLIP_FORMATS,
  applyCharacterEdits,
  characterBox,
  characterFrameName,
  characterImage,
  characterName,
  characterSlug,
  characterWork,
  charactersFile,
  charactersReport,
  emptyCharacterSplitFlowData,
  frameRateOfTimes,
  inputsForPort,
  readFrameName,
  sheetLayout,
  type Bitmap,
  type CharacterResult,
  type CharacterSplitFlowData,
  type FlowNode,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useBatchRun, waitUntil } from '../../state/batchRun';
import { useStudio } from '../../state/store';
import { pngDataUrl, readBitmap } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { canEncodeExactly, startClip } from '../common/media';
import { inSlices, textDataUrl } from '../common/slices';
import { blobDataUrl } from './renderVideo';
import { paintBitmap } from './CropFlowEditor';
import { EditorShell } from './EditorShell';

interface ReadFrame {
  name: string;
  time: number | null;
  bitmap: Bitmap;
}

/** A colour for each character, apart from its neighbours'. */
function tintOf(place: number): [number, number, number] {
  const hue = (place * 137.508) % 360;
  const c = 0.75;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + 0.2) * 255), Math.round((g + 0.2) * 255), Math.round((b + 0.2) * 255)];
}

/** A frame with each character's pixels tinted its colour, or only one character's. */
function shownBitmap(frame: Bitmap, owner: Uint8Array, only: number | null): Bitmap {
  const out = new Uint8ClampedArray(frame.data.length);
  for (let p = 0; p < owner.length; p += 1) {
    const who = owner[p]!;
    const at = p * 4;
    if (only !== null) {
      if (who !== only + 1) continue;
      out.set(frame.data.subarray(at, at + 4), at);
      continue;
    }
    if (frame.data[at + 3] === 0) continue;
    if (!who) {
      // Kept in the frames but nobody's: shown faint.
      out.set([frame.data[at]!, frame.data[at + 1]!, frame.data[at + 2]!, 90], at);
      continue;
    }
    const [r, g, b] = tintOf(who - 1);
    out.set([(frame.data[at]! + r) >> 1, (frame.data[at + 1]! + g) >> 1, (frame.data[at + 2]! + b) >> 1, 255], at);
  }
  return { width: frame.width, height: frame.height, data: out };
}

/**
 * Splitting a video's foreground frames into characters (see `characterWork`).
 *
 * The frames are read from the folder wired in and kept while the editor is
 * open; the characters are found a slice at a time whenever a setting
 * changes. Characters can be named, joined and left out by hand.
 */
export function CharacterSplitFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, notify, generateFlow } = useStudio();
  const data = node.data.editor === 'characterSplit' ? (node.data as CharacterSplitFlowData) : emptyCharacterSplitFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<CharacterSplitFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);

  const input = inputsForPort(project, node.id, 'frames').find((one) => one.artifact)?.artifact;
  const entries = useMemo(
    () => [...(input?.entries ?? [])].filter((entry) => /\.(png|jpe?g|webp)$/i.test(entry)).sort((a, b) => readFrameName(a).index - readFrameName(b).index || (a < b ? -1 : 1)),
    [input?.entries],
  );

  /* ---------------- reading the frames ---------------- */

  const [frames, setFrames] = useState<ReadFrame[]>([]);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const read = useCallback(async (): Promise<ReadFrame[]> => {
    if (!input || entries.length === 0) return [];
    setRunning({ done: 0, total: entries.length });
    const got: ReadFrame[] = [];
    try {
      for (const entry of entries) {
        const bitmap = await readBitmap(api.artifactUrl(project.id, `${input.path}/${entry}`), { maxPixels: 16_000_000 });
        if (got[0] && (bitmap.width !== got[0].bitmap.width || bitmap.height !== got[0].bitmap.height)) throw new Error(`${entry} is ${bitmap.width} × ${bitmap.height}, not ${got[0].bitmap.width} × ${got[0].bitmap.height} like the frames before it`);
        got.push({ name: entry, time: readFrameName(entry).time, bitmap });
        setRunning({ done: got.length, total: entries.length });
      }
    } catch (reason) {
      notify('error', `Could not read the frames: ${(reason as Error).message}`);
      return [];
    } finally {
      setRunning(null);
    }
    setFrames(got);
    const was = dataRef.current.frames;
    const same = was?.hash === input.hash;
    patch({
      frames: { hash: input.hash, count: got.length, width: got[0]!.bitmap.width, height: got[0]!.bitmap.height },
      // Edits name characters found in these frames: other frames, other characters.
      ...(same ? {} : { names: {}, joined: [], dropped: [], current: null, frame: null }),
    });
    return got;
  }, [entries, input, notify, patch, project.id]);

  /* ---------------- finding the characters ---------------- */

  const [found, setFound] = useState<CharacterResult | null>(null);
  const [working, setWorking] = useState<{ stage: string; done: number; total: number } | null>(null);
  const { join, minArea, sameness, maxMove, minFrames } = data;
  useEffect(() => {
    if (frames.length === 0) {
      setFound(null);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setWorking({ stage: 'pieces', done: 0, total: frames.length });
        const made = await inSlices(characterWork(frames.map((frame) => frame.bitmap), { join, minArea, sameness, maxMove, minFrames }), setWorking, () => cancelled);
        if (!made || cancelled) return;
        setFound(made);
        setWorking(null);
      })();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [frames, join, minArea, sameness, maxMove, minFrames]);
  const result = useMemo(() => (found ? applyCharacterEdits(found, data) : null), [found, data.joined, data.dropped]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- writing ---------------- */

  const [writing, setWriting] = useState<string | null>(null);
  const send = async (list: readonly ReadFrame[], made: CharacterResult) => {
    const settings = dataRef.current;
    const names = list.map((frame) => frame.name);
    const times = list.map((frame) => frame.time);
    const boxes = made.characters.map((character) => characterBox(character, made.width, made.height));
    const attachments: Array<{ name: string; data: string }> = [];
    const fps = frameRateOfTimes(times);
    const clipFormat = (await canEncodeExactly(CLIP_FORMATS[0]!, 640, 360)) ? CLIP_FORMATS[0]! : (await canEncodeExactly(CLIP_FORMATS[1]!, 640, 360)) ? CLIP_FORMATS[1]! : null;
    for (const [place, character] of made.characters.entries()) {
      setWriting(`Writing ${characterName(settings, character.id)} (${place + 1} of ${made.characters.length})`);
      const box = boxes[place]!;
      // Its frames, the size the frames were.
      for (const appearance of character.frames) {
        attachments.push({ name: `frames/${characterFrameName(place, names[appearance.frame]!)}`, data: await pngDataUrl(characterImage(list[appearance.frame]!.bitmap, made.owners[appearance.frame]!, place)) });
      }
      // Its sheet: its frames side by side, each cut to the box round all of them.
      const layout = sheetLayout(character.frames.length, box);
      const sheet = new OffscreenCanvas(layout.width, layout.height);
      const sheetContext = sheet.getContext('2d')!;
      const cell = new OffscreenCanvas(box.width, box.height);
      const cellContext = cell.getContext('2d')!;
      const drawCell = (frame: number) => {
        const image = characterImage(list[frame]!.bitmap, made.owners[frame]!, place);
        const crop = new ImageData(box.width, box.height);
        for (let y = 0; y < box.height; y += 1) {
          const from = ((box.y + y) * image.width + box.x) * 4;
          crop.data.set(image.data.subarray(from, from + box.width * 4), y * box.width * 4);
        }
        cellContext.putImageData(crop, 0, 0);
      };
      character.frames.forEach((appearance, index) => {
        drawCell(appearance.frame);
        const at = layout.at(index);
        sheetContext.drawImage(cell, at.x, at.y);
      });
      attachments.push({ name: `sheets/${characterSlug(place)}.png`, data: await blobDataUrl(await sheet.convertToBlob({ type: 'image/png' })) });
      // Its clip: from its first frame to its last, see-through, clear where it is not.
      if (clipFormat) {
        const writer = await startClip(clipFormat, box.width, box.height, fps, true);
        const firstFrame = character.frames[0]!.frame;
        const lastFrame = character.frames[character.frames.length - 1]!.frame;
        const present = new Set(character.frames.map((appearance) => appearance.frame));
        for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
          writer.context.clearRect(0, 0, box.width, box.height);
          if (present.has(frame)) {
            drawCell(frame);
            writer.context.drawImage(cell, 0, 0);
          }
          await writer.add();
        }
        attachments.push({ name: `characters/${characterSlug(place)}.webm`, data: await blobDataUrl(await writer.finish()) });
      }
    }
    if (!clipFormat) notify('info', 'This browser cannot write WebM frame by frame, so the characters come out as sheets and frames, without clips.');
    attachments.push({ name: 'characters.json', data: textDataUrl(charactersFile(settings, made, names, times, boxes), 'application/json') });
    attachments.push({ name: 'characters.md', data: textDataUrl(charactersReport(settings, made, names)) });
    setWriting(null);
    await generateFlow(node.id, attachments);
  };

  const onGenerate = async () => {
    if (!result) {
      await generateFlow(node.id);
      return;
    }
    try {
      await send(frames, result);
    } catch (reason) {
      setWriting(null);
      notify('error', `Could not write the characters: ${(reason as Error).message}`);
    }
  };

  // Generate all, for one item of a batch: read its frames, find its characters, and send them.
  const readRef = useRef(read);
  readRef.current = read;
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useBatchRun(node, async () => {
    await waitUntil(() => (entriesRef.current.length > 0 ? true : null), 'Waiting for the frames');
    const got = framesRef.current.length > 0 ? framesRef.current : await readRef.current();
    if (got.length === 0) throw new Error('no frames could be read');
    const settings = dataRef.current;
    const made = await inSlices(characterWork(got.map((frame) => frame.bitmap), settings), setWorking, () => false);
    setWorking(null);
    if (!made) throw new Error('the characters could not be found');
    await send(got, applyCharacterEdits(made, settings));
  });

  /* ---------------- what is shown ---------------- */

  const frameIndex = data.frame !== null && data.frame < frames.length ? data.frame : 0;
  const currentPlace = result && data.current ? result.characters.findIndex((character) => character.id === data.current) : -1;
  const picture = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const frame = frames[frameIndex];
    if (!frame) {
      paintBitmap(picture.current, null);
      return;
    }
    paintBitmap(picture.current, result ? shownBitmap(frame.bitmap, result.owners[frameIndex]!, currentPlace >= 0 ? currentPlace : null) : frame.bitmap);
  }, [frames, frameIndex, result, currentPlace]);

  const ids = found?.characters.map((character) => character.id) ?? [];
  const joinedInto = (id: string) => data.joined.find(([, gone]) => gone === id)?.[0] ?? '';
  const setJoined = (id: string, into: string) => patch({ joined: [...data.joined.filter(([, gone]) => gone !== id), ...(into ? ([[into, id]] as Array<[string, string]>) : [])] });
  const blocked = !input ? 'No frames — wire a folder of frames with only the characters left (from Video Foreground) into Frames.' : entries.length === 0 ? 'The folder wired in has no pictures in it yet.' : null;

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={onGenerate}
      banner={blocked ? <div className="vt-sync-banner"><span>{blocked}</span></div> : writing ? <div className="vt-sync-banner"><span>{writing}…</span></div> : undefined}
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Frames</h3>
          <p className="vt-faint" style={{ fontSize: 11 }}>
            {entries.length > 0 ? `${entries.length} frame(s) in the folder wired in${frames.length > 0 ? `, read at ${frames[0]!.bitmap.width} × ${frames[0]!.bitmap.height}` : ''}.` : '—'}
          </p>
          {running ? (
            <progress max={running.total} value={running.done} style={{ width: '100%' }} />
          ) : (
            <button type="button" className="vt-btn is-primary is-small" disabled={entries.length === 0} onClick={() => void read()}>
              {frames.length > 0 ? 'Read the frames again' : 'Read the frames'}
            </button>
          )}
        </div>

        <div className="vt-section">
          <h3>Finding the characters</h3>
          <p className="vt-hint">
            Each frame’s pieces are given an embedding — their colours. Pieces alike in colour are one character, learnt where the characters are apart. Where they touch,
            the piece is split pixel by pixel: to whichever character’s colours it fits and whichever was nearest in the frames next to it.
          </p>
          <Slider range="characterSplit.join" label="Join pieces within" tip="characterSplit.join" value={data.join} format={(value) => `${Math.round(value)} px`} onChange={(value) => patch({ join: Math.round(value) })} />
          <Slider range="characterSplit.minArea" label="Smallest piece" tip="characterSplit.minArea" value={data.minArea} format={(value) => `${Math.round(value)} px`} onChange={(value) => patch({ minArea: Math.round(value) })} />
          <Slider range="characterSplit.sameness" label="Sameness" tip="characterSplit.sameness" value={data.sameness} format={(value) => `${Math.round(value)}%`} onChange={(value) => patch({ sameness: Math.round(value) })} />
          <Slider range="characterSplit.maxMove" label="Most a character moves" tip="characterSplit.maxMove" value={data.maxMove} format={(value) => `${Math.round(value)} px`} onChange={(value) => patch({ maxMove: Math.round(value) })} />
          <Slider range="characterSplit.minFrames" label="Least frames" tip="characterSplit.minFrames" value={data.minFrames} format={(value) => `${Math.round(value)}`} onChange={(value) => patch({ minFrames: Math.round(value) })} />
          {working ? (
            <div className="vt-row" style={{ gap: 6 }}>
              <span className="vt-faint" style={{ fontSize: 11 }}>{working.stage === 'pieces' ? 'Finding the pieces' : working.stage === 'group' ? 'Grouping by colour' : 'Sharing out the pieces'}…</span>
              <progress max={working.total} value={working.done} style={{ flex: 1 }} />
            </div>
          ) : null}
          <dl className="vt-kv">
            <dt>Pieces</dt>
            <dd>{found ? found.stats.pieces : '—'}</dd>
            <dt>Split</dt>
            <dd>{found ? `${found.stats.split} piece(s) shared out` : '—'}</dd>
            <dt>Too few frames</dt>
            <dd>{found ? found.stats.tooFew : '—'}</dd>
          </dl>
        </div>

        <div className="vt-section">
          <h3>Characters{result ? ` (${result.characters.length})` : ''}</h3>
          {!found ? (
            <p className="vt-hint">Read the frames to find the characters.</p>
          ) : (
            <ul className="vt-char-list">
              {found.characters.map((character, index) => {
                const out = data.dropped.includes(character.id);
                const into = joinedInto(character.id);
                const place = result ? result.characters.findIndex((one) => one.id === character.id) : -1;
                const [r, g, b] = tintOf(place >= 0 ? place : index);
                return (
                  <li key={character.id} className={`vt-char${data.current === character.id ? ' is-on' : ''}${out || into ? ' is-out' : ''}`}>
                    <div className="vt-row" style={{ gap: 6, alignItems: 'center' }}>
                      <span className="vt-char-swatch" style={{ background: `rgb(${r},${g},${b})` }} title="Its colour here" />
                      <span className="vt-char-palette">
                        {character.palette.map((colour) => (
                          <i key={colour} style={{ background: colour }} title={colour} />
                        ))}
                      </span>
                      <input
                        className="vt-char-name"
                        value={data.names[character.id] ?? ''}
                        placeholder={characterName({ names: {} }, character.id)}
                        aria-label={`Name of ${characterName(data, character.id)}`}
                        onChange={(event) => patch({ names: { ...data.names, [character.id]: event.target.value } })}
                      />
                    </div>
                    <div className="vt-row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
                      <span className="vt-faint">
                        {character.frames.length} frame(s){character.frames.some((appearance) => appearance.split) ? `, split in ${character.frames.filter((appearance) => appearance.split).length}` : ''}
                      </span>
                      <button type="button" className="vt-btn is-ghost is-small" onClick={() => patch({ current: data.current === character.id ? null : character.id, frame: data.current === character.id ? data.frame : character.frames[0]!.frame })}>
                        {data.current === character.id ? 'Show all' : 'Show only'}
                      </button>
                      <label className="vt-row" style={{ gap: 4 }}>
                        <input type="checkbox" checked={out} onChange={(event) => patch({ dropped: event.target.checked ? [...data.dropped, character.id] : data.dropped.filter((id) => id !== character.id) })} />
                        Leave out
                      </label>
                      <select aria-label={`Join ${characterName(data, character.id)} to`} value={into} onChange={(event) => setJoined(character.id, event.target.value)}>
                        <option value="">Not joined</option>
                        {ids
                          .filter((id) => id !== character.id)
                          .map((id) => (
                            <option key={id} value={id}>
                              Is {characterName(data, id)}
                            </option>
                          ))}
                      </select>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage zoomable title={frames[frameIndex] ? `${frames[frameIndex]!.name}${currentPlace >= 0 ? ` · ${characterName(data, data.current!)} only` : ''}` : 'Frames'}>
          {() => (
            <div className="vt-resize-stage">
              {frames.length === 0 ? (
                <div className="vt-empty">{blocked ?? (running ? `Reading frame ${running.done} of ${running.total}…` : 'Read the frames to find the characters in them.')}</div>
              ) : (
                <div className="vt-crop-frame">
                  <canvas ref={picture} className="vt-crop-canvas" style={{ imageRendering: 'pixelated' }} />
                </div>
              )}
            </div>
          )}
        </Stage>
        {frames.length > 0 ? (
          <div className="vt-bg-strip" role="listbox" aria-label="Frames">
            {frames.map((frame, index) => {
              const here = result?.characters.filter((character) => character.frames.some((appearance) => appearance.frame === index)) ?? [];
              return (
                <button
                  key={frame.name}
                  type="button"
                  role="option"
                  aria-selected={index === frameIndex}
                  className={`vt-bg-thumb${index === frameIndex ? ' is-on' : ''}`}
                  title={`${frame.name}: ${here.map((character) => characterName(data, character.id)).join(', ') || 'nobody'}`}
                  onClick={() => patch({ frame: index })}
                >
                  <span className="vt-char-dots">
                    {here.map((character) => {
                      const [r, g, b] = tintOf(result!.characters.indexOf(character));
                      return <i key={character.id} style={{ background: `rgb(${r},${g},${b})` }} />;
                    })}
                  </span>
                  <span>{frame.time !== null ? `${frame.time.toFixed(2)}s` : `#${index + 1}`}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </EditorShell>
  );
}
