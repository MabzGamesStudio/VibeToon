import type { SettingTip } from '@vibetoon/shared';
import { InfoTip } from './InfoTip';

export interface SliderProps {
  label: string;
  hint?: string;
  tip?: string | SettingTip;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
  onChange(value: number): void;
}

/** A labelled range with its current value read out beside the label. */
export function Slider({
  label,
  hint,
  tip,
  value,
  min = 0,
  max = 1,
  step = 0.05,
  format,
  onChange,
}: SliderProps): JSX.Element {
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
        <span>{format ? format(current) : current.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <div className="vt-hint">{hint}</div> : null}
    </div>
  );
}
