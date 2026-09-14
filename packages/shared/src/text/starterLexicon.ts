import { slugify } from '../ids';
import type { Lexeme, Lexicon, WordType } from '../types/text';

/**
 * A small English word database to start from: enough function words to hold a
 * sentence together, and a set of content words about a workshop at night that
 * are wired to each other by weighted context — `apple` pulls hard on `tree`
 * and `red`, less on `leaf`.
 *
 * Rows are `[spelling, type, frequency, description, contexts]`, where contexts
 * are `spelling:weight` pairs resolved to ids when the lexicon is built.
 */
type Row = [string, WordType, number, string, string?];

const ROWS: Row[] = [
  /* Determiners and pronouns ---------------------------------------- */
  ['the', 'determiner', 0.99, 'The definite article.'],
  ['a', 'determiner', 0.95, 'The indefinite article.'],
  ['an', 'determiner', 0.6, 'The indefinite article before a vowel sound.'],
  ['this', 'determiner', 0.7, 'Points at something close by.'],
  ['that', 'determiner', 0.75, 'Points at something further off.'],
  ['another', 'determiner', 0.35, 'One more of the same.'],
  ['every', 'determiner', 0.35, 'All of them, taken one at a time.'],
  ['some', 'determiner', 0.5, 'An unspecified amount.'],
  ['no', 'determiner', 0.4, 'None at all.'],
  ['its', 'determiner', 0.5, 'Belonging to the thing just mentioned.'],
  ['their', 'determiner', 0.5, 'Belonging to them.'],
  ['her', 'determiner', 0.5, 'Belonging to her.'],
  ['his', 'determiner', 0.5, 'Belonging to him.'],
  ['it', 'pronoun', 0.9, 'The thing itself.'],
  ['they', 'pronoun', 0.8, 'More than one of them.'],
  ['she', 'pronoun', 0.7, 'The woman or girl already mentioned.'],
  ['he', 'pronoun', 0.7, 'The man or boy already mentioned.'],
  ['we', 'pronoun', 0.6, 'The speaker and others.'],
  ['you', 'pronoun', 0.65, 'The person being spoken to.'],
  ['nobody', 'pronoun', 0.35, 'Not one person.', 'watch:0.6, secret:0.5, quiet:0.4'],
  ['something', 'pronoun', 0.45, 'A thing not yet named.', 'strange:0.6, move:0.4'],

  /* Prepositions and conjunctions ------------------------------------ */
  ['of', 'preposition', 0.95, 'Belonging to, or made of.'],
  ['in', 'preposition', 0.9, 'Inside.'],
  ['on', 'preposition', 0.85, 'Resting on top of.'],
  ['at', 'preposition', 0.8, 'At a place or a moment.'],
  ['with', 'preposition', 0.8, 'Alongside, or by means of.'],
  ['from', 'preposition', 0.7, 'Starting point or origin.'],
  ['for', 'preposition', 0.75, 'Intended to serve.'],
  ['into', 'preposition', 0.6, 'Moving to the inside of.'],
  ['under', 'preposition', 0.55, 'Below.', 'bench:0.6, table:0.6, floor:0.4'],
  ['over', 'preposition', 0.55, 'Above, or across the top of.'],
  ['behind', 'preposition', 0.5, 'At the back of.', 'door:0.6, shadow:0.5'],
  ['through', 'preposition', 0.5, 'In one side and out the other.', 'window:0.7, door:0.5, smoke:0.4'],
  ['across', 'preposition', 0.4, 'From one side to the other.', 'floor:0.5, road:0.5, river:0.5'],
  ['against', 'preposition', 0.4, 'Touching and pressing.', 'wall:0.6, window:0.4'],
  ['without', 'preposition', 0.45, 'Not having.'],
  ['and', 'conjunction', 0.95, 'Joins two things.'],
  ['but', 'conjunction', 0.8, 'Joins two things that disagree.'],
  ['or', 'conjunction', 0.6, 'Offers an alternative.'],
  ['so', 'conjunction', 0.6, 'Therefore.'],
  ['because', 'conjunction', 0.5, 'Gives the reason.'],
  ['then', 'conjunction', 0.7, 'After that.'],
  ['while', 'conjunction', 0.5, 'At the same time as.'],
  ['until', 'conjunction', 0.45, 'Up to the moment when.', 'wait:0.7, forget:0.5'],
  ['if', 'conjunction', 0.6, 'Introduces a condition.'],

  /* Adverbs ---------------------------------------------------------- */
  ['not', 'adverb', 0.85, 'Negates what follows.'],
  ['still', 'adverb', 0.55, 'Continuing, even now.'],
  ['again', 'adverb', 0.5, 'One more time.', 'twice:0.6, yesterday:0.4'],
  ['never', 'adverb', 0.5, 'At no time.', 'always:0.5, finish:0.4'],
  ['always', 'adverb', 0.45, 'At every time.', 'never:0.5, habit:0.5'],
  ['almost', 'adverb', 0.45, 'Very nearly.'],
  ['already', 'adverb', 0.45, 'Before now.'],
  ['slowly', 'adverb', 0.4, 'At a low speed.', 'turn:0.7, cool:0.5, push:0.5'],
  ['quietly', 'adverb', 0.4, 'Making little sound.', 'quiet:0.8, shut:0.5, wait:0.4'],
  ['softly', 'adverb', 0.3, 'Gently, without force.', 'quiet:0.6, hum:0.5'],
  ['barely', 'adverb', 0.3, 'Only just.', 'almost:0.5, move:0.4'],
  ['exactly', 'adverb', 0.35, 'Precisely.', 'twice:0.4, count:0.4'],
  ['twice', 'adverb', 0.3, 'Two times.', 'again:0.6, yesterday:0.6, once:0.7'],
  ['once', 'adverb', 0.45, 'A single time, or formerly.', 'twice:0.7, yesterday:0.5'],
  ['yesterday', 'adverb', 0.4, 'The day before today.', 'twice:0.6, once:0.5, remember:0.5'],
  ['somewhere', 'adverb', 0.3, 'In a place not named.', 'road:0.4, hill:0.4'],

  /* Verbs ------------------------------------------------------------ */
  ['is', 'verb', 0.95, 'Present of “to be”.'],
  ['was', 'verb', 0.9, 'Past of “to be”.'],
  ['are', 'verb', 0.8, 'Present plural of “to be”.'],
  ['has', 'verb', 0.75, 'Present of “to have”.'],
  ['had', 'verb', 0.7, 'Past of “to have”.'],
  ['turn', 'verb', 0.5, 'Rotate, or change direction.', 'gear:0.9, lamp:0.6, slowly:0.7, screw:0.6, hand:0.4'],
  ['stop', 'verb', 0.5, 'Come to rest.', 'gear:0.7, clock:0.6, machine:0.6, wait:0.4'],
  ['wait', 'verb', 0.45, 'Stay until something happens.', 'until:0.7, patient:0.7, quietly:0.4, forget:0.5'],
  ['watch', 'verb', 0.45, 'Look at for a while.', 'eye:0.8, nobody:0.6, machine:0.5, quietly:0.4'],
  ['work', 'verb', 0.5, 'Do a job, or function properly.', 'machine:0.9, bench:0.6, workshop:0.7, break:0.6'],
  ['break', 'verb', 0.4, 'Come apart.', 'machine:0.7, spring:0.6, glass:0.7, mistake:0.5, work:0.6'],
  ['hold', 'verb', 0.45, 'Keep in the hand, or keep in place.', 'hand:0.9, hinge:0.5, jar:0.5'],
  ['open', 'verb', 0.45, 'Make no longer shut.', 'door:0.9, window:0.7, jar:0.6, hinge:0.6'],
  ['shut', 'verb', 0.4, 'Close.', 'door:0.9, window:0.6, quietly:0.5'],
  ['listen', 'verb', 0.35, 'Pay attention with the ears.', 'voice:0.8, quiet:0.6, hum:0.5, tick:0.5'],
  ['sit', 'verb', 0.45, 'Rest in place.', 'chair:0.9, bench:0.7, table:0.5, cat:0.6'],
  ['tick', 'verb', 0.2, 'Make a small sharp sound, over and over.', 'clock:0.95, bulb:0.6, cool:0.6, listen:0.5'],
  ['hum', 'verb', 0.2, 'Make a low steady sound.', 'machine:0.8, wire:0.5, bee:0.7, softly:0.5'],
  ['fall', 'verb', 0.4, 'Drop.', 'apple:0.8, leaf:0.8, rain:0.7, dust:0.5'],
  ['keep', 'verb', 0.45, 'Hold on to, or carry on.', 'habit:0.5, secret:0.7'],
  ['forget', 'verb', 0.3, 'Fail to remember.', 'remember:0.8, until:0.5, secret:0.5, wait:0.5'],
  ['remember', 'verb', 0.35, 'Bring back to mind.', 'forget:0.8, yesterday:0.5, story:0.5'],
  ['move', 'verb', 0.45, 'Change place.', 'hand:0.6, gear:0.5, shadow:0.5, barely:0.4'],
  ['drag', 'verb', 0.25, 'Pull along the ground.', 'lamp:0.7, chair:0.6, floor:0.6'],
  ['sway', 'verb', 0.15, 'Swing slowly side to side.', 'lamp:0.7, branch:0.7, wind:0.7'],
  ['cool', 'verb', 0.2, 'Lose heat.', 'bulb:0.8, tea:0.6, tick:0.6, fire:0.5'],
  ['burn', 'verb', 0.25, 'Be on fire.', 'fire:0.9, lamp:0.5, ash:0.8, bright:0.5'],
  ['shine', 'verb', 0.25, 'Give off light.', 'light:0.9, lamp:0.8, sun:0.8, bright:0.8'],
  ['grow', 'verb', 0.3, 'Get bigger.', 'tree:0.8, grass:0.7, garden:0.7, root:0.6'],
  ['eat', 'verb', 0.35, 'Take food.', 'apple:0.8, bread:0.8, honey:0.6, bee:0.3'],
  ['push', 'verb', 0.35, 'Press away.', 'door:0.6, slowly:0.5, switch:0.5'],
  ['refuse', 'verb', 0.2, 'Decline to do it.', 'machine:0.7, work:0.6, stubborn:0.7'],
  ['finish', 'verb', 0.3, 'Bring to an end.', 'unfinished:0.9, never:0.4, work:0.5'],
  ['count', 'verb', 0.3, 'Say the numbers in order.', 'one:0.6, two:0.6, three:0.6, exactly:0.4'],
  ['ask', 'verb', 0.4, 'Put a question.', 'question:0.9, answer:0.7, voice:0.4'],
  ['say', 'verb', 0.6, 'Speak words.', 'voice:0.7, story:0.5, answer:0.5'],

  /* Nouns — the workshop --------------------------------------------- */
  ['workshop', 'noun', 0.3, 'A room for making and mending things.', 'bench:0.9, machine:0.8, oil:0.6, dust:0.6, work:0.7, lamp:0.6'],
  ['bench', 'noun', 0.3, 'The work surface everything ends up on.', 'workshop:0.9, screw:0.6, oil:0.5, dust:0.5, sit:0.7'],
  ['machine', 'noun', 0.45, 'A made thing with moving parts.', 'gear:0.95, brass:0.7, work:0.9, break:0.7, hum:0.8, refuse:0.7, switch:0.6'],
  ['gear', 'noun', 0.3, 'A toothed wheel.', 'machine:0.95, turn:0.9, brass:0.7, tooth:0.8, spring:0.6'],
  ['tooth', 'noun', 0.3, 'One point on a gear, or one in a mouth.', 'gear:0.8, turn:0.4'],
  ['spring', 'noun', 0.3, 'A coil that pushes back.', 'machine:0.7, gear:0.6, break:0.6, brass:0.4'],
  ['screw', 'noun', 0.3, 'A threaded fastener.', 'bench:0.6, turn:0.6, hinge:0.5, brass:0.5'],
  ['hinge', 'noun', 0.25, 'What lets a door swing.', 'door:0.9, open:0.6, oil:0.6, screw:0.5'],
  ['switch', 'noun', 0.3, 'What turns a thing on.', 'lamp:0.7, machine:0.6, light:0.7, push:0.5'],
  ['wire', 'noun', 0.3, 'A thin line of metal.', 'lamp:0.6, machine:0.6, hum:0.5, bulb:0.6'],
  ['bulb', 'noun', 0.25, 'The glass part of a lamp.', 'lamp:0.95, light:0.9, glass:0.7, tick:0.6, cool:0.8, bright:0.6'],
  ['lamp', 'noun', 0.4, 'A light you can move.', 'bulb:0.95, light:0.9, bench:0.6, shine:0.8, shadow:0.7, drag:0.7, sway:0.7'],
  ['light', 'noun', 0.6, 'What lets you see.', 'lamp:0.9, bulb:0.9, shadow:0.8, bright:0.9, sun:0.7, window:0.6'],
  ['shadow', 'noun', 0.35, 'The dark shape light leaves behind.', 'light:0.8, dark:0.8, lamp:0.7, wall:0.6, move:0.5'],
  ['oil', 'noun', 0.3, 'What a hinge wants.', 'hinge:0.6, machine:0.6, workshop:0.6, dust:0.4'],
  ['dust', 'noun', 0.3, 'What settles on everything.', 'workshop:0.6, bench:0.5, floor:0.6, old:0.6, fall:0.5'],
  ['clock', 'noun', 0.4, 'What counts the hours.', 'tick:0.95, hand:0.8, hour:0.9, stop:0.6, wall:0.5'],
  ['hour', 'noun', 0.4, 'Sixty minutes.', 'clock:0.9, night:0.6, wait:0.5'],
  ['hand', 'noun', 0.6, 'On an arm, or on a clock.', 'clock:0.8, hold:0.9, move:0.6, glove:0.5'],
  ['glove', 'noun', 0.2, 'What goes on a hand.', 'hand:0.9, warm:0.5'],
  ['glass', 'noun', 0.35, 'Hard, clear, easy to break.', 'bulb:0.7, window:0.8, break:0.7, jar:0.6'],
  ['brass', 'noun', 0.2, 'A yellow metal that goes dull.', 'machine:0.7, gear:0.7, screw:0.5, bright:0.4'],

  /* Nouns — the house ------------------------------------------------ */
  ['door', 'noun', 0.5, 'The way in.', 'hinge:0.9, open:0.9, shut:0.9, behind:0.6, wall:0.5'],
  ['window', 'noun', 0.45, 'The way the light gets in.', 'glass:0.8, light:0.6, rain:0.6, through:0.7, wall:0.6'],
  ['wall', 'noun', 0.4, 'What holds the roof up.', 'window:0.6, door:0.5, shadow:0.6, house:0.7'],
  ['floor', 'noun', 0.4, 'What you stand on.', 'dust:0.6, across:0.5, drag:0.6, house:0.6'],
  ['roof', 'noun', 0.3, 'What the rain lands on.', 'house:0.9, rain:0.8, chimney:0.8'],
  ['chimney', 'noun', 0.15, 'Where the smoke goes.', 'roof:0.8, smoke:0.95, fire:0.7'],
  ['house', 'noun', 0.55, 'Where someone lives.', 'roof:0.9, door:0.7, wall:0.7, kitchen:0.7, garden:0.7'],
  ['kitchen', 'noun', 0.35, 'Where the food happens.', 'table:0.8, bread:0.8, cup:0.7, knife:0.7, house:0.7'],
  ['table', 'noun', 0.45, 'Flat, with legs.', 'chair:0.9, kitchen:0.8, cup:0.7, sit:0.5'],
  ['chair', 'noun', 0.4, 'For sitting.', 'table:0.9, sit:0.9, kitchen:0.5'],
  ['cup', 'noun', 0.35, 'Holds the tea.', 'tea:0.95, table:0.7, kitchen:0.6'],
  ['tea', 'noun', 0.3, 'Hot, brown, better than it sounds.', 'cup:0.95, warm:0.7, cool:0.6, kitchen:0.6'],
  ['bread', 'noun', 0.35, 'Baked, then cut.', 'knife:0.8, kitchen:0.8, eat:0.8, honey:0.6'],
  ['knife', 'noun', 0.3, 'Sharp, for cutting.', 'bread:0.8, sharp:0.9, kitchen:0.7'],
  ['jar', 'noun', 0.25, 'Glass, with a lid.', 'honey:0.9, glass:0.6, open:0.6, hold:0.5'],
  ['honey', 'noun', 0.25, 'What the bees make.', 'bee:0.95, jar:0.9, sweet:0.9, bread:0.6'],

  /* Nouns — outside -------------------------------------------------- */
  ['garden', 'noun', 0.35, 'Outside, but yours.', 'tree:0.9, grass:0.9, grow:0.7, house:0.7, bee:0.6'],
  ['tree', 'noun', 0.5, 'Tall, wooden, patient.', 'apple:1, leaf:0.95, branch:0.95, root:0.8, garden:0.9, grow:0.8'],
  ['apple', 'noun', 0.42, 'A fruit; the thing that falls.', 'tree:1, red:0.9, fruit:0.9, eat:0.8, sweet:0.6, branch:0.5, leaf:0.4'],
  ['fruit', 'noun', 0.35, 'What the tree is for.', 'apple:0.9, tree:0.8, sweet:0.7, eat:0.7'],
  ['leaf', 'noun', 0.35, 'Green, then brown, then gone.', 'tree:0.95, branch:0.8, fall:0.8, green:0.8, wind:0.6'],
  ['branch', 'noun', 0.3, 'An arm of the tree.', 'tree:0.95, leaf:0.8, apple:0.5, sway:0.7'],
  ['root', 'noun', 0.3, 'The half nobody sees.', 'tree:0.8, grow:0.6, stone:0.4'],
  ['grass', 'noun', 0.35, 'Green, and always coming back.', 'garden:0.9, grow:0.7, green:0.8, rain:0.5'],
  ['bee', 'noun', 0.25, 'Small, loud, busy.', 'honey:0.95, hum:0.7, garden:0.6, flower:0.9'],
  ['flower', 'noun', 0.35, 'The bright part of the plant.', 'bee:0.9, garden:0.8, grow:0.7, red:0.5, sweet:0.5'],
  ['rain', 'noun', 0.4, 'Water, arriving.', 'roof:0.8, window:0.6, fall:0.7, wind:0.7, cold:0.6'],
  ['wind', 'noun', 0.4, 'Air with somewhere to be.', 'rain:0.7, leaf:0.6, sway:0.7, cold:0.6'],
  ['river', 'noun', 0.35, 'Water with a direction.', 'stone:0.6, road:0.4, across:0.5, cold:0.5'],
  ['stone', 'noun', 0.35, 'Heavy, and in no hurry.', 'river:0.6, road:0.5, heavy:0.8, cold:0.5'],
  ['road', 'noun', 0.4, 'The way out.', 'hill:0.7, house:0.5, across:0.5, somewhere:0.4'],
  ['hill', 'noun', 0.3, 'The slow way up.', 'road:0.7, grass:0.5, house:0.4'],
  ['night', 'noun', 0.5, 'When the lamp earns its keep.', 'dark:0.9, moon:0.8, quiet:0.8, lamp:0.6, hour:0.6'],
  ['morning', 'noun', 0.45, 'The other end of it.', 'sun:0.8, light:0.7, bread:0.4, tea:0.5'],
  ['sun', 'noun', 0.5, 'The big one.', 'light:0.8, morning:0.8, shine:0.8, warm:0.8'],
  ['moon', 'noun', 0.35, 'The other one.', 'night:0.8, light:0.5, window:0.4'],
  ['fire', 'noun', 0.4, 'Warm until it is not.', 'smoke:0.9, ash:0.9, burn:0.9, warm:0.8, chimney:0.7'],
  ['smoke', 'noun', 0.3, 'What the fire leaves on the way up.', 'fire:0.9, chimney:0.8, through:0.4'],
  ['ash', 'noun', 0.2, 'What the fire leaves behind.', 'fire:0.9, dust:0.6, grey:0.8'],

  /* Nouns — people and abstractions ---------------------------------- */
  ['friend', 'noun', 0.45, 'The one who stays to watch.', 'voice:0.6, story:0.5, patient:0.6'],
  ['voice', 'noun', 0.45, 'What a person sounds like.', 'listen:0.8, say:0.7, quiet:0.6, friend:0.6'],
  ['eye', 'noun', 0.45, 'For watching.', 'watch:0.8, face:0.8, light:0.4'],
  ['face', 'noun', 0.5, 'The front of a person, or of a clock.', 'eye:0.8, clock:0.4'],
  ['breath', 'noun', 0.3, 'In, then out.', 'quiet:0.6, cold:0.5, wait:0.4'],
  ['story', 'noun', 0.45, 'What gets told afterwards.', 'say:0.6, remember:0.5, friend:0.5, secret:0.5'],
  ['question', 'noun', 0.4, 'What comes before the answer.', 'answer:0.95, ask:0.9'],
  ['answer', 'noun', 0.4, 'What comes after the question.', 'question:0.95, ask:0.7, say:0.5'],
  ['secret', 'noun', 0.35, 'What is kept.', 'keep:0.7, nobody:0.6, story:0.5, forget:0.5'],
  ['trick', 'noun', 0.3, 'The bit that makes it work.', 'machine:0.6, secret:0.6, work:0.5'],
  ['mistake', 'noun', 0.35, 'The useful kind of wrong.', 'break:0.5, work:0.4, again:0.5'],
  ['habit', 'noun', 0.3, 'What you do without deciding.', 'always:0.5, keep:0.5, again:0.4'],
  ['note', 'noun', 0.35, 'A few words on paper.', 'paper:0.9, pencil:0.8, say:0.3'],
  ['paper', 'noun', 0.4, 'Thin, and takes ink.', 'note:0.9, pencil:0.9, drawing:0.8'],
  ['pencil', 'noun', 0.3, 'For the drawing and the note.', 'paper:0.9, drawing:0.9, note:0.8, sharp:0.5'],
  ['drawing', 'noun', 0.35, 'What the pencil leaves.', 'paper:0.9, pencil:0.9, line:0.7'],
  ['line', 'noun', 0.4, 'One stroke, or one spoken.', 'drawing:0.7, pencil:0.6, say:0.4'],
  ['cat', 'noun', 0.35, 'Sits where it is least useful.', 'sit:0.8, quiet:0.6, warm:0.6, bird:0.5'],
  ['bird', 'noun', 0.35, 'Loud at the wrong hour.', 'feather:0.9, tree:0.7, morning:0.6, cat:0.5'],
  ['feather', 'noun', 0.2, 'What a bird leaves behind.', 'bird:0.9, thin:0.5'],

  /* Adjectives ------------------------------------------------------- */
  ['red', 'adjective', 0.5, 'The colour of the apple.', 'apple:0.9, flower:0.5, bright:0.5'],
  ['green', 'adjective', 0.45, 'The colour of the leaf.', 'leaf:0.8, grass:0.8, garden:0.6'],
  ['grey', 'adjective', 0.35, 'The colour of ash and weather.', 'ash:0.8, dust:0.6, rain:0.5'],
  ['small', 'adjective', 0.6, 'Not big.', 'machine:0.5, bee:0.6, gear:0.5'],
  ['heavy', 'adjective', 0.4, 'Hard to lift.', 'stone:0.8, door:0.5, machine:0.5'],
  ['thin', 'adjective', 0.4, 'Not thick.', 'wire:0.7, paper:0.6, feather:0.5, line:0.5'],
  ['quiet', 'adjective', 0.45, 'Making little sound.', 'night:0.8, voice:0.6, quietly:0.8, listen:0.6'],
  ['loud', 'adjective', 0.35, 'Making a lot of it.', 'bird:0.5, machine:0.4'],
  ['old', 'adjective', 0.6, 'Been here a while.', 'machine:0.6, house:0.6, habit:0.5, dust:0.6'],
  ['new', 'adjective', 0.6, 'Not old.', 'old:0.5, bulb:0.4'],
  ['bright', 'adjective', 0.45, 'Giving off a lot of light.', 'light:0.9, lamp:0.7, sun:0.7, bulb:0.6'],
  ['dark', 'adjective', 0.45, 'Giving off none.', 'night:0.9, shadow:0.8, window:0.4'],
  ['cold', 'adjective', 0.5, 'Low on heat.', 'rain:0.6, stone:0.5, night:0.6, warm:0.5'],
  ['warm', 'adjective', 0.5, 'Comfortably hot.', 'fire:0.8, tea:0.7, sun:0.8, cold:0.5'],
  ['sweet', 'adjective', 0.35, 'Tastes of honey.', 'honey:0.9, apple:0.6, fruit:0.7'],
  ['sharp', 'adjective', 0.4, 'Cuts, or cuts through.', 'knife:0.9, pencil:0.5, tooth:0.5'],
  ['broken', 'adjective', 0.4, 'No longer working.', 'machine:0.8, glass:0.7, break:0.9, unfinished:0.5'],
  ['unfinished', 'adjective', 0.2, 'Started, and then not.', 'finish:0.9, broken:0.5, workshop:0.6'],
  ['patient', 'adjective', 0.3, 'Willing to wait.', 'wait:0.8, friend:0.6, quiet:0.5'],
  ['stubborn', 'adjective', 0.25, 'Will not be talked round.', 'refuse:0.8, machine:0.5'],
  ['strange', 'adjective', 0.4, 'Not as expected.', 'something:0.6, story:0.4'],
  ['careful', 'adjective', 0.4, 'Taking no chances.', 'hand:0.5, work:0.5, slowly:0.5'],
  ['tired', 'adjective', 0.35, 'Out of road.', 'night:0.5, hour:0.4'],
  ['empty', 'adjective', 0.4, 'Nothing in it.', 'cup:0.7, jar:0.6, house:0.4, room:0.5'],
  ['full', 'adjective', 0.45, 'Nothing more fits.', 'cup:0.6, jar:0.6, empty:0.5'],
  ['first', 'adjective', 0.5, 'Before the others.', 'last:0.6, morning:0.4'],
  ['last', 'adjective', 0.5, 'After the others.', 'first:0.6, night:0.4'],
  ['room', 'noun', 0.5, 'Four walls and whatever is in them.', 'wall:0.7, door:0.7, house:0.7, empty:0.5'],

  /* Numbers, interjections, punctuation ------------------------------ */
  ['one', 'number', 0.6, 'The first number.', 'two:0.7, count:0.6'],
  ['two', 'number', 0.5, 'The second.', 'one:0.7, three:0.7, twice:0.6'],
  ['three', 'number', 0.4, 'The third.', 'two:0.7, count:0.5'],
  ['ten', 'number', 0.3, 'A round one.', 'count:0.5, hour:0.4'],
  ['42', 'number', 0.05, 'A written number, kept as its own token.', 'count:0.4'],
  ['oh', 'interjection', 0.35, 'Surprise, or filling a gap.'],
  ['well', 'interjection', 0.4, 'Buying a moment before answering.', 'answer:0.4, say:0.3'],
  ['.', 'punctuation', 0.99, 'Ends a sentence.'],
  [',', 'punctuation', 0.9, 'Separates parts of one.'],
  ['?', 'punctuation', 0.35, 'Ends a question.', 'question:0.8, ask:0.6'],
  ['!', 'punctuation', 0.25, 'Ends something said loudly.'],
  [';', 'punctuation', 0.12, 'Joins two sentences that could stand alone.'],
  [':', 'punctuation', 0.12, 'Introduces what follows.'],
  ["'", 'punctuation', 0.3, 'Apostrophe or quote, kept as its own token.'],
];

function idFor(spelling: string, type: WordType): string {
  // Punctuation has no letters to slugify, so it is keyed by character code —
  // otherwise every mark would collapse onto the same id.
  const slug = /[a-z0-9]/i.test(spelling)
    ? slugify(spelling)
    : `p${[...spelling].map((character) => character.charCodeAt(0).toString(16)).join('')}`;
  return `lex_${slug}_${type.slice(0, 3)}`;
}

/**
 * Build the starter lexicon. Ids are derived from the spelling and word type
 * rather than random, so two copies of the starter database line up when one is
 * merged into another.
 */
export function createStarterLexicon(): Lexicon {
  const idBySpelling = new Map<string, string>();
  for (const [spelling, type] of ROWS) {
    if (!idBySpelling.has(spelling)) idBySpelling.set(spelling, idFor(spelling, type));
  }

  const lexemes: Lexeme[] = ROWS.map(([spelling, type, frequency, description, contexts]) => ({
    id: idFor(spelling, type),
    spelling,
    type,
    frequency,
    description,
    contexts: (contexts ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [target, weight] = entry.split(':');
        return { id: idBySpelling.get(target?.trim() ?? '') ?? '', weight: Number(weight ?? 0.5) };
      })
      // A reference to a word that is not in the table is dropped rather than
      // left dangling; the starter data is checked for these by a test.
      .filter((context) => context.id !== ''),
  }));

  return { lexemes };
}

/** Spellings referenced by a context that are not themselves in the table. */
export function starterLexiconGaps(): string[] {
  const known = new Set(ROWS.map(([spelling]) => spelling));
  const gaps = new Set<string>();
  for (const [, , , , contexts] of ROWS) {
    for (const entry of (contexts ?? '').split(',')) {
      const target = entry.split(':')[0]?.trim();
      if (target && !known.has(target)) gaps.add(target);
    }
  }
  return [...gaps].sort();
}
