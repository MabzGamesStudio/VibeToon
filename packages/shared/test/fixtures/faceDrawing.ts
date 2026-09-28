import type { VectorImage, VectorPoint, VectorShape } from '../../src/flows/vector';

/** An ellipse as a polygon. */
export function ellipse(cx: number, cy: number, rx: number, ry: number, sides = 16): VectorPoint[] {
  return Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * Math.PI * 2;
    return { x: Math.round((cx + Math.cos(angle) * rx) * 100) / 100, y: Math.round((cy + Math.sin(angle) * ry) * 100) / 100 };
  });
}

const poly = (id: string, color: string, points: VectorPoint[]): VectorShape => ({ id, kind: 'polygon', color, points });

/**
 * A cartoon head with every feature: a face, hair over the top, ears, eyebrows,
 * eyes with pupils, a nose and a mouth with teeth. `dx` moves it, `k` sizes it,
 * and `eyeColor` tells two heads' eyes apart.
 */
export function faceDrawing(prefix = '', dx = 0, k = 1, eyeColor = '#222222'): VectorImage {
  const at = (x: number, y: number) => ({ x: 100 + dx + (x - 100) * k, y: 100 + (y - 100) * k });
  const e = (cx: number, cy: number, rx: number, ry: number, sides?: number) => ellipse(at(cx, cy).x, at(cx, cy).y, rx * k, ry * k, sides);
  const id = (name: string) => `${prefix}${name}`;
  return {
    width: 400,
    height: 240,
    shapes: [
      poly(id('ear-l'), '#e8b890', e(38, 110, 10, 18, 10)),
      poly(id('ear-r'), '#e8b890', e(162, 110, 10, 18, 10)),
      poly(id('face'), '#f0c8a0', e(100, 110, 60, 75, 24)),
      poly(id('hair'), '#5a3420', [at(40, 70), at(50, 35), at(100, 20), at(150, 35), at(160, 70), at(130, 55), at(100, 50), at(70, 55)]),
      poly(id('brow-l'), '#3a2010', [at(62, 78), at(90, 76), at(90, 81), at(62, 83)]),
      poly(id('brow-r'), '#3a2010', [at(110, 76), at(138, 78), at(138, 83), at(110, 81)]),
      poly(id('eye-l'), eyeColor, e(76, 96, 11, 7, 12)),
      poly(id('pupil-l'), '#ffffff', e(78, 95, 3, 3, 8)),
      poly(id('eye-r'), eyeColor, e(124, 96, 11, 7, 12)),
      poly(id('pupil-r'), '#ffffff', e(126, 95, 3, 3, 8)),
      poly(id('nose'), '#d8a080', [at(100, 108), at(106, 128), at(94, 128)]),
      poly(id('mouth'), '#a02030', e(100, 150, 20, 7, 14)),
      poly(id('teeth'), '#ffffff', e(100, 147, 12, 2.5, 8)),
    ],
  };
}
