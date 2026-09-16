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
| Word database | **Required.** Without it every word type would be a guess, and a database of guesses describes nothing. |

Wire its Grammar database output into a Random Text flow's Grammar database
input, and turn that flow's **Grammar database** slider up.

## What a slot is

Each token becomes one slot:

- A word becomes its type and, when it inflects, its form — `verb:past`,
  `noun:plural`, `adjective:comparative`. The type is read off the word database;
  the form is read off the word's [variations](WORD-DATABASE.md#variations).
- A mark becomes `punctuation:` and the mark itself, so `punctuation:.` and
  `punctuation:?` are different slots.
- A word the database has never seen is still tagged, by guess, so one unfamiliar
  word does not throw away the sentence around it. The report says how many of
  those there were.

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

## Combining and taking back out

Patterns are stored as **counts**, exactly as corpora are, so the same arithmetic
holds: read two books into one grammar database, untick one, and what is left is
precisely what the other one put in. Nothing is recomputed from an average, so
nothing drifts.

## Settings

| Setting | What it does |
| --- | --- |
| Longest sentence kept | A longer sentence is read and counted, but its shape is not stored. |
| Shortest / longest phrase | The range of run lengths kept as phrases. |
| Patterns kept of each kind | How many of each kind to keep, commonest first. |
| A pattern must occur | How often a shape has to turn up before it is kept. |
| Include word forms | `verb:past` versus plain `verb`. |

## What the generator does with it

Two things, both scaled by the Random Text flow's **Grammar database** weight:

1. **A sentence shape to write into.** One is drawn, weighted by how often the
   corpus used it, and the run fills its slots in order. A slot asking for
   punctuation gets the mark directly; a slot asking for `verb:past` gets a verb,
   spelled `walked` rather than `walk`.
2. **A score on every candidate.** The longest run of recent slots the grammar
   has seen is looked up, and a word whose slot often continued that run scores
   higher. A word of the wrong type for the slot is pushed down hard.

At weight 0 a wired grammar database changes nothing at all, so it is easy to
hear what it is doing: same seed, same settings, slider at 0 and then at 0.7.

## Accuracy depends on the word types

A grammar database is only as good as the types underneath it. If the dictionary
has not been run — or could not be reached — most words are guessed, and guessed
types produce shapes like `the bread workshops`. Run the lookup on the word
database first, correct anything obviously wrong, then read the corpus into the
grammar. It is the single biggest lever on the quality of what comes out.

Reading the **same** corpus into both flows helps for the same reason: every word
in the text is then one the database has a type for.

## Outputs

| Port | File | What it is |
| --- | --- | --- |
| Grammar database | `grammar.json` | Sentence, fragment and phrase patterns with their counts, and what was read. |
| Report | `report.md` | What went in, how much of it the word database could type, and the commonest shapes it found. |
