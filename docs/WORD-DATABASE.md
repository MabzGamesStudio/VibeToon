# The word database

A word database is counted, not written. You give it text; it counts what is in
there and what follows what, asks a dictionary what the words are, and produces
the `lexicon.json` that a Random Text flow writes from.

The **Word Database** flow (`text.lexicon`) owns this. Add it from the palette
and wire its Word database output into a Random Text flow's Word database input.

Two neighbouring flows do the jobs either side of it:

- The **Corpus** flow (`text.corpus`) gathers the text. Wire it into both this
  flow and a [grammar database](GRAMMAR-DATABASE.md) and the two read exactly
  the same words, which is what makes their word types line up.
- The **Dictionary** flow (`text.dictionary`) takes a database in and hands a
  better one out, asking a service what each word is. The counting knows how
  often a word appears; only a dictionary knows what kind of word it is.

## What a row is made of

| Field | Where it comes from |
| --- | --- |
| `spelling` | A token counted in the corpus: a word, a number, or a mark like `.` or `,`. |
| `type` | The dictionary's part of speech, mapped onto a word type. Guessed when the dictionary has no entry or cannot be reached. |
| `description` | The dictionary's first definition. |
| `frequency` | How often the token appears in the corpora you included. |
| `contexts` | Which words follow it, and how strongly — counted from the text. |
| `variations` | The other spellings the word takes, keyed by form. |

### Variations

Which forms an entry carries depends on what type it is — there is no point
asking a preposition for its plural:

| Type | Forms |
| --- | --- |
| Verb | `infinitive`, `third_person_singular`, `present_progressive`, `past`, `past_participle` |
| Noun | `singular`, `plural` |
| Adjective, adverb | `positive`, `comparative`, `superlative` |
| Everything else | none |

```json
{
  "id": "lex_walk",
  "spelling": "walk",
  "type": "verb",
  "frequency": 0.63,
  "description": "To move at a regular pace by lifting and setting down each foot in turn.",
  "variations": {
    "infinitive": "walk",
    "third_person_singular": "walks",
    "present_progressive": "walking",
    "past": "walked",
    "past_participle": "walked"
  }
}
```

The forms are worked out from spelling rules plus tables of the irregulars —
`go → went`, `knife → knives`, `good → better` — and a modal simply has no
progressive, so `can` carries `could` and nothing else. The form names follow
the convention used by [english-inflection](https://github.com/BryanKoo/english-inflection);
the rules and tables here are this project's own.

Variations are what let a [grammar database](GRAMMAR-DATABASE.md) say *which
form* of a word a sentence used, and what let the generator write `walked` into
a slot that asks for a past tense.

## Corpora, and the master

Each corpus you add becomes a **dataset of its own**: the counts taken from that
text and nothing else. The master database is whatever the ticked datasets add
up to.

Datasets hold **counts, never weights**, and that is the whole trick. Adding two
corpora adds their counts; unticking one subtracts them again, exactly. Build a
database from the Odyssey and Gatsby, untick the Odyssey, and what is left is
bit-for-bit the Gatsby database — not an approximation of it. Frequencies and
context weights are recomputed from whatever counts remain, so every number in
the database always describes exactly the corpora that are ticked.

Four ways to add one:

- **From the web.** Any plain-text URL. The editor suggests some public-domain
  books; a Project Gutenberg file has its licence header and footer trimmed off
  so several thousand words of legal English are not counted as the author's
  vocabulary. Only add text you have the right to use.
- **Paste it.** A script, a transcript, your own writing.
- **The bundled sample.** A short piece written for this project, so a new flow
  works with nothing downloaded. It is about a thousand tokens — enough to
  demonstrate the machinery, small enough that what it writes repeats itself.
  Add a book for anything real.
- **Over a wire.** Text arriving on the flow's Corpus input is counted as its own
  dataset and re-counted on every run, so a Random Text or Dialog flow can feed
  the database its own output.

## How the numbers are worked out

Counting walks the text once, tallying each token and each **pair** of adjacent
tokens. Punctuation counts as a token, so `yesterday → .` and `. → the` are
learned like any other pair — that is what teaches the generator where sentences
end. A blank line breaks the chain; a wrapped line does not.

**Frequency** is compressed logarithmically against the most common token:

```
frequency = log(1 + count) / log(1 + maxCount)
```

The commonest word sits at 1 and the long tail stays usable, where a raw share of
tokens would put almost everything at nearly zero.

**Context weight** is *lift*: how much more often B follows A than B turns up at
all.

```
lift   = P(B | A) / P(B)          = [count(A→B) / count(A)] / [count(B) / tokens]
weight = min(1, log(1 + lift) / log(1 + liftCeiling))
```

Dividing by the word's own frequency is what stops `the` from being the strongest
context of every word in the language: `the` follows everything, so its lift is
near 1 and its weight is low, while a word that *only* ever follows one other
word scores near the ceiling.

## Settings

**Counting** (applied when a corpus is added — a dataset keeps the counts it was
pruned to, so changing these affects the next corpus, not the ones already in):

| Setting | What it does |
| --- | --- |
| Words kept per corpus | Keep this many distinct tokens, commonest first. |
| Links kept per word | Keep this many following-word links per entry. |
| A pair must occur | Pairs seen fewer times than this are noise, and dropped. |
| Count punctuation | Whether `.` `,` and the rest are tokens of their own. |

**Weighting** (applied every time the database is derived, so change these
freely):

| Setting | What it does |
| --- | --- |
| Lift ceiling | How much lift counts as a full-strength link. Lower makes more links strong. |
| Weakest link kept | Links below this weight are dropped. |
| Contexts per word | How many links each word keeps, strongest first. |

## The dictionary

**Look up words** asks a dictionary service for each word's part of speech and
first definition, and caches every answer on disk — a word is only ever fetched
once, and the cache survives restarts. Punctuation and numbers are not sent
anywhere; they are labelled locally.

A database counted from a book runs to thousands of words, and no free
dictionary will answer thousands of requests in a row, so the lookup runs **in
batches**: a hundred words per call, a few requests in flight at a time with a
breath between them. Each batch's answers are saved before the next one starts,
so the progress bar is real progress and **Stop** keeps everything found so far —
running it again carries on from where it stopped rather than starting over.

Failures are handled rather than hidden:

- A **429** is the service asking us to slow down. The word is retried, waiting
  as long as `Retry-After` asks.
- A **5xx** or a dropped connection is retried a few times with a growing gap.
- A request that **never answers** is abandoned after eight seconds instead of
  hanging the batch.
- A **403** or similar will say the same thing however often it is asked, so it
  is not retried at all.
- A run of words the service will not answer **abandons the batch**, rather than
  firing hundreds of doomed requests. Whatever was learned is kept, the rest come
  back as still-to-ask, and the editor says what happened and how far it got.

Words the dictionary has never heard of, and every word when the service cannot
be reached, fall back to a **guess**: a table of function words plus suffix rules
(`-ly` is an adverb, `-ness` a noun). The editor shows which is which — `dictionary`,
`inferred`, or `manual` if you corrected it yourself — so nothing guessed is ever
presented as something a dictionary said. Corrections you make are kept against
the spelling, so they survive rebuilding the database from different corpora.

### Which dictionary

Swapping dictionary is not just a different address: each service answers in its
own shape, and a part of speech is `partOfSpeech` in one, `fl` in another, and a
single letter glued to the front of the definition in a third. So the studio
knows several services, each with the code that reads its replies. Pick one in
the Word Database editor under **Dictionary**; the choice is remembered in
`data/settings.json`.

| Service | Key | What it is good and bad at |
| --- | --- | --- |
| **Free Dictionary API** | none | The default. Generous until it is not: it throttles hard on a long run, and has been known to refuse outright from a datacentre address. |
| **Wiktionary** | none | Wikimedia's own, so it is steady and will not vanish. Definitions are written by hand and can be long; its part-of-speech labels are the broadest here. |
| **Datamuse** | none | By far the most tolerant of a few thousand words in a row. Terse definitions, and only four parts of speech — but a *type* is what the grammar flow actually needs. |
| **Merriam-Webster Collegiate** | [free](https://dictionaryapi.com/register/index) | The best definitions and the most reliable types. 1,000 lookups a day is the catch for a book-sized database. |
| **Wordnik** | [free](https://developer.wordnik.com/) | Pulls from several published dictionaries at once, so coverage of unusual words is good. Non-commercial use. |

For a large database, **Datamuse** is usually the right answer: word *type* is
what decides whether the [grammar database](GRAMMAR-DATABASE.md) is any good,
and Datamuse will answer thousands of words without complaining. Run
Merriam-Webster afterwards if you want readable definitions — answers are
cached per word, so the second service only fetches what the first did not get.

Configured from the environment when you would rather not click:

| Variable | What it does |
| --- | --- |
| `VIBETOON_DICTIONARY` | A service id: `free-dictionary`, `wiktionary`, `datamuse`, `merriam-webster`, `wordnik`. |
| `VIBETOON_DICTIONARY_KEY` | The key, for a service that needs one. Read on the server only — never written to a project, never sent to the browser, and masked out of the [API log](API-LOG.md). |
| `VIBETOON_DICTIONARY_URL` | Any other service, with `{word}` where the word goes. Wins over everything else, and the reply is read for whichever common shape it turns out to be in. |

A service whose key is missing cannot be selected at all, rather than being used
to fire a few hundred requests that can only come back 401.

### When it does not work

Open **Logs** in the header. Every attempt is there with the address, the status
and the reason — see [API-LOG.md](API-LOG.md).

## Outputs

| Port | File | What it is |
| --- | --- | --- |
| Word database | `lexicon.json` | Every word with its type, description, frequency, count and weighted contexts. |
| Report | `report.md` | Which corpora went in, which were held back, the settings used, and the most common words. |
