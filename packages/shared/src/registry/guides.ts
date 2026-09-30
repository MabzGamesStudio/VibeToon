/**
 * How each flow's algorithm works, written to be read in the studio ("How it
 * works" in a flow's editor) and generated into docs/ALGORITHMS.md.
 *
 * A guide says the same thing four ways, for four ways of understanding:
 *
 * - **steps** — a flow diagram: what happens in what order, where it loops,
 *   and where a thing is turned away and why;
 * - **pseudocode** — the same, exactly, as short code;
 * - **sections** — the reasoning: why it is done this way, what each part is
 *   for, what it gets wrong;
 * - **settings** and **resources** — what each setting changes, and where to
 *   read more.
 *
 * The guides are written from the code they describe (`source`), and name its
 * functions, so a guide can be checked against it.
 */

export type GuideStep =
  | { kind: 'input' | 'output' | 'step'; title: string; detail?: string }
  /** A test: yes carries on down; `no` says what happens instead. */
  | { kind: 'decision'; title: string; detail?: string; no: string }
  /** Steps done again and again: for each pixel, until it settles… */
  | { kind: 'loop'; title: string; detail?: string; steps: GuideStep[] };

export interface GuideSection {
  heading: string;
  /**
   * Paragraphs, split by a blank line. A line starting `- ` is a bullet;
   * `**bold**` and `` `code` `` are kept.
   */
  body: string;
}

export interface GuideResource {
  title: string;
  url?: string;
  /** What it adds: why read it. */
  note: string;
}

export interface AlgorithmGuide {
  /** The flow kinds it is for. */
  kinds: string[];
  title: string;
  /** What it does, in a paragraph. */
  summary: string;
  steps: GuideStep[];
  pseudocode: string;
  sections: GuideSection[];
  settings?: Array<{ name: string; effect: string }>;
  /** How long it takes, and on what. */
  cost?: string;
  resources: GuideResource[];
  /** Where it is in the code. */
  source: string[];
  /** Something in the editor to see it working, if there is one. */
  tryIt?: string;
}

/**
 * Flows with an editor but no algorithm to explain: they keep, fetch or
 * arrange what is given to them. Each says why.
 */
export const NO_ALGORITHM: Record<string, string> = {
  'story.dialog': 'A script is written by hand; the flow lays it out as text and as scenes, as typed.',
  'animation.character.design': 'A design is drawn and written by hand; the drawings are rasterised as drawn and the written fields become the spec.',
  'animation.set.design': 'A design is drawn and written by hand; the drawings are rasterised as drawn and the written fields become the spec.',
  'animation.prop.design': 'A design is drawn and written by hand; the drawings are rasterised as drawn and the written fields become the spec.',
  'art.image': 'A picture is uploaded or fetched and kept as it is.',
  'custom.flow': 'A custom flow is a card standing for other flows; each of them has its own guide.',
};
