import { tmpdir } from 'node:os';
import { sniffVideoType, videoNeedsConversion, videoTypeLabel } from '@vibetoon/shared';
import { convertToMp4, hasFfmpeg } from '../render/video';
import { HttpError } from '../storage';

/**
 * A video as a browser can play it. Most arrive that way already (MP4, WebM,
 * QuickTime, Ogg, Matroska) and are kept as they are. One a browser cannot
 * open at all — AVI, Windows Media, Flash, an MPEG stream — is converted to
 * MP4 with ffmpeg; without ffmpeg it is turned away with what to do, rather
 * than kept where every flow that reads it would fail.
 */
export async function playableVideo(bytes: Uint8Array, fileName: string): Promise<{ bytes: Uint8Array; fileName: string; convertedFrom?: string }> {
  const type = sniffVideoType(bytes);
  if (!videoNeedsConversion(type)) return { bytes, fileName };
  const label = videoTypeLabel(type!);
  if (!hasFfmpeg()) {
    throw new HttpError(415, `This is ${label}, which a browser cannot play. Install ffmpeg (or set VIBETOON_FFMPEG to where it is) and add it again, and it is converted to MP4 as it arrives — or convert it to MP4 or WebM first.`);
  }
  const converted = await convertToMp4(bytes, tmpdir());
  if (!converted) throw new HttpError(422, `This ${label} could not be converted to MP4 by ffmpeg.`);
  return { bytes: converted, fileName: `${fileName.replace(/\.[a-z0-9]+$/i, '') || 'video'}.mp4`, convertedFrom: label };
}
