import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauRoot = process.env.TAU_BENCH_DIR ?? path.join(projectRoot, "work/tau-bench");
const tau2Root = process.env.TAU2_BENCH_DIR ?? path.join(projectRoot, "work/tau2-bench");

const read = (file) => readFileSync(file, "utf8");
const json = (file) => JSON.parse(read(file));
const tauPath = (...parts) => path.join(tauRoot, ...parts);
const tau2Path = (...parts) => path.join(tau2Root, ...parts);

function maybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function countToolCalls(messages) {
  return messages.reduce((count, message) => count + (message.tool_calls?.length ?? 0), 0);
}

function hasUserToolCall(messages) {
  return messages.some(
    (message) =>
      message.role === "user" &&
      message.tool_calls?.some((call) => (call.requestor ?? "user") === "user"),
  );
}

function normalizeMessages(messages) {
  const usedResults = new Set();

  return messages.flatMap((message, messageIndex) => {
    if (message.role === "system" || message.role === "tool") return [];

    const calls = (message.tool_calls ?? []).map((call, callIndex) => {
      const id = call.id ?? `${messageIndex}-${callIndex}`;
      const name = call.name ?? call.function?.name ?? "unknown_tool";
      const args = maybeJson(call.arguments ?? call.function?.arguments ?? {});
      const requestor = call.requestor ?? (message.role === "user" ? "user" : "assistant");
      const resultIndex = messages.findIndex((candidate, index) => {
        if (index <= messageIndex || usedResults.has(index) || candidate.role !== "tool") {
          return false;
        }
        const resultId = candidate.id ?? candidate.tool_call_id;
        return resultId === id;
      });
      const result = resultIndex >= 0 ? messages[resultIndex] : null;
      if (resultIndex >= 0) usedResults.add(resultIndex);

      return {
        id,
        name,
        requestor,
        arguments: args,
        result: result ? maybeJson(result.content ?? "") : null,
        error: result?.error ?? false,
      };
    });

    return [
      {
        role: message.role,
        content: message.content ?? null,
        turnIndex: message.turn_idx ?? messageIndex,
        timestamp: message.timestamp ?? null,
        toolCalls: calls,
      },
    ];
  });
}

function firstSentence(value, fallback) {
  if (!value) return fallback;
  const compact = value.replace(/\s+/g, " ").trim();
  const sentence = compact.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? compact;
  return sentence.length > 92 ? `${sentence.slice(0, 89).trim()}…` : sentence;
}

function pickTrajectories(records, rewardOf, preferUserTool = false) {
  const withTools = records.filter((record) => countToolCalls(record.messages ?? record.traj) > 0);
  const picked = [];
  const add = (record) => {
    if (!record) return;
    if (picked.some((item) => String(item.task_id) === String(record.task_id))) return;
    picked.push(record);
  };

  add(withTools.find((record) => rewardOf(record) === 1));
  add(withTools.find((record) => rewardOf(record) === 0));
  if (preferUserTool) {
    add(withTools.find((record) => hasUserToolCall(record.messages ?? record.traj)));
  }
  add(
    [...withTools]
      .filter((record) => !picked.some((item) => String(item.task_id) === String(record.task_id)))
      .filter((record) => (record.messages ?? record.traj).length <= 48)
      .sort(
        (a, b) =>
          countToolCalls(b.messages ?? b.traj) - countToolCalls(a.messages ?? a.traj),
      )[0],
  );
  return picked.slice(0, 3);
}

const tauUserSource = read(tauPath("tau_bench/envs/user.py"));
const tauPromptBlocks = [
  ...tauUserSource.matchAll(/(?:return|prompt =)\s+f"""([\s\S]*?)"""/g),
].map((match) => match[1].trim());
const instructionPlaceholder = "\n\nInstruction: {{ task.instruction }}\n";

const tauUserPrompts = [
  {
    id: "llm",
    label: "LLM simulator",
    description: "Default simulator system prompt with the task instruction injected.",
    content: tauPromptBlocks[0].replace("{instruction_display}", instructionPlaceholder),
  },
  {
    id: "react",
    label: "ReAct simulator",
    description: "Adds a private thought and a parsed one-line user response.",
    content: tauPromptBlocks[1].replace("{instruction_display}", instructionPlaceholder),
  },
  {
    id: "verify",
    label: "Verify supervisor",
    description: "Classifies whether a simulated user response is satisfactory.",
    content: tauPromptBlocks[2],
  },
  {
    id: "reflection",
    label: "Reflection supervisor",
    description: "Reflects on a rejected response and proposes a replacement.",
    content: tauPromptBlocks[3],
  },
];

const tau2StandardGuidelines = read(
  tau2Path("data/tau2/user_simulator/simulation_guidelines.md"),
).trim();
const tau2ToolGuidelines = read(
  tau2Path("data/tau2/user_simulator/simulation_guidelines_tools.md"),
).trim();
const withScenario = (guidelines) =>
  `${guidelines}\n\n<scenario>\n{{ user_scenario }}\n</scenario>`;

const domainMeta = {
  "tau:airline": {
    name: "Airline",
    summary: "Booking, reservation changes, cancellation, refunds, and compensation.",
    taskCount: 50,
    trajectoryCount: 200,
    toolCount: 14,
  },
  "tau:retail": {
    name: "Retail",
    summary: "Order lookup, cancellation, payment changes, returns, and exchanges.",
    taskCount: 115,
    trajectoryCount: 460,
    toolCount: 16,
  },
  "tau2:airline": {
    name: "Airline",
    summary: "Dual-control reservation workflows with policy and outcome evaluation.",
    taskCount: 50,
    trajectoryCount: 200,
    toolCount: 15,
  },
  "tau2:retail": {
    name: "Retail",
    summary: "Expanded retail workflows with structured scenarios and assertions.",
    taskCount: 114,
    trajectoryCount: 456,
    toolCount: 17,
  },
  "tau2:telecom": {
    name: "Telecom",
    summary: "Collaborative troubleshooting where both agent and user operate tools.",
    taskCount: 114,
    trajectoryCount: 456,
    toolCount: 28,
  },
};

function buildTauDomain(domain, policyFile, resultsFile) {
  const records = json(tauPath("historical_trajectories", resultsFile));
  const selected = pickTrajectories(records, (record) => record.reward);
  const meta = domainMeta[`tau:${domain}`];

  return {
    id: `tau:${domain}`,
    benchmark: "tau",
    benchmarkLabel: "τ-bench",
    versionLabel: "legacy snapshot",
    slug: domain,
    ...meta,
    policy: read(tauPath(policyFile)).trim(),
    policySource: `tau_bench/envs/${domain}/wiki.md`,
    policyUrl: `https://github.com/sierra-research/tau-bench/blob/59a200c6d575d595120f1cb70fea53cef0632f6b/tau_bench/envs/${domain}/wiki.md`,
    userPrompts: tauUserPrompts,
    promptSource: "tau_bench/envs/user.py",
    promptUrl:
      "https://github.com/sierra-research/tau-bench/blob/59a200c6d575d595120f1cb70fea53cef0632f6b/tau_bench/envs/user.py",
    source: {
      repository: "sierra-research/tau-bench",
      commit: "59a200c6d575d595120f1cb70fea53cef0632f6b",
      license: "MIT",
      resultsFile: `historical_trajectories/${resultsFile}`,
    },
    trajectories: selected.map((record) => {
      const task = record.info.task;
      return {
        id: `tau:${domain}:gpt-4o:${record.task_id}:${record.trial}`,
        taskId: String(record.task_id),
        trial: record.trial,
        reward: record.reward,
        title: firstSentence(task.instruction, `Task ${record.task_id}`),
        model: "GPT-4o",
        userModel: "GPT-4o",
        terminationReason: record.info.reward_info ? "completed" : "max_steps",
        duration: null,
        agentCost: null,
        userCost: record.info.user_cost ?? null,
        policyUsed: record.traj.find((message) => message.role === "system")?.content ?? null,
        scenario: {
          instruction: task.instruction,
          userId: task.user_id,
        },
        task: {
          user_id: task.user_id,
          actions: task.actions,
          outputs: task.outputs,
        },
        evaluation: record.info.reward_info ?? null,
        messages: normalizeMessages(record.traj),
        sourceUrl: `https://github.com/sierra-research/tau-bench/blob/59a200c6d575d595120f1cb70fea53cef0632f6b/historical_trajectories/${resultsFile}`,
      };
    }),
  };
}

function buildTau2Domain(domain, policyFile, resultsFile, usesUserTools = false) {
  const result = json(tau2Path("data/tau2/results/final", resultsFile));
  const selected = pickTrajectories(
    result.simulations,
    (simulation) => simulation.reward_info?.reward ?? 0,
    usesUserTools,
  );
  const tasksById = new Map(result.tasks.map((task) => [String(task.id), task]));
  const meta = domainMeta[`tau2:${domain}`];
  const policy = result.info.environment_info.policy ?? read(tau2Path(policyFile)).trim();

  const userPrompts = usesUserTools
    ? [
        {
          id: "tool-enabled",
          label: "Tool-enabled simulator",
          description: "Runtime prompt used when the simulated user can operate device tools.",
          content: withScenario(tau2ToolGuidelines),
        },
        {
          id: "standard",
          label: "Standard simulator",
          description: "Text-only baseline without user-side tool instructions.",
          content: withScenario(tau2StandardGuidelines),
        },
      ]
    : [
        {
          id: "standard",
          label: "Standard simulator",
          description: "Global guidelines followed by the task-specific user scenario.",
          content: withScenario(tau2StandardGuidelines),
        },
      ];

  return {
    id: `tau2:${domain}`,
    benchmark: "tau2",
    benchmarkLabel: "τ²-bench",
    versionLabel: "v0.2.0",
    slug: domain,
    ...meta,
    policy,
    policySource: policyFile.replace("data/tau2/", ""),
    policyUrl: `https://github.com/sierra-research/tau2-bench/blob/v0.2.0/${policyFile}`,
    userPrompts,
    promptSource: usesUserTools
      ? "data/tau2/user_simulator/simulation_guidelines_tools.md"
      : "data/tau2/user_simulator/simulation_guidelines.md",
    promptUrl: `https://github.com/sierra-research/tau2-bench/blob/v0.2.0/data/tau2/user_simulator/${
      usesUserTools ? "simulation_guidelines_tools.md" : "simulation_guidelines.md"
    }`,
    source: {
      repository: "sierra-research/tau2-bench",
      commit: "f8de30c298689cbe0117d76a378e7315a17e5bd8",
      runCommit: result.info.git_commit ?? null,
      license: "MIT",
      resultsFile: `data/tau2/results/final/${resultsFile}`,
    },
    trajectories: selected.map((simulation) => {
      const task = tasksById.get(String(simulation.task_id));
      const instructions = task?.user_scenario?.instructions ?? {};
      return {
        id: `tau2:${domain}:${simulation.id}`,
        taskId: String(simulation.task_id),
        trial: simulation.trial,
        reward: simulation.reward_info?.reward ?? 0,
        title: firstSentence(
          task?.description?.purpose ?? instructions.reason_for_call,
          `Task ${simulation.task_id}`,
        ),
        model: result.info.agent_info?.llm ?? "GPT-4.1",
        userModel: result.info.user_info?.llm ?? "GPT-4.1",
        terminationReason: simulation.termination_reason,
        duration: simulation.duration,
        agentCost: simulation.agent_cost,
        userCost: simulation.user_cost,
        policyUsed: result.info.environment_info.policy ?? null,
        scenario: {
          persona: task?.user_scenario?.persona ?? null,
          reasonForCall: instructions.reason_for_call ?? null,
          knownInfo: instructions.known_info ?? null,
          unknownInfo: instructions.unknown_info ?? null,
          taskInstructions: instructions.task_instructions ?? null,
        },
        task,
        evaluation: simulation.reward_info,
        messages: normalizeMessages(simulation.messages),
        sourceUrl: `https://github.com/sierra-research/tau2-bench/blob/v0.2.0/data/tau2/results/final/${resultsFile}`,
      };
    }),
  };
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  notice:
    "Curated, pinned samples from the official MIT-licensed repositories. Counts describe the selected official result files; the UI bundles three representative trajectories per domain.",
  sources: [
    {
      id: "tau",
      label: "τ-bench",
      repository: "https://github.com/sierra-research/tau-bench",
      revision: "59a200c6d575d595120f1cb70fea53cef0632f6b",
      license: "MIT",
    },
    {
      id: "tau2",
      label: "τ²-bench",
      repository: "https://github.com/sierra-research/tau2-bench",
      revision: "v0.2.0 · f8de30c298689cbe0117d76a378e7315a17e5bd8",
      license: "MIT",
    },
  ],
  domains: [
    buildTauDomain(
      "airline",
      "tau_bench/envs/airline/wiki.md",
      "gpt-4o-airline.json",
    ),
    buildTauDomain(
      "retail",
      "tau_bench/envs/retail/wiki.md",
      "gpt-4o-retail.json",
    ),
    buildTau2Domain(
      "airline",
      "data/tau2/domains/airline/policy.md",
      "gpt-4.1-2025-04-14_airline_default_gpt-4.1-2025-04-14_4trials.json",
    ),
    buildTau2Domain(
      "retail",
      "data/tau2/domains/retail/policy.md",
      "gpt-4.1-2025-04-14_retail_default_gpt-4.1-2025-04-14_4trials.json",
    ),
    buildTau2Domain(
      "telecom",
      "data/tau2/domains/telecom/main_policy.md",
      "gpt-4.1-2025-04-14_telecom_default_gpt-4.1-2025-04-14_4trials.json",
      true,
    ),
  ],
};

const output = path.join(projectRoot, "app/data/benchmark-snapshot.json");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${output}`);
