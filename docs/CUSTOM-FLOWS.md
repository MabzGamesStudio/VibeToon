# Custom flows

An arrangement of flows, saved under a name and used again as one.

A chain you build more than once (picture → decomposition → vector edit, say)
can be saved as a **custom flow**. It appears in the palette under **Custom
flows**, and each use of it is one card on the graph. The card has the chain's
own inputs and outputs, and behind it are the chain's flows with the wires and
every setting they were saved with.

```
Picture ──▶ ┌ Trace ─────────────────────────────┐ ──▶ Rig Binding
            │  Decompose ──▶ Tidy                │
            └────────────────────────────────────┘
```

## Making one

There are two ways: build one from nothing on a graph of its own, or turn flows
already on the graph into one.

### On a graph of its own

1. On the graph, press **New custom flow**. A card appears, and its own graph
   opens: empty, with a **Takes** card on the left and a **Gives** card on the
   right.
2. Add flows from the palette beside it. They go inside the custom flow, not on
   the main graph.
3. Wire them as on the main graph: drag from a port to a port.
4. Drag an input onto **Takes** to show it on the card, so it can be wired from
   outside. Drag an output onto **Gives** to show that. A dotted line joins each
   to the port it stands for. **×** on either card, or **Hide** in the side
   panel, takes a port off the card again (with any wire to it from outside).
   **Show what the wiring leaves open** shows every input nothing inside feeds and
   every output nothing inside reads, keeping names already given.
5. Name it (on the graph and in the palette) and press **Save over the
   template**. It is in the palette under **Custom flows** from then on.

An input that another flow inside already feeds cannot be taken: it is not
something the custom flow takes from outside.

### From flows already on the graph

1. On the graph, press **Make a custom flow from these**.
2. Tick the flows that go in it. **+ everything upstream** adds everything that
   feeds the ones ticked.
3. Name it, and say what it does if you like.
4. Check the ports it will show:
   - **Takes**: every input of the chosen flows that is not fed by another of
     them. It is either wired from outside or not wired at all, so it is
     something the arrangement takes.
   - **Gives**: every output that something outside reads, or that nothing
     inside reads. An output only the arrangement itself uses stays inside.
   - Untick any port to keep it inside as well. Two ports with the same name
     are told apart by their flows' names, e.g. *Decompose · Drawing* and
     *Tidy · Drawing*.
5. Press **Make it**.

The flows you chose go behind one card where they were, and they keep their
settings, their files and their wires. The arrangement is saved to the project
as a **template**.

## Using it again

Click it in the palette under **Custom flows**. Each use gets **its own copies**
of the flows inside, with the settings the template was saved with and wired as
they were.

Editing one use changes that use alone. Neither the template nor any other use
of it is touched. That is what lets the same arrangement run with different
settings in two places.

## Inside a custom flow

Double-click the card to open it. It opens as a graph of its own, laid out like
the main one:

- the flows inside, as cards, wired to one another. Drag them about, wire and
  unwire them, add flows from the palette, delete them with Delete;
- **Takes** on the left and **Gives** on the right: the ports on the card, each
  joined by a dotted line to the flow port it stands for;
- a side panel with its names, its template, and its ports: which flow and port
  each stands for, and what it is wired to outside. Each port's name can be
  edited.

Double-click a flow (or select it and press Enter) to open its ordinary editor.
Everything works there as it always does, including undo. The back button, and the
path in the header, lead back to the custom flow. Selecting a wire opens the
inspector beside the graph, for its rules.

Undo here is the graph's undo: adding, wiring, moving and removing flows inside
it, and showing and hiding ports.

| Button | What it does |
| --- | --- |
| **Generate** | Generates every flow inside, upstream first, so each reads what the one before it made in the same pass. |
| **Save over the template** | Makes this use's flows, wires, ports and settings the template's, so new uses start from here. Uses already on the graph keep their own. |
| **Open out** | Puts the flows back on the graph as ordinary flows where the card was, and removes the card. The wires stay. |
| **Remove** | Removes the card and every flow inside it. |

The palette's **×** forgets a template. Uses already on the graph keep working;
there is just no making another.

## How it works

The flows behind a card are ordinary flows in the project, marked as belonging
to the card (`group` on the flow) and not drawn on the graph. So every editor,
generator, staleness check and undo step works on them unchanged.

A wire to or from the card is stored as a wire to the flow port it stands for.
The graph draws it at the card's port, and a wire dropped on the card's port is
stored against that flow port. A wire between two flows inside the card is not
drawn at all.

The card is as up to date as the least up to date flow inside it. **Generate
stale** runs the flows inside, never the card itself.

Templates live in the project (`customFlows`). Making, using, opening out and
forgetting a custom flow are each one step that undo takes back.
