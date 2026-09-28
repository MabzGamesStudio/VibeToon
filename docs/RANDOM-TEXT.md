# Random Text

The `text.random` flow writes text from a word database: into the text that
arrives over a wire, after it, or in place of some of its words. Nothing about it
is a language model: every run is a walk through a graph of words you can see and
edit, seeded so the same settings always produce the same text.

## What a run does

| Mode | What happens to the text coming in |
| --- | --- |
| **Within** | Every word of it is kept, in order. New words, phrases and fragments are written in between, after a word, until the whole is as long as the target. |
| **After** | It is kept as it is, and the run writes on from its end until the whole is as long as the target. If it stops mid-sentence, that sentence is finished word by word first. With nothing coming in, this is writing from nothing. |
| **Alter** | A share of its words (the **alter temperature**) is replaced, each with a word, a phrase or a fragment. |

Within and Alter with nothing to work on write from nothing instead, and say so.
A flow saved when the modes were *Generate* and *Alter* opens in **After** where it
said Generate: with nothing coming in, it writes what Generate did.

### Words, phrases and fragments

Where a run writes into the text (Within) or replaces a word (Alter), each piece is
one of three sizes, chosen by three weights, **A word**, **A phrase** and **A
fragment**. Only how they compare matters: 1, 0, 0 is word for word.

- **A phrase** is a run of words, from **Words in a phrase** (2 to 4 by
  default). It brings no punctuation; its last word is fitted to the word after it.
- **A fragment** is a clause of its own, from **Words in a fragment** (3 to 7),
  set off by a comma before it, and one after it when a word follows. With a
  grammar database wired in, it is written into one of the database's fragment
  shapes of that length.

### Sentence sizes

**Words in a sentence** (4 to 30 by default) holds every sentence the run writes:
a full stop is impossible before the fewest, and one is put in at the most. With
a grammar database wired in, the sentence shape is chosen from within the range
as well. **Sentence length** is where, inside the range, a full stop starts to
become likely.

## The word database

One entry — a *lexeme* — per word or token. A database is **counted out of a
corpus** by the Word Database flow; see [WORD-DATABASE.md](WORD-DATABASE.md) for
how the counting and weighting work.

| Field | What it is |
| --- | --- |
| `id` | Stable identifier, referenced by other entries' contexts. |
| `spelling` | The word, or the token: `apple`, `.`, `'`, `42`. |
| `type` | noun, verb, adjective, adverb, pronoun, determiner, preposition, conjunction, interjection, number, punctuation. |
| `frequency` | 0–1, how common the word is in English. |
| `description` | What it means, for whoever edits the database later. |
| `contexts` | Weighted links to other entries. |

Contexts are the steering: a link says how much more often one word follows
another than that word turns up at all. After *apple*, a word that only ever
follows apples is far likelier than one that follows everything. Links count in
reverse too, scaled by the flow's **context symmetry**.

A new Random Text flow starts with a database counted from the bundled sample
corpus — about a thousand tokens, which is enough to write with and small enough
to repeat itself. For anything real, add a **Word Database** flow, give it a book,
and wire it into the Random Text flow's Word database input. Entries are matched
on spelling plus word type and contexts are unioned at the stronger weight, so
merging never quietly drops what you had.

## Picking the next word

Every candidate in the database is scored, and one is drawn:

```
score = frequency^e × (1 + gain × contextPull) × grammar × sentenceShape × nextFit × repeatPenalty
```

- **`contextPull`** is what the previous words want. Each step back through the
  **context window** counts for less (**context decay**), and each step
  contributes the weight of the link from that word to the candidate — or the
  link read backwards, scaled by **context symmetry**.
- **`frequency bias`** sets both `e` and `gain`: at 0 every word is equally
  reachable and context decides everything; at 1 the common words win and context
  is ignored.
- **`grammar bias`** raises a part-of-speech table to a power. At 0 word order is
  ignored entirely — word soup. At 1 a determiner is followed by a noun or an
  adjective and very little else.
- **Sentence shape** is what puts punctuation in: a full stop becomes likely as
  the sentence passes **sentence length** words, and is impossible before the
  fewest **words in a sentence**.
- **`nextFit`** is the [grammar database](GRAMMAR-DATABASE.md), when one is wired
  in and the **Grammar database** weight is above 0: a word whose slot often
  continued the run just written scores higher, and a word of the wrong type for
  the slot the sentence shape is asking for is pushed down hard.
- A word used in the last few tokens is penalised, on a sliding scale, so the
  text does not loop.

The draw itself is reshaped by **pick temperature**: at 0 the strongest candidate
always wins, at 1 the draw is straight proportional to score.

## Sentence shapes

Wire a **Grammar Database** flow into the Grammar database input and the run
stops writing word by word and starts writing *into a shape*. A sentence's length
is drawn first, as often as the corpus wrote sentences that long (and within
**words in a sentence**). Then a shape of that length is drawn, weighted by how
often the corpus used it. Each slot is filled with a word of that type, spelled
into that form: a slot asking for `verb:past` gets `walked`, not `walk`.

Drawing the length first keeps short sentences as rare as the corpus had them.
Short shapes repeat word for word far more often than long ones, so drawing whole
shapes by count made one-word sentences come up many times too often.

The **Grammar database** slider is how hard that pulls. At 0 a wired grammar
changes nothing, which makes it easy to hear what it does: same seed, same
settings, 0 and then 0.7. See [GRAMMAR-DATABASE.md](GRAMMAR-DATABASE.md).

## Length

Five controls, because "make it 20% shorter" and "make it 500 characters" are
different jobs:

| Mode | What the target is |
| --- | --- |
| Keep the length it is | No length pass at all. |
| Word count | An absolute number of words. |
| Character count | An absolute number of characters. |
| Change in words (%) | A percentage of the incoming text's word count. |
| Change in characters (%) | A percentage of its character count. |

**Length temperature** turns the target into a band: the run picks one point
inside `target ± (target × temperature ÷ 2)` and writes to that, which is what
lets a sentence finish instead of stopping mid-clause. At 0 it lands on the
number exactly — as exactly as whole words allow, which for a character target
means within a word of it.

Growing text inserts words where they fit (read from both sides, so an insertion
agrees with the word after it as well as the one before). Shrinking drops the
words that cost least — adverbs and adjectives first, pronouns and determiners
last, punctuation never.

## Altering

**Alter temperature** is the share of the incoming words a run replaces. A word
replaced by a word is drawn with the same scoring, with two additions: the word
being replaced is excluded, and its part of speech is preferred, so a noun comes
back as a noun. A word replaced by a phrase or a fragment reads on from what is
before it and into what is after it. With a grammar database wired in, the replacement also has to fit the
form the original was in and follow what came before it, so a past tense stays
past tense.

What the text *is* survives the pass. Line breaks, blank lines, punctuation runs
like `====`, and words that are not in the database are all left alone — only
words the database knows are candidates for replacement, and the report lists the
ones it could not read. That means a script keeps its shape:

```
SCENE 1 — INT. WORKSHOP - NIGHT        SCENE 1 — INT. WORKSHOP - NIGHT

  MABZ                                   MABZ
    It did it yesterday. Twice.            It asks it yesterday. Twice.
```

The database holds whatever was counted, so a word the corpus never used is not in
it. Its *forms* are a different matter: once the morphology dataset has been
built, `waits` has a row of its own even if the corpus only ever said `wait`, so
the generator can spell a slot that asks for the third person. See
[Variations](WORD-DATABASE.md#variations). A word the corpus never used at all
still needs a larger corpus.

## Rules on the wire

A connection into a random text flow can set the run's options, so one database
can be driven differently by each flow that reads from it:

```
mode: within
alter: 0.35
length: +50%
temperature: 0.45
context window: 4
seed: rain
```

`mode` takes `within` (or `insert`), `after` (or `generate`, `continue`) and
`alter`. `length` takes `keep`, `120 words`, `900 characters`, `+20%`, or
`-15% characters`. Setting `alter` also switches the flow into altering, since
saying how much to change implies wanting the incoming text changed. The editor
shows a banner when a wire is overriding the flow's own settings.

## Speed

The editor merges every wired-in word database once, when one changes, not on
every keystroke. The live preview waits for typing to pause. With live preview
off, typing into the input costs nothing but the text itself.

## Outputs

| Port | File | What it is |
| --- | --- | --- |
| Text | `text.txt` | What the run produced. |
| Word database | `lexicon.json` | The database, for other flows to merge in. |
| Report | `report.md` | Lengths in and out, what changed, what it could not read, and the exact options used. |
