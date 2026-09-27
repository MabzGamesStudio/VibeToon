import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  effectiveRange,
  validateSliderOverrides,
  type EffectiveRange,
  type SliderRangeOverride,
  type SliderRangeOverrides,
} from '@vibetoon/shared';
import { api } from '../api/client';
import { useStudio } from './store';

const SAVE_DELAY_MS = 400;

interface SliderRangesValue {
  overrides: SliderRangeOverrides;
  /** Change one slider's ends; `null` puts it back to its defaults. */
  setRange(key: string, change: SliderRangeOverride | null): void;
  resetAll(): void;
}

const SliderRangesContext = createContext<SliderRangesValue | null>(null);

/**
 * How far each slider reaches, for this installation.
 *
 * Read from the server once, changed here, written back a moment after the
 * last change. Every slider asks this for its ends, so a change shows at once
 * in every open editor.
 */
export function SliderRangesProvider({ children }: { children: ReactNode }): JSX.Element {
  const { notify } = useStudio();
  const [overrides, setOverrides] = useState<SliderRangeOverrides>({});
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api
      .sliderRanges()
      .then((loaded) => setOverrides(loaded.overrides))
      .catch((error: Error) => notify('error', `Could not load slider ranges: ${error.message}`));
  }, [notify]);

  const save = useCallback(
    (next: SliderRangeOverrides) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        api.saveSliderRanges(next).catch((error: Error) => notify('error', `Could not save slider ranges: ${error.message}`));
      }, SAVE_DELAY_MS);
    },
    [notify],
  );

  const setRange = useCallback(
    (key: string, change: SliderRangeOverride | null) => {
      setOverrides((current) => {
        const next = { ...current };
        if (change) next[key] = change;
        else delete next[key];
        // Only a set that would be accepted is kept; the settings page checks
        // each row before it gets here, so this is a last guard.
        const checked = validateSliderOverrides(next);
        if (!checked.ok) return current;
        save(checked.value);
        return checked.value;
      });
    },
    [save],
  );

  const resetAll = useCallback(() => {
    setOverrides({});
    save({});
  }, [save]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const value = useMemo(() => ({ overrides, setRange, resetAll }), [overrides, setRange, resetAll]);
  return <SliderRangesContext.Provider value={value}>{children}</SliderRangesContext.Provider>;
}

export function useSliderRanges(): SliderRangesValue {
  return useContext(SliderRangesContext) ?? { overrides: {}, setRange: () => {}, resetAll: () => {} };
}

/** The ends and step of one slider, as set for this installation. */
export function useSliderRange(key: string): EffectiveRange {
  const { overrides } = useSliderRanges();
  return useMemo(() => effectiveRange(key, overrides), [key, overrides]);
}
