/**
 * Regenerates docs/ALGORITHMS.md from the guides the studio shows under "How
 * it works", so the document and the studio say the same thing. Run with
 * `npm run docs:flows`.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALGORITHM_GUIDES,
  FLOW_KINDS,
  NO_ALGORITHM,
  type AlgorithmGuide,
  type GuideStep,
} from '../packages/shared/src/index';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const labelOf = (kind: string) => FLOW_KINDS.find((def) => def.kind === kind)?.label ?? kind;

/** Text safe inside a quoted Mermaid label. */
function mermaidText(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/[<>]/g, (char) => (char === '<' ? '#lt;' : '#gt;'));
}

/**
 * The steps as a Mermaid flowchart: boxes in order, loops as boxed groups with
 * an arrow back to their start, and decisions as diamonds whose "no" goes off
 * to the side.
 */
function flowchart(steps: readonly GuideStep[]): string[] {
  const out = ['```mermaid', 'flowchart TD'];
  let serial = 0;
  const next = () => `s${(serial += 1)}`;
  // Nested loops that end on the same step would draw the same arrow back once each.
  const edges = new Set<string>();
  const edge = (indent: string, from: string, arrow: string, to: string) => {
    const key = `${from} ${to}`;
    if (edges.has(key)) return;
    edges.add(key);
    out.push(`${indent}${from} ${arrow} ${to}`);
  };

  /** Draw a run of steps; returns the first and last node ids. */
  const run = (list: readonly GuideStep[], indent: string): { first: string; last: string } | null => {
    let first: string | null = null;
    let last: string | null = null;
    for (const step of list) {
      let head: string;
      let tail: string;
      if (step.kind === 'loop') {
        const group = next();
        out.push(`${indent}subgraph ${group}["↻ ${mermaidText(step.title)}"]`);
        const inner = run(step.steps, `${indent}  `);
        out.push(`${indent}end`);
        if (!inner) continue;
        edge(indent, inner.last, '-. next .->', inner.first);
        head = inner.first;
        tail = inner.last;
      } else {
        head = tail = next();
        const text = mermaidText(step.title);
        if (step.kind === 'decision') {
          out.push(`${indent}${head}{"${text}"}`);
          const side = next();
          out.push(`${indent}${side}["${mermaidText(step.no)}"]`);
          edge(indent, head, '-- no -->', side);
        } else if (step.kind === 'input' || step.kind === 'output') {
          out.push(`${indent}${head}(["${text}"])`);
        } else {
          out.push(`${indent}${head}["${text}"]`);
        }
      }
      if (last) edge(indent, last, '-->', head);
      first ??= head;
      last = tail;
    }
    return first && last ? { first, last } : null;
  };

  run(steps, '  ');
  out.push('```');
  return out;
}

/** The same steps as a nested list, with the detail the chart leaves out. */
function stepList(steps: readonly GuideStep[], depth = 0): string[] {
  const pad = '  '.repeat(depth);
  return steps.flatMap((step) => {
    const detail = step.detail ? ` — ${step.detail}` : '';
    if (step.kind === 'loop') return [`${pad}- **↻ ${step.title}**${detail}`, ...stepList(step.steps, depth + 1)];
    if (step.kind === 'decision') return [`${pad}- **${step.title}**${detail} *If not:* ${step.no}`];
    if (step.kind === 'input') return [`${pad}- *In:* ${step.title}${detail}`];
    if (step.kind === 'output') return [`${pad}- *Out:* ${step.title}${detail}`];
    return [`${pad}- ${step.title}${detail}`];
  });
}

function guideDoc(guide: AlgorithmGuide): string[] {
  const lines = [
    `## ${guide.kinds.map(labelOf).join(', ')}`,
    '',
    `**${guide.title}** · ${guide.kinds.map((kind) => `\`${kind}\``).join(', ')}`,
    '',
    guide.summary,
    '',
    '### The steps',
    '',
    ...flowchart(guide.steps),
    '',
    ...stepList(guide.steps),
    '',
    '### Pseudocode',
    '',
    '```',
    guide.pseudocode,
    '```',
    '',
  ];
  for (const section of guide.sections) lines.push(`### ${section.heading}`, '', section.body, '');
  if (guide.settings?.length) {
    lines.push('### Settings', '', '| Setting | What it changes |', '| --- | --- |');
    for (const setting of guide.settings) lines.push(`| ${setting.name} | ${setting.effect.replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  if (guide.cost) lines.push(`**Cost:** ${guide.cost}`, '');
  if (guide.tryIt) lines.push(`**Try it:** ${guide.tryIt}`, '');
  lines.push('### Further reading', '');
  for (const resource of guide.resources) {
    const title = resource.url ? `[${resource.title}](${resource.url})` : resource.title;
    lines.push(`- ${title} — ${resource.note}`);
  }
  lines.push('', `*Code:* ${guide.source.map((file) => `\`${file}\``).join(', ')}`, '');
  return lines;
}

const lines: string[] = [
  '# How each flow works',
  '',
  'The algorithm behind every flow that has one, said four ways: a flow chart,',
  'pseudocode, the reasoning, and where to read more. The same guides are in the',
  'studio: open a flow and press **How it works**.',
  '',
  '*Generated from `packages/shared/src/registry/guides/` by `npm run docs:flows`.*',
  '',
  '## Contents',
  '',
  ...ALGORITHM_GUIDES.map((guide) => `- ${guide.kinds.map(labelOf).join(', ')} — ${guide.title}`),
  '',
];
for (const guide of ALGORITHM_GUIDES) lines.push(...guideDoc(guide));

lines.push('## Flows with no algorithm', '', 'These keep, fetch or arrange what is given to them.', '');
for (const [kind, why] of Object.entries(NO_ALGORITHM)) lines.push(`- **${labelOf(kind)}** (\`${kind}\`) — ${why}`);
lines.push('');

await writeFile(path.join(root, 'docs', 'ALGORITHMS.md'), lines.join('\n'), 'utf8');
console.log(`Wrote docs/ALGORITHMS.md (${ALGORITHM_GUIDES.length} guides)`);
