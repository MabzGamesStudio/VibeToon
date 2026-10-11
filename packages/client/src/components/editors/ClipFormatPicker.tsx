import { CLIP_FORMATS, clipFormat, type ClipFormatId } from '@vibetoon/shared';
import { useFormatSupport, type FormatSupport } from './renderVideo';

const SAYS: Record<FormatSupport, string> = {
  exact: 'written frame by frame, every frame evenly spaced, with its length and an index',
  recorded: 'this browser cannot encode it frame by frame, so it is recorded as the video plays: its frames may not be evenly spaced',
  none: 'this browser cannot write it',
};

/**
 * What a clip is written as. Every format is listed; the ones this browser
 * cannot write are greyed out with why, rather than hidden, so it is clear
 * what another browser would give.
 */
export function ClipFormatPicker({ value, onChange, label = 'Written as' }: { value: ClipFormatId | undefined; onChange(id: ClipFormatId): void; label?: string }): JSX.Element {
  const chosen = clipFormat(value);
  const support = useFormatSupport();
  const chosenSupport = support?.[chosen.id];
  const exactOne = support ? CLIP_FORMATS.find((format) => support[format.id] === 'exact') : undefined;
  return (
    <div style={{ marginTop: 6 }}>
      <div className="vt-row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="vt-faint">{label}</span>
        <div className="vt-facet-values" role="radiogroup" aria-label={label}>
          {CLIP_FORMATS.map((format) => {
            const how = support?.[format.id];
            return (
              <button
                key={format.id}
                type="button"
                className={`vt-chip${chosen.id === format.id ? ' is-on' : ''}`}
                aria-pressed={chosen.id === format.id}
                disabled={how === 'none'}
                title={`.${format.extension} — ${format.contentType}${how ? `: ${SAYS[how]}` : ''}`}
                onClick={() => onChange(format.id)}
              >
                {format.label}
                {how === 'recorded' ? ' ⚠' : ''}
              </button>
            );
          })}
        </div>
      </div>
      {chosenSupport === 'none' ? <p className="vt-hint">This browser cannot write {chosen.label}; pick another, or open the studio in a browser that can.</p> : null}
      {chosenSupport === 'recorded' ? <p className="vt-hint">{chosen.label}: {SAYS.recorded}.{exactOne ? ` ${exactOne.label} is written frame by frame.` : ''}</p> : null}
    </div>
  );
}
