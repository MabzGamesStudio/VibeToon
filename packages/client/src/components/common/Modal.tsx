import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ title, onClose, children, footer }: ModalProps): JSX.Element {
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
      <div className="vt-modal" role="dialog" aria-modal="true" aria-label={title}>
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
