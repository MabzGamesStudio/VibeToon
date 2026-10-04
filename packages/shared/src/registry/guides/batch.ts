import type { AlgorithmGuide } from '../guides';

export const BATCH_SELECT_GUIDE: AlgorithmGuide = {
  kinds: ['production.batch.select'],
  title: 'Batches in, the items you tick out',
  summary:
    'Every folder or batch wired into Items is listed, item by item. A batch flow’s items arrive gathered into one folder; a folder arrives whole. You untick what you do not want. The ticked items are copied into one folder on Selected, which a flow taking one file runs as a batch, and the rest into another. Choices are kept by where an item came from and its own key, and it is the unticked ones that are stored, so an item that arrives later is ticked.',
  steps: [
    { kind: 'input', title: 'Any number of folders or batches on Items' },
    {
      kind: 'loop',
      title: 'For each wire, in the order it was made',
      steps: [
        { kind: 'step', title: 'List its items', detail: 'A folder’s files, or a batch flow’s items (gathered), or the items it will make (not made yet).' },
        { kind: 'step', title: 'Key each one: source flow, port and item key' },
        { kind: 'step', title: 'Name each one', detail: 'A batch item after the item it is (shot-01.png); a name already taken gets the source’s name in front.' },
      ],
    },
    { kind: 'decision', title: 'Has the item been made?', no: 'Left out, and the report says so.' },
    { kind: 'decision', title: 'Is it the same kind as the first item made?', no: 'Set aside: a folder holds one kind of file.' },
    { kind: 'decision', title: 'Is it ticked (not in the left-out list)?', no: 'It goes on The rest.' },
    { kind: 'output', title: 'Selected and The rest, each one folder; selection.md' },
  ],
  pseudocode: `items = []
for wire in wires into "items":
    for item in items_of(wire):              # folder entries, or a batch gathered
        key  = f"{wire.from_node}:{wire.from_port}/{item.key}"
        name = item.file if item.file == item.key else stem(item.key) + ext(item.file)
        if name taken: name = f"{wire.source_name}-{name}"
        items.append(key, name, item)

kind = kind of the first item made
for item in items:
    if not made(item):        waiting.append(item); continue
    if item.kind != kind:     other_kind.append(item); continue
    (rest if item.key in excluded else selected).append(item)

write_folder("selected", selected); write_folder("rest", rest)`,
  sections: [
    {
      heading: 'Why the unticked are stored, not the ticked',
      body: 'A batch grows: split the video again and a shot appears. Storing what was left out means a new item arrives ticked and goes on through the graph, which is what usually wants to happen; storing what was ticked would leave every new item out until it was noticed.',
    },
    {
      heading: 'Gathered, not batched',
      body: 'Items takes folders only. So a batch flow wired in does not make Batch Select a batch of its own — its items arrive gathered, one folder holding every item’s file — and Batch Select runs once, over all of them, as choosing between items needs.',
    },
    {
      heading: 'Names that stay apart',
      body: 'Every item of a Video Background is background.png, so items of a batch are named for the item they are: the backgrounds of shot-01 and shot-02 are shot-01.png and shot-02.png. Two Shot Splits both have a shot-01.webm, so the second is named for the flow it came from.',
    },
  ],
  resources: [{ title: 'Batches in VibeToon', url: 'https://github.com/MabzGamesStudio/VibeToon/blob/main/docs/BATCHES.md', note: 'How folders become batches and are gathered again.' }],
  source: ['packages/shared/src/flows/batchSelect.ts — selectSources, splitSelection, setSelected, invertSelected', 'packages/server/src/generators/batchSelect.ts — generateBatchSelect'],
  tryIt: 'Wire two Shot Splits’ clips into one Batch Select, untick a few shots, and wire Selected into a Video Background.',
};
