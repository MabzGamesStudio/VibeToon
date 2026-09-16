# The API log

Everything the studio asks of the outside world is recorded: every dictionary
lookup and every corpus download, with what was asked, what came back, how long
it took, and which attempt it was. **Logs** in the header opens it.

## Why it exists

There was nowhere to see this. The server printed three lines at startup and
nothing else; a flow's run log covers generating only; and the browser's network
tab shows the call *into* this app, not the call this app makes *out* of it —
which is the half that fails. When a lookup of 2,000 words came back with 40
definitions, the reason existed nowhere at all.

## What a line says

| Column | What it is |
| --- | --- |
| Time | To the millisecond, because four requests in flight at once land within one. |
| Service | `dictionary` or `corpus`. |
| Outcome | What happened, not what was asked. |
| Subject | The word looked up, or the host fetched from. |
| Status | The HTTP status, when there was one. |
| Try | Shown from the second attempt on, so a retry storm is obvious at a glance. |
| Time taken | Milliseconds. A service that has started stalling shows up here before it starts failing. |
| Size | For a corpus, how much came back. |

Click a line for the full address and the reason it went the way it did.

| Outcome | Means |
| --- | --- |
| `ok` | Answered, and something useful came back. |
| `missing` | Answered, but has no entry for that word. It will not be asked again. |
| `cached` | Came off the disk cache; nothing left this machine. One line per batch, not per word. |
| `retry` | Failed, and is about to be tried again. |
| `rate-limited` | A 429 — the service asking us to slow down. |
| `timeout` | No answer within eight seconds. |
| `failed` | Failed for good. |

## Where it is kept

In memory, capped at a thousand entries so the viewer stays instant, and
appended to `data/logs/api.jsonl` so a server restart — which `npm run dev` does
on every save — does not throw away what you were reading. **Load from file**
reads that back, including whatever a restart lost. The file is capped at 2 MB
and rotated once to `api.jsonl.1`.

Anything in an address that looks like a credential — `key`, `token`, `secret`,
`app_id` and the like — is masked before it is stored, so a dictionary key from
the environment cannot end up in the file, or in a screenshot of the viewer.

## Using it

- **problems only** hides the successes, which is usually what you want when
  something is wrong.
- **live** tails as calls happen. It follows the bottom while you are at the
  bottom and leaves you alone the moment you scroll up to read something.
- **Copy as JSON** takes exactly what is filtered, for pasting into a bug report.
- **Clear** empties the buffer and the file.

The typical shape of a bad dictionary run: a run of `failed` lines all with the
same status is the service refusing you; `rate-limited` followed by `ok` is the
backoff working as intended; `retry` three times then `failed` is a service that
has gone away. What to do about each is in
[WORD-DATABASE.md](WORD-DATABASE.md#which-dictionary).
