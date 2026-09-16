import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'vibetoon.view';

/**
 * What the studio draws.
 *
 * A big project on a modest laptop is the case this exists for: forty nodes each
 * drawing their ports and their files, a settings column, an inspector with
 * image previews in it, and a preview that reruns the generator on every
 * keystroke. Each is useful and each costs something, so each can be turned off.
 *
 * These are preferences of the person, not of the project: they live in this
 * browser and are never saved to a file anyone else opens.
 */
export interface ViewPrefs {
  /** The (i) beside every setting. */
  tips: boolean;
  /** The settings column down the left of an editor. */
  sidebar: boolean;
  /** Inputs & files in an editor, and the inspector on the graph. */
  inspector: boolean;
  /** The flow palette on the graph. */
  palette: boolean;
  /** How much each node on the graph draws. */
  nodeDetail: 'full' | 'compact';
  /** Previews that recompute as you type. The biggest cost of the lot. */
  livePreview: boolean;
  /** Thumbnails and previews of generated files. */
  artifactPreviews: boolean;
  /** Transitions, shadows and the graph's grid. */
  effects: boolean;
  /** How many rows a long list draws before it stops. */
  listLimit: number;
}

export const DEFAULT_VIEW: ViewPrefs = {
  tips: true,
  sidebar: true,
  inspector: true,
  palette: true,
  nodeDetail: 'full',
  livePreview: true,
  artifactPreviews: true,
  effects: true,
  listLimit: 300,
};

/** Everything expensive, off. One click for a laptop that is struggling. */
export const LIGHT_VIEW: ViewPrefs = {
  ...DEFAULT_VIEW,
  inspector: false,
  palette: false,
  nodeDetail: 'compact',
  livePreview: false,
  artifactPreviews: false,
  effects: false,
  listLimit: 50,
};

interface ViewValue {
  view: ViewPrefs;
  set<K extends keyof ViewPrefs>(key: K, value: ViewPrefs[K]): void;
  toggle(key: keyof ViewPrefs): void;
  apply(preset: ViewPrefs): void;
  /** True when anything is turned off, so the header can say so. */
  reduced: boolean;
}

const ViewContext = createContext<ViewValue | null>(null);

function read(): ViewPrefs {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    // Merged over the defaults, so a preference added later is not `undefined`
    // for everyone who has opened the studio before.
    return stored ? { ...DEFAULT_VIEW, ...(JSON.parse(stored) as Partial<ViewPrefs>) } : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

export function ViewProvider({ children }: { children: ReactNode }): JSX.Element {
  const [view, setView] = useState<ViewPrefs>(read);

  const write = useCallback((next: ViewPrefs) => {
    setView(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the studio still works, the choice just does not
      // survive a reload.
    }
  }, []);

  // One class on the root is cheaper than threading `effects` through every
  // component that has a transition on it.
  useEffect(() => {
    document.documentElement.classList.toggle('vt-no-effects', !view.effects);
  }, [view.effects]);

  const value = useMemo<ViewValue>(
    () => ({
      view,
      set: (key, next) => write({ ...view, [key]: next }),
      toggle: (key) => {
        const current = view[key];
        if (typeof current === 'boolean') write({ ...view, [key]: !current } as ViewPrefs);
      },
      apply: (preset) => write(preset),
      reduced: (Object.keys(DEFAULT_VIEW) as Array<keyof ViewPrefs>).some(
        (key) => view[key] !== DEFAULT_VIEW[key],
      ),
    }),
    [view, write],
  );

  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

export function useView(): ViewValue {
  // Defaulting rather than throwing keeps a component usable outside the
  // provider, which is what rendering one on its own in a test does.
  return (
    useContext(ViewContext) ?? {
      view: DEFAULT_VIEW,
      set: () => {},
      toggle: () => {},
      apply: () => {},
      reduced: false,
    }
  );
}

/** The one preference most components need. */
export function useTips(): { show: boolean; setShow(show: boolean): void; toggle(): void } {
  const { view, set } = useView();
  return {
    show: view.tips,
    setShow: (show) => set('tips', show),
    toggle: () => set('tips', !view.tips),
  };
}
