/**
 * What every setting in the studio means, and what a value of it looks like.
 *
 * The (i) beside a setting reads its text from here rather than from the editor
 * that draws the control, for two reasons: the same setting shown in two places
 * says the same thing, and the explanations can be read, reviewed and corrected
 * as one body of text instead of being scattered through the UI. A short hint
 * still sits under a control for the thing you need at a glance; the tip is for
 * the thing you need once.
 */
export interface SettingTip {
  /** What the setting does, in a sentence or two. */
  what: string;
  /**
   * Concrete values and what each one gives you. Written as `value — result`,
   * so the tip reads as a small table.
   */
  examples: string[];
  /** Anything worth knowing that is not about a particular value. */
  note?: string;
}

export const SETTING_TIPS: Record<string, SettingTip> = {
  /* ---------------------------------------------------------------- *
   * Random text — what the run does
   * ---------------------------------------------------------------- */
  'text.mode': {
    what: 'Whether the run writes new text from the word database, or rewrites the text coming in.',
    examples: [
      'Generate — ignores the input and writes from nothing but the database.',
      'Alter — keeps the shape of the input and swaps words out of it.',
    ],
    note: 'Alter with nothing wired in and nothing typed has nothing to work on, so it writes instead.',
  },
  'text.seed': {
    what: 'The starting point for the run’s randomness. The same seed with the same settings always writes exactly the same text.',
    examples: [
      '`take-1` — one result you can come back to.',
      'Change a character — a different result from the same settings.',
      'Same seed, one setting moved — shows what that setting did, and nothing else.',
    ],
  },
  'text.input': {
    what: 'The text this flow works from. In alter mode it is what gets rewritten; in generate mode it is ignored.',
    examples: [
      'Empty — generate mode writes from the database alone.',
      'A paragraph — alter mode rewrites it in place.',
    ],
    note: 'Text wired in from another flow wins over what is typed here; the typed text is kept for when nothing is connected.',
  },

  /* ---------------------------------------------------------------- *
   * Random text — length
   * ---------------------------------------------------------------- */
  'text.length.mode': {
    what: 'How the length of the result is asked for: an exact size, a change against the input, or no target at all.',
    examples: [
      'Keep — as long as the input. In generate mode, about eighty words.',
      'Words / Characters — an exact target.',
      'Change in words / characters — a percentage of what came in.',
    ],
  },
  'text.length.words': {
    what: 'How many words the result should come to.',
    examples: ['40 — a short paragraph.', '120 — a page of dialog.', '600 — a scene.'],
    note: 'Punctuation is not counted as a word, so `40 words` is forty words plus its full stops and commas.',
  },
  'text.length.characters': {
    what: 'How many characters the result should come to, spaces and punctuation included.',
    examples: [
      '280 — a caption.',
      '1,200 — a few paragraphs.',
      'A word is about five characters, so 1,200 is roughly 200 words.',
    ],
  },
  'text.length.wordPercent': {
    what: 'How much longer or shorter than the input the result should be, counted in words.',
    examples: ['+0% — the same length.', '+50% — half again as long.', '-30% — a third shorter.'],
  },
  'text.length.charPercent': {
    what: 'The same as change in words, counted in characters — useful when what matters is how much space the text takes.',
    examples: ['+0% — the same size.', '-20% — trims it to fit.'],
  },
  'text.length.temperature': {
    what: 'How far off the target a run is allowed to land, so a sentence can finish instead of being cut mid-phrase.',
    examples: [
      '0 — hits the target exactly, even if that means stopping mid-sentence.',
      '0.25 — lands within a few words of it. A good default.',
      '1 — treats the target as a suggestion.',
    ],
  },

  /* ---------------------------------------------------------------- *
   * Random text — how words are picked
   * ---------------------------------------------------------------- */
  'text.alterTemperature': {
    what: 'The share of the incoming words this run may replace. Only used when altering.',
    examples: [
      '0 — nothing is replaced; the text comes back as it went in.',
      '0.35 — about one word in three is swapped for something the database thinks fits.',
      '1 — every word is fair game, and little of the original survives.',
    ],
  },
  'text.pickTemperature': {
    what: 'How much the run is willing to take a less likely word. It sharpens or flattens the scores before one is drawn.',
    examples: [
      '0.02 — always takes the strongest candidate, so a seed writes the same phrase over and over.',
      '0.45 — favours the strong ones but strays. A good default.',
      '1 — draws straight from the scores, so an unusual word turns up as often as it scores.',
    ],
  },
  'text.contextWindow': {
    what: 'How many of the words just written are allowed to pull on the next one.',
    examples: [
      '0 tokens — nothing pulls; every word is drawn on frequency alone.',
      '3 tokens — the last three words all have a say. A good default.',
      '8 tokens — a long memory, which keeps a subject going but can lock into a loop.',
    ],
  },
  'text.contextDecay': {
    what: 'How fast a word’s pull fades as it gets further back in the window.',
    examples: [
      '0 — every word in the window pulls equally hard.',
      '0.55 — the word just written matters about twice as much as the one before it.',
      '0.95 — only the last word really counts, whatever the window is set to.',
    ],
  },
  'text.frequencyBias': {
    what: 'The balance between how common a word is and what the words before it pull towards.',
    examples: [
      '0 — context decides everything, so a rare word wins if it fits.',
      '0.45 — both matter. A good default.',
      '1 — nothing but frequency, so the result is the commonest words in English.',
    ],
  },
  'text.contextSymmetry': {
    what: 'How much a link counts when it is only recorded the other way round — `tree` listing `apple` pulling apple → tree.',
    examples: [
      '0 — only links pointing forwards are read.',
      '0.5 — a backwards link counts half. A good default.',
      '1 — direction is ignored entirely, which finds more links but blurs word order.',
    ],
  },
  'text.grammarBias': {
    what: 'How strictly the built-in table of which word type may follow which is obeyed.',
    examples: [
      '0 — word soup: a preposition can follow a determiner.',
      '0.85 — word order is mostly respected. A good default.',
      '1 — a combination the table forbids is never written.',
    ],
    note: 'This is the small built-in table. A grammar database wired in is a separate, much richer control.',
  },
  'text.grammarWeight': {
    what: 'How hard a wired-in grammar database drives the writing: it supplies whole sentence shapes to write into, and scores each word on how well it continues what has just been written.',
    examples: [
      '0 — the grammar database is ignored, even when one is connected.',
      '0.7 — sentences follow shapes the corpus used, and words are inflected to fit. A good default.',
      '1 — a word of the wrong type for the slot is all but never written.',
    ],
    note: 'Does nothing unless a Grammar Database flow is wired into the Grammar database input.',
  },
  'text.sentenceLength': {
    what: 'The length at which punctuation starts wanting to end the sentence. It is a pull, not a rule.',
    examples: [
      '6 words — clipped, and a lot of full stops.',
      '12 words — ordinary prose. A good default.',
      '30 words — long, winding sentences.',
    ],
  },

  /* ---------------------------------------------------------------- *
   * Word database — counting
   * ---------------------------------------------------------------- */
  'lexicon.maxWords': {
    what: 'How many of a corpus’s words to keep, commonest first. The rest are counted and thrown away.',
    examples: [
      '500 — the words a short scene needs.',
      '2,000 — a novel’s working vocabulary. A good default.',
      '20,000 — nearly everything, which makes a large file and a slow editor.',
    ],
    note: 'A corpus keeps the counts it was pruned to, so changing this affects the next corpus you add, not the ones already counted.',
  },
  'lexicon.maxLinksPerWord': {
    what: 'How many following words to remember for each word, commonest first. These are what become its weighted contexts.',
    examples: [
      '8 — a lean database that writes predictably.',
      '24 — enough variety to surprise you. A good default.',
      '100 — every link worth keeping, at the cost of size.',
    ],
  },
  'lexicon.minPairCount': {
    what: 'How many times one word has to follow another in the corpus before that pairing is remembered at all.',
    examples: [
      '1 — keeps every pairing, including the ones that happened once by accident.',
      '2 — a pairing has to repeat. A good default for a book.',
      '5 — only well-worn pairings, which is the right floor for a very large corpus.',
    ],
  },
  'lexicon.includePunctuation': {
    what: 'Whether marks are counted as tokens of their own, so the database learns where a full stop or a comma goes.',
    examples: [
      'On — `.` and `,` are words with their own frequencies and contexts.',
      'Off — marks are dropped, and the chain runs straight through where they were.',
    ],
  },

  /* ---------------------------------------------------------------- *
   * Word database — weighting
   * ---------------------------------------------------------------- */
  'lexicon.liftCeiling': {
    what: 'How much more often one word must follow another than it appears anywhere at all before the link counts as full strength.',
    examples: [
      '4 — links reach full strength easily, so many words pull hard.',
      '12 — a link has to be genuinely distinctive. A good default.',
      '50 — only the strongest pairings, like `once → upon`, come out near 1.',
    ],
    note: 'Measured as lift: how much likelier `B` is after `A` than `B` is in general. That is why a very common word rarely makes a strong link.',
  },
  'lexicon.minWeight': {
    what: 'The weakest link worth keeping. A context below this is dropped rather than stored at almost no strength.',
    examples: [
      '0 — keep every link, however faint.',
      '0.05 — drops the noise. A good default.',
      '0.4 — only strong associations survive, which makes for terse, repetitive writing.',
    ],
  },
  'lexicon.maxContexts': {
    what: 'How many weighted contexts each word is allowed to carry into the database, strongest first.',
    examples: ['6 — tight and predictable.', '16 — a good default.', '60 — as much nuance as the corpus offers.'],
  },
  'lexicon.corpusUrl': {
    what: 'A plain-text address to read a corpus from. The text is counted, not stored as a copy.',
    examples: [
      'A Project Gutenberg `.txt` file — its licence header and footer are trimmed off.',
      'A raw file from any site that serves plain text.',
    ],
    note: 'Use text you have the right to use. The buttons below are public-domain suggestions.',
  },
  'lexicon.pasteText': {
    what: 'Text pasted in and counted as a corpus of its own, kept with the project rather than fetched.',
    examples: ['Your own writing.', 'A transcript.', 'A script you are working from.'],
  },
  'lexicon.provider': {
    what: 'Which dictionary service is asked for word types and definitions. Every service answers in its own shape, so this picks the address and the code that reads the reply.',
    examples: [
      'Free Dictionary API — no key, but throttles hard on a long run.',
      'Datamuse — no key, and the most tolerant of a few thousand words in a row.',
      'Wiktionary — no key, steady, with the broadest part-of-speech labels.',
      'Merriam-Webster or Wordnik — a free key, better definitions, a daily cap.',
    ],
    note: 'A key is read from VIBETOON_DICTIONARY_KEY on the server and is never written to a project or sent to this page. Open Logs to see what a service actually answered.',
  },
  'lexicon.wordType': {
    what: 'What part of speech this word is. It decides which words may follow it, and which variations it has.',
    examples: [
      'Comes from the dictionary when one has answered about this word.',
      'Set it yourself to correct a guess — a wrong type is the commonest cause of odd writing.',
    ],
  },
  'lexicon.description': {
    what: 'What the word means. It is for you, not for the generator: nothing in the writing reads it.',
    examples: ['Filled in from the dictionary.', 'Yours to correct or replace.'],
  },

  /* ---------------------------------------------------------------- *
   * Grammar database
   * ---------------------------------------------------------------- */
  'grammar.maxSentenceSlots': {
    what: 'The longest sentence kept as a shape. A longer one is still read and counted, but its shape is not stored.',
    examples: [
      '12 — short shapes only, which write clipped prose.',
      '24 — ordinary sentences. A good default.',
      '60 — keeps long sentences too, at the cost of a much bigger database.',
    ],
  },
  'grammar.phraseMin': {
    what: 'The shortest run of words kept as a phrase. Phrases are what the generator uses to judge whether one word follows another naturally.',
    examples: ['2 — pairs, the most useful. A good default.', '3 — skips pairs, which loses most of the signal.'],
  },
  'grammar.phraseMax': {
    what: 'The longest run kept as a phrase. A longer run is a stronger signal when it matches, but matches less often.',
    examples: [
      '3 — quick and small.',
      '5 — a good default.',
      '8 — very specific shapes that only a large corpus will repeat.',
    ],
  },
  'grammar.maxPatterns': {
    what: 'How many shapes of each kind — sentences, fragments, phrases — to keep, commonest first.',
    examples: ['200 — a small database.', '600 — a good default.', '5,000 — everything a book offers.'],
  },
  'grammar.minCount': {
    what: 'How often a shape has to turn up before it is kept.',
    examples: [
      '1 — keeps one-offs, which is right for a short corpus.',
      '2 — a shape has to repeat. A good default.',
      '5 — only well-worn shapes, for a book-sized corpus.',
    ],
    note: 'Whole sentence shapes are kept even when seen once: a sentence repeating at all is already meaningful.',
  },
  'grammar.useForms': {
    what: 'Whether a shape records which form a word was in, or only its type.',
    examples: [
      'On — `verb:past` and `noun:plural`, so the generator writes `walked` where the corpus did. A good default.',
      'Off — just `verb` and `noun`, which matches far more often but says nothing about tense or number.',
    ],
  },
  'grammar.corpusUrl': {
    what: 'A plain-text address to read for its sentence shapes. The same addresses the word database reads.',
    examples: ['A Project Gutenberg `.txt` file.', 'Any address that serves plain text.'],
    note: 'Read the same corpus into both flows and the word types will line up, which is what makes the shapes accurate.',
  },

  /* ---------------------------------------------------------------- *
   * Connections
   * ---------------------------------------------------------------- */
  'connection.enabled': {
    what: 'Whether this wire is used. A disabled wire stays on the graph but carries nothing.',
    examples: [
      'On — the input is read, and the flow goes stale when it changes.',
      'Off — the downstream flow behaves as though the wire were not there.',
    ],
  },
  'connection.mode': {
    what: 'How firmly the input is taken.',
    examples: [
      'Apply — the rules are obeyed, and the settings they name are overridden.',
      'Suggest — the rules are offered, and you accept them flow by flow.',
      'Reference — the content is read, but the rules change nothing on their own.',
    ],
  },
  'connection.weight': {
    what: 'How hard this input should push the result when several wires disagree.',
    examples: ['0.25 — a light touch.', '1.00 — full strength. A good default.', '0 — read, but never decisive.'],
  },
  'connection.rules': {
    what: 'Plain-text instructions this wire carries, one per line. A rule a downstream flow understands changes its settings; anything else is passed on as guidance.',
    examples: [
      '`length: +20%` — makes the result a fifth longer.',
      '`alter: 0.3` — replaces about a third of the words.',
      '`context window: 3` — three words of memory.',
      '`keep the workshop quiet` — no flow parses it, so it travels as a note.',
    ],
  },
  'connection.notes': {
    what: 'Why this wire exists. Travels with the rules, and is for whoever opens the project next.',
    examples: ['“Dialog drives the panel count.”', '“Only here so the storyboard goes stale when the script does.”'],
  },

  /* ---------------------------------------------------------------- *
   * Project and flows
   * ---------------------------------------------------------------- */
  'project.name': {
    what: 'What the project is called. Used in the picker and in generated reports.',
    examples: ['“Lamp and gear”', '“Pilot — cold open”'],
  },
  'project.styleNote': {
    what: 'A line of direction prepended to every flow’s guidance when it generates, so the whole clip pulls one way.',
    examples: ['“Dry, plain, no adverbs.”', '“Hand-drawn, heavy line, muted palette.”'],
  },
  'project.fps': {
    what: 'Frames per second for the animatic and every video output.',
    examples: ['12 — on twos, the classic hand-drawn feel.', '24 — film. A good default.', '30 — video.'],
  },
  'project.width': {
    what: 'Output width in pixels. Sketches and panels are drawn to this frame.',
    examples: ['1280 — light on a laptop. A good default.', '1920 — full HD.', '1080 — square, for social.'],
  },
  'project.height': {
    what: 'Output height in pixels.',
    examples: ['720 — with 1280, sixteen by nine.', '1080 — with 1920, full HD.'],
  },
  'project.shotSeconds': {
    what: 'How long a shot runs when the beat or panel it came from gives no duration of its own.',
    examples: ['1.5s — quick cutting.', '2.5s — a good default.', '5s — slow and held.'],
  },
  'node.name': {
    what: 'What this flow is called, on the graph and in every report that mentions it.',
    examples: ['“Cold open dialog”', '“Mabz — design”'],
  },
  'node.notes': {
    what: 'Notes read by this flow’s generator as guidance, and shown on the node itself.',
    examples: ['“Keep it under thirty seconds.”', '“She never finishes a sentence.”'],
  },

  /* ---------------------------------------------------------------- *
   * Animatic
   * ---------------------------------------------------------------- */
  'animatic.targetSeconds': {
    what: 'How long the whole cut should run. Leave it empty for no target.',
    examples: ['`90s`, `1m30` and `1:30` all mean the same thing.', 'Empty — the cut runs as long as its shots do.'],
    note: '“Fit to target” scales every shot at once so the cut lands on it.',
  },
  'animatic.pacing': {
    what: 'Where the cut should breathe and where it should cut hard. Written into the cut list for whoever works from it.',
    examples: ['“Hold on the lamp, then cut fast through the workshop.”'],
  },
  'animatic.shotHold': {
    what: 'How long each shot is held. A shot follows the storyboard until you change its hold here, and then it keeps your number.',
    examples: [
      '0.5s — a flash.',
      '2s — long enough to read a line of dialog.',
      '↺ on a shot puts that one back to what the board asked for; Reset timing puts all of them back.',
    ],
    note: 'Rules on the incoming wire can clamp every shot to a shortest and longest hold.',
  },
};

/** The tip for a setting, or nothing when none has been written yet. */
export function settingTip(key: string): SettingTip | undefined {
  return SETTING_TIPS[key];
}

/** Every key that has a tip, for a test that checks nothing is referenced by mistake. */
export function settingTipKeys(): string[] {
  return Object.keys(SETTING_TIPS);
}
