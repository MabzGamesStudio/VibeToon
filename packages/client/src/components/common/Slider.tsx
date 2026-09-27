import type { SettingTip } from '@vibetoon/shared';
import { useSliderRange } from '../../state/sliderRanges';
import { InfoTip } from './InfoTip';

export interface SliderProps {
  label: string;
  hint?: string;
  tip?: string | SettingTip;
  /**
   * Which slider this is, in `SLIDER_RANGES`. Its ends and step come from
   * there — the defaults, or what they have been changed to in Settings — so
   * they are never written at the slider itself.
   */
  range: string;
  /**
   * Hard limits the data itself sets, such as a joint's own turning range.
   * The slider covers only the part of its range inside them.
   */
  within?: { min: number; max: number };
  value: number;
  format?: (value: number) => string;
  onChange(value: number): void;
}

/** A labelled range with its current value read out beside the label. */
export function Slider({ label, hint, tip, range, within, value, format, onChange }: SliderProps): JSX.Element {
  const set = useSliderRange(range);
  let { min, max } = set;
  if (within) {
    const low = Math.max(min, within.min);
    const high = Math.min(max, within.max);
    // Limits that do not overlap the range leave the limits in charge.
    [min, max] = high > low ? [low, high] : [within.min, within.max];
  }
  // A setting a stored project predates is normalised on the way out of storage,
  // but a control that white-screens the studio when one slips through is not a
  // reasonable way to find that out. Fall back to the floor and carry on.
  const current = Number.isFinite(value) ? value : min;
  return (
    <div className="vt-field">
      <div className="vt-label">
        <span>
          {label}
          {tip ? <InfoTip tip={tip} label={label} /> : null}
        </span>
        {/* The value as it is, even outside the range the slider now covers. */}
        <span>{format ? format(current) : current.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={set.step}
        value={current}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <div className="vt-hint">{hint}</div> : null}
    </div>
  );
}
