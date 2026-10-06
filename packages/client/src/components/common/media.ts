import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Conversion,
  EncodedPacketSink,
  Input,
  MkvOutputFormat,
  Mp4OutputFormat,
  Output,
  QUALITY_VERY_HIGH,
  UrlSource,
  WebMOutputFormat,
  canEncodeVideo,
  type InputVideoTrack,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';
import { snapFrameRate, type ClipFormat, type VideoFacts } from '@vibetoon/shared';

/**
 * Video read and written by its frames, not by playing it.
 *
 * Everything here goes through the file's own packets (with Mediabunny, over
 * WebCodecs): a video's length is the end of its last frame, its frame count
 * is how many frames it holds, and a frame is the one the file holds at a time.
 * The other way — a `<video>` element, a seek and a hope, or a recorder
 * capturing the page as it plays — is what made clips whose length nothing
 * agreed on and whose frames froze. Where this browser cannot decode a file
 * this way, the callers fall back to the element (see `frames.ts`).
 */

/** Packets looked at to count frames; past this the count is worked out from the rate. */
const COUNTED_PACKETS = 20_000;

function inputFor(url: string | Blob): Input {
  return new Input({ source: typeof url === 'string' ? new UrlSource(url) : new BlobSource(url), formats: ALL_FORMATS });
}

async function videoTrack(input: Input): Promise<InputVideoTrack> {
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('there is no picture in this file');
  if (!(await track.canDecode())) throw new Error(`this browser cannot decode ${track.codec ?? 'this video'} from the file`);
  return track;
}

async function factsOf(track: InputVideoTrack): Promise<VideoFacts> {
  const [first, duration, stats] = await Promise.all([track.getFirstTimestamp(), track.computeDuration(), track.computePacketStats(COUNTED_PACKETS)]);
  const span = Math.max(1e-6, duration - first);
  const counted = stats.packetCount < COUNTED_PACKETS;
  const fps = snapFrameRate(counted ? stats.packetCount / span : stats.averagePacketRate);
  const frames = Math.max(1, counted ? stats.packetCount : Math.round(span * fps));
  return { first, duration, last: Math.max(first, duration - 1 / fps), frames, fps, width: track.displayWidth, height: track.displayHeight, exact: true };
}

/** A video's length, frame count and frame rate, from its packets. Null when it cannot be read this way. */
export async function readVideoFacts(url: string): Promise<VideoFacts | null> {
  if (typeof VideoDecoder === 'undefined') return null;
  const input = inputFor(url);
  try {
    return await factsOf(await videoTrack(input));
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

export interface ExactVideo {
  facts: VideoFacts;
  /** When each frame is shown, first to last, as the file has them. */
  frameTimes(): Promise<number[]>;
  /**
   * The frame shown at each of `times` (ascending) — the last whose time is at
   * or before it — handed to `use` one at a time, as a canvas that is reused:
   * draw from it before `use` returns.
   */
  read(times: readonly number[], use: (frame: { time: number; shownAt: number; image: CanvasImageSource }) => void | Promise<void>, stopped?: () => boolean): Promise<void>;
  close(): void;
}

/** Open a video to take frames out of it exactly. Throws when this browser cannot. */
export async function openExactVideo(url: string): Promise<ExactVideo> {
  if (typeof VideoDecoder === 'undefined') throw new Error('this browser has no video decoder to call on');
  const input = inputFor(url);
  try {
    const track = await videoTrack(input);
    const facts = await factsOf(track);
    return {
      facts,
      async frameTimes() {
        const times: number[] = [];
        for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
          times.push(packet.timestamp);
          if (times.length >= 200_000) break;
        }
        // Packets come in decode order; frames are shown in time order.
        return times.sort((a, b) => a - b).filter((time, index, all) => index === 0 || time - all[index - 1]! > 1e-6);
      },
      async read(times, use, stopped) {
        if (times.length === 0) return;
        const sink = new CanvasSink(track, { poolSize: 2 });
        // Nothing is shown before the first frame: that is read as the first.
        const at = times.map((time) => Math.max(facts.first, time + 1e-6));
        let index = 0;
        for await (const wrapped of sink.canvasesAtTimestamps(at)) {
          const time = times[index++]!;
          if (stopped?.()) return;
          if (!wrapped) continue;
          await use({ time, shownAt: wrapped.timestamp, image: wrapped.canvas });
        }
      },
      close: () => input.dispose(),
    };
  } catch (reason) {
    input.dispose();
    throw reason;
  }
}

/* ---------------- writing ---------------- */

const CODEC: Record<string, VideoCodec> = { 'webm-vp9': 'vp9', 'webm-vp8': 'vp8', 'webm-av1': 'av1', 'mp4-h264': 'avc', 'mkv-h264': 'avc' };

function outputFormat(format: ClipFormat): OutputFormat {
  if (format.extension === 'mp4') return new Mp4OutputFormat({ fastStart: 'in-memory' });
  if (format.extension === 'mkv') return new MkvOutputFormat();
  return new WebMOutputFormat();
}

/** Whether this browser can encode a format frame by frame, at a size. */
export async function canEncodeExactly(format: ClipFormat, width = 1280, height = 720): Promise<boolean> {
  const codec = CODEC[format.id];
  if (!codec || typeof VideoEncoder === 'undefined') return false;
  try {
    return await canEncodeVideo(codec, { width: Math.max(2, width - (width % 2)), height: Math.max(2, height - (height % 2)) });
  } catch {
    return false;
  }
}

/**
 * A video file written one frame at a time from a canvas: frame `n` is shown
 * at `n / fps` for `1 / fps`, so a clip of `n` frames lasts exactly `n / fps`.
 *
 * The file is finished properly: its length written in its header, an index
 * (WebM Cues, an MP4 index at the front) and a whole picture at least every
 * second, so whatever reads it agrees on how long it is, how many frames it has
 * and can go straight to any of them.
 */
export interface ClipWriter {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
  /** Write what is on the canvas as the next frame. */
  add(): Promise<void>;
  frames(): number;
  finish(): Promise<Blob>;
  cancel(): Promise<void>;
}

/**
 * `seeThrough` keeps the canvas's transparency in the file (WebM with VP8 or
 * VP9, which carry it alongside the picture): a character on clear stays on
 * clear.
 */
export async function startClip(format: ClipFormat, width: number, height: number, fps: number, seeThrough = false): Promise<ClipWriter> {
  const codec = CODEC[format.id];
  if (!codec) throw new Error(`${format.label} cannot be written frame by frame`);
  const canvas = new OffscreenCanvas(Math.max(2, width - (width % 2)), Math.max(2, height - (height % 2)));
  const context = canvas.getContext('2d')!;
  const target = new BufferTarget();
  const output = new Output({ format: outputFormat(format), target });
  const source = new CanvasSource(canvas, { codec, quality: QUALITY_VERY_HIGH, keyFrameInterval: 1, latencyMode: 'quality', ...(seeThrough ? { alpha: 'keep' as const } : {}) });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  let written = 0;
  return {
    canvas,
    context,
    async add() {
      await source.add(written / fps, 1 / fps);
      written += 1;
    },
    frames: () => written,
    async finish() {
      await output.finalize();
      if (!target.buffer) throw new Error('nothing was written');
      return new Blob([target.buffer], { type: format.contentType });
    },
    async cancel() {
      await output.cancel();
    },
  };
}

/**
 * Finish a file a recorder wrote as it went — a live WebM has no length in
 * its header and no index — by copying its frames into a file that has both.
 * The frames are not re-encoded. Gives the recording back as it was if it
 * cannot be done.
 */
export async function finishRecording(blob: Blob, format: ClipFormat): Promise<Blob> {
  const input = inputFor(blob);
  try {
    const target = new BufferTarget();
    const output = new Output({ format: outputFormat(format), target });
    const conversion = await Conversion.init({ input, output, audio: { discard: true } });
    if (!conversion.isValid) return blob;
    await conversion.execute();
    return target.buffer ? new Blob([target.buffer], { type: format.contentType }) : blob;
  } catch {
    return blob;
  } finally {
    input.dispose();
  }
}
