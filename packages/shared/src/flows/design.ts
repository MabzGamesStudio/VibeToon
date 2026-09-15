import { newId } from '../ids';
import type { FlowKindDef, PortSpec } from '../types/flow';
import type { DesignFlowData, DesignPlate } from '../types/design';

/** Plates a design flow starts with, so the sheet is not a blank page. */
const STARTER_PLATES: Record<string, string[]> = {
  'animation.character.design': ['Front', 'Three-quarter', 'Expressions'],
  'animation.set.design': ['Key view', 'Plan'],
  'animation.prop.design': ['Key view', 'In use'],
};

export function newPlate(label = 'Plate'): DesignPlate {
  return { id: newId('plate'), label, sketch: null, note: '' };
}

export function emptyDesignData(def: FlowKindDef): DesignFlowData {
  const fields: Record<string, string> = {};
  for (const field of def.fields ?? []) fields[field.id] = '';
  return {
    editor: 'design',
    fields,
    plates: (STARTER_PLATES[def.kind] ?? ['Key view']).map((label) => newPlate(label)),
  };
}

/** The single-image port a design flow's first plate becomes. */
export function keyImagePort(def: FlowKindDef): PortSpec | undefined {
  return def.outputs.find((port) => port.kinds.includes('image'));
}

/** The folder port every plate becomes, when the flow has one. */
export function plateSetPort(def: FlowKindDef): PortSpec | undefined {
  return def.outputs.find((port) => port.kinds.includes('imageSet'));
}

/** `modelsheet/plate-002-three-quarter.png` — stable, readable, ordered. */
export function plateFileName(index: number, label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'plate';
  return `plate-${String(index + 1).padStart(3, '0')}-${slug}.png`;
}

export function drawnPlates(data: DesignFlowData): DesignPlate[] {
  return data.plates.filter((plate) => plate.sketch !== null && plate.sketch.strokes.length > 0);
}
