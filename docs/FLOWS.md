# The flow catalogue

Every kind of work that goes into a clip, as a flow with typed inputs and
outputs. Two have a bespoke editor; the rest use the brief editor, which
collects the fields listed here and generates a markdown brief with everything
arriving over their connections recorded underneath.

*Generated from `packages/shared/src/registry/flowKinds.ts` by `npm run docs:flows`.*

## Brainstorm

### Idea Board

`brainstorm.ideas` · brief editor

Loose sparks, premises and what-ifs before anything is committed.

- **In:** Context
- **Out:** Ideas `ideas.md`, Logline `logline.txt`
- **Fields:** Premise, Sparks, Constraints, Audience
- **Default rules on a new outgoing connection:**

  ```
  keep: premise, logline
  ignore: rejected sparks
  ```

### Tone & Theme

`brainstorm.tone` · brief editor

What the clip is about underneath, and how it should feel.

- **In:** Ideas
- **Out:** Tone `tone.md`
- **Fields:** Themes, Tone, References, Avoid

## Story

### Outline / Beat Sheet

`story.outline` · brief editor

The clip as ordered beats, before any dialog is written.

- **In:** Premise, World
- **Out:** Outline `outline.md`, Beats `beats.json`
- **Fields:** Shape, Beats, Turn, Ending
- **Default rules on a new outgoing connection:**

  ```
  one scene per beat
  keep beat order
  carry: turn, ending
  ```

### Scene Dialog

`story.dialog` · **bespoke editor**

Scenes of character dialog with action, sound cues and sets.

- **In:** Outline, Characters, World
- **Out:** Dialog `dialog.txt`, Scenes `scenes.json`, Sound cues `soundcues.txt`
- **Default rules on a new outgoing connection:**

  ```
  panel per: beat
  merge: consecutive action beats
  shot for line: MCU
  shot for action: WS
  carry: sound -> notes
  min duration: 1.2
  ```

### Character

`story.character` · brief editor

One character: personality, history, want, voice.

- **In:** Brief, World
- **Out:** Profile `character.md`, Voice `voice.txt`
- **Fields:** Name, Role, Want, Need, History, Personality, Voice, Relationships
- **Default rules on a new outgoing connection:**

  ```
  voice: keep vocabulary and rhythm
  never: contradict history
  ```

### Timeline

`story.timeline` · brief editor

Story chronology, separate from the order the clip shows it in.

- **In:** Scenes, World
- **Out:** Timeline `timeline.json`, Timeline doc `timeline.md`
- **Fields:** Events, Present day, Off-screen

### Continuity

`story.continuity` · brief editor

The bible: names, props, injuries, weather, who knows what and when.

- **In:** Scenes, Characters
- **Out:** Continuity `continuity.md`
- **Fields:** Facts, Props in play, Watch for

## World

### World Design

`world.design` · brief editor

How the world works: rules, culture, what is normal here.

- **In:** Tone
- **Out:** World `world.md`, World rules `worldrules.txt`
- **Fields:** Pitch, Rules, Culture, History, Texture

### Settings

`world.setting` · brief editor

The specific places the clip happens in.

- **In:** World
- **Out:** Settings `settings.md`, Set list `sets.json`
- **Fields:** Locations, Mood, Staging notes

## Animation

### Storyboard

`animation.storyboard` · **bespoke editor**

Scenes broken into panels: shot, action, dialog and a sketch.

- **In:** Dialog *(required)*, Style, Sets, Characters
- **Out:** Storyboard `storyboard.json`, Shot list `shotlist.csv`, Panel images `panels`, Board doc `boards.md`
- **Default rules on a new outgoing connection:**

  ```
  hold each panel for its duration
  carry: dialog, sound
  ```

### Animation Style

`animation.style` · brief editor

Line, shading, palette, frame rate and how motion should read.

- **In:** Tone
- **Out:** Style guide `style.md`, Palette `palette.json`
- **Fields:** Line & shape, Colour, Motion, Rules

### Character Design

`animation.character.design` · brief editor

Model sheet and turnaround for one character.

- **In:** Profile, Style
- **Out:** Design `character.png`, Model sheet `modelsheet`, Design spec `design.md`
- **Fields:** Silhouette, Palette, Costume & props, Expressions, Constraints

### Set Design

`animation.set.design` · brief editor

The buildable version of a location, with staging.

- **In:** Settings, Style
- **Out:** Design `set.png`, Set spec `set.md`
- **Fields:** Layout, Dressing, Light, Camera positions

### Prop Design

`animation.prop.design` · brief editor

A prop that has to act: how it looks and how it moves.

- **In:** Scenes, Style
- **Out:** Design `prop.png`, Prop spec `prop.md`
- **Fields:** What it is, How it moves, States

### Layout

`animation.layout` · brief editor

Staging and camera per shot: where everything sits in frame.

- **In:** Storyboard *(required)*, Sets
- **Out:** Layout `layout.json`, Layout doc `layout.md`
- **Fields:** Shots, Screen direction, Depth

### Rig / Puppet

`animation.rig` · brief editor

The character as a puppet: parts, pivots, swaps, mouth set.

- **In:** Design, Spec
- **Out:** Rig `rig.json`, Rig notes `rig.md`
- **Fields:** Parts, Swaps, Limits

### Animatic

`animation.animatic` · brief editor

Boards cut to time against voice and music — the first watchable pass.

- **In:** Storyboard *(required)*, Panel images, Voice, Music
- **Out:** Animatic `animatic.json`, Preview `animatic.mp4`
- **Fields:** Pacing, Holds, Target length

### Animation Pass

`animation.scene` · brief editor

Keys, breakdowns and inbetweens for one scene.

- **In:** Animatic *(required)*, Rig, Layout, Lip sync
- **Out:** Scene `scene.json`, Frames `frames`
- **Fields:** Key poses, Timing, Notes

### VFX Pass

`animation.vfx` · brief editor

Effects animation: smoke, water, sparks, screens, weather.

- **In:** Scene, Style
- **Out:** VFX plan `vfx.md`, VFX frames `vfx`
- **Fields:** Effects, Method

## Art

### Colour Script

`art.colorscript` · brief editor

The clip as a strip of colour and light, beat by beat.

- **In:** Storyboard, Style
- **Out:** Colour script `colorscript`, Colour notes `color.md`
- **Fields:** Colour arc, Keys

### Backgrounds

`art.background` · brief editor

Finished painted backgrounds, one per unique camera setup.

- **In:** Layout, Set design, Colour
- **Out:** Backgrounds `backgrounds`, BG list `backgrounds.md`
- **Fields:** Background list, Treatment

## Music

### Melody / Theme

`music.theme` · brief editor

The tunes: main theme, character motifs, the hook.

- **In:** Tone, Timeline
- **Out:** Melody `melody.mid`, Theme notes `themes.md`
- **Fields:** Key & tempo, Motifs, Hook

### Arrangement

`music.arrangement` · brief editor

Instruments, voicing and the arrangement of each cue.

- **In:** Melody, Cue sheet
- **Out:** Arrangement `arrangement.json`, Music `music.wav`
- **Fields:** Instruments, Texture, Dynamics

### Cue Sheet

`music.cuesheet` · brief editor

Spotting: exactly where music starts, stops and hits.

- **In:** Animatic *(required)*, Melody
- **Out:** Cue sheet `cuesheet.md`, Cues `cues.json`
- **Fields:** Cues, Hits, Silence

## Sound

### Voice

`sound.voice` · brief editor

Casting, direction and recorded takes for every line.

- **In:** Dialog *(required)*, Voice notes
- **Out:** Voice takes `vo`, Casting `casting.md`, Take log `takes.json`
- **Fields:** Casting, Direction, Selects

### Sound Effects

`sound.effects` · brief editor

Foley and hard effects for every cue in the script.

- **In:** Sound cues *(required)*, Storyboard
- **Out:** SFX `sfx`, SFX sheet `sfx.md`
- **Fields:** Cues, Sound palette

### Ambience

`sound.ambience` · brief editor

Room tone and beds that make each set sound like a place.

- **In:** Settings
- **Out:** Ambience `ambience`, Ambience notes `ambience.md`
- **Fields:** Beds, Transitions

### Mix

`sound.mix` · brief editor

Voice, effects, ambience and music balanced into one track.

- **In:** Voice *(required)*, SFX, Ambience, Music, Animatic
- **Out:** Mix `mix.wav`, Mix notes `mix.md`
- **Fields:** Levels, Moves, Target

## Production

### Lip Sync

`production.lipsync` · brief editor

Mouth shapes timed to the recorded voice.

- **In:** Voice *(required)*, Dialog, Rig
- **Out:** Lip sync `lipsync.json`
- **Fields:** Mouth set, Approach

### Subtitles

`production.subtitles` · brief editor

Captions and localisation, timed to the cut.

- **In:** Dialog *(required)*, Timing
- **Out:** Subtitles `subtitles.srt`, Caption notes `captions.md`
- **Fields:** Languages, Style

### Edit

`production.edit` · brief editor

The assembly: what is on screen at every moment.

- **In:** Animatic *(required)*, Frames, Mix
- **Out:** Edit list `edl.json`, Edit notes `edit.md`
- **Fields:** Cuts, Transitions, Length

### Render

`production.render` · brief editor

The clip as a file: resolution, codec, frame rate, output.

- **In:** Edit list *(required)*, Frames, Panels, Mix
- **Out:** Clip `clip.mp4`, Render plan `render.md`
- **Fields:** Format, Deliverables

### Review

`production.review` · brief editor

Dailies notes that feed back into the flows upstream.

- **In:** Clip, Context
- **Out:** Notes `notes.md`
- **Fields:** Works, Fix, Questions

### Asset Library

`production.assets` · brief editor

One registry of every asset, so nothing gets re-made or lost.

- **In:** Assets
- **Out:** Asset list `assets.json`, Index `assets.md`
- **Fields:** Naming, Tracked

---

34 flow kinds.
