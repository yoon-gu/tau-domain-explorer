# TAU Explorer

A minimal, grayscale web explorer for the official [τ-bench](https://github.com/sierra-research/tau-bench) and [τ²-bench](https://github.com/sierra-research/tau2-bench) domain artifacts.

Explore domain policies, user-simulation prompts, task scenarios, evaluation details, and tool-rich trajectories in a chat interface. Agent-side and user-side tool calls are normalized and displayed with their arguments and results.

## Included catalog

TAU Explorer indexes every unique official trajectory result in the pinned repositories, rather than a three-example sample.

| Benchmark | Domain | Runs | Trajectories |
| --- | --- | ---: | ---: |
| τ-bench | Airline | 2 | 600 |
| τ-bench | Retail | 2 | 1,380 |
| τ²-bench v0.2.0 | Airline | 5 | 1,000 |
| τ²-bench v0.2.0 | Retail | 5 | 2,280 |
| τ²-bench v0.2.0 | Telecom, including the workflow-policy variant | 19 | 8,664 |
| **Total** | **5 domain views** | **33** | **13,924** |

The catalog covers GPT-4o and Claude 3.5 Sonnet historical τ-bench runs, plus Claude 3.7 Sonnet, GPT-4.1, GPT-4.1 mini, o4-mini, GPT-5, oracle-plan, no-user, no-user-oracle-plan, and Telecom workflow-policy τ²-bench runs. The GPT-5 trajectories come from the official leaderboard submission included in the pinned τ²-bench checkout; byte-identical leaderboard copies of files already present in `data/tau2/results/final/` are deduplicated.

The complete catalog includes eight τ² `no-user` and `no-user-op` ablation runs containing 3,648 agent-only traces. They use `dummy_user`, contain no user-role messages, and did not invoke a user-simulation prompt. The UI labels those runs as agent-only and shows a clear “No user simulator” placeholder while preserving their complete assistant and tool traces. Oracle-plan (`op`) runs use the normal user simulator; `no-user-op` is represented as the separate no-user-oracle-plan mode.

τ² Telecom trajectories distinguish user-operated device tools from agent-operated customer-service tools. Their effective user prompt uses the tool-enabled simulator guidelines recorded by the benchmark.

## Lazy data layout

The browser does not download hundreds of megabytes as one application bundle. Generated data is split into a small catalog and lazy JSON assets:

```text
app/data/benchmark-snapshot.json
public/data/sets/official-conversational-v2/
├── chunks/<run-id>/chunk_<number>.json
├── indexes/<run-id>.json
└── tasks/<content-hash>.json
```

The catalog contains domain policies, prompt templates, policy snapshots, run configurations, counts, and pointers to the shards. Selecting a run loads its searchable trajectory index. Each run is divided into detail chunks of at most 20 trajectories; selecting a trajectory loads only its containing chunk and resolves the trajectory by ID from the chunk's `trajectories` map. Task sets are content-addressed and referenced per run, so task metadata remains correct even when upstream result files were produced at different revisions.

Each run index carries the fields needed for filtering without loading transcripts: task and trial IDs, outcome, title, termination reason, message and tool-call counts, distinct tool names, a scenario preview, and whether user-side tools were used. Chunk shards contain the full normalized conversations and evaluations. The normalizer pairs tool calls and results by call ID and parses JSON-string arguments and results when possible.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Production validation:

```bash
npm test
```

## Refresh the data catalog

Clone the pinned upstream repositories into the ignored `work/` directory:

```bash
git clone --depth 1 https://github.com/sierra-research/tau-bench.git work/tau-bench
git clone --branch v0.2.0 --depth 1 https://github.com/sierra-research/tau2-bench.git work/tau2-bench
npm run sync-data
```

You can also point the generator at existing checkouts:

```bash
TAU_BENCH_DIR=/path/to/tau-bench \
TAU2_BENCH_DIR=/path/to/tau2-bench \
npm run sync-data
```

`npm run sync-data` rebuilds `app/data/benchmark-snapshot.json` and the complete `public/data/` shard tree. It validates the expected 33 runs and 13,924 trajectories, including all 3,648 agent-only traces; rejects orphaned tool results; deduplicates source files and task sets; emits detail chunks containing at most 20 trajectories; and fails if a chunk exceeds the static asset limit or the generated data tree reaches 1,000 files.

## Source revisions

- τ-bench: `59a200c6d575d595120f1cb70fea53cef0632f6b`
- τ²-bench: `v0.2.0` / `f8de30c298689cbe0117d76a378e7315a17e5bd8`

The current τ²-bench `main` branch has evolved into τ³-bench. This explorer pins v0.2.0 so the Airline, Retail, and Telecom artifacts match the original τ² scope.

The upstream benchmark code and bundled results are MIT-licensed. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for attribution.
