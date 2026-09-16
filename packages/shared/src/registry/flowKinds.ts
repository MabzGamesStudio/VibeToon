import type { ArtifactKind } from '../types/artifacts';
import type { BriefFieldSpec, FlowCategory, FlowKindDef, PortSpec } from '../types/flow';

interface PortOpts {
  required?: boolean;
  multiple?: boolean;
}

function input(
  id: string,
  label: string,
  kinds: ArtifactKind[],
  description: string,
  opts: PortOpts = {},
): PortSpec {
  return { id, label, kinds, description, multiple: true, ...opts };
}

function output(
  id: string,
  label: string,
  kinds: ArtifactKind[],
  fileName: string,
  description: string,
): PortSpec {
  return { id, label, kinds, fileName, description };
}

function field(
  id: string,
  label: string,
  input: BriefFieldSpec['input'],
  hint: string,
): BriefFieldSpec {
  return { id, label, input, hint };
}

/**
 * The flow catalogue. Every entry is usable today: the two flows marked
 * `editor` have a bespoke editor, the rest use the brief editor, which
 * collects structured text and generates a markdown brief their downstream
 * flows can read. Adding a bespoke editor later is a per-kind change; the
 * graph, connections and generation pipeline do not move.
 */
export const FLOW_KINDS: readonly FlowKindDef[] = [
  /* ---------------------------------------------------------------- *
   * Brainstorm
   * ---------------------------------------------------------------- */
  {
    kind: 'brainstorm.ideas',
    category: 'brainstorm',
    label: 'Idea Board',
    summary: 'Loose sparks, premises and what-ifs before anything is committed.',
    inputs: [input('context', 'Context', ['markdown', 'text'], 'Anything to riff on.')],
    outputs: [
      output('ideas', 'Ideas', ['markdown'], 'ideas.md', 'The idea board as a readable list.'),
      output('logline', 'Logline', ['text'], 'logline.txt', 'The one-sentence pitch.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('premise', 'Premise', 'text', 'The clip in two or three sentences.'),
      field('sparks', 'Sparks', 'list', 'One idea per line. Keep the bad ones.'),
      field('constraints', 'Constraints', 'list', 'Runtime, cast size, budget, what must be avoidable.'),
      field('audience', 'Audience', 'line', 'Who it is for and where it will be watched.'),
    ],
    defaultOutgoingRules: { ideas: 'keep: premise, logline\nignore: rejected sparks' },
  },
  {
    kind: 'brainstorm.tone',
    category: 'brainstorm',
    label: 'Tone & Theme',
    summary: 'What the clip is about underneath, and how it should feel.',
    inputs: [input('ideas', 'Ideas', ['markdown', 'text'], 'Idea board or logline.')],
    outputs: [
      output('tone', 'Tone', ['markdown'], 'tone.md', 'Theme, tone and reference notes.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('themes', 'Themes', 'list', 'One theme per line.'),
      field('tone', 'Tone', 'text', 'Funny, dry, melancholy, frantic — and how far.'),
      field('references', 'References', 'list', 'Clips, films, records, paintings.'),
      field('avoid', 'Avoid', 'list', 'Tones and cliches to stay away from.'),
    ],
  },

  /* ---------------------------------------------------------------- *
   * Text
   * ---------------------------------------------------------------- */
  {
    kind: 'text.corpus',
    category: 'text',
    label: 'Corpus',
    summary: 'Gathers the text everything else reads, so one body of writing feeds every flow that needs it.',
    inputs: [
      input('text', 'Text', ['text', 'markdown'], 'Text from another flow, added as a part of its own.'),
    ],
    outputs: [
      output('corpus', 'Corpus', ['text'], 'corpus.txt', 'Every included part, one after another.'),
      output('report', 'Report', ['markdown'], 'report.md', 'What went into it, and what could not be read.'),
    ],
    editor: 'corpus',
    maturity: 'editor',
  },

  {
    kind: 'text.lexicon',
    category: 'text',
    label: 'Word Database',
    summary: 'Counts words out of a corpus into a database other flows can write from.',
    inputs: [
      input('corpus', 'Corpus', ['text', 'markdown'], 'Text to count as a corpus of its own.'),
    ],
    outputs: [
      output('lexicon', 'Word database', ['json'], 'lexicon.json', 'Words, frequencies and weighted contexts.'),
      output('report', 'Report', ['markdown'], 'report.md', 'What went into it and what came out.'),
    ],
    editor: 'lexicon',
    maturity: 'editor',
  },

  {
    kind: 'text.grammar',
    category: 'text',
    label: 'Grammar Database',
    summary: 'Counts the shapes sentences take in a corpus, read against a word database.',
    inputs: [
      input('corpus', 'Corpus', ['text', 'markdown'], 'Text to read for its sentence shapes.'),
      input('lexicon', 'Word database', ['json'], 'Supplies the word type and form of each token.', {
        required: true,
      }),
    ],
    outputs: [
      output('grammar', 'Grammar database', ['json'], 'grammar.json', 'Sentence, fragment and phrase patterns with their counts.'),
      output('report', 'Report', ['markdown'], 'report.md', 'What was read and the shapes it found.'),
    ],
    editor: 'grammar',
    maturity: 'editor',
  },

  {
    kind: 'text.random',
    category: 'text',
    label: 'Random Text',
    summary: 'Writes or rewrites text from a word database of weighted contexts.',
    inputs: [
      input('text', 'Text', ['text', 'markdown'], 'Text to rewrite. Without it the flow writes new text.'),
      input('lexicon', 'Word database', ['json'], 'A lexicon to merge into this one.'),
      input('grammar', 'Grammar database', ['json'], 'Sentence shapes to write into.'),
    ],
    outputs: [
      output('text', 'Text', ['text'], 'text.txt', 'The text this run produced.'),
      output('lexicon', 'Word database', ['json'], 'lexicon.json', 'The words, contexts and weights, for other flows to share.'),
      output('report', 'Report', ['markdown'], 'report.md', 'What the run did: lengths, what changed, what it could not read.'),
    ],
    editor: 'text',
    maturity: 'editor',
    defaultIncomingRules: {
      text: ['alter: 0.3', 'length: +0%', 'temperature: 0.45', 'context window: 3'].join('\n'),
    },
  },

  /* ---------------------------------------------------------------- *
   * Story
   * ---------------------------------------------------------------- */
  {
    kind: 'story.outline',
    category: 'story',
    label: 'Outline / Beat Sheet',
    summary: 'The clip as ordered beats, before any dialog is written.',
    inputs: [
      input('premise', 'Premise', ['markdown', 'text'], 'Logline, ideas, tone.'),
      input('world', 'World', ['markdown'], 'World and setting notes.'),
    ],
    outputs: [
      output('outline', 'Outline', ['markdown'], 'outline.md', 'The beat sheet.'),
      output('beats', 'Beats', ['json'], 'beats.json', 'Beats as data for downstream flows.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('shape', 'Shape', 'line', 'Three act, two-hander, single gag, vignette...'),
      field('beats', 'Beats', 'list', 'One beat per line, in order.'),
      field('turn', 'Turn', 'text', 'The moment the clip pivots.'),
      field('ending', 'Ending', 'text', 'Where it lands and on what image.'),
    ],
    defaultOutgoingRules: { outline: 'one scene per beat\nkeep beat order\ncarry: turn, ending' },
  },
  {
    kind: 'story.dialog',
    category: 'story',
    label: 'Scene Dialog',
    summary: 'Scenes of character dialog with action, sound cues and sets.',
    inputs: [
      input('outline', 'Outline', ['markdown', 'text', 'json'], 'Beat sheet driving the scenes.'),
      input('characters', 'Characters', ['markdown', 'text'], 'Character profiles and voices.'),
      input('world', 'World', ['markdown'], 'World, setting and continuity notes.'),
    ],
    outputs: [
      output('dialog', 'Dialog', ['text'], 'dialog.txt', 'Screenplay-formatted scenes.'),
      output('scenes', 'Scenes', ['json'], 'scenes.json', 'Scenes, beats and sets as data.'),
      output('soundcues', 'Sound cues', ['text'], 'soundcues.txt', 'Every sound cue in script order.'),
    ],
    editor: 'dialog',
    maturity: 'editor',
    defaultOutgoingRules: (() => {
      const board = [
        'panel per: beat',
        'merge: consecutive action beats',
        'shot for line: MCU',
        'shot for action: WS',
        'carry: sound -> notes',
        'min duration: 1.2',
      ].join('\n');
      // Both the readable script and the structured scenes break down the same way.
      return { dialog: board, scenes: board };
    })(),
  },
  {
    kind: 'story.character',
    category: 'story',
    label: 'Character',
    summary: 'One character: personality, history, want, voice.',
    inputs: [
      input('brief', 'Brief', ['markdown', 'text'], 'Ideas, tone, outline.'),
      input('world', 'World', ['markdown'], 'The world this character lives in.'),
    ],
    outputs: [
      output('profile', 'Profile', ['markdown'], 'character.md', 'The character profile.'),
      output('voice', 'Voice', ['text'], 'voice.txt', 'Casting and delivery notes.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('name', 'Name', 'line', 'What everyone calls them.'),
      field('role', 'Role', 'line', 'Their job in this clip.'),
      field('want', 'Want', 'text', 'What they are chasing on screen.'),
      field('need', 'Need', 'text', 'What they actually need.'),
      field('history', 'History', 'text', 'The past that shows up in their behaviour.'),
      field('personality', 'Personality', 'text', 'How they behave under pressure.'),
      field('voice', 'Voice', 'text', 'Vocabulary, rhythm, accent, delivery.'),
      field('relationships', 'Relationships', 'list', 'One per line: `other character — the dynamic`.'),
    ],
    defaultOutgoingRules: { profile: 'voice: keep vocabulary and rhythm\nnever: contradict history' },
  },
  {
    kind: 'story.timeline',
    category: 'story',
    label: 'Timeline',
    summary: 'Story chronology, separate from the order the clip shows it in.',
    inputs: [
      input('scenes', 'Scenes', ['json', 'text', 'markdown'], 'Scenes or outline.'),
      input('world', 'World', ['markdown'], 'World history.'),
    ],
    outputs: [
      output('timeline', 'Timeline', ['json'], 'timeline.json', 'Events in story order.'),
      output('doc', 'Timeline doc', ['markdown'], 'timeline.md', 'Readable chronology.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('events', 'Events', 'list', 'One per line: `when — what happened`.'),
      field('present', 'Present day', 'line', 'Where the clip sits on this line.'),
      field('offscreen', 'Off-screen', 'list', 'Events that happen between scenes.'),
    ],
  },
  {
    kind: 'story.continuity',
    category: 'story',
    label: 'Continuity',
    summary: 'The bible: names, props, injuries, weather, who knows what and when.',
    inputs: [
      input('scenes', 'Scenes', ['json', 'text'], 'Dialog and scenes.'),
      input('profiles', 'Characters', ['markdown'], 'Character profiles.'),
    ],
    outputs: [
      output('continuity', 'Continuity', ['markdown'], 'continuity.md', 'Continuity rules and facts.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('facts', 'Facts', 'list', 'One fact per line. These are binding.'),
      field('props', 'Props in play', 'list', 'Props that must appear and persist.'),
      field('watch', 'Watch for', 'list', 'Known continuity traps in this clip.'),
    ],
  },

  /* ---------------------------------------------------------------- *
   * World
   * ---------------------------------------------------------------- */
  {
    kind: 'world.design',
    category: 'world',
    label: 'World Design',
    summary: 'How the world works: rules, culture, what is normal here.',
    inputs: [input('tone', 'Tone', ['markdown', 'text'], 'Tone, theme, ideas.')],
    outputs: [
      output('world', 'World', ['markdown'], 'world.md', 'The world document.'),
      output('rules', 'World rules', ['text'], 'worldrules.txt', 'Hard rules nothing may break.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('pitch', 'Pitch', 'text', 'The world in three sentences.'),
      field('rules', 'Rules', 'list', 'One hard rule per line.'),
      field('culture', 'Culture', 'text', 'Who lives here and what they care about.'),
      field('history', 'History', 'text', 'What happened before the clip.'),
      field('texture', 'Texture', 'list', 'Small concrete details that sell it.'),
    ],
  },
  {
    kind: 'world.setting',
    category: 'world',
    label: 'Settings',
    summary: 'The specific places the clip happens in.',
    inputs: [input('world', 'World', ['markdown', 'text'], 'World design.')],
    outputs: [
      output('settings', 'Settings', ['markdown'], 'settings.md', 'One section per location.'),
      output('setList', 'Set list', ['json'], 'sets.json', 'Locations as data.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('locations', 'Locations', 'list', 'One per line: `INT. WORKSHOP - NIGHT — what it is`.'),
      field('mood', 'Mood', 'text', 'Light, weather, sound of each place.'),
      field('staging', 'Staging notes', 'text', 'Where characters can stand, enter, hide.'),
    ],
  },

  /* ---------------------------------------------------------------- *
   * Animation
   * ---------------------------------------------------------------- */
  {
    kind: 'animation.storyboard',
    category: 'animation',
    label: 'Storyboard',
    summary: 'Scenes broken into panels: shot, action, dialog and a sketch.',
    inputs: [
      input('dialog', 'Dialog', ['text', 'json'], 'Dialog or scene data to break down.', {
        required: true,
      }),
      input('style', 'Style', ['markdown'], 'Style guide and palette.'),
      input('sets', 'Sets', ['markdown', 'image'], 'Set designs and settings.'),
      input('characters', 'Characters', ['markdown', 'image'], 'Character designs and profiles.'),
    ],
    outputs: [
      output('storyboard', 'Storyboard', ['json'], 'storyboard.json', 'Panels with timing and sketch refs.'),
      output('shotlist', 'Shot list', ['csv'], 'shotlist.csv', 'One row per panel.'),
      output('panels', 'Panel images', ['imageSet'], 'panels', 'Rasterised panel sketches.'),
      output('boards', 'Board doc', ['markdown'], 'boards.md', 'Readable board, panel by panel.'),
    ],
    editor: 'storyboard',
    maturity: 'editor',
    defaultOutgoingRules: { storyboard: 'hold each panel for its duration\ncarry: dialog, sound' },
  },
  {
    kind: 'animation.style',
    category: 'animation',
    label: 'Animation Style',
    summary: 'Line, shading, palette, frame rate and how motion should read.',
    inputs: [input('tone', 'Tone', ['markdown'], 'Tone and references.')],
    outputs: [
      output('style', 'Style guide', ['markdown'], 'style.md', 'The style guide.'),
      output('palette', 'Palette', ['json'], 'palette.json', 'Named colours as data.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('line', 'Line & shape', 'text', 'Line weight, shape language, level of detail.'),
      field('color', 'Colour', 'list', 'One per line: `name #rrggbb — where it is used`.'),
      field('motion', 'Motion', 'text', 'On ones/twos, smear frames, easing, held poses.'),
      field('rules', 'Rules', 'list', 'Hard style rules for every shot.'),
    ],
  },
  {
    kind: 'animation.character.design',
    category: 'animation',
    label: 'Character Design',
    summary: 'Model sheet and turnaround for one character.',
    inputs: [
      input('profile', 'Profile', ['markdown', 'text'], 'Character profile.'),
      input('style', 'Style', ['markdown', 'json'], 'Style guide and palette.'),
    ],
    outputs: [
      output('design', 'Design', ['image'], 'character.png', 'The key design image.'),
      output('modelSheet', 'Model sheet', ['imageSet'], 'modelsheet', 'Turnaround and expressions.'),
      output('spec', 'Design spec', ['markdown'], 'design.md', 'What the design must hold to.'),
    ],
    editor: 'design',
    maturity: 'editor',
    fields: [
      field('silhouette', 'Silhouette', 'text', 'Readable at thumbnail size — how?'),
      field('palette', 'Palette', 'list', 'One per line: `part — colour`.'),
      field('costume', 'Costume & props', 'list', 'Worn and carried items.'),
      field('expressions', 'Expressions', 'list', 'The expressions this clip needs.'),
      field('constraints', 'Constraints', 'list', 'What must stay consistent across shots.'),
    ],
  },
  {
    kind: 'animation.set.design',
    category: 'animation',
    label: 'Set Design',
    summary: 'The buildable version of a location, with staging.',
    inputs: [
      input('settings', 'Settings', ['markdown', 'json'], 'Setting notes.'),
      input('style', 'Style', ['markdown', 'json'], 'Style guide and palette.'),
    ],
    outputs: [
      output('design', 'Design', ['image'], 'set.png', 'The key set image.'),
      output('spec', 'Set spec', ['markdown'], 'set.md', 'Layout, exits, dressing, camera positions.'),
    ],
    editor: 'design',
    maturity: 'editor',
    fields: [
      field('layout', 'Layout', 'text', 'Plan of the space and its exits.'),
      field('dressing', 'Dressing', 'list', 'What is in the room.'),
      field('light', 'Light', 'text', 'Sources, direction, time of day.'),
      field('cameras', 'Camera positions', 'list', 'Angles this set supports.'),
    ],
  },
  {
    kind: 'animation.prop.design',
    category: 'animation',
    label: 'Prop Design',
    summary: 'A prop that has to act: how it looks and how it moves.',
    inputs: [
      input('scenes', 'Scenes', ['text', 'json', 'markdown'], 'Where the prop appears.'),
      input('style', 'Style', ['markdown', 'json'], 'Style guide.'),
    ],
    outputs: [
      output('design', 'Design', ['image'], 'prop.png', 'The prop design.'),
      output('spec', 'Prop spec', ['markdown'], 'prop.md', 'Scale, materials, moving parts.'),
    ],
    editor: 'design',
    maturity: 'editor',
    fields: [
      field('what', 'What it is', 'text', 'Function and scale next to a character.'),
      field('moves', 'How it moves', 'text', 'Hinges, weight, sound it makes.'),
      field('states', 'States', 'list', 'Closed, open, broken, lit...'),
    ],
  },
  {
    kind: 'animation.layout',
    category: 'animation',
    label: 'Layout',
    summary: 'Staging and camera per shot: where everything sits in frame.',
    inputs: [
      input('storyboard', 'Storyboard', ['json', 'csv'], 'Panels to stage.', { required: true }),
      input('sets', 'Sets', ['markdown', 'image'], 'Set specs and designs.'),
    ],
    outputs: [
      output('layout', 'Layout', ['json'], 'layout.json', 'Per-shot staging as data.'),
      output('doc', 'Layout doc', ['markdown'], 'layout.md', 'Readable staging notes.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('shots', 'Shots', 'list', 'One per line: `panel — camera, lens, move`.'),
      field('screenDirection', 'Screen direction', 'text', 'Who faces where, and the line you will not cross.'),
      field('depth', 'Depth', 'text', 'Foreground, midground, background per shot.'),
    ],
  },
  {
    kind: 'animation.rig',
    category: 'animation',
    label: 'Rig / Puppet',
    summary: 'The character as a puppet: parts, pivots, swaps, mouth set.',
    inputs: [
      input('design', 'Design', ['image', 'imageSet'], 'Character design.'),
      input('spec', 'Spec', ['markdown'], 'Design spec.'),
    ],
    outputs: [
      output('rig', 'Rig', ['json'], 'rig.json', 'Parts, pivots and swap sets.'),
      output('doc', 'Rig notes', ['markdown'], 'rig.md', 'How to animate this puppet.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('parts', 'Parts', 'list', 'One per line: `part — parent — pivot`.'),
      field('swaps', 'Swaps', 'list', 'Hand sets, mouth shapes, eye sets.'),
      field('limits', 'Limits', 'text', 'What the rig cannot do, so boards avoid it.'),
    ],
  },
  {
    kind: 'animation.animatic',
    category: 'animation',
    label: 'Animatic',
    summary: 'Boards cut to time against voice and music — the first watchable pass.',
    inputs: [
      input('storyboard', 'Storyboard', ['json'], 'Panels and durations.', { required: true }),
      input('panels', 'Panel images', ['imageSet'], 'Rasterised panels.'),
      input('vo', 'Voice', ['audio', 'audioSet'], 'Scratch or final voice.'),
      input('music', 'Music', ['audio', 'midi'], 'Temp or final music.'),
    ],
    outputs: [
      output('animatic', 'Animatic', ['timeline'], 'animatic.json', 'Cut list with in/out times.'),
      output('preview', 'Preview', ['video'], 'animatic.webm', 'The cut as a video file.'),
    ],
    editor: 'animatic',
    maturity: 'editor',
    defaultIncomingRules: { storyboard: 'target length: 60s' },
  },
  {
    kind: 'animation.scene',
    category: 'animation',
    label: 'Animation Pass',
    summary: 'Keys, breakdowns and inbetweens for one scene.',
    inputs: [
      input('animatic', 'Animatic', ['timeline', 'json'], 'Timing to animate against.', {
        required: true,
      }),
      input('rig', 'Rig', ['json'], 'Puppet definition.'),
      input('layout', 'Layout', ['json'], 'Staging and camera.'),
      input('lipsync', 'Lip sync', ['json'], 'Mouth timing.'),
    ],
    outputs: [
      output('scene', 'Scene', ['json'], 'scene.json', 'Keys and timing as data.'),
      output('frames', 'Frames', ['imageSet'], 'frames', 'Rendered frame sequence.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('keys', 'Key poses', 'list', 'One per line: `time — pose`.'),
      field('timing', 'Timing', 'text', 'On ones/twos, holds, anticipation.'),
      field('notes', 'Notes', 'text', 'Anything the boards could not say.'),
    ],
  },
  {
    kind: 'animation.vfx',
    category: 'animation',
    label: 'VFX Pass',
    summary: 'Effects animation: smoke, water, sparks, screens, weather.',
    inputs: [
      input('scene', 'Scene', ['json'], 'Animation pass.'),
      input('style', 'Style', ['markdown'], 'Style guide.'),
    ],
    outputs: [
      output('vfx', 'VFX plan', ['markdown'], 'vfx.md', 'Per-shot effects plan.'),
      output('frames', 'VFX frames', ['imageSet'], 'vfx', 'Effect element sequences.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('effects', 'Effects', 'list', 'One per line: `shot — effect`.'),
      field('method', 'Method', 'text', 'Hand drawn, particle, comp trick.'),
    ],
  },

  /* ---------------------------------------------------------------- *
   * Art
   * ---------------------------------------------------------------- */
  {
    kind: 'art.colorscript',
    category: 'art',
    label: 'Colour Script',
    summary: 'The clip as a strip of colour and light, beat by beat.',
    inputs: [
      input('storyboard', 'Storyboard', ['json', 'imageSet'], 'Panels in order.'),
      input('style', 'Style', ['markdown', 'json'], 'Style guide and palette.'),
    ],
    outputs: [
      output('colorscript', 'Colour script', ['imageSet'], 'colorscript', 'Colour keys per beat.'),
      output('doc', 'Colour notes', ['markdown'], 'color.md', 'Where the light comes from and why.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('arc', 'Colour arc', 'text', 'How the palette moves across the clip.'),
      field('keys', 'Keys', 'list', 'One per line: `scene — key light, palette`.'),
    ],
  },
  {
    kind: 'art.background',
    category: 'art',
    label: 'Backgrounds',
    summary: 'Finished painted backgrounds, one per unique camera setup.',
    inputs: [
      input('layout', 'Layout', ['json', 'markdown'], 'Staging and camera.'),
      input('setDesign', 'Set design', ['image', 'markdown'], 'Set designs.'),
      input('color', 'Colour', ['markdown', 'imageSet'], 'Colour script.'),
    ],
    outputs: [
      output('backgrounds', 'Backgrounds', ['imageSet'], 'backgrounds', 'One image per setup.'),
      output('doc', 'BG list', ['markdown'], 'backgrounds.md', 'Which shot uses which background.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('list', 'Background list', 'list', 'One per line: `id — shots it covers`.'),
      field('treatment', 'Treatment', 'text', 'Paint style, detail level, edge treatment.'),
    ],
  },

  /* ---------------------------------------------------------------- *
   * Music
   * ---------------------------------------------------------------- */
  {
    kind: 'music.theme',
    category: 'music',
    label: 'Melody / Theme',
    summary: 'The tunes: main theme, character motifs, the hook.',
    inputs: [
      input('tone', 'Tone', ['markdown'], 'Tone and references.'),
      input('timeline', 'Timeline', ['json', 'timeline'], 'Where music has to land.'),
    ],
    outputs: [
      output('melody', 'Melody', ['midi'], 'melody.mid', 'Themes as MIDI.'),
      output('doc', 'Theme notes', ['markdown'], 'themes.md', 'What each motif is for.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('key', 'Key & tempo', 'line', 'e.g. `D minor, 96bpm, 4/4`.'),
      field('motifs', 'Motifs', 'list', 'One per line: `who or what — the idea`.'),
      field('hook', 'Hook', 'text', 'The bit a viewer hums afterwards.'),
    ],
  },
  {
    kind: 'music.arrangement',
    category: 'music',
    label: 'Arrangement',
    summary: 'Instruments, voicing and the arrangement of each cue.',
    inputs: [
      input('melody', 'Melody', ['midi', 'json'], 'Themes to arrange.'),
      input('cues', 'Cue sheet', ['markdown', 'json'], 'Where cues sit.'),
    ],
    outputs: [
      output('arrangement', 'Arrangement', ['json'], 'arrangement.json', 'Tracks, instruments, ranges.'),
      output('render', 'Music', ['audio'], 'music.wav', 'Rendered music bed.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('instruments', 'Instruments', 'list', 'One per line: `instrument — role`.'),
      field('texture', 'Texture', 'text', 'Sparse or thick, acoustic or synthetic.'),
      field('dynamics', 'Dynamics', 'text', 'Where it lifts and where it drops out.'),
    ],
  },
  {
    kind: 'music.cuesheet',
    category: 'music',
    label: 'Cue Sheet',
    summary: 'Spotting: exactly where music starts, stops and hits.',
    inputs: [
      input('animatic', 'Animatic', ['timeline', 'json'], 'Timing to spot against.', {
        required: true,
      }),
      input('melody', 'Melody', ['midi'], 'Available themes.'),
    ],
    outputs: [
      output('cuesheet', 'Cue sheet', ['markdown'], 'cuesheet.md', 'Readable spotting notes.'),
      output('cues', 'Cues', ['json'], 'cues.json', 'Cue in/out times as data.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('cues', 'Cues', 'list', 'One per line: `in — out — what plays`.'),
      field('hits', 'Hits', 'list', 'Moments the music must catch.'),
      field('silence', 'Silence', 'list', 'Where there should be no music at all.'),
    ],
  },

  /* ---------------------------------------------------------------- *
   * Sound
   * ---------------------------------------------------------------- */
  {
    kind: 'sound.voice',
    category: 'sound',
    label: 'Voice',
    summary: 'Casting, direction and recorded takes for every line.',
    inputs: [
      input('dialog', 'Dialog', ['text', 'json'], 'Lines to record.', { required: true }),
      input('voiceNotes', 'Voice notes', ['text', 'markdown'], 'Casting and delivery notes.'),
    ],
    outputs: [
      output('vo', 'Voice takes', ['audioSet'], 'vo', 'One file per line or per take.'),
      output('casting', 'Casting', ['markdown'], 'casting.md', 'Who plays who, and direction.'),
      output('takes', 'Take log', ['json'], 'takes.json', 'Selected takes per line.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('casting', 'Casting', 'list', 'One per line: `character — performer`.'),
      field('direction', 'Direction', 'text', 'Room, mic, energy, pacing.'),
      field('selects', 'Selects', 'list', 'One per line: `line id — take`.'),
    ],
  },
  {
    kind: 'sound.effects',
    category: 'sound',
    label: 'Sound Effects',
    summary: 'Foley and hard effects for every cue in the script.',
    inputs: [
      input('soundcues', 'Sound cues', ['text', 'json'], 'Cues pulled from the script.', {
        required: true,
      }),
      input('storyboard', 'Storyboard', ['json'], 'Panels, for timing.'),
    ],
    outputs: [
      output('sfx', 'SFX', ['audioSet'], 'sfx', 'One file per cue.'),
      output('sheet', 'SFX sheet', ['markdown'], 'sfx.md', 'Cue list with sources.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('cues', 'Cues', 'list', 'One per line: `cue — how it is made`.'),
      field('palette', 'Sound palette', 'text', 'The character of the effects.'),
    ],
  },
  {
    kind: 'sound.ambience',
    category: 'sound',
    label: 'Ambience',
    summary: 'Room tone and beds that make each set sound like a place.',
    inputs: [input('settings', 'Settings', ['markdown', 'json'], 'Locations.')],
    outputs: [
      output('ambience', 'Ambience', ['audioSet'], 'ambience', 'One bed per location.'),
      output('doc', 'Ambience notes', ['markdown'], 'ambience.md', 'What each bed is made of.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('beds', 'Beds', 'list', 'One per line: `location — bed`.'),
      field('transitions', 'Transitions', 'text', 'How beds change across cuts.'),
    ],
  },
  {
    kind: 'sound.mix',
    category: 'sound',
    label: 'Mix',
    summary: 'Voice, effects, ambience and music balanced into one track.',
    inputs: [
      input('vo', 'Voice', ['audio', 'audioSet'], 'Voice takes.', { required: true }),
      input('sfx', 'SFX', ['audio', 'audioSet'], 'Sound effects.'),
      input('ambience', 'Ambience', ['audio', 'audioSet'], 'Ambience beds.'),
      input('music', 'Music', ['audio'], 'Music bed.'),
      input('animatic', 'Animatic', ['timeline', 'json'], 'Timing reference.'),
    ],
    outputs: [
      output('mix', 'Mix', ['audio'], 'mix.wav', 'The final mixed track.'),
      output('doc', 'Mix notes', ['markdown'], 'mix.md', 'Levels, moves and decisions.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('levels', 'Levels', 'list', 'One per line: `stem — level`.'),
      field('moves', 'Moves', 'list', 'Ducks, fades, filters and when.'),
      field('target', 'Target', 'line', 'Loudness target and delivery format.'),
    ],
  },

  /* ---------------------------------------------------------------- *
   * Production
   * ---------------------------------------------------------------- */
  {
    kind: 'production.lipsync',
    category: 'production',
    label: 'Lip Sync',
    summary: 'Mouth shapes timed to the recorded voice.',
    inputs: [
      input('vo', 'Voice', ['audio', 'audioSet'], 'Recorded lines.', { required: true }),
      input('dialog', 'Dialog', ['text', 'json'], 'The words being said.'),
      input('rig', 'Rig', ['json'], 'Available mouth set.'),
    ],
    outputs: [
      output('lipsync', 'Lip sync', ['json'], 'lipsync.json', 'Mouth shape per frame range.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('mouthSet', 'Mouth set', 'list', 'The shapes available, one per line.'),
      field('approach', 'Approach', 'text', 'Phoneme accurate, or stylised on twos.'),
    ],
  },
  {
    kind: 'production.subtitles',
    category: 'production',
    label: 'Subtitles',
    summary: 'Captions and localisation, timed to the cut.',
    inputs: [
      input('dialog', 'Dialog', ['text', 'json'], 'Lines to caption.', { required: true }),
      input('animatic', 'Timing', ['timeline', 'json'], 'Cut timing.'),
    ],
    outputs: [
      output('subtitles', 'Subtitles', ['text'], 'subtitles.srt', 'SRT captions.'),
      output('doc', 'Caption notes', ['markdown'], 'captions.md', 'Reading speed and style decisions.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('languages', 'Languages', 'list', 'One per line.'),
      field('style', 'Style', 'text', 'Line length, reading speed, sound captions.'),
    ],
  },
  {
    kind: 'production.edit',
    category: 'production',
    label: 'Edit',
    summary: 'The assembly: what is on screen at every moment.',
    inputs: [
      input('animatic', 'Animatic', ['timeline', 'json'], 'Cut to build from.', { required: true }),
      input('frames', 'Frames', ['imageSet'], 'Animated frame sequences.'),
      input('mix', 'Mix', ['audio'], 'Final audio.'),
    ],
    outputs: [
      output('edl', 'Edit list', ['timeline'], 'edl.json', 'Clips, in/out points and audio.'),
      output('doc', 'Edit notes', ['markdown'], 'edit.md', 'Why each cut is where it is.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('cuts', 'Cuts', 'list', 'One per line: `shot — in — out`.'),
      field('transitions', 'Transitions', 'list', 'Only where a straight cut will not do.'),
      field('length', 'Length', 'line', 'Target runtime.'),
    ],
  },
  {
    kind: 'production.render',
    category: 'production',
    label: 'Render',
    summary: 'The clip as a file: resolution, codec, frame rate, output.',
    inputs: [
      input('edl', 'Edit list', ['timeline', 'json'], 'What to render.', { required: true }),
      input('frames', 'Frames', ['imageSet'], 'Frame sequences.'),
      input('panels', 'Panels', ['imageSet'], 'Board panels, for a board render.'),
      input('mix', 'Mix', ['audio'], 'Audio track.'),
    ],
    outputs: [
      output('clip', 'Clip', ['video'], 'clip.mp4', 'The rendered clip.'),
      output('plan', 'Render plan', ['markdown'], 'render.md', 'Settings and the exact render command.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('format', 'Format', 'line', 'e.g. `1920x1080, 24fps, h264`.'),
      field('deliverables', 'Deliverables', 'list', 'Every file that has to come out.'),
    ],
  },
  {
    kind: 'production.review',
    category: 'production',
    label: 'Review',
    summary: 'Dailies notes that feed back into the flows upstream.',
    inputs: [
      input('clip', 'Clip', ['video'], 'What is being reviewed.'),
      input('context', 'Context', ['markdown', 'json', 'text'], 'Anything the notes refer to.'),
    ],
    outputs: [
      output('notes', 'Notes', ['markdown'], 'notes.md', 'Notes, grouped by the flow that owns them.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('works', 'Works', 'list', 'What is already landing.'),
      field('fix', 'Fix', 'list', 'One per line: `flow — the note`.'),
      field('questions', 'Questions', 'list', 'Open questions for the next pass.'),
    ],
  },
  {
    kind: 'production.assets',
    category: 'production',
    label: 'Asset Library',
    summary: 'One registry of every asset, so nothing gets re-made or lost.',
    inputs: [input('assets', 'Assets', ['image', 'imageSet', 'audio', 'audioSet', 'json', 'markdown'], 'Anything worth tracking.')],
    outputs: [
      output('assets', 'Asset list', ['json'], 'assets.json', 'Every asset with its owning flow.'),
      output('index', 'Index', ['markdown'], 'assets.md', 'Readable index.'),
    ],
    editor: 'brief',
    maturity: 'brief',
    fields: [
      field('naming', 'Naming', 'text', 'The naming convention for files.'),
      field('tracked', 'Tracked', 'list', 'Assets that must stay in sync.'),
    ],
  },
];

const BY_KIND = new Map<string, FlowKindDef>(FLOW_KINDS.map((f) => [f.kind, f]));

export function getFlowKind(kind: string): FlowKindDef | undefined {
  return BY_KIND.get(kind);
}

export function requireFlowKind(kind: string): FlowKindDef {
  const def = BY_KIND.get(kind);
  if (!def) throw new Error(`Unknown flow kind: ${kind}`);
  return def;
}

export function flowKindsByCategory(category: FlowCategory): FlowKindDef[] {
  return FLOW_KINDS.filter((f) => f.category === category);
}

export function findPort(
  kind: string,
  portId: string,
  side: 'inputs' | 'outputs',
): PortSpec | undefined {
  return getFlowKind(kind)?.[side].find((p) => p.id === portId);
}

/** True when an output port's artifact kinds overlap what an input port accepts. */
export function portsCompatible(from: PortSpec, to: PortSpec): boolean {
  return from.kinds.some((k) => to.kinds.includes(k));
}
