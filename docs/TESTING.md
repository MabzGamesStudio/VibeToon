# Tests, and what the build insists on

```bash
npm test           # shared model + server API tests
npm run typecheck  # whole monorepo, including the test files
npm run build      # production client bundle
```

Every pull request runs all three, on the oldest Node the project claims to
support and the current one. The workflow is `.github/workflows/ci.yml`.

## Why typecheck is separate, and not optional

Tests run under `tsx`, which strips types rather than checking them. A test can
pass while being wrong about the types it uses — writing a stroke with a field
that does not exist, say — and only `npm run typecheck` will say so. Both run in
CI for that reason, and the first thing to try when CI fails but `npm test`
passed locally is `npm run typecheck`.

## Every flow editor is tested, and the build checks that

Nine flow kinds have an editor of their own, and an editor of its own means
logic of its own: how a corpus is ordered, how a beat is timed, what counts as a
drawn plate, what unticking a dataset does to the master.

`packages/shared/test/editorCoverage.test.ts` walks the flow registry — not a
list kept by hand — and fails when:

- a kind declares an editor with no matching `test/<editor>.test.ts`,
- that file holds fewer than eight tests, which is not coverage of a flow's data
  model, its edges and what it writes,
- an editor is not wired into the studio's `FlowEditor`,
- a flow that writes artifacts has no server test exercising what it writes,
- a flow kind is incoherent: no summary, no outputs, a port carrying nothing, or
  two ports sharing an id.

So adding a custom editor without testing it breaks the build, rather than being
noticed a year later. If you add one, the failure tells you the file to create.

## Where a test belongs

| Kind of thing | Where |
| --- | --- |
| Flow data: adding, removing, ordering, summarising | `packages/shared/test/<editor>.test.ts` |
| What a generator writes, end to end over HTTP | `packages/server/test/<editor>.test.ts` |
| The engines — tokenising, scoring, inflection, grammar | `packages/shared/test/` by subject |

Server tests run a real app against a temporary `VIBETOON_DATA`, so they write
real artifacts and read them back. Anything reaching the network is stubbed with
a local Express server or an injected `fetch`, so the suite passes offline.

## Things the suite guards that are easy to break

- **Settings a stored project predates.** A flow gaining a setting leaves a gap
  in every project already on disk, and reading that gap is how a slider gets
  handed `undefined`. `migrate.test.ts` covers the filling-in.
- **Every slider in Settings.** `sliderRanges.test.ts` reads the client source
  and fails if a slider does not name its range, names one not in the registry,
  or the registry holds a range no slider uses.
- **The (i) on every setting.** `settingTips.test.ts` reads the client source and
  fails if a control asks for a tip nobody wrote, or a tip is written that
  nothing shows.
