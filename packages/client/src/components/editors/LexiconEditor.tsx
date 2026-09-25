import { useMemo, useState } from 'react';
import {
  WORD_TYPES,
  WORD_TYPE_LABEL,
  buildLexiconIndex,
  lexemeLabel,
  lexiconStats,
  newLexeme,
  pruneLexicon,
  setContextWeight,
  type Lexeme,
  type Lexicon,
  type WordType,
} from '@vibetoon/shared';
import { useSliderRange } from '../../state/sliderRanges';

/** Word types worth suggesting a link to; function words carry no meaning. */
const CONTENT_TYPES = new Set<WordType>(['noun', 'verb', 'adjective', 'adverb']);

export interface LexiconEditorProps {
  lexicon: Lexicon;
  onChange(lexicon: Lexicon): void;
}

/**
 * The word database. Each entry carries how common the word is and what it
 * pulls towards; those weights are the whole steering mechanism, so editing
 * them is the main thing this view is for.
 */
export function LexiconEditor({ lexicon, onChange }: LexiconEditorProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<WordType | 'all'>('all');
  const frequencyRange = useSliderRange('lexicon.frequency');
  const weightRange = useSliderRange('lexicon.contextWeight');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contextQuery, setContextQuery] = useState('');

  const stats = useMemo(() => lexiconStats(lexicon), [lexicon]);
  const index = useMemo(() => buildLexiconIndex(lexicon), [lexicon]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lexicon.lexemes
      .filter((lexeme) => (typeFilter === 'all' ? true : lexeme.type === typeFilter))
      .filter(
        (lexeme) =>
          !needle ||
          lexeme.spelling.toLowerCase().includes(needle) ||
          lexeme.description.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.frequency - a.frequency || a.spelling.localeCompare(b.spelling));
  }, [lexicon.lexemes, query, typeFilter]);

  const selected = selectedId ? lexicon.lexemes.find((lexeme) => lexeme.id === selectedId) : undefined;

  const update = (id: string, patch: Partial<Lexeme>) => {
    onChange({
      lexemes: lexicon.lexemes.map((lexeme) => (lexeme.id === id ? { ...lexeme, ...patch } : lexeme)),
    });
  };

  const add = () => {
    const lexeme = newLexeme(query.trim(), typeFilter === 'all' ? 'noun' : typeFilter);
    onChange({ lexemes: [...lexicon.lexemes, lexeme] });
    setSelectedId(lexeme.id);
    setQuery('');
  };

  const remove = (id: string) => {
    // Dropping a word also drops every context pointing at it, so the database
    // never ends up referring to something that is not there.
    onChange(pruneLexicon({ lexemes: lexicon.lexemes.filter((lexeme) => lexeme.id !== id) }));
    if (selectedId === id) setSelectedId(null);
  };

  // Sorting by weight is the useful order, but re-sorting while a slider is
  // being dragged makes rows jump out from under the pointer. The order is
  // recomputed when the selection or the number of links changes, not on every
  // weight edit.
  const orderedContexts = useMemo(
    () => (selected ? [...selected.contexts].sort((a, b) => b.weight - a.weight) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected?.id, selected?.contexts.length],
  );

  const contextCandidates = useMemo(() => {
    if (!selected) return [];
    const needle = contextQuery.trim().toLowerCase();
    const taken = new Set(selected.contexts.map((context) => context.id));
    const pool = lexicon.lexemes.filter((lexeme) => lexeme.id !== selected.id && !taken.has(lexeme.id));

    if (needle) {
      return pool
        .filter((lexeme) => lexeme.spelling.toLowerCase().includes(needle))
        .sort((a, b) => b.frequency - a.frequency)
        .slice(0, 12);
    }

    // With nothing typed, the useful suggestions are, in order: words that
    // already point at this one (worth making the link both ways), then words
    // its neighbours point at, then ordinary content words. Suggesting `the` or
    // `is` would tell the generator nothing, so the very common words are left
    // out of the last group.
    const backlinks = [...(index.backward.get(selected.id)?.keys() ?? [])]
      .filter((id) => !taken.has(id))
      .map((id) => index.byId.get(id))
      .filter((lexeme): lexeme is Lexeme => lexeme !== undefined);

    const secondDegree = new Map<string, number>();
    for (const context of selected.contexts) {
      for (const [id, weight] of index.forward.get(context.id) ?? []) {
        if (id === selected.id || taken.has(id)) continue;
        secondDegree.set(id, (secondDegree.get(id) ?? 0) + weight * context.weight);
      }
    }
    const neighbours = [...secondDegree.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => index.byId.get(id))
      .filter((lexeme): lexeme is Lexeme => lexeme !== undefined && !backlinks.includes(lexeme));

    const contentful = pool
      .filter((lexeme) => CONTENT_TYPES.has(lexeme.type) && lexeme.frequency < 0.7)
      .sort((a, b) => b.frequency - a.frequency);

    const seen = new Set<string>();
    return [...backlinks, ...neighbours, ...contentful]
      .filter((lexeme) => !seen.has(lexeme.id) && seen.add(lexeme.id))
      .slice(0, 8);
  }, [contextQuery, index, lexicon.lexemes, selected]);

  return (
    <div className="vt-lexicon">
      <div className="vt-lexicon-list">
        <div className="vt-lexicon-tools">
          <input
            value={query}
            placeholder="Search words…"
            aria-label="Search words"
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            value={typeFilter}
            aria-label="Filter by word type"
            onChange={(event) => setTypeFilter(event.target.value as WordType | 'all')}
          >
            <option value="all">All types</option>
            {WORD_TYPES.map((type) => (
              <option key={type} value={type}>
                {WORD_TYPE_LABEL[type]}
              </option>
            ))}
          </select>
          <button type="button" className="vt-btn is-small" onClick={add}>
            + Word
          </button>
        </div>

        <div className="vt-faint" style={{ fontSize: 11, padding: '0 8px 6px' }}>
          {stats.total} word{stats.total === 1 ? '' : 's'} · {stats.contextEdges} context link
          {stats.contextEdges === 1 ? '' : 's'} · showing {filtered.length}
          {stats.danglingRefs.length > 0 ? ` · ${stats.danglingRefs.length} broken link(s)` : ''}
          {stats.duplicateIds.length > 0 ? ` · ${stats.duplicateIds.length} duplicate id(s)` : ''}
        </div>

        <div className="vt-lexeme-rows vt-scroll">
          {filtered.map((lexeme) => (
            <button
              key={lexeme.id}
              type="button"
              className={`vt-lexeme-row${lexeme.id === selectedId ? ' is-selected' : ''}`}
              onClick={() => setSelectedId(lexeme.id)}
            >
              <span className="vt-lexeme-spelling">{lexemeLabel(lexeme)}</span>
              <span className="vt-lexeme-type">{lexeme.type.slice(0, 4)}</span>
              <span className="vt-freq-bar" title={`frequency ${lexeme.frequency.toFixed(2)}`}>
                <i style={{ width: `${Math.round(lexeme.frequency * 100)}%` }} />
              </span>
              <span className="vt-lexeme-links">{lexeme.contexts.length}</span>
            </button>
          ))}
          {filtered.length === 0 ? (
            <div className="vt-empty" style={{ padding: 10 }}>
              Nothing matches. “+ Word” adds “{query.trim() || 'a new word'}”.
            </div>
          ) : null}
        </div>
      </div>

      <div className="vt-lexeme-detail vt-scroll">
        {!selected ? (
          <div className="vt-empty">Pick a word to edit it.</div>
        ) : (
          <>
            <div className="vt-row" style={{ marginBottom: 8 }}>
              <input
                value={selected.spelling}
                aria-label="Spelling"
                style={{ fontWeight: 600 }}
                onChange={(event) => update(selected.id, { spelling: event.target.value })}
              />
              <select
                value={selected.type}
                aria-label="Word type"
                style={{ width: 140 }}
                onChange={(event) => update(selected.id, { type: event.target.value as WordType })}
              >
                {WORD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {WORD_TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="vt-btn is-small is-danger"
                onClick={() => remove(selected.id)}
                title="Remove this word"
              >
                Remove
              </button>
            </div>

            <div className="vt-field">
              <div className="vt-label">
                <span>Frequency</span>
                <span>{selected.frequency.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={frequencyRange.min}
                max={frequencyRange.max}
                step={frequencyRange.step}
                value={selected.frequency}
                onChange={(event) => update(selected.id, { frequency: Number(event.target.value) })}
              />
              <div className="vt-hint">How common the word is in English. Higher turns up more often.</div>
            </div>

            <div className="vt-field">
              <div className="vt-label">
                <span>Description</span>
              </div>
              <textarea
                rows={2}
                value={selected.description}
                placeholder="What it means, in a few words"
                onChange={(event) => update(selected.id, { description: event.target.value })}
              />
            </div>

            <div className="vt-section">
              <h3>
                <span>Context</span>
                <span className="vt-faint">{selected.contexts.length} link(s)</span>
              </h3>
              <div className="vt-hint" style={{ marginBottom: 6 }}>
                Words this one pulls towards. A strong link makes that word likely to turn up nearby;
                links also count in reverse, scaled by the flow’s symmetry setting.
              </div>

              {orderedContexts
                .map((ordered) => selected.contexts.find((context) => context.id === ordered.id))
                .filter((context): context is NonNullable<typeof context> => context !== undefined)
                .map((context) => {
                  const target = index.byId.get(context.id);
                  return (
                    <div className="vt-context-row" key={context.id}>
                      <button
                        type="button"
                        className="vt-context-name"
                        onClick={() => setSelectedId(context.id)}
                        title="Open this word"
                      >
                        {target ? lexemeLabel(target) : `(missing: ${context.id})`}
                      </button>
                      <input
                        type="range"
                        min={weightRange.min}
                        max={weightRange.max}
                        step={weightRange.step}
                        value={context.weight}
                        aria-label={`Weight for ${target?.spelling ?? context.id}`}
                        onChange={(event) =>
                          update(selected.id, {
                            contexts: setContextWeight(selected, context.id, Number(event.target.value)),
                          })
                        }
                      />
                      <span className="vt-context-weight">{context.weight.toFixed(2)}</span>
                      <button
                        type="button"
                        className="vt-btn is-ghost is-small is-danger"
                        title="Remove this link"
                        onClick={() =>
                          update(selected.id, { contexts: setContextWeight(selected, context.id, 0) })
                        }
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              {selected.contexts.length === 0 ? (
                <div className="vt-empty">No links yet — this word only turns up on frequency.</div>
              ) : null}

              <div className="vt-row" style={{ marginTop: 8 }}>
                <input
                  value={contextQuery}
                  placeholder="Link to another word…"
                  aria-label="Find a word to link to"
                  onChange={(event) => setContextQuery(event.target.value)}
                />
              </div>
              <div className="vt-context-candidates">
                {contextCandidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="vt-btn is-small"
                    onClick={() => {
                      update(selected.id, { contexts: setContextWeight(selected, candidate.id, 0.7) });
                      setContextQuery('');
                    }}
                  >
                    + {lexemeLabel(candidate)}
                  </button>
                ))}
              </div>
            </div>

            <div className="vt-section">
              <h3>Pulled towards this word</h3>
              <div className="vt-hint">Other entries that list it in their own context.</div>
              <div className="vt-context-candidates" style={{ marginTop: 6 }}>
                {[...(index.backward.get(selected.id)?.entries() ?? [])]
                  .sort((a, b) => b[1] - a[1])
                  .map(([id, weight]) => {
                    const source = index.byId.get(id);
                    if (!source) return null;
                    return (
                      <button
                        key={id}
                        type="button"
                        className="vt-btn is-small is-ghost"
                        onClick={() => setSelectedId(id)}
                      >
                        {lexemeLabel(source)} · {weight.toFixed(2)}
                      </button>
                    );
                  })}
                {(index.backward.get(selected.id)?.size ?? 0) === 0 ? (
                  <span className="vt-faint">Nothing points here yet.</span>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
