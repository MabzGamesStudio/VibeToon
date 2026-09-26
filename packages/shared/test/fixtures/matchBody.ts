import { emptyRigFlowData, restPose, type RigFlowData } from '../../src/flows/rig';
import type { BoundRig } from '../../src/flows/rigBind';
import type { VectorPoint, VectorPolygon, VectorShape } from '../../src/flows/vector';

/**
 * A cartoon body on the human rig, for testing the rig match: a capsule of
 * color round every bone, with markings — eyes, a mouth, stripes, a belt,
 * cuffs — so the parts have something to be told apart by.
 */

const SCALE = 4;
const ORIGIN = { x: 200, y: 190 };

/** Width of each part's capsule, in rig units. */
const WIDTH: Record<string, number> = {
  hips: 13,
  spine: 13,
  chest: 15,
  neck: 5,
  head: 12,
  'left-shoulder': 5,
  'right-shoulder': 5,
  'left-upper-arm': 4.5,
  'right-upper-arm': 4.5,
  'left-forearm': 4,
  'right-forearm': 4,
  'left-hand': 5,
  'right-hand': 5,
  'left-leg-thigh': 6,
  'right-leg-thigh': 6,
  'left-leg-shin': 5,
  'right-leg-shin': 5,
  'left-leg-foot': 4.5,
  'right-leg-foot': 4.5,
};

const COLOR: Record<string, string> = {
  hips: '#3b4a8c',
  spine: '#d9483b',
  chest: '#d9483b',
  neck: '#f1c6a0',
  head: '#f1c6a0',
  'left-shoulder': '#d9483b',
  'right-shoulder': '#d9483b',
  'left-upper-arm': '#e0674c',
  'right-upper-arm': '#c9383b',
  'left-forearm': '#f1c6a0',
  'right-forearm': '#eab88f',
  'left-hand': '#f5d2b0',
  'right-hand': '#e8b690',
  'left-leg-thigh': '#3b4a8c',
  'right-leg-thigh': '#34427d',
  'left-leg-shin': '#4b5aa0',
  'right-leg-shin': '#2e3b70',
  'left-leg-foot': '#5a3a22',
  'right-leg-foot': '#4a2e1a',
};

function capsule(from: VectorPoint, to: VectorPoint, radius: number, steps = 8): VectorPoint[] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const points: VectorPoint[] = [];
  const same = Math.hypot(to.x - from.x, to.y - from.y) < 1e-6;
  for (let step = 0; step <= steps; step += 1) {
    const a = angle - Math.PI / 2 - (step / steps) * Math.PI;
    points.push({ x: from.x + Math.cos(a) * radius, y: from.y + Math.sin(a) * radius });
  }
  for (let step = 0; step <= steps; step += 1) {
    const a = angle + Math.PI / 2 - (step / steps) * Math.PI;
    points.push({ x: to.x + Math.cos(a) * radius, y: to.y + Math.sin(a) * radius });
  }
  if (same) {
    // A zero-length bone: a round blob.
    return Array.from({ length: 16 }, (_, index) => {
      const a = (index / 16) * Math.PI * 2;
      return { x: from.x + Math.cos(a) * radius, y: from.y + Math.sin(a) * radius };
    });
  }
  return points.map((point) => ({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 }));
}

function disc(at: VectorPoint, radius: number, steps = 10): VectorPoint[] {
  return Array.from({ length: steps }, (_, index) => {
    const a = (index / steps) * Math.PI * 2;
    return { x: Math.round((at.x + Math.cos(a) * radius) * 100) / 100, y: Math.round((at.y + Math.sin(a) * radius) * 100) / 100 };
  });
}

function band(from: VectorPoint, to: VectorPoint, at: number, halfWidth: number, thickness: number): VectorPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const cx = from.x + dx * at;
  const cy = from.y + dy * at;
  const px = -uy * halfWidth;
  const py = ux * halfWidth;
  const tx = ux * thickness;
  const ty = uy * thickness;
  return [
    { x: cx + px - tx, y: cy + py - ty },
    { x: cx - px - tx, y: cy - py - ty },
    { x: cx - px + tx, y: cy - py + ty },
    { x: cx + px + tx, y: cy + py + ty },
  ];
}

export function matchBody(): BoundRig {
  const base = emptyRigFlowData('human');
  const rig: RigFlowData = {
    ...base,
    bones: base.bones.map((bone) => ({ ...bone, offset: { x: bone.offset.x * SCALE, y: bone.offset.y * SCALE } })),
    origin: { ...ORIGIN },
  };
  const rest = restPose(rig);
  const shapes: VectorShape[] = [];
  const points: Record<string, Array<string | null>> = {};
  const add = (id: string, bone: string, color: string, outline: VectorPoint[]) => {
    const shape: VectorPolygon = { id, kind: 'polygon', color, points: outline };
    shapes.push(shape);
    points[id] = outline.map(() => bone);
  };
  // Back to front: legs and arms behind the body.
  const order = [
    'left-leg-foot', 'right-leg-foot', 'left-leg-shin', 'right-leg-shin', 'left-leg-thigh', 'right-leg-thigh',
    'hips', 'spine', 'chest', 'neck', 'head',
    'left-shoulder', 'right-shoulder', 'left-upper-arm', 'right-upper-arm', 'left-forearm', 'right-forearm', 'left-hand', 'right-hand',
  ];
  for (const id of order) {
    const place = rest.get(id)!;
    add(`part-${id}`, id, COLOR[id]!, capsule(place.from, place.to, ((WIDTH[id] ?? 4) * SCALE) / 2));
  }
  // Markings.
  const head = rest.get('head')!;
  const headMiddle = { x: (head.from.x + head.to.x) / 2, y: (head.from.y + head.to.y) / 2 };
  add('eye-left', 'head', '#1b1b1b', disc({ x: headMiddle.x - 9, y: headMiddle.y - 4 }, 3.2));
  add('eye-right', 'head', '#1b1b1b', disc({ x: headMiddle.x + 9, y: headMiddle.y - 4 }, 3.2));
  add('mouth', 'head', '#8a2a2a', band({ x: headMiddle.x - 8, y: headMiddle.y + 10 }, { x: headMiddle.x + 8, y: headMiddle.y + 10 }, 0.5, 1.6, 8));
  add('hair', 'head', '#4a2a12', capsule({ x: head.to.x - 14, y: head.to.y + 4 }, { x: head.to.x + 14, y: head.to.y + 4 }, 7));
  const chest = rest.get('chest')!;
  for (const [index, at] of [0.25, 0.6].entries()) add(`stripe-${index}`, 'chest', '#f4f0e0', band(chest.from, chest.to, at, 28, 3.5));
  const spine = rest.get('spine')!;
  add('belt', 'spine', '#2a1a10', band(spine.from, spine.to, 0.08, 26, 4));
  add('buckle', 'spine', '#e8c440', band(spine.from, spine.to, 0.08, 5, 4.6));
  for (const side of ['left', 'right']) {
    const fore = rest.get(`${side}-forearm`)!;
    add(`cuff-${side}`, `${side}-forearm`, '#ffffff', band(fore.from, fore.to, 0.85, 9, 3));
    const shin = rest.get(`${side}-leg-shin`)!;
    add(`sock-${side}`, `${side}-leg-shin`, side === 'left' ? '#f0f0f0' : '#d8d020', band(shin.from, shin.to, 0.88, 11, 4));
    const thigh = rest.get(`${side}-leg-thigh`)!;
    add(`patch-${side}`, `${side}-leg-thigh`, side === 'left' ? '#6a7ad0' : '#20284a', band(thigh.from, thigh.to, 0.5, 8, 5));
  }
  return { rig, image: { width: 400, height: 400, shapes }, points };
}
