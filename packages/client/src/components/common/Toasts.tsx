import { useStudio } from '../../state/store';

export function Toasts(): JSX.Element {
  const { toasts, dismissToast } = useStudio();
  if (toasts.length === 0) return <></>;
  return (
    <div className="vt-toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`vt-toast is-${toast.kind}`} role="status">
          <div style={{ flex: 1 }}>{toast.message}</div>
          <button type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
