import type { ReactNode } from 'react';

export interface FieldProps {
  label: string;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
}

/** Label above, hint below: used everywhere so forms line up without thinking. */
export function Field({ label, hint, aside, children }: FieldProps): JSX.Element {
  return (
    <div className="vt-field">
      <div className="vt-label">
        <span>{label}</span>
        {aside}
      </div>
      {children}
      {hint ? <div className="vt-hint">{hint}</div> : null}
    </div>
  );
}
