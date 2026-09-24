import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyRigFlowData, restPose, setBoneLimits, setChain, type RigFlowData } from '../src/flows/rig';
import {
  DEFAULT_SIM_SETTINGS,
  createSim,
  grabSim,
  motionAt,
  pushSim,
  releaseSim,
  simBones,
  simReadout,
  simSpeed,
  stepSim,
  type SimSettings,
} from '../src/flows/rigSim';

const settings = (over: Partial<SimSettings> = {}): SimSettings => ({ ...DEFAULT_SIM_SETTINGS, ...over });

function run(rig: RigFlowData, seconds: number, over: Partial<SimSettings> = {}) {
  const sim = createSim(rig);
  for (let t = 0; t < seconds; t += 1 / 60) stepSim(sim, 1 / 60, settings(over));
  return sim;
}

test('with no forces the skeleton stands exactly as it was built', () => {
  const rig = emptyRigFlowData('human');
  const sim = run(rig, 2, { gravity: 0 });
  const rest = restPose(rig);
  for (const [id, place] of simBones(sim)) {
    assert.ok(Math.hypot(place.to.x - rest.get(id)!.to.x, place.to.y - rest.get(id)!.to.y) < 1e-6, id);
  }
});

test('under gravity, every joint stays inside its range and every bone inside its stretch', () => {
  for (const kind of ['human', 'octopus', 'quadruped', 'snake'] as const) {
    const rig = emptyRigFlowData(kind);
    const sim = run(rig, 3, { gravity: 2, wind: 0.8, motion: 'sway', motionSize: 0.3, motionSpeed: 1.5 });
    const read = simReadout(sim);
    for (const bone of sim.bones) {
      const { turn, stretch } = read.get(bone.id)!;
      const slack = 1.5; // degrees: the last constraint pass nudges what the one before it fixed
      assert.ok(turn >= (bone.minTurn * 180) / Math.PI - slack && turn <= (bone.maxTurn * 180) / Math.PI + slack, `${kind} ${bone.id} turned ${turn.toFixed(1)}°`);
      assert.ok(stretch >= bone.minLength / bone.length - 0.03 && stretch <= bone.maxLength / bone.length + 0.03, `${kind} ${bone.id} at ×${stretch.toFixed(2)}`);
      assert.ok(Number.isFinite(turn) && Number.isFinite(stretch));
    }
  }
});

test('a welded joint does not turn at all', () => {
  const rig = setBoneLimits(emptyRigFlowData('human'), 'neck', { angles: { min: 0, max: 0, stiffness: 1 } });
  const sim = run(rig, 2, { gravity: 3, wind: 1 });
  assert.ok(Math.abs(simReadout(sim).get('neck')!.turn) < 1.5);
});

test('a stiffer joint gives less under the same load', () => {
  // The neck is the one joint gravity pulls sideways on: the head sits above it.
  const loose = setBoneLimits(emptyRigFlowData('human'), 'neck', { angles: { min: -80, max: 80, stiffness: 0.1 } });
  const stiff = setBoneLimits(emptyRigFlowData('human'), 'neck', { angles: { min: -80, max: 80, stiffness: 0.9 } });
  const push = { gravity: 1, wind: 0.6, gust: 0 };
  const bent = (rig: RigFlowData) => Math.abs(simReadout(run(rig, 3, push)).get('neck')!.turn);
  assert.ok(bent(loose) > bent(stiff) * 2, `loose ${bent(loose).toFixed(1)}°, stiff ${bent(stiff).toFixed(1)}°`);
});

test('a floppier chain hangs lower', () => {
  const octopus = emptyRigFlowData('octopus');
  const chain = octopus.chains[0]!;
  const tip = chain.bones[chain.bones.length - 1]!;
  const floppy = setChain({ ...octopus, options: { ...octopus.options, mirror: false } }, chain.id, { floppiness: 1, taper: 0 });
  const firm = setChain({ ...octopus, options: { ...octopus.options, mirror: false } }, chain.id, { floppiness: 0.1, taper: 0 });
  const movedBy = (rig: RigFlowData) => {
    const sim = run(rig, 3, { gravity: 1.5 });
    const now = simBones(sim).get(tip)!.to;
    const was = restPose(rig).get(tip)!.to;
    return Math.hypot(now.x - was.x, now.y - was.y);
  };
  assert.ok(movedBy(floppy) > movedBy(firm) + 1, `floppy ${movedBy(floppy).toFixed(1)}, firm ${movedBy(firm).toFixed(1)}`);
});

test('a dragged joint goes where it is dragged, and the rest follows within its limits', () => {
  const rig = emptyRigFlowData('human');
  const sim = createSim(rig);
  const hand = restPose(rig).get('left-forearm')!.to;
  const to = { x: hand.x - 4, y: hand.y - 10 };
  grabSim(sim, 'left-forearm', to);
  for (let t = 0; t < 1; t += 1 / 60) stepSim(sim, 1 / 60, settings());
  const at = simBones(sim).get('left-forearm')!.to;
  assert.ok(Math.hypot(at.x - to.x, at.y - to.y) < 1e-6, 'held where the hand is');
  const elbow = simBones(sim).get('left-upper-arm')!.to;
  assert.notDeepEqual(elbow, restPose(rig).get('left-upper-arm')!.to, 'the elbow was pulled along');
  releaseSim(sim);
  assert.equal(sim.grabbed, null);
});

test('dragging the root carries the whole skeleton', () => {
  const rig = emptyRigFlowData('human');
  const sim = createSim(rig);
  const anchor = { ...sim.anchor };
  // Carried across over a second, the way a hand moves, then held there.
  for (let t = 0; t < 3; t += 1 / 60) {
    grabSim(sim, 'root', { x: anchor.x + 20 * Math.min(1, t), y: anchor.y });
    stepSim(sim, 1 / 60, settings());
  }
  const head = simBones(sim).get('head')!.to;
  assert.ok(Math.abs(head.x - (restPose(rig).get('head')!.to.x + 20)) < 1, 'the head went with it');
  releaseSim(sim);
  assert.deepEqual(sim.anchor, { x: anchor.x + 20, y: anchor.y }, 'and it stays where it was put');
});

test('a push dies away, and faster with more damping', () => {
  const rig = emptyRigFlowData('octopus');
  const after = (damping: number) => {
    const sim = createSim(rig);
    pushSim(sim, { x: sim.height * 2, y: 0 });
    for (let t = 0; t < 2; t += 1 / 60) stepSim(sim, 1 / 60, settings({ gravity: 0, damping }));
    return simSpeed(sim);
  };
  assert.ok(after(0.3) < after(0) || after(0) < 1e-6, 'it settles');
  assert.ok(after(0.8) <= after(0.1) + 1e-9, `${after(0.8)} vs ${after(0.1)}`);
});

test('the chosen motion carries the root, and held still leaves it be', () => {
  const sim = createSim(emptyRigFlowData('human'));
  assert.deepEqual(motionAt(sim, settings({ motion: 'still' }), 0.37), sim.anchor);
  const swayed = motionAt(sim, settings({ motion: 'sway', motionSize: 0.2, motionSpeed: 1 }), 0.25);
  assert.ok(Math.abs(swayed.x - sim.anchor.x - 0.2 * sim.height) < 1e-9, 'a quarter cycle is the far side');
  const bounced = motionAt(sim, settings({ motion: 'bounce', motionSize: 0.2, motionSpeed: 1 }), 0.5);
  assert.ok(bounced.y < sim.anchor.y, 'up, never below where it stands');
});

test('a big frame gap does not throw the skeleton apart', () => {
  const rig = emptyRigFlowData('octopus');
  const sim = createSim(rig);
  stepSim(sim, 30, settings({ gravity: 3 }));
  for (const place of simBones(sim).values()) assert.ok(Number.isFinite(place.to.x) && Number.isFinite(place.to.y));
  assert.ok(sim.time <= 0.11, 'only a tenth of a second is taken at once');
});
