import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IMAGE_CONTENT_TYPES,
  describeSize,
  emptyImageFlowData,
  formatBytes,
  hostOf,
  imageTypeLabel,
  imageWarnings,
  summariseImage,
  type FlowNode,
  type ImageFlowData,
  type ImageSource,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { Stage } from '../common/Stage';
import { formatWhen } from '../common/format';
import { EditorShell } from './EditorShell';

/**
 * A picture into the graph.
 *
 * Before this flow the only way to get an image in was to find some other flow
 * with a spare image output and upload onto that port, which works and is not
 * something anyone would guess. This is the door, and it does the two things
 * people actually have: a file on this machine, or an address.
 *
 * Either way the bytes are written to the port straight away rather than fetched
 * on each run. A link that works today is not a link that works next year, and a
 * flow that needs the network to tell you what its picture is would be a flow
 * that stops working on a train.
 */
export function ImageFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, uploadOutput, fetchOutput, notify, busyFlows } = useStudio();
  const data = node.data.editor === 'image' ? (node.data as ImageFlowData) : emptyImageFlowData();
  const artifact = node.outputs.find((output) => output.port === 'image');
  const busy = busyFlows.includes(node.id);

  const [url, setUrl] = useState('');
  const file = useRef<HTMLInputElement | null>(null);

  const patch = useCallback(
    (over: Partial<ImageFlowData>) => setFlowData(node.id, { ...data, ...over }),
    [data, node.id, setFlowData],
  );

  const imageUrl = useMemo(
    () => (artifact ? api.artifactUrl(project.id, artifact.path) : null),
    [artifact, project.id],
  );

  /**
   * Measure the picture once the browser has decoded it. Nothing on the server
   * decodes an image, so its own dimensions are something only this side knows —
   * and they are the number that decides whether everything downstream is quick.
   */
  useEffect(() => {
    if (!imageUrl || !data.source) return;
    if (data.source.width !== undefined && data.source.height !== undefined) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      patch({
        source: { ...data.source!, width: image.naturalWidth, height: image.naturalHeight },
      });
    };
    image.onerror = () => {
      if (!cancelled) notify('error', 'The browser could not decode that image.');
    };
    image.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [data.source, imageUrl, notify, patch]);

  const record = (over: Omit<ImageSource, 'addedAt'>) =>
    patch({ source: { ...over, addedAt: new Date().toISOString() } });

  const onFile = (chosen: File | undefined) => {
    if (!chosen) return;
    if (chosen.type && !IMAGE_CONTENT_TYPES.includes(chosen.type)) {
      notify('error', `${chosen.type} is not an image this studio can read.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      await uploadOutput(node.id, 'image', chosen.name, String(reader.result));
      record({
        origin: 'upload',
        fileName: chosen.name,
        contentType: chosen.type || 'image/png',
        bytes: chosen.size,
      });
    };
    reader.onerror = () => notify('error', 'Could not read that file.');
    reader.readAsDataURL(chosen);
  };

  const onFetch = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const result = await fetchOutput(node.id, 'image', trimmed);
    if (!result) return;
    record({
      origin: 'link',
      fileName: result.artifact.fileName,
      contentType: result.source.contentType,
      bytes: result.source.bytes,
      url: result.source.url,
    });
    setUrl('');
  };

  const warnings = imageWarnings(data.source);

  return (
    <EditorShell project={project} node={node}>
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Add a picture</h3>

          <Field
            label="From this machine"
            hint="PNG, JPEG, WebP, GIF, AVIF, BMP or SVG."
            tip="image.upload"
          >
            <input
              ref={file}
              type="file"
              accept={IMAGE_CONTENT_TYPES.join(',')}
              onChange={(event) => {
                onFile(event.target.files?.[0]);
                // Cleared so choosing the same file twice fires again, which is
                // what you do after editing it in another program.
                event.target.value = '';
              }}
            />
          </Field>

          <Field
            label="From a link"
            hint="The address of the image itself, not the page it sits on."
            tip="image.link"
          >
            <div className="vt-row" style={{ gap: 4 }}>
              <input
                value={url}
                placeholder="https://…"
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void onFetch();
                }}
              />
              <button
                type="button"
                className="vt-btn is-small"
                disabled={busy || url.trim() === ''}
                onClick={() => void onFetch()}
              >
                {busy ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
          </Field>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.4 }}>
            The picture is copied into this project, so it keeps working when the
            address it came from stops.
          </p>
        </div>

        <div className="vt-section">
          <h3>About it</h3>
          <Field label="What it is" hint="For whoever opens this project later.">
            <textarea
              rows={3}
              value={data.description}
              placeholder="A reference photo of the harbour at dusk."
              onChange={(event) => patch({ description: event.target.value })}
            />
          </Field>
          <Field
            label="Credit and terms"
            hint="Who made it, and on what terms."
            tip="image.credit"
          >
            <textarea
              rows={2}
              value={data.credit}
              placeholder="Photo: A. Nother, CC BY 4.0"
              onChange={(event) => patch({ credit: event.target.value })}
            />
          </Field>
        </div>

        {data.source ? (
          <div className="vt-section">
            <h3>The file</h3>
            <dl className="vt-kv">
              <dt>Name</dt>
              <dd>
                <code>{data.source.fileName}</code>
              </dd>
              <dt>Format</dt>
              <dd>{imageTypeLabel(data.source.contentType)}</dd>
              <dt>Size</dt>
              <dd>{formatBytes(data.source.bytes)}</dd>
              <dt>Dimensions</dt>
              <dd>{describeSize(data.source)}</dd>
              <dt>Came from</dt>
              <dd>
                {data.source.origin === 'link' ? (
                  <a href={data.source.url} target="_blank" rel="noreferrer noopener">
                    {hostOf(data.source.url)}
                  </a>
                ) : (
                  'this machine'
                )}
              </dd>
              <dt>Added</dt>
              <dd>{formatWhen(data.source.addedAt)}</dd>
            </dl>
          </div>
        ) : null}
      </aside>

      <div className="vt-editor-main">
        <Stage title="The picture" zoomable>
          <div className="vt-image-stage">
            {imageUrl ? (
              <img src={imageUrl} alt={data.description || data.source?.fileName || 'The picture'} />
            ) : (
              <div className="vt-empty">
                No picture yet. Upload a file or fetch a link on the left.
              </div>
            )}
          </div>
        </Stage>

        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summariseImage(data)}
        </p>

        {warnings.length > 0 ? (
          <div className="vt-section">
            <h3>Worth knowing</h3>
            <ul className="vt-hints">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {data.source && !artifact ? (
          <div className="vt-sync-banner">
            <span>
              The image is recorded but its file is missing — the project may have been copied without its
              artifacts. Add it again.
            </span>
          </div>
        ) : null}
      </div>
    </EditorShell>
  );
}
