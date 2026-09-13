/**
 * Regenerates docs/FLOWS.md from the flow catalogue, so the document cannot
 * drift from the code. Run with `npm run docs:flows`.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLOW_CATEGORIES,
  FLOW_CATEGORY_LABEL,
  FLOW_KINDS,
  type PortSpec,
} from '../packages/shared/src/index';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ports(list: PortSpec[]): string {
  if (list.length === 0) return '—';
  return list
    .map((port) => {
      const file = port.fileName ? ` \`${port.fileName}\`` : '';
      const required = port.required ? ' *(required)*' : '';
      return `${port.label}${file}${required}`;
    })
    .join(', ');
}

const lines: string[] = [
  '# The flow catalogue',
  '',
  'Every kind of work that goes into a clip, as a flow with typed inputs and',
  'outputs. Two have a bespoke editor; the rest use the brief editor, which',
  'collects the fields listed here and generates a markdown brief with everything',
  'arriving over their connections recorded underneath.',
  '',
  '*Generated from `packages/shared/src/registry/flowKinds.ts` by `npm run docs:flows`.*',
  '',
];

for (const category of FLOW_CATEGORIES) {
  const defs = FLOW_KINDS.filter((def) => def.category === category);
  if (defs.length === 0) continue;
  lines.push(`## ${FLOW_CATEGORY_LABEL[category]}`, '');
  for (const def of defs) {
    lines.push(`### ${def.label}`, '');
    lines.push(`\`${def.kind}\` · ${def.maturity === 'editor' ? '**bespoke editor**' : 'brief editor'}`, '');
    lines.push(def.summary, '');
    lines.push(`- **In:** ${ports(def.inputs)}`);
    lines.push(`- **Out:** ${ports(def.outputs)}`);
    if (def.fields?.length) {
      lines.push(`- **Fields:** ${def.fields.map((field) => field.label).join(', ')}`);
    }
    if (def.defaultOutgoingRules) {
      lines.push('- **Default rules on a new outgoing connection:**');
      lines.push('');
      lines.push('  ```');
      for (const rule of def.defaultOutgoingRules.split('\n')) lines.push(`  ${rule}`);
      lines.push('  ```');
    }
    lines.push('');
  }
}

lines.push('---', '', `${FLOW_KINDS.length} flow kinds.`, '');

await writeFile(path.join(root, 'docs', 'FLOWS.md'), lines.join('\n'), 'utf8');
console.log(`Wrote docs/FLOWS.md (${FLOW_KINDS.length} flow kinds)`);
