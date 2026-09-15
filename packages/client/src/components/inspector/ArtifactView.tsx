import { useCallback, useEffect, useState } from 'react';
import { isTextualArtifact, type ArtifactRef } from '@vibetoon/shared';
import { api } from '../../api/client';
import { formatBytes, formatWhen } from '../common/format';

export interface ArtifactViewProps {
  projectId: string;
  artifact: ArtifactRef;
  /** Open by default, e.g. in the flow editor's output panel. */
  defaultOpen?: boolean;
}

export function ArtifactView({ projectId, artifact, defaultOpen = false }: ArtifactViewProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState<string | null>(artifact.preview ?? null);
  const [error, setError] = useState<string | null>(null);
  const url = api.artifactUrl(projectId, artifact.path);

  useEffect(() => {
    if (!open || !isTextualArtifact(artifact.kind)) return;
    let cancelled = false;
    void api
      .artifactText(projectId, artifact.path)
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.hash, artifact.kind, artifact.path, open, projectId]);

  /**
   * A video recorded in the browser has no duration in its header — the format
   * is written for streaming — so the scrubber is dead until the player has
   * seeked past the last frame. Doing that once on load fixes it.
   */
  const resolveDuration = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (Number.isFinite(video.duration)) return;
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      video.currentTime = 0;
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = 1e6;
  }, []);

  return (
    <div className="vt-artifact">
      <div className="vt-artifact-head">
        <button
          type="button"
          className="vt-btn is-ghost is-small"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="vt-artifact-name" title={artifact.path}>
          {artifact.fileName}
        </span>
        <span className="vt-spacer" />
        <a className="vt-faint" href={url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
          open
        </a>
      </div>
      <div className="vt-artifact-meta">
        {artifact.port} · {artifact.kind} · {formatBytes(artifact.bytes)}
        {artifact.entries ? ` · ${artifact.entries.length} file(s)` : ''} · {formatWhen(artifact.generatedAt)}
      </div>

      {open ? (
        <div className="vt-artifact-preview">
          {error ? <div className="vt-pill is-error">{error}</div> : null}
          {artifact.kind === 'image' ? <img src={url} alt={artifact.fileName} /> : null}
          {artifact.kind === 'video' ? <video src={url} controls onLoadedMetadata={resolveDuration} /> : null}
          {artifact.kind === 'audio' ? <audio src={url} controls /> : null}
          {artifact.kind === 'imageSet' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 6 }}>
              {(artifact.entries ?? []).map((entry) => (
                <a key={entry} href={`${url}/${entry}`} target="_blank" rel="noreferrer" title={entry}>
                  <img src={`${url}/${entry}`} alt={entry} />
                </a>
              ))}
            </div>
          ) : null}
          {artifact.kind === 'audioSet' ? (
            <div style={{ display: 'grid', gap: 4 }}>
              {(artifact.entries ?? []).map((entry) => (
                <div key={entry}>
                  <div className="vt-faint" style={{ fontSize: 11 }}>
                    {entry}
                  </div>
                  <audio src={`${url}/${entry}`} controls />
                </div>
              ))}
            </div>
          ) : null}
          {isTextualArtifact(artifact.kind) ? <pre>{text ?? 'Loading…'}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
