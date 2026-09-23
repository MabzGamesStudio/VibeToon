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

Reading happens **in the editor**. Press **Read the image**. A PNG is decoded byte
for byte by the project's own decoder (below); JPEG, WebP and GIF are decoded by
the browser.

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
| Palette | `palette.json` | Each color as hex and RGB, with how opaque it is, the share of the image it accounts for, its pixel count, how many counted colors were in its group, and that group's commonest color. The transparent entry, when there is one, is `#00000000`. |
| Report | `report.md` | The palette as a table, plus what was counted, what was grouped, and why. |

Shares always add up to the whole image: a color with no group near enough joins
the nearest one anyway rather than being dropped, so the numbers describe the
picture completely.

## Every entry is a value the picture holds

Pixels are **grouped** by a rounded color and **named** by an exact one: each
entry is the commonest exact pixel of its group — color and opacity — so it is a
value the file really contains. Naming a group after its rounded value would put a
color in the palette that no pixel has (`#dc2828` rounds to `#de2929` at five bits),
and a filter looking for exactly that color would find nothing.

The image is read **byte for byte**, not through a browser canvas. A canvas keeps
every pixel multiplied by its own opacity, so a half-transparent pixel comes back a
step off — `#283cdc80` reads as `#283cdb80` — and an exact palette of it would not
exactly match the picture. PNGs are decoded by `png.ts`; other formats still go
through the browser, which is exact for a JPEG (no opacity to lose) and a GIF (all
or nothing). A count made the old way still works, but the editor and the run both
ask for the image to be read again.

## Opacity is part of a color

An entry is a color **and how see-through it is**, not just a color. Its opacity is
that of the pixel it is named after — not an average of the group, which would be
a value no pixel has. A red drawn solid with soft edges is a solid red: its edge
pixels are the same red, fading, and belong to it. A pane of glass drawn at half
opacity is a half-opaque entry.

The hex says so: `#4a6fd4` is solid, `#4a6fd480` is the same blue at about half.
Eight digits are written only when there is an opacity worth writing, so a palette
off flat artwork looks exactly as it always did. The editor draws every swatch
over a checker, because otherwise a half-transparent white and a pale grey are the
same square.

**Distances count opacity**, measured apart from color: the distance between the
colors, and 50 for the whole way from clear to solid, put together like the two
sides of a right angle. For two solid colors that is exactly the distance it always
was. Two fully transparent pixels are `0` apart whatever color numbers they carry,
and transparent is never mistaken for black. Kept apart on purpose: a fading color
is then always nearer itself than any other color, so the soft edge of a red shape
belongs to red.

A **group is keyed on color alone**, though — `modeHex` never carries an opacity.
An entry you have edited should still be found after the artwork behind it has
faded, and if the opacity were part of a group's identity every edit would be
stranded by the fade.

## The transparent entry

A picture with transparent pixels — anything under **Ignore pixels more
transparent than** — gets an entry for them: `#00000000`, fully transparent, **on
top of** the colors asked for. Five colors from a cut-out picture gives five colors
and the clear around them.

It is what the Palette Filter's snap mode snaps transparent pixels to, so the
background of a cut-out stays clear and the result holds the palette's values and
no others. Switch it off and the palette is only colors; a filter snapping to it
then has to give transparent pixels one of them, and says so. It can be taken out,
or changed — set it to white and snapping fills the background white.

What opacity is *for* is the Palette Filter: snap writes an entry's color and
opacity exactly, and both modes count opacity when judging what matches. See
[IMAGE-FLOWS.md](IMAGE-FLOWS.md).

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
| **Opacity** | Set how see-through an entry is, 0 to 100%. Not a separate kind of edit: it lives in the same hex the change records, so resetting an entry puts its opacity back along with its color. |
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
