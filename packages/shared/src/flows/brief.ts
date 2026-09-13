import type { BriefFieldSpec, FlowKindDef } from '../types/flow';
import type { BriefFlowData } from '../types/project';

export function emptyBriefData(def: FlowKindDef): BriefFlowData {
  const fields: Record<string, string> = {};
  for (const field of def.fields ?? []) fields[field.id] = '';
  return { editor: 'brief', fields };
}

export function briefValue(data: BriefFlowData, fieldId: string): string {
  return data.fields[fieldId] ?? '';
}

/** `list` fields are one item per line; blank lines are dropped. */
export function parseListField(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

export interface UpstreamContext {
  /** e.g. `Outline / Beat Sheet → Outline` */
  label: string;
  rules: string;
  mode: string;
  weight: number;
  /** Excerpt of the upstream artifact, already truncated by the caller. */
  excerpt?: string;
}

export interface BriefRenderInput {
  title: string;
  def: FlowKindDef;
  data: BriefFlowData;
  /** The flow's own notes. */
  notes: string;
  projectStyleNote: string;
  upstream: UpstreamContext[];
}

function renderField(spec: BriefFieldSpec, raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  const lines: string[] = [`## ${spec.label}`, ''];
  if (spec.input === 'list') {
    for (const item of parseListField(value)) lines.push(`- ${item}`);
  } else {
    lines.push(value);
  }
  lines.push('');
  return lines;
}

/**
 * The brief editor's output: a markdown document that reads like a document a
 * person would write, with everything arriving over the connections recorded
 * underneath it so a downstream flow (or a reader) can see what shaped it.
 */
export function formatBriefMarkdown(input: BriefRenderInput): string {
  const { title, def, data, notes, projectStyleNote, upstream } = input;
  const lines: string[] = [`# ${title}`, '', `*${def.label} — ${def.summary}*`, ''];

  let wroteField = false;
  for (const spec of def.fields ?? []) {
    const rendered = renderField(spec, briefValue(data, spec.id));
    if (rendered.length > 0) wroteField = true;
    lines.push(...rendered);
  }
  if (!wroteField) {
    lines.push('> Nothing filled in yet.', '');
  }

  if (notes.trim()) {
    lines.push('## Flow notes', '', notes.trim(), '');
  }

  if (projectStyleNote.trim()) {
    lines.push('## Project style', '', projectStyleNote.trim(), '');
  }

  if (upstream.length > 0) {
    lines.push('## Inputs', '');
    for (const source of upstream) {
      lines.push(`### ${source.label}`, '');
      lines.push(`- Mode: ${source.mode} (weight ${source.weight.toFixed(2)})`);
      lines.push('');
      if (source.rules.trim()) {
        lines.push('Rules on the connection:', '', '```', source.rules.trim(), '```', '');
      }
      if (source.excerpt?.trim()) {
        lines.push('What it carries:', '', '```', source.excerpt.trim(), '```', '');
      }
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Plain-text flavour of the same brief, for `text` output ports. */
export function formatBriefText(input: BriefRenderInput): string {
  return formatBriefMarkdown(input)
    .replace(/^#+\s*/gm, '')
    .replace(/^\*(.*)\*$/gm, '$1')
    .replace(/^```$/gm, '---');
}

export function briefPayload(def: FlowKindDef, data: BriefFlowData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of def.fields ?? []) {
    const value = briefValue(data, spec.id);
    out[spec.id] = spec.input === 'list' ? parseListField(value) : value;
  }
  return out;
}

export function formatBriefCsv(def: FlowKindDef, data: BriefFlowData): string {
  const rows = [['field', 'value']];
  for (const spec of def.fields ?? []) {
    for (const value of spec.input === 'list'
      ? parseListField(briefValue(data, spec.id))
      : [briefValue(data, spec.id)]) {
      if (!value.trim()) continue;
      rows.push([spec.id, value]);
    }
  }
  return `${rows
    .map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','))
    .join('\n')}\n`;
}
