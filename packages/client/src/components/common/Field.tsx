import type { ReactNode } from 'react';
import type { SettingTip } from '@vibetoon/shared';
import { InfoTip } from './InfoTip';

export interface FieldProps {
  label: string;
  hint?: string;
  /**
   * A key into the shared tip registry, or a tip written out here, shown behind
   * an (i) beside the label. The hint below the control is for what you need at
   * a glance; the tip is for what the setting actually does.
   */
  tip?: string | SettingTip;
  aside?: ReactNode;
  children: ReactNode;
}

/** Label above, hint below: used everywhere so forms line up without thinking. */
export function Field({ label, hint, tip, aside, children }: FieldProps): JSX.Element {
  return (
    <div className="vt-field">
      <div className="vt-label">
        <span>
          {label}
          {tip ? <InfoTip tip={tip} label={label} /> : null}
        </span>
        {aside}
      </div>
      {children}
      {hint ? <div className="vt-hint">{hint}</div> : null}
    </div>
  );
}
