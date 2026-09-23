/**
 * How big to draw a handle inside a stage that can be zoomed.
 *
 * A handle is a thing you grab, not a thing you look at: a joint, an anchor, the
 * outline round a selection. Drawn at a fixed size in the picture's own units it
 * grows with the zoom — and zooming in is exactly what you do when you want to
 * put one somewhere precise, so at eight times the dot is eight times wider than
 * the thing you are aiming at and covers the place you were trying to see.
 *
 * Dividing by the stage's scale keeps it the size it was when the picture fitted
 * the frame, however far in you go. `size` is therefore read as "the size it
 * looks at fit", which is the size somebody chose by eye in the first place.
 */
export function onScreen(size: number, scale: number): number {
  return size / Math.max(0.05, scale);
}
