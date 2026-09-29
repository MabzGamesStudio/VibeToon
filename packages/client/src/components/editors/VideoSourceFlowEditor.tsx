import { useCallback, useRef, useState } from 'react';
import {
  VIDEO_TYPES,
  emptyVideoSourceFlowData,
  formatMegabytes,
  summariseVideoSource,
  videoTypeLabel,
  type FlowNode,
  type Project,
  type VideoSourceFlowData,
  type VideoSourceInfo,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { formatWhen } from '../common/format';
import { clock } from '../common/video';
import { EditorShell } from './EditorShell';

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return url ?? '';
  }
}

/**
 * A video brought in: uploaded from this machine, or fetched from a link.
 *
 * Either way the file is written to the port straight away and kept with the
 * project, rather than fetched on each run. Its length and size are measured
 * here, by playing it.
 */
export function VideoSourceFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, uploadOutput, fetchOutput, notify, busyFlows } = useStudio();
  const data = node.data.editor === 'videoSource' ? (node.data as VideoSourceFlowData) : emptyVideoSourceFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const artifact = node.outputs.find((output) => output.port === 'video');
  const busy = busyFlows.includes(node.id);
  const [url, setUrl] = useState('');

  const patch = useCallback((over: Partial<VideoSourceFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);
  const videoUrl = artifact ? api.artifactUrl(project.id, artifact.path) : null;

  const record = (over: Omit<VideoSourceInfo, 'addedAt'>) => patch({ source: { ...over, addedAt: new Date().toISOString() } });

  const onFile = (chosen: File | undefined) => {
    if (!chosen) return;
    if (chosen.type && !chosen.type.startsWith('video/')) {
      notify('error', `${chosen.type} is not a video.`);
      return;
    }
    // The file goes as it is: a video can be far too big to read into the page as text.
    void uploadOutput(node.id, 'video', chosen.name, chosen).then((done) => {
      if (done) record({ origin: 'upload', fileName: chosen.name, contentType: chosen.type || 'video/mp4', bytes: chosen.size });
    });
  };

  const onFetch = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const result = await fetchOutput(node.id, 'video', trimmed);
    if (!result) return;
    record({ origin: 'link', fileName: result.artifact.fileName, contentType: result.source.contentType, bytes: result.source.bytes, url: result.source.url });
    setUrl('');
  };

  /** Measured once the browser has read the video: nothing on the server decodes one. */
  const onMeasured = (video: HTMLVideoElement) => {
    const source = dataRef.current.source;
    if (!source) return;
    if (!Number.isFinite(video.duration)) {
      // A video recorded in a browser often does not say how long it is until
      // it has been read to the end; seeking past the end makes it find out.
      if (video.readyState >= 1) video.currentTime = 1e101;
      return;
    }
    if (video.currentTime > video.duration - 0.05 && video.paused) video.currentTime = 0;
    const measured = { duration: Math.round(video.duration * 1000) / 1000, width: video.videoWidth, height: video.videoHeight };
    if (source.duration === measured.duration && source.width === measured.width && source.height === measured.height) return;
    patch({ source: { ...source, ...measured } });
  };

  const source = data.source;
  return (
    <EditorShell project={project} node={node}>
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Add a video</h3>
          <Field label="From this machine" hint="MP4, WebM, QuickTime, Ogg or Matroska — whatever this browser plays." tip="videoSource.upload">
            <input
              type="file"
              accept={['video/*', ...Object.keys(VIDEO_TYPES)].join(',')}
              onChange={(event) => {
                onFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </Field>
          <Field label="From a link" hint="The address of the video file itself, not the page it plays on." tip="videoSource.link">
            <div className="vt-row" style={{ gap: 4 }}>
              <input
                value={url}
                placeholder="https://…/clip.mp4"
                aria-label="Video address"
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void onFetch();
                }}
              />
              <button type="button" className="vt-btn is-small" disabled={busy || url.trim() === ''} onClick={() => void onFetch()}>
                {busy ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
          </Field>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.4 }}>
            The video is copied into this project, so it keeps working when the address it came from stops. Up to 256 MB
            from a link.
          </p>
        </div>

        <div className="vt-section">
          <h3>About it</h3>
          <Field label="What it is" hint="For whoever opens this project later.">
            <textarea rows={3} value={data.description} placeholder="Reference footage of a horse trotting." onChange={(event) => patch({ description: event.target.value })} />
          </Field>
          <Field label="Credit and terms" hint="Who made it, and on what terms." tip="videoSource.credit">
            <textarea rows={2} value={data.credit} placeholder="Footage: A. Nother, CC BY 4.0" onChange={(event) => patch({ credit: event.target.value })} />
          </Field>
        </div>

        {source ? (
          <div className="vt-section">
            <h3>The file</h3>
            <dl className="vt-kv">
              <dt>Name</dt>
              <dd>
                <code>{source.fileName}</code>
              </dd>
              <dt>Format</dt>
              <dd>{videoTypeLabel(source.contentType)}</dd>
              <dt>Size</dt>
              <dd>{formatMegabytes(source.bytes)}</dd>
              <dt>Length</dt>
              <dd>{source.duration !== undefined ? clock(source.duration) : '—'}</dd>
              <dt>Dimensions</dt>
              <dd>{source.width && source.height ? `${source.width} × ${source.height}` : '—'}</dd>
              <dt>Came from</dt>
              <dd>
                {source.origin === 'link' ? (
                  <a href={source.url} target="_blank" rel="noreferrer noopener">
                    {hostOf(source.url)}
                  </a>
                ) : (
                  'this machine'
                )}
              </dd>
              <dt>Added</dt>
              <dd>{formatWhen(source.addedAt)}</dd>
            </dl>
          </div>
        ) : null}
      </aside>

      <div className="vt-editor-main">
        {videoUrl ? (
          <video
            key={videoUrl}
            className="vt-video-player"
            src={videoUrl}
            controls
            playsInline
            preload="metadata"
            aria-label="The video"
            onLoadedMetadata={(event) => onMeasured(event.currentTarget)}
            onDurationChange={(event) => onMeasured(event.currentTarget)}
          />
        ) : (
          <div className="vt-empty">No video yet. Upload a file or fetch a link on the left.</div>
        )}
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summariseVideoSource(source)}
        </p>
        {source && !artifact ? (
          <div className="vt-sync-banner">
            <span>The video is recorded but its file is missing — the project may have been copied without its files. Add it again.</span>
          </div>
        ) : null}
      </div>
    </EditorShell>
  );
}
