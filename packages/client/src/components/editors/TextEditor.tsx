import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_RANDOM_TEXT_OPTIONS,
  LENGTH_MODES,
  LENGTH_MODE_LABEL,
  glossTokens,
  renderParts,
  resolveTextRun,
  runRandomText,
  summariseGloss,
  type FlowNode,
  type LengthMode,
  type Project,
  type RandomTextOptions,
  type TextFlowData,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { useView } from '../../state/view';
import { Field } from '../common/Field';
import { InfoTip } from '../common/InfoTip';
import { Slider } from '../common/Slider';
import { EditorShell } from './EditorShell';
import { LexiconEditor } from './LexiconEditor';
import { useUpstreamText } from './useUpstreamText';

const SEED_WORDS = ['rain', 'gear', 'lamp', 'brass', 'quiet', 'ember', 'thread', 'hollow', 'drift', 'salt'];

export function TextEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data as TextFlowData;
  const { view: prefs } = useView();
  const [tab, setTab] = useState<'text' | 'lexicon'>('text');
  // TEMPORARY: the type/variant view of the output. See text/tokenGloss.ts.
  const [gloss, setGloss] = useState(false);
  // Rerunning the generator on every keystroke is the most expensive thing the
  // studio does, so whether it starts on is a preference.
  const [live, setLive] = useState(prefs.livePreview);
  const upstream = useUpstreamText(project, node);

  const patch = useCallback(
    (change: Partial<TextFlowData>) => setFlowData(node.id, { ...data, ...change }),
    [data, node.id, setFlowData],
  );

  const setOption = useCallback(
    <K extends keyof RandomTextOptions>(key: K, value: RandomTextOptions[K]) => {
      patch({ options: { ...data.options, [key]: value } });
    },
    [data.options, patch],
  );

  const setLength = useCallback(
    <K extends keyof RandomTextOptions['length']>(key: K, value: RandomTextOptions['length'][K]) => {
      patch({ options: { ...data.options, length: { ...data.options.length, [key]: value } } });
    },
    [data.options, patch],
  );

  // The preview runs the same engine the server does, over the same resolved
  // inputs, so what you see here is what the artifact will hold.
  const resolved = useMemo(
    () => resolveTextRun(data, upstream.sources),
    [data, upstream.sources],
  );

  const preview = useMemo(() => {
    if (!live) return null;
    try {
      return runRandomText({
        input: resolved.input,
        options: resolved.options,
        lexicon: resolved.lexicon,
        grammar: resolved.grammar,
      });
    } catch (error) {
      return { error: (error as Error).message } as const;
    }
  }, [live, resolved]);

  const result = preview && !('error' in preview) ? preview : null;
  const parts = useMemo(() => (result ? renderParts(result.tokens) : []), [result]);
  // TEMPORARY: what each written token actually is, read back against the
  // database the run wrote from.
  const glosses = useMemo(
    () => (result && gloss ? glossTokens(result.tokens, resolved.lexicon) : []),
    [gloss, resolved.lexicon, result],
  );
  const glossStats = useMemo(() => summariseGloss(glosses), [glosses]);
  const upstreamText = upstream.sources.find((source) => source.port === 'text' && source.text);
  const upstreamGrammar = upstream.sources.find((source) => source.port === 'grammar' && source.grammar)?.label;
  const stats = result?.stats;
  const options = resolved.options;
  const overridden = JSON.stringify(options) !== JSON.stringify(data.options);

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={async () => {
        await generateFlow(node.id);
      }}
      actions={
        <>
          <div className="vt-tabs">
            <button
              type="button"
              className={`vt-btn is-small${tab === 'text' ? ' is-active' : ''}`}
              onClick={() => setTab('text')}
            >
              Text
            </button>
            <button
              type="button"
              className={`vt-btn is-small${tab === 'lexicon' ? ' is-active' : ''}`}
              onClick={() => setTab('lexicon')}
            >
              Word database
            </button>
          </div>
          <button
            type="button"
            className="vt-btn is-small"
            title="New seed — the same settings, a different draw"
            onClick={() => {
              const word = SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)]!;
              setOption('seed', `${word}-${Math.floor(Math.random() * 900 + 100)}`);
            }}
          >
            ↻ Reroll
          </button>
        </>
      }
    >
      {tab === 'lexicon' ? (
        <div className="vt-editor-main" style={{ padding: 0, display: 'flex', minHeight: 0 }}>
          <LexiconEditor lexicon={data.lexicon} onChange={(lexicon) => patch({ lexicon })} />
        </div>
      ) : (
        <>
          <aside className="vt-editor-side">
            <div className="vt-section">
              <h3>
                What the run does
                <InfoTip tip="text.mode" label="What the run does" />
              </h3>
              <div className="vt-mode-picker">
                {(['generate', 'alter'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`vt-mode${options.mode === mode ? ' is-active' : ''}`}
                    onClick={() => setOption('mode', mode)}
                  >
                    <div>
                      <strong>{mode === 'generate' ? 'Generate' : 'Alter'}</strong>
                      <span>
                        {mode === 'generate'
                          ? 'Write new text from the database.'
                          : 'Rewrite the text that comes in.'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              <Field label="Seed" tip="text.seed" hint="The same seed and settings always write the same text.">
                <input value={data.options.seed} onChange={(event) => setOption('seed', event.target.value)} />
              </Field>
            </div>

            <div className="vt-section">
              <h3>Length</h3>
              <Field label="Measured by" tip="text.length.mode">
                <select
                  value={options.length.mode}
                  onChange={(event) => setLength('mode', event.target.value as LengthMode)}
                >
                  {LENGTH_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {LENGTH_MODE_LABEL[mode]}
                    </option>
                  ))}
                </select>
              </Field>

              {options.length.mode === 'words' ? (
                <Field label="Words" tip="text.length.words">
                  <input
                    type="number"
                    min={1}
                    value={data.options.length.words}
                    onChange={(event) => setLength('words', Number(event.target.value) || 1)}
                  />
                </Field>
              ) : null}
              {options.length.mode === 'characters' ? (
                <Field label="Characters" tip="text.length.characters">
                  <input
                    type="number"
                    min={1}
                    step={10}
                    value={data.options.length.characters}
                    onChange={(event) => setLength('characters', Number(event.target.value) || 1)}
                  />
                </Field>
              ) : null}
              {options.length.mode === 'wordPercent' ? (
                <Slider
                  label="Change in words"
                  tip="text.length.wordPercent"
                  min={-90}
                  max={200}
                  step={5}
                  value={data.options.length.wordPercent}
                  format={(value) => `${value > 0 ? '+' : ''}${value}%`}
                  hint="Against the length of the text coming in."
                  onChange={(value) => setLength('wordPercent', value)}
                />
              ) : null}
              {options.length.mode === 'charPercent' ? (
                <Slider
                  label="Change in characters"
                  tip="text.length.charPercent"
                  min={-90}
                  max={200}
                  step={5}
                  value={data.options.length.charPercent}
                  format={(value) => `${value > 0 ? '+' : ''}${value}%`}
                  hint="Against the length of the text coming in."
                  onChange={(value) => setLength('charPercent', value)}
                />
              ) : null}

              <Slider
                label="Length temperature"
                tip="text.length.temperature"
                value={data.options.length.temperature}
                hint={
                  stats?.plan
                    ? `Target ${stats.plan.target} ${stats.plan.metric} ±${stats.plan.tolerance}.`
                    : 'How far off the target a run may land, so a sentence can finish.'
                }
                onChange={(value) => setLength('temperature', value)}
              />
            </div>

            <div className="vt-section">
              <h3>How words are picked</h3>
              <Slider
                label="Alter temperature"
                tip="text.alterTemperature"
                value={data.options.alterTemperature}
                hint="Share of the incoming words this run may replace. Only used when altering."
                onChange={(value) => setOption('alterTemperature', value)}
              />
              <Slider
                label="Pick temperature"
                tip="text.pickTemperature"
                min={0.02}
                value={data.options.pickTemperature}
                hint="0 always takes the strongest candidate; 1 draws straight from the scores."
                onChange={(value) => setOption('pickTemperature', value)}
              />
              <Slider
                label="Context window"
                tip="text.contextWindow"
                min={0}
                max={8}
                step={1}
                value={data.options.contextWindow}
                format={(value) => `${value} token${value === 1 ? '' : 's'}`}
                hint="How many previous words are allowed to pull on the next one."
                onChange={(value) => setOption('contextWindow', value)}
              />
              <Slider
                label="Context decay"
                tip="text.contextDecay"
                value={data.options.contextDecay}
                hint="How fast that pull fades further back in the window."
                onChange={(value) => setOption('contextDecay', value)}
              />
              <Slider
                label="Frequency bias"
                tip="text.frequencyBias"
                value={data.options.frequencyBias}
                hint="0 lets context decide everything; 1 just uses how common a word is."
                onChange={(value) => setOption('frequencyBias', value)}
              />
              <Slider
                label="Context symmetry"
                tip="text.contextSymmetry"
                value={data.options.contextSymmetry}
                hint="How much a link read backwards counts — `tree` listing `apple` pulling apple → tree."
                onChange={(value) => setOption('contextSymmetry', value)}
              />
              <Slider
                label="Grammar bias"
                tip="text.grammarBias"
                value={data.options.grammarBias}
                hint="How strictly word order is followed. 0 is word soup."
                onChange={(value) => setOption('grammarBias', value)}
              />
              <Slider
                label="Grammar database"
                tip="text.grammarWeight"
                value={data.options.grammarWeight}
                hint={
                  upstreamGrammar
                    ? `Writing into sentence shapes from ${upstreamGrammar}.`
                    : 'Nothing yet — wire a Grammar Database flow into the Grammar database input.'
                }
                onChange={(value) => setOption('grammarWeight', value)}
              />
              <Slider
                label="Sentence length"
                tip="text.sentenceLength"
                min={3}
                max={40}
                step={1}
                value={data.options.sentenceLength}
                format={(value) => `${value} words`}
                hint="Where punctuation starts wanting to end the sentence."
                onChange={(value) => setOption('sentenceLength', value)}
              />
              <button
                type="button"
                className="vt-btn is-small"
                onClick={() =>
                  patch({
                    options: {
                      ...DEFAULT_RANDOM_TEXT_OPTIONS,
                      seed: data.options.seed,
                      mode: data.options.mode,
                      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length },
                    },
                  })
                }
              >
                Reset settings
              </button>
            </div>
          </aside>

          <div className="vt-editor-main">
            {overridden ? (
              <div className="vt-sync-banner" style={{ marginBottom: 10 }}>
                <span>
                  Rules on an incoming connection are overriding this flow’s settings for the run
                  {options.mode !== data.options.mode ? ` (mode: ${options.mode})` : ''}.
                </span>
              </div>
            ) : null}

            <Field
              label={upstreamText ? 'Input (from upstream)' : 'Input'}
              tip="text.input"
              hint={
                upstreamText
                  ? `Coming from ${upstreamText.label}. The text below is kept for when nothing is wired in.`
                  : 'The text to rewrite. Leave it empty to write from nothing.'
              }
              aside={
                <span className="vt-faint">
                  {stats ? `${stats.inputWords} words · ${stats.inputCharacters} characters` : ''}
                </span>
              }
            >
              <textarea
                rows={5}
                value={upstreamText?.text ?? data.input}
                readOnly={Boolean(upstreamText)}
                placeholder="Paste or write the text this flow should work from…"
                onChange={(event) => patch({ input: event.target.value })}
              />
            </Field>

            <div className="vt-row" style={{ margin: '12px 0 8px' }}>
              <strong>Output</strong>
              {stats ? (
                <span className="vt-faint">
                  {stats.outputWords} words · {stats.outputCharacters} characters
                  {stats.inputWords > 0
                    ? ` · ${stats.wordChangePercent >= 0 ? '+' : ''}${stats.wordChangePercent.toFixed(0)}% words`
                    : ''}
                  {stats.replaced > 0 ? ` · ${stats.replaced} replaced` : ''}
                  {stats.added > 0 && stats.mode === 'alter' ? ` · ${stats.added} added` : ''}
                  {stats.removed > 0 ? ` · ${stats.removed} removed` : ''}
                </span>
              ) : null}
              <span className="vt-spacer" />
              <label className="vt-row" style={{ gap: 5 }}>
                <input
                  type="checkbox"
                  checked={live}
                  style={{ width: 'auto' }}
                  onChange={(event) => setLive(event.target.checked)}
                />
                <span className="vt-faint">live preview</span>
              </label>
              {/* TEMPORARY: see text/tokenGloss.ts for how to remove this. */}
              <button
                type="button"
                className={`vt-btn is-small${gloss ? ' is-active' : ''}`}
                disabled={!result}
                title="Show what each word is — noun:plural instead of cats — and whether it has variants at all"
                onClick={() => setGloss((current) => !current)}
              >
                {gloss ? 'Words' : 'Types'}
              </button>
              <button
                type="button"
                className="vt-btn is-small"
                disabled={!result}
                onClick={() => {
                  if (!result) return;
                  void navigator.clipboard?.writeText(result.text);
                  notify('info', 'Output copied.');
                }}
              >
                Copy
              </button>
            </div>

            {preview && 'error' in preview ? (
              <div className="vt-pill is-error">{preview.error}</div>
            ) : null}

            {!live ? (
              <div className="vt-empty">
                Live preview is off. Press Generate to run it and write the artifact.
              </div>
            ) : null}

            {result && gloss ? (
              /* TEMPORARY: the type/variant view. See text/tokenGloss.ts. */
              <>
                <div className="vt-gloss-legend">
                  <span className="vt-gloss has-variants">type:form</span> has variants ·{' '}
                  <span className="vt-gloss no-variants">type</span> no variants for this word type ·{' '}
                  <span className="vt-gloss is-unknown">?:word</span> not in the database
                  <span className="vt-spacer" />
                  <strong>
                    {glossStats.withVariants} of {glossStats.words}
                  </strong>{' '}
                  word(s) have variants
                  {glossStats.withoutVariants > 0 ? `, ${glossStats.withoutVariants} cannot` : ''}
                  {glossStats.unknown > 0 ? `, ${glossStats.unknown} unknown` : ''}
                </div>
                <div className="vt-text-output is-gloss">
                  {glosses.map((item, position) =>
                    item.label === '\n' || item.label === '\n\n' ? (
                      <br key={position} />
                    ) : (
                      <span
                        key={position}
                        className={`vt-gloss ${
                          item.unknown ? 'is-unknown' : item.hasVariants ? 'has-variants' : 'no-variants'
                        }`}
                        title={
                          item.variations
                            ? `${result.tokens[position]?.text} — ${Object.entries(item.variations)
                                .map(([form, spelling]) => `${form}: ${spelling}`)
                                .join(', ')}`
                            : item.unknown
                              ? `${result.tokens[position]?.text} — not in the word database`
                              : `${result.tokens[position]?.text} — a ${item.type} has no variants`
                        }
                      >
                        {item.label}
                      </span>
                    ),
                  )}
                </div>
              </>
            ) : result ? (
              <div className="vt-text-output">
                {parts.map((part, position) => (
                  <span
                    key={position}
                    className={`vt-tok is-${(result.tokens[position]?.origin ?? 'kept') as string}`}
                    title={result.tokens[position]?.origin}
                  >
                    {part.lead}
                    {part.text}
                  </span>
                ))}
              </div>
            ) : null}

            {result && stats?.mode === 'alter' ? (
              <div className="vt-row vt-faint" style={{ gap: 12, marginTop: 8, fontSize: 11 }}>
                <span className="vt-tok is-kept">kept</span>
                <span className="vt-tok is-replaced">replaced</span>
                <span className="vt-tok is-added">added</span>
              </div>
            ) : null}

            {result && result.warnings.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                {result.warnings.map((warning) => (
                  <div key={warning} className="vt-pill is-stale" style={{ marginRight: 6 }}>
                    {warning}
                  </div>
                ))}
              </div>
            ) : null}

            {result && stats && stats.unknownWords.length > 0 ? (
              <div className="vt-hint" style={{ marginTop: 10 }}>
                Not in the database, so nothing could be read from them:{' '}
                {stats.unknownWords.slice(0, 20).join(', ')}
                {stats.unknownWords.length > 20 ? `, +${stats.unknownWords.length - 20} more` : ''}.
              </div>
            ) : null}

            {upstream.error ? <div className="vt-pill is-error">{upstream.error}</div> : null}
          </div>
        </>
      )}
    </EditorShell>
  );
}
