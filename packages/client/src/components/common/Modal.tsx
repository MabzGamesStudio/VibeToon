import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  /** For content that is a table rather than a form. */
  wide?: boolean;
}

export function Modal({ title, onClose, children, footer, wide = false }: ModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="vt-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`vt-modal${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button type="button" className="vt-btn is-ghost is-small" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="vt-modal-body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}
