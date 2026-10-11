# Character Split

`art.video.characters` · takes **Frames** · gives **`characters/`**, **`sheets/`**, **`frames/`**, **`characters.json`** and **`characters.md`**

Splits what moves in a video into its characters, each on its own: one item per
character comes out, as a batch.

```
Video Foreground ──▶ Character Split ──▶ characters/character-1.webm, character-2.webm …
                                     ──▶ sheets/character-1.png …
                                     ──▶ frames/character-1-frame-0001-at-0.000s.png …
```

The frames are those [Video Foreground](VIDEO-FOREGROUND.md) makes: only what
moves in front of the background, on clear.

## How it is worked out

1. **Pieces.** In each frame, the kept pixels are gathered in patches **Join
   pieces within** pixels across; touching patches are one piece. Parts of a
   character no further apart than that — an arm and a body with a line of
   background between — are one piece. Pieces smaller than **Smallest piece**
   are left out.
2. **Embeddings.** Each piece is given an embedding: the share of its pixels
   in each of 216 colours (a 6 × 6 × 6 grid of the colour cube, each pixel
   shared softly between the eight grid colours round it, so compression noise
   does not move it). A character is mostly its colours — its skin, its
   clothes, its hair — in about the same shares whichever way it turns.
3. **Characters, from where they are apart.** Pieces are grouped by embedding:
   a piece joins the group whose mean embedding is at least **Sameness** alike
   (the Bhattacharyya coefficient, 100% for the same colours in the same
   shares), or starts its own. The frames with the most pieces go first: that
   is where characters are apart, and their clean colours set what each looks
   like.
4. **Blends.** Two characters touching are one piece, with both their colours
   in it. A group whose colours are far better explained as a mix of two other
   groups' than as either — and whose two are not seen apart in the same frames
   — is taken for two characters together, not a third character.
5. **Each piece.** A piece of one character's group, with no other character
   near, is that character's. A piece two or more could be in — a blend, or one
   where another character not seen apart in this frame is expected from the
   frames either side — is **split pixel by pixel**: each pixel goes to the
   character with the highest likelihood, its share of that pixel's colour
   times how near the pixel is to where that character was (its own pixels in
   the nearest frame where it was apart, moved on by how it was moving; within
   **Most a character moves**). Colour decides where the characters differ;
   place decides where they share colours, like two heads of the same skin.
6. Characters in fewer than **Least frames** frames are left out as noise.

Where two characters overlap in the same colours, which one is in front cannot
be told from colour or place, and those pixels may go to either.

## In the editor

- Each frame is shown with every pixel tinted the colour of the character it
  went to; pixels kept but nobody's are faint. **Show only** a character to see
  its own pixels.
- The strip under the picture has a dot for each character in each frame.
- In the character list: the colour it is tinted, its commonest colours, a
  **name**, how many frames it is in (and in how many it was split from
  another), **Leave out**, and **Is …** to join it to another character — one
  character found as two (turning round, say) is put back together that way.
  Edits are kept with the flow, and cleared when different frames are read.

## What comes out

- `characters/`: one see-through WebM clip per character, cut to the box round
  everything it does, from its first frame to its last (clear in frames where
  it is not), at the rate the frames were read. Into a flow that takes one
  video — Video Rig Match, Video Edit — **a batch of the characters**.
- `sheets/`: one picture per character, its frames side by side in rows of
  eight, cut to the same box. Into a flow that takes one picture, a batch of
  the characters.
- `frames/`: every character's frames, the size the frames were, clear but for
  it: `character-1-frame-0001-at-0.000s.png`.
- `characters.json`: each character — id, name, colours, embedding, its clip,
  sheet and box — and every frame it is in, with the source frame, time, area,
  box and whether it was split there.
- `characters.md`: the same, in words.

Clips are written frame by frame, as Shot Split's are (VP9, or VP8 where this
browser has no VP9 encoder, with the transparency kept). In a browser that can
write neither, the sheets and frames are still written.

When the flow is a batch itself — the frames of each of a Shot Split's shots —
each shot's characters are written in that shot's folder.
