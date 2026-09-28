# The grammar database

Where a [word database](WORD-DATABASE.md) says which *words* follow which, a
grammar database says which **kinds** of word follow which, and in what form:

```
determiner noun:singular verb:third_person_singular adjective:positive punctuation:.
```

That is one **pattern** — the shape of `The lamp is old.` — and the database
stores how often the corpus used it. The word database supplies the type and the
form of each token; the corpus supplies the order.

The **Grammar Database** flow (`text.grammar`) owns this. It takes two inputs and
needs both:

| Input | Why |
| --- | --- |
| Corpus | The text to read for its shapes. |
| Word database | **Required.** Without it no word has a type, and a database of untyped slots describes nothing. |

Wire its Grammar database output into a Random Text flow's Grammar database
input, and turn that flow's **Grammar database** slider up.

## Where a sentence starts and ends

A sentence runs from one full stop (or `!`, `?`, `…`) to the next:

- `Mr.`, `Mrs.`, `Dr.`, `St.` and other titles and abbreviations do not end one,
  nor does an initial (`F. Scott`).
- A closing quote or bracket after the full stop stays with its sentence:
  `"Go home."` is one sentence, and the next begins after the quote.
- A blank line ends whatever was running. A heading with no full stop is not a
  sentence, and does not run on into the paragraph under it.
- A run in capitals or roman numerals (`CHAPTER IV.`, `THE END.`, `II.`) is a
  heading, and is not read.
- Only a run that ends in its own full stop is a whole sentence. The text's last
  unfinished line, a title or a list item still gives fragments and phrases.

Quote marks and brackets are left out of every shape: they are not grammar, and a
shape that opened a quote without closing it would write unbalanced quotes.

## What a slot is

Each token becomes one slot:

- A word becomes its type and, when it inflects, its form — `verb:past`,
  `noun:plural`, `adjective:comparative`. The type is read off the word database;
  the form is read off the word's [variations](WORD-DATABASE.md#variations).
- A mark becomes `punctuation:` and the mark itself, so `punctuation:.` and
  `punctuation:?` are different slots.
- A word the database has never seen, or has never had looked up, becomes
  `unknown`. It still takes a place in the pattern, so one unfamiliar word does
  not throw away the sentence around it — it simply does not pretend to be a noun.
  The report says how many of those there were.

Turn **Include word forms** off and a slot is just `verb` — far more shapes
match, but nothing is said about tense or number.

## Three kinds of pattern

| Kind | What it is |
| --- | --- |
| **Sentences** | A whole sentence, its final mark included. The shapes the generator writes into. |
| **Fragments** | A sentence cut at its commas, semicolons and joining words. One clause, without the glue. |
| **Phrases** | Every short run of slots inside a fragment, two to five long. What the generator scores candidate words against. |

A sentence shape is kept even if it was only seen once — a whole sentence
repeating at all is already meaningful — while fragments and phrases have to meet
the **A pattern must occur** floor.

**Sentence lengths** are counted too: how many sentences had each number of
words, for every sentence read, including those too long to keep as a shape. The
sentence shapes kept are shared out between lengths in proportion, so the one-off
long sentences are not squeezed out by the few short ones that repeat exactly.

## Combining and taking back out

Patterns are stored as **counts**, exactly as corpora are, so the same arithmetic
holds: read two books into one grammar database, untick one, and what is left is
precisely what the other one put in. Nothing is recomputed from an average, so
nothing drifts.

## Settings

| Setting | What it does |
| --- | --- |
| Longest sentence kept | A longer sentence is read and its length counted, but its shape is not stored (40 slots by default). |
| Shortest / longest phrase | The range of run lengths kept as phrases. |
| Patterns kept of each kind | How many of each kind to keep, commonest first (1,500 by default). Sentence shapes are shared out between lengths. |
| A pattern must occur | How often a shape has to turn up before it is kept. |
| Include word forms | `verb:past` versus plain `verb`. |

## What the generator does with it

Two things, both scaled by the Random Text flow's **Grammar database** weight:

1. **A sentence shape to write into.** First a length is drawn, as often as the
   corpus wrote sentences that long, within the Random Text flow's **words in a
   sentence**. Then a shape of that length is drawn, weighted by how often the
   corpus used it, and the run fills its slots in order. A slot asking for
   punctuation gets the mark directly; a slot asking for `verb:past` gets a verb,
   spelled `walked` rather than `walk`.
2. **A score on every candidate.** The longest run of recent slots the grammar
   has seen is looked up, and a word whose slot often continued that run scores
   higher. A word of the wrong type for the slot is pushed down hard.

Drawing the length first is what keeps short sentences as rare as the corpus had
them. Weighting whole shapes by how often each repeated made the shortest ones
(`noun .`) come up far too often: they repeat word for word, where long sentences
almost never do.

A fragment written into the text by the Random Text flow's **Within** or **Alter**
mode is written into a fragment shape of the right length, when there is one.

At weight 0 a wired grammar database changes nothing at all, so it is easy to
hear what it is doing: same seed, same settings, slider at 0 and then at 0.7.

## Accuracy depends on the word types

A grammar database is only as good as the types underneath it. If the dictionary
has not been run — or could not be reached — most words are `unknown`, and a
corpus of `unknown unknown unknown` shapes teaches the generator nothing. Run the
lookup on the word database first, correct anything obviously wrong, then read the
corpus into the grammar. It is the single biggest lever on the quality of what
comes out.

Forms matter as much as types. A slot is only `verb:past` if the word database
knows `walked` is the past of `walk`, which means the morphology dataset has to
have been built — see [Variations](WORD-DATABASE.md#variations). Without it every
verb is just `verb`, and the grammar cannot say anything about tense.

Reading the **same** corpus into both flows helps for the same reason: every word
in the text is then one the database has a type for.

## Outputs

| Port | File | What it is |
| --- | --- | --- |
| Grammar database | `grammar.json` | Sentence, fragment and phrase patterns with their counts, and what was read. |
| Report | `report.md` | What went in, how much of it the word database could type, and the commonest shapes it found. |
