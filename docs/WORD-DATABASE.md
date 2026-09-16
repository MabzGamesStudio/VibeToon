# The word database

A word database is counted, not written. You give it text; it counts what is in
there and what follows what, asks a dictionary what the words are, and produces
the `lexicon.json` that a Random Text flow writes from.

The **Word Database** flow (`text.lexicon`) owns this. Add it from the palette
and wire its Word database output into a Random Text flow's Word database input.

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

The service is `api.dictionaryapi.dev` by default; point `VIBETOON_DICTIONARY_URL`
at another one (with `{word}` where the word goes) if you prefer.

## Outputs

| Port | File | What it is |
| --- | --- | --- |
| Word database | `lexicon.json` | Every word with its type, description, frequency, count and weighted contexts. |
| Report | `report.md` | Which corpora went in, which were held back, the settings used, and the most common words. |
