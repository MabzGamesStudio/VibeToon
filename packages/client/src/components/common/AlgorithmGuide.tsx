import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { guideFor, type AlgorithmGuide, type GuideStep } from '@vibetoon/shared';

type Tab = 'overview' | 'pseudocode' | 'detail' | 'reading';

const TABS: Array<[Tab, string]> = [
  ['overview', 'Overview'],
  ['pseudocode', 'Pseudocode'],
  ['detail', 'In detail'],
  ['reading', 'Further reading'],
];

/** `**bold**` and `` `code` `` inside a line of guide text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    out.push(token.startsWith('**') ? <strong key={at}>{token.slice(2, -2)}</strong> : <code key={at}>{token.slice(1, -1)}</code>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Guide text: paragraphs split by a blank line, `- ` bullets. */
export function GuideText({ text }: { text: string }): JSX.Element {
  const blocks = text.split(/\n\s*\n/);
  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n');
        if (lines.every((line) => line.trim().startsWith('- '))) {
          return (
            <ul key={index}>
              {lines.map((line, k) => (
                <li key={k}>{inline(line.trim().slice(2))}</li>
              ))}
            </ul>
          );
        }
        // A paragraph that leads into a list.
        const first = lines.findIndex((line) => line.trim().startsWith('- '));
        if (first > 0) {
          return (
            <Fragment key={index}>
              <p>{inline(lines.slice(0, first).join(' '))}</p>
              <ul>
                {lines.slice(first).map((line, k) => (
                  <li key={k}>{inline(line.trim().replace(/^- /, ''))}</li>
                ))}
              </ul>
            </Fragment>
          );
        }
        return <p key={index}>{inline(lines.join(' '))}</p>;
      })}
    </>
  );
}

/** The steps as a flow diagram: boxes in order, loops as frames, tests with the way out when they fail. */
export function FlowDiagram({ steps }: { steps: readonly GuideStep[] }): JSX.Element {
  return (
    <div className="vt-flowchart">
      {steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 ? <div className="vt-flowchart-arrow" aria-hidden="true" /> : null}
          <DiagramStep step={step} />
        </Fragment>
      ))}
    </div>
  );
}

function DiagramStep({ step }: { step: GuideStep }): JSX.Element {
  if (step.kind === 'loop') {
    return (
      <div className="vt-flowchart-loop">
        <div className="vt-flowchart-loop-head">
          <span aria-hidden="true">↻</span> {inline(step.title)}
        </div>
        {step.detail ? <div className="vt-flowchart-detail">{inline(step.detail)}</div> : null}
        <FlowDiagram steps={step.steps} />
      </div>
    );
  }
  if (step.kind === 'decision') {
    return (
      <div className="vt-flowchart-decision-row">
        <div className="vt-flowchart-box is-decision">
          <div className="vt-flowchart-title">{inline(step.title)}</div>
          {step.detail ? <div className="vt-flowchart-detail">{inline(step.detail)}</div> : null}
          <span className="vt-flowchart-yes">yes ↓</span>
        </div>
        <div className="vt-flowchart-no">
          <span className="vt-flowchart-no-arrow">no →</span>
          <span>{inline(step.no)}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`vt-flowchart-box is-${step.kind}`}>
      <div className="vt-flowchart-title">{inline(step.title)}</div>
      {step.detail ? <div className="vt-flowchart-detail">{inline(step.detail)}</div> : null}
    </div>
  );
}

/** One flow's guide, in tabs. */
export function GuideBody({ guide }: { guide: AlgorithmGuide }): JSX.Element {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <>
      <div className="vt-facet-values vt-guide-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`vt-chip${tab === id ? ' is-on' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="vt-guide-body">
        {tab === 'overview' ? (
          <>
            <p className="vt-guide-summary">{inline(guide.summary)}</p>
            {guide.tryIt ? (
              <p className="vt-guide-try">
                <b>See it work:</b> {inline(guide.tryIt)}
              </p>
            ) : null}
            <h3>The steps</h3>
            <FlowDiagram steps={guide.steps} />
          </>
        ) : tab === 'pseudocode' ? (
          <>
            <p className="vt-faint">The same steps, as code. Comments say why.</p>
            <pre className="vt-guide-code">{guide.pseudocode}</pre>
          </>
        ) : tab === 'detail' ? (
          <>
            {guide.sections.map((section) => (
              <section key={section.heading}>
                <h3>{section.heading}</h3>
                <GuideText text={section.body} />
              </section>
            ))}
            {guide.settings && guide.settings.length > 0 ? (
              <section>
                <h3>What each setting changes</h3>
                <dl className="vt-guide-settings">
                  {guide.settings.map((setting) => (
                    <Fragment key={setting.name}>
                      <dt>{setting.name}</dt>
                      <dd>{inline(setting.effect)}</dd>
                    </Fragment>
                  ))}
                </dl>
              </section>
            ) : null}
            {guide.cost ? (
              <section>
                <h3>How long it takes</h3>
                <GuideText text={guide.cost} />
              </section>
            ) : null}
          </>
        ) : (
          <>
            <ul className="vt-guide-resources">
              {guide.resources.map((resource) => (
                <li key={resource.title}>
                  {resource.url ? (
                    <a href={resource.url} target="_blank" rel="noreferrer noopener">
                      {resource.title}
                    </a>
                  ) : (
                    <strong>{resource.title}</strong>
                  )}
                  <span> — {inline(resource.note)}</span>
                </li>
              ))}
            </ul>
            <h3>In the code</h3>
            <ul className="vt-guide-resources">
              {guide.source.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

/** The guide for a flow kind, over everything, until closed. */
export function AlgorithmGuideView({ kind, onClose }: { kind: string; onClose(): void }): JSX.Element | null {
  const guide = guideFor(kind);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  if (!guide) return null;
  return (
    <div className="vt-guide-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="vt-guide" role="dialog" aria-label={`How it works: ${guide.title}`}>
        <header className="vt-row">
          <div>
            <div className="vt-faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              How it works
            </div>
            <h2>{guide.title}</h2>
          </div>
          <span className="vt-spacer" />
          <button type="button" className="vt-btn is-ghost is-small" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <GuideBody guide={guide} />
      </div>
    </div>
  );
}
