# TAU Explorer

A minimal, grayscale web explorer for the official [τ-bench](https://github.com/sierra-research/tau-bench) and [τ²-bench](https://github.com/sierra-research/tau2-bench) domain artifacts.

Explore domain policies, user-simulation prompts, task scenarios, evaluation details, and tool-rich trajectories in a chat interface. Agent-side and user-side tool calls are normalized and displayed with their arguments and results.

## Included snapshot

| Benchmark | Domains | Tasks represented by the source run | Bundled trajectories |
| --- | --- | ---: | ---: |
| τ-bench | Airline, Retail | 50 + 115 | 3 per domain |
| τ²-bench v0.2.0 | Airline, Retail, Telecom | 50 + 114 + 114 | 3 per domain |

The app intentionally bundles a curated set of pass/fail trajectories instead of loading the official monolithic result files (which can reach tens of megabytes) in the browser. Domain policies and simulator prompt templates are included in full.

τ² Telecom trajectories distinguish user-operated tools such as device checks from agent-operated customer-service tools. The effective Telecom user prompt uses the tool-enabled simulator guidelines, matching the runtime behavior in v0.2.0.

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

## Refresh the data snapshot

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

The generated browser snapshot lives at `app/data/benchmark-snapshot.json`. The normalizer pairs tool calls and results by call ID, parses JSON-string arguments/results when possible, preserves the trajectory-level policy snapshot, and joins τ² simulations to the task copy embedded in the same result file.

## Source revisions

- τ-bench: `59a200c6d575d595120f1cb70fea53cef0632f6b`
- τ²-bench: `v0.2.0` / `f8de30c298689cbe0117d76a378e7315a17e5bd8`

The current τ²-bench `main` branch has evolved into τ³-bench. This explorer pins v0.2.0 so the Airline, Retail, and Telecom artifacts match the original τ² scope.

The upstream benchmark code and bundled excerpts are MIT-licensed. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for attribution.
