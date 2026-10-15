# Microclaw: an AI assistant for Microsoft 365

Microclaw lives in Microsoft Teams. It reads and acts on a user's email, calendar, Teams chats, files,
Excel workbooks, tasks and contacts through 87 tools over Microsoft Graph, using Azure OpenAI function
calling. I built it on my own, working agent-first in Claude Code: I made the design and product calls and
ran the evaluations below.

It passed Microsoft's Marketplace and Teams Store certification and was published on Microsoft AppSource
(May 2026) and the Teams Store (August 2026). It never had a paying customer, and the hosted service has
been shut down since October 2026.

The product repository is private. This repository holds selected code, copied from it unchanged except
where a `// [excerpt: …]` marker says what was cut or adapted, plus the tool-selection test data and an
evaluation you can re-run offline.

## Results

| What was measured | Result | Reproduce |
|---|---|---|
| **Tool selection.** On 362 requests written blind by a separate agent that saw only the tool catalogue, how often every tool the request needed was offered | **98.1%** (355 / 362), vs **87.0%** for the selector production used | `npm run eval:selection`, offline, ~15 s |
| **Agent eval.** 142 cases, offline replay: did the agent call the right tools | **134 of 142** on average over three runs, the same as sending all tools, with **49% fewer prompt tokens** per message\* | Not here: needs the full agent and its Microsoft 365 fixtures |
| **A rejected design.** Offer only the top 3 tools plus a `find_tools` tool | Cheaper, but 125 of 142, and once it said it had saved an automation it hadn't | |

\* Three runs each, measured with 85 tools, before two email-drafting tools were added.

The method, both sealed sets, what changed from the old selector and the limits are in
[`eval-data/tool-selection/README.md`](eval-data/tool-selection/README.md).

## How a message is handled

```
Teams message
  │
  ├─ Tool selection (src/tool-selection/)
  │    Each tool is scored by its best embedding match: its own description, or any of 1,053
  │    labelled example requests. Plus tools from the previous exchange, per-clause tools for
  │    multi-part requests, contact lookup, and keyword routing. About 21 of 87 tools go out.
  │
  ├─ Model routing: gpt-4.1-mini by default, gpt-5.1 for long or multi-step work
  │
  ├─ Tool loop (excerpts/agent-loop/runner.ts)
  │    model asks for tools → permission check → Microsoft Graph, as the signed-in user → repeat
  │    Guards: bounded 429 retries, a repeated-call check, a 35-call cap per turn, context
  │    compaction on timeout, and a retry with all tools if the reply shows a tool was missing
  │
  └─ Reply
```

## Guardrails

- **Delegated sign-in.** Each user signs in with their own Microsoft 365 account. Microclaw can only do
  what that user's account can do.
- **Writes are off until the user turns them on.** Sending, drafting, calendar changes, file edits and
  the rest each have a toggle, checked in code before the tool runs. With no settings on record the check
  fails closed, and an organization admin can switch a capability off for everyone.
  See `excerpts/permissions/`.
- **Tenant isolation.** Postgres row-level security is forced on every tenant table, and the tenant is
  bound to each transaction. Data access with no tenant context throws instead of falling back to a
  default. See `excerpts/tenancy/`. The policy SQL and the CI test that checks every table aren't included.

## What's here

| Path | Contents |
|---|---|
| `src/tool-selection/` | The selector's ranking code, keyword routing, all 1,053 labelled examples, the tool catalogue, tests |
| `src/eval/` | The agent-eval scorer and its tests, with 13 of the 142 cases |
| `src/timezone/` | Reminder-time parsing: a time the user says is their local wall-clock; the server does the conversion |
| `src/pricing/` | Token prices, keyed by the model Azure says it served, not the deployment name |
| `scripts/` | The offline tool-selection eval, and a demo that scores one eval case two ways |
| `eval-data/tool-selection/` | Sealed test sets #2 and #3, the write-up, per-tool token sizes, precomputed embeddings |
| `excerpts/` | Read-only extracts: the agent loop, permissions, tenant binding. They don't compile on their own |

## Run it

```
npm install --legacy-peer-deps
npm test                 # 41 tests: selection ranking, eval scorer, timezone parsing, pricing
npm run eval:selection   # re-scores sealed sets #3 and #2, offline
npm run demo:score       # one case scored two ways: a draft passes, an unasked send fails
```

`eval:selection` prints each file separately. Sealed set #3 is `test3.json` plus `followups-test3.json`:
281 + 74 = 355 of 362 for `current`, and 252 + 63 = 315 for `legacy`, the selector production used.

## What the evals don't show

- **Coverage says the right tool was offered, not that the task succeeded.**
- **The agent eval's headline checks which tools were called**, not their arguments or whether the answer
  was right. A text check exists, but it matches literal words and is too strict to quote.
- **The test requests were written by a language model**, not real users. The 142 agent-eval cases were
  also used to choose the design; the sealed sets were scored once.

The evals caught one bug: the agent confirmed a saved automation as "Deleted:", copying an example from
its prompt. They missed another: "from now on, handle my briefing automatically" saved a memory note
instead of scheduling anything, and the case passed because it didn't require a saved automation. Both
are fixed, and that case now requires one.

## What I'd change next

- Check outbound recipients deterministically, so mail can't go to an address that first appeared in
  content the agent read.
- Return malformed tool arguments to the model as an error instead of running the tool with none.
- Keep tool calls and their results together when compacting context.
- Make a missing user timezone fail loudly instead of borrowing another user's.
- Grade tool arguments against the fixture data, not just tool names.

## Paths in copied comments

Comments copied from the product refer to its paths. `src/agent/embeddings.ts` and
`src/agent/training-data.ts` are in `src/tool-selection/` here, `eval/agent/` is `src/eval/`,
`eval/tool-selection/` is `eval-data/tool-selection/`, and `scripts/eval-tool-selection.ts` is in
`scripts/`. The rest of what they mention, such as the tuning sets, the agent-eval fixtures and the
rejected design's branch, stays in the private repository.

No open-source license. Shared so you can read and run it.
