# Random Text

The `text.random` flow writes text from a word database, or rewrites text that
arrives over a wire. Nothing about it is a language model: every run is a walk
through a graph of words you can see and edit, seeded so the same settings always
produce the same text.

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
  the sentence passes **sentence length** words, and impossible before three.
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
stops writing word by word and starts writing *into a shape*: a whole sentence
pattern is drawn — weighted by how often the corpus used it — and each slot is
filled with a word of that type, spelled into that form. A slot asking for
`verb:past` gets `walked`, not `walk`.

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

**Alter temperature** is the share of the incoming words a run may replace. Each
replacement is drawn with the same scoring, with two additions: the word being
replaced is excluded, and its part of speech is preferred, so a noun comes back
as a noun. With a grammar database wired in, the replacement also has to fit the
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

The database holds whatever was counted, so a word the corpus never used is
unknown — including inflections (`waits` when the corpus only ever said `wait`).
Counting a larger corpus is what fixes that.

## Rules on the wire

A connection into a random text flow can set the run's options, so one database
can be driven differently by each flow that reads from it:

```
alter: 0.35
length: +50%
temperature: 0.45
context window: 4
seed: rain
```

`length` takes `keep`, `120 words`, `900 characters`, `+20%`, or
`-15% characters`. Setting `alter` also switches the flow into altering, since
saying how much to change implies wanting the incoming text changed. The editor
shows a banner when a wire is overriding the flow's own settings.

## Outputs

| Port | File | What it is |
| --- | --- | --- |
| Text | `text.txt` | What the run produced. |
| Word database | `lexicon.json` | The database, for other flows to merge in. |
| Report | `report.md` | Lengths in and out, what changed, what it could not read, and the exact options used. |
