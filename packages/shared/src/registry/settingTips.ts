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
   * Corpus
   * ---------------------------------------------------------------- */
  'corpus.separator': {
    what: 'What is written between one part and the next, so the end of one does not read as the start of the next.',
    examples: [
      'A blank line — the counting treats it as a break, so no word pair is learned across the join. The safe choice.',
      'A line break — treated as a wrap, so the last word of one part pairs with the first of the next.',
      'A break mark — visible in the text as well as being a break.',
    ],
  },
  'corpus.url': {
    what: 'A plain-text address to read. It is stored as an address and fetched every time the flow runs, so a novel never goes into the project file.',
    examples: [
      'A Project Gutenberg `.txt` file — its licence header and footer are trimmed off.',
      'Any address that serves plain text.',
      'Check fetches it once now, so a bad address is found before a run depends on it.',
    ],
    note: 'Use text you have the right to use. The buttons below are public-domain suggestions.',
  },
  'corpus.paste': {
    what: 'Text pasted in and kept with the project, because nothing else has it.',
    examples: ['Your own writing.', 'A transcript.', 'A script you are working from.'],
    note: 'Unlike an address, this is stored in the project file — so keep it to the size you would happily copy around.',
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
  'dictionary.key': {
    what: 'The API token for a service that needs one. It is stored on the server, in `data/settings.json`, which sits outside every project and is gitignored.',
    examples: [
      'Paste it once — it is never shown again, only whether one is stored.',
      'Clear removes it, and the service becomes unpickable again.',
    ],
    note: 'It is never sent back to this page, written into a project or an artifact, or recorded in the API log. It is stored in plain text on this machine, exactly as a .env file would be.',
  },
  'dictionary.minFrequency': {
    what: 'Words rarer than this are not asked about. Frequency runs 0 to 1, where the commonest word in the corpus is 1.',
    examples: [
      '0 — ask about everything.',
      '0.1 — skips the long tail of words seen once or twice, which is often half the database.',
      '0.3 — only the words that actually turn up in what gets written.',
    ],
  },
  'dictionary.morphology': {
    what: 'Which dataset the forms of a word come from. No dictionary API returns inflections, so this is a separate file, downloaded once and then answered from disk.',
    examples: [
      'AGID — 112,000 words, broad: it lists a form wherever its word list had one.',
      'NIH SPECIALIST — 40,000 words, careful: where a word has no genuinely inflected form it says so.',
    ],
    note: 'Neither needs a key. Until one is built, words have no forms — they are left unknown rather than worked out from the spelling, because working them out produced `forgived` and `cactu`.',
  },
  'lexicon.wordType': {
    what: 'What part of speech this word is. It decides which words may follow it, and which forms it has.',
    examples: [
      'Comes from the dictionary when one has answered about this word.',
      '“Not looked up” means exactly that: nothing has been asked, and nothing is being guessed.',
      'Set it yourself to correct one — a wrong type is the commonest cause of odd writing.',
    ],
    note: 'A spelling with several meanings has a row per meaning, each with its own type. Changing one here does not touch the others.',
  },
  'lexicon.variations': {
    what: 'The other spellings this word takes, from the forms dataset. They are what lets the generator write a past tense where a sentence shape asks for one.',
    examples: [
      'A verb has five: infinitive, third person singular, present progressive, past, past participle.',
      'A noun has two: singular and plural.',
      'An adjective or adverb has three: positive, comparative, superlative.',
      'Everything else \u2014 determiners, prepositions, pronouns \u2014 has none.',
    ],
    note: 'Looked up in a dataset, never worked out from the spelling. Empty means either that this kind of word has no other forms, or that the dataset has nothing for it \u2014 the panel says which.',
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

  /* ---------------------------------------------------------------- *
   * Color palette
   * ---------------------------------------------------------------- */
  /* Image source ---------------------------------------------------- */

  'image.upload': {
    what: 'A picture from this machine. It is copied into the project, so the project stays complete when the original is moved or deleted.',
    examples: [
      'PNG for artwork and anything with transparency.',
      'JPEG for a photograph — but note that JPEG has no transparency, so a cutout of one has to be written as a PNG.',
      'SVG works, but has no fixed pixel grid, so anything counting pixels reads whatever size it was drawn at.',
    ],
  },
  'image.link': {
    what: 'The address of an image on the web. The server fetches it once and stores the bytes in the project.',
    examples: [
      'It has to be the address of the picture itself, not of the page it sits on — a page address returns HTML, and the flow says so rather than storing it.',
      'Fetched once, never again: a link that works today is not a link that works next year.',
      'Addresses on this machine or its private network are refused, because the server can reach things your browser cannot.',
    ],
  },
  'image.credit': {
    what: 'Who made the picture and on what terms.',
    examples: [
      'Nothing enforces this; it is the only place the fact can be recorded.',
      'Easiest to fill in now, while it is still easy to find out.',
    ],
  },

  /* Image extraction ------------------------------------------------ */

  'cutout.tolerance': {
    what: 'How different a neighbouring pixel may be from the one you clicked and still count as the same region. Measured in OKLab, times 100.',
    examples: [
      '0 to 5 — flat artwork, where a region really is one color.',
      '10 to 20 — a photograph, where an edge is blended and a surface is not one color.',
      '40 and up — takes in most of the picture; usually a sign a cut line would work better.',
      'Each fill keeps the tolerance it was made with, so this is only the value the next one starts at.',
    ],
  },
  'cutout.region': {
    what: 'A shape you draw round something, which takes everything inside it regardless of what the pixels are.',
    examples: [
      'For a subject no tolerance can separate — a face against a busy background shares its colors with it everywhere.',
      'Finish with a double-click or Enter to keep the inside; right-click to drop it instead.',
      'Smoothed follows a curve through your points; cornered joins them straight, for something with edges.',
    ],
  },
  'cutout.diagonal': {
    what: 'Whether a fill may spread through a corner as well as through an edge.',
    examples: [
      'Off — a one-pixel diagonal gap is a wall. Usually what you want on artwork.',
      'On — closes speckled edges on a photograph, at the cost of leaking through thin diagonal gaps.',
    ],
  },
  'cutout.grow': {
    what: 'Push the edge of the selection out (or pull it in) by this many pixels after the fills have run.',
    examples: [
      '+1 to +2 — takes back the blended halo a fill on a photograph stops short of.',
      '-1 to -2 — trims a fringe of background off a selection that went slightly wide.',
      '0 — flat artwork, where the edge is exactly where the color changes.',
    ],
  },
  'cutout.feather': {
    what: 'Blur the edge of the selection by this many pixels, so the cutout fades out rather than ending.',
    examples: [
      '0 — a hard edge. Right for sprites, cel artwork, and anything going to indexed color.',
      '1 to 3 — enough that a cutout composited over a new background does not look cut out.',
      '8 and up — a soft vignette rather than an edge.',
    ],
  },
  'cutout.minIsland': {
    what: 'Drop included patches smaller than this many pixels.',
    examples: [
      '0 — keep everything, including single-pixel specks.',
      '20 to 100 — clears the speckle a fill picks up on a noisy photograph.',
      'It only removes patches; it never fills holes.',
    ],
  },

  'palette.transparent': {
    what: 'Whether the pixels too transparent to have a color get a palette entry of their own: fully transparent, #00000000.',
    examples: [
      'On — five colors asked for from a cut-out picture gives five colors and the clear around them. A filter snapping to the palette then keeps the background clear.',
      'Off — the palette is only colors. A filter snapping to it has to give transparent pixels one of them, and says so.',
      'A picture with no transparent pixels gets no clear entry either way.',
    ],
    note: 'Which pixels count as transparent is the setting above it: anything under that opacity.',
  },
  'palette.opacity': {
    what: 'How opaque one palette entry is, 0 to 100%. Read out of the image as the opacity of the pixels the entry is named after — a value the picture really holds — and editable like its color.',
    examples: [
      'solid — the ordinary case, and what a color read off flat artwork comes back as.',
      '50% — snapping a pixel to this entry makes it exactly this color at half opacity, which is how you fade one color of a picture.',
      '0% — every pixel that snaps to this entry is erased, which is how you drop one color of a picture.',
    ],
    note: 'Both filter modes count it when judging what matches: a half-faded red is not the solid red entry at a tolerance of 0.',
  },

  /* Palette filter -------------------------------------------------- */

  'paletteFilter.mode': {
    what: 'What the filter does with a pixel once it knows how close that pixel is to the palette.',
    examples: [
      'Keep — a pixel within the tolerance of a palette color stays exactly as it was, color and opacity, and every other pixel becomes fully transparent (0, 0, 0, 0). For finding where a color is used.',
      'Snap — every pixel becomes exactly one palette value, color and opacity, whichever looks nearest. Five colors and a transparent one in play gives a picture with six values in it and no others.',
      'To drop a color rather than find it, keep the others: an inverted answer is the same question asked about the rest of the palette.',
    ],
  },
  'paletteFilter.tolerance': {
    what: 'How close a pixel has to be to a palette color to count as that color, opacity included. Same OKLab scale the palette’s own minimum distance uses.',
    examples: [
      '0 — only pixels that are that exact color at that exact opacity, which is what a drawing made from a palette contains.',
      '15 to 25 — the useful range on artwork: takes in shading without taking in the neighbouring color.',
      'Snap ignores this: every pixel has a nearest, so there is no threshold to set.',
    ],
  },

  /* Polygon decomposition ------------------------------------------- */

  'vectorize.lineWidth': {
    what: 'The widest a stroke can be and still be treated as a drawn line rather than an area.',
    examples: [
      'This is the setting that decides what the picture is. Below it a thin shape is a mark with a middle; above it the same shape is a long thin area with an inside.',
      '2 to 4 — clean line art drawn with a thin pen.',
      '8 and up — a brushy drawing, or a scan where the ink has spread.',
      'There is no right answer in general: it depends how the picture was drawn, so turn it and watch the result.',
    ],
  },
  'vectorize.edgeThreshold': {
    what: 'How much contrast counts as a boundary, in the OKLab-times-100 scale.',
    examples: [
      'This is where the shapes come from. One pass finds every place the picture changes this steeply, and the regions are whatever those boundaries enclose.',
      '8 to 15 — the useful range for drawn artwork. The default is 12.',
      'Lower to catch a faint boundary, at the cost of finding boundaries inside shading.',
      'Higher to ignore shading and gradients, at the cost of merging two shapes that only differ slightly.',
      'The same number also stops the fill crossing a plain step from one pixel to the next, which is what keeps a one-pixel line from being swallowed by the colors either side of it.',
    ],
  },
  'vectorize.edgeFloor': {
    what: 'The weaker threshold. Contrast above this counts as a boundary only where it joins a boundary that cleared the stronger one.',
    examples: [
      'What keeps a real boundary unbroken where it briefly softens, without letting every faint wobble become a boundary of its own.',
      'About half the stronger threshold is the usual advice, and the defaults follow it: 5 against 12.',
      'A gap of one pixel in a boundary is enough for two regions to bleed into one, so lower this before raising the other if shapes are merging.',
    ],
  },
  'pose.chainLength': {
    what: 'How many joints back from the one you are dragging are allowed to move.',
    examples: [
      '2 to 3 — an arm: wrist, elbow, shoulder. Enough to reach without the whole body leaning.',
      '1 — only the bone itself turns, which is forward kinematics with extra steps.',
      '6 and up — a tentacle, where the whole length should curl towards what it is reaching for.',
    ],
  },
  'pose.respectLimits': {
    what: 'Whether the solver obeys each joint’s range of motion.',
    examples: [
      'On — an elbow still only bends one way, and a reach it cannot make honestly falls short.',
      'Off — the rig will reach anything within its length, through poses a body could not hold. Useful for finding out whether the limits or the length is what is stopping you.',
    ],
  },
  'vectorize.refineRounds': {
    what: 'How many rounds of “draw it, see what is wrong, and do that part better”.',
    examples: [
      'Each round rasterises the shapes, measures them against the picture they came from, and grants more anchors to the boundaries running through the parts that came out worst. Everywhere else is left alone, which is what makes it affordable.',
      '0 — one pass and done. Quickest, and usually close.',
      '1 to 2 — the useful range. A round that comes back worse is thrown away, so more rounds never make the drawing worse, only slower.',
      'Painting over a transparent part of the picture counts for sixteen ordinary wrong pixels, so a boundary that has spilled into the empty space is the first thing a round pulls back.',
    ],
  },
  'vectorize.hotspotBlock': {
    what: 'How big a square the error is averaged over when looking for the worst parts.',
    examples: [
      'The measure is an average, so this is really asking how big a mistake has to be before it counts as one.',
      '8 to 16 — notices a single misplaced corner.',
      '32 and up — only notices a whole shape in the wrong place.',
    ],
  },
  'vectorize.hotspotShare': {
    what: 'At most this fraction of the picture’s blocks are worked on in a round.',
    examples: [
      'A block also has to be twice as wrong as the picture’s own average to qualify, so on a drawing that is already good this is almost nowhere however high it is set.',
      '10% to 30% — the useful range.',
      'Higher spends anchors over more of the drawing for less each; lower concentrates them on the one thing that is worst.',
    ],
  },
  'vectorize.minArea': {
    what: 'Regions smaller than this many pixels are dropped as noise.',
    examples: [
      '0 — keep everything, including single-pixel specks.',
      '10 to 50 — clears the speckle along a compressed edge.',
      'Raise it when the shape count is in the thousands.',
    ],
  },
  'vectorize.detail': {
    what: 'How far a traced outline may be moved in order to drop a point.',
    examples: [
      'The main control over how heavy the result is. Every pixel step of a traced outline is an anchor to begin with, which is a hundred times more than any shape needs.',
      '0 — keep every one of them.',
      '1 to 2 — the useful range: follows the drawing without recording its jaggies. The default is 1.8.',
      '4 and up — a loose shape with very few points.',
      'A shape smaller than the tolerance is not flattened away; it keeps enough points to still be a shape.',
    ],
  },
  'vectorize.maxPoints': {
    what: 'The most points any one shape may have.',
    examples: [
      'A budget rather than a tolerance, because “no more than sixteen points” is a thing you can want and a tolerance alone cannot promise it — one fiddly outline will always find a way to spend forty.',
      'A shape over budget is simplified harder until it fits, which loosens the shapes that need loosening and leaves the rest alone.',
      '0 — no limit; the tolerance decides on its own.',
      '12 to 24 — a drawing light enough to pose and animate.',
    ],
  },
  'vectorize.curveThreshold': {
    what: 'How bent a run has to be, relative to its length, before it is called a curve rather than a straight line.',
    examples: [
      'Relative on purpose: a 2px bow across 10px is a curve, and the same bow across 400px is a straight line someone drew by hand.',
      '4% — the default, and about right for drawn artwork.',
      '0% — everything curves. 30% — almost nothing does.',
    ],
  },
  'vectorize.minNodeGap': {
    what: 'The closest two nodes of the drawing may be, in pixels. Nodes closer than this along an outline or a line are merged into one.',
    examples: [
      '0 — nodes stay exactly where tracing put them.',
      '1.5 — the default: tidies the crowds of nodes tracing leaves on tight curves and where regions meet, for a couple of percent more pixels off.',
      '3 to 4 — a much lighter drawing that has lost the fine turns.',
    ],
    note: 'A node is merged in every shape that shares it, so neighbours still meet exactly. A node where three or more outlines meet stays put and the other comes to it.',
  },
  'vectorize.minPolygonArea': {
    what: 'The smallest a polygon may be, in square pixels, once the picture has been cut into shapes.',
    examples: [
      '0 — every polygon is kept, however small.',
      '6 — the default: crumbs a couple of pixels across go.',
      '20 to 50 — a photograph comes out in far fewer shapes. On the test photograph 161 polygons became 78, and the drawing got closer to the picture, because the crumbs were mostly wrong anyway.',
    ],
    note: 'A smaller polygon is folded into the neighbour it shares most of its outline with, taking that neighbour’s color, so it leaves no hole. One touching no other polygon is dropped. The region minimum above works on pixels before tracing; this one on the finished shapes.',
  },
  'vectorize.minLineLength': {
    what: 'The shortest a line may be, end to end, in pixels.',
    examples: [
      '0 — every line is kept.',
      '4 — the default: stubs a few pixels long go.',
      '10 or more — only proper strokes are lines; dashes and dots are drawn as the small areas they are.',
    ],
    note: 'A stroke whose lines are all shorter than this is drawn as an area, so its ink is kept; a short stub off a longer line is dropped. A thin piece of an area only becomes a stroke if the stroke would be at least this long.',
  },
  'vectorize.joinShapes': {
    what: 'Whether shapes of exactly the same color that touch are put back together once the picture has been cut up.',
    examples: [
      'On — polygons that share a side become one polygon, and lines whose ends meet become one line. A cheek is one shape rather than seven triangles.',
      'Off — every area is the convex pieces it was cut into, for a consumer that needs every polygon convex.',
      'A shape with a hole in it stays two polygons even when on: a polygon is one loop of points, and cannot go round a hole.',
    ],
    note: 'Exactly the same color means the same hex. Two shapes a shade apart are two things in the picture.',
  },
  'vectorize.joinGap': {
    what: 'How close the ends of two lines of the same color have to be for them to become one line, in pixels.',
    examples: [
      '0 — only ends that are on the very same point.',
      '3 — the default: takes in the pixel or two that tracing leaves where a line forks.',
      'Where three ends meet, the two that carry on straightest are joined and the third stays a line of its own.',
    ],
  },

  'palette.count': {
    what: 'How many colors the palette has.',
    examples: [
      '3 to 5 — a scheme you could paint a whole shot with.',
      '8 to 12 — enough to describe a photograph.',
      'The image may not have that many far enough apart, and the flow says so rather than padding the palette.',
    ],
  },
  'palette.minDistance': {
    what: 'How far apart two palette colors must look. Anything closer joins the group of the color already chosen instead of becoming an entry of its own.',
    examples: [
      '0 — the raw top counts. A photo of a sky gives you five near-identical blues.',
      '2 — the point at which a person can see a difference at all.',
      '12 — the default. Navy against royal blue is about 20.',
      '35 — only genuinely different colors, so a palette of six needs a busy picture.',
    ],
    note: 'Measured in OKLab, where equal numbers look equally different, times 100 so black to white is about 100. Plain RGB cannot do this: it puts navy/blue and green/mint the same distance apart.',
  },
  'palette.temperature': {
    what: 'How far each entry may wander from its group\u2019s commonest color.',
    examples: [
      '0 — every entry is the exact modal color of its group.',
      '0.5 — halfway towards another color from the same group.',
      '1 — any color from the group, weighted by how often it appears.',
    ],
    note: 'It moves towards another member of the same group and never out of it, so a palette color is always a color the image actually contains.',
  },
  'palette.seed': {
    what: 'Same seed, same palette. Rerolling is an edit you can see rather than a result that changes under you.',
    examples: ['Only does anything above temperature 0 \u2014 at 0 there is nothing to choose.'],
  },
  'palette.precision': {
    what: 'How finely colors are rounded together before they are counted.',
    examples: [
      '5 bits \u2014 32 levels a channel. The default.',
      '8 bits \u2014 no rounding, so a photograph has almost no repeated colors and the mode means nothing.',
      '3 bits \u2014 very coarse, for finding the broad blocks of a painting.',
    ],
    note: 'Without rounding, a photograph of a red wall holds a hundred thousand slightly different reds seen once each. Read the image again for a change here to take effect.',
  },
  'palette.alphaFloor': {
    what: 'Pixels this transparent are not counted.',
    examples: [
      '8 \u2014 the default. Skips a cut-out background.',
      '0 \u2014 counts every pixel, so a transparent PNG\u2019s commonest color is the hole in the middle.',
      '255 \u2014 only fully opaque pixels.',
    ],
  },
  'palette.minShare': {
    what: 'Leaves out a color group that accounts for less than this much of the image.',
    examples: ['0% \u2014 keep everything.', '2% \u2014 drops the odd stray highlight.'],
    note: 'The commonest group is always kept, so the palette is never empty.',
  },
  'palette.edit': {
    what: 'The palette, once the image has been read, is yours to change: set a color to whatever you like, take one out, or add one that is not in the picture at all.',
    examples: [
      'For a brand color, or when the count found something almost right.',
      'Take one out when the palette spent an entry on something you do not want — a background, or a compression artefact.',
      'Add one for a color the drawing will need that the photograph did not have.',
    ],
    note: 'Edits are kept apart from the palette and applied on top of it, so turning a setting or reading the image again re-derives the colors without throwing your work away. Each edit is remembered against the color group it was made for, not the position in the list — so asking for four colors instead of eight never silently moves your edit onto a different color. An edit whose group the settings no longer produce waits rather than being lost.',
  },

  /* ---------------------------------------------------------------- *
   * Skeletal rig
   * ---------------------------------------------------------------- */
  'rig.kind': {
    what: 'What kind of skeleton the character has. The type *is* the structure: how many bones, and how they connect.',
    examples: [
      'Human \u2014 two arms, two legs, a spine of three.',
      'Octopus \u2014 eight arms of five bones, each arm its own chain.',
      'Snake \u2014 a head and fourteen body joints, all one chain.',
    ],
    note: 'Swapping type keeps the limits of any bone that exists in both skeletons, matched by id. A head stays the head you tuned; an arm does not become a foreleg.',
  },
  'rig.angleRange': {
    what: 'How far the joint may turn from its rest pose, in degrees. A hard stop, not a preference.',
    examples: [
      'An elbow: 0\u00b0 to 145\u00b0 \u2014 it bends one way and cannot go the other.',
      'A knee: -140\u00b0 to 0\u00b0 \u2014 the same thing the other way round.',
      'Both ends at 0\u00b0 welds the joint.',
    ],
    note: 'Getting this wrong is what makes a rig look broken. A range that does not include 0 means the character starts the shot already out of bounds.',
  },
  'rig.angleStiffness': {
    what: 'How hard the joint pulls back towards its rest angle. A cost rather than a stop \u2014 the range is the stop.',
    examples: [
      '0.2 \u2014 a shoulder: it goes where it is put.',
      '0.7 \u2014 a chest: it resists.',
      '1 \u2014 it always returns to rest.',
    ],
    note: 'A shoulder and a neck have similar ranges and very different stiffness, and that is most of what makes one character move like a person and another like a puppet.',
  },
  'rig.stretchRange': {
    what: 'How much the bone may change length, as a multiple of its rest length.',
    examples: [
      '\u00d71 to \u00d71 \u2014 rigid bone.',
      '\u00d70.95 to \u00d71.08 \u2014 a limb with a little give.',
      '\u00d70.7 to \u00d71.4 \u2014 cartoon rubber.',
    ],
  },
  'rig.stretchStiffness': {
    what: 'How hard the bone pulls back to its rest length.',
    examples: ['1 \u2014 bone.', '0.4 \u2014 flesh.', '0 \u2014 chewing gum.'],
  },
  'rig.floppiness': {
    what: 'How loose a whole chain of bones is. One number for the lot, because a tentacle is one behaviour rather than eight decisions.',
    examples: [
      '0 \u2014 the chain is welded solid.',
      '0.35 \u2014 a spider\u2019s leg.',
      '0.9 \u2014 an octopus arm.',
    ],
    note: 'Any single joint in the chain can still be given its own angles, and told to follow the chain again afterwards.',
  },
  'rig.taper': {
    what: 'How much of the chain\u2019s floppiness the base gives up. The tip always keeps all of it.',
    examples: [
      '0 \u2014 every joint in the chain is equally floppy.',
      '0.5 \u2014 the base moves half as far as the tip.',
      '1 \u2014 the base does not move at all.',
    ],
    note: 'This is what makes a tentacle read as a tentacle rather than a hinge: a real arm is anchored at the body and loose at the end.',
  },
  'rig.span': {
    what: 'How far a fully floppy joint in this chain may turn, either way.',
    examples: ['\u00b120\u00b0 \u2014 a segmented abdomen.', '\u00b155\u00b0 \u2014 an octopus arm that can curl.'],
    note: 'Floppiness scales this. A span of \u00b155\u00b0 at floppiness 0.5 gives \u00b127.5\u00b0.',
  },
  'rig.squashAndStretch': {
    what: 'Multiplies every bone\u2019s length range at once, so a whole character can be made rubbery without touching each bone.',
    examples: ['\u00d71 \u2014 whatever the character type says.', '\u00d70 \u2014 nothing stretches at all.', '\u00d73 \u2014 broad cartoon.'],
  },
  'rig.looseness': {
    what: 'Multiplies every angle range at once.',
    examples: ['\u00d71 \u2014 the type\u2019s own limits.', '\u00d70.5 \u2014 a tighter, more controlled character.'],
    note: 'It scales the range without changing which way a joint bends, so an elbow at any looseness still only bends one way.',
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
