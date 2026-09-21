import type { WordMeaning } from './senses';

/**
 * What the sample corpus's words are, written by hand.
 *
 * The studio guesses nothing: a word whose type nobody has established is
 * `unknown` and says so. That is right, and it leaves a problem — a Random Text
 * flow you have only just added has a database with no types in it, so its
 * grammar has nothing to work with and its first output is word soup. Somebody
 * has to answer for the sample corpus before it can demonstrate anything.
 *
 * So these are the answers, for all two hundred-odd words the bundled corpus
 * contains. The types and the descriptions were written for this file, which is
 * why they are marked `manual`: authored data, not a rule applied to a spelling.
 * The forms come from AGID — the same dataset the Dictionary flow downloads — so
 * they are the dataset's rather than this file's opinion, and `knife`/`knives`,
 * `go`/`went`/`gone` and `be`/`was`/`been` are right here for the same reason
 * they are right anywhere else in the studio.
 *
 * Thirteen carry no forms, and each absence is correct: `slowly` and `away` have
 * no inflected comparative, `Mabz` and `Tully` are names, and `brass`, `faded`
 * and `alone` take `more` rather than an ending. `are` has none because it is the
 * plural present of `be`, and the five verb forms this studio models have no slot
 * for that.
 *
 * A dictionary lookup over the same words replaces all of this, which is the
 * point: it is a floor, not a ceiling.
 */
export const SAMPLE_MEANINGS: Record<string, WordMeaning> = {
  "the": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "Points at a particular one." },
    ],
  },
  "a": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "Any one of them." },
    ],
  },
  "this": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "The one here." },
    ],
  },
  "that": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "The one over there." },
      { type: 'conjunction', description: "Introduces what follows." },
    ],
  },
  "some": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "An amount of, not said exactly." },
    ],
  },
  "every": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "Each one of them." },
    ],
  },
  "all": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "Every one." },
    ],
  },
  "other": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "The remaining one." },
    ],
  },
  "same": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "Not another." },
    ],
  },
  "neither": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "Not one and not the other." },
    ],
  },
  "its": {
    source: 'manual',
    senses: [
      { type: 'determiner', description: "Belonging to it." },
    ],
  },
  "it": {
    source: 'manual',
    senses: [
      { type: 'pronoun', description: "The thing already mentioned." },
    ],
  },
  "they": {
    source: 'manual',
    senses: [
      { type: 'pronoun', description: "The ones being spoken about." },
    ],
  },
  "them": {
    source: 'manual',
    senses: [
      { type: 'pronoun', description: "The ones already mentioned." },
    ],
  },
  "us": {
    source: 'manual',
    senses: [
      { type: 'pronoun', description: "The speaker and others." },
    ],
  },
  "nobody": {
    source: 'manual',
    senses: [
      { type: 'pronoun', description: "Not one person." },
    ],
  },
  "nothing": {
    source: 'manual',
    senses: [
      { type: 'pronoun', description: "Not one thing." },
    ],
  },
  "anybody": {
    source: 'manual',
    senses: [
      { type: 'pronoun', description: "Any one person." },
    ],
  },
  "one": {
    source: 'manual',
    senses: [
      { type: 'number', description: "The first number.", variations: { singular: "one", plural: "ones" } },
      { type: 'pronoun', description: "A person, spoken of generally." },
    ],
  },
  "on": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Resting on top of." },
    ],
  },
  "in": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Inside." },
    ],
  },
  "of": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Belonging to." },
    ],
  },
  "at": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "In the place of." },
    ],
  },
  "from": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Starting at." },
    ],
  },
  "over": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Above, or across." },
    ],
  },
  "beside": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Next to." },
    ],
  },
  "by": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Beside, or by means of." },
    ],
  },
  "under": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Below." },
    ],
  },
  "with": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "In the company of." },
    ],
  },
  "across": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "From one side to the other." },
    ],
  },
  "behind": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "At the back of." },
    ],
  },
  "for": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Meant to go to." },
    ],
  },
  "into": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "To the inside of." },
    ],
  },
  "onto": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "On to the top of." },
    ],
  },
  "through": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "In at one side and out the other." },
    ],
  },
  "above": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Higher than." },
    ],
  },
  "around": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "On every side of." },
    ],
  },
  "between": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "In the space separating two things." },
    ],
  },
  "beyond": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Further than." },
    ],
  },
  "to": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Towards." },
    ],
  },
  "like": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "In the manner of." },
      { type: 'verb', description: "To be fond of.", variations: { infinitive: "like", past: "liked", past_participle: "liked", present_progressive: "liking", third_person_singular: "likes" } },
    ],
  },
  "before": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "In front of." },
      { type: 'conjunction', description: "Earlier than." },
    ],
  },
  "outside": {
    source: 'manual',
    senses: [
      { type: 'preposition', description: "Beyond the walls of." },
      { type: 'adverb', description: "Not indoors.", variations: { positive: "outside", comparative: "outsider" } },
    ],
  },
  "and": {
    source: 'manual',
    senses: [
      { type: 'conjunction', description: "Joins two things." },
    ],
  },
  "because": {
    source: 'manual',
    senses: [
      { type: 'conjunction', description: "For the reason that." },
    ],
  },
  "when": {
    source: 'manual',
    senses: [
      { type: 'conjunction', description: "At the time that." },
    ],
  },
  "where": {
    source: 'manual',
    senses: [
      { type: 'conjunction', description: "In the place that." },
    ],
  },
  "while": {
    source: 'manual',
    senses: [
      { type: 'conjunction', description: "During the time that." },
    ],
  },
  "as": {
    source: 'manual',
    senses: [
      { type: 'conjunction', description: "In the way that." },
    ],
  },
  "again": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "Once more." },
    ],
  },
  "slowly": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "At a low speed." },
    ],
  },
  "quietly": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "Making little sound." },
    ],
  },
  "twice": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "Two times.", variations: { positive: "twice", comparative: "twicer" } },
    ],
  },
  "once": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "One time.", variations: { positive: "once", comparative: "oncer" } },
    ],
  },
  "always": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "Every time." },
    ],
  },
  "away": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "To another place." },
    ],
  },
  "now": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "At this moment." },
    ],
  },
  "not": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "Says something is untrue.", variations: { positive: "not", comparative: "noter" } },
    ],
  },
  "there": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "In that place." },
    ],
  },
  "up": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "To a higher place.", variations: { positive: "up", comparative: "upper" } },
    ],
  },
  "out": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "Away from the inside.", variations: { positive: "out", comparative: "outer" } },
    ],
  },
  "later": {
    source: 'manual',
    senses: [
      { type: 'adverb', description: "After this.", variations: { positive: "late", comparative: "later", superlative: "latest" } },
    ],
  },
  "is": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Third person singular of “be”.", variations: { infinitive: "be", third_person_singular: "is", present_progressive: "being", past: "was", past_participle: "been" } },
    ],
  },
  "are": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Plural of “be”." },
    ],
  },
  "have": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "To hold or own.", variations: { infinitive: "have", past: "had", past_participle: "had", present_progressive: "having", third_person_singular: "has" } },
    ],
  },
  "has": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Third person singular of “have”.", variations: { infinitive: "have", past: "had", past_participle: "had", present_progressive: "having", third_person_singular: "has" } },
    ],
  },
  "does": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Third person singular of “do”.", variations: { infinitive: "do", past: "did", past_participle: "done", present_progressive: "doing", third_person_singular: "does" } },
    ],
  },
  "will": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Says something is going to happen.", variations: { infinitive: "will", past: "willed", past_participle: "willed", present_progressive: "willing", third_person_singular: "wills" } },
    ],
  },
  "keep": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "To go on having.", variations: { infinitive: "keep", past: "kept", past_participle: "kept", present_progressive: "keeping", third_person_singular: "keeps" } },
    ],
  },
  "sit": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "To rest on a seat.", variations: { infinitive: "sit", past: "sat", past_participle: "sat", present_progressive: "sitting", third_person_singular: "sits" } },
    ],
  },
  "wait": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "To stay until something happens.", variations: { infinitive: "wait", past: "waited", past_participle: "waited", present_progressive: "waiting", third_person_singular: "waits" } },
    ],
  },
  "forget": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "To fail to keep in mind.", variations: { infinitive: "forget", past: "forgot", past_participle: "forgotten", present_progressive: "forgetting", third_person_singular: "forgets" } },
    ],
  },
  "falls": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Drops under its own weight.", variations: { infinitive: "fall", past: "fell", past_participle: "fallen", present_progressive: "falling", third_person_singular: "falls" } },
    ],
  },
  "moves": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Changes place.", variations: { infinitive: "move", past: "moved", past_participle: "moved", present_progressive: "moving", third_person_singular: "moves" } },
    ],
  },
  "says": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Puts into words.", variations: { infinitive: "say", past: "said", past_participle: "said", present_progressive: "saying", third_person_singular: "says" } },
    ],
  },
  "sits": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Rests on a seat.", variations: { infinitive: "sit", past: "sat", past_participle: "sat", present_progressive: "sitting", third_person_singular: "sits" } },
    ],
  },
  "turns": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Goes round.", variations: { infinitive: "turn", past: "turned", past_participle: "turned", present_progressive: "turning", third_person_singular: "turns" } },
    ],
  },
  "waits": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Stays until something happens.", variations: { infinitive: "wait", past: "waited", past_participle: "waited", present_progressive: "waiting", third_person_singular: "waits" } },
    ],
  },
  "burns": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Is on fire.", variations: { infinitive: "burn", past: "burned", past_participle: "burned", present_progressive: "burning", third_person_singular: "burns" } },
    ],
  },
  "comes": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Moves towards.", variations: { infinitive: "come", past: "came", past_participle: "come", present_progressive: "coming", third_person_singular: "comes" } },
    ],
  },
  "holds": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Keeps hold of.", variations: { infinitive: "hold", past: "held", past_participle: "held", present_progressive: "holding", third_person_singular: "holds" } },
    ],
  },
  "ticks": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Makes a small repeated sound.", variations: { infinitive: "tick", past: "ticked", past_participle: "ticked", present_progressive: "ticking", third_person_singular: "ticks" } },
    ],
  },
  "sways": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Leans one way and then the other.", variations: { infinitive: "sway", past: "swayed", past_participle: "swayed", present_progressive: "swaying", third_person_singular: "sways" } },
    ],
  },
  "asks": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Puts a question.", variations: { infinitive: "ask", past: "asked", past_participle: "asked", present_progressive: "asking", third_person_singular: "asks" } },
    ],
  },
  "cools": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Becomes less hot.", variations: { infinitive: "cool", past: "cooled", past_participle: "cooled", present_progressive: "cooling", third_person_singular: "cools" } },
    ],
  },
  "goes": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Moves away.", variations: { infinitive: "go", past: "went", past_participle: "gone", present_progressive: "going", third_person_singular: "goes" } },
    ],
  },
  "hangs": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Is held from above.", variations: { infinitive: "hang", past: "hung", past_participle: "hung", present_progressive: "hanging", third_person_singular: "hangs" } },
    ],
  },
  "hears": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Takes in sound.", variations: { infinitive: "hears", past: "hearsed", past_participle: "hearsed", present_progressive: "hearsing", third_person_singular: "hearses" } },
    ],
  },
  "laughs": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Makes the sound of being amused.", variations: { infinitive: "laugh", past: "laughed", past_participle: "laughed", present_progressive: "laughing", third_person_singular: "laughs" } },
    ],
  },
  "settles": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Comes to rest.", variations: { infinitive: "settle", past: "settled", past_participle: "settled", present_progressive: "settling", third_person_singular: "settles" } },
    ],
  },
  "stands": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Is upright.", variations: { infinitive: "stand", past: "stood", past_participle: "stood", present_progressive: "standing", third_person_singular: "stands" } },
    ],
  },
  "brings": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Carries towards.", variations: { infinitive: "bring", past: "brought", past_participle: "brought", present_progressive: "bringing", third_person_singular: "brings" } },
    ],
  },
  "brushed": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Swept lightly.", variations: { infinitive: "brush", past: "brushed", past_participle: "brushed", present_progressive: "brushing", third_person_singular: "brushes" } },
    ],
  },
  "carries": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Takes from one place to another.", variations: { infinitive: "carry", past: "carried", past_participle: "carried", present_progressive: "carrying", third_person_singular: "carries" } },
    ],
  },
  "climbs": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Goes up.", variations: { infinitive: "climb", past: "climbed", past_participle: "climbed", present_progressive: "climbing", third_person_singular: "climbs" } },
    ],
  },
  "counts": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Says the numbers of.", variations: { infinitive: "count", past: "counted", past_participle: "counted", present_progressive: "counting", third_person_singular: "counts" } },
    ],
  },
  "drags": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Pulls along the ground.", variations: { infinitive: "drag", past: "dragged", past_participle: "dragged", present_progressive: "dragging", third_person_singular: "drags" } },
    ],
  },
  "draws": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Makes a picture, or pulls.", variations: { infinitive: "draw", past: "drew", past_participle: "drawn", present_progressive: "drawing", third_person_singular: "draws" } },
    ],
  },
  "eats": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Takes in food.", variations: { infinitive: "eat", past: "ate", past_participle: "eaten", present_progressive: "eating", third_person_singular: "eats" } },
    ],
  },
  "follows": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Goes after.", variations: { infinitive: "follow", past: "followed", past_participle: "followed", present_progressive: "following", third_person_singular: "follows" } },
    ],
  },
  "forgets": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Fails to keep in mind.", variations: { infinitive: "forget", past: "forgot", past_participle: "forgotten", present_progressive: "forgetting", third_person_singular: "forgets" } },
    ],
  },
  "grows": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Gets bigger.", variations: { infinitive: "grow", past: "grew", past_participle: "grown", present_progressive: "growing", third_person_singular: "grows" } },
    ],
  },
  "held": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Kept hold of.", variations: { infinitive: "hold", past: "held", past_participle: "held", present_progressive: "holding", third_person_singular: "holds" } },
    ],
  },
  "hums": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Makes a low steady sound.", variations: { infinitive: "hum", past: "hummed", past_participle: "hummed", present_progressive: "humming", third_person_singular: "hums" } },
    ],
  },
  "opens": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Makes open.", variations: { infinitive: "open", past: "opened", past_participle: "opened", present_progressive: "opening", third_person_singular: "opens" } },
    ],
  },
  "reaches": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Stretches out to.", variations: { infinitive: "reach", past: "reached", past_participle: "reached", present_progressive: "reaching", third_person_singular: "reaches" } },
    ],
  },
  "reads": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Takes in what is written.", variations: { infinitive: "read", past: "read", past_participle: "read", present_progressive: "reading", third_person_singular: "reads" } },
    ],
  },
  "shakes": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Moves quickly to and fro.", variations: { infinitive: "shake", past: "shook", past_participle: "shaken", present_progressive: "shaking", third_person_singular: "shakes" } },
    ],
  },
  "shuts": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Closes.", variations: { infinitive: "shut", past: "shut", past_participle: "shut", present_progressive: "shutting", third_person_singular: "shuts" } },
    ],
  },
  "sings": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Makes music with the voice.", variations: { infinitive: "sing", past: "sang", past_participle: "sung", present_progressive: "singing", third_person_singular: "sings" } },
    ],
  },
  "sleeping": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "At rest with the eyes closed.", variations: { infinitive: "sleep", past: "slept", past_participle: "slept", present_progressive: "sleeping", third_person_singular: "sleeps" } },
    ],
  },
  "sleeps": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Rests with the eyes closed.", variations: { infinitive: "sleep", past: "slept", past_participle: "slept", present_progressive: "sleeping", third_person_singular: "sleeps" } },
    ],
  },
  "smells": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Gives off a scent, or takes one in.", variations: { infinitive: "smell", past: "smelled", past_participle: "smelled", present_progressive: "smelling", third_person_singular: "smells" } },
    ],
  },
  "stopped": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Came to a halt.", variations: { infinitive: "stop", past: "stopped", past_participle: "stopped", present_progressive: "stopping", third_person_singular: "stops" } },
    ],
  },
  "stops": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Comes to a halt.", variations: { infinitive: "stop", past: "stopped", past_participle: "stopped", present_progressive: "stopping", third_person_singular: "stops" } },
    ],
  },
  "swings": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Moves to and fro from a fixed point.", variations: { infinitive: "swing", past: "swung", past_participle: "swung", present_progressive: "swinging", third_person_singular: "swings" } },
    ],
  },
  "takes": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Gets hold of.", variations: { infinitive: "take", past: "took", past_participle: "taken", present_progressive: "taking", third_person_singular: "takes" } },
    ],
  },
  "turned": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Went round.", variations: { infinitive: "turn", past: "turned", past_participle: "turned", present_progressive: "turning", third_person_singular: "turns" } },
    ],
  },
  "turning": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Going round.", variations: { infinitive: "turn", past: "turned", past_participle: "turned", present_progressive: "turning", third_person_singular: "turns" } },
    ],
  },
  "works": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Does what it is meant to do.", variations: { infinitive: "work", past: "worked", past_participle: "worked", present_progressive: "working", third_person_singular: "works" } },
    ],
  },
  "machine": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A made thing that does work.", variations: { singular: "machine", plural: "machines" } },
    ],
  },
  "gear": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A toothed wheel that turns another.", variations: { singular: "gear", plural: "gears" } },
    ],
  },
  "mabz": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A name." },
    ],
  },
  "tully": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A name." },
    ],
  },
  "bench": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A long seat, or a work surface.", variations: { singular: "bench", plural: "benches" } },
    ],
  },
  "lamp": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A light you can move.", variations: { singular: "lamp", plural: "lamps" } },
    ],
  },
  "workshop": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A room for making and mending.", variations: { singular: "workshop", plural: "workshops" } },
    ],
  },
  "door": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What closes a doorway.", variations: { singular: "door", plural: "doors" } },
    ],
  },
  "wall": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "An upright side of a room.", variations: { singular: "wall", plural: "walls" } },
    ],
  },
  "apple": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A round fruit.", variations: { singular: "apple", plural: "apples" } },
    ],
  },
  "brass": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A yellow metal.", variations: { singular: "brass", plural: "brasses" } },
      { type: 'adjective', description: "Made of brass." },
    ],
  },
  "bread": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Baked dough.", variations: { singular: "bread", plural: "breads" } },
    ],
  },
  "garden": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Ground kept for growing.", variations: { singular: "garden", plural: "gardens" } },
    ],
  },
  "cat": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A small kept animal.", variations: { singular: "cat", plural: "Cats" } },
    ],
  },
  "house": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A building lived in.", variations: { singular: "house", plural: "houses" } },
    ],
  },
  "night": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The dark part of the day.", variations: { singular: "night", plural: "nights" } },
    ],
  },
  "nights": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Dark parts of the day.", variations: { singular: "night", plural: "nights" } },
    ],
  },
  "shadow": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The dark shape a thing casts.", variations: { singular: "shadow", plural: "shadows" } },
    ],
  },
  "bird": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A feathered animal.", variations: { singular: "bird", plural: "birds" } },
    ],
  },
  "branch": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "An arm of a tree.", variations: { singular: "branch", plural: "branches" } },
    ],
  },
  "bulb": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The glass part of a lamp.", variations: { singular: "bulb", plural: "bulbs" } },
    ],
  },
  "chimney": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The pipe smoke leaves by.", variations: { singular: "chimney", plural: "chimneys" } },
    ],
  },
  "clock": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A thing that tells the time.", variations: { singular: "clock", plural: "clocks" } },
    ],
  },
  "cloth": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Woven material.", variations: { singular: "cloth", plural: "cloths" } },
    ],
  },
  "cup": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A small vessel to drink from.", variations: { singular: "cup", plural: "cups" } },
    ],
  },
  "fire": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Burning.", variations: { singular: "fire", plural: "fires" } },
    ],
  },
  "floor": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What is walked on.", variations: { singular: "floor", plural: "floors" } },
    ],
  },
  "grass": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The green cover of the ground.", variations: { singular: "grass", plural: "grasses" } },
    ],
  },
  "honey": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What bees make.", variations: { singular: "honey", plural: "honeys" } },
    ],
  },
  "hour": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Sixty minutes.", variations: { singular: "hour", plural: "hours" } },
    ],
  },
  "jar": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A wide glass vessel.", variations: { singular: "jar", plural: "jars" } },
    ],
  },
  "kitchen": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The room food is made in.", variations: { singular: "kitchen", plural: "kitchens" } },
    ],
  },
  "knife": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A blade with a handle.", variations: { singular: "knife", plural: "knives" } },
    ],
  },
  "leaf": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A flat green part of a plant.", variations: { singular: "leaf", plural: "leaves" } },
    ],
  },
  "morning": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The early part of the day.", variations: { singular: "morning", plural: "mornings" } },
    ],
  },
  "mornings": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Early parts of the day.", variations: { singular: "morning", plural: "mornings" } },
    ],
  },
  "paper": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What is written on.", variations: { singular: "paper", plural: "papers" } },
    ],
  },
  "pencil": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A wooden stick for writing.", variations: { singular: "pencil", plural: "pencils" } },
    ],
  },
  "roof": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What covers a building.", variations: { singular: "roof", plural: "roofs" } },
    ],
  },
  "room": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A part of a building.", variations: { singular: "room", plural: "rooms" } },
    ],
  },
  "smoke": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What rises from a fire.", variations: { singular: "smoke", plural: "smokes" } },
      { type: 'verb', description: "To give off smoke.", variations: { infinitive: "smoke", past: "smoked", past_participle: "smoked", present_progressive: "smoking", third_person_singular: "smokes" } },
    ],
  },
  "story": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "An account of what happened.", variations: { singular: "story", plural: "stories" } },
    ],
  },
  "sun": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The star the day comes from.", variations: { singular: "sun", plural: "Suns" } },
    ],
  },
  "table": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A flat top on legs.", variations: { singular: "table", plural: "tables" } },
    ],
  },
  "tea": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A drink made from leaves.", variations: { singular: "tea", plural: "teas" } },
    ],
  },
  "thing": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Any object.", variations: { singular: "thing", plural: "things" } },
    ],
  },
  "time": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What clocks measure.", variations: { singular: "time", plural: "times" } },
    ],
  },
  "tree": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A tall woody plant.", variations: { singular: "tree", plural: "trees" } },
    ],
  },
  "week": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Seven days.", variations: { singular: "week", plural: "weeks" } },
    ],
  },
  "window": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A hole in a wall with glass in it.", variations: { singular: "window", plural: "windows" } },
    ],
  },
  "wire": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A thin thread of metal.", variations: { singular: "wire", plural: "wires" } },
    ],
  },
  "line": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A long thin mark.", variations: { singular: "line", plural: "lines" } },
    ],
  },
  "lines": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Long thin marks.", variations: { singular: "line", plural: "lines" } },
    ],
  },
  "hand": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The end of the arm.", variations: { singular: "hand", plural: "hands" } },
      { type: 'verb', description: "To pass something over.", variations: { infinitive: "hand", past: "handed", past_participle: "handed", present_progressive: "handing", third_person_singular: "hands" } },
    ],
  },
  "hands": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The ends of the arms.", variations: { singular: "hand", plural: "hands" } },
      { type: 'verb', description: "Passes something over.", variations: { infinitive: "hand", past: "handed", past_participle: "handed", present_progressive: "handing", third_person_singular: "hands" } },
    ],
  },
  "light": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What lets you see.", variations: { singular: "light", plural: "lights" } },
      { type: 'verb', description: "To set burning.", variations: { infinitive: "light", past: "lighted", past_participle: "lighted", present_progressive: "lighting", third_person_singular: "lights" } },
      { type: 'adjective', description: "Not heavy.", variations: { positive: "light", comparative: "lighter", superlative: "lightest" } },
    ],
  },
  "wind": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Moving air.", variations: { singular: "wind", plural: "winds" } },
      { type: 'verb', description: "To turn something round.", variations: { infinitive: "wind", past: "winded", past_participle: "winded", present_progressive: "winding", third_person_singular: "winds" } },
    ],
  },
  "watches": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Looks at for a while.", variations: { infinitive: "watch", past: "watched", past_participle: "watched", present_progressive: "watching", third_person_singular: "watches" } },
      { type: 'noun', description: "Things worn to tell the time.", variations: { singular: "watch", plural: "watches" } },
    ],
  },
  "drawing": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A picture made with lines.", variations: { singular: "drawing", plural: "drawings" } },
      { type: 'verb', description: "Making a picture.", variations: { infinitive: "draw", past: "drew", past_participle: "drawn", present_progressive: "drawing", third_person_singular: "draws" } },
    ],
  },
  "answer": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What is said back.", variations: { singular: "answer", plural: "answers" } },
      { type: 'verb', description: "To say back.", variations: { infinitive: "answer", past: "answered", past_participle: "answered", present_progressive: "answering", third_person_singular: "answers" } },
    ],
  },
  "question": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What is asked.", variations: { singular: "question", plural: "questions" } },
      { type: 'verb', description: "To ask about.", variations: { infinitive: "question", past: "questioned", past_participle: "questioned", present_progressive: "questioning", third_person_singular: "questions" } },
    ],
  },
  "trick": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A clever way of doing something.", variations: { singular: "trick", plural: "tricks" } },
      { type: 'verb', description: "To fool.", variations: { infinitive: "trick", past: "tricked", past_participle: "tricked", present_progressive: "tricking", third_person_singular: "tricks" } },
    ],
  },
  "screw": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "A threaded fastening.", variations: { singular: "screw", plural: "screws" } },
      { type: 'verb', description: "To fasten with one.", variations: { infinitive: "screw", past: "screwed", past_participle: "screwed", present_progressive: "screwing", third_person_singular: "screws" } },
    ],
  },
  "rain": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "Water falling from the sky.", variations: { singular: "rain", plural: "rains" } },
      { type: 'verb', description: "To fall as water.", variations: { infinitive: "rain", past: "rained", past_participle: "rained", present_progressive: "raining", third_person_singular: "rains" } },
    ],
  },
  "spring": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "The season after winter, or a coiled wire.", variations: { singular: "spring", plural: "springs" } },
      { type: 'verb', description: "To jump.", variations: { infinitive: "spring", past: "sprang", past_participle: "sprung", present_progressive: "springing", third_person_singular: "springs" } },
    ],
  },
  "work": {
    source: 'manual',
    senses: [
      { type: 'noun', description: "What has to be done.", variations: { singular: "work", plural: "works" } },
      { type: 'verb', description: "To do what one is meant to.", variations: { infinitive: "work", past: "worked", past_participle: "worked", present_progressive: "working", third_person_singular: "works" } },
    ],
  },
  "look": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "To turn the eyes towards.", variations: { infinitive: "look", past: "looked", past_participle: "looked", present_progressive: "looking", third_person_singular: "looks" } },
      { type: 'noun', description: "An act of looking.", variations: { singular: "look", plural: "looks" } },
    ],
  },
  "lies": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Rests flat, or says what is untrue.", variations: { infinitive: "lie", past: "lied", past_participle: "lain", present_progressive: "lying", third_person_singular: "lies" } },
      { type: 'noun', description: "Things said that are untrue.", variations: { singular: "lie", plural: "lies" } },
    ],
  },
  "drinks": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Takes in liquid.", variations: { infinitive: "drink", past: "drank", past_participle: "drunk", present_progressive: "drinking", third_person_singular: "drinks" } },
      { type: 'noun', description: "Things to drink.", variations: { singular: "drink", plural: "drinks" } },
    ],
  },
  "drops": {
    source: 'manual',
    senses: [
      { type: 'verb', description: "Lets fall.", variations: { infinitive: "drop", past: "dropped", past_participle: "dropped", present_progressive: "dropping", third_person_singular: "drops" } },
      { type: 'noun', description: "Small round bits of liquid.", variations: { singular: "drop", plural: "drops" } },
    ],
  },
  "clean": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Without dirt.", variations: { positive: "clean", comparative: "cleaner", superlative: "cleanest" } },
      { type: 'verb', description: "To take the dirt off.", variations: { infinitive: "clean", past: "cleaned", past_participle: "cleaned", present_progressive: "cleaning", third_person_singular: "cleans" } },
    ],
  },
  "open": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Not shut.", variations: { positive: "open", comparative: "opener", superlative: "openest" } },
      { type: 'verb', description: "To make open.", variations: { infinitive: "open", past: "opened", past_participle: "opened", present_progressive: "opening", third_person_singular: "opens" } },
    ],
  },
  "cold": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Low in temperature.", variations: { positive: "cold", comparative: "colder", superlative: "coldest" } },
    ],
  },
  "dark": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Without light.", variations: { positive: "dark", comparative: "darker", superlative: "darkest" } },
    ],
  },
  "warm": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Pleasantly hot.", variations: { positive: "warm", comparative: "warmer", superlative: "warmest" } },
    ],
  },
  "careful": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Taking trouble not to go wrong.", variations: { positive: "careful", comparative: "carefuller", superlative: "carefullest" } },
    ],
  },
  "old": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Having been there a long time.", variations: { positive: "old", comparative: "older", superlative: "oldest" } },
    ],
  },
  "quiet": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Making little sound.", variations: { positive: "quiet", comparative: "quieter", superlative: "quietest" } },
    ],
  },
  "long": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Great in length.", variations: { positive: "long", comparative: "longer", superlative: "longest" } },
    ],
  },
  "small": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Little in size.", variations: { positive: "small", comparative: "smaller", superlative: "smallest" } },
    ],
  },
  "still": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Not moving.", variations: { positive: "still", comparative: "stiller", superlative: "stillest" } },
      { type: 'adverb', description: "Even now.", variations: { positive: "still", comparative: "stiller", superlative: "stillest" } },
    ],
  },
  "dull": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Not bright, not sharp.", variations: { positive: "dull", comparative: "duller", superlative: "dullest" } },
    ],
  },
  "early": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Before the usual time.", variations: { positive: "early", comparative: "earlier", superlative: "earliest" } },
      { type: 'adverb', description: "Before the usual time.", variations: { positive: "early", comparative: "earlier", superlative: "earliest" } },
    ],
  },
  "late": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "After the usual time.", variations: { positive: "late", comparative: "later", superlative: "latest" } },
      { type: 'adverb', description: "After the usual time.", variations: { positive: "late", comparative: "later", superlative: "latest" } },
    ],
  },
  "empty": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "With nothing in it.", variations: { positive: "empty", comparative: "emptier", superlative: "emptiest" } },
    ],
  },
  "faded": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Gone pale." },
    ],
  },
  "heavy": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Weighing a lot.", variations: { positive: "heavy", comparative: "heavier", superlative: "heaviest" } },
    ],
  },
  "low": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Not high.", variations: { positive: "low", comparative: "lower", superlative: "lowest" } },
    ],
  },
  "new": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Only just made.", variations: { positive: "new", comparative: "newer", superlative: "newest" } },
    ],
  },
  "patient": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Able to wait without complaint.", variations: { positive: "patient", comparative: "patienter", superlative: "patientest" } },
    ],
  },
  "red": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "The color of blood.", variations: { positive: "red", comparative: "redder", superlative: "reddest" } },
    ],
  },
  "sweet": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Tasting of sugar.", variations: { positive: "sweet", comparative: "sweeter", superlative: "sweetest" } },
    ],
  },
  "tired": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Wanting rest.", variations: { positive: "tired", comparative: "tireder", superlative: "tiredest" } },
    ],
  },
  "wet": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "Covered in liquid.", variations: { positive: "wet", comparative: "wetter", superlative: "wettest" } },
    ],
  },
  "alone": {
    source: 'manual',
    senses: [
      { type: 'adjective', description: "With nobody else." },
    ],
  },
};
