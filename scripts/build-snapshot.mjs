import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauRoot = process.env.TAU_BENCH_DIR ?? path.join(projectRoot, "work/tau-bench");
const tau2Root = process.env.TAU2_BENCH_DIR ?? path.join(projectRoot, "work/tau2-bench");
const datasetId = "official-conversational-v2";
const detailsPerChunk = 20;
const publicDataRoot = path.join(projectRoot, "public/data");
const catalogPath = path.join(projectRoot, "app/data/benchmark-snapshot.json");

if (!publicDataRoot.startsWith(`${projectRoot}${path.sep}`)) {
  throw new Error("Refusing to write generated data outside the project.");
}

rmSync(publicDataRoot, { recursive: true, force: true });
mkdirSync(publicDataRoot, { recursive: true });

const read = (file) => readFileSync(file, "utf8");
const tauPath = (...parts) => path.join(tauRoot, ...parts);
const tau2Path = (...parts) => path.join(tau2Root, ...parts);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function stableId(prefix, parts, length = 22) {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("base64url")
    .slice(0, length);
  return `${prefix}_${digest}`;
}

function writeJson(relativePath, value, pretty = false) {
  const output = path.join(publicDataRoot, relativePath);
  if (!output.startsWith(`${publicDataRoot}${path.sep}`)) {
    throw new Error(`Unsafe generated path: ${relativePath}`);
  }
  mkdirSync(path.dirname(output), { recursive: true });
  const serialized = `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
  writeFileSync(output, serialized);
  return { url: `/data/${relativePath}`, bytes: Buffer.byteLength(serialized) };
}

function maybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeMessages(messages) {
  const output = [];
  const pending = new Map();
  let orphanToolResults = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === "system") continue;

    if (message.role === "tool") {
      const resultId = String(message.id ?? message.tool_call_id ?? "");
      const queue = pending.get(resultId) ?? [];
      const invocation = queue.shift();
      if (invocation) {
        invocation.result = maybeJson(message.content ?? "");
        invocation.error = Boolean(message.error);
      } else {
        orphanToolResults += 1;
      }
      if (queue.length) pending.set(resultId, queue);
      else pending.delete(resultId);
      continue;
    }

    if (message.role !== "assistant" && message.role !== "user") continue;

    const normalized = {
      role: message.role,
      content: message.content ?? null,
      turnIndex: message.turn_idx ?? index,
      timestamp: message.timestamp ?? null,
      toolCalls: [],
    };

    for (let callIndex = 0; callIndex < (message.tool_calls ?? []).length; callIndex += 1) {
      const call = message.tool_calls[callIndex];
      const id = String(call.id ?? `${index}-${callIndex}`);
      const invocation = {
        id,
        name: call.name ?? call.function?.name ?? "unknown_tool",
        requestor: call.requestor ?? (message.role === "user" ? "user" : "assistant"),
        arguments: maybeJson(call.arguments ?? call.function?.arguments ?? {}),
        result: null,
        error: false,
      };
      normalized.toolCalls.push(invocation);
      const queue = pending.get(id) ?? [];
      queue.push(invocation);
      pending.set(id, queue);
    }

    output.push(normalized);
  }

  return { messages: output, orphanToolResults };
}

function firstSentence(value, fallback) {
  if (!value) return fallback;
  const compact = value.replace(/\s+/g, " ").trim();
  const sentence = compact.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? compact;
  return sentence.length > 96 ? `${sentence.slice(0, 93).trim()}…` : sentence;
}

function modelLabel(raw, fallback = "Unknown model") {
  const value = String(raw ?? "").toLowerCase();
  if (value.includes("gpt-5")) return "GPT-5";
  if (value.includes("gpt-4.1-mini")) return "GPT-4.1 mini";
  if (value.includes("gpt-4.1")) return "GPT-4.1";
  if (value.includes("gpt-4o")) return "GPT-4o";
  if (value.includes("o4-mini")) return "o4-mini";
  if (value.includes("3-7-sonnet")) return "Claude 3.7 Sonnet";
  if (value.includes("sonnet-35") || value.includes("3.5")) return "Claude 3.5 Sonnet";
  return raw ? String(raw) : fallback;
}

function modeFromFilename(filename) {
  if (filename.includes("_no-user-op_")) return "no-user-oracle-plan";
  if (filename.includes("_no-user_")) return "no-user";
  if (filename.includes("_op_")) return "oracle-plan";
  if (filename.includes("_base_")) return "base";
  return "default";
}

const modeLabels = {
  historical: "Historical",
  default: "Default",
  base: "Base",
  "oracle-plan": "Oracle plan",
  "no-user": "No user",
  "no-user-oracle-plan": "No user + oracle plan",
};

function compactScenario(scenario) {
  return Object.values(scenario)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
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
    description:
      "Default source template with the task instruction injected. Historical result files do not record the simulator strategy, so this mapping is source-derived.",
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

function makeDomain({
  id,
  benchmark,
  benchmarkLabel,
  versionLabel,
  slug,
  name,
  summary,
  taskCount,
  toolCount,
  policy,
  policySource,
  policyUrl,
  userPrompts,
  promptSource,
  promptUrl,
  source,
}) {
  return {
    id,
    benchmark,
    benchmarkLabel,
    versionLabel,
    slug,
    name,
    summary,
    taskCount,
    trajectoryCount: 0,
    toolCount,
    policy,
    policySource,
    policyUrl,
    userPrompts,
    promptSource,
    promptUrl,
    source,
    defaultRunId: "",
    policySnapshots: [],
    runs: [],
  };
}

const tauCommit = "59a200c6d575d595120f1cb70fea53cef0632f6b";
const tau2Commit = "f8de30c298689cbe0117d76a378e7315a17e5bd8";
const tau2PromptStandard = [
  {
    id: "standard",
    label: "Standard simulator",
    description: "Global guidelines followed by the task-specific user scenario.",
    content: withScenario(tau2StandardGuidelines),
  },
];
const tau2PromptTools = [
  {
    id: "tool-enabled",
    label: "Tool-enabled simulator",
    description: "Runtime prompt used when the simulated user can operate device tools.",
    content: withScenario(tau2ToolGuidelines),
  },
  ...tau2PromptStandard,
  {
    id: "no-user",
    label: "No user simulator",
    description:
      "Agent-only ablation. The dummy_user implementation does not generate user messages or use a user-simulation prompt.",
    content: [
      "No user simulator was invoked for this run.",
      "",
      "Implementation: dummy_user",
      "This agent-only trajectory contains no user-role messages, so there is no resolved user-simulation prompt.",
    ].join("\n"),
  },
];

const domains = [
  makeDomain({
    id: "tau:airline",
    benchmark: "tau",
    benchmarkLabel: "τ-bench",
    versionLabel: "legacy snapshot",
    slug: "airline",
    name: "Airline",
    summary: "Booking, reservation changes, cancellation, refunds, and compensation.",
    taskCount: 50,
    toolCount: 14,
    policy: read(tauPath("tau_bench/envs/airline/wiki.md")).trim(),
    policySource: "tau_bench/envs/airline/wiki.md",
    policyUrl: `https://github.com/sierra-research/tau-bench/blob/${tauCommit}/tau_bench/envs/airline/wiki.md`,
    userPrompts: tauUserPrompts,
    promptSource: "tau_bench/envs/user.py",
    promptUrl: `https://github.com/sierra-research/tau-bench/blob/${tauCommit}/tau_bench/envs/user.py`,
    source: { repository: "sierra-research/tau-bench", commit: tauCommit, license: "MIT" },
  }),
  makeDomain({
    id: "tau:retail",
    benchmark: "tau",
    benchmarkLabel: "τ-bench",
    versionLabel: "legacy snapshot",
    slug: "retail",
    name: "Retail",
    summary: "Order lookup, cancellation, payment changes, returns, and exchanges.",
    taskCount: 115,
    toolCount: 16,
    policy: read(tauPath("tau_bench/envs/retail/wiki.md")).trim(),
    policySource: "tau_bench/envs/retail/wiki.md",
    policyUrl: `https://github.com/sierra-research/tau-bench/blob/${tauCommit}/tau_bench/envs/retail/wiki.md`,
    userPrompts: tauUserPrompts,
    promptSource: "tau_bench/envs/user.py",
    promptUrl: `https://github.com/sierra-research/tau-bench/blob/${tauCommit}/tau_bench/envs/user.py`,
    source: { repository: "sierra-research/tau-bench", commit: tauCommit, license: "MIT" },
  }),
  makeDomain({
    id: "tau2:airline",
    benchmark: "tau2",
    benchmarkLabel: "τ²-bench",
    versionLabel: "v0.2.0",
    slug: "airline",
    name: "Airline",
    summary: "Dual-control reservation workflows with policy and outcome evaluation.",
    taskCount: 50,
    toolCount: 15,
    policy: read(tau2Path("data/tau2/domains/airline/policy.md")).trim(),
    policySource: "data/tau2/domains/airline/policy.md",
    policyUrl: "https://github.com/sierra-research/tau2-bench/blob/v0.2.0/data/tau2/domains/airline/policy.md",
    userPrompts: tau2PromptStandard,
    promptSource: "data/tau2/user_simulator/simulation_guidelines.md",
    promptUrl: "https://github.com/sierra-research/tau2-bench/blob/v0.2.0/data/tau2/user_simulator/simulation_guidelines.md",
    source: { repository: "sierra-research/tau2-bench", commit: tau2Commit, license: "MIT" },
  }),
  makeDomain({
    id: "tau2:retail",
    benchmark: "tau2",
    benchmarkLabel: "τ²-bench",
    versionLabel: "v0.2.0",
    slug: "retail",
    name: "Retail",
    summary: "Expanded retail workflows with structured scenarios and assertions.",
    taskCount: 114,
    toolCount: 17,
    policy: read(tau2Path("data/tau2/domains/retail/policy.md")).trim(),
    policySource: "data/tau2/domains/retail/policy.md",
    policyUrl: "https://github.com/sierra-research/tau2-bench/blob/v0.2.0/data/tau2/domains/retail/policy.md",
    userPrompts: tau2PromptStandard,
    promptSource: "data/tau2/user_simulator/simulation_guidelines.md",
    promptUrl: "https://github.com/sierra-research/tau2-bench/blob/v0.2.0/data/tau2/user_simulator/simulation_guidelines.md",
    source: { repository: "sierra-research/tau2-bench", commit: tau2Commit, license: "MIT" },
  }),
  makeDomain({
    id: "tau2:telecom",
    benchmark: "tau2",
    benchmarkLabel: "τ²-bench",
    versionLabel: "v0.2.0",
    slug: "telecom",
    name: "Telecom",
    summary: "Collaborative troubleshooting where both agent and user operate tools.",
    taskCount: 114,
    toolCount: 28,
    policy: [
      "<main_policy>",
      read(tau2Path("data/tau2/domains/telecom/main_policy.md")).trim(),
      "</main_policy>",
      "<tech_support_policy>",
      read(tau2Path("data/tau2/domains/telecom/tech_support_manual.md")).trim(),
      "</tech_support_policy>",
    ].join("\n"),
    policySource: "data/tau2/domains/telecom/main_policy.md + tech_support_manual.md",
    policyUrl: "https://github.com/sierra-research/tau2-bench/tree/v0.2.0/data/tau2/domains/telecom",
    userPrompts: tau2PromptTools,
    promptSource: "data/tau2/user_simulator/simulation_guidelines_tools.md",
    promptUrl: "https://github.com/sierra-research/tau2-bench/blob/v0.2.0/data/tau2/user_simulator/simulation_guidelines_tools.md",
    source: { repository: "sierra-research/tau2-bench", commit: tau2Commit, license: "MIT" },
  }),
];
const domainsById = new Map(domains.map((domain) => [domain.id, domain]));
const taskAssetPaths = new Map();
const sourceHashes = new Set();
const generation = {
  sourceRuns: 0,
  trajectories: 0,
  agentOnlyRuns: 0,
  agentOnlyTrajectories: 0,
  orphanToolResults: 0,
  detailBytes: 0,
  maxDetailBytes: 0,
  writtenAssets: 0,
  trajectoryIds: new Set(),
};

function ensurePolicySnapshot(domain, content, environmentId, sourceUrl) {
  const hash = sha256(content);
  const existing = domain.policySnapshots.find((snapshot) => snapshot.hash === hash);
  if (existing) return existing.id;
  const id = `policy_${hash.slice(0, 16)}`;
  domain.policySnapshots.push({
    id,
    hash,
    label: environmentId === "telecom-workflow" ? "Workflow policy snapshot" : "Run policy snapshot",
    content,
    sourceUrl,
  });
  return id;
}

function writeTasksAsset(tasks) {
  const sorted = Object.fromEntries(
    Object.entries(tasks).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })),
  );
  const serialized = JSON.stringify(sorted);
  const hash = sha256(serialized);
  if (taskAssetPaths.has(hash)) return taskAssetPaths.get(hash);
  const relative = `sets/${datasetId}/tasks/tasks_${hash.slice(0, 18)}.json`;
  const result = writeJson(relative, { schemaVersion: 2, datasetId, tasks: sorted });
  generation.writtenAssets += 1;
  taskAssetPaths.set(hash, result.url);
  return result.url;
}

function detailAndSummary({
  benchmark,
  domain,
  runId,
  sourceKey,
  record,
  taskEntry,
}) {
  const rawMessages = benchmark === "tau" ? record.traj : record.messages;
  const normalized = normalizeMessages(rawMessages);
  generation.orphanToolResults += normalized.orphanToolResults;
  const taskId = String(record.task_id);
  const trial = record.trial ?? 0;
  const trajectoryId = stableId("tr", [benchmark, sourceKey, record.id ?? taskId, trial]);
  if (generation.trajectoryIds.has(trajectoryId)) {
    throw new Error(`Duplicate trajectory id: ${trajectoryId}`);
  }
  generation.trajectoryIds.add(trajectoryId);
  const reward = benchmark === "tau" ? record.reward : record.reward_info?.reward ?? 0;
  const terminationReason = benchmark === "tau"
    ? record.info.reward_info ? "completed" : "max_steps"
    : record.termination_reason;
  const toolCalls = normalized.messages.flatMap((message) => message.toolCalls);
  const toolNames = [...new Set(toolCalls.map((call) => call.name))].sort();
  const detail = {
    id: trajectoryId,
    runId,
    taskId,
    trial,
    reward,
    title: taskEntry.title,
    terminationReason,
    duration: benchmark === "tau" ? null : record.duration,
    agentCost: benchmark === "tau" ? null : record.agent_cost ?? null,
    userCost: benchmark === "tau" ? record.info.user_cost ?? null : record.user_cost ?? null,
    evaluation: benchmark === "tau" ? record.info.reward_info ?? null : record.reward_info ?? null,
    messages: normalized.messages,
  };
  return {
    detail,
    summary: {
      id: trajectoryId,
      detailPath: "",
      domainId: domain.id,
      runId,
      taskId,
      trial,
      reward,
      title: taskEntry.title,
      terminationReason,
      duration: detail.duration,
      agentCost: detail.agentCost,
      userCost: detail.userCost,
      messageCount: normalized.messages.length,
      toolCallCount: toolCalls.length,
      userToolCallCount: toolCalls.filter((call) => call.requestor === "user").length,
      toolNames,
      scenarioPreview: compactScenario(taskEntry.scenario),
    },
  };
}

function addRun({
  benchmark,
  domainId,
  sourceFile,
  sourceRelative,
  sourceUrl,
  raw,
  model,
  userModel,
  mode,
  environmentId,
  agentImplementation,
  userImplementation,
  taskEntries,
  records,
  policyUsed,
  promptRef,
}) {
  const domain = domainsById.get(domainId);
  if (!domain) throw new Error(`Unknown domain: ${domainId}`);
  const sourceKey = `${benchmark}:${sourceRelative}`;
  const sourceHash = sha256(raw);
  if (sourceHashes.has(sourceHash)) return;
  sourceHashes.add(sourceHash);

  const runId = stableId("run", [benchmark, sourceRelative], 18);
  const tasksPath = writeTasksAsset(taskEntries);
  const policySnapshotId = ensurePolicySnapshot(domain, policyUsed, environmentId, sourceUrl);
  const prepared = records.map((record) => {
    const taskEntry = taskEntries[String(record.task_id)];
    if (!taskEntry) throw new Error(`Missing task ${record.task_id} in ${sourceFile}`);
    return detailAndSummary({
      benchmark,
      domain,
      runId,
      sourceKey,
      record,
      taskEntry,
    });
  });
  const summaries = [];
  for (let start = 0; start < prepared.length; start += detailsPerChunk) {
    const chunk = prepared.slice(start, start + detailsPerChunk);
    const chunkNumber = String(Math.floor(start / detailsPerChunk)).padStart(4, "0");
    const chunkRelative = `sets/${datasetId}/chunks/${runId}/chunk_${chunkNumber}.json`;
    const written = writeJson(chunkRelative, {
      schemaVersion: 2,
      datasetId,
      trajectories: Object.fromEntries(
        chunk.map(({ detail }) => [detail.id, detail]),
      ),
    });
    generation.writtenAssets += 1;
    generation.detailBytes += written.bytes;
    generation.maxDetailBytes = Math.max(generation.maxDetailBytes, written.bytes);
    for (const { summary } of chunk) {
      summary.detailPath = written.url;
      summaries.push(summary);
    }
  }
  const indexRelative = `sets/${datasetId}/indexes/${runId}.json`;
  const index = writeJson(indexRelative, {
    schemaVersion: 2,
    datasetId,
    runId,
    trajectories: summaries,
  });
  generation.writtenAssets += 1;

  const passCount = summaries.filter((summary) => summary.reward === 1).length;
  const trials = [...new Set(summaries.map((summary) => summary.trial))].sort((a, b) => a - b);
  const policyVariant = environmentId === "telecom-workflow" ? "workflow" : "standard";
  const labelParts = [model, modeLabels[mode] ?? mode];
  if (policyVariant === "workflow") labelParts.push("Workflow policy");
  const run = {
    id: runId,
    label: labelParts.join(" · "),
    model,
    userModel,
    mode,
    environmentId,
    policyVariant,
    agentImplementation,
    userImplementation,
    taskCount: Object.keys(taskEntries).length,
    trajectoryCount: summaries.length,
    passCount,
    failCount: summaries.length - passCount,
    trials,
    policySnapshotId,
    promptRef,
    indexPath: index.url,
    tasksPath,
    sourceFile: sourceRelative,
    sourceUrl,
  };
  domain.runs.push(run);
  domain.trajectoryCount += summaries.length;
  generation.sourceRuns += 1;
  generation.trajectories += summaries.length;
}

function tauTaskEntries(records) {
  const entries = {};
  for (const record of records) {
    const taskId = String(record.task_id);
    if (entries[taskId]) continue;
    const task = record.info.task;
    entries[taskId] = {
      taskId,
      title: firstSentence(task.instruction, `Task ${taskId}`),
      scenario: { instruction: task.instruction, userId: task.user_id },
      task: { user_id: task.user_id, actions: task.actions, outputs: task.outputs },
    };
  }
  return entries;
}

function tau2TaskEntries(tasks) {
  return Object.fromEntries(
    tasks.map((task) => {
      const taskId = String(task.id);
      const instructions = task.user_scenario?.instructions ?? {};
      const scenario = typeof instructions === "string"
        ? { taskInstructions: instructions }
        : {
            persona: task.user_scenario?.persona ?? null,
            reasonForCall: instructions.reason_for_call ?? null,
            knownInfo: instructions.known_info ?? null,
            unknownInfo: instructions.unknown_info ?? null,
            taskInstructions: instructions.task_instructions ?? null,
          };
      return [
        taskId,
        {
          taskId,
          title: firstSentence(
            task.description?.purpose ?? scenario.reasonForCall,
            `Task ${taskId}`,
          ),
          scenario,
          task,
        },
      ];
    }),
  );
}

const tauRuns = [
  { domain: "airline", file: "gpt-4o-airline.json", model: "GPT-4o" },
  { domain: "retail", file: "gpt-4o-retail.json", model: "GPT-4o" },
  { domain: "airline", file: "sonnet-35-new-airline.json", model: "Claude 3.5 Sonnet" },
  { domain: "retail", file: "sonnet-35-new-retail.json", model: "Claude 3.5 Sonnet" },
];

for (const spec of tauRuns) {
  const sourceRelative = `historical_trajectories/${spec.file}`;
  const file = tauPath(sourceRelative);
  const raw = read(file);
  const records = JSON.parse(raw);
  const policyUsed = records[0].traj.find((message) => message.role === "system")?.content
    ?? domainsById.get(`tau:${spec.domain}`).policy;
  addRun({
    benchmark: "tau",
    domainId: `tau:${spec.domain}`,
    sourceFile: spec.file,
    sourceRelative,
    sourceUrl: `https://github.com/sierra-research/tau-bench/blob/${tauCommit}/${sourceRelative}`,
    raw,
    model: spec.model,
    userModel: "Not recorded",
    mode: "historical",
    environmentId: spec.domain,
    agentImplementation: "tool_calling_agent",
    userImplementation: "not recorded",
    taskEntries: tauTaskEntries(records),
    records,
    policyUsed,
    promptRef: "llm",
  });
}

const finalResultsDir = tau2Path("data/tau2/results/final");
const tau2Inputs = readdirSync(finalResultsDir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({
    absolute: path.join(finalResultsDir, file),
    relative: `data/tau2/results/final/${file}`,
  }));
const gpt5Dir = tau2Path(
  "web/leaderboard/public/submissions/gpt-5_sierra_2025-08-09/trajectories",
);
for (const file of readdirSync(gpt5Dir).filter((name) => name.endsWith(".json")).sort()) {
  tau2Inputs.push({
    absolute: path.join(gpt5Dir, file),
    relative: `web/leaderboard/public/submissions/gpt-5_sierra_2025-08-09/trajectories/${file}`,
  });
}

for (const input of tau2Inputs) {
  const raw = read(input.absolute);
  const result = JSON.parse(raw);
  const mode = modeFromFilename(path.basename(input.absolute));
  const hasUserMessages = result.simulations.some((simulation) =>
    simulation.messages.some((message) => message.role === "user"),
  );
  const agentOnlyRun = mode.startsWith("no-user") || !hasUserMessages;
  if (agentOnlyRun) {
    generation.agentOnlyRuns += 1;
    generation.agentOnlyTrajectories += result.simulations.length;
  }

  const environmentId = result.info.environment_info.domain_name;
  const domainSlug = environmentId.startsWith("telecom") ? "telecom" : environmentId;
  const domainId = `tau2:${domainSlug}`;
  const agentModel = modelLabel(result.info.agent_info?.llm, path.basename(input.absolute));
  const userModel = agentOnlyRun
    ? "Not used"
    : modelLabel(result.info.user_info?.llm, "Not recorded");
  const usesUserTools = environmentId.startsWith("telecom") && !agentOnlyRun;
  addRun({
    benchmark: "tau2",
    domainId,
    sourceFile: path.basename(input.absolute),
    sourceRelative: input.relative,
    sourceUrl: `https://github.com/sierra-research/tau2-bench/blob/v0.2.0/${input.relative}`,
    raw,
    model: agentModel,
    userModel,
    mode,
    environmentId,
    agentImplementation: result.info.agent_info?.implementation ?? "unknown",
    userImplementation: result.info.user_info?.implementation ?? "user_simulator",
    taskEntries: tau2TaskEntries(result.tasks),
    records: result.simulations,
    policyUsed: result.info.environment_info.policy,
    promptRef: agentOnlyRun ? "no-user" : usesUserTools ? "tool-enabled" : "standard",
  });
}

function runPriority(run, benchmark) {
  if (benchmark === "tau") return run.model === "GPT-4o" ? 0 : 10;
  let score = 0;
  if (run.model === "GPT-4.1") score += 0;
  else if (run.model === "GPT-5") score += 10;
  else if (run.model === "Claude 3.7 Sonnet") score += 20;
  else if (run.model === "o4-mini") score += 30;
  else if (run.model === "GPT-4.1 mini") score += 40;
  else score += 50;
  if (run.mode === "oracle-plan") score += 100;
  if (run.policyVariant === "workflow") score += 200;
  return score;
}

for (const domain of domains) {
  domain.runs.sort(
    (a, b) => runPriority(a, domain.benchmark) - runPriority(b, domain.benchmark)
      || a.label.localeCompare(b.label),
  );
  domain.defaultRunId = domain.runs[0]?.id ?? "";
  domain.policySnapshots = domain.policySnapshots.map(
    ({ id, label, content, sourceUrl }) => ({ id, label, content, sourceUrl }),
  );
}

const expectedRuns = 33;
const expectedTrajectories = 13_924;
if (generation.sourceRuns !== expectedRuns) {
  throw new Error(`Expected ${expectedRuns} conversational runs, got ${generation.sourceRuns}.`);
}
if (generation.trajectories !== expectedTrajectories) {
  throw new Error(
    `Expected ${expectedTrajectories} conversational trajectories, got ${generation.trajectories}.`,
  );
}
if (generation.trajectoryIds.size !== generation.trajectories) {
  throw new Error("Generated trajectory IDs are not unique.");
}
if (generation.orphanToolResults !== 0) {
  throw new Error(`Found ${generation.orphanToolResults} orphan tool results.`);
}
if (generation.maxDetailBytes >= 25 * 1024 * 1024) {
  throw new Error(`Largest detail asset exceeds the 25 MiB static asset limit.`);
}

const catalog = {
  schemaVersion: 2,
  datasetId,
  generatedAt: new Date().toISOString(),
  notice:
    "All 13,924 unique official trajectories are indexed, including τ² no-user and no-user-oracle-plan agent-only ablations.",
  agentOnly: {
    reason: "dummy_user ablations with zero user-role messages",
    runs: generation.agentOnlyRuns,
    trajectories: generation.agentOnlyTrajectories,
  },
  sources: [
    {
      id: "tau",
      label: "τ-bench",
      repository: "https://github.com/sierra-research/tau-bench",
      revision: tauCommit,
      license: "MIT",
    },
    {
      id: "tau2",
      label: "τ²-bench",
      repository: "https://github.com/sierra-research/tau2-bench",
      revision: `v0.2.0 · ${tau2Commit}`,
      license: "MIT",
    },
  ],
  totals: {
    runs: generation.sourceRuns,
    trajectories: generation.trajectories,
    detailBytes: generation.detailBytes,
  },
  domains,
};

mkdirSync(path.dirname(catalogPath), { recursive: true });
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

const publicFileCount = generation.writtenAssets;
if (publicFileCount >= 1_000) {
  throw new Error(
    `Generated ${publicFileCount} data assets; expected fewer than 1,000 for the hosting metadata budget.`,
  );
}

console.log(
  JSON.stringify(
    {
      catalog: catalogPath,
      runs: generation.sourceRuns,
      trajectories: generation.trajectories,
      agentOnlyRuns: generation.agentOnlyRuns,
      agentOnlyTrajectories: generation.agentOnlyTrajectories,
      dataAssets: generation.writtenAssets,
      detailMiB: Number((generation.detailBytes / 1024 / 1024).toFixed(1)),
      largestDetailKiB: Number((generation.maxDetailBytes / 1024).toFixed(1)),
    },
    null,
    2,
  ),
);
