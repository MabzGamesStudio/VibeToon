import type { AlgorithmGuide } from '../guides';
import { LINES_GUIDE } from './lines';

/** Every flow's guide to how it works. */
export const ALGORITHM_GUIDES: readonly AlgorithmGuide[] = [LINES_GUIDE];

export function guideFor(kind: string): AlgorithmGuide | undefined {
  return ALGORITHM_GUIDES.find((guide) => guide.kinds.includes(kind));
}
