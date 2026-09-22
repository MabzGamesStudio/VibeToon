# The color palette

A palette is *counted*, not averaged. The **Color Palette** flow (`art.palette`)
takes an image in and gives you the colors it actually uses most — not the
colors you get by averaging it, which is how palettes end up as five shades of
mud.

Wire any flow with an image output into its Image input: a character design, a
background, a storyboard panel, or a photo uploaded onto a port by hand.

## The idea: modes, not means

Every pixel is counted. The counts are sorted. The commonest colors are taken in
order. That is the whole of it — until you try it on a photograph of a sky and
get five near-identical blues, because a gradient is thousands of near
neighbours and they beat everything else in the picture.

So there is a **minimum distance**. A color closer than that to one already
chosen is not a new entry: it joins that entry's *group*, and the group keeps its
own tally. One group is one mode of the image, and the palette is one color
picked out of each. The four blues become one blue that accounts for a third of
the picture, and the red that was being crowded out gets its place.

| Setting | What it does |
| --- | --- |
| Colors | How many entries the palette has. |
| Minimum distance | How far apart two entries must look. Anything closer joins a group. |
| Temperature | How far each entry may wander from its group's commonest color. |
| Seed | Same seed, same palette. Only matters above temperature 0. |
| Color precision | How finely colors are rounded together before counting. |
| Transparency floor | Pixels this transparent are not counted at all. |
| Drop groups under | Leaves out a color that barely appears. |

## Distance is measured where the eye is

Distance is the straight-line distance in **OKLab**, times 100 so the numbers are
worth typing into a slider.

Plain RGB cannot do this job. `#0000ff` and `#000080` — royal blue and navy — are
128 apart in RGB, and so are `#00ff00` and `#00ff80`, two obviously different
greens. One minimum distance cannot serve both, so a palette measured in RGB
either merges greens that should be separate or splits blues that should not be.
OKLab is built so that equal distances look equally different, including in the
blues, which is exactly where the older CIE Lab is known to fail.

On that scale:

| Apart | What it looks like |
| --- | --- |
| under 2 | A difference you cannot see. |
| 10 | Two greens you would call different greens. |
| 20 | Navy against royal blue. |
| 70+ | Red against green. |
| ~100 | Black against white — what the scale is pinned to. |

## Rounding, before anything is counted

A photograph of a red wall contains a hundred thousand slightly different reds,
each seen once or twice. The commonest color is then whichever one happened to
repeat, which is noise. So colors are rounded before they are counted —
**5 bits a channel** by default, which is 32 levels each.

Coarse enough for a wall to be one color; fine enough that a palette entry is
still a color you can see in the picture. Pure white stays `#ffffff` rather than
drifting to `#f8f8f8`, because the rounded value is expanded back across the full
range.

Changing this setting needs the image read again, and the editor says so.

## Temperature, and why it cannot invent a color

At temperature 0 every entry is its group's commonest color exactly.

Above that, the entry moves towards **another member of the same group**, chosen
by how often that member appears, by the fraction the temperature asks for. A
warm grey can come out as the slightly warmer grey beside it. Blending happens in
OKLab, so an intermediate between two blues stays blue — an RGB midpoint between
two blues can pass through grey.

It never leaves the group, which is the point: a palette color is always a
color the image actually contains. Rerolling the seed moves it somewhere else
inside the same group.

## Reading the image

Reading happens **in the editor**, because that is where an image can be decoded:
the browser already reads PNG, JPEG, WebP and GIF, and the alternative is this
project carrying a decoder for each. Press **Read the image**.

What is kept in the flow is the tally — a few thousand rows rather than a few
million pixels. So generating afterwards is instant, repeatable, and needs
neither the picture nor a network.

Two consequences, both of which the flow says out loud rather than hiding:

- Generating before the image has been read produces a warning, not a palette.
- The tally records the image's hash. Change the picture and the flow refuses to
  describe the old one until you read it again.

A picture bigger than about 400,000 pixels is **sampled** — every Nth pixel —
rather than resized. Resizing interpolates, and interpolation invents colors
that are not in the image, which is the one thing a palette must not contain.

## What comes out

| Port | File | What it is |
| --- | --- | --- |
| Palette | `palette.json` | Each color as hex and RGB, with the share of the image it accounts for, its pixel count, how many counted colors were in its group, and that group's commonest color. |
| Report | `report.md` | The palette as a table, plus what was counted, what was grouped, and why. |

Shares always add up to the whole image: a color with no group near enough joins
the nearest one anyway rather than being dropped, so the numbers describe the
picture completely.

## When it will not give you what you asked for

Ask for eight colors at a distance of 30 from a two-tone drawing and you get
two, with a warning saying so. That is the honest answer — padding the palette
with near-duplicates to reach eight would be worse than useless, because the
whole point of the minimum distance is that near-duplicates are not colors.

Lower the distance, or ask for fewer.

## Editing the palette

What comes out of a photograph is a starting point, not an answer. Once the image
has been read, every entry is yours:

| | What it does |
| --- | --- |
| **Change** | Set an entry to any color you like. It stays there, whatever the settings do. For a brand color, or when the count found something almost right. |
| **Take out** | Drop an entry the palette should not have spent — a background, or a compression artefact. It can be put back. |
| **Add** | Put in a color the drawing will need that the picture did not have. |

### Edits are kept apart from the palette

The palette is always **derived from the image**, and the edits are applied on
top of it — never folded in. That is what lets you turn a setting or read the
picture again without losing the work: a palette stored as a flat list of colors
would have to choose between wiping your edits and ignoring the image, and both
are wrong.

An added color stands for **no pixels**, and says so: its share is zero, and the
"covers" figure drops accordingly rather than crediting an invented color with
part of the image. Taking an entry out lowers that figure too, because the
palette really does account for less of the picture than it did.

### Kept against the color, not the position

Each edit is remembered against the **group it was made for** — the group's
commonest color, which is what the report calls its mode — rather than against a
row number.

Position is not identity. Ask for four colors instead of eight and entry three is
a different color than it was, so an edit stored against "3" would quietly apply
to something you never chose. Against a group, an edit either lands on the color
you made it for, or the settings no longer produce that group and the edit
**waits** — kept, doing nothing, and back the moment the settings are. The editor
says how many are waiting, so a change with no visible effect is explained rather
than mysterious.

The closest pair is worked out again after editing, for the same reason it is
shown at all: two colors chosen by hand can sit far closer together than any
bucketing would have put them, and a stale figure would say the minimum distance
was being met when it is not.
