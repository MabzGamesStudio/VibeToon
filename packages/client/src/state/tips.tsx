import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'vibetoon.showTips';

interface TipsValue {
  /** Whether the (i) beside each setting is shown at all. */
  show: boolean;
  setShow(show: boolean): void;
  toggle(): void;
}

const TipsContext = createContext<TipsValue | null>(null);

function read(): boolean {
  try {
    // Shown unless it has been turned off, so the explanations are there the
    // first time someone opens a flow they have not used before.
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * The one switch for setting tips. Kept apart from the project store because it
 * is a preference of the person using the studio, not part of the project: it
 * lives in this browser and is never saved to a file.
 */
export function TipsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [show, setShowState] = useState(read);

  const setShow = useCallback((next: boolean) => {
    setShowState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // A browser with storage blocked still works; the choice just does not
      // survive a reload.
    }
  }, []);

  const value = useMemo<TipsValue>(
    () => ({ show, setShow, toggle: () => setShow(!show) }),
    [setShow, show],
  );

  return <TipsContext.Provider value={value}>{children}</TipsContext.Provider>;
}

export function useTips(): TipsValue {
  const value = useContext(TipsContext);
  // Defaulting rather than throwing keeps a control usable outside the provider,
  // which is what a test rendering one field on its own does.
  return value ?? { show: true, setShow: () => {}, toggle: () => {} };
}
