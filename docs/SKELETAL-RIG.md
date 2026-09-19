# The skeletal rig

The **Skeletal Rig** flow (`animation.rig`) is a character's skeleton: what bones
it has, how they hang off each other, and how far each joint is allowed to move.

Wire a character design into its Design input and the drawing shows behind the
bones, so a skeleton can be laid over the character it belongs to.

## The character type is the structure

Choosing `octopus` is not a label. It is forty-two bones in eight chains, and
choosing `human` is nineteen in a different shape. The type seeds the rig;
everything after that is editing limits rather than adding bones.

| Type | What it is |
| --- | --- |
| Human | Two arms, two legs, a spine of three. |
| Quadruped | Four legs, a horizontal spine, a tail chain. |
| Bird | Two wings of three, a long neck, a tail fan. |
| Fish | A head and a whip — most of the motion is one spine chain. |
| Snake | A head and fourteen body joints, all one chain. |
| Octopus | Eight arms of five bones, every arm its own chain. |
| Insect | Six legs of three, antennae, a segmented abdomen. |
| Arachnid | Eight legs of four, each its own chain. |

Swapping type keeps the limits of any bone that exists in **both** skeletons,
matched by id. A head stays the head you tuned; an arm does not quietly become a
foreleg.

Positions are not stored — only each bone's offset from its parent — so moving a
joint carries everything below it without a second pass to fix the children up.

## Two kinds of limit, because joints fail in two ways

**Range of motion** is a hard stop. An elbow is `0°` to `145°`: it bends one way
and cannot go the other. A knee is `-140°` to `0°`, the same thing reversed. A
knee that bends backwards is a broken knee and no amount of force should reach
it, so this is a stop rather than a preference. Both ends at `0°` welds the joint.

**Stiffness** is not a stop but a cost: how hard the joint pulls back towards its
rest pose. A shoulder and a neck have similar ranges and completely different
stiffness, and that difference is most of what makes one character move like a
person and another like a puppet.

**Length range** multiplies the bone's rest length. `×1 to ×1` is bone; `×0.85 to
×1.25` is a limb that can squash and stretch; `×0.7 to ×1.4` is cartoon rubber.
It has a stiffness of its own for the same reason.

Two multipliers act on the whole rig at once, so a character can be loosened or
tightened without touching each bone:

- **Squash and stretch** scales every length range. At 0 nothing stretches at all.
- **Looseness** scales every angle range — without changing which way a joint
  bends, so an elbow at any looseness still only bends one way.

## Chains: one behaviour, one number

A tentacle is not eight independently tuned joints. It is one behaviour. So a run
of small bones — a tentacle, a tail, a spine, a spider's leg — is a **chain**, and
the chain has one **floppiness**. Each joint in it reads its angles off that.

**Taper** is what makes a tentacle read as a tentacle rather than a hinge: a real
arm is anchored at the body and loose at the end. Floppiness is what the *tip*
does, and taper is how much of it the base gives up — 0 makes the whole chain
equally floppy, 1 welds the base solid.

> It is written that way round deliberately. Scaling the tip *up* from the
> chain's floppiness is the obvious way to do it and runs into the ceiling: at a
> floppiness of 0.8 the last two joints of a five-bone arm both clamp to fully
> loose, and the taper quietly stops doing anything exactly where it matters.

**Span** is how far a fully floppy joint in that chain may turn either way.
Floppiness scales it: ±55° at floppiness 0.5 is ±27.5°.

Any single joint in a chain can still be given **its own angles**, and told to
follow the chain again afterwards. The common case stays one slider; the
exception is one click.

## Mirroring

Editing a left bone writes the same limits to its right twin by default. A
character with a loose left elbow and a tight right one is almost always a slip
rather than a choice, and it is a slip that is very hard to see in a still pose.
Turn it off for a character who is meant to be lopsided.

## What it checks

The editor lists what is wrong with a rig in the terms whoever has to animate it
would use, and clicking a problem selects the bone:

- A joint whose range is nought degrees is welded — sometimes right, usually a slip.
- A range that runs backwards.
- **A range that does not include the rest pose.** The character starts the shot
  already out of bounds. This is the one that wastes an afternoon.
- A bone that can squash to nothing or inside out.
- A parent that is not in the rig, or a loop in the hierarchy.

A rig with problems still generates, because a broken rig is worth reading.

## What comes out

| Port | File | What it is |
| --- | --- | --- |
| Rig | `rig.json` | Every bone with its parent, length, resolved rest position, angle range, stiffness and length range — plus the chains. |
| Rig notes | `rig.md` | The skeleton as a table, the chains, the problems, and what the numbers mean. |

Limits are **resolved** before they are written. A chain bone's angles live on its
chain, and nothing downstream should have to know that to find out how far a
tentacle's third joint bends. Both are in the file: the resolved numbers to use,
and the chain that produced them, so a number can be changed in the right place
rather than eight times.

Rest positions are resolved too, so a consumer does not have to walk the
hierarchy to find out where a bone is.

## Units

Bones are measured in **rig units** with y pointing down, the way the studio's
canvases do, and a figure is roughly 100 units tall. Nothing here is pixels — the
rig describes proportions, and the drawing it is laid over decides the scale.

A spec wired into the Spec input is quoted in the notes as context. It cannot
change the skeleton, and does not appear to: the character type is what decides
the bones.
