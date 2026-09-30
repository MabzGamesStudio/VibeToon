import type { AlgorithmGuide } from '../guides';

export const CORPUS_GUIDE: AlgorithmGuide = {
  kinds: ['text.corpus'],
  title: 'Gathering text into one body',
  summary:
    'A corpus is the text the word and grammar databases read. It is a list of parts: text you pasted, the built-in sample, or an address fetched each time the flow runs, plus any text wired in. A run reads the included parts in order, trims each, and joins them with the separator. A part that cannot be read is noted on the part and skipped, so one dead link does not lose the rest.',
  steps: [
    { kind: 'input', title: 'Parts, in order', detail: 'Pasted, built in, or an address; and text on the Text input.' },
    {
      kind: 'loop',
      title: 'For each included part',
      steps: [
        { kind: 'decision', title: 'Does it carry its own text?', detail: 'Pasted and built-in parts do.', no: 'Fetch the address (http/https only, no private hosts), up to 8 MB.' },
        { kind: 'decision', title: 'Was it read?', no: 'Record the error on the part, warn, and go on to the next.' },
        { kind: 'step', title: 'Note its size on the part', detail: 'So the editor can show a size without fetching again.' },
      ],
    },
    { kind: 'step', title: 'Add text from wires', detail: 'Read fresh on every run, never stored.' },
    { kind: 'step', title: 'Trim each piece, drop empty ones, join with the separator' },
    { kind: 'output', title: 'corpus.txt and report.md' },
  ],
  pseudocode: `pieces = []
for part in included_parts(data):          # in the order they are listed
    if part.kind in (pasted, builtin):
        text = part.text
    else:
        try:  text = fetch(guarded(part.url), limit=8 MB)
        except error:
            part.last_error = error; continue
    part.last_bytes = len(text)
    pieces.append(text)

for wire into the Text port:
    pieces.append(read(wire))                # fresh every run

corpus = separator.join(p.strip() for p in pieces if p.strip())`,
  sections: [
    {
      heading: 'Why a corpus is its own flow',
      body: 'The word database and the grammar database both read text. When each kept its own copy, the two could read different books, and then their word types would not line up. One corpus wired into both means they read the same words.',
    },
    {
      heading: 'Addresses are fetched, not stored',
      body: 'A novel is a megabyte, and a project is a folder you copy around. So a part with an address keeps only the address, and the text is fetched when the flow runs. Only the size and the last error are remembered.\n\nThe fetch refuses anything but http and https, and refuses localhost and private network ranges. A very large file is cut off and a warning says so.',
    },
    {
      heading: 'What the separator is for',
      body: 'Parts are joined with a blank line by default. Without it, the last sentence of one book and the first of the next would run together. The word counter would then count a pair of words that never stood side by side.',
    },
  ],
  settings: [
    { name: 'Included / order', effect: 'Only ticked parts are written, in the order shown.' },
    { name: 'Separator', effect: 'Written between parts. A blank line ends a paragraph, so the counters do not link across parts.' },
  ],
  cost: 'One fetch per address part per run; joining is linear in the text size.',
  resources: [
    { title: 'Project Gutenberg', url: 'https://www.gutenberg.org/', note: 'Free public-domain books, a good source of corpus text.' },
    { title: 'Text corpus (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Text_corpus', note: 'What a corpus is and how it is used in language work.' },
  ],
  source: ['packages/shared/src/flows/corpusFlow.ts', 'packages/server/src/generators/corpus.ts', 'packages/server/src/text/corpusFetch.ts'],
};

export const LEXICON_GUIDE: AlgorithmGuide = {
  kinds: ['text.lexicon'],
  title: 'Counting words, and the company they keep',
  summary:
    'The word database reads a corpus and counts two things for every word: how often it appears, and which words turn up near it. Datasets are kept as raw counts, so adding or removing a book is exact addition or subtraction. When the master database is built, frequency becomes a log scale from 0 to 1. Each word’s contexts are weighted by lift: how much more often a word keeps this one company than it turns up at all. That is what stops "the" being the strongest context of every word.',
  steps: [
    { kind: 'input', title: 'A corpus', detail: 'Pasted, fetched, the sample, or wired in.' },
    { kind: 'step', title: 'Split into tokens', detail: 'Words, numbers, punctuation marks and line breaks.' },
    {
      kind: 'loop',
      title: 'For each token',
      steps: [
        { kind: 'step', title: 'count[token] += 1' },
        { kind: 'decision', title: 'Same paragraph as the token before?', no: 'A blank line breaks the chain: no pair is counted.' },
        { kind: 'step', title: 'pairs[previous][token] += 1' },
      ],
    },
    { kind: 'step', title: 'Keep the most common words', detail: 'Up to Max words; links below Min pair count are dropped.' },
    {
      kind: 'loop',
      title: 'For each kept word, each other word nearby',
      steps: [
        { kind: 'step', title: 'Chance = distance chance × rarity', detail: 'Next to it 0.9, same sentence 0.25, same paragraph 0.05; very common words are taken less.' },
        { kind: 'decision', title: 'Does the seeded roll pass?', no: 'Not taken this time.' },
        { kind: 'step', title: 'Take it into the word’s context slots', detail: 'Already there: weight + 1. A free slot: weight 1. All full: may push out the weakest.' },
      ],
    },
    { kind: 'step', title: 'Master = sum of the ticked datasets’ counts' },
    { kind: 'step', title: 'Frequency = log(1 + count) / log(1 + max count)' },
    { kind: 'step', title: 'Context weight = log(lift) / log(lift ceiling)', detail: 'lift = share of the word’s company ÷ share of the corpus. Only lift > 1 is kept.' },
    { kind: 'step', title: 'One entry per sense, then one per form', detail: 'From the dictionary’s answers and the morphology dataset.' },
    { kind: 'output', title: 'lexicon.json' },
  ],
  pseudocode: `# counting (once per corpus)
for token in tokenize(text):
    if token is a blank line: previous = None; continue
    count[token] += 1
    if previous: pairs[previous][token] += 1
    previous = token
kept = top(count, max_words)

rng = seeded(corpus name)
for each occurrence of a kept word w at position i:
    for other word o within reach, same paragraph:
        chance = {adjacent: 0.9, sentence: 0.25, paragraph: 0.05}[distance]
        chance *= min(1, common_share / share(o))        # "the" rarely taken
        if rng() < chance: take(slots[w], o)

take(slots, o):
    if o in slots:            slots[o] += 1
    elif free slot:           slots[o] = 1
    else:
        weakest = min(slots)
        if rng() < 1 / (1 + slots[weakest]):  replace weakest with o
    if total weight >= capacity * grow_at: capacity *= 2   (max 128)

# deriving (every time the master changes)
master = sum(counts of ticked datasets)
frequency(w) = log(1 + count[w]) / log(1 + max_count)
for o in slots[w]:
    lift = (slots[w][o] / sum(slots[w])) / (count[o] / total)
    if lift > 1:
        weight = min(1, log(lift) / log(lift_ceiling))
        if weight >= min_weight: contexts[w].append(o, weight)`,
  sections: [
    {
      heading: 'Counts, never weights',
      body: 'A dataset stores raw counts. That makes the set algebra exact. Two datasets combine by adding counts and come apart by subtracting them, so `subtract(combine(a, b), b)` gives back `a` exactly. Unticking a book is a subtraction, and nothing is lost by it.\n\nEvery derived number (frequency, context weight) is recomputed from whatever counts are left.',
    },
    {
      heading: 'Why frequency is a log',
      body: 'Word counts follow Zipf’s law: the commonest word is about twice as common as the second, three times the third, and so on. A raw share would put almost every word near zero. `log(1+count) / log(1+max)` puts the commonest word at 1 and keeps the long tail usable.',
    },
    {
      heading: 'Contexts are sampled, not all counted',
      body: 'Counting every pair of words in the same paragraph would give each word thousands of contexts, mostly noise. Instead each nearby word gets a chance of being taken, and the chance falls with distance and with how common the word is. A word right beside another is almost always taken. One elsewhere in the paragraph is taken one time in twenty.\n\nEach word starts with 16 slots. When all are full, a new context may push out the weakest, and the lighter the weakest is, the likelier. Strong contexts therefore survive and one-off ones get replaced. Once the slots are heavily used, they double, so a word the corpus uses a lot has room for more company.\n\nThe random rolls are seeded from the corpus, so counting the same text again gives the same contexts.',
    },
    {
      heading: 'Lift: why "the" is not everyone’s context',
      body: 'If a word is 5% of the corpus and 5% of what sits near "kitchen", it tells you nothing about kitchens. Lift divides the share of a word’s company by the share of the corpus:\n\n- lift 1 means no more often than chance, and the context is dropped;\n- lift 12 (the ceiling) or more means full weight, 1.0;\n- between the two, the weight grows on a log scale.\n\nThis is pointwise mutual information, rescaled to 0..1.',
    },
    {
      heading: 'Senses and forms',
      body: 'Counting cannot tell `light` the noun from `light` the verb. When a dictionary has answered, each sense becomes its own entry with the same counts. Each sense is also given the words of its own definition as extra contexts, so `bank` the river’s edge keeps company with `river` and `bank` the lender with `money`.\n\nThen every form of each word (`cats`, `walked`) gets a row too. A form the corpus never saw has a count of 0.',
    },
  ],
  settings: [
    { name: 'Max words', effect: 'How many distinct tokens are kept, commonest first.' },
    { name: 'Links per word / Min pair count', effect: 'How many following words are kept per word, and how often a pair must appear to count.' },
    { name: 'Adjacent / sentence / paragraph chance', effect: 'How likely a word at each distance is to be taken as a context.' },
    { name: 'Context slots / grow at', effect: 'Starting room for contexts, and how full the slots must be before they double.' },
    { name: 'Lift ceiling', effect: 'The lift that counts as full strength. Lower it and more contexts reach weight 1.' },
    { name: 'Min weight', effect: 'Contexts weaker than this after weighting are dropped.' },
  ],
  cost: 'Linear in the corpus length for counting; about 50 nearby words are rolled per word occurrence. A novel takes a second or two.',
  resources: [
    { title: 'Pointwise mutual information (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Pointwise_mutual_information', note: 'Lift is the ratio inside PMI; the log of it is PMI.' },
    { title: 'Zipf’s law (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Zipf%27s_law', note: 'Why word frequency needs a log scale.' },
    { title: 'Distributional semantics (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Distributional_semantics', note: '"You shall know a word by the company it keeps": the idea behind contexts.' },
    { title: 'Space-Saving / heavy hitters', url: 'https://en.wikipedia.org/wiki/Streaming_algorithm#Frequent_elements', note: 'The slot scheme is a relative of these fixed-memory frequent-item counters.' },
  ],
  source: ['packages/shared/src/text/corpus.ts', 'packages/shared/src/flows/lexicon.ts', 'packages/shared/src/text/senses.ts', 'packages/shared/src/text/tokenize.ts'],
  tryIt: 'Click a word in the database table to see its contexts and their weights.',
};

export const DICTIONARY_GUIDE: AlgorithmGuide = {
  kinds: ['text.dictionary'],
  title: 'Asking a dictionary, and applying the answers',
  summary:
    'Counting text tells you how common a word is, but not what kind of word it is. This flow fills that gap. In the editor, it asks a dictionary service about each word, commonest first, in batches with retries and a disk cache. Generating then applies the answers: each sense becomes its own entry, and each word’s forms come from a morphology dataset rather than rules. A word nobody answered for is left exactly as it came in.',
  steps: [
    { kind: 'input', title: 'A word database' },
    { kind: 'step', title: 'Words to ask about', detail: 'Not forms, not marks or numbers, at least Min frequency, not already answered (unless Refresh). Commonest first.' },
    {
      kind: 'loop',
      title: 'Lookup (in the editor), a batch of 200 at a time',
      steps: [
        { kind: 'decision', title: 'On disk already?', no: 'Ask the service: 4 at a time, 120 ms apart, 8 s timeout.' },
        { kind: 'decision', title: 'Did it answer?', detail: 'A 404 is an answer: "not a word it knows".', no: 'Retry after 0.5 s, 1.5 s, 4 s (or as long as Retry-After says). After 3 words fail outright, stop the batch.' },
        { kind: 'step', title: 'Cache the senses; look up the forms in the morphology dataset' },
      ],
    },
    {
      kind: 'loop',
      title: 'Generate: for each spelling in the database',
      steps: [
        { kind: 'decision', title: 'Was anything learned about it?', no: 'Keep every row exactly as it came in.' },
        { kind: 'step', title: 'Match each sense to a row of the same type', detail: 'The first sense takes the first row, so context links keep pointing at it.' },
        { kind: 'step', title: 'A sense with no row gets a new entry', detail: 'Split senses on: light (noun), light (verb), light (adjective).' },
        { kind: 'step', title: 'Set type, description and forms from the sense' },
      ],
    },
    { kind: 'step', title: 'Drop form rows whose word changed type', detail: 'Unless the corpus counted them: then they are words in their own right.' },
    { kind: 'step', title: 'Add a row for every form', detail: 'If Add variants is on.' },
    { kind: 'output', title: 'The improved word database' },
  ],
  pseudocode: `# lookup (editor, resumable)
queue = [w for w in database by frequency desc
         if not form and lookup_candidate(w) and freq >= min
         and (refresh or w not in answers)]
for batch of 200 in queue:
    for w in batch (4 workers, 120 ms pause):
        if cached(w): answer = cache[w]; continue
        for delay in [0, 500, 1500, 4000]:          # or Retry-After
            response = get(provider_url(w))          # key never logged
            if ok or 404: cache[w] = senses(response); break
            wait(delay)
        else: failures += 1
        if failures >= 3: stop batch, report what is left

# generate (instant, repeatable)
for spelling, rows in group_by_spelling(database):
    senses = answers[spelling] (first only unless split_senses)
    if not senses: keep rows; continue
    for i, sense in enumerate(senses):
        row = row with type == sense.type
              or (i == 0 and first unclaimed row)
              or new row(id = allocate(spelling, sense.type))
        row.type, row.description = sense.type, sense.description
        row.forms = morphology[spelling][sense.type]
drop derived forms whose root changed type (unless counted)
if add_variants: add a row per form`,
  sections: [
    {
      heading: 'Why looking up and generating are separate',
      body: 'Asking a service about thousands of words is slow, rate-limited and sometimes refused. So the asking happens in the editor, with a progress bar and a Stop button, and everything learned is cached on disk. Generating only applies what is known, so it is instant and repeatable. A lookup stopped halfway is still worth generating.',
    },
    {
      heading: 'A spelling is not a word',
      body: '`light` is a noun, a verb and an adjective, and means something different as each. If one row held only the first sense, a grammar flow would put `light` where only a noun fits. With Split senses on, every sense the dictionary reports becomes its own entry.\n\nThe first sense keeps the plain id. That matters, because context links counted from the corpus point at the plain id and know nothing about senses.',
    },
    {
      heading: 'Forms come from data, not rules',
      body: 'No dictionary service returns inflections, and working them out by rule was wrong too often (`forgive` → `forgived`, `cactus` → `cactu`). So forms come from a morphology dataset. It is downloaded once, indexed, and answers from disk. Switching datasets re-indexes but does not re-ask the dictionary.\n\nWhen a word changes type, its forms change too. `walks` is a plural while `walk` is a noun, but the third person singular once `walk` is a verb.',
    },
    {
      heading: 'Being polite to the service',
      body: 'A batch sends at most 200 requests, 4 at a time with a short pause. A refused request is retried with growing waits, and if the service sends Retry-After, that wait is used instead. After three words fail outright, the batch stops rather than firing hundreds of requests that will fail too.\n\nAPI keys are stored only on the server, never sent to the browser, and masked in the log.',
    },
  ],
  settings: [
    { name: 'Provider', effect: 'Which dictionary service is asked. One that needs a key it does not have cannot be picked.' },
    { name: 'Morphology dataset', effect: 'Where word forms come from.' },
    { name: 'Min frequency', effect: 'Skip rare words, so a long tail does not take all day.' },
    { name: 'Refresh', effect: 'Ask again about words already answered.' },
    { name: 'Overwrite types / descriptions', effect: 'Replace what the incoming database already had.' },
    { name: 'Split senses', effect: 'One entry per meaning, or only the first.' },
    { name: 'Add variants', effect: 'Give every form its own row.' },
  ],
  cost: 'About 5 words a second with the defaults on an uncached run; cached words cost nothing. Generating is instant.',
  resources: [
    { title: 'Free Dictionary API', url: 'https://dictionaryapi.dev/', note: 'The keyless default service.' },
    { title: 'Exponential backoff (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Exponential_backoff', note: 'The retry scheme, and why waits grow.' },
    { title: 'Inflection (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Inflection', note: 'What word forms are, and why English ones are irregular.' },
  ],
  source: ['packages/shared/src/flows/dictionary.ts', 'packages/server/src/text/dictionary.ts', 'packages/server/src/text/morphology.ts', 'packages/shared/src/text/senses.ts'],
};

export const GRAMMAR_GUIDE: AlgorithmGuide = {
  kinds: ['text.grammar'],
  title: 'Sentence shapes, counted',
  summary:
    'The grammar database reads a corpus against a word database and counts shapes. Each token is tagged with its type (and form) from the word database, for example `determiner adjective noun verb:past punctuation:.`. The flow counts three kinds of pattern: whole sentences, the fragments between commas and joining words, and every short run of 2 to 5 slots. The random text flow uses these to choose a sentence shape and to score how well each word continues the last few.',
  steps: [
    { kind: 'input', title: 'A corpus and a word database' },
    { kind: 'step', title: 'Tag each token', detail: 'Type and form from the word database. A word it does not know is tagged unknown, not guessed.' },
    { kind: 'step', title: 'Split into sentences', detail: '"Mr." and initials do not end one; a blank line does.' },
    {
      kind: 'loop',
      title: 'For each sentence',
      steps: [
        { kind: 'decision', title: 'Did it end with its own full stop?', no: 'A heading or unfinished line: its shape is not kept, but its fragments still are.' },
        { kind: 'step', title: 'Count the whole shape, and its length in words' },
        { kind: 'step', title: 'Split at commas and conjunctions into fragments; count each' },
        { kind: 'step', title: 'Count every run of 2–5 slots inside each fragment' },
      ],
    },
    { kind: 'step', title: 'Keep the commonest', detail: 'Sentence shapes are shared out between lengths in proportion to how often each length was written.' },
    { kind: 'output', title: 'grammar.json' },
  ],
  pseudocode: `for sentence in sentences(tokenize(text)):
    slots = [tag(t) for t in sentence]   # e.g. "determiner", "verb:past", "punctuation:."
    if sentence.closed:
        lengths[words_in(slots)] += 1
        if len(slots) <= max_sentence_slots:
            sentences[signature(slots)] += 1
    for fragment in split_at_commas_and_conjunctions(slots):
        fragments[signature(fragment)] += 1
        for size in 2..5:
            for each run r of that size in fragment:
                phrases[signature(r)] += 1

# keep: sentence shapes by length quota, the rest commonest first
quota(length) = max(3, max_patterns * share_of_sentences(length))

# used by random text
continuations[first n-1 slots][last slot] += count     # from phrases
score(next | recent) = share of the longest matching run`,
  sections: [
    {
      heading: 'Why it needs a word database',
      body: 'A shape is made of word types, and the word database is the only authority on types. A token it has never seen is tagged `unknown` rather than guessed. It still takes a place in the pattern, so an unfamiliar word does not break its sentence.\n\nForms matter too. If the word database has its forms filled in, `walked` is tagged `verb:past`, not just `verb`, and the grammar is far more detailed.',
    },
    {
      heading: 'Three sizes of pattern',
      body: '- **Sentences:** the whole shape, used to choose what a new sentence looks like.\n- **Fragments:** the pieces between commas and joining words, used to write a clause into existing text.\n- **Phrases:** every run of 2 to 5 slots, turned into a table of what comes next after each run. This is an n-gram model over word types rather than words.',
    },
    {
      heading: 'Length first, then shape',
      body: 'Short shapes repeat word for word far more often than long ones. Choosing shapes by count alone made one-word sentences many times commoner than the corpus had them. So the generator picks in two draws: first a length, by how often the corpus wrote sentences of that length, then a shape of that length.\n\nFor the same reason, the kept shapes are shared out between lengths in proportion to how often each was written.',
    },
    {
      heading: 'Scoring a continuation',
      body: 'To score a candidate word, the generator looks for the longest run of recent slots (up to 4) that the grammar has seen. It asks what share of that run’s continuations match the candidate’s slot. A match on type alone (a verb, but in another tense) counts for 0.6. A longer match counts for more.',
    },
  ],
  settings: [
    { name: 'Max sentence slots', effect: 'Longer sentences are counted by length but their shape is not kept.' },
    { name: 'Phrase min / max', effect: 'The shortest and longest runs counted as phrases.' },
    { name: 'Max patterns / min count', effect: 'How many of each kind are kept, and how often one must appear.' },
    { name: 'Use forms', effect: 'Slots carry the form (verb:past) or only the type (verb).' },
  ],
  cost: 'Linear in the corpus: each fragment of n slots adds about 4n phrase counts.',
  resources: [
    { title: 'Part-of-speech tagging (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Part-of-speech_tagging', note: 'What tagging is. This flow does the simplest kind: a lookup.' },
    { title: 'n-gram (Wikipedia)', url: 'https://en.wikipedia.org/wiki/N-gram', note: 'The phrase table is an n-gram model over word types.' },
    { title: 'Speech and Language Processing, ch. 3 and 8 (Jurafsky & Martin)', url: 'https://web.stanford.edu/~jurafsky/slp3/', note: 'A free textbook on n-gram models and tagging.' },
  ],
  source: ['packages/shared/src/text/grammarDatabase.ts', 'packages/shared/src/flows/grammar.ts'],
};

export const RANDOM_TEXT_GUIDE: AlgorithmGuide = {
  kinds: ['text.random'],
  title: 'Writing one word at a time',
  summary:
    'Random text writes by picking one word at a time from the word database. Every candidate gets a score. Word frequency is the starting point. That is multiplied up by how strongly the last few words point at the candidate, and multiplied down by how poorly its type follows the previous type. A grammar database, when wired in, adds a sentence shape to fill and a score for how well the candidate continues the last few slots. Repeats are penalised. The draw is weighted by score, sharpened by temperature, and seeded, so the same settings always write the same text.',
  steps: [
    { kind: 'input', title: 'A word database; maybe a grammar database and text' },
    { kind: 'decision', title: 'Mode after / from nothing?', no: 'Within: write words, phrases and fragments into gaps. Alter: replace a share of the words, then grow or trim to length.' },
    { kind: 'step', title: 'Plan a length', detail: 'A target and a tolerance, in words or characters.' },
    {
      kind: 'loop',
      title: 'Until the length is reached',
      steps: [
        { kind: 'decision', title: 'Room left in this sentence?', detail: 'Fewer words than the most a sentence may have.', no: 'End it with a full stop and start the next.' },
        { kind: 'step', title: 'Next slot from the sentence shape', detail: 'A new shape is drawn when one runs out: length first, then shape.' },
        { kind: 'step', title: 'Gather candidates', detail: 'Everything the last few words point at, plus the commonest words, up to 400.' },
        { kind: 'step', title: 'Score each candidate', detail: 'prior × context × grammar × punctuation × slot × continuation × repeat penalty.' },
        { kind: 'step', title: 'Draw one, weighted by score^(1/temperature)' },
        { kind: 'step', title: 'Spell it for the slot', detail: 'A past-tense slot gets "walked", if the database has that form.' },
      ],
    },
    { kind: 'step', title: 'Finish the sentence if there is room; close it' },
    { kind: 'output', title: 'Text, with each token marked kept / replaced / added' },
  ],
  pseudocode: `rng = mulberry32(seed)
while length(text) < goal:
    slot = next slot of current sentence shape (or None)
    for c in candidates(history):                     # ≤ 400
        prior   = c.frequency ^ lerp(0.4, 3, frequency_bias)
        pull    = Σ_back decay^back · max(fwd[prev][c], sym · fwd[c][prev])
                  / Σ decay^back                     # last context_window words
        context = 1 + 14·(1 − frequency_bias) · pull
        grammar = follow(prev_type → c.type) ^ (3 · grammar_bias)
        punct   = 0 for a mark after a mark; full stop grows with sentence progress
        shape   = 1 if c.type == slot.type else (1 − grammar_weight)^3
        cont    = 1 + 6 · grammar_weight · continuation(recent_slots, slot_of(c))
        repeat  = 0.1 .. 1 if c was used in the last 6 words
        score[c] = prior · context · grammar · punct · shape · cont · repeat
    word = draw(candidates, weight = score ^ (1 / pick_temperature), rng)
    text += spell_for_slot(word, slot)`,
  sections: [
    {
      heading: 'Frequency is the prior, context multiplies it, grammar filters it',
      body: 'Without context, the commonest words would win every time. **Frequency bias** slides between two readings. At 0, every word is about equally likely before context, and context decides everything. At 1, common words dominate and context is ignored.\n\nThe context pull reads the last few words, each counting less the further back it is (`contextDecay`). A context read backwards (`tree` listing `apple` rather than `apple` listing `tree`) counts for `contextSymmetry` of the forward weight.',
    },
    {
      heading: 'Two kinds of grammar',
      body: '- **Grammar bias** uses a fixed table of how readily one word type follows another (a determiner is followed by a noun or an adjective). It is blunt, but it keeps "the the quiet of" from happening.\n- **Grammar weight** uses a wired-in grammar database. It supplies a sentence shape whose slots each candidate should fill, and a continuation score from the phrases the corpus actually used.\n\nWhen writing into existing text, a candidate also has to fit the word after it, not only the one before.',
    },
    {
      heading: 'Temperature',
      body: 'Scores are raised to the power 1/temperature before the draw. At 1 the draw is proportional to score. Towards 0 the best candidate wins almost every time, so the text is more predictable and repeats itself more. The same trick sharpens the choice of sentence shape.',
    },
    {
      heading: 'Seeded, so it is repeatable',
      body: 'Every random choice comes from a seeded generator (mulberry32). The same database, settings and seed always give the same text, so the graph only marks the flow stale when something real changed. Rerolling means changing the seed, which is an edit you can see and undo.',
    },
    {
      heading: 'Alter and within',
      body: 'In **alter** mode, a share of the words (the alter temperature) is replaced by a word, phrase or fragment that reads on from what is before and into what is after. The text is then grown or trimmed towards the target length. When trimming, adverbs and adjectives go first and determiners and pronouns last, so the sentence structure survives.\n\nIn **within** mode, nothing that came in is changed. New words, phrases and fragments are set into gaps after words until the text is long enough.',
    },
  ],
  settings: [
    { name: 'Mode', effect: 'After (write on), within (write into gaps), or alter (replace words).' },
    { name: 'Seed', effect: 'Same seed, same text.' },
    { name: 'Pick temperature', effect: 'Lower is safer and more repetitive; higher is more varied.' },
    { name: 'Context window / decay / symmetry', effect: 'How many words back the context reads, how fast each step back fades, and how much a backwards link counts.' },
    { name: 'Frequency bias', effect: 'From context decides everything (0) to common words win (1).' },
    { name: 'Grammar bias / grammar weight', effect: 'Strength of the built-in type table, and of the wired grammar database.' },
    { name: 'Sentence words / length', effect: 'Fewest and most words a sentence may have, and the length it aims for.' },
    { name: 'Units', effect: 'How often within and alter write a word, a phrase or a fragment.' },
  ],
  cost: 'About 400 candidates scored per word: a few thousand words a second.',
  resources: [
    { title: 'Markov text generators (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Markov_chain#Markov_text_generators', note: 'The simplest version of the same idea.' },
    { title: 'Softmax temperature', url: 'https://en.wikipedia.org/wiki/Softmax_function#Applications', note: 'Why raising scores to 1/T sharpens or flattens a draw.' },
    { title: 'Weighted random sampling', url: 'https://en.wikipedia.org/wiki/Reservoir_sampling#Weighted_random_sampling', note: 'Drawing in proportion to a weight.' },
  ],
  source: ['packages/shared/src/text/generate.ts', 'packages/shared/src/text/grammar.ts', 'packages/shared/src/text/grammarDatabase.ts', 'packages/shared/src/flows/text.ts'],
  tryIt: 'Change the seed or the pick temperature and generate again; replaced and added words are highlighted.',
};
