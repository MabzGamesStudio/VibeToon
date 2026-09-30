import type { AlgorithmGuide } from '../guides';

export const RIG_GUIDE: AlgorithmGuide = {
  kinds: ['animation.rig'],
  title: 'A skeleton, and a preview of it moving under forces',
  summary:
    'A rig is a tree of bones, each with a rest angle and length, a range of motion (a hard stop) and a stiffness (a pull back towards rest). The character type seeds the whole structure. Runs of small bones form chains with one floppiness and a taper. The preview moves the skeleton with position-based dynamics: joints are particles pushed by gravity, wind and drags, then corrected so bones keep their length and joints stay inside their ranges, with stiffness as a spring whose strength does not depend on the step size.',
  steps: [
    { kind: 'input', title: 'A character type', detail: 'It seeds the bones: a human is nineteen, an octopus forty-two.' },
    { kind: 'step', title: 'Edit limits', detail: 'Range of motion and stiffness per joint; floppiness and taper per chain. A mirrored edit goes to the twin on the other side.' },
    {
      kind: 'loop',
      title: 'Preview: each small time step',
      steps: [
        { kind: 'step', title: 'Move each joint by velocity and forces', detail: 'Gravity, wind, a shove, the body carried about, a drag.' },
        {
          kind: 'loop',
          title: 'A few rounds of corrections',
          steps: [
            { kind: 'step', title: 'Each bone: move its two ends so its length is inside its stretch range' },
            { kind: 'step', title: 'Each joint: clamp its angle inside its range of motion' },
            { kind: 'step', title: 'Each joint: spring back towards rest by its stiffness', detail: 'Compliance form (XPBD), so the spring’s frequency is the same at any step size.' },
          ],
        },
        { kind: 'step', title: 'Velocity = how far each joint actually moved ÷ the step' },
      ],
    },
    { kind: 'output', title: 'rig.json (the preview is never saved)' },
  ],
  pseudocode: `rig = template(character_type)                    # bones, rest pose, limits
for chain in rig.chains:                             # tentacles, tails
  for i, joint in enumerate(chain):
    joint.floppiness = chain.floppiness * (1 - chain.taper * (1 - i / len(chain)))

# the preview: position-based dynamics
every step dt:
  for joint: joint.prev = joint.pos
             joint.vel += dt * forces(joint) / mass
             joint.pos += dt * joint.vel
  repeat iterations:
    for bone: keep |end - start| inside [length * (1 - stretch), length * (1 + stretch)]
    for joint: clamp angle(joint) to its range of motion        # hard stop
    for joint: pull angle towards rest with compliance(stiffness) / dt²
  for joint: joint.vel = (joint.pos - joint.prev) / dt`,
  sections: [
    {
      heading: 'Two kinds of limit',
      body: 'A **range of motion** is a hard stop: a knee that bends backwards is broken, and no force should get it there. **Stiffness** is a cost: how strongly a joint pulls back to rest. A shoulder and a neck have similar ranges and very different stiffness — most of what makes one character move like a person and another like a puppet.',
    },
    {
      heading: 'Chains',
      body: 'A tentacle is one behaviour, not eight independently tuned joints, so it gets one number: **floppiness**, what the tip does. **Taper** is how much of that the base gives up — at 1 the base does not move at all. Any single joint can still be given its own values.',
    },
    {
      heading: 'Position-based dynamics',
      body: 'Instead of computing forces for the constraints, PBD moves the joints freely and then **projects** them back: a bone that got too long has its ends moved together, a joint bent past its range is clamped. Hard stops are applied in full every step, so they never give. Stiffness is a soft constraint in the compliance form (XPBD): a stiffness of 1 springs back about four times a second, 0.5 twice, 0 not at all, however many steps the preview takes.',
    },
  ],
  settings: [
    { name: 'Range of motion', effect: 'The hard stops of each joint, in degrees from rest.' },
    { name: 'Stiffness', effect: 'How strongly a joint springs back to rest.' },
    { name: 'Floppiness / Taper', effect: 'A chain’s looseness at the tip, and how much stiffer the base is.' },
    { name: 'Mirror', effect: 'An edit to one side goes to its twin on the other.' },
  ],
  cost: 'Bones × correction rounds per step: trivially fast for a skeleton.',
  resources: [
    { title: 'Position Based Dynamics (Müller et al.)', url: 'https://matthias-research.github.io/pages/publications/posBasedDyn.pdf', note: 'The method the preview uses.' },
    { title: 'XPBD', url: 'https://matthias-research.github.io/pages/publications/XPBD.pdf', note: 'The compliance form that makes stiffness independent of the step size.' },
    { title: 'Skeletal animation', url: 'https://en.wikipedia.org/wiki/Skeletal_animation', note: 'Bones, hierarchies and rest poses.' },
  ],
  source: ['packages/shared/src/flows/rig.ts — templates, limits, chains, mirroring', 'packages/shared/src/flows/rigSim.ts — the preview'],
};

export const BIND_GUIDE: AlgorithmGuide = {
  kinds: ['animation.bind'],
  title: 'Binding a drawing to a skeleton, node by node',
  summary:
    'Binding maps the points a drawing is drawn through — its nodes — to bones. A node is a position, not a point of one shape: shapes that share a boundary share its points, and they are one node, bound once. The rig is first fitted inside the drawing (scaled by the tighter dimension and centred), then drawing and skeleton are lined up by hand, and nodes are given to bones with a brush, an area or a click. A check finds nodes bound to nothing and shapes split between bones.',
  steps: [
    { kind: 'input', title: 'A rig and a vector drawing' },
    { kind: 'step', title: 'Collect the nodes', detail: 'Every point of every shape, keyed by position: points in the same place are one node.' },
    { kind: 'step', title: 'Fit the rig inside the drawing', detail: 'Scaled by whichever dimension is tighter, keeping its proportions, and centred.' },
    { kind: 'step', title: 'Line them up by hand', detail: 'Move and zoom the drawing and the skeleton independently; drag joints.' },
    {
      kind: 'loop',
      title: 'For each bone',
      steps: [{ kind: 'step', title: 'Give it nodes', detail: 'Brush over them, draw an area round them, or click.' }],
    },
    { kind: 'decision', title: 'Every node bound?', no: 'Reported: an unbound node stays put when the rig moves, and its shape stretches.' },
    { kind: 'output', title: 'bound.json, bound.svg, bound.md — and a drawing per bone' },
  ],
  pseudocode: `nodes = {}
for shape in drawing: for point in shape: nodes[key(point)] += (shape, point)

rig = fit_inside(rig, drawing.bounds)         # scale by tighter side, centre
# ... placed and adjusted by hand ...

bind(keys, bone):   for k in keys: binding[k] = bone
brush(at, r):       bind(nodes within r of at, current bone)
area(polygon):      bind(nodes inside polygon, current bone)

bound = { rig, drawing, points: for each shape, the bone of each point }
parts_by_bone = group shapes by the bone most of their points follow`,
  sections: [
    {
      heading: 'By node, not by shape',
      body: 'A shape is often bigger than a body part — a whole skin-coloured arm and hand can be one polygon. Bound by its points it can go several ways: the points round the upper arm follow the upper arm, the ones round the hand follow the hand, and the polygon bends at the elbow instead of having to be cut there.',
    },
    {
      heading: 'A node is a position',
      body: 'Neighbouring shapes share the points along their boundary. Two points in the same place are one node, bound once — so a boundary can never be given two bones and torn apart when the rig moves.',
    },
    {
      heading: 'Placed by hand',
      body: 'The drawing and skeleton arrive in different spaces. An automatic fit gets them roughly on top of each other; lining the skeleton up with *this* drawing’s shoulders and hips is done by hand, moving each independently.',
    },
  ],
  settings: [
    { name: 'Brush', effect: 'The radius of the binding brush.' },
    { name: 'Show only this bone', effect: 'Hide the other bones’ nodes while working.' },
  ],
  resources: [
    { title: 'Skinning', url: 'https://en.wikipedia.org/wiki/Skeletal_animation#Technique', note: 'Binding a drawing (or mesh) to bones.' },
  ],
  source: ['packages/shared/src/flows/rigBind.ts — nodesOf, fitRigTo, bindNodes, boundRigOf', 'packages/shared/src/flows/rigBindCheck.ts'],
};

export const POSE_GUIDE: AlgorithmGuide = {
  kinds: ['animation.pose'],
  title: 'Posing: angles down the tree (FK), and dragging a hand to a target (IK)',
  summary:
    'A pose is one angle per bone: its turn from rest. Forward kinematics places every bone by adding each turn to its parents’ and rotating its rest offset by the total. Inverse kinematics — dragging a bone’s tip to a point — uses cyclic coordinate descent: from the joint nearest the tip back up the chain, each joint turns to point the tip at the target, clamped to its range, round and round until close enough.',
  steps: [
    { kind: 'input', title: 'A bound rig and a pose' },
    {
      kind: 'loop',
      title: 'FK: for each bone, parents first',
      steps: [
        { kind: 'step', title: 'Its angle = its parent’s total + its rest angle + its turn' },
        { kind: 'step', title: 'Its end = its start + its length in that direction' },
      ],
    },
    {
      kind: 'loop',
      title: 'IK: each round, until close enough or out of rounds',
      steps: [
        { kind: 'decision', title: 'Stalled, with the chain straight?', no: 'Carry on.' },
        { kind: 'step', title: 'Nudge: bend alternate joints a few degrees', detail: 'Fixed, not random, so the same drag gives the same pose.' },
        {
          kind: 'loop',
          title: 'For each joint, from the tip back up the chain',
          steps: [{ kind: 'step', title: 'Turn it so the tip points at the target, the short way round; clamp to its range' }],
        },
        { kind: 'step', title: 'Keep the best pose seen' },
      ],
    },
    { kind: 'step', title: 'Move each drawing point with the bone it is bound to' },
    { kind: 'output', title: 'pose.json and the posed drawing' },
  ],
  pseudocode: `def fk(rig, pose):
  for bone in rig in parent-first order:
    angle[bone] = angle[parent] + rest_angle[bone] + pose[bone]
    start[bone] = end[parent] (or the rig's origin)
    end[bone]   = start[bone] + length[bone] * (cos angle, sin angle)

def ik(rig, pose, tip, target, chain_length):
  chain = tip and its parents, chain_length long
  best = pose
  for round in 1..iterations:
    if stalled: bend alternate joints by ±8° × nudge
    for joint in chain (tip first):
      p = start of joint; t = end of tip
      turn = angle(target - p) - angle(t - p), wrapped to [-180, 180]
      pose[joint] = clamp(pose[joint] + turn, joint's range)
    if distance(tip, target) < best: best = pose
    if close enough: break
  return best`,
  sections: [
    {
      heading: 'Angles, not positions',
      body: 'A pose stores how far each bone has turned, not where it is. Positions would be a drawing of one arrangement; angles are the arrangement itself: they survive the rig being edited underneath, interpolate sensibly between two poses, and cannot describe a skeleton that has come apart.',
    },
    {
      heading: 'Forward kinematics',
      body: 'A bone’s turn is added to everything its parents have done, and its rest offset rotated by the total. That is why the whole arm lifts when the shoulder turns, without the elbow being told anything.',
    },
    {
      heading: 'Cyclic coordinate descent',
      body: 'CCD rather than a Jacobian solver: joint limits are a clamp rather than a constraint to solve around, each step is a couple of angle calculations, and a chain that cannot reach settles stretched towards the target instead of oscillating. Its weak spot — a straight chain aimed along itself, where each joint’s correction is tiny — is broken by a small fixed bend when progress stalls. The best pose seen is the one returned, so a solve never makes things worse.',
    },
  ],
  settings: [
    { name: 'Chain length', effect: 'How many bones up from the dragged one IK may turn.' },
    { name: 'Respect limits', effect: 'Clamp every joint to its range of motion.' },
  ],
  cost: 'FK is one pass over the bones. IK is rounds × chain length × one FK.',
  resources: [
    { title: 'Forward kinematics', url: 'https://en.wikipedia.org/wiki/Forward_kinematics', note: 'Placing a chain from its joint angles.' },
    { title: 'Inverse kinematics', url: 'https://en.wikipedia.org/wiki/Inverse_kinematics', note: 'The reverse problem, and the ways to solve it.' },
    { title: 'Cyclic coordinate descent (Kenwright)', url: 'https://arxiv.org/abs/1311.6311', note: 'An accessible account of CCD for character chains.' },
  ],
  source: ['packages/shared/src/flows/pose.ts — posedBones, solveIk, posedImage'],
};

export const PARTS_GUIDE: AlgorithmGuide = {
  kinds: ['animation.parts'],
  title: 'Taking a bound drawing apart: each shape to the bone most of it follows',
  summary:
    'Each shape of the bound drawing goes to the bone that most of its points follow; shapes whose points follow nothing go to a “Not bound” part. Each part is the shapes of one bone, drawn the size of the whole drawing so the parts lie back over one another exactly. Shapes can then be moved between parts and each part’s drawing edited.',
  steps: [
    { kind: 'input', title: 'A bound rig' },
    {
      kind: 'loop',
      title: 'For each shape',
      steps: [
        { kind: 'step', title: 'Count the bones its points follow' },
        { kind: 'decision', title: 'Any point bound?', no: 'It goes to Not bound.' },
        { kind: 'step', title: 'Give it to the bone with the most points' },
      ],
    },
    { kind: 'step', title: 'One part per bone, in the rig’s order, the whole drawing’s size' },
    { kind: 'step', title: 'Move shapes between parts, edit each part’s drawing' },
    { kind: 'output', title: 'parts.json, parts.svg, and a drawing per part' },
  ],
  pseudocode: `majority_bone(shape):
    votes = {}; best = None; most = 0
    for bone in bound.points[shape]:           # one entry per point, or None
        if bone is None: continue
        votes[bone] += 1
        if votes[bone] > most: most, best = votes[bone], bone   # a tie keeps the first to get there
    return best

for shape in bound.drawing.shapes:            # in drawing order
    by_bone[majority_bone(shape) or NOT_BOUND] += shape

parts = [Part(bone, by_bone[bone], size = whole drawing)
         for bone in rig.bones if bone in by_bone]
if NOT_BOUND in by_bone: parts += Part("Not bound", ...)
parts += bones the drawing names but the rig no longer has`,
  sections: [
    {
      heading: 'The majority',
      body: 'A shape bound by its points may follow several bones — that is how an arm bends at the elbow. As a part it has to belong to one, so it goes with the bone most of its points follow. Where that is wrong, move it by hand.',
    },
    {
      heading: 'The whole drawing’s size',
      body: 'Every part’s drawing keeps the size and coordinates of the whole, so the parts lie back over one another exactly and can be swapped or animated in place.',
    },
  ],
  resources: [{ title: 'Cut-out animation', url: 'https://en.wikipedia.org/wiki/Cutout_animation', note: 'Animation from separate parts, which is what this prepares.' }],
  source: ['packages/shared/src/flows/rigParts.ts — majorityBone, splitIntoParts'],
};

export const FACE_GUIDE: AlgorithmGuide = {
  kinds: ['animation.face'],
  title: 'Finding the features of a face from where shapes sit, their size, shape and colour',
  summary:
    'The face is the big low shape the others sit on. Every other shape is placed on it — across from left to right, down from top to chin — and sized against it. Then rules, in order, name the hair, ears, eyes (the best mirrored pair), eyebrows, mouth and nose. Anything left is unassigned, for you to give to a feature; each feature can then be hidden, isolated, nudged or swapped with the same feature of another head.',
  steps: [
    { kind: 'input', title: 'A head: a drawing, or the head parts of a Rig Parts file' },
    { kind: 'step', title: 'The face', detail: 'Of the polygons at least a third the size of the largest, the lowest.' },
    { kind: 'step', title: 'Place everything on the face', detail: 'Across 0 (left) to 1 (right), down 0 (top) to 1 (chin), and size against it.' },
    { kind: 'step', title: 'Hair', detail: 'Sizeable, reaching the top, out above or beside the face or across it as a fringe, not the face’s colour.' },
    { kind: 'step', title: 'Ears', detail: 'At the face’s sides, halfway down, smaller than hair.' },
    {
      kind: 'loop',
      title: 'Eyes: each pair of candidate shapes in the upper middle',
      steps: [
        { kind: 'step', title: 'Score it', detail: '2 × how unlevel + 2 × how unmirrored + ½ × size difference + 2 × colour difference + how far from the eye line.' },
        { kind: 'decision', title: 'Level, mirrored and alike enough?', no: 'Not a pair of eyes.' },
      ],
    },
    { kind: 'step', title: 'Keep the best pair; what is inside an eye is part of it' },
    { kind: 'step', title: 'Eyebrows: above each eye, wider than tall' },
    { kind: 'step', title: 'Mouth: middle, below the eyes, the widest thing wider than tall' },
    { kind: 'step', title: 'Nose: middle, between the eyes and the mouth' },
    { kind: 'output', title: 'face.json, each head redrawn, and each feature drawn alone' },
  ],
  pseudocode: `face = lowest of polygons with area >= largest / 3
for s in other shapes: s.u, s.v = position across / down the face; s.size = area / face.area
hair  = shapes reaching the top, big, outside or across the top, colour != face
ears  = shapes at u ≈ 0 or 1, v ≈ 0.5, smaller than hair
eyes  = argmin over pairs (a, b) in the upper middle of
        2*|a.v - b.v| + 2*|a.u + b.u - 1| + 0.5*size_diff + 2*colour_gap + 0.5*|mean v - 0.42|
        where level < 0.12, mirror < 0.15, size_diff < 1.2, and not long and thin
eyebrows = above each eye, wider than tall
mouth = middle, below the eyes, widest wider-than-tall shape (with what is inside it)
nose  = middle, between eyes and mouth
everything else: unassigned`,
  sections: [
    {
      heading: 'Rules, not learning',
      body: 'A face drawn for animation follows conventions: eyes are a level mirrored pair above the middle, the mouth is wide and low, the nose between them. Reading those from where a shape is, how big, what shape and what colour is enough for most drawn heads — and every rule is one you can read and correct by hand.',
    },
    {
      heading: 'Swapping',
      body: 'A feature can be swapped for the same feature of another head: its shapes are fitted into the place this head’s own feature was, so two heads can trade eyes or mouths.',
    },
  ],
  resources: [{ title: 'Facial symmetry', url: 'https://en.wikipedia.org/wiki/Facial_symmetry', note: 'Why a mirrored pair is the strongest clue to the eyes.' }],
  source: ['packages/shared/src/flows/face.ts — identifyFace, composeFeature, composeHead'],
};
