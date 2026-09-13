import { CHARACTER_COLORS } from '../flows/dialog';
import { newId } from '../ids';
import { requireFlowKind } from '../registry/flowKinds';
import type { DialogFlowData, Project } from '../types/project';
import { createConnection, createNode, createProject } from './factory';

/**
 * The starter graph: one dialog flow feeding one storyboard flow, with a short
 * scene already in it so the board has something to break down on first open.
 */
export function createStarterProject(name = 'Untitled clip'): Project {
  const project = createProject(name);
  project.settings.styleNote = 'Two-hander, handmade look, no camera moves that a single animator would regret.';

  const dialogNode = createNode('story.dialog', { x: 120, y: 180 }, 'Scene Dialog');
  dialogNode.data = starterDialog();
  dialogNode.notes = 'Keep it under 30 seconds of screen time.';

  const storyboardNode = createNode('animation.storyboard', { x: 620, y: 180 }, 'Storyboard');
  storyboardNode.notes = 'Sync from the dialog, then sketch each panel.';

  const connection = createConnection(
    { nodeId: dialogNode.id, portId: 'dialog' },
    { nodeId: storyboardNode.id, portId: 'dialog' },
    { rules: requireFlowKind('story.dialog').defaultOutgoingRules, mode: 'suggest' },
  );

  project.nodes = [dialogNode, storyboardNode];
  project.connections = [connection];
  return project;
}

function starterDialog(): DialogFlowData {
  const mabz = { id: newId('chr'), name: 'Mabz', personality: 'Fixes things that are not broken.', voice: 'Dry, quick, trails off mid-sentence.', color: CHARACTER_COLORS[0]! };
  const tully = { id: newId('chr'), name: 'Tully', personality: 'Patient right up until they are not.', voice: 'Warm, slow, lands every consonant.', color: CHARACTER_COLORS[1]! };
  const workshop = { id: newId('set'), name: 'Workshop', description: 'One bench, one lamp, forty unfinished projects.', timeOfDay: 'Night' };

  return {
    editor: 'dialog',
    logline: 'Two friends argue about a machine that only works when nobody is watching.',
    characters: [mabz, tully],
    sets: [workshop],
    scenes: [
      {
        id: newId('scn'),
        slug: 'INT. WORKSHOP - NIGHT',
        setId: workshop.id,
        summary: 'Mabz demonstrates the machine. It refuses.',
        beats: [
          { id: newId('bt'), type: 'action', text: 'Mabz drags the lamp round to point at a small brass machine.' },
          { id: newId('bt'), type: 'line', characterId: mabz.id, text: 'Watch. No, actually — do not watch. That is the trick.' },
          { id: newId('bt'), type: 'line', characterId: tully.id, parenthetical: 'not moving', text: 'I am going to watch.' },
          { id: newId('bt'), type: 'action', text: 'The machine sits there. A single gear turns half a tooth and stops.', sound: 'one small clack' },
          { id: newId('bt'), type: 'sound', text: '', sound: 'the lamp filament ticks as it cools' },
          { id: newId('bt'), type: 'line', characterId: mabz.id, text: 'It did it yesterday. Twice.' },
          { id: newId('bt'), type: 'direction', text: 'Push in slowly on the machine until the gear fills frame.' },
          { id: newId('bt'), type: 'line', characterId: tully.id, text: 'Then we wait until it forgets we are here.' },
        ],
      },
    ],
  };
}
