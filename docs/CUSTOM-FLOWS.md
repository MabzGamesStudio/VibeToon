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

1. On the graph, press **Make a custom flow**.
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

Double-click the card to open it. The editor lists:

- the flows inside, in the order they run, each with its status and an
  **Open ▸** button;
- the wires between them;
- the ports it takes and gives: which flow and port each stands for, and what
  it is wired to. Each port's name can be edited.

**Open ▸** opens a flow's ordinary editor. Everything works there as it always
does, including undo. The back button, and the path in the header, lead back to
the custom flow.

| Button | What it does |
| --- | --- |
| **Generate** | Generates every flow inside, upstream first, so each reads what the one before it made in the same pass. |
| **Save over the template** | Makes this use's settings the template's, so new uses start from here. Uses already on the graph keep their own. |
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
