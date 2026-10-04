import { CLIP_FORMATS, clipFormat, type ClipFormatId } from '@vibetoon/shared';
import { recordingType } from './renderVideo';

/**
 * What a recording is written as. Every format is listed; the ones this
 * browser cannot record are greyed out with why, rather than hidden, so it is
 * clear what another browser would give.
 */
export function ClipFormatPicker({ value, onChange, label = 'Recorded as' }: { value: ClipFormatId | undefined; onChange(id: ClipFormatId): void; label?: string }): JSX.Element {
  const chosen = clipFormat(value);
  const canRecord = Boolean(recordingType(chosen));
  return (
    <div style={{ marginTop: 6 }}>
      <div className="vt-row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="vt-faint">{label}</span>
        <div className="vt-facet-values" role="radiogroup" aria-label={label}>
          {CLIP_FORMATS.map((format) => {
            const supported = Boolean(recordingType(format));
            return (
              <button
                key={format.id}
                type="button"
                className={`vt-chip${chosen.id === format.id ? ' is-on' : ''}`}
                aria-pressed={chosen.id === format.id}
                disabled={!supported}
                title={supported ? `.${format.extension} — ${format.contentType}` : `This browser cannot record ${format.label}.`}
                onClick={() => onChange(format.id)}
              >
                {format.label}
              </button>
            );
          })}
        </div>
      </div>
      {!canRecord ? <p className="vt-hint">This browser cannot record {chosen.label}; pick another, or open the studio in a browser that can.</p> : null}
    </div>
  );
}
