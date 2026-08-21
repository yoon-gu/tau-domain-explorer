import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tau2Root = process.env.TAU2_BENCH_DIR ?? path.join(projectRoot, "work/tau2-bench");
const datasetId = "tau2-gpt5-sierra-2025-08-09-v1";
const schemaVersion = 2;
const translationSchemaVersion = 1;
const detailsPerChunk = 20;
const releaseTag = "v0.2.0";
const releaseCommit = "f8de30c298689cbe0117d76a378e7315a17e5bd8";
const runtimeCommit = "964ef7aed331ecf0c9bc592abdc2b4aecd941586";
const repository = "https://github.com/sierra-research/tau2-bench";
const publicDataRoot = path.join(projectRoot, "public/data");
const stagingDataRoot = path.join(projectRoot, `public/.tau-data-staging-${process.pid}`);
const catalogPath = path.join(projectRoot, "app/data/benchmark-snapshot.json");
const catalogTemporaryPath = path.join(
  projectRoot,
  `app/data/.benchmark-snapshot-${process.pid}.json`,
);
const taskTranslationsPath = path.join(projectRoot, "app/data/task-translations.ko.json");
const contextTranslationsPath = path.join(
  projectRoot,
  "app/data/gpt5-context-translations.ko.json",
);
const transcriptTranslationsRoot = path.join(
  projectRoot,
  "app/data/gpt5-transcript-translations.ko",
);
const toolTranslationsPath = path.join(
  projectRoot,
  "app/data/gpt5-tool-translations.ko.json",
);

const CONTROL_ONLY = /^\s*###(?:STOP|TRANSFER|OUT-OF-SCOPE)###\s*$/iu;
const CONTROL_TOKEN = /###(?:STOP|TRANSFER|OUT-OF-SCOPE)###/giu;
const HANGUL = /[\uac00-\ud7a3]/u;
const toolClassifierVersion = "tau2-tool-ascii-prose-v1";
const TOOL_URL_ONLY = /^https?:\/\/\S+$/iu;
const TOOL_EMAIL_ONLY = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/iu;
const TOOL_COMPACT_UPPER_CODE = /^#?[A-Z0-9_-]+$/u;
const TOOL_COMPACT_MIXED_ALNUM = /^(?=.*[A-Za-z])(?=.*\d)\S+$/u;
const TOOL_SNAKE_IDENTIFIER = /^[a-z0-9]+(?:_[a-z0-9]+)+$/u;
const PROTECTED_SOURCE = [
  "###(?:STOP|TRANSFER|OUT-OF-SCOPE)###",
  "`[^`]+`",
  "https?://[^\\s)\\]}>]+",
  "[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}",
  "\\b\\d{3}-\\d{3}-\\d{4}\\b",
  "#[A-Za-z0-9_-]+",
  "\\b\\d{4}-\\d{2}-\\d{2}\\b",
  "\\b\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[AP]M)?\\b",
  "[$€£¥]\\s?\\d(?:\\d|[,.](?=\\d))*(?:\\s?(?:USD|EUR|GBP|KRW))?",
  "\\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9_-]{3,}\\b",
  "\\b[a-z][a-z0-9_]+\\((?=[^()\\n]*(?:=|[\"']))[^()\\n]*\\)",
  "\\b[a-z]+(?:_[a-z0-9]+)+\\b",
  "\\b\\d+(?:[.,]\\d+)*[A-Za-z]{1,6}\\b",
  "\\b\\d+(?:[.,]\\d+)*(?:%|st|nd|rd|th)?\\b",
].join("|");
const TOOL_PROTECTED_CODE_TOKEN = [
  "AA", "AC", "AM", "APN", "ATL", "BOS", "CF", "CLT", "DEN", "DOB", "DTW",
  "ET", "EWR", "GB", "HD", "HEPA", "HLR", "HSS", "HXDUBJ", "IAH", "ID",
  "IFOYYZ", "IL", "IR", "JFK", "LAS", "LAX", "LED", "LGA", "MCO", "MIA",
  "MMS", "MMSC", "MSP", "MXP", "ORD", "PDP", "PGW", "PHL", "PHX", "PIN",
  "POOR", "PUK", "SD", "SEA", "SFO", "SIM", "SMF", "SMS", "SSD", "TX",
  "URL", "USA", "USD", "VPN", "ZIP",
].join("|");
const TOOL_PROTECTED_CODE_SOURCE = `\\b(?:${TOOL_PROTECTED_CODE_TOKEN})(?:-(?:${TOOL_PROTECTED_CODE_TOKEN}))*\\b`;
const TOOL_PROTECTED_SOURCE = `${PROTECTED_SOURCE}|${TOOL_PROTECTED_CODE_SOURCE}`;
const TASK_PROTECTED_PATTERNS = [
  /`[^`]+`/gu,
  /https?:\/\/[^\s)\]}]+/gu,
  /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu,
  /#[A-Za-z0-9_-]+/gu,
  /\b\d{3}-\d{3}-\d{4}\b/gu,
  /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{3,}\b/gu,
  /\b[a-z]+(?:_[a-z0-9]+)+\b/gu,
  /(?:\b\d{4}-\d{2}-\d{2}\b|\b\d{6,}\b)/gu,
];

const selectedRuns = [
  {
    domainId: "tau2:airline",
    slug: "airline",
    name: "Airline",
    summary: "Dual-control reservation workflows with policy and outcome evaluation.",
    agentToolCount: 14,
    userToolCount: 0,
    taskCount: 50,
    trajectoryCount: 200,
    passCount: 125,
    promptId: "standard",
    promptLabel: "Standard simulator",
    promptDescription: "The exact standard user-simulator runtime template with the task scenario injected.",
    promptSource: "data/tau2/user_simulator/simulation_guidelines.md",
    policySource: "data/tau2/domains/airline/policy.md",
    policyUrl: `${repository}/blob/${releaseTag}/data/tau2/domains/airline/policy.md`,
    runId: "run_cJ5pvG-VbK9x6vYlpe",
    sourceFile: "gpt-5_airline_default_gpt-4.1-2025-04-14_4trials.json",
    sourceSha256: "a105bdd94410994cf5b252b409766d67b7f71a105adbe828ed6718d5f7ff721a",
    evaluatorInvocations: 200,
  },
  {
    domainId: "tau2:retail",
    slug: "retail",
    name: "Retail",
    summary: "Expanded retail workflows with structured scenarios and assertions.",
    agentToolCount: 15,
    userToolCount: 0,
    taskCount: 114,
    trajectoryCount: 456,
    passCount: 372,
    promptId: "standard",
    promptLabel: "Standard simulator",
    promptDescription: "The exact standard user-simulator runtime template with the task scenario injected.",
    promptSource: "data/tau2/user_simulator/simulation_guidelines.md",
    policySource: "data/tau2/domains/retail/policy.md",
    policyUrl: `${repository}/blob/${releaseTag}/data/tau2/domains/retail/policy.md`,
    runId: "run_o7OQCUdXVT5V8W3TkF",
    sourceFile: "gpt-5_retail_default_gpt-4.1-2025-04-14_4trials.json",
    sourceSha256: "e85532b024b128349c547e2ebadec34b399e73c1a750ef911628072fc0a47734",
    evaluatorInvocations: 32,
  },
  {
    domainId: "tau2:telecom",
    slug: "telecom",
    name: "Telecom",
    summary: "Collaborative troubleshooting where both agent and user operate tools.",
    agentToolCount: 13,
    userToolCount: 30,
    taskCount: 114,
    trajectoryCount: 456,
    passCount: 437,
    promptId: "tool-enabled",
    promptLabel: "Tool-enabled simulator",
    promptDescription: "The exact user-simulator runtime template used when the customer can operate device tools.",
    promptSource: "data/tau2/user_simulator/simulation_guidelines_tools.md",
    policySource: "data/tau2/domains/telecom/main_policy.md + data/tau2/domains/telecom/tech_support_manual.md",
    policyUrl: `${repository}/tree/${releaseTag}/data/tau2/domains/telecom`,
    runId: "run_NkQuH5ORPpc2f1qZ8t",
    sourceFile: "gpt-5_telecom_default_gpt-4.1-2025-04-14_4trials.json",
    sourceSha256: "015610625e69f05ef0e0acdf4c822dcf69ef70010e29ead0fd0e60bb68c84f2f",
    evaluatorInvocations: 0,
  },
];

const submissionRelative =
  "web/leaderboard/public/submissions/gpt-5_sierra_2025-08-09/trajectories";
const read = (file) => readFileSync(file, "utf8");
const readJson = (file) => JSON.parse(read(file));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function requireNonblank(value, label) {
  const result = requireString(value, label);
  if (!result.trim()) throw new Error(`${label} must not be blank.`);
  return result;
}

function sortedKeys(value) {
  return Object.keys(value).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function requireExactKeys(value, expectedKeys, label) {
  const actual = sortedKeys(requireRecord(value, label));
  const expected = [...expectedKeys].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys differ. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

function requireKorean(value, label) {
  const result = requireNonblank(value, label);
  if (!HANGUL.test(result)) throw new Error(`${label} must contain Hangul.`);
  return result;
}

function occurrences(value, expression) {
  return [...value.matchAll(expression)].map((match) => match[0]);
}

function protectedLiterals(value, protectedSource = PROTECTED_SOURCE) {
  return occurrences(value, new RegExp(protectedSource, "gu")).sort();
}

function assertProtectedLiterals(source, translated, label, protectedSource = PROTECTED_SOURCE) {
  const actualCounts = new Map();
  for (const literal of protectedLiterals(translated, protectedSource)) {
    actualCounts.set(literal, (actualCounts.get(literal) ?? 0) + 1);
  }
  const expectedCounts = new Map();
  for (const literal of protectedLiterals(source, protectedSource)) {
    expectedCounts.set(literal, (expectedCounts.get(literal) ?? 0) + 1);
  }
  for (const [literal, count] of expectedCounts) {
    if ((actualCounts.get(literal) ?? 0) < count) {
      throw new Error(`${label} did not preserve ${literal} exactly.`);
    }
  }
  const controlPattern = new RegExp(CONTROL_TOKEN.source, "giu");
  const expectedControls = occurrences(source, controlPattern).map((value) => value.toUpperCase()).sort();
  const actualControls = occurrences(translated, new RegExp(CONTROL_TOKEN.source, "giu"))
    .map((value) => value.toUpperCase())
    .sort();
  if (JSON.stringify(actualControls) !== JSON.stringify(expectedControls)) {
    throw new Error(`${label} did not preserve control tokens exactly.`);
  }
}

function assertTranslation(
  source,
  translated,
  label,
  { korean = true, protectedSource = PROTECTED_SOURCE } = {},
) {
  if (korean) requireKorean(translated, label);
  else requireNonblank(translated, label);
  assertProtectedLiterals(source, translated, label, protectedSource);
}

function assertTranslatedJsonShape(source, translated, label) {
  let sourceValue;
  try {
    sourceValue = JSON.parse(source);
  } catch {
    return;
  }
  let translatedValue;
  try {
    translatedValue = JSON.parse(translated);
  } catch {
    throw new Error(`${label} must remain valid JSON.`);
  }
  const visit = (original, localized, location) => {
    if (Array.isArray(original)) {
      if (!Array.isArray(localized) || localized.length !== original.length) {
        throw new Error(`${label} changed JSON array shape at ${location}.`);
      }
      original.forEach((value, index) => visit(value, localized[index], `${location}[${index}]`));
      return;
    }
    if (isRecord(original)) {
      if (!isRecord(localized)) throw new Error(`${label} changed JSON object shape at ${location}.`);
      requireExactKeys(localized, Object.keys(original), `${label} JSON object at ${location}`);
      for (const key of Object.keys(original)) visit(original[key], localized[key], `${location}.${key}`);
      return;
    }
    if (typeof original === "string") {
      if (typeof localized !== "string") throw new Error(`${label} changed JSON string type at ${location}.`);
      return;
    }
    if (!Object.is(localized, original)) throw new Error(`${label} changed JSON literal at ${location}.`);
  };
  visit(sourceValue, translatedValue, "$");
}

function taskProtectedLiterals(value) {
  return [...new Set(TASK_PROTECTED_PATTERNS.flatMap((pattern) => value.match(pattern) ?? []))]
    .filter((literal) => !/^\d{1,2}(?:am|pm|h|st|nd|rd|th)$/iu.test(literal))
    .filter((literal) => !/^\d{1,3}-year-old$/iu.test(literal));
}

function assertTaskTranslation(source, translated, label) {
  const result = requireKorean(translated, label);
  if (/__TAU\d+TOKEN__/u.test(result)) throw new Error(`${label} contains a translation placeholder.`);
  if (/\b\d{5}\ub144/u.test(result)) throw new Error(`${label} mistranslates a ZIP code as a year.`);
  for (const literal of taskProtectedLiterals(source)) {
    if (!result.includes(literal)) throw new Error(`${label} did not preserve ${literal}.`);
  }
  return result;
}

function assertPlaceholder(source, translated, placeholder, label) {
  const sourceCount = source.split(placeholder).length - 1;
  const translatedCount = translated.split(placeholder).length - 1;
  if (sourceCount === 0 || sourceCount !== translatedCount) {
    throw new Error(`${label} must preserve ${placeholder} exactly.`);
  }
}

function stableId(prefix, parts, length = 22) {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("base64url")
    .slice(0, length);
  return `${prefix}_${digest}`;
}

const serializedJson = (value, pretty = false) =>
  `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;

function safeOutput(relativePath) {
  const output = path.join(stagingDataRoot, relativePath);
  if (!output.startsWith(`${stagingDataRoot}${path.sep}`)) {
    throw new Error(`Unsafe generated path: ${relativePath}`);
  }
  return output;
}

function writeJson(relativePath, value, pretty = false) {
  const output = safeOutput(relativePath);
  const serialized = serializedJson(value, pretty);
  const bytes = Buffer.byteLength(serialized);
  if (bytes >= 25 * 1024 * 1024) {
    throw new Error(`${relativePath} exceeds the 25 MiB static asset limit.`);
  }
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, serialized);
  return {
    path: `/data/${relativePath}`,
    sha256: sha256(serialized),
    bytes,
  };
}

function writeContentAddressedJson(directory, basename, value) {
  const serialized = serializedJson(value);
  const hash = sha256(serialized);
  const relativePath = `${directory}/${basename}_${hash.slice(0, 18)}.json`;
  const written = writeJson(relativePath, value);
  if (written.sha256 !== hash) throw new Error(`Hash drift while writing ${relativePath}.`);
  return written;
}

function readAtRuntimeCommit(relativePath) {
  return execFileSync(
    "git",
    ["-C", tau2Root, "show", `${runtimeCommit}:${relativePath}`],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
}

function activeToolDecoratorCount(relativePath) {
  return readAtRuntimeCommit(relativePath)
    .split("\n")
    .filter((line) => /^\s*@is_tool\(/u.test(line)).length;
}

function extractTripleQuoted(source, name, { trim = false } = {}) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*=\\s*f?"""([\\s\\S]*?)"""`));
  if (!match) throw new Error(`Could not resolve Python triple-quoted value ${name}.`);
  return trim ? match[1].trim() : match[1];
}

function resolveTemplate(template, replacements, label) {
  let output = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    const count = output.split(placeholder).length - 1;
    if (count !== 1) throw new Error(`${label} expected one ${placeholder}, got ${count}.`);
    output = output.replace(placeholder, value);
  }
  return output;
}

function maybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isToolTranslationEligible(value) {
  const compact = value.trim();
  return Boolean(compact)
    && /[A-Za-z]/u.test(compact)
    && !CONTROL_ONLY.test(compact)
    && !TOOL_URL_ONLY.test(compact)
    && !TOOL_EMAIL_ONLY.test(compact)
    && !TOOL_COMPACT_UPPER_CODE.test(compact)
    && !TOOL_COMPACT_MIXED_ALNUM.test(compact)
    && !TOOL_SNAKE_IDENTIFIER.test(compact);
}

function jsonPointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function visitStringLeaves(value, pointer, visitor) {
  if (typeof value === "string") {
    visitor(value, pointer);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visitStringLeaves(item, `${pointer}/${index}`, visitor);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      visitStringLeaves(item, `${pointer}/${jsonPointerSegment(key)}`, visitor);
    }
  }
}

function recordSurfaceValue(surface, value) {
  surface.occurrences += 1;
  surface.values.add(value);
}

function createSurfaceStats() {
  return { occurrences: 0, values: new Set() };
}

function surfaceTotals(surface) {
  return { occurrences: surface.occurrences, unique: surface.values.size };
}

function toolTranslationId(content) {
  const sourceHash = sha256(content);
  return { id: `tool_${sourceHash.slice(0, 24)}`, sourceHash };
}

function collectToolTranslationRefs(messages, generation) {
  const refs = {};
  messages.forEach((message, messageIndex) => {
    message.toolCalls.forEach((call, callIndex) => {
      const callPointer = `/messages/${messageIndex}/toolCalls/${callIndex}`;
      for (const [surfaceName, value] of [
        ["arguments", call.arguments],
        ["results", call.result],
      ]) {
        visitStringLeaves(value, `${callPointer}/${surfaceName === "arguments" ? "arguments" : "result"}`, (content, pointer) => {
          recordSurfaceValue(generation.toolLeaves.all, content);
          recordSurfaceValue(generation.toolLeaves[surfaceName], content);
          if (!isToolTranslationEligible(content)) {
            recordSurfaceValue(generation.toolLeaves.codeOnly, content);
            return;
          }
          recordSurfaceValue(generation.toolLeaves.translated, content);
          recordSurfaceValue(generation.toolLeaves[`translated${surfaceName === "arguments" ? "Arguments" : "Results"}`], content);
          const identity = toolTranslationId(content);
          const expected = { sourceHash: identity.sourceHash, content };
          const previous = generation.expectedToolTranslations.get(identity.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(expected)) {
            throw new Error(`Tool translation id collision: ${identity.id}.`);
          }
          generation.expectedToolTranslations.set(identity.id, expected);
          if (refs[pointer]) throw new Error(`Duplicate tool translation pointer: ${pointer}.`);
          refs[pointer] = identity.id;
        });
      }
    });
  });
  return refs;
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
  return {
    messages: output,
    orphanToolResults,
    unresolvedToolCalls: [...pending.values()].reduce((sum, queue) => sum + queue.length, 0),
  };
}

function firstSentence(value, fallback) {
  if (!value) return fallback;
  const compact = value.replace(/\s+/g, " ").trim();
  const sentence = compact.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? compact;
  return sentence.length > 96 ? `${sentence.slice(0, 93).trim()}…` : sentence;
}

function compactScenario(scenario) {
  return Object.values(scenario)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function pythonIndent(value, prefix = "\t") {
  return String(value)
    .split("\n")
    .map((line) => (line.trim() ? `${prefix}${line}` : line))
    .join("\n");
}

function structuredInstructionsEnglish(instructions) {
  if (typeof instructions === "string") return instructions;
  const source = requireRecord(instructions, "task user instructions");
  const lines = [
    `Domain: ${requireString(source.domain, "task instructions.domain")}`,
    `Reason for call:\n${pythonIndent(requireString(source.reason_for_call, "task instructions.reason_for_call"))}`,
  ];
  if (source.known_info !== null && source.known_info !== undefined) {
    lines.push(`Known info:\n${pythonIndent(requireString(source.known_info, "task instructions.known_info"))}`);
  }
  if (source.unknown_info !== null && source.unknown_info !== undefined) {
    lines.push(`Unknown info:\n${pythonIndent(requireString(source.unknown_info, "task instructions.unknown_info"))}`);
  }
  lines.push(`Task instructions:\n${pythonIndent(requireString(source.task_instructions, "task instructions.task_instructions"))}`);
  return lines.join("\n");
}

function runtimeScenarioEnglish(task) {
  const userScenario = requireRecord(task.user_scenario, `task ${task.id} user_scenario`);
  const lines = [];
  if (userScenario.persona !== null && userScenario.persona !== undefined) {
    lines.push("Persona:", pythonIndent(requireString(userScenario.persona, `task ${task.id} persona`)));
  }
  lines.push("Instructions:", pythonIndent(structuredInstructionsEnglish(userScenario.instructions)));
  return lines.join("\n");
}

function runtimeScenarioKorean(task, translation) {
  const userScenario = requireRecord(task.user_scenario, `task ${task.id} user_scenario`);
  const translated = requireRecord(translation.scenario, `task ${task.id} Korean scenario`);
  const sourceInstructions = userScenario.instructions;
  if (typeof sourceInstructions === "string") {
    const lines = [];
    if (userScenario.persona !== null && userScenario.persona !== undefined) {
      lines.push("페르소나:", pythonIndent(requireKorean(translated.persona, `task ${task.id} persona`)));
    }
    lines.push("지침:", pythonIndent(requireKorean(translated.taskInstructions, `task ${task.id} taskInstructions`)));
    return lines.join("\n");
  }
  const instructions = requireRecord(sourceInstructions, `task ${task.id} instructions`);
  const body = [
    `도메인: ${requireString(instructions.domain, `task ${task.id} domain`)}`,
    `문의 이유:\n${pythonIndent(requireKorean(translated.reasonForCall, `task ${task.id} reasonForCall`))}`,
  ];
  if (instructions.known_info !== null && instructions.known_info !== undefined) {
    body.push(`알고 있는 정보:\n${pythonIndent(requireKorean(translated.knownInfo, `task ${task.id} knownInfo`))}`);
  }
  if (instructions.unknown_info !== null && instructions.unknown_info !== undefined) {
    body.push(`모르는 정보:\n${pythonIndent(requireKorean(translated.unknownInfo, `task ${task.id} unknownInfo`))}`);
  }
  body.push(`작업 지침:\n${pythonIndent(requireKorean(translated.taskInstructions, `task ${task.id} taskInstructions`))}`);
  const lines = [];
  if (userScenario.persona !== null && userScenario.persona !== undefined) {
    lines.push("페르소나:", pythonIndent(requireKorean(translated.persona, `task ${task.id} persona`)));
  }
  lines.push("지침:", pythonIndent(body.join("\n")));
  return lines.join("\n");
}

function pythonStringRepr(value) {
  const useDouble = value.includes("'") && !value.includes('"');
  const quote = useDouble ? '"' : "'";
  let escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
  escaped = useDouble ? escaped.replaceAll('"', '\\"') : escaped.replaceAll("'", "\\'");
  return `${quote}${escaped}${quote}`;
}

const pythonListRepr = (values) => `[${values.map(pythonStringRepr).join(", ")}]`;

function rawTrajectoryText(messages, translateMessage) {
  return messages
    .map((message) => {
      const rawContent = message.content;
      const content = rawContent === null || rawContent === undefined
        ? "None"
        : translateMessage(message, String(rawContent));
      return `${String(message.role)}: ${content}`;
    })
    .join("\n");
}

function messageTranslationId(role, content) {
  const sourceHash = sha256(JSON.stringify([role, content]));
  return { id: `msg_${sourceHash.slice(0, 24)}`, sourceHash };
}

const agentSourcePath = "src/tau2/agent/llm_agent.py";
const userSourcePath = "src/tau2/user/user_simulator.py";
const evaluatorSourcePath = "src/tau2/evaluator/evaluator_nl_assertions.py";
const agentSource = readAtRuntimeCommit(agentSourcePath);
const userSource = readAtRuntimeCommit(userSourcePath);
const evaluatorSource = readAtRuntimeCommit(evaluatorSourcePath);
const agentInstruction = extractTripleQuoted(agentSource, "AGENT_INSTRUCTION", { trim: true });
const agentTemplate = extractTripleQuoted(agentSource, "SYSTEM_PROMPT", { trim: true });
const userTemplate = extractTripleQuoted(userSource, "SYSTEM_PROMPT", { trim: true });
const evaluatorSystem = extractTripleQuoted(evaluatorSource, "system_prompt");
const evaluatorUserTemplate = extractTripleQuoted(evaluatorSource, "user_prompt");

if (
  Buffer.byteLength(agentInstruction) !== 489
  || sha256(agentInstruction) !== "ee69e38fa2832e13bf808cbf73c72b961af1c34459848cbf5bd9b27e983d37ac"
) {
  throw new Error("The pinned 964ef AGENT_INSTRUCTION changed.");
}

const runtimeUrls = {
  agent: `${repository}/blob/${runtimeCommit}/${agentSourcePath}`,
  user: `${repository}/blob/${runtimeCommit}/${userSourcePath}`,
  evaluator: `${repository}/blob/${runtimeCommit}/${evaluatorSourcePath}`,
};

const runtimePrompts = {
  agent: {
    model: "GPT-5",
    instruction: { sourceHash: sha256(agentInstruction), content: agentInstruction, sourceUrl: runtimeUrls.agent },
    systemTemplate: { sourceHash: sha256(agentTemplate), content: agentTemplate, sourceUrl: runtimeUrls.agent },
  },
  evaluator: {
    model: "gpt-4o-mini",
    temperature: 0,
    invocationCount: 232,
    system: { sourceHash: sha256(evaluatorSystem), content: evaluatorSystem, sourceUrl: runtimeUrls.evaluator },
    userTemplate: { sourceHash: sha256(evaluatorUserTemplate), content: evaluatorUserTemplate, sourceUrl: runtimeUrls.evaluator },
  },
};

function userPromptFor(spec) {
  const guidelines = readAtRuntimeCommit(spec.promptSource);
  const guidelinesUrl = `${repository}/blob/${runtimeCommit}/${spec.promptSource}`;
  const content = resolveTemplate(
    userTemplate,
    {
      "{global_user_sim_guidelines}": guidelines,
      "{instructions}": "{{ user_scenario }}",
    },
    `${spec.domainId} user prompt`,
  );
  return {
    id: spec.promptId,
    label: spec.promptLabel,
    description: spec.promptDescription,
    content,
    sourceHash: sha256(content),
    sourceUrl: runtimeUrls.user,
    sourceLinks: [
      {
        label: "Runtime wrapper",
        sourcePath: userSourcePath,
        sourceUrl: runtimeUrls.user,
      },
      {
        label: "Simulation guidelines",
        sourcePath: spec.promptSource,
        sourceUrl: guidelinesUrl,
      },
    ],
  };
}

function validateTaskTranslationRoot(source) {
  requireExactKeys(source, ["schemaVersion", "datasetId", "locale", "domains"], "task translation root");
  if (source.schemaVersion !== 1 || source.locale !== "ko") {
    throw new Error("Task translations must use schemaVersion 1 and locale ko.");
  }
  // This curated source predates the narrowed dataset; selected subtrees remain authoritative.
  return requireRecord(source.domains, "task translation domains");
}

function buildTaskEntries(spec, tasks, taskTranslationDomains) {
  const translationDomain = requireRecord(taskTranslationDomains[spec.domainId], `task translations for ${spec.domainId}`);
  requireExactKeys(translationDomain, ["tasks"], `${spec.domainId} task translations`);
  const translatedTasks = requireRecord(translationDomain.tasks, `${spec.domainId} translated tasks`);
  const taskIds = tasks.map((task) => String(task.id));
  requireExactKeys(translatedTasks, taskIds, `${spec.domainId} translated task set`);
  return Object.fromEntries(tasks.map((task) => {
    const taskId = String(task.id);
    const translation = requireRecord(translatedTasks[taskId], `${spec.domainId} task ${taskId} translation`);
    requireExactKeys(translation, ["title", "descriptionPurpose", "scenario"], `${spec.domainId} task ${taskId} translation`);
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
    const translatedScenario = requireRecord(translation.scenario, `${spec.domainId} task ${taskId} scenario translation`);
    requireExactKeys(translatedScenario, Object.keys(scenario), `${spec.domainId} task ${taskId} scenario translation`);
    for (const key of Object.keys(scenario)) {
      const sourceValue = scenario[key];
      const translatedValue = translatedScenario[key];
      if (sourceValue === null) {
        if (translatedValue !== null) throw new Error(`${spec.domainId} task ${taskId} scenario.${key} must remain null.`);
      } else {
        assertTaskTranslation(requireString(sourceValue, `${spec.domainId} task ${taskId} scenario.${key}`), translatedValue, `${spec.domainId} task ${taskId} scenario.${key} translation`);
      }
    }
    const descriptionPurpose = task.description?.purpose ?? null;
    if (descriptionPurpose === null) {
      if (translation.descriptionPurpose !== null) throw new Error(`${spec.domainId} task ${taskId} descriptionPurpose must remain null.`);
    } else {
      assertTaskTranslation(descriptionPurpose, translation.descriptionPurpose, `${spec.domainId} task ${taskId} descriptionPurpose translation`);
    }
    const title = firstSentence(descriptionPurpose ?? scenario.reasonForCall, `Task ${taskId}`);
    assertTaskTranslation(title, translation.title, `${spec.domainId} task ${taskId} title translation`);
    const runtimeScenario = runtimeScenarioEnglish(task);
    const runtimeScenarioKo = runtimeScenarioKorean(task, translation);
    requireKorean(runtimeScenarioKo, `${spec.domainId} task ${taskId} runtimeScenario translation`);
    return [taskId, {
      taskId,
      title,
      scenario,
      runtimeScenario,
      task,
      translations: {
        ko: {
          title: translation.title,
          descriptionPurpose: translation.descriptionPurpose,
          scenario: { ...translatedScenario },
          runtimeScenario: runtimeScenarioKo,
        },
      },
    }];
  }));
}

function validateTranscriptMemory(spec, source, expectedEntries) {
  requireExactKeys(source, ["schemaVersion", "datasetId", "locale", "model", "domainId", "runId", "entries"], `${spec.runId} transcript translations`);
  if (
    source.schemaVersion !== 1
    || source.datasetId !== datasetId
    || source.locale !== "ko"
    || source.model !== "GPT-5"
    || source.domainId !== spec.domainId
    || source.runId !== spec.runId
  ) throw new Error(`${spec.runId} transcript translation metadata differs from the pinned run.`);
  const entries = requireRecord(source.entries, `${spec.runId} transcript entries`);
  requireExactKeys(entries, [...expectedEntries.keys()], `${spec.runId} transcript entries`);
  for (const [entryId, expected] of expectedEntries) {
    const entry = requireRecord(entries[entryId], `${spec.runId} ${entryId}`);
    requireExactKeys(entry, ["role", "sourceHash", "content"], `${spec.runId} ${entryId}`);
    if (entry.role !== expected.role || entry.sourceHash !== expected.sourceHash) {
      throw new Error(`${spec.runId} ${entryId} source identity differs.`);
    }
    assertTranslation(expected.content, entry.content, `${spec.runId} ${entryId}`);
    assertTranslatedJsonShape(expected.content, entry.content, `${spec.runId} ${entryId}`);
  }
  return entries;
}

function validateToolTranslations(source, expectedEntries) {
  requireExactKeys(
    source,
    ["schemaVersion", "datasetId", "locale", "model", "classifierVersion", "entries"],
    "GPT-5 tool translations",
  );
  if (
    source.schemaVersion !== 1
    || source.datasetId !== datasetId
    || source.locale !== "ko"
    || source.model !== "GPT-5"
    || source.classifierVersion !== toolClassifierVersion
  ) throw new Error("GPT-5 tool translation metadata differs from the selected dataset.");
  const entries = requireRecord(source.entries, "GPT-5 tool translation entries");
  requireExactKeys(entries, [...expectedEntries.keys()], "GPT-5 tool translation entries");
  for (const [entryId, expected] of expectedEntries) {
    const entry = requireRecord(entries[entryId], `tool translation ${entryId}`);
    requireExactKeys(entry, ["sourceHash", "content"], `tool translation ${entryId}`);
    if (entry.sourceHash !== expected.sourceHash) {
      throw new Error(`tool translation ${entryId} source identity differs.`);
    }
    assertTranslation(expected.content, entry.content, `tool translation ${entryId}`, {
      protectedSource: TOOL_PROTECTED_SOURCE,
    });
  }
  return entries;
}

function prepareRun(spec, taskTranslationDomains, generation) {
  const actualAgentToolCount = activeToolDecoratorCount(
    `src/tau2/domains/${spec.slug}/tools.py`,
  );
  const actualUserToolCount = spec.userToolCount === 0
    ? 0
    : activeToolDecoratorCount(`src/tau2/domains/${spec.slug}/user_tools.py`);
  if (
    actualAgentToolCount !== spec.agentToolCount
    || actualUserToolCount !== spec.userToolCount
  ) {
    throw new Error(`${spec.domainId} runtime tool inventory changed: ${JSON.stringify({
      agent: actualAgentToolCount,
      user: actualUserToolCount,
    })}`);
  }
  const sourceRelative = `${submissionRelative}/${spec.sourceFile}`;
  const raw = read(path.join(tau2Root, sourceRelative));
  if (sha256(raw) !== spec.sourceSha256) throw new Error(`${spec.sourceFile} does not match the pinned submission hash.`);
  const result = JSON.parse(raw);
  if (
    result.info?.git_commit !== runtimeCommit
    || result.info?.agent_info?.llm !== "gpt-5"
    || result.info?.user_info?.llm !== "gpt-4.1-2025-04-14"
    || result.info?.num_trials !== 4
  ) throw new Error(`${spec.sourceFile} runtime provenance differs from the pinned GPT-5 run.`);
  if (result.info?.environment_info?.domain_name !== spec.slug) throw new Error(`${spec.sourceFile} environment changed.`);
  if (result.tasks.length !== spec.taskCount || result.simulations.length !== spec.trajectoryCount) {
    throw new Error(`${spec.sourceFile} task or trajectory count changed.`);
  }
  const sourceKey = `tau2:${sourceRelative}`;
  const runId = stableId("run", ["tau2", sourceRelative], 18);
  if (runId !== spec.runId) throw new Error(`${spec.sourceFile} run id changed to ${runId}.`);
  const taskEntries = buildTaskEntries(spec, result.tasks, taskTranslationDomains);
  const taskById = new Map(result.tasks.map((task) => [String(task.id), task]));
  const prepared = [];
  const expectedTranslations = new Map();
  for (const record of result.simulations) {
    const taskId = String(record.task_id);
    const taskEntry = taskEntries[taskId];
    const task = taskById.get(taskId);
    if (!taskEntry || !task) throw new Error(`${spec.sourceFile} references unknown task ${taskId}.`);
    const normalized = normalizeMessages(record.messages);
    generation.orphanToolResults += normalized.orphanToolResults;
    generation.unresolvedToolCalls += normalized.unresolvedToolCalls;
    const trial = record.trial ?? 0;
    const trajectoryId = stableId("tr", ["tau2", sourceKey, record.id ?? taskId, trial]);
    if (generation.trajectoryIds.has(trajectoryId)) throw new Error(`Duplicate trajectory id: ${trajectoryId}`);
    generation.trajectoryIds.add(trajectoryId);
    const assertions = task.evaluation_criteria?.nl_assertions ?? [];
    const evaluationPrompt = assertions.length
      ? {
          model: "gpt-4o-mini",
          userPrompt: resolveTemplate(
            evaluatorUserTemplate,
            {
              "{trajectory_str}": rawTrajectoryText(record.messages, (_message, content) => content),
              "{nl_assertions}": pythonListRepr(assertions),
            },
            `${trajectoryId} evaluator prompt`,
          ),
        }
      : undefined;
    if (evaluationPrompt) generation.evaluatorPrompts += 1;
    const toolCalls = normalized.messages.flatMap((message) => message.toolCalls);
    const toolTranslationRefs = collectToolTranslationRefs(normalized.messages, generation);
    const toolNames = [...new Set(toolCalls.map((call) => call.name))].sort();
    for (const message of normalized.messages) {
      generation.messages += 1;
      generation.toolCalls += message.toolCalls.length;
      generation.userToolCalls += message.toolCalls.filter((call) => call.requestor === "user").length;
      const content = message.content;
      if (content === null || content === "") {
        generation.nullOrEmptyContents += 1;
        continue;
      }
      generation.messageContents += 1;
      if (CONTROL_ONLY.test(content)) {
        generation.controlOnlyContents += 1;
        continue;
      }
      const identity = messageTranslationId(message.role, content);
      const expected = { role: message.role, sourceHash: identity.sourceHash, content };
      const previous = expectedTranslations.get(identity.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(expected)) {
        throw new Error(`Message translation id collision: ${identity.id}.`);
      }
      expectedTranslations.set(identity.id, expected);
    }
    const detail = {
      id: trajectoryId,
      runId,
      taskId,
      trial,
      reward: record.reward_info?.reward ?? 0,
      title: taskEntry.title,
      terminationReason: record.termination_reason,
      duration: record.duration,
      agentCost: record.agent_cost ?? null,
      userCost: record.user_cost ?? null,
      evaluation: record.reward_info ?? null,
      ...(evaluationPrompt ? { evaluationPrompt } : {}),
      messages: normalized.messages,
    };
    prepared.push({
      detail,
      record,
      assertions,
      toolTranslationRefs,
      summary: {
        id: trajectoryId,
        detailPath: "",
        domainId: spec.domainId,
        runId,
        taskId,
        trial,
        reward: detail.reward,
        title: detail.title,
        terminationReason: detail.terminationReason,
        duration: detail.duration,
        agentCost: detail.agentCost,
        userCost: detail.userCost,
        messageCount: normalized.messages.length,
        toolCallCount: toolCalls.length,
        userToolCallCount: toolCalls.filter((call) => call.requestor === "user").length,
        toolNames,
        scenarioPreview: compactScenario(taskEntry.scenario),
      },
    });
  }
  const transcriptSource = readJson(path.join(transcriptTranslationsRoot, `${runId}.json`));
  const transcriptEntries = validateTranscriptMemory(spec, transcriptSource, expectedTranslations);
  generation.transcriptEntries += expectedTranslations.size;
  const chunks = [];
  for (let start = 0; start < prepared.length; start += detailsPerChunk) {
    const members = prepared.slice(start, start + detailsPerChunk);
    const chunkNumber = String(Math.floor(start / detailsPerChunk)).padStart(4, "0");
    const detailRelative = `sets/${datasetId}/chunks/${runId}/chunk_${chunkNumber}.json`;
    const detailPath = `/data/${detailRelative}`;
    for (const member of members) member.summary.detailPath = detailPath;
    chunks.push({ chunkNumber, detailRelative, detailPath, members });
  }
  const prompt = userPromptFor(spec);
  const policy = requireString(result.info?.environment_info?.policy, `${spec.sourceFile} runtime policy`);
  const policyHash = sha256(policy);
  const policySnapshotId = `policy_${policyHash.slice(0, 16)}`;
  const sourceUrl = `${repository}/blob/${releaseTag}/${sourceRelative}`;
  return {
    spec,
    sourceRelative,
    sourceUrl,
    result,
    runId,
    taskEntries,
    prepared,
    chunks,
    transcriptEntries,
    prompt,
    policy,
    policyHash,
    policySnapshotId,
  };
}

function validateContextDocument(record, source, label, options) {
  requireExactKeys(record, ["sourceHash", "content"], label);
  if (record.sourceHash !== sha256(source)) throw new Error(`${label} sourceHash differs.`);
  assertTranslation(source, record.content, label, options);
  return record;
}

function validateContextTranslations(source, plans) {
  requireExactKeys(source, ["schemaVersion", "datasetId", "locale", "model", "common", "domains"], "GPT-5 context translations");
  if (
    source.schemaVersion !== 1
    || source.datasetId !== datasetId
    || source.locale !== "ko"
    || source.model !== "GPT-5"
  ) throw new Error("GPT-5 context translation metadata differs from the selected dataset.");
  const common = requireRecord(source.common, "context common translations");
  requireExactKeys(common, ["agentInstruction", "agentTemplate", "evaluatorSystem", "evaluatorUserTemplate", "evaluationAssertions"], "context common translations");
  validateContextDocument(common.agentInstruction, agentInstruction, "agent instruction translation");
  validateContextDocument(common.agentTemplate, agentTemplate, "agent template translation", { korean: false });
  assertPlaceholder(agentTemplate, common.agentTemplate.content, "{agent_instruction}", "agent template");
  assertPlaceholder(agentTemplate, common.agentTemplate.content, "{domain_policy}", "agent template");
  validateContextDocument(common.evaluatorSystem, evaluatorSystem, "evaluator system translation");
  validateContextDocument(common.evaluatorUserTemplate, evaluatorUserTemplate, "evaluator user template translation");
  assertPlaceholder(evaluatorUserTemplate, common.evaluatorUserTemplate.content, "{trajectory_str}", "evaluator user template");
  assertPlaceholder(evaluatorUserTemplate, common.evaluatorUserTemplate.content, "{nl_assertions}", "evaluator user template");
  const expectedAssertions = new Map();
  for (const plan of plans) {
    for (const task of plan.result.tasks) {
      for (const assertion of task.evaluation_criteria?.nl_assertions ?? []) {
        expectedAssertions.set(sha256(assertion), assertion);
      }
    }
  }
  const translatedAssertions = requireRecord(common.evaluationAssertions, "evaluation assertion translations");
  requireExactKeys(translatedAssertions, [...expectedAssertions.keys()], "evaluation assertion translations");
  for (const [sourceHash, assertion] of expectedAssertions) {
    assertTranslation(assertion, translatedAssertions[sourceHash], `evaluation assertion ${sourceHash}`);
  }
  const domains = requireRecord(source.domains, "context domain translations");
  requireExactKeys(domains, plans.map((plan) => plan.spec.domainId), "context translation domains");
  for (const plan of plans) {
    const domain = requireRecord(domains[plan.spec.domainId], `${plan.spec.domainId} context`);
    requireExactKeys(domain, ["policy", "userPrompt"], `${plan.spec.domainId} context`);
    validateContextDocument(domain.policy, plan.policy, `${plan.spec.domainId} policy translation`);
    const userPrompt = requireRecord(domain.userPrompt, `${plan.spec.domainId} user prompt translation`);
    requireExactKeys(userPrompt, ["id", "sourceHash", "label", "description", "content"], `${plan.spec.domainId} user prompt translation`);
    if (userPrompt.id !== plan.prompt.id || userPrompt.sourceHash !== plan.prompt.sourceHash) {
      throw new Error(`${plan.spec.domainId} user prompt source identity differs.`);
    }
    requireKorean(userPrompt.label, `${plan.spec.domainId} user prompt label`);
    requireKorean(userPrompt.description, `${plan.spec.domainId} user prompt description`);
    assertTranslation(plan.prompt.content, userPrompt.content, `${plan.spec.domainId} user prompt content`);
    assertPlaceholder(plan.prompt.content, userPrompt.content, "{{ user_scenario }}", `${plan.spec.domainId} user prompt`);
  }
  return { common, domains, translatedAssertions };
}

function localizedToolLeaf(content, toolTranslations, label) {
  if (!isToolTranslationEligible(content)) return content;
  const identity = toolTranslationId(content);
  const translation = toolTranslations[identity.id];
  if (!translation) throw new Error(`${label} is missing tool translation ${identity.id}.`);
  return translation.content;
}

function localizedToolValue(value, toolTranslations, label) {
  if (typeof value === "string") {
    return localizedToolLeaf(value, toolTranslations, label);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      localizedToolValue(item, toolTranslations, `${label}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      localizedToolValue(item, toolTranslations, `${label}.${key}`),
    ]));
  }
  return value;
}

function localizedToolMessageContent(content, toolTranslations, label) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return localizedToolLeaf(content, toolTranslations, label);
  }
  return JSON.stringify(localizedToolValue(parsed, toolTranslations, label));
}

function localizedEvaluatorTrajectory(plan, member, toolTranslations) {
  const roleLabels = { assistant: "상담원", user: "사용자", tool: "도구", system: "시스템" };
  return member.record.messages.map((message, messageIndex) => {
    const role = roleLabels[message.role] ?? String(message.role);
    if (message.content === null || message.content === undefined) return `${role}: 없음`;
    const content = String(message.content);
    if (message.role === "tool") {
      return `${role}: ${localizedToolMessageContent(
        content,
        toolTranslations,
        `${member.detail.id} evaluator tool message ${messageIndex}`,
      )}`;
    }
    if (message.role === "user" || message.role === "assistant") {
      if (!content.trim() || CONTROL_ONLY.test(content)) return `${role}: ${content}`;
      const identity = messageTranslationId(message.role, content);
      const translation = plan.transcriptEntries[identity.id];
      if (!translation) throw new Error(`${member.detail.id} is missing evaluator message ${identity.id}.`);
      return `${role}: ${translation.content}`;
    }
    return `${role}: ${content}`;
  }).join("\n");
}

function localizedEvaluatorPrompt(plan, member, context, toolTranslations) {
  if (!member.assertions.length) return undefined;
  const trajectory = localizedEvaluatorTrajectory(plan, member, toolTranslations);
  const assertions = member.assertions.map((assertion) => {
    const translated = context.translatedAssertions[sha256(assertion)];
    if (!translated) throw new Error(`${member.detail.id} assertion translation is missing.`);
    return translated;
  });
  const prompt = resolveTemplate(
    context.common.evaluatorUserTemplate.content,
    { "{trajectory_str}": trajectory, "{nl_assertions}": pythonListRepr(assertions) },
    `${member.detail.id} Korean evaluator prompt`,
  );
  requireKorean(prompt, `${member.detail.id} Korean evaluator prompt`);
  if (/^(?:assistant|user|tool|system):/mu.test(prompt) || /:\s*None(?:\s|$)/mu.test(prompt)) {
    throw new Error(`${member.detail.id} Korean evaluator prompt retained English role labels.`);
  }
  return prompt;
}

function buildTranscriptOverlay(plan, chunk, context, toolTranslations) {
  const trajectories = {};
  for (const member of chunk.members) {
    const messages = {};
    member.detail.messages.forEach((message, messageIndex) => {
      const content = message.content;
      if (content === null || content === "" || CONTROL_ONLY.test(content)) return;
      const identity = messageTranslationId(message.role, content);
      const translation = plan.transcriptEntries[identity.id];
      if (!translation) throw new Error(`${member.detail.id} is missing ${identity.id}.`);
      messages[String(messageIndex)] = translation.content;
    });
    const toolLeaves = Object.fromEntries(Object.entries(member.toolTranslationRefs).map(
      ([pointer, entryId]) => {
        const translation = toolTranslations[entryId];
        if (!translation) throw new Error(`${member.detail.id} is missing ${entryId}.`);
        return [pointer, translation.content];
      },
    ));
    const evaluatorUserPrompt = localizedEvaluatorPrompt(
      plan,
      member,
      context,
      toolTranslations,
    );
    trajectories[member.detail.id] = {
      messages,
      ...(Object.keys(toolLeaves).length ? { toolLeaves } : {}),
      ...(evaluatorUserPrompt ? { evaluatorUserPrompt } : {}),
    };
  }
  return {
    schemaVersion: translationSchemaVersion,
    datasetId,
    locale: "ko",
    model: "GPT-5",
    runId: plan.runId,
    sourceDetailPath: chunk.detailPath,
    trajectories,
  };
}

function buildContextAsset(plan, context) {
  const domain = context.domains[plan.spec.domainId];
  const domainAssertions = {};
  for (const task of plan.result.tasks) {
    for (const assertion of task.evaluation_criteria?.nl_assertions ?? []) {
      const sourceHash = sha256(assertion);
      domainAssertions[sourceHash] = context.translatedAssertions[sourceHash];
    }
  }
  const agentResolvedEnglish = resolveTemplate(
    agentTemplate,
    { "{agent_instruction}": agentInstruction, "{domain_policy}": plan.policy },
    `${plan.spec.domainId} agent system prompt`,
  );
  const agentResolvedKorean = resolveTemplate(
    context.common.agentTemplate.content,
    {
      "{agent_instruction}": context.common.agentInstruction.content,
      "{domain_policy}": domain.policy.content,
    },
    `${plan.spec.domainId} Korean agent system prompt`,
  );
  return {
    schemaVersion: translationSchemaVersion,
    datasetId,
    locale: "ko",
    model: "GPT-5",
    domainId: plan.spec.domainId,
    source: { repository, release: releaseTag, runtimeCommit },
    policy: domain.policy,
    policySnapshots: { [plan.policySnapshotId]: domain.policy },
    agent: {
      model: "GPT-5",
      instruction: context.common.agentInstruction,
      systemTemplate: context.common.agentTemplate,
      resolvedSystemPrompt: { sourceHash: sha256(agentResolvedEnglish), content: agentResolvedKorean },
    },
    user: { model: "gpt-4.1-2025-04-14", prompt: domain.userPrompt },
    evaluator: {
      model: "gpt-4o-mini",
      temperature: 0,
      invocationCount: plan.spec.evaluatorInvocations,
      system: context.common.evaluatorSystem,
      userTemplate: context.common.evaluatorUserTemplate,
      assertions: Object.fromEntries(Object.entries(domainAssertions).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

function recursiveFileCount(directory) {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += recursiveFileCount(path.join(directory, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function main() {
  const taskTranslationDomains = validateTaskTranslationRoot(readJson(taskTranslationsPath));
  const contextTranslationSource = readJson(contextTranslationsPath);
  const toolTranslationSource = readJson(toolTranslationsPath);
  const generation = {
    trajectoryIds: new Set(),
    expectedToolTranslations: new Map(),
    orphanToolResults: 0,
    unresolvedToolCalls: 0,
    messages: 0,
    messageContents: 0,
    nullOrEmptyContents: 0,
    controlOnlyContents: 0,
    transcriptEntries: 0,
    toolCalls: 0,
    userToolCalls: 0,
    evaluatorPrompts: 0,
    detailBytes: 0,
    maxDetailBytes: 0,
    writtenAssets: 0,
    toolLeaves: {
      all: createSurfaceStats(),
      arguments: createSurfaceStats(),
      results: createSurfaceStats(),
      translated: createSurfaceStats(),
      translatedArguments: createSurfaceStats(),
      translatedResults: createSurfaceStats(),
      codeOnly: createSurfaceStats(),
    },
  };
  const plans = selectedRuns.map((spec) => prepareRun(spec, taskTranslationDomains, generation));
  const toolTranslations = validateToolTranslations(
    toolTranslationSource,
    generation.expectedToolTranslations,
  );
  const context = validateContextTranslations(contextTranslationSource, plans);
  const totals = {
    runs: plans.length,
    tasks: plans.reduce((sum, plan) => sum + plan.spec.taskCount, 0),
    trajectories: plans.reduce((sum, plan) => sum + plan.prepared.length, 0),
    detailChunks: plans.reduce((sum, plan) => sum + plan.chunks.length, 0),
  };
  const toolLeafTotals = {
    all: surfaceTotals(generation.toolLeaves.all),
    arguments: surfaceTotals(generation.toolLeaves.arguments),
    results: surfaceTotals(generation.toolLeaves.results),
    translated: surfaceTotals(generation.toolLeaves.translated),
    translatedArguments: surfaceTotals(generation.toolLeaves.translatedArguments),
    translatedResults: surfaceTotals(generation.toolLeaves.translatedResults),
    codeOnly: surfaceTotals(generation.toolLeaves.codeOnly),
  };
  if (
    totals.runs !== 3
    || totals.tasks !== 278
    || totals.trajectories !== 1_112
    || totals.detailChunks !== 56
    || generation.trajectoryIds.size !== 1_112
    || generation.messages !== 24_619
    || generation.messageContents !== 14_018
    || generation.nullOrEmptyContents !== 10_601
    || generation.controlOnlyContents !== 283
    || generation.transcriptEntries !== 11_520
    || generation.toolCalls !== 15_157
    || generation.userToolCalls !== 6_740
    || generation.evaluatorPrompts !== 232
    || toolLeafTotals.all.occurrences !== 188_101
    || toolLeafTotals.all.unique !== 3_396
    || toolLeafTotals.arguments.occurrences !== 15_477
    || toolLeafTotals.arguments.unique !== 1_236
    || toolLeafTotals.results.occurrences !== 172_624
    || toolLeafTotals.results.unique !== 3_168
    || toolLeafTotals.translated.occurrences !== 72_782
    || toolLeafTotals.translated.unique !== 1_057
    || toolLeafTotals.translatedArguments.occurrences !== 2_333
    || toolLeafTotals.translatedArguments.unique !== 309
    || toolLeafTotals.translatedResults.occurrences !== 70_449
    || toolLeafTotals.translatedResults.unique !== 861
    || toolLeafTotals.codeOnly.occurrences !== 115_319
    || toolLeafTotals.codeOnly.unique !== 2_339
    || generation.expectedToolTranslations.size !== 1_057
  ) {
    throw new Error(`Pinned GPT-5 coverage changed: ${JSON.stringify({
      totals,
      messages: generation.messages,
      messageContents: generation.messageContents,
      nullOrEmptyContents: generation.nullOrEmptyContents,
      controlOnlyContents: generation.controlOnlyContents,
      transcriptEntries: generation.transcriptEntries,
      toolCalls: generation.toolCalls,
      userToolCalls: generation.userToolCalls,
      evaluatorPrompts: generation.evaluatorPrompts,
      toolLeafTotals,
      toolTranslationEntries: generation.expectedToolTranslations.size,
      trajectoryIds: generation.trajectoryIds.size,
    })}`);
  }
  if (generation.orphanToolResults || generation.unresolvedToolCalls) {
    throw new Error(`Tool pairing failed: ${generation.orphanToolResults} orphan, ${generation.unresolvedToolCalls} unresolved.`);
  }

  // Existing public data remains intact until all English and Korean inputs pass preflight.
  rmSync(stagingDataRoot, { recursive: true, force: true });
  rmSync(catalogTemporaryPath, { force: true });
  mkdirSync(stagingDataRoot, { recursive: true });
  try {
    const domains = [];
    for (const plan of plans) {
      const sortedTasks = Object.fromEntries(
        Object.entries(plan.taskEntries).sort(([a], [b]) =>
          a.localeCompare(b, undefined, { numeric: true }),
        ),
      );
      const tasksWritten = writeContentAddressedJson(
        `sets/${datasetId}/tasks`,
        "tasks",
        { schemaVersion, datasetId, tasks: sortedTasks },
      );
      generation.writtenAssets += 1;
      const summaries = [];
      const transcriptOverlayRefs = {};
      for (const chunk of plan.chunks) {
        const detailPayload = {
          schemaVersion,
          datasetId,
          trajectories: Object.fromEntries(chunk.members.map(({ detail }) => [detail.id, detail])),
        };
        const detailWritten = writeJson(chunk.detailRelative, detailPayload);
        generation.writtenAssets += 1;
        generation.detailBytes += detailWritten.bytes;
        generation.maxDetailBytes = Math.max(generation.maxDetailBytes, detailWritten.bytes);
        if (detailWritten.path !== chunk.detailPath) throw new Error(`${chunk.detailPath} path drift.`);
        const overlayWritten = writeContentAddressedJson(
          `sets/${datasetId}/translations/ko/transcripts/${plan.runId}`,
          `chunk_${chunk.chunkNumber}`,
          buildTranscriptOverlay(plan, chunk, context, toolTranslations),
        );
        generation.writtenAssets += 1;
        transcriptOverlayRefs[chunk.detailPath] = {
          ...overlayWritten,
          sourceSha256: detailWritten.sha256,
        };
        summaries.push(...chunk.members.map(({ summary }) => summary));
      }
      const indexWritten = writeJson(`sets/${datasetId}/indexes/${plan.runId}.json`, {
        schemaVersion,
        datasetId,
        runId: plan.runId,
        trajectories: summaries,
        transcriptOverlays: { ko: transcriptOverlayRefs },
      });
      generation.writtenAssets += 1;
      const contextWritten = writeContentAddressedJson(
        `sets/${datasetId}/translations/ko/context`,
        plan.spec.slug,
        buildContextAsset(plan, context),
      );
      generation.writtenAssets += 1;
      const run = {
        id: plan.runId,
        label: "GPT-5 · Default",
        model: "GPT-5",
        userModel: "gpt-4.1-2025-04-14",
        mode: "default",
        environmentId: plan.spec.slug,
        policyVariant: "standard",
        agentImplementation: "llm_agent",
        userImplementation: "user_simulator",
        taskCount: plan.spec.taskCount,
        trajectoryCount: summaries.length,
        passCount: plan.spec.passCount,
        failCount: summaries.length - plan.spec.passCount,
        trials: [0, 1, 2, 3],
        policySnapshotId: plan.policySnapshotId,
        promptRef: plan.prompt.id,
        indexPath: indexWritten.path,
        tasksPath: tasksWritten.path,
        sourceFile: plan.sourceRelative,
        sourceUrl: plan.sourceUrl,
      };
      domains.push({
        id: plan.spec.domainId,
        benchmark: "tau2",
        benchmarkLabel: "τ²-bench",
        versionLabel: releaseTag,
        slug: plan.spec.slug,
        name: plan.spec.name,
        summary: plan.spec.summary,
        taskCount: plan.spec.taskCount,
        trajectoryCount: summaries.length,
        toolCount: plan.spec.agentToolCount + plan.spec.userToolCount,
        agentToolCount: plan.spec.agentToolCount,
        userToolCount: plan.spec.userToolCount,
        policy: plan.policy,
        policySource: plan.spec.policySource,
        policyUrl: plan.spec.policyUrl,
        userPrompts: [plan.prompt],
        promptSource: `${userSourcePath} + ${plan.spec.promptSource}`,
        promptUrl: plan.prompt.sourceUrl,
        source: {
          repository: "sierra-research/tau2-bench",
          commit: runtimeCommit,
          release: releaseTag,
          dataCommit: releaseCommit,
          license: "MIT",
        },
        defaultRunId: plan.runId,
        policySnapshots: [{
          id: plan.policySnapshotId,
          label: "Run policy snapshot",
          content: plan.policy,
          sourceUrl: plan.sourceUrl,
        }],
        contextTranslationPath: contextWritten.path,
        runs: [run],
      });
    }
    if (generation.maxDetailBytes >= 25 * 1024 * 1024) {
      throw new Error("Largest detail asset exceeds the 25 MiB static asset limit.");
    }
    if (generation.writtenAssets !== 121) {
      throw new Error(`Expected 121 public data assets, wrote ${generation.writtenAssets}.`);
    }
    const actualFileCount = recursiveFileCount(stagingDataRoot);
    if (actualFileCount !== generation.writtenAssets) {
      throw new Error(`Staging contains ${actualFileCount} files, expected ${generation.writtenAssets}.`);
    }
    const catalog = {
      schemaVersion,
      datasetId,
      generatedAt: new Date().toISOString(),
      notice: "Pinned GPT-5 conversational trajectories from the official τ²-bench Sierra submission, with exhaustive Korean display overlays.",
      agentOnly: {
        reason: "The selected GPT-5 submission contains interactive user simulations only.",
        runs: 0,
        trajectories: 0,
      },
      selection: {
        benchmark: "tau2",
        model: "GPT-5",
        submission: "gpt-5_sierra_2025-08-09",
        release: releaseTag,
        runtimeCommit,
      },
      sources: [{
        id: "tau2",
        label: "τ²-bench",
        repository,
        revision: releaseTag,
        runtimeCommit,
        dataCommit: releaseCommit,
        license: "MIT",
      }],
      totals: {
        runs: totals.runs,
        tasks: totals.tasks,
        trajectories: totals.trajectories,
        detailChunks: totals.detailChunks,
        detailBytes: generation.detailBytes,
      },
      translationTotals: {
        locale: "ko",
        transcriptOverlays: totals.detailChunks,
        messageContents: generation.messageContents,
        translatedMessageContents: generation.messageContents - generation.controlOnlyContents,
        controlOnlyContents: generation.controlOnlyContents,
        evaluatorPrompts: generation.evaluatorPrompts,
        contexts: domains.length,
        toolLeaves: {
          classifierVersion: toolClassifierVersion,
          calls: generation.toolCalls,
          all: toolLeafTotals.all,
          translated: toolLeafTotals.translated,
          translatedArguments: toolLeafTotals.translatedArguments,
          translatedResults: toolLeafTotals.translatedResults,
          codeOnly: toolLeafTotals.codeOnly,
        },
      },
      runtimePrompts,
      domains,
    };
    writeFileSync(catalogTemporaryPath, serializedJson(catalog, true));
    rmSync(publicDataRoot, { recursive: true, force: true });
    renameSync(stagingDataRoot, publicDataRoot);
    renameSync(catalogTemporaryPath, catalogPath);
    console.log(JSON.stringify({
      catalog: catalogPath,
      datasetId,
      domains: domains.length,
      runs: totals.runs,
      tasks: totals.tasks,
      trajectories: totals.trajectories,
      chunks: totals.detailChunks,
      evaluatorPrompts: generation.evaluatorPrompts,
      translatedToolLeaves: toolLeafTotals.translated.occurrences,
      uniqueTranslatedToolLeaves: toolLeafTotals.translated.unique,
      dataAssets: generation.writtenAssets,
      detailMiB: Number((generation.detailBytes / 1024 / 1024).toFixed(1)),
      largestDetailKiB: Number((generation.maxDetailBytes / 1024).toFixed(1)),
    }, null, 2));
  } catch (error) {
    rmSync(stagingDataRoot, { recursive: true, force: true });
    rmSync(catalogTemporaryPath, { force: true });
    throw error;
  }
}

main();
