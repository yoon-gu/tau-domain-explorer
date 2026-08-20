# TAU Explorer

A minimal, grayscale explorer for the official [τ²-bench](https://github.com/sierra-research/tau2-bench) GPT-5 submission from Sierra.

The UI combines domain policy and runtime-prompt provenance with every selected trajectory. Conversations are shown as chat, and agent-side and user-side tool calls retain their exact names, arguments, results, errors, and requestor.

## Selected catalog

This snapshot intentionally contains only the three interactive GPT-5 runs from `gpt-5_sierra_2025-08-09`. It does not mix in earlier τ-bench runs, other models, workflow variants, or agent-only ablations.

| Domain | Agent tools | User tools | Tasks | Trajectories | Detail chunks | Passed | NL evaluator prompts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Airline | 14 | 0 | 50 | 200 | 10 | 125 | 200 |
| Retail | 15 | 0 | 114 | 456 | 23 | 372 | 32 |
| Telecom | 13 | 30 | 114 | 456 | 23 | 437 | 0 |
| **Total** | **42** | **30** | **278** | **1,112** | **56** | **934** | **232** |

Every task has four trials. Telecom is the collaborative tool-use environment: its customer simulator can operate device tools, and the explorer distinguishes those calls from agent-operated customer-service tools.

## What the context view shows

The context drawer exposes the actual components used by the recorded runtime:

- the exact 489-byte agent instruction from runtime commit `964ef7aed331ecf0c9bc592abdc2b4aecd941586`;
- the agent system template and the resolved template with the selected run's domain policy;
- the exact effective domain policy recorded in each result file, including Telecom's assembled `<main_policy>` and `<tech_support_policy>` document;
- the standard or tool-enabled user-simulator guideline, both as a template and resolved with the task's exact runtime scenario;
- the GPT-4o-mini natural-language evaluator system prompt and, for the 232 invocations, the exact per-trajectory user input and expected outcomes.

Each user-simulator prompt links to both sources that produced it: the runtime wrapper and the injected standard or tool-enabled guideline document. The recorded simulator model is shown exactly as `gpt-4.1-2025-04-14`.

The orchestrator's initial `Hi! How can I help you today?` greeting is a trajectory message, not part of the user-simulator prompt. Tool schemas were supplied to the model through the tool API rather than embedded in the agent system prompt.

## English / 한국어 display

The entire selected experience can switch between **EN** and **한국어**:

- all 278 task titles, description purposes, and natural-language scenario fields;
- 13,735 user/assistant message occurrences across all 1,112 trajectories;
- 72,782 human-readable string leaves inside tool arguments and results;
- all three domain policies, the agent and user-simulator prompt components, and 133 unique evaluator assertions;
- all 232 resolved evaluator user prompts.

The transcript source of truth contains 11,520 run-local translation entries and 11,499 globally unique role/content identities. The normalized trajectories contain 24,619 messages: 10,601 have null or empty bodies, while 14,018 are nonempty. Of those nonempty bodies, 283 are exact control-only messages (`###STOP###`, `###TRANSFER###`, or `###OUT-OF-SCOPE###`) and remain unchanged; the other 13,735 use Korean overlays.

The 15,157 tool calls contain 188,101 string-leaf occurrences (3,396 unique values). The `tau2-tool-ascii-prose-v1` classifier selects exactly 72,782 human-readable occurrences (1,057 unique values): 2,333 argument leaves (309 unique) and 70,449 result leaves (861 unique). The remaining 115,319 code-like occurrences (2,339 unique values) stay canonical. Korean tool values are referenced by RFC 6901 pointers in the same per-trajectory overlays as the chat messages, so the UI can translate nested display values without mutating arguments, results, keys, or raw exports.

Korean is display-only. Canonical tasks, policies, runtime prompts, transcripts, tool calls, evaluation data, IDs, dates, amounts, control tokens, placeholders, and source hashes remain tied to the pinned English benchmark bytes. Switching language never changes benchmark behavior. Raw views continue to expose the English source.

Curated inputs live at:

- `app/data/task-translations.ko.json` — the exact selected three-domain, 278-task translation corpus;
- `app/data/gpt5-transcript-translations.ko/<run-id>.json` — exact run-local message translation memories;
- `app/data/gpt5-tool-translations.ko.json` — the 1,057 GPT-5 tool string translations selected by the pinned classifier;
- `app/data/gpt5-context-translations.ko.json` — policies, prompt templates, and evaluator assertions.

Generation fails on missing or extra selected entries, source-hash drift, blank or non-Korean natural language, placeholder changes, or modified protected literals such as tool names, IDs, dates, amounts, Markdown code, XML tags, and control tokens.

## Lazy data layout

The application shell imports only the small catalog. Run indexes, task sets, transcript chunks, Korean overlays, and context documents load on demand.

```text
app/data/
├── benchmark-snapshot.json
├── task-translations.ko.json
├── gpt5-context-translations.ko.json
├── gpt5-tool-translations.ko.json
└── gpt5-transcript-translations.ko/<run-id>.json

public/data/sets/tau2-gpt5-sierra-2025-08-09-v1/
├── indexes/<run-id>.json
├── tasks/tasks_<content-hash>.json
├── chunks/<run-id>/chunk_<number>.json
└── translations/ko/
    ├── context/<domain>_<content-hash>.json
    └── transcripts/<run-id>/chunk_<number>_<content-hash>.json
```

Each detail chunk contains at most 20 trajectories. A run index maps every English detail chunk to one Korean transcript overlay and records the overlay hash, byte size, and exact English source-chunk hash. Content-addressed task, context, and overlay paths make stale or mismatched assets detectable.

The generated public tree contains 121 JSON assets:

- 56 English detail chunks and 56 Korean transcript overlays;
- 3 run indexes, 3 task assets, and 3 Korean context assets.

## Run locally

Node.js 22.13 or newer is required.

```bash
npm install
npm run dev
```

Production validation:

```bash
npm test
```

The test suite server-renders the application and exhaustively follows catalog → run index → detail chunk → Korean overlay mappings. It verifies hashes and byte sizes, resolves all 1,112 trajectory IDs, checks all 11,520 run-local message entries and 1,057 tool entries against their English source identities, resolves every tool-leaf RFC 6901 pointer, reconstructs all 232 Korean evaluator prompts, and confirms the 121-file asset topology.

## Refresh the snapshot

The generator needs the v0.2.0 data tree and the recorded runtime commit object, so use a full τ²-bench clone:

```bash
git clone https://github.com/sierra-research/tau2-bench.git work/tau2-bench
git -C work/tau2-bench checkout v0.2.0
npm run sync-data
```

Or point it at an existing checkout:

```bash
TAU2_BENCH_DIR=/path/to/tau2-bench npm run sync-data
```

`npm run sync-data` preflights the three official result-file hashes, runtime provenance, 278 tasks, 1,112 trajectories, 56 chunks, English/Korean source identities, tool-call pairing, all 188,101 tool string leaves, 232 evaluator prompts, and the 121-asset topology before replacing `public/data/` and the catalog.

## Source revisions

- Result data and domain artifacts: τ²-bench `v0.2.0` / `f8de30c298689cbe0117d76a378e7315a17e5bd8`.
- Runtime code recorded by all three GPT-5 result files: `964ef7aed331ecf0c9bc592abdc2b4aecd941586`.
- Agent model label recorded by the submission: `gpt-5`; the provider's dated snapshot was not recorded.
- User simulator: `gpt-4.1-2025-04-14`, temperature 0.
- NL evaluator: `gpt-4o-mini`, temperature 0, invoked 232 times.

The data commit and runtime commit are deliberately reported separately: the result files identify `964ef…` as the code that ran, while the bundled policies, tasks, and submission files are pinned from v0.2.0.

The upstream benchmark code and bundled results are MIT-licensed. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for attribution.
