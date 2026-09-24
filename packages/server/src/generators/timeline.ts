import {
  exportEvents,
  formatPartialTime,
  isFiltering,
  matchesFilter,
  spanRange,
  summariseTimeline,
  timeRange,
  type TimelineFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The timeline, written out: every event as data, and as a chronology to read.
 *
 * All the events, whatever the editor happens to be filtering by — a filter is
 * a way of looking, not a decision about what exists. The filter in force is
 * noted in the doc, so nobody wonders where an event went.
 */
export async function generateTimeline(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as TimelineFlowData;
  const events = exportEvents(data);
  const span = spanRange(data.span);

  if (events.length === 0) ctx.warn('There are no events yet. Open the timeline and add some.');
  const undated = data.events.filter((event) => !timeRange(event.start));
  if (undated.length > 0) {
    ctx.log(`${undated.length} event(s) have no date yet, and are listed at the end.`);
  }
  const outside = data.events.filter((event) => {
    const range = timeRange(event.start);
    return range && (range.to <= span.from || range.from >= span.to);
  });
  if (outside.length > 0) {
    ctx.warn(
      `${outside.length} event(s) fall outside the timeline's span (${new Date(span.from).toISOString().slice(0, 10)} to ${new Date(span.to).toISOString().slice(0, 10)}), so they cannot be seen on it: ${outside
        .slice(0, 4)
        .map((event) => `“${event.title}”`)
        .join(', ')}${outside.length > 4 ? '…' : ''}`,
    );
  }
  for (const event of data.events) {
    const start = timeRange(event.start);
    const end = event.end ? timeRange(event.end) : null;
    if (start && end && end.to <= start.from) ctx.warn(`“${event.title}” ends before it starts.`);
  }

  const json = {
    span: {
      start: new Date(span.from).toISOString(),
      end: new Date(span.to).toISOString(),
      endIsToday: data.span.end === null,
    },
    colorBy: data.color.by,
    events,
  };

  const shown = data.events.filter((event) => matchesFilter(event, data.filter)).length;
  const lines = [
    `# ${ctx.node.name}`,
    '',
    summariseTimeline(data),
    '',
    `- Span: ${formatPartialTime({ year: new Date(span.from).getUTCFullYear(), month: new Date(span.from).getUTCMonth() + 1, day: new Date(span.from).getUTCDate() })} to ${
      data.span.end === null ? 'today' : new Date(span.to).toISOString().slice(0, 10)
    } (UTC)`,
    ...(isFiltering(data.filter)
      ? [`- The editor is filtering (${shown} of ${data.events.length} shown); everything is written out here regardless.`]
      : []),
    '',
    '## Events',
    '',
  ];
  for (const event of events) {
    lines.push(`### ${event.when} — ${event.title}`);
    lines.push('');
    const facts = [
      ...(event.duration ? [`**Lasts:** ${event.duration}`] : []),
      ...(event.timeNote ? [`**When:** ${event.timeNote}`] : []),
      ...(event.places.length > 0 ? [`**Where:** ${event.places.map((place) => place.label).join('; ')}`] : []),
      ...(event.characters.length > 0 ? [`**Who:** ${event.characters.join(', ')}`] : []),
      ...(event.tags.length > 0 ? [`**Tags:** ${event.tags.join(', ')}`] : []),
    ];
    if (facts.length > 0) lines.push(facts.join(' · '), '');
    if (event.details.trim()) lines.push(event.details.trim(), '');
    if (event.dialog.length > 0) {
      for (const line of event.dialog) {
        lines.push(`> **${line.character || '—'}**${line.direction ? ` _(${line.direction})_` : ''}: ${line.line}`);
      }
      lines.push('');
    }
  }

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'timeline',
      kind: 'json',
      fileName: 'timeline.json',
      content: `${JSON.stringify(json, null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'doc',
      kind: 'markdown',
      fileName: 'timeline.md',
      content: `${lines.join('\n').trimEnd()}\n`,
    }),
  ];
  return { outputs };
}
