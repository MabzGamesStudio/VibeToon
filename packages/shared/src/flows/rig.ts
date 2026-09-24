import type { Vec2 } from '../types/project';

/**
 * A skeleton: what bones a character has, how they hang off each other, and how
 * far each joint is allowed to move.
 *
 * The character type is the whole of the structure. Choosing `octopus` is not a
 * label — it is forty-two bones in eight arms, and choosing `human` is nineteen
 * in a different shape. So the type seeds the rig, and everything after that is
 * editing limits rather than adding bones.
 *
 * Limits come in two kinds, because joints fail in two ways. A **range of
 * motion** is a hard stop: a knee that bends backwards is a broken knee, and no
 * amount of force should get it there. **Stiffness** is not a stop but a cost:
 * how strongly the joint pulls back towards its rest pose. A shoulder and a neck
 * have similar ranges and completely different stiffness, which is most of what
 * makes one character move like a person and another like a puppet.
 *
 * A run of small bones — a tentacle, a tail, a snake — is not a set of
 * independently tuned joints. It is one behaviour, so it gets one number:
 * `floppiness`, on the chain. Each joint's angles are read off that unless it has
 * been given its own, which keeps the common case to one slider and still lets
 * any single joint be pinned by hand.
 */

export type RigKind =
  | 'human'
  | 'quadruped'
  | 'bird'
  | 'fish'
  | 'snake'
  | 'octopus'
  | 'insect'
  | 'arachnid';

export const RIG_KINDS: readonly RigKind[] = [
  'human',
  'quadruped',
  'bird',
  'fish',
  'snake',
  'octopus',
  'insect',
  'arachnid',
];

export const RIG_KIND_LABEL: Record<RigKind, string> = {
  human: 'Human',
  quadruped: 'Quadruped',
  bird: 'Bird',
  fish: 'Fish',
  snake: 'Snake',
  octopus: 'Octopus',
  insect: 'Insect',
  arachnid: 'Arachnid',
};

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

export interface StretchLimits {
  /**
   * How short the bone may get, as a multiple of its rest length. 1 cannot
   * shorten at all; 0.7 squashes to seven tenths.
   */
  min: number;
  /** How long it may get. 1 cannot stretch; 1.4 is cartoon rubber. */
  max: number;
  /**
   * 0..1 — how hard it pulls back to its rest length. 1 is bone, 0 is chewing
   * gum. It is a cost rather than a stop: the range above is the stop.
   */
  stiffness: number;
}

export interface AngleLimits {
  /** Degrees anticlockwise from the rest pose the joint may turn. Negative. */
  min: number;
  /** Degrees clockwise from the rest pose. Positive. */
  max: number;
  /** 0..1 — how hard it pulls back to the rest angle. */
  stiffness: number;
}

export interface Bone {
  id: string;
  name: string;
  /** Parent bone id. Absent on the root, of which there is exactly one. */
  parent?: string;
  /**
   * Where this bone's far end sits relative to its parent's far end, at rest, in
   * rig units. The rig is drawn and measured in these; nothing here is pixels.
   */
  offset: Vec2;
  /** The chain this bone belongs to, when it is part of one. */
  chain?: string;
  /** Which side of the body, for mirroring an edit onto the twin. */
  side?: 'left' | 'right';
  stretch: StretchLimits;
  /**
   * This joint's own angles. Absent on a chain bone, which reads its angles off
   * the chain's floppiness instead — see `effectiveAngles`.
   */
  angles?: AngleLimits;
}

/**
 * A run of bones that move as one behaviour.
 *
 * `taper` is what makes a tentacle look like a tentacle rather than a hinge: the
 * base of an arm is stiffer than the tip. `floppiness` is what the *tip* does,
 * and taper is how much of that the base gives up — at 0 the whole chain is
 * equally floppy, at 1 the base does not move at all.
 *
 * It is written that way round so the gradient survives. Scaling the tip *up*
 * from the chain's floppiness is the obvious way to do it and runs into the
 * ceiling: at a floppiness of 0.8 the last two joints of a five-bone arm both
 * clamp to fully loose, and the taper quietly stops doing anything exactly where
 * it matters most.
 */
export interface BoneChain {
  id: string;
  name: string;
  /** Bone ids in order, base first. */
  bones: string[];
  /** 0..1 — how loose the whole chain is. */
  floppiness: number;
  /** 0..1 — how much of the floppiness the base gives up. The tip keeps all of it. */
  taper: number;
  /** Degrees a fully floppy joint may turn either way. */
  span: number;
}

export interface RigOptions {
  /** An edit to a left bone writes the same limits to its right twin. */
  mirror: boolean;
  /**
   * Moving a joint moves its twin on the other side the matching way — mirrored
   * across the body for a skeleton drawn face on, the same way for one drawn
   * side on. On by default, for the same reason as `mirror`.
   */
  mirrorMoves: boolean;
  /**
   * Multiplies every bone's stretch range, so a whole rig can be made rubbery
   * without touching each bone. 1 leaves the type's own values alone.
   */
  squashAndStretch: number;
  /** Multiplies every angle range. Below 1 is a stiffer, more controlled rig. */
  looseness: number;
}

export const DEFAULT_RIG_OPTIONS: RigOptions = {
  mirror: true,
  mirrorMoves: true,
  squashAndStretch: 1,
  looseness: 1,
};

export interface RigFlowData {
  editor: 'rig';
  kind: RigKind;
  bones: Bone[];
  chains: BoneChain[];
  options: RigOptions;
  /**
   * Where the root of the skeleton sits, in whatever space it is being used in.
   *
   * Absent means the origin, which is what the rig flow itself draws against. It
   * matters once a rig is laid over a drawing: the two were made in different
   * spaces and something has to say how they line up.
   */
  origin?: Vec2;
}

/* ------------------------------------------------------------------ *
 * Building a skeleton
 * ------------------------------------------------------------------ */

const RIGID: StretchLimits = { min: 1, max: 1, stiffness: 1 };
const SLIGHT: StretchLimits = { min: 0.95, max: 1.08, stiffness: 0.8 };
const SOFT: StretchLimits = { min: 0.85, max: 1.25, stiffness: 0.4 };

function angles(min: number, max: number, stiffness: number): AngleLimits {
  return { min, max, stiffness };
}

interface BoneSpec {
  id: string;
  name: string;
  parent?: string;
  offset: Vec2;
  stretch?: StretchLimits;
  angles?: AngleLimits;
  side?: 'left' | 'right';
  chain?: string;
}

function bone(spec: BoneSpec): Bone {
  return {
    id: spec.id,
    name: spec.name,
    ...(spec.parent ? { parent: spec.parent } : {}),
    offset: spec.offset,
    ...(spec.chain ? { chain: spec.chain } : {}),
    ...(spec.side ? { side: spec.side } : {}),
    stretch: spec.stretch ?? SLIGHT,
    ...(spec.angles ? { angles: spec.angles } : {}),
  };
}

/**
 * A run of identical small bones, each a little shorter than the last.
 *
 * Tentacles, tails and spines are all this shape, and writing out forty of them
 * by hand would be forty chances to get one wrong. The bones carry no angles of
 * their own, so the chain's floppiness is what decides how they move.
 */
function chainOf(options: {
  id: string;
  name: string;
  parent: string;
  count: number;
  /** The first bone's offset; later ones are scaled by `shrink` each step. */
  step: Vec2;
  shrink?: number;
  /** Degrees to fan each successive bone by, for a curled rest pose. */
  curl?: number;
  floppiness: number;
  taper?: number;
  span?: number;
  stretch?: StretchLimits;
}): { bones: Bone[]; chain: BoneChain } {
  const shrink = options.shrink ?? 0.88;
  const curl = ((options.curl ?? 0) * Math.PI) / 180;
  const bones: Bone[] = [];
  let parent = options.parent;
  let { x, y } = options.step;

  for (let index = 0; index < options.count; index += 1) {
    const id = `${options.id}-${index + 1}`;
    bones.push(
      bone({
        id,
        name: `${options.name} ${index + 1}`,
        parent,
        offset: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 },
        chain: options.id,
        stretch: options.stretch ?? SOFT,
      }),
    );
    parent = id;
    const turned = { x: x * Math.cos(curl) - y * Math.sin(curl), y: x * Math.sin(curl) + y * Math.cos(curl) };
    x = turned.x * shrink;
    y = turned.y * shrink;
  }

  return {
    bones,
    chain: {
      id: options.id,
      name: options.name,
      bones: bones.map((entry) => entry.id),
      floppiness: options.floppiness,
      taper: options.taper ?? 0.5,
      span: options.span ?? 40,
    },
  };
}

/** Both sides of a limb, from one description of the left. */
function pair(build: (side: 'left' | 'right', flip: number) => Bone[]): Bone[] {
  return [...build('left', -1), ...build('right', 1)];
}

/**
 * A quadruped's leg, and a bird's, and an insect's: the same three segments with
 * different proportions, so they are built once.
 */
function leg(options: {
  id: string;
  label: string;
  parent: string;
  side: 'left' | 'right';
  root: Vec2;
  segments: Array<{ name: string; offset: Vec2; angles: AngleLimits }>;
}): Bone[] {
  const bones: Bone[] = [];
  let parent = options.parent;
  let first = true;
  for (const segment of options.segments) {
    const id = `${options.id}-${segment.name}`;
    bones.push(
      bone({
        id,
        name: `${options.label} ${segment.name}`,
        parent,
        offset: first ? { x: options.root.x + segment.offset.x, y: options.root.y + segment.offset.y } : segment.offset,
        side: options.side,
        angles: segment.angles,
        stretch: SLIGHT,
      }),
    );
    parent = id;
    first = false;
  }
  return bones;
}

export interface RigTemplate {
  bones: Bone[];
  chains: BoneChain[];
  /** What the type is for, shown beside the picker. */
  note: string;
}

/**
 * The skeletons.
 *
 * Offsets are in rig units with y pointing down, the way the studio's canvases
 * do, and a figure is roughly 100 units tall so the numbers are readable. Rest
 * poses are the conventional ones: a human stands, a quadruped stands in profile,
 * an octopus hangs.
 */
export function rigTemplate(kind: RigKind): RigTemplate {
  switch (kind) {
    case 'human': {
      const bones: Bone[] = [
        bone({ id: 'hips', name: 'Hips', offset: { x: 0, y: 0 }, stretch: RIGID, angles: angles(-30, 30, 0.5) }),
        bone({ id: 'spine', name: 'Spine', parent: 'hips', offset: { x: 0, y: -14 }, angles: angles(-25, 20, 0.6) }),
        bone({ id: 'chest', name: 'Chest', parent: 'spine', offset: { x: 0, y: -12 }, angles: angles(-15, 15, 0.7) }),
        bone({ id: 'neck', name: 'Neck', parent: 'chest', offset: { x: 0, y: -6 }, angles: angles(-35, 35, 0.5) }),
        bone({ id: 'head', name: 'Head', parent: 'neck', offset: { x: 0, y: -10 }, stretch: SLIGHT, angles: angles(-20, 20, 0.6) }),
        ...pair((side, flip) => [
          bone({
            id: `${side}-shoulder`,
            name: `${side === 'left' ? 'Left' : 'Right'} shoulder`,
            parent: 'chest',
            offset: { x: 7 * flip, y: -2 },
            side,
            stretch: RIGID,
            angles: angles(-20, 20, 0.7),
          }),
          bone({
            id: `${side}-upper-arm`,
            name: `${side === 'left' ? 'Left' : 'Right'} upper arm`,
            parent: `${side}-shoulder`,
            offset: { x: 4 * flip, y: 14 },
            side,
            // A shoulder is the loosest joint a person has, and it shows.
            angles: angles(-150, 150, 0.25),
          }),
          bone({
            id: `${side}-forearm`,
            name: `${side === 'left' ? 'Left' : 'Right'} forearm`,
            parent: `${side}-upper-arm`,
            offset: { x: 1 * flip, y: 13 },
            side,
            // An elbow bends one way only. This is the limit that stops a rig
            // looking broken more often than any other.
            angles: angles(0, 145, 0.4),
          }),
          bone({
            id: `${side}-hand`,
            name: `${side === 'left' ? 'Left' : 'Right'} hand`,
            parent: `${side}-forearm`,
            offset: { x: 0, y: 5 },
            side,
            angles: angles(-70, 70, 0.5),
          }),
        ]),
        ...pair((side, flip) =>
          leg({
            id: `${side}-leg`,
            label: side === 'left' ? 'Left' : 'Right',
            parent: 'hips',
            side,
            root: { x: 3.5 * flip, y: 0 },
            segments: [
              { name: 'thigh', offset: { x: 0, y: 20 }, angles: angles(-110, 30, 0.35) },
              // A knee bends backwards and only backwards.
              { name: 'shin', offset: { x: 0, y: 19 }, angles: angles(-140, 0, 0.4) },
              { name: 'foot', offset: { x: 4 * flip, y: 4 }, angles: angles(-30, 45, 0.6) },
            ],
          }),
        ),
      ];
      return { bones, chains: [], note: 'Two arms, two legs, a spine of three. The default for a person.' };
    }

    case 'quadruped': {
      const tail = chainOf({
        id: 'tail',
        name: 'Tail',
        parent: 'hips',
        count: 5,
        step: { x: 7, y: -2 },
        curl: 8,
        floppiness: 0.65,
        span: 35,
      });
      const bones: Bone[] = [
        bone({ id: 'hips', name: 'Hips', offset: { x: 0, y: 0 }, stretch: RIGID, angles: angles(-20, 20, 0.6) }),
        bone({ id: 'spine', name: 'Spine', parent: 'hips', offset: { x: -20, y: -2 }, angles: angles(-20, 20, 0.6) }),
        bone({ id: 'chest', name: 'Chest', parent: 'spine', offset: { x: -18, y: 0 }, angles: angles(-15, 15, 0.7) }),
        bone({ id: 'neck', name: 'Neck', parent: 'chest', offset: { x: -10, y: -8 }, angles: angles(-50, 40, 0.45) }),
        bone({ id: 'head', name: 'Head', parent: 'neck', offset: { x: -9, y: -3 }, angles: angles(-30, 30, 0.55) }),
        ...pair((side, flip) =>
          leg({
            id: `${side}-front`,
            label: `${side === 'left' ? 'Left' : 'Right'} front`,
            parent: 'chest',
            side,
            root: { x: 0, y: 0 },
            segments: [
              { name: 'upper', offset: { x: 1, y: 16 }, angles: angles(-70, 50, 0.4) },
              { name: 'lower', offset: { x: -1, y: 15 }, angles: angles(0, 120, 0.45) },
              { name: 'paw', offset: { x: 3, y: 4 }, angles: angles(-25, 40, 0.6) },
            ],
          }).map((entry) => ({ ...entry, offset: { ...entry.offset, x: entry.offset.x + flip * 0.5 } })),
        ),
        ...pair((side, flip) =>
          leg({
            id: `${side}-rear`,
            label: `${side === 'left' ? 'Left' : 'Right'} rear`,
            parent: 'hips',
            side,
            root: { x: 0, y: 0 },
            segments: [
              { name: 'upper', offset: { x: -2, y: 16 }, angles: angles(-60, 70, 0.4) },
              { name: 'lower', offset: { x: 3, y: 15 }, angles: angles(-120, 0, 0.45) },
              { name: 'paw', offset: { x: 2, y: 4 }, angles: angles(-25, 40, 0.6) },
            ],
          }).map((entry) => ({ ...entry, offset: { ...entry.offset, x: entry.offset.x + flip * 0.5 } })),
        ),
        ...tail.bones,
      ];
      return {
        bones,
        chains: [tail.chain],
        note: 'Four legs, a horizontal spine and a tail chain. Dogs, cats, horses.',
      };
    }

    case 'bird': {
      const tail = chainOf({
        id: 'tail',
        name: 'Tail',
        parent: 'hips',
        count: 3,
        step: { x: 8, y: 1 },
        floppiness: 0.5,
        span: 30,
      });
      const bones: Bone[] = [
        bone({ id: 'hips', name: 'Hips', offset: { x: 0, y: 0 }, stretch: RIGID, angles: angles(-20, 20, 0.6) }),
        bone({ id: 'chest', name: 'Chest', parent: 'hips', offset: { x: -14, y: -6 }, angles: angles(-20, 20, 0.6) }),
        bone({ id: 'neck-1', name: 'Neck 1', parent: 'chest', offset: { x: -6, y: -8 }, angles: angles(-60, 60, 0.35) }),
        bone({ id: 'neck-2', name: 'Neck 2', parent: 'neck-1', offset: { x: -3, y: -7 }, angles: angles(-60, 60, 0.35) }),
        bone({ id: 'head', name: 'Head', parent: 'neck-2', offset: { x: -6, y: -2 }, angles: angles(-40, 40, 0.5) }),
        bone({ id: 'beak', name: 'Beak', parent: 'head', offset: { x: -6, y: 1 }, stretch: RIGID, angles: angles(-10, 25, 0.8) }),
        ...pair((side, flip) => [
          bone({
            id: `${side}-wing-upper`,
            name: `${side === 'left' ? 'Left' : 'Right'} wing upper`,
            parent: 'chest',
            offset: { x: 4, y: 3 * flip + 2 },
            side,
            angles: angles(-120, 100, 0.3),
          }),
          bone({
            id: `${side}-wing-lower`,
            name: `${side === 'left' ? 'Left' : 'Right'} wing lower`,
            parent: `${side}-wing-upper`,
            offset: { x: 13, y: 2 },
            side,
            angles: angles(-140, 10, 0.35),
          }),
          bone({
            id: `${side}-wing-tip`,
            name: `${side === 'left' ? 'Left' : 'Right'} wing tip`,
            parent: `${side}-wing-lower`,
            offset: { x: 14, y: 0 },
            side,
            stretch: SOFT,
            angles: angles(-60, 30, 0.3),
          }),
        ]),
        ...pair((side, flip) =>
          leg({
            id: `${side}-leg`,
            label: side === 'left' ? 'Left' : 'Right',
            parent: 'hips',
            side,
            root: { x: 0, y: 0 },
            segments: [
              { name: 'thigh', offset: { x: 1 + flip * 0.5, y: 10 }, angles: angles(-70, 40, 0.4) },
              { name: 'shin', offset: { x: -2, y: 12 }, angles: angles(0, 110, 0.4) },
              { name: 'foot', offset: { x: -5, y: 3 }, angles: angles(-40, 40, 0.5) },
            ],
          }),
        ),
        ...tail.bones,
      ];
      return { bones, chains: [tail.chain], note: 'Two wings of three, a long neck, a tail fan.' };
    }

    case 'fish': {
      const spine = chainOf({
        id: 'spine',
        name: 'Spine',
        parent: 'head',
        count: 6,
        step: { x: 11, y: 0 },
        shrink: 0.92,
        floppiness: 0.7,
        taper: 0.7,
        span: 30,
      });
      const bones: Bone[] = [
        bone({ id: 'head', name: 'Head', offset: { x: 0, y: 0 }, stretch: RIGID, angles: angles(-20, 20, 0.6) }),
        ...spine.bones,
        bone({ id: 'tail-fin', name: 'Tail fin', parent: 'spine-6', offset: { x: 9, y: 0 }, stretch: SOFT, angles: angles(-45, 45, 0.25) }),
        ...pair((side, flip) => [
          bone({
            id: `${side}-pectoral`,
            name: `${side === 'left' ? 'Left' : 'Right'} pectoral fin`,
            parent: 'spine-1',
            offset: { x: 3, y: 4 * flip },
            side,
            stretch: SOFT,
            angles: angles(-70, 70, 0.3),
          }),
        ]),
        bone({ id: 'dorsal', name: 'Dorsal fin', parent: 'spine-3', offset: { x: 0, y: -7 }, stretch: SOFT, angles: angles(-25, 25, 0.5) }),
      ];
      return { bones, chains: [spine.chain], note: 'A head and a whip: most of the motion is one spine chain.' };
    }

    case 'snake': {
      const body = chainOf({
        id: 'body',
        name: 'Body',
        parent: 'head',
        count: 14,
        step: { x: 8, y: 0 },
        shrink: 0.97,
        floppiness: 0.85,
        taper: 0.3,
        span: 35,
      });
      return {
        bones: [
          bone({ id: 'head', name: 'Head', offset: { x: 0, y: 0 }, stretch: RIGID, angles: angles(-40, 40, 0.5) }),
          ...body.bones,
        ],
        chains: [body.chain],
        note: 'One head and fourteen body joints. Everything is the chain.',
      };
    }

    case 'octopus': {
      const bones: Bone[] = [
        bone({ id: 'mantle', name: 'Mantle', offset: { x: 0, y: 0 }, stretch: SOFT, angles: angles(-30, 30, 0.4) }),
        bone({ id: 'head', name: 'Head', parent: 'mantle', offset: { x: 0, y: 16 }, stretch: SOFT, angles: angles(-40, 40, 0.35) }),
      ];
      const chains: BoneChain[] = [];
      // Eight arms of five, fanned across the lower half so the rest pose reads
      // as an octopus rather than a star.
      for (let arm = 0; arm < 8; arm += 1) {
        const spread = -70 + arm * 20;
        const radians = (spread * Math.PI) / 180;
        const built = chainOf({
          id: `arm-${arm + 1}`,
          name: `Arm ${arm + 1}`,
          parent: 'head',
          count: 5,
          step: { x: Math.sin(radians) * 9, y: Math.cos(radians) * 9 },
          shrink: 0.85,
          curl: arm < 4 ? -6 : 6,
          floppiness: 0.9,
          taper: 0.6,
          span: 55,
        });
        bones.push(...built.bones);
        chains.push(built.chain);
      }
      return {
        bones,
        chains,
        note: 'Eight arms of five bones each, every arm its own chain. Forty-two bones.',
      };
    }

    case 'insect': {
      const abdomen = chainOf({
        id: 'abdomen',
        name: 'Abdomen',
        parent: 'thorax',
        count: 3,
        step: { x: 9, y: 0 },
        floppiness: 0.3,
        span: 20,
      });
      const bones: Bone[] = [
        bone({ id: 'thorax', name: 'Thorax', offset: { x: 0, y: 0 }, stretch: RIGID, angles: angles(-15, 15, 0.8) }),
        bone({ id: 'head', name: 'Head', parent: 'thorax', offset: { x: -10, y: -1 }, stretch: RIGID, angles: angles(-45, 45, 0.5) }),
        ...pair((side, flip) => [
          bone({
            id: `${side}-antenna`,
            name: `${side === 'left' ? 'Left' : 'Right'} antenna`,
            parent: 'head',
            offset: { x: -8, y: -5 + flip },
            side,
            stretch: SOFT,
            angles: angles(-60, 60, 0.15),
          }),
        ]),
        ...abdomen.bones,
      ];
      // Six legs: three a side, hung off the thorax and splayed fore and aft.
      for (const side of ['left', 'right'] as const) {
        const flip = side === 'left' ? -1 : 1;
        for (const [index, forward] of [-6, 0, 6].entries()) {
          bones.push(
            ...leg({
              id: `${side}-leg-${index + 1}`,
              label: `${side === 'left' ? 'Left' : 'Right'} leg ${index + 1}`,
              parent: 'thorax',
              side,
              root: { x: forward, y: 0 },
              segments: [
                { name: 'coxa', offset: { x: 0, y: 6 * (flip === -1 ? 1 : 1) }, angles: angles(-40, 40, 0.5) },
                { name: 'femur', offset: { x: forward * 0.4, y: 9 }, angles: angles(-80, 20, 0.45) },
                { name: 'tibia', offset: { x: forward * 0.3, y: 9 }, angles: angles(0, 110, 0.5) },
              ],
            }),
          );
        }
      }
      return { bones, chains: [abdomen.chain], note: 'Six legs of three, antennae, a segmented abdomen.' };
    }

    case 'arachnid': {
      const bones: Bone[] = [
        bone({ id: 'abdomen', name: 'Abdomen', offset: { x: 0, y: 0 }, stretch: SOFT, angles: angles(-20, 20, 0.7) }),
        bone({ id: 'thorax', name: 'Cephalothorax', parent: 'abdomen', offset: { x: -14, y: 0 }, stretch: RIGID, angles: angles(-25, 25, 0.7) }),
      ];
      const chains: BoneChain[] = [];
      // Eight legs, each a four-bone chain: a spider's leg bends in too many
      // places to be worth four sliders apiece.
      for (const side of ['left', 'right'] as const) {
        const flip = side === 'left' ? -1 : 1;
        for (const [index, forward] of [-7, -2, 3, 8].entries()) {
          const built = chainOf({
            id: `${side}-leg-${index + 1}`,
            name: `${side === 'left' ? 'Left' : 'Right'} leg ${index + 1}`,
            parent: 'thorax',
            count: 4,
            step: { x: forward * 0.5, y: 8 * (flip === -1 ? 1 : 1) },
            shrink: 0.9,
            curl: flip * 18,
            floppiness: 0.35,
            taper: 0.4,
            span: 45,
          });
          bones.push(...built.bones.map((entry) => ({ ...entry, side })));
          chains.push(built.chain);
        }
      }
      return { bones, chains, note: 'Eight legs of four, each its own chain. Spiders and crabs.' };
    }
  }
}

export function emptyRigFlowData(kind: RigKind = 'human'): RigFlowData {
  const template = rigTemplate(kind);
  return {
    editor: 'rig',
    kind,
    bones: template.bones,
    chains: template.chains,
    options: { ...DEFAULT_RIG_OPTIONS },
  };
}

/**
 * Swap the character type, keeping what still applies.
 *
 * A bone that exists in both skeletons — `head`, `hips`, a chain's floppiness —
 * keeps the limits it was given, because those are the edits somebody made on
 * purpose. Everything else comes from the new type. It is matched by id rather
 * than by name, so `left-forearm` carries over and `left-wing-lower` does not
 * pretend to be one.
 */
export function changeRigKind(data: RigFlowData, kind: RigKind): RigFlowData {
  const template = rigTemplate(kind);
  const held = new Map(data.bones.map((entry) => [entry.id, entry]));
  const heldChains = new Map(data.chains.map((entry) => [entry.id, entry]));

  return {
    ...data,
    kind,
    bones: template.bones.map((fresh) => {
      const previous = held.get(fresh.id);
      if (!previous) return fresh;
      return {
        ...fresh,
        stretch: previous.stretch,
        ...(previous.angles ? { angles: previous.angles } : {}),
      };
    }),
    chains: template.chains.map((fresh) => {
      const previous = heldChains.get(fresh.id);
      return previous
        ? { ...fresh, floppiness: previous.floppiness, taper: previous.taper, span: previous.span }
        : fresh;
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Reading the rig
 * ------------------------------------------------------------------ */

export function boneById(data: RigFlowData, id: string): Bone | undefined {
  return data.bones.find((entry) => entry.id === id);
}

export function chainById(data: RigFlowData, id: string | undefined): BoneChain | undefined {
  return id ? data.chains.find((entry) => entry.id === id) : undefined;
}

export function rootBones(data: RigFlowData): Bone[] {
  const ids = new Set(data.bones.map((entry) => entry.id));
  return data.bones.filter((entry) => !entry.parent || !ids.has(entry.parent));
}

export function childrenOf(data: RigFlowData, id: string): Bone[] {
  return data.bones.filter((entry) => entry.parent === id);
}

/** A bone's rest length, in rig units. It is the length of its offset. */
export function boneLength(bone: Bone): number {
  return Math.hypot(bone.offset.x, bone.offset.y);
}

/**
 * Where every bone's ends are at rest, walking down from the roots.
 *
 * Positions are not stored, only offsets, so that editing a joint moves
 * everything below it without a second pass to fix up children. This is the one
 * place that turns the hierarchy into coordinates.
 */
export function restPose(data: RigFlowData): Map<string, { from: Vec2; to: Vec2 }> {
  const positions = new Map<string, { from: Vec2; to: Vec2 }>();
  const byParent = new Map<string, Bone[]>();
  for (const entry of data.bones) {
    const key = entry.parent ?? '';
    byParent.set(key, [...(byParent.get(key) ?? []), entry]);
  }

  const walk = (bone: Bone, origin: Vec2): void => {
    const to = { x: origin.x + bone.offset.x, y: origin.y + bone.offset.y };
    positions.set(bone.id, { from: origin, to });
    for (const child of byParent.get(bone.id) ?? []) walk(child, to);
  };

  const origin = data.origin ?? { x: 0, y: 0 };
  for (const root of rootBones(data)) walk(root, origin);
  return positions;
}

/**
 * The angles a joint actually moves through.
 *
 * A bone with its own `angles` uses them. A chain bone reads them off the
 * chain's floppiness instead: the span opens up as floppiness rises, the
 * stiffness falls away, and `taper` tips both further along the chain so the tip
 * of a tentacle is looser than its base. The rig's `looseness` then scales the
 * result, so one number can tighten a whole character.
 */
export function effectiveAngles(
  bone: Bone,
  chain: BoneChain | undefined,
  options: RigOptions = DEFAULT_RIG_OPTIONS,
): AngleLimits {
  const scale = Math.max(0, options.looseness);
  if (bone.angles) {
    return {
      min: Math.round(bone.angles.min * scale * 10) / 10,
      max: Math.round(bone.angles.max * scale * 10) / 10,
      stiffness: bone.angles.stiffness,
    };
  }
  if (!chain) {
    // A bone with neither its own angles nor a chain is a bug in a template
    // rather than a pose, so it is locked rather than silently free.
    return { min: 0, max: 0, stiffness: 1 };
  }

  const index = Math.max(0, chain.bones.indexOf(bone.id));
  const last = Math.max(1, chain.bones.length - 1);
  // 0 at the base, 1 at the tip.
  const along = index / last;
  const taper = Math.max(0, Math.min(1, chain.taper));
  const floppiness = Math.max(0, Math.min(1, chain.floppiness));
  // The tip gets the chain's floppiness; the base gives up `taper` of it. Nothing
  // is scaled above the ceiling, so the gradient holds at every floppiness.
  const open = floppiness * (1 - taper * (1 - along));
  const span = Math.round(chain.span * open * scale * 10) / 10;

  return { min: -span, max: span, stiffness: Math.round((1 - open) * 100) / 100 };
}

/** The stretch a bone actually has, with the rig's own multiplier applied. */
export function effectiveStretch(bone: Bone, options: RigOptions = DEFAULT_RIG_OPTIONS): StretchLimits {
  const scale = Math.max(0, options.squashAndStretch);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    min: round(1 - (1 - bone.stretch.min) * scale),
    max: round(1 + (bone.stretch.max - 1) * scale),
    stiffness: bone.stretch.stiffness,
  };
}

/* ------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------ */

/** `left-forearm` and `right-forearm` are twins; everything else has none. */
export function mirrorIdOf(id: string): string | undefined {
  if (id.startsWith('left-')) return `right-${id.slice(5)}`;
  if (id.startsWith('right-')) return `left-${id.slice(6)}`;
  return undefined;
}

/**
 * Change one bone's limits, and its twin's when mirroring is on.
 *
 * Mirroring is on by default because a character with a loose left elbow and a
 * tight right one is almost always a mistake rather than a choice, and it is a
 * mistake that is hard to see in a still pose.
 */
export function setBoneLimits(
  data: RigFlowData,
  id: string,
  change: { stretch?: Partial<StretchLimits>; angles?: Partial<AngleLimits> | null },
): RigFlowData {
  const twin = data.options.mirror ? mirrorIdOf(id) : undefined;
  const targets = new Set([id, ...(twin ? [twin] : [])]);

  return {
    ...data,
    bones: data.bones.map((bone) => {
      if (!targets.has(bone.id)) return bone;
      const next: Bone = { ...bone };
      if (change.stretch) next.stretch = { ...bone.stretch, ...change.stretch };
      if (change.angles === null) delete next.angles;
      else if (change.angles) {
        const base = bone.angles ?? { min: 0, max: 0, stiffness: 0.5 };
        next.angles = { ...base, ...change.angles };
      }
      return next;
    }),
  };
}

export function setChain(
  data: RigFlowData,
  id: string,
  change: Partial<Pick<BoneChain, 'floppiness' | 'taper' | 'span'>>,
): RigFlowData {
  const twin = data.options.mirror ? mirrorIdOf(id) : undefined;
  const targets = new Set([id, ...(twin ? [twin] : [])]);
  return {
    ...data,
    chains: data.chains.map((chain) => (targets.has(chain.id) ? { ...chain, ...change } : chain)),
  };
}

const MIRROR = {
  x: { x: -1, y: 1 },
  y: { x: 1, y: -1 },
  none: { x: 1, y: 1 },
} as const;

/**
 * Which way a rig's two sides mirror each other, read off its twins.
 *
 * A person drawn face on is mirrored left for right (`x`); a fish seen from the
 * side has its fins above and below (`y`); a horse seen from the side has both
 * legs in the same place (`none`). Judged over every pair together rather than
 * one at a time, because a single bone can fit two answers — a leg pointing
 * straight down is its own reflection.
 */
export function mirrorAxis(data: RigFlowData): 'x' | 'y' | 'none' {
  const cost = { x: 0, y: 0, none: 0 };
  for (const bone of data.bones) {
    if (!bone.id.startsWith('left-')) continue;
    const twin = boneById(data, mirrorIdOf(bone.id)!);
    if (!twin) continue;
    for (const axis of ['x', 'y', 'none'] as const) {
      const flip = MIRROR[axis];
      cost[axis] += Math.hypot(bone.offset.x * flip.x - twin.offset.x, bone.offset.y * flip.y - twin.offset.y);
    }
  }
  // Ties go to the plainest answer, which is also what a rig with no twins gets.
  return cost.x < cost.none && cost.x <= cost.y ? 'x' : cost.y < cost.none ? 'y' : 'none';
}

/**
 * Move a joint: the far end of a bone goes to `to`.
 *
 * Only the bone's own offset changes. Everything hanging off it is stored
 * relative to it, so it comes along — pulling a wrist takes the hand with it
 * and leaves the elbow where it was.
 *
 * With `mirrorMoves` on, the twin's joint moves the matching way, reflected
 * across the rig's own mirror (`mirrorAxis`) — never assumed to be left for
 * right. The twin's own shape is kept: an arm already raised a little higher
 * than the other stays that much higher.
 */
export function moveRigJoint(data: RigFlowData, boneId: string, to: Vec2): RigFlowData {
  const bone = boneById(data, boneId);
  const place = restPose(data).get(boneId);
  if (!bone || !place) return data;
  const offset = { x: to.x - place.from.x, y: to.y - place.from.y };
  const dx = offset.x - bone.offset.x;
  const dy = offset.y - bone.offset.y;

  const options = { ...DEFAULT_RIG_OPTIONS, ...data.options };
  const twinId = options.mirrorMoves ? mirrorIdOf(boneId) : undefined;
  const twin = twinId ? boneById(data, twinId) : undefined;
  let twinOffset: Vec2 | undefined;
  if (twin) {
    const flip = MIRROR[mirrorAxis(data)];
    twinOffset = { x: twin.offset.x + dx * flip.x, y: twin.offset.y + dy * flip.y };
  }

  return {
    ...data,
    bones: data.bones.map((candidate) => {
      if (candidate.id === boneId) return { ...candidate, offset };
      if (twin && twinOffset && candidate.id === twin.id) return { ...candidate, offset: twinOffset };
      return candidate;
    }),
  };
}

/** Put one bone back to what its character type says it should be. */
export function resetBone(data: RigFlowData, id: string): RigFlowData {
  const fresh = rigTemplate(data.kind).bones.find((entry) => entry.id === id);
  if (!fresh) return data;
  return { ...data, bones: data.bones.map((bone) => (bone.id === id ? fresh : bone)) };
}

/* ------------------------------------------------------------------ *
 * Checking it
 * ------------------------------------------------------------------ */

export interface RigProblem {
  boneId?: string;
  chainId?: string;
  message: string;
}

/**
 * What is wrong with a rig, in the terms whoever has to animate it would use.
 *
 * A joint whose range is nought degrees is welded, which is sometimes right and
 * usually a slip. A range that does not include the rest pose means the
 * character starts the shot already out of bounds, which is the one that wastes
 * an afternoon.
 */
export function rigProblems(data: RigFlowData): RigProblem[] {
  const problems: RigProblem[] = [];
  const ids = new Set<string>();

  for (const bone of data.bones) {
    if (ids.has(bone.id)) problems.push({ boneId: bone.id, message: 'two bones share this id' });
    ids.add(bone.id);
    if (bone.parent && !data.bones.some((entry) => entry.id === bone.parent)) {
      problems.push({ boneId: bone.id, message: `its parent ${bone.parent} is not in the rig` });
    }
    if (boneLength(bone) === 0 && bone.parent) {
      problems.push({ boneId: bone.id, message: 'has no length, so it cannot be posed' });
    }

    const stretch = effectiveStretch(bone, data.options);
    if (stretch.min > stretch.max) {
      problems.push({ boneId: bone.id, message: 'its shortest length is longer than its longest' });
    }
    if (stretch.min <= 0) {
      problems.push({ boneId: bone.id, message: 'can squash to nothing or inside out' });
    }

    const angles = effectiveAngles(bone, chainById(data, bone.chain), data.options);
    if (angles.min > angles.max) {
      problems.push({ boneId: bone.id, message: 'its angle range runs backwards' });
    }
    if (angles.min > 0 || angles.max < 0) {
      problems.push({
        boneId: bone.id,
        message: 'its rest pose is outside its own range of motion',
      });
    }
  }

  for (const chain of data.chains) {
    const missing = chain.bones.filter((id) => !ids.has(id));
    if (missing.length > 0) {
      problems.push({ chainId: chain.id, message: `names ${missing.length} bone(s) that are not in the rig` });
    }
    if (chain.bones.length < 2) {
      problems.push({ chainId: chain.id, message: 'has fewer than two bones, so it is not a chain' });
    }
  }

  // A cycle would make `restPose` recurse forever, so it is checked rather than
  // discovered.
  const posed = restPose(data);
  if (posed.size !== data.bones.length) {
    problems.push({
      message: `${data.bones.length - posed.size} bone(s) are not reachable from a root — the hierarchy has a loop or a gap`,
    });
  }

  return problems;
}

export interface RigSummary {
  kind: RigKind;
  bones: number;
  chains: number;
  /** Bones that are part of a chain, so read their angles off it. */
  chained: number;
  /** Joints that cannot move at all. */
  welded: number;
  /** Bones that can change length. */
  stretchy: number;
  /** Total rest length of every bone, in rig units. */
  span: number;
  /** How tall the rest pose is, in rig units. */
  height: number;
  problems: number;
}

export function summariseRig(data: RigFlowData): RigSummary {
  const posed = restPose(data);
  const ys = [...posed.values()].flatMap((entry) => [entry.from.y, entry.to.y]);
  let welded = 0;
  let stretchy = 0;

  for (const bone of data.bones) {
    const angles = effectiveAngles(bone, chainById(data, bone.chain), data.options);
    if (angles.max - angles.min === 0) welded += 1;
    const stretch = effectiveStretch(bone, data.options);
    if (stretch.min < 1 || stretch.max > 1) stretchy += 1;
  }

  return {
    kind: data.kind,
    bones: data.bones.length,
    chains: data.chains.length,
    chained: data.bones.filter((bone) => bone.chain).length,
    welded,
    stretchy,
    span: Math.round(data.bones.reduce((sum, bone) => sum + boneLength(bone), 0)),
    height: ys.length > 0 ? Math.round(Math.max(...ys) - Math.min(...ys)) : 0,
    problems: rigProblems(data).length,
  };
}
