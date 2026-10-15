# Tool-selection evaluation

Microclaw has 87 tools. Every tool definition sent costs prompt tokens on every model
call (all 85 measure 10,198 tokens; per-tool sizes are in `tool-tokens.json`), so a
selector picks the ones relevant to each message. If it leaves out a tool the request
needs, the model can't do the task. This directory measures that: **coverage** is the
share of requests for which every needed tool was offered, and **avg tools offered** is
the cost side. The end-to-end effect (did the agent do the job, at what cost) is
measured by the agent eval; results are at the end of this file.

Run it with `npx tsx scripts/eval-tool-selection.ts eval/tool-selection/test3.json`.
The harness calls the production selection code (`selectToolNames` in
`src/agent/embeddings.ts`, `unionKeywordTools` in `src/agent/runner.ts`). Only the
embedding call goes to Azure OpenAI, and the vectors are cached locally.

## Data

Every case is synthetic, uses invented names and `example.com` addresses, and was
written by a separate agent that could see only the tool catalogue, never
`src/agent/training-data.ts`. Labels give the **minimal** set of tools a request needs.
`alt_map` lists acceptable substitutes.

| File | Cases | Role |
|---|---|---|
| `dev.json`, `followups-dev.json` | 200 + 50 | Used to design and tune the selector |
| `tune.json`, `followups-tune.json` | 250 + 70 | First held-out set. Its misses were looked at and used to pick the final sizes, so it now counts as tuning data |
| `test.json`, `followups-test.json` | 300 + 80 | Sealed set #2. Written after the design was frozen and scored once (2026-10-13) |
| `test3.json`, `followups-test3.json` | 300 + 80 | **Sealed set #3.** Written by a separate agent (the same model that wrote set #2) that could read only the tool catalogue, after the agent-eval comparison had picked this design; scored once (2026-10-13). These are the numbers to quote |

Follow-up cases ("yes", "the second one", "move greg to 3") carry the previous
exchange in `prev_user` / `prev_assistant`. Cases that need no tool are excluded from
coverage.

## Results on the sealed sets (2026-10-13)

Sealed set #3, the one to quote:

| | Standalone (285) | Follow-ups (77) | Combined (362) | Avg tools offered | Unneeded tools per message |
|---|---|---|---|---|---|
| Before: KNN at ≥0.80, else description top-18, plus keywords | 88.8% | 81.8% | 87.3% (95% CI 83.5–90.3) | 21.8 | 20.0 |
| **Now** | **98.9%** | **96.1%** | **98.3% (95% CI 96.4–99.2)** | 21.1 | 19.1 |

"Unneeded" = offered tools that are neither a label nor an accepted substitute. A
request needs 1.8 tools on average. Sealed set #2 gave the same picture: 85.6% before,
98.3% now (combined, 361 cases).

So the redesign is a **coverage** gain, not a size cut: both send about 21 tools. What
cut the token cost was dropping the duplicate tool list from the system prompt (see
below).

Mid-conversation, the context component adds tools to every message. Pairing each
standalone case with an unrelated previous exchange puts the average at **24.9**, about
3 tools more than before. Coverage on that run was 98.6%.

## What changed, and why

The old selector used KNN over 1,045 training examples, but only when the nearest
example scored at least 0.80; otherwise it fell back to description similarity, top 18.
On unseen phrasing the threshold was rarely met. On 117 messages logged by the deployed
service (development and review traffic), the nearest example cleared 0.80 only 14.5%
of the time, so about 85% of those messages were routed by description similarity alone. The earlier "95% recall" figure
(archived at `archive/scripts/compare-tool-selection.ts`) measured a different
selector from the one that shipped: it scored the 7 nearest training examples on
every query, with no 0.80 gate, on a random 80/20 split of the same synthetic
training set. Re-running that procedure with a recorded seed
(`demo/evidence/build-leak.ts`, 2026-10-14): ungated, the 7 nearest examples held
every needed tool for 85% of held-out requests (79% on sealed set #3, so
same-generator wording added a few points); with production's 0.80 gate, the
training examples applied to only 7% of held-out requests (11% on sealed set #3).
An earlier version of this README said near-copies of each test query sat in the
training half; the re-run doesn't support that (median nearest similarity 0.68).

The new selector (`src/agent/embeddings.ts`):

1. **Scores each tool** by its best match: the tool's own description, or any training
   example labelled with it. It takes the top 14, plus anything within 0.05 of the best.
2. **Adds the previous exchange.** Up to 8 more tools come from ranking the previous
   turn plus the current message, so follow-ups keep their tools.
3. **Adds per-clause tools.** Up to 4 more tools come from each clause of a multi-part
   request ("find the memo **and** email them"), because one embedding averages the
   intents together.
4. **Adds address resolution.** Any selected tool whose schema takes email addresses
   (`to`, `cc`, `attendees`, ...) brings `search_contacts` and `search_people`, so a name
   can be turned into an address.
5. **Keeps the keyword union** (`unionKeywordTools`) and `send_message`, unchanged.

Everything still goes out in one embeddings request per message.

## End-to-end: the agent eval (2026-10-13 and 10-14)

Each design ran the 142-case agent eval (`eval/agent/`) offline, inline system prompt,
gpt-4.1-mini escalating to gpt-5.1, with 85 tools. "Did the job" = called the expected
tools and no forbidden one. Every row is without the duplicate tool list (below).
Cost is per 142 messages at Azure list prices: "no caching" charges every prompt token
in full; "cached" applies the discount Azure gave on these runs. Production falls
between the two, since the clock at the top of the system prompt changes every minute
and breaks caching across messages, though not across calls within one
(`eval/agent/pricing.ts`). Digest: `demo/evidence/build-results.ts`.

| | Runs | Did the job (of 142) | Prompt tokens per message | Cost, no caching | Cost, cached |
|---|---|---|---|---|---|
| All 85 tools | 3 | 134.3 (136, 133, 134) | 33,900 | $2.90 | $0.72 |
| **Now: this selector** | 3 | **134.3 (136, 132, 135)** | **17,200** | **$1.50** | **$0.51** |
| Before: the old selector | 1 | 131 | 17,500 | $1.53 | $0.61 |
| Rejected: top 3 + `find_tools` | 1 | 125 | 15,000 | $1.30 | $0.44 |

- **This design did the job as often as sending every tool, with 49% fewer prompt
  tokens** (48% less at list price, 28% less cached). For the "all tools" row, the
  first run's pass count is included; its tokens and cost are not, because it still
  carried the duplicate list.
- **Against the old selector this is a coverage gain, not a cost cut.** Both send about
  21 tools. The old selector's one run (131) is inside this design's range, so the
  eval doesn't show it doing the job less often; the sealed sets above show where it
  misses (e.g. "set up a meeting with Carlos at 11" got no calendar tools).
- **The duplicate list** in the system prompt repeated every offered tool's description,
  about 61 tokens per tool per call (5,197 for all 85, measured). Removing it cut the old
  selector's prompt tokens 12% (19,900 → 17,500; cost 11%) and didn't change how often
  the job got done. That, not the selector, is where the cost cut against the old system
  came from.
- **Rejected: top 3 + `find_tools`.** Sending only the 3 likeliest tools plus a tool the
  model could call to fetch more cut unneeded tools from ~19 to ~6 per message, but the
  model called `find_tools` in only 11 of 142 cases. Usually it made do with the wrong
  tools. Once it said it had saved an automation it hadn't, and once it presented an
  unsaved rule as if it were set up. The code is on branch `feat/lean-tool-selection`.
- **Stability:** over the three runs of this design, 131 cases passed every time, 5
  failed every time and 6 varied.

**87 tools (2026-10-15).** `create_draft` and `send_draft` were added after these runs.
Re-scored with 87 tools, sealed set #3 combined is 98.1% (355 / 362; one request,
t3-050, now misses `update_event` by one place in the ranking) and sealed set #2 is
unchanged at 98.3%. Nothing was tuned on either set.

## Known limits

- **The labels and the test cases come from one LLM author, not real users.** They were
  written blind to the training data, but they share that author's sense of what's
  "minimal". A few labels are debatable. For example, "share the spreadsheet with
  ana@example.com" is labelled with `send_mail`, where `create_sharing_link` alone might
  do.
- **Remaining misses on the sealed set:**
  - CRUD actions within a topic the selector has right ("add X to the plan", "update
    Jonah's email ... then add him to friday"). Embeddings capture the topic much better
    than the verb.
  - Lookups the model needs before acting (`list_sharepoint_sites`, `list_planner_plans`).
- **The service's own logs aren't a fair test of the old selector.** The 117 logged
  messages are labelled with the tools the model actually called, and those were
  offered by the old selector in the first place, so it scores 100% by construction.
  They aren't committed; they contain user messages.
- **Coverage is necessary, not sufficient.** It says the right tool was offered, not
  that the model used it well. The agent eval above covers that side.
- **Token figures are for the eval's deployments** (measured 2026-10-13 from the API's
  `prompt_tokens`); other models tokenise tool schemas slightly differently.
