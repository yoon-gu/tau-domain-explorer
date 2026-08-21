"use client";

import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import snapshotJson from "./data/benchmark-snapshot.json";
import type {
  AssetRef,
  BenchmarkSnapshot,
  DomainData,
  KoreanContextTranslationAsset,
  KoreanTranscriptOverlayAsset,
  KoreanTranscriptTrajectory,
  RunData,
  RunIndexAsset,
  RuntimePromptCatalog,
  TaskAssetEntry,
  TaskLanguage,
  TaskTranslation,
  TasksAsset,
  ToolInvocation,
  Trajectory,
  TrajectoryChunkAsset,
  TrajectoryDetail,
  TrajectorySummary,
  TranscriptMessage,
} from "./data/types";

const snapshot = snapshotJson as BenchmarkSnapshot;
const TARGET_BENCHMARK = "tau2";
const TARGET_MODEL = "GPT-5";
const scopedDomains = snapshot.domains.filter(
  (domain) => domain.benchmark === TARGET_BENCHMARK &&
    domain.runs.some((run) => run.model === TARGET_MODEL),
);
type OutcomeFilter = "all" | "pass" | "fail";
type CatalogView = "tasks" | "trajectories";
type ContextTab = "policy" | "prompt" | "task" | "evaluation" | "raw";
type PromptComponent = "agent" | "user" | "evaluator";
type PromptMode = "resolved" | "template";
type EvaluatorPromptMode = "system" | "user";
type LoadStatus = "idle" | "loading" | "ready" | "error";

interface LoadState<T> {
  key: string;
  status: LoadStatus;
  data: T;
  error: string | null;
}

interface IndexData {
  trajectories: TrajectorySummary[];
  transcriptOverlays: Record<string, AssetRef>;
}

interface TaskRunGroup {
  runId: string;
  trajectories: TrajectorySummary[];
  passCount: number;
  failCount: number;
}

interface TaskSummaryGroup {
  key: string;
  taskId: string;
  title: string;
  scenarioPreview: string;
  contentLanguage: TaskLanguage;
  trajectories: TrajectorySummary[];
  runs: TaskRunGroup[];
  passCount: number;
  failCount: number;
}

type EvaluationItemKind = "database" | "environment" | "action" | "communication" | "nl";

interface EvaluationDisplayItem {
  id: string;
  kind: EvaluationItemKind;
  label: string;
  detail: string | null;
  met: boolean | null;
  score: number | null;
  affectsScore: boolean;
  anchorMessageIndex: number | null;
}

const PAGE_SIZE = 100;
const TASK_PAGE_SIZE = 40;
const DETAIL_CACHE_LIMIT = 24;
const DISPLAY_LANGUAGE_STORAGE_KEY = "tau-explorer-display-language";
const LEGACY_TASK_LANGUAGE_STORAGE_KEY = "tau-explorer-task-language";
const PANEL_LAYOUT_STORAGE_KEY = "tau-explorer-panel-layout-v1";
const CATALOG_PANEL_DEFAULT = 304;
const CATALOG_PANEL_MIN = 244;
const CATALOG_PANEL_MAX = 440;
const CONTEXT_PANEL_DEFAULT = 410;
const CONTEXT_PANEL_MIN = 340;
const CONTEXT_PANEL_MAX = 600;
const MIN_WORKSPACE_WIDTH = 560;
const runIndexCache = new Map<string, Promise<RunIndexAsset>>();
const tasksCache = new Map<string, Promise<TasksAsset>>();
const loadedTasksCache = new Map<string, TasksAsset>();
const detailChunkCache = new Map<string, Promise<TrajectoryChunkAsset>>();
const transcriptOverlayCache = new Map<string, Promise<KoreanTranscriptOverlayAsset>>();
const contextTranslationCache = new Map<string, Promise<KoreanContextTranslationAsset>>();
const detailCache = new Map<string, Trajectory>();

function clampPanelWidth(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA adjustable separators are keyboard interactive. */
function PanelResizer({
  side,
  value,
  minimum,
  maximum,
  label,
  onChange,
  onReset,
}: {
  side: "catalog" | "context";
  value: number;
  minimum: number;
  maximum: number;
  label: string;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const dragState = useRef<{ pointerId: number; clientX: number; value: number } | null>(null);

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragState.current) return;
    dragState.current = null;
    document.body.classList.remove("panel-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragState.current = { pointerId: event.pointerId, clientX: event.clientX, value };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("panel-resizing");
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const direction = side === "catalog" ? 1 : -1;
    onChange(clampPanelWidth(drag.value + ((event.clientX - drag.clientX) * direction), minimum, maximum));
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const direction = side === "catalog" ? 1 : -1;
    const increment = event.shiftKey ? 48 : 16;
    let nextValue: number | null = null;
    if (event.key === "ArrowLeft") nextValue = value - (increment * direction);
    if (event.key === "ArrowRight") nextValue = value + (increment * direction);
    if (event.key === "Home") nextValue = minimum;
    if (event.key === "End") nextValue = maximum;
    if (nextValue === null) return;
    event.preventDefault();
    onChange(clampPanelWidth(nextValue, minimum, maximum));
  }

  return (
    <div
      className={`panel-resizer ${side}-panel-resizer`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={side === "catalog" ? "catalog-sidebar" : "context-sidebar"}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      tabIndex={0}
      title={`${label} · double-click to reset`}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
    />
  );
}
/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Could not load data (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function loadRunIndex(run: RunData) {
  const cached = runIndexCache.get(run.id);
  if (cached) return cached;

  const request = readJson<RunIndexAsset>(run.indexPath)
    .then((asset) => {
      if (asset.runId !== run.id || !Array.isArray(asset.trajectories)) {
        throw new Error(`The index for ${run.label} is invalid.`);
      }
      return asset;
    })
    .catch((error) => {
      runIndexCache.delete(run.id);
      throw error;
    });
  runIndexCache.set(run.id, request);
  return request;
}

function taskGroupKey(summary: TrajectorySummary, runsById: Map<string, RunData>) {
  const taskSet = runsById.get(summary.runId)?.tasksPath ?? summary.runId;
  return JSON.stringify([summary.domainId, taskSet, summary.taskId]);
}

function groupTaskSummaries(
  summaries: TrajectorySummary[],
  runsById: Map<string, RunData>,
  taskLanguage: TaskLanguage,
  taskAssets: Map<string, TasksAsset>,
): TaskSummaryGroup[] {
  const tasks = new Map<string, {
    key: string;
    taskId: string;
    title: string;
    scenarioPreview: string;
    contentLanguage: TaskLanguage;
    trajectories: TrajectorySummary[];
    runs: Map<string, TrajectorySummary[]>;
  }>();

  for (const summary of summaries) {
    const key = taskGroupKey(summary, runsById);
    const display = taskDisplayForSummary(
      summary,
      taskLanguage,
      runsById,
      taskAssets,
    );
    let task = tasks.get(key);
    if (!task) {
      task = {
        key,
        taskId: summary.taskId,
        title: display.title,
        scenarioPreview: display.scenarioPreview,
        contentLanguage: display.translation ? "ko" : "en",
        trajectories: [],
        runs: new Map(),
      };
      tasks.set(key, task);
    }
    task.trajectories.push(summary);
    const runTrajectories = task.runs.get(summary.runId) ?? [];
    runTrajectories.push(summary);
    task.runs.set(summary.runId, runTrajectories);
  }

  return [...tasks.values()].map((task) => {
    const runs = [...task.runs.entries()].map(([runId, trajectories]) => {
      const sorted = [...trajectories].sort((left, right) => left.trial - right.trial);
      const passCount = sorted.filter((item) => item.reward === 1).length;
      return {
        runId,
        trajectories: sorted,
        passCount,
        failCount: sorted.length - passCount,
      };
    });
    const trajectories = runs.flatMap((run) => run.trajectories);
    const passCount = trajectories.filter((item) => item.reward === 1).length;
    return {
      key: task.key,
      taskId: task.taskId,
      title: task.title,
      scenarioPreview: task.scenarioPreview,
      contentLanguage: task.contentLanguage,
      trajectories,
      runs,
      passCount,
      failCount: trajectories.length - passCount,
    };
  });
}

function loadTasks(path: string) {
  const cached = tasksCache.get(path);
  if (cached) return cached;
  const request = readJson<TasksAsset>(path)
    .then((asset) => {
      loadedTasksCache.set(path, asset);
      return asset;
    })
    .catch((error) => {
      tasksCache.delete(path);
      loadedTasksCache.delete(path);
      throw error;
    });
  tasksCache.set(path, request);
  return request;
}

function nonEmptyText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function localizedTaskScenario(
  scenario: Record<string, unknown>,
  translation?: TaskTranslation,
) {
  if (!translation) return scenario;
  return Object.fromEntries(
    Object.entries(scenario).map(([key, value]) => [
      key,
      nonEmptyText(translation.scenario[key]) ?? value,
    ]),
  );
}

function compactScenarioPreview(scenario: Record<string, unknown>) {
  return Object.values(scenario)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => typeof value === "string" ? value : JSON.stringify(value))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function taskEntryForSummary(
  summary: TrajectorySummary,
  runsById: Map<string, RunData>,
  taskAssets: Map<string, TasksAsset>,
) {
  const tasksPath = runsById.get(summary.runId)?.tasksPath;
  return tasksPath ? taskAssets.get(tasksPath)?.tasks[summary.taskId] : undefined;
}

function taskDisplayForSummary(
  summary: TrajectorySummary,
  taskLanguage: TaskLanguage,
  runsById: Map<string, RunData>,
  taskAssets: Map<string, TasksAsset>,
) {
  const taskEntry = taskEntryForSummary(summary, runsById, taskAssets);
  const translation = taskLanguage === "ko" ? taskEntry?.translations?.ko : undefined;
  const scenario = taskEntry
    ? localizedTaskScenario(taskEntry.scenario, translation)
    : undefined;
  return {
    title: nonEmptyText(translation?.title) ?? summary.title,
    scenarioPreview: scenario
      ? compactScenarioPreview(scenario) || summary.scenarioPreview
      : summary.scenarioPreview,
    translation,
  };
}

function loadDetailChunk(path: string) {
  const cached = detailChunkCache.get(path);
  if (cached) return cached;
  const request = readJson<TrajectoryChunkAsset>(path)
    .then((asset) => {
      if (!asset.trajectories || typeof asset.trajectories !== "object") {
        throw new Error("The selected trajectory chunk is invalid.");
      }
      return asset;
    })
    .catch((error) => {
      detailChunkCache.delete(path);
      throw error;
    });
  detailChunkCache.set(path, request);
  return request;
}

function loadTranscriptOverlay(path: string) {
  const cached = transcriptOverlayCache.get(path);
  if (cached) return cached;
  const request = readJson<KoreanTranscriptOverlayAsset>(path)
    .then((asset) => {
      if (
        asset.schemaVersion !== 1 ||
        asset.datasetId !== snapshot.datasetId ||
        asset.locale !== "ko" ||
        asset.model !== TARGET_MODEL ||
        !asset.trajectories ||
        typeof asset.trajectories !== "object"
      ) {
        throw new Error("The Korean conversation overlay is invalid.");
      }
      return asset;
    })
    .catch((error) => {
      transcriptOverlayCache.delete(path);
      throw error;
    });
  transcriptOverlayCache.set(path, request);
  return request;
}

function loadContextTranslation(path: string, domainId: string) {
  const cached = contextTranslationCache.get(path);
  if (cached) return cached;
  const request = readJson<KoreanContextTranslationAsset>(path)
    .then((asset) => {
      if (
        asset.schemaVersion !== 1 ||
        asset.datasetId !== snapshot.datasetId ||
        asset.locale !== "ko" ||
        asset.model !== TARGET_MODEL ||
        asset.domainId !== domainId
      ) {
        throw new Error("The Korean domain context overlay is invalid.");
      }
      return asset;
    })
    .catch((error) => {
      contextTranslationCache.delete(path);
      throw error;
    });
  contextTranslationCache.set(path, request);
  return request;
}

function contextTranslationRef(domain: DomainData) {
  return domain.contextTranslationPath ? { path: domain.contextTranslationPath } : undefined;
}

function isControlToken(content: string | null) {
  return Boolean(content?.trim().match(/^###[A-Z0-9_-]+###$/));
}

function translatedMessageContent(trajectoryOverlay: KoreanTranscriptTrajectory, messageIndex: number) {
  return nonEmptyText(trajectoryOverlay.messages[String(messageIndex)]);
}

interface DisplayToolInvocation {
  invocation: ToolInvocation;
  argumentsLanguage: TaskLanguage;
  resultLanguage: TaskLanguage;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
    );
  }
  return value;
}

function decodeJsonPointerSegment(segment: string) {
  if (/~(?![01])/u.test(segment)) return undefined;
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function translatedToolValue(
  canonical: unknown,
  pointer: string,
  leaves: Record<string, string>,
) {
  const exact = nonEmptyText(leaves[pointer]);
  if (exact && (canonical === null || typeof canonical !== "object")) {
    return { value: exact, translated: true };
  }

  const prefix = `${pointer}/`;
  const entries = Object.entries(leaves).filter(([path]) => path.startsWith(prefix));
  if (!entries.length || canonical === null || typeof canonical !== "object") {
    return { value: canonical, translated: false };
  }

  const value = cloneJsonValue(canonical);
  let translated = false;
  for (const [path, translation] of entries) {
    const segments = path.slice(prefix.length).split("/").map(decodeJsonPointerSegment);
    if (!segments.length || segments.some((segment) => segment === undefined)) continue;
    let cursor: unknown = value;
    let valid = true;
    for (const segment of segments.slice(0, -1)) {
      if (segment === undefined) {
        valid = false;
        break;
      }
      if (Array.isArray(cursor)) {
        if (!/^\d+$/u.test(segment)) {
          valid = false;
          break;
        }
        const index = Number(segment);
        if (index >= cursor.length) {
          valid = false;
          break;
        }
        cursor = cursor[index];
      } else if (cursor && typeof cursor === "object" &&
        Object.prototype.hasOwnProperty.call(cursor, segment)) {
        cursor = (cursor as Record<string, unknown>)[segment];
      } else {
        valid = false;
        break;
      }
    }
    const leaf = segments.at(-1);
    if (!valid || leaf === undefined) continue;
    if (Array.isArray(cursor)) {
      if (!/^\d+$/u.test(leaf)) continue;
      const index = Number(leaf);
      if (index >= cursor.length || (cursor[index] !== null && typeof cursor[index] === "object")) {
        continue;
      }
      cursor[index] = translation;
      translated = true;
    } else if (cursor && typeof cursor === "object" &&
      Object.prototype.hasOwnProperty.call(cursor, leaf)) {
      const record = cursor as Record<string, unknown>;
      if (record[leaf] !== null && typeof record[leaf] === "object") continue;
      record[leaf] = translation;
      translated = true;
    }
  }
  return { value, translated };
}

function displayToolInvocations(
  message: TranscriptMessage,
  messageIndex: number,
  translation: KoreanTranscriptTrajectory | null,
): DisplayToolInvocation[] {
  const leaves = translation?.toolLeaves ?? {};
  return message.toolCalls.map((invocation, toolIndex) => {
    const base = `/messages/${messageIndex}/toolCalls/${toolIndex}`;
    const translatedArguments = translatedToolValue(
      invocation.arguments,
      `${base}/arguments`,
      leaves,
    );
    const translatedResult = translatedToolValue(invocation.result, `${base}/result`, leaves);
    return {
      invocation: {
        ...invocation,
        arguments: translatedArguments.value,
        result: translatedResult.value,
      },
      argumentsLanguage: translatedArguments.translated ? "ko" : "en",
      resultLanguage: translatedResult.translated ? "ko" : "en",
    };
  });
}

function rememberDetail(id: string, trajectory: Trajectory) {
  detailCache.delete(id);
  detailCache.set(id, trajectory);
  if (detailCache.size > DETAIL_CACHE_LIMIT) {
    const oldest = detailCache.keys().next().value;
    if (oldest) detailCache.delete(oldest);
  }
}

function hydrateTrajectory(
  domain: DomainData,
  run: RunData,
  summary: TrajectorySummary,
  task: TaskAssetEntry,
  detail: TrajectoryDetail,
): Trajectory {
  if (detail.id !== summary.id || detail.runId !== run.id) {
    throw new Error("The selected trajectory detail does not match its index entry.");
  }
  if (!Array.isArray(detail.messages)) {
    throw new Error("The selected trajectory has no valid message transcript.");
  }
  const policy = domain.policySnapshots.find(
    (snapshot) => snapshot.id === run.policySnapshotId,
  );
  return {
    ...detail,
    model: run.model,
    userModel: run.userModel,
    policyUsed: policy?.content ?? null,
    scenario: task.scenario,
    task: task.task,
    sourceUrl: run.sourceUrl,
  };
}

function loadTrajectoryDetail(
  domain: DomainData,
  run: RunData,
  summary: TrajectorySummary,
) {
  const loaded = detailCache.get(summary.id);
  if (loaded) {
    detailCache.delete(summary.id);
    detailCache.set(summary.id, loaded);
    return Promise.resolve(loaded);
  }

  return Promise.all([
    loadDetailChunk(summary.detailPath),
    loadTasks(run.tasksPath),
  ])
    .then(([chunk, tasks]) => {
      const detail = chunk.trajectories[summary.id];
      if (!detail) {
        throw new Error("The selected trajectory is missing from its detail chunk.");
      }
      const task = tasks.tasks[summary.taskId];
      if (!task) throw new Error("Task metadata is missing for this trajectory.");
      const trajectory = hydrateTrajectory(domain, run, summary, task, detail);
      rememberDetail(summary.id, trajectory);
      return trajectory;
    });
}

const contextTabs: Array<{ id: ContextTab; label: string }> = [
  { id: "policy", label: "Policy" },
  { id: "prompt", label: "Prompts" },
  { id: "task", label: "Task" },
  { id: "evaluation", label: "Evaluation" },
  { id: "raw", label: "Raw" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordArray(value: unknown) {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function evaluationBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function evaluationNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildEvaluationItems(trajectory: Trajectory): EvaluationDisplayItem[] {
  const evaluation = asRecord(trajectory.evaluation);
  const rewardBasis = new Set(
    Array.isArray(evaluation.reward_basis) ? evaluation.reward_basis.map(String) : [],
  );
  const items: EvaluationDisplayItem[] = [];
  const dbCheck = asRecord(evaluation.db_check);

  if (rewardBasis.has("DB") && Object.keys(dbCheck).length) {
    items.push({
      id: "database",
      kind: "database",
      label: "Database state matches the expected final state",
      detail: null,
      met: evaluationBoolean(dbCheck.db_match),
      score: evaluationNumber(dbCheck.db_reward),
      affectsScore: rewardBasis.has("DB"),
      anchorMessageIndex: null,
    });
  }

  (rewardBasis.has("ENV_ASSERTION") ? asRecordArray(evaluation.env_assertions) : []).forEach((check, index) => {
    const assertion = asRecord(check.env_assertion);
    const name = typeof assertion.func_name === "string"
      ? assertion.func_name
      : `Environment assertion ${index + 1}`;
    const args = Object.keys(asRecord(assertion.arguments)).length
      ? JSON.stringify(assertion.arguments)
      : null;
    items.push({
      id: `environment-${index}`,
      kind: "environment",
      label: name,
      detail: args,
      met: evaluationBoolean(check.met),
      score: evaluationNumber(check.reward),
      affectsScore: rewardBasis.has("ENV_ASSERTION"),
      anchorMessageIndex: null,
    });
  });

  const usedToolCalls = new Set<string>();
  if (rewardBasis.has("ACTION")) {
    asRecordArray(evaluation.action_checks).forEach((check, index) => {
      const action = asRecord(check.action);
      const name = typeof action.name === "string" ? action.name : `Action ${index + 1}`;
      const requestor = typeof action.requestor === "string" ? action.requestor : null;
      const met = evaluationBoolean(check.action_match);
      let anchorMessageIndex: number | null = null;

      if (met) {
        for (let messageIndex = 0; messageIndex < trajectory.messages.length; messageIndex += 1) {
          const message = trajectory.messages[messageIndex];
          const callIndex = message.toolCalls.findIndex((call, toolIndex) => {
            const key = `${messageIndex}:${toolIndex}`;
            return !usedToolCalls.has(key) && call.name === name &&
              (!requestor || call.requestor === requestor);
          });
          if (callIndex >= 0) {
            usedToolCalls.add(`${messageIndex}:${callIndex}`);
            anchorMessageIndex = messageIndex;
            break;
          }
        }
      }

      items.push({
        id: `action-${index}`,
        kind: "action",
        label: name,
        detail: Object.keys(asRecord(action.arguments)).length
          ? JSON.stringify(action.arguments)
          : null,
        met,
        score: evaluationNumber(check.action_reward),
        affectsScore: true,
        anchorMessageIndex,
      });
    });
  }

  if (rewardBasis.has("COMMUNICATE")) {
    asRecordArray(evaluation.communicate_checks).forEach((check, index) => {
      const info = typeof check.info === "string" ? check.info : `Communication ${index + 1}`;
      const justification = typeof check.justification === "string" ? check.justification : null;
      let anchorMessageIndex: number | null = null;
      if (evaluationBoolean(check.met) && justification) {
        anchorMessageIndex = trajectory.messages.findIndex((message) =>
          message.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.length >= 20 &&
          justification.includes(`message:\n '${message.content}'`));
        if (anchorMessageIndex < 0) anchorMessageIndex = null;
      }
      items.push({
        id: `communication-${index}`,
        kind: "communication",
        label: `Communicate: ${info}`,
        detail: justification,
        met: evaluationBoolean(check.met),
        score: evaluationBoolean(check.met) === null ? null : evaluationBoolean(check.met) ? 1 : 0,
        affectsScore: true,
        anchorMessageIndex,
      });
    });
  }

  asRecordArray(evaluation.nl_assertions).forEach((check, index) => {
    items.push({
      id: `nl-${index}`,
      kind: "nl",
      label: typeof check.nl_assertion === "string"
        ? check.nl_assertion
        : `Natural-language assertion ${index + 1}`,
      detail: typeof check.justification === "string" ? check.justification : null,
      met: evaluationBoolean(check.met),
      score: null,
      affectsScore: false,
      anchorMessageIndex: null,
    });
  });

  return items;
}

function stringify(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value, null, 2);
}

function compactTaskId(taskId: string) {
  if (taskId.length <= 26) return taskId;
  return `${taskId.slice(0, 23)}…`;
}

function formatDuration(duration: number | null) {
  if (duration === null) return null;
  if (duration < 60) return `${duration.toFixed(1)}s`;
  return `${Math.floor(duration / 60)}m ${Math.round(duration % 60)}s`;
}

function formatCost(cost: number | null) {
  if (cost === null) return "—";
  return `$${cost.toFixed(cost < 0.01 ? 4 : 3)}`;
}

function formatRunMode(mode: RunData["mode"]) {
  return mode
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatRunLabel(run: RunData) {
  const mode = formatRunMode(run.mode);
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  return normalize(run.label).includes(normalize(mode)) ? run.label : `${run.label} · ${mode}`;
}

function documentContent(value: unknown) {
  return nonEmptyText(value) ?? nonEmptyText(asRecord(value).content);
}

function documentSourceUrl(value: unknown) {
  return nonEmptyText(asRecord(value).sourceUrl) ?? nonEmptyText(asRecord(value).url);
}

function runtimePromptCatalog() {
  const prompts = (snapshot as BenchmarkSnapshot & { runtimePrompts?: RuntimePromptCatalog })
    .runtimePrompts;
  return prompts ?? {
    agent: {
      model: TARGET_MODEL,
      instruction: { sourceHash: "", content: AGENT_INSTRUCTION_FALLBACK, sourceUrl: "" },
      systemTemplate: { sourceHash: "", content: AGENT_SYSTEM_TEMPLATE_FALLBACK, sourceUrl: "" },
    },
    evaluator: {
      model: "gpt-4o-mini",
      temperature: 0,
      invocationCount: 0,
      system: { sourceHash: "", content: EVALUATOR_SYSTEM_FALLBACK, sourceUrl: "" },
      userTemplate: { sourceHash: "", content: "", sourceUrl: "" },
    },
  };
}

function runtimeScenario(task: TaskAssetEntry | undefined, translation?: TaskTranslation) {
  return nonEmptyText(translation?.runtimeScenario) ?? nonEmptyText(task?.runtimeScenario);
}

function fillAgentSystemPrompt(template: string, instruction: string, policy: string) {
  return template
    .replaceAll("{agent_instruction}", instruction)
    .replaceAll("{domain_policy}", policy);
}

function fillUserSystemPrompt(template: string, scenario: string) {
  return template.replaceAll("{{ user_scenario }}", scenario);
}

function CopyButton({
  text,
  label,
  language = "en",
}: {
  text: string;
  label?: string;
  language?: TaskLanguage;
}) {
  const [copied, setCopied] = useState(false);
  const buttonLabel = label ?? (language === "ko" ? "복사" : "Copy");

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button type="button" className="quiet-button" onClick={copy} lang={language}>
      {copied ? (language === "ko" ? "복사됨" : "Copied") : buttonLabel}
    </button>
  );
}

function TaskLanguageSwitch({
  value,
  onChange,
  className = "",
}: {
  value: TaskLanguage;
  onChange: (language: TaskLanguage) => void;
  className?: string;
}) {
  return (
    <div
      className={`task-language-switch${className ? ` ${className}` : ""}`}
      role="group"
      aria-label="Content display language"
    >
      {(["en", "ko"] as TaskLanguage[]).map((language) => (
        <button
          type="button"
          className={value === language ? "active" : ""}
          onClick={() => onChange(language)}
          aria-pressed={value === language}
          aria-label={language === "en"
            ? "Show tasks, conversations, policies, and prompts in English"
            : "태스크, 대화, 정책, 프롬프트를 한국어로 보기"}
          lang={language}
          key={language}
        >
          {language === "en" ? "EN" : "한국어"}
        </button>
      ))}
    </div>
  );
}

function JsonBlock({
  label,
  value,
  language = "en",
  uiLanguage = "en",
}: {
  label: string;
  value: unknown;
  language?: TaskLanguage;
  uiLanguage?: TaskLanguage;
}) {
  const text = stringify(value);
  return (
    <section className="json-block" lang={language}>
      <div className="json-heading">
        <span lang={uiLanguage}>{label}</span>
        <CopyButton text={text} language={uiLanguage} />
      </div>
      <pre>{text}</pre>
    </section>
  );
}

function ToolInvocationCard({
  invocation,
  argumentsLanguage,
  resultLanguage,
  displayLanguage,
}: {
  invocation: ToolInvocation;
  argumentsLanguage: TaskLanguage;
  resultLanguage: TaskLanguage;
  displayLanguage: TaskLanguage;
}) {
  const isUserTool = invocation.requestor === "user";
  const korean = displayLanguage === "ko";
  return (
    <details
      className={`tool-call ${isUserTool ? "user-tool" : "agent-tool"}${
        invocation.error ? " tool-error" : ""
      }`}
      lang={displayLanguage}
    >
      <summary>
        <span className="tool-owner" aria-hidden="true">
          {korean ? (isUserTool ? "사" : "상") : isUserTool ? "U" : "A"}
        </span>
        <span className="tool-summary-copy">
          <span className="tool-kind">
            {korean ? (isUserTool ? "사용자 도구" : "상담원 도구") : isUserTool ? "User tool" : "Agent tool"}
          </span>
          <strong lang="en">{invocation.name}</strong>
        </span>
        <span className={`tool-state${invocation.error ? " error" : ""}`}>
          {invocation.error
            ? (korean ? "오류" : "Error")
            : invocation.result === null
              ? (korean ? "결과 없음" : "No result")
              : (korean ? "성공" : "Success")}
        </span>
        <span className="disclosure" aria-hidden="true">⌄</span>
      </summary>
      <div className="tool-detail-grid">
        <JsonBlock
          label={korean ? "인자" : "Arguments"}
          value={invocation.arguments}
          language={argumentsLanguage}
          uiLanguage={displayLanguage}
        />
        <JsonBlock
          label={korean ? "결과" : "Result"}
          value={invocation.result}
          language={resultLanguage}
          uiLanguage={displayLanguage}
        />
      </div>
    </details>
  );
}

function ToolInvocationGroup({
  invocations,
  displayLanguage,
}: {
  invocations: DisplayToolInvocation[];
  displayLanguage: TaskLanguage;
}) {
  const korean = displayLanguage === "ko";
  const isUserTool = invocations[0]?.invocation.requestor === "user";
  const errorCount = invocations.filter((item) => Boolean(item.invocation.error)).length;
  const nameCounts = new Map<string, number>();
  for (const item of invocations) {
    nameCounts.set(item.invocation.name, (nameCounts.get(item.invocation.name) ?? 0) + 1);
  }
  const names = [...nameCounts.entries()]
    .map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ""}`)
    .join(" · ");

  return (
    <details
      className={`tool-call-group ${isUserTool ? "user-tool" : "agent-tool"}${errorCount ? " tool-error" : ""}`}
      lang={displayLanguage}
    >
      <summary>
        <span className="tool-owner" aria-hidden="true">
          {korean ? (isUserTool ? "사" : "상") : isUserTool ? "U" : "A"}
        </span>
        <span className="tool-summary-copy">
          <strong>{korean ? `도구 호출 ${invocations.length}개` : `${invocations.length} tool calls`}</strong>
          <span className="tool-group-names" lang="en" title={names}>{names}</span>
        </span>
        <span className={`tool-state${errorCount ? " error" : ""}`}>
          {errorCount
            ? (korean ? `오류 ${errorCount}` : `${errorCount} errors`)
            : (korean ? "모두 성공" : "All succeeded")}
        </span>
        <span className="disclosure" aria-hidden="true">⌄</span>
      </summary>
      <div className="tool-call-group-body">
        {invocations.map((display, index) => (
          <ToolInvocationCard
            key={`${display.invocation.id}-${index}`}
            invocation={display.invocation}
            argumentsLanguage={display.argumentsLanguage}
            resultLanguage={display.resultLanguage}
            displayLanguage={displayLanguage}
          />
        ))}
      </div>
    </details>
  );
}

function TranscriptItem({
  message,
  metadataVisible,
  displayContent,
  displayToolCalls,
  contentLanguage,
  displayLanguage,
  translationFallback,
}: {
  message: TranscriptMessage;
  metadataVisible: boolean;
  displayContent: string | null;
  displayToolCalls: DisplayToolInvocation[];
  contentLanguage: TaskLanguage;
  displayLanguage: TaskLanguage;
  translationFallback: boolean;
}) {
  const isUser = message.role === "user";
  const korean = displayLanguage === "ko";
  const timestamp = message.timestamp
    ? new Date(message.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <li className={`message ${isUser ? "user-message" : "assistant-message"}`}>
      <div className="message-meta">
        <span className={`avatar ${isUser ? "user-avatar" : "assistant-avatar"}`}>
          {korean ? (isUser ? "사" : "상") : isUser ? "U" : "A"}
        </span>
        <strong lang={displayLanguage}>
          {korean ? (isUser ? "사용자" : "상담원") : isUser ? "User" : "Assistant"}
        </strong>
        <span className="turn-label" lang={displayLanguage}>
          {korean ? `턴 ${message.turnIndex}` : `Turn ${message.turnIndex}`}
        </span>
        {translationFallback ? (
          <span className="message-language-badge" lang={displayLanguage}>
            {korean ? "영어 원문" : "EN original"}
          </span>
        ) : null}
        {metadataVisible && timestamp ? <time>{timestamp}</time> : null}
      </div>
      {displayContent ? (
        <p
          className={isControlToken(displayContent) ? "control-token" : undefined}
          lang={contentLanguage}
        >
          {displayContent}
        </p>
      ) : null}
      {displayToolCalls.length > 1 ? (
        <ToolInvocationGroup invocations={displayToolCalls} displayLanguage={displayLanguage} />
      ) : displayToolCalls[0] ? (
        <ToolInvocationCard
          invocation={displayToolCalls[0].invocation}
          argumentsLanguage={displayToolCalls[0].argumentsLanguage}
          resultLanguage={displayToolCalls[0].resultLanguage}
          displayLanguage={displayLanguage}
        />
      ) : null}
    </li>
  );
}

function TranscriptLanguageNotice({
  status,
  error,
  hasTranslation,
  fallbackCount,
  retry,
}: {
  status: LoadStatus;
  error: string | null;
  hasTranslation: boolean;
  fallbackCount: number;
  retry: () => void;
}) {
  const unavailable = status === "error" || (status === "ready" && !hasTranslation);
  return (
    <li className="transcript-language-note" role="status" aria-live="polite" lang="ko">
      <span>
        {status === "loading"
          ? "한국어 대화를 불러오는 동안 영어 원문을 표시합니다."
          : unavailable
            ? "한국어 대화를 불러오지 못해 영어 원문을 표시합니다."
            : fallbackCount
              ? `표시용 한국어 번역입니다. 번역이 없는 ${fallbackCount}개 메시지는 영어 원문입니다.`
              : "표시용 한국어 번역입니다. 실제 대화와 도구 데이터는 영어로 기록되었습니다."}
      </span>
      {unavailable ? (
        <button type="button" className="quiet-button" onClick={retry} aria-label="한국어 대화 다시 불러오기">
          다시 시도
        </button>
      ) : null}
      {error ? <small lang="en">{error}</small> : null}
    </li>
  );
}

function evaluationKindLabel(kind: EvaluationItemKind, language: TaskLanguage) {
  const korean = language === "ko";
  const labels: Record<EvaluationItemKind, string> = {
    database: korean ? "DB 상태" : "Database",
    environment: korean ? "환경 검증" : "Environment",
    action: korean ? "도구 행동" : "Action",
    communication: korean ? "정보 전달" : "Communication",
    nl: korean ? "자연어 검토" : "NL review",
  };
  return labels[kind];
}

function EvaluationItemRow({
  item,
  displayLanguage,
}: {
  item: EvaluationDisplayItem;
  displayLanguage: TaskLanguage;
}) {
  const korean = displayLanguage === "ko";
  const status = item.met === null
    ? "—"
    : item.met
      ? "✓"
      : "×";
  return (
    <details className={`evaluation-item ${item.met === false ? "fail" : "pass"}`}>
      <summary>
        <span className="evaluation-status" aria-hidden="true">{status}</span>
        <span className="evaluation-item-copy">
          <small lang={displayLanguage}>{evaluationKindLabel(item.kind, displayLanguage)}</small>
          <strong lang="en">{item.label}</strong>
        </span>
        {item.score !== null ? (
          <span className="evaluation-item-score" aria-label={`${korean ? "점수" : "Score"} ${item.score}`}>
            {item.score.toFixed(1)}
          </span>
        ) : null}
        <span className="disclosure" aria-hidden="true">⌄</span>
      </summary>
      {item.detail ? <p lang="en">{item.detail}</p> : (
        <p lang={displayLanguage}>{korean ? "추가 설명이 기록되지 않았습니다." : "No additional detail was recorded."}</p>
      )}
    </details>
  );
}

function EvaluationOverview({
  trajectory,
  items,
  displayLanguage,
}: {
  trajectory: Trajectory;
  items: EvaluationDisplayItem[];
  displayLanguage: TaskLanguage;
}) {
  const korean = displayLanguage === "ko";
  const evaluation = asRecord(trajectory.evaluation);
  const breakdown = asRecord(evaluation.reward_breakdown);
  const scoredCount = items.filter((item) => item.affectsScore).length;
  return (
    <li className="evaluation-overview" lang={displayLanguage}>
      <div className="evaluation-overview-heading">
        <div>
          <span className="evaluation-kicker">{korean ? "평가 모드" : "Evaluation mode"}</span>
          <h2>{korean ? "이 대화의 실행 후 평가" : "Post-run evaluation"}</h2>
        </div>
        <strong>{trajectory.reward.toFixed(1)} / 1.0</strong>
      </div>
      <p>
        {korean
          ? "아래 표시는 대화가 끝난 뒤 계산된 평가를 읽기 편하게 배치한 것입니다. 실제 실행 중 상담원에게는 보이지 않았습니다."
          : "These results were calculated after the conversation and placed here for review. The agent did not see them while running."}
      </p>
      <div className="evaluation-breakdown" aria-label={korean ? "점수 구성" : "Score breakdown"}>
        {Object.entries(breakdown).map(([basis, value]) => (
          <span key={basis}><b>{basis}</b>{String(value)}</span>
        ))}
        <span><b>{korean ? "점수 항목" : "Scored items"}</b>{scoredCount}</span>
      </div>
    </li>
  );
}

function EvaluationEvidence({
  items,
  displayLanguage,
}: {
  items: EvaluationDisplayItem[];
  displayLanguage: TaskLanguage;
}) {
  const korean = displayLanguage === "ko";
  return (
    <li className="evaluation-evidence" lang={displayLanguage}>
      <div className="evaluation-evidence-heading">
        <span aria-hidden="true">↳</span>
        <strong>{korean ? "이 턴과 연결된 평가 근거" : "Evaluation evidence linked to this turn"}</strong>
      </div>
      {items.map((item) => (
        <EvaluationItemRow item={item} displayLanguage={displayLanguage} key={item.id} />
      ))}
    </li>
  );
}

function EvaluationSummary({
  items,
  displayLanguage,
}: {
  items: EvaluationDisplayItem[];
  displayLanguage: TaskLanguage;
}) {
  const korean = displayLanguage === "ko";
  const scoreItems = items.filter((item) => item.affectsScore && item.anchorMessageIndex === null);
  const supplementalItems = items.filter((item) => item.kind === "nl");
  if (!scoreItems.length && !supplementalItems.length) return null;
  return (
    <li className="evaluation-summary" lang={displayLanguage}>
      <div className="evaluation-summary-heading">
        <span className="evaluation-kicker">{korean ? "대화 전체" : "Whole conversation"}</span>
        <h2>{korean ? "특정 턴에 연결되지 않은 평가" : "Evaluation without a turn-level anchor"}</h2>
        <p>
          {korean
            ? "DB·환경·미충족 정보 전달 항목은 특정 메시지의 근거로 저장되지 않아 대화 전체 결과로 표시합니다."
            : "Database, environment, and unmet communication checks are stored as whole-conversation results rather than evidence for a specific message."}
        </p>
      </div>
      {scoreItems.map((item) => (
        <EvaluationItemRow item={item} displayLanguage={displayLanguage} key={item.id} />
      ))}
      {supplementalItems.length ? (
        <div className="evaluation-supplemental">
          <h3>{korean ? "보조 자연어 검토 · 최종 점수 미반영" : "Supplemental NL review · not included in the final score"}</h3>
          {supplementalItems.map((item) => (
            <EvaluationItemRow item={item} displayLanguage={displayLanguage} key={item.id} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function inlineMarkdown(text: string): ReactNode[] {
  return text
    .split(/(\*\*.*?\*\*|`.*?`)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={index}>{part.slice(1, -1)}</code>;
      }
      return <Fragment key={index}>{part}</Fragment>;
    });
}

function MarkdownDocument({ content }: { content: string }) {
  return (
    <div className="markdown-document">
      {content.split("\n").map((rawLine, index) => {
        const line = rawLine.trimEnd();
        if (!line.trim()) return <div className="markdown-space" key={index} />;
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          const children = inlineMarkdown(heading[2]);
          if (level === 1) return <h2 key={index}>{children}</h2>;
          if (level === 2) return <h3 key={index}>{children}</h3>;
          return <h4 key={index}>{children}</h4>;
        }
        if (/^<\/?[a-z_]+>$/.test(line.trim())) {
          return (
            <div className="document-tag" key={index}>
              {line.trim()}
            </div>
          );
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        if (bullet) {
          return (
            <div className="markdown-bullet" key={index}>
              <span aria-hidden="true">•</span>
              <p>{inlineMarkdown(bullet[1])}</p>
            </div>
          );
        }
        const ordered = line.match(/^\s*(\d+)\.\s+(.*)$/);
        if (ordered) {
          return (
            <div className="markdown-bullet" key={index}>
              <span>{ordered[1]}.</span>
              <p>{inlineMarkdown(ordered[2])}</p>
            </div>
          );
        }
        return <p key={index}>{inlineMarkdown(line)}</p>;
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function TaskPanel({
  domain,
  trajectory,
  taskLanguage,
  taskTranslation,
  translationStatus,
  translationError,
  retryTranslation,
}: {
  domain: DomainData;
  trajectory?: Trajectory;
  taskLanguage: TaskLanguage;
  taskTranslation?: TaskTranslation;
  translationStatus: LoadStatus;
  translationError: string | null;
  retryTranslation: () => void;
}) {
  if (!trajectory) return <EmptyContext label="Choose a trajectory to inspect its task." />;
  const description = asRecord(trajectory.task.description);
  const translatedScenario = localizedTaskScenario(
    trajectory.scenario,
    taskLanguage === "ko" ? taskTranslation : undefined,
  );
  const rawPurpose = nonEmptyText(description.purpose);
  const title = taskLanguage === "ko"
    ? nonEmptyText(taskTranslation?.title) ?? trajectory.title
    : trajectory.title;
  const purpose = taskLanguage === "ko"
    ? nonEmptyText(taskTranslation?.descriptionPurpose) ?? rawPurpose
    : rawPurpose;
  const scenarioFields = domain.benchmark === "tau"
    ? ["instruction"]
    : ["persona", "reasonForCall", "knownInfo", "unknownInfo", "taskInstructions"];
  const hasFieldFallback = taskLanguage === "ko" && (
    !nonEmptyText(taskTranslation?.title) ||
    (Boolean(rawPurpose) && !nonEmptyText(taskTranslation?.descriptionPurpose)) ||
    scenarioFields.some((field) =>
      nonEmptyText(trajectory.scenario[field]) &&
      !nonEmptyText(taskTranslation?.scenario[field]))
  );
  const labels = taskLanguage === "ko"
    ? {
        task: "태스크",
        userInstruction: "사용자 지시사항",
        userId: "사용자 ID",
        referenceActions: "참조 액션",
        expectedOutputs: "예상 출력",
        persona: "페르소나",
        reasonForCall: "문의 사유",
        knownInfo: "알려진 정보",
        unknownInfo: "알려지지 않은 정보",
        taskInstructions: "태스크 지시사항",
        completeJson: "전체 태스크 JSON",
      }
    : {
        task: "Task",
        userInstruction: "User instruction",
        userId: "User ID",
        referenceActions: "Reference actions",
        expectedOutputs: "Expected outputs",
        persona: "Persona",
        reasonForCall: "Reason for call",
        knownInfo: "Known information",
        unknownInfo: "Unknown information",
        taskInstructions: "Task instructions",
        completeJson: "Complete task JSON",
      };

  return (
    <div className="context-content structured-content">
      <div className="panel-intro">
        <span className="section-kicker" lang={taskLanguage}>
          {labels.task} · <span lang="en">{compactTaskId(trajectory.taskId)}</span>
        </span>
        <h2 lang={taskLanguage === "ko" && nonEmptyText(taskTranslation?.title) ? "ko" : "en"}>
          {title}
        </h2>
        {purpose ? (
          <p lang={taskLanguage === "ko" && nonEmptyText(taskTranslation?.descriptionPurpose) ? "ko" : "en"}>
            {purpose}
          </p>
        ) : null}
      </div>

      {taskLanguage === "ko" && translationStatus === "loading" ? (
        <div className="context-note translation-note" role="status" aria-live="polite" lang="ko">
          한국어 번역을 불러오는 동안 번역되지 않은 항목은 영어 원문으로 표시됩니다.
        </div>
      ) : taskLanguage === "ko" && (translationError || hasFieldFallback) ? (
        <div className="context-note translation-note" role="status" aria-live="polite" lang="ko">
          <span>한국어 번역이 없는 항목은 정확한 영어 원문으로 표시됩니다.</span>
          {translationError ? (
            <button type="button" className="quiet-button" onClick={retryTranslation}>
              다시 시도
            </button>
          ) : null}
        </div>
      ) : null}

      {domain.benchmark === "tau" ? (
        <>
          <ContextSection title={labels.userInstruction} titleLanguage={taskLanguage}>
            <p
              className="preserve-lines"
              lang={taskLanguage === "ko" && nonEmptyText(taskTranslation?.scenario.instruction) ? "ko" : "en"}
            >
              {String(translatedScenario.instruction ?? "—")}
            </p>
          </ContextSection>
          <dl className="definition-list" lang={taskLanguage}>
            <Stat label={labels.userId} value={String(trajectory.scenario.userId ?? "—")} />
            <Stat
              label={labels.referenceActions}
              value={Array.isArray(trajectory.task.actions) ? trajectory.task.actions.length : 0}
            />
            <Stat
              label={labels.expectedOutputs}
              value={Array.isArray(trajectory.task.outputs) ? trajectory.task.outputs.length : 0}
            />
          </dl>
        </>
      ) : (
        <>
          {[
            { field: "persona", label: labels.persona, value: translatedScenario.persona },
            { field: "reasonForCall", label: labels.reasonForCall, value: translatedScenario.reasonForCall },
            { field: "knownInfo", label: labels.knownInfo, value: translatedScenario.knownInfo },
            { field: "unknownInfo", label: labels.unknownInfo, value: translatedScenario.unknownInfo },
            { field: "taskInstructions", label: labels.taskInstructions, value: translatedScenario.taskInstructions },
          ].map(({ field, label, value }) =>
            value ? (
              <ContextSection title={String(label)} titleLanguage={taskLanguage} key={String(label)}>
                <p
                  className="preserve-lines"
                  lang={taskLanguage === "ko" && nonEmptyText(taskTranslation?.scenario[field]) ? "ko" : "en"}
                >
                  {stringify(value)}
                </p>
              </ContextSection>
            ) : null,
          )}
        </>
      )}

      <details className="raw-disclosure">
        <summary lang={taskLanguage}>{labels.completeJson} <span aria-hidden="true">⌄</span></summary>
        <JsonBlock label="Task" value={trajectory.task} />
      </details>
    </div>
  );
}

function ContextSection({
  title,
  titleLanguage = "en",
  children,
}: {
  title: string;
  titleLanguage?: TaskLanguage;
  children: ReactNode;
}) {
  return (
    <section className="context-section">
      <h3 lang={titleLanguage}>{title}</h3>
      {children}
    </section>
  );
}

function EvaluationPanel({ trajectory }: { trajectory?: Trajectory }) {
  if (!trajectory) return <EmptyContext label="Choose a trajectory to inspect its evaluation." />;
  const evaluation = asRecord(trajectory.evaluation);
  const breakdown = asRecord(evaluation.reward_breakdown);
  const rewardBasis = Array.isArray(evaluation.reward_basis)
    ? evaluation.reward_basis.map(String)
    : [];

  return (
    <div className="context-content structured-content" lang="en">
      <div className="evaluation-hero">
        <span className={`outcome-mark ${trajectory.reward === 1 ? "pass" : "fail"}`}>
          {trajectory.reward === 1 ? "✓" : "×"}
        </span>
        <div>
          <span className="section-kicker">Outcome</span>
          <h2>{trajectory.reward === 1 ? "Passed" : "Failed"}</h2>
        </div>
        <strong className="reward-number">{trajectory.reward.toFixed(1)}</strong>
      </div>

      <dl className="definition-list">
        <Stat label="Termination" value={trajectory.terminationReason.replaceAll("_", " ")} />
        <Stat label="Trial" value={`#${trajectory.trial}`} />
        <Stat label="Agent model" value={trajectory.model} />
        <Stat label="User model" value={trajectory.userModel} />
        <Stat label="Agent cost" value={formatCost(trajectory.agentCost)} />
        <Stat label="User cost" value={formatCost(trajectory.userCost)} />
      </dl>

      {rewardBasis.length ? (
        <ContextSection title="Reward basis">
          <div className="chip-row">
            {rewardBasis.map((basis) => <span className="text-chip" key={basis}>{basis}</span>)}
          </div>
        </ContextSection>
      ) : null}

      {Object.keys(breakdown).length ? (
        <ContextSection title="Breakdown">
          <dl className="definition-list inset-list">
            {Object.entries(breakdown).map(([key, value]) => (
              <Stat label={key} value={String(value)} key={key} />
            ))}
          </dl>
        </ContextSection>
      ) : null}

      <div className="context-note">
        τ² reference actions describe a target environment state unless ACTION is explicitly
        part of the reward basis.
      </div>

      <details className="raw-disclosure">
        <summary>Complete evaluation JSON <span aria-hidden="true">⌄</span></summary>
        <JsonBlock label="Evaluation" value={trajectory.evaluation} />
      </details>
    </div>
  );
}

function EmptyContext({ label }: { label: string }) {
  return <div className="empty-context">{label}</div>;
}

function ContextLoadState({
  status,
  error,
  label,
  retry,
}: {
  status: LoadStatus;
  error: string | null;
  label: string;
  retry: () => void;
}) {
  if (status === "idle") {
    return <EmptyContext label={`Choose a trajectory to inspect ${label}.`} />;
  }
  if (status === "error") {
    return (
      <div className="empty-context context-error" role="alert">
        <span>{error ?? `Could not load ${label}.`}</span>
        <button type="button" className="quiet-button" onClick={retry}>Retry</button>
      </div>
    );
  }
  return <EmptyContext label={`Loading ${label}…`} />;
}

function translatedPolicyContent(
  asset: KoreanContextTranslationAsset | null,
  policyMode: "domain" | "run",
  policySnapshotId?: string,
) {
  if (!asset) return undefined;
  if (policyMode === "domain") return asset.policy.content;
  if (!policySnapshotId) return undefined;
  return asset.policySnapshots[policySnapshotId]?.content;
}

function ContextTranslationNote({
  status,
  error,
  translated,
  kind,
  retry,
}: {
  status: LoadStatus;
  error: string | null;
  translated: boolean;
  kind: string;
  retry: () => void;
}) {
  const fallback = status === "error" || (status === "ready" && !translated);
  return (
    <div className="context-note translation-note" role="status" aria-live="polite" lang="ko">
      <span>
        {status === "loading"
          ? `한국어 ${kind}을 불러오는 동안 영어 원문을 표시합니다.`
          : fallback
            ? `한국어 ${kind}을 불러오지 못해 영어 원문을 표시합니다.`
            : `표시용 한국어 번역입니다. 실제 모델 실행에는 영어 원문이 사용되었습니다.`}
      </span>
      {fallback ? (
        <button type="button" className="quiet-button" onClick={retry}>다시 시도</button>
      ) : null}
      {error ? <span className="sr-only" lang="en">{error}</span> : null}
    </div>
  );
}

const AGENT_INSTRUCTION_FALLBACK = `You are a customer service agent that helps the user according to the <policy> provided below.
In each turn you can either:
- Send a message to the user.
- Make a tool call.
You cannot do both at the same time.

Try to be helpful and always follow the policy. Always make sure you generate valid JSON only.`;

const AGENT_SYSTEM_TEMPLATE_FALLBACK = `<instructions>
{agent_instruction}
</instructions>
<policy>
{domain_policy}
</policy>`;

const EVALUATOR_SYSTEM_FALLBACK = `TASK
- You will be given a list of expected outcomes and a conversation that was collected during a test case run.
- The conversation is between an agent and a customer.
- Your job is to evaluate whether the agent satisfies each of the expected outcomes.
- Grade each expected outcome individually.

FORMAT
- Your response should be a JSON object with the fields reasoning, metExpectation, and expectedOutcome.`;

function legacyScenarioText(domain: DomainData, trajectory: Trajectory | undefined) {
  if (!trajectory) return "";
  const fields: Array<[string, unknown]> = [
    ["Domain", domain.slug],
    ["Persona", trajectory.scenario.persona],
    ["Reason for call", trajectory.scenario.reasonForCall],
    ["Known information", trajectory.scenario.knownInfo],
    ["Unknown information", trajectory.scenario.unknownInfo],
    ["Task instructions", trajectory.scenario.taskInstructions],
  ];
  return fields
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([label, value]) => `${label}:\n${stringify(value)}`)
    .join("\n\n");
}

function PromptPanel({
  domain,
  trajectory,
  taskEntry,
  taskTranslation,
  taskLanguage,
  component,
  setComponent,
  promptMode,
  setPromptMode,
  evaluatorMode,
  setEvaluatorMode,
  runtimePromptId,
  runAgentModel,
  runUserModel,
  runPolicy,
  contextTranslation,
  contextTranslationStatus,
  contextTranslationError,
  retryContextTranslation,
  taskTranslationStatus,
  taskTranslationError,
  retryTaskTranslation,
  transcriptTranslation,
  transcriptTranslationStatus,
  transcriptTranslationError,
  retryTranscriptTranslation,
  detailStatus,
  detailError,
  retryDetail,
}: {
  domain: DomainData;
  trajectory?: Trajectory;
  taskEntry?: TaskAssetEntry;
  taskTranslation?: TaskTranslation;
  taskLanguage: TaskLanguage;
  component: PromptComponent;
  setComponent: (component: PromptComponent) => void;
  promptMode: PromptMode;
  setPromptMode: (mode: PromptMode) => void;
  evaluatorMode: EvaluatorPromptMode;
  setEvaluatorMode: (mode: EvaluatorPromptMode) => void;
  runtimePromptId?: string;
  runAgentModel?: string;
  runUserModel?: string;
  runPolicy?: string;
  contextTranslation: KoreanContextTranslationAsset | null;
  contextTranslationStatus: LoadStatus;
  contextTranslationError: string | null;
  retryContextTranslation: () => void;
  taskTranslationStatus: LoadStatus;
  taskTranslationError: string | null;
  retryTaskTranslation: () => void;
  transcriptTranslation: KoreanTranscriptTrajectory | null;
  transcriptTranslationStatus: LoadStatus;
  transcriptTranslationError: string | null;
  retryTranscriptTranslation: () => void;
  detailStatus: LoadStatus;
  detailError: string | null;
  retryDetail: () => void;
}) {
  const runtimePrompts = runtimePromptCatalog();
  const runtimeAgent = runtimePrompts.agent;
  const runtimeEvaluator = runtimePrompts.evaluator;
  const translatedAgent = contextTranslation?.agent;
  const translatedUser = contextTranslation?.user;
  const translatedEvaluator = contextTranslation?.evaluator;
  const userPrompt = domain.userPrompts.find((item) => item.id === runtimePromptId) ??
    domain.userPrompts[0];
  const translatedUserPrompt = translatedUser?.prompt;
  const evaluationPrompt = trajectory?.evaluationPrompt;

  const agentInstruction = documentContent(runtimeAgent.instruction) ?? AGENT_INSTRUCTION_FALLBACK;
  const agentTemplate = documentContent(runtimeAgent.systemTemplate) ?? AGENT_SYSTEM_TEMPLATE_FALLBACK;
  const agentResolved = fillAgentSystemPrompt(
    agentTemplate,
    agentInstruction,
    runPolicy ?? domain.policy,
  );
  const translatedAgentTemplate = documentContent(translatedAgent?.systemTemplate);
  const translatedAgentResolved = documentContent(translatedAgent?.resolvedSystemPrompt);
  const englishScenario = runtimeScenario(taskEntry) ?? legacyScenarioText(domain, trajectory);
  const koreanScenario = nonEmptyText(taskTranslation?.runtimeScenario);
  const userTemplate = userPrompt?.content ?? "No user simulator prompt was recorded.";
  const translatedUserTemplate = documentContent(translatedUserPrompt);
  const userResolved = fillUserSystemPrompt(userTemplate, englishScenario);
  const translatedUserResolved = translatedUserTemplate && koreanScenario
    ? fillUserSystemPrompt(translatedUserTemplate, koreanScenario)
    : undefined;
  const evaluatorSystem = documentContent(runtimeEvaluator.system) ?? EVALUATOR_SYSTEM_FALLBACK;
  const translatedEvaluatorSystem = documentContent(translatedEvaluator?.system);
  const evaluatorUserPrompt = nonEmptyText(evaluationPrompt?.userPrompt);
  const translatedEvaluatorUserPrompt = nonEmptyText(transcriptTranslation?.evaluatorUserPrompt);
  const evaluatorInvoked = Boolean(evaluatorUserPrompt);
  const agentModel = runAgentModel ?? runtimeAgent.model;
  const userModel = runUserModel ?? contextTranslation?.user.model ?? "gpt-4.1-2025-04-14";
  const evaluatorModel = runtimeEvaluator.model;

  const isKorean = taskLanguage === "ko";
  const usesTranscriptTranslation = component === "evaluator" && evaluatorMode === "user";
  const usesTaskTranslation = component === "user" && promptMode === "resolved" &&
    Boolean(translatedUserTemplate);
  const translationStatus = usesTranscriptTranslation
    ? transcriptTranslationStatus
    : usesTaskTranslation
      ? taskTranslationError ? "error" : taskTranslationStatus
      : contextTranslationStatus;
  const translationError = usesTranscriptTranslation
    ? transcriptTranslationError
    : usesTaskTranslation
      ? taskTranslationError
      : contextTranslationError;
  const retryTranslation = usesTranscriptTranslation
    ? retryTranscriptTranslation
    : usesTaskTranslation
      ? retryTaskTranslation
      : retryContextTranslation;

  let text = "";
  let translated = false;
  let title = "";
  let description = "";
  let sourceUrl = domain.promptUrl;
  let waitingForDetail = false;

  if (component === "agent") {
    title = "Agent system prompt";
    description = `Instructions and the selected run’s domain-policy snapshot sent to ${agentModel}.`;
    const translatedText = promptMode === "template"
      ? translatedAgentTemplate
      : translatedAgentResolved;
    text = isKorean && translatedText
      ? translatedText
      : promptMode === "template" ? agentTemplate : agentResolved;
    translated = Boolean(isKorean && translatedText);
    sourceUrl = documentSourceUrl(runtimeAgent.systemTemplate) ??
      `https://github.com/${domain.source.repository}/blob/964ef/src/tau2/agent/llm_agent.py`;
  } else if (component === "user") {
    title = isKorean
      ? nonEmptyText(translatedUserPrompt?.label) ?? userPrompt?.label ?? "User simulator system prompt"
      : userPrompt?.label ?? "User simulator system prompt";
    description = isKorean
      ? nonEmptyText(translatedUserPrompt?.description) ?? userPrompt?.description ??
        `The system prompt sent to the ${userModel} user simulator.`
      : userPrompt?.description ??
      `The system prompt sent to the ${userModel} user simulator.`;
    const translatedText = promptMode === "template"
      ? translatedUserTemplate
      : translatedUserResolved;
    text = isKorean && translatedText
      ? translatedText
      : promptMode === "template" ? userTemplate : userResolved;
    translated = Boolean(isKorean && translatedText);
    waitingForDetail = promptMode === "resolved" && !trajectory;
    sourceUrl = documentSourceUrl(userPrompt) ?? domain.promptUrl;
  } else {
    title = evaluatorMode === "system" ? "NL evaluator system prompt" : "NL evaluator user input";
    description = evaluatorMode === "system"
      ? `The grading instructions sent to ${evaluatorModel}.`
      : "The selected trajectory and expected outcomes sent for natural-language grading.";
    const translatedText = evaluatorMode === "system"
      ? translatedEvaluatorSystem
      : translatedEvaluatorUserPrompt;
    const englishText = evaluatorMode === "system" ? evaluatorSystem : evaluatorUserPrompt ?? "";
    text = isKorean && translatedText ? translatedText : englishText;
    translated = Boolean(isKorean && translatedText);
    waitingForDetail = !trajectory;
    sourceUrl = documentSourceUrl(runtimeEvaluator.system) ??
      `https://github.com/${domain.source.repository}/blob/964ef/src/tau2/evaluator/evaluator_nl_assertions.py`;
  }

  const translationKind = component === "agent"
    ? "에이전트 프롬프트"
    : component === "user"
      ? "사용자 시뮬레이터 프롬프트"
      : "평가 프롬프트";
  const promptLanguage: TaskLanguage = translated ? "ko" : "en";
  const sourceLinks = component === "user" && userPrompt?.sourceLinks?.length
    ? userPrompt.sourceLinks
    : [{ label: "English source", sourcePath: "", sourceUrl }];

  return (
    <div className="context-content document-content">
      <div className="stacked-toolbar">
        <div className="prompt-component-switch" role="tablist" aria-label="Runtime prompt component">
          {([
            ["agent", "Agent", agentModel],
            ["user", "User simulator", userModel],
            ["evaluator", "NL evaluator", evaluatorModel],
          ] as Array<[PromptComponent, string, string]>).map(([id, label, model]) => (
            <button
              type="button"
              role="tab"
              aria-selected={component === id}
              className={component === id ? "active" : ""}
              onClick={() => setComponent(id)}
              key={id}
            >
              <span>{label}</span>
              <small>{model}</small>
            </button>
          ))}
        </div>
        <div className="document-toolbar">
          {component === "evaluator" ? (
            <div className="mini-switch" role="group" aria-label="Evaluator prompt view">
              <button
                type="button"
                className={evaluatorMode === "system" ? "active" : ""}
                onClick={() => setEvaluatorMode("system")}
              >
                System
              </button>
              <button
                type="button"
                className={evaluatorMode === "user" ? "active" : ""}
                onClick={() => setEvaluatorMode("user")}
              >
                User input
              </button>
            </div>
          ) : (
            <div className="mini-switch" role="group" aria-label="Prompt view">
              <button
                type="button"
                className={promptMode === "template" ? "active" : ""}
                onClick={() => setPromptMode("template")}
              >
                Template
              </button>
              <button
                type="button"
                className={promptMode === "resolved" ? "active" : ""}
                onClick={() => setPromptMode("resolved")}
              >
                Resolved
              </button>
            </div>
          )}
          {text ? <CopyButton text={text} /> : null}
        </div>
      </div>

      <div
        className="prompt-description"
        lang={component === "user" && isKorean && translatedUserPrompt ? "ko" : "en"}
      >
        <strong>{title}</strong>
        <p>{description}</p>
      </div>

      {isKorean && !(component === "evaluator" && trajectory && !evaluatorInvoked) ? (
        <ContextTranslationNote
          status={translationStatus}
          error={translationError}
          translated={translated}
          kind={translationKind}
          retry={retryTranslation}
        />
      ) : null}

      {component === "user" ? (
        <div className="context-note">
          The initial greeting is a transcript message, not part of this system prompt.
          {domain.slug === "telecom"
            ? " Telecom uses the tool-enabled user-simulator prompt at runtime."
            : ""}
        </div>
      ) : null}

      <div className="source-line">
        <span className="source-link-list">
          {sourceLinks.map((source) => (
            <a
              href={source.sourceUrl}
              target="_blank"
              rel="noreferrer"
              title={source.sourcePath || undefined}
              key={`${source.label}:${source.sourceUrl}`}
            >
              {source.label} ↗
            </a>
          ))}
        </span>
      </div>

      {waitingForDetail ? (
        <ContextLoadState
          status={detailStatus}
          error={detailError}
          label={component === "evaluator" ? "the evaluator input" : "the resolved prompt"}
          retry={retryDetail}
        />
      ) : component === "evaluator" && !evaluatorInvoked ? (
        <div className="empty-context" role="status" lang={isKorean ? "ko" : "en"}>
          {isKorean
            ? "이 trajectory에서는 자연어 평가기가 호출되지 않았습니다."
            : "The NL evaluator was not invoked for this trajectory."}
        </div>
      ) : (
        <pre className="prompt-pre" lang={promptLanguage}>{text}</pre>
      )}
    </div>
  );
}

function ContextPanel({
  domain,
  trajectory,
  taskLanguage,
  taskEntry,
  taskTranslation,
  translationStatus,
  translationError,
  retryTaskTranslation,
  tab,
  setTab,
  promptComponent,
  setPromptComponent,
  policyMode,
  setPolicyMode,
  promptMode,
  setPromptMode,
  evaluatorPromptMode,
  setEvaluatorPromptMode,
  runtimePromptId,
  runAgentModel,
  runUserModel,
  runPolicy,
  runPolicyUrl,
  runPolicyId,
  contextTranslation,
  contextTranslationStatus,
  contextTranslationError,
  retryContextTranslation,
  transcriptTranslation,
  transcriptTranslationStatus,
  transcriptTranslationError,
  retryTranscriptTranslation,
  detailStatus,
  detailError,
  retryDetail,
  open,
  close,
  collapsed,
  collapse,
}: {
  domain: DomainData;
  trajectory?: Trajectory;
  taskLanguage: TaskLanguage;
  taskEntry?: TaskAssetEntry;
  taskTranslation?: TaskTranslation;
  translationStatus: LoadStatus;
  translationError: string | null;
  retryTaskTranslation: () => void;
  tab: ContextTab;
  setTab: (tab: ContextTab) => void;
  promptComponent: PromptComponent;
  setPromptComponent: (component: PromptComponent) => void;
  policyMode: "domain" | "run";
  setPolicyMode: (mode: "domain" | "run") => void;
  promptMode: PromptMode;
  setPromptMode: (mode: PromptMode) => void;
  evaluatorPromptMode: EvaluatorPromptMode;
  setEvaluatorPromptMode: (mode: EvaluatorPromptMode) => void;
  runtimePromptId?: string;
  runAgentModel?: string;
  runUserModel?: string;
  runPolicy?: string;
  runPolicyUrl?: string;
  runPolicyId?: string;
  contextTranslation: KoreanContextTranslationAsset | null;
  contextTranslationStatus: LoadStatus;
  contextTranslationError: string | null;
  retryContextTranslation: () => void;
  transcriptTranslation: KoreanTranscriptTrajectory | null;
  transcriptTranslationStatus: LoadStatus;
  transcriptTranslationError: string | null;
  retryTranscriptTranslation: () => void;
  detailStatus: LoadStatus;
  detailError: string | null;
  retryDetail: () => void;
  open: boolean;
  close: () => void;
  collapsed: boolean;
  collapse: () => void;
}) {
  const canonicalPolicy = policyMode === "run" && runPolicy
    ? runPolicy
    : domain.policy;
  const translatedPolicy = taskLanguage === "ko"
    ? translatedPolicyContent(contextTranslation, policyMode, runPolicyId)
    : undefined;
  const policy = translatedPolicy ?? canonicalPolicy;

  function downloadRaw() {
    if (!trajectory) return;
    const blob = new Blob([JSON.stringify(trajectory, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${domain.benchmark}-${domain.slug}-${trajectory.taskId.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <aside
      id="context-sidebar"
      className={`context-panel${open ? " context-open" : ""}${collapsed ? " panel-collapsed" : ""}`}
      aria-label="Domain context"
    >
      <div className="context-header">
        <div>
          <p className="eyebrow">Domain context</p>
          <strong>{domain.name}</strong>
        </div>
        <div className="context-header-actions">
          <span
            title="Callable tools exposed to each participant"
            aria-label={`${domain.agentToolCount ?? domain.toolCount} agent tools and ${domain.userToolCount ?? 0} user tools`}
          >
            Agent {domain.agentToolCount ?? domain.toolCount} · User {domain.userToolCount ?? 0}
          </span>
          <span>{domain.versionLabel}</span>
          <button
            type="button"
            className="context-collapse"
            onClick={collapse}
            aria-expanded={!collapsed}
            aria-label={taskLanguage === "ko" ? "오른쪽 컨텍스트 패널 접기" : "Collapse context sidebar"}
            title={taskLanguage === "ko" ? "컨텍스트 패널 접기" : "Collapse context sidebar"}
          >
            →
          </button>
          <button type="button" className="context-close" onClick={close} aria-label="Close context">
            ×
          </button>
        </div>
      </div>

      <div className="context-tabs" role="tablist" aria-label="Context views">
        {contextTabs.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
            key={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="context-scroll">
        {tab === "policy" ? (
          <div className="context-content document-content">
            <div className="document-toolbar">
              <div className="mini-switch" aria-label="Policy version">
                <button
                  type="button"
                  className={policyMode === "domain" ? "active" : ""}
                  onClick={() => setPolicyMode("domain")}
                >
                  Domain policy
                </button>
                <button
                  type="button"
                  className={policyMode === "run" ? "active" : ""}
                  onClick={() => setPolicyMode("run")}
                  disabled={!runPolicy}
                >
                  Run snapshot
                </button>
              </div>
              <CopyButton text={policy} />
            </div>
            <div className="source-line">
              <span>{policyMode === "run" ? "Policy captured in trajectory" : domain.policySource}</span>
              <a
                href={policyMode === "run" ? runPolicyUrl ?? domain.policyUrl : domain.policyUrl}
                target="_blank"
                rel="noreferrer"
              >
                English source ↗
              </a>
            </div>
            {taskLanguage === "ko" ? (
              <ContextTranslationNote
                status={contextTranslationStatus}
                error={contextTranslationError}
                translated={Boolean(translatedPolicy)}
                kind="도메인 정책"
                retry={retryContextTranslation}
              />
            ) : null}
            <div lang={translatedPolicy ? "ko" : "en"}>
              <MarkdownDocument content={policy} />
            </div>
          </div>
        ) : null}

        {tab === "prompt" ? (
          <PromptPanel
            domain={domain}
            trajectory={trajectory}
            taskEntry={taskEntry}
            taskTranslation={taskTranslation}
            taskLanguage={taskLanguage}
            component={promptComponent}
            setComponent={setPromptComponent}
            promptMode={promptMode}
            setPromptMode={setPromptMode}
            evaluatorMode={evaluatorPromptMode}
            setEvaluatorMode={setEvaluatorPromptMode}
            runtimePromptId={runtimePromptId}
            runAgentModel={runAgentModel}
            runUserModel={runUserModel}
            runPolicy={runPolicy}
            contextTranslation={contextTranslation}
            contextTranslationStatus={contextTranslationStatus}
            contextTranslationError={contextTranslationError}
            retryContextTranslation={retryContextTranslation}
            taskTranslationStatus={translationStatus}
            taskTranslationError={translationError}
            retryTaskTranslation={retryTaskTranslation}
            transcriptTranslation={transcriptTranslation}
            transcriptTranslationStatus={transcriptTranslationStatus}
            transcriptTranslationError={transcriptTranslationError}
            retryTranscriptTranslation={retryTranscriptTranslation}
            detailStatus={detailStatus}
            detailError={detailError}
            retryDetail={retryDetail}
          />
        ) : null}

        {tab === "task" ? (
          trajectory ? (
            <TaskPanel
              domain={domain}
              trajectory={trajectory}
              taskLanguage={taskLanguage}
              taskTranslation={taskTranslation}
              translationStatus={translationStatus}
              translationError={translationError}
              retryTranslation={retryTaskTranslation}
            />
          ) : (
            <ContextLoadState
              status={detailStatus}
              error={detailError}
              label="task context"
              retry={retryDetail}
            />
          )
        ) : null}
        {tab === "evaluation" ? (
          trajectory ? <EvaluationPanel trajectory={trajectory} /> : (
            <ContextLoadState
              status={detailStatus}
              error={detailError}
              label="evaluation data"
              retry={retryDetail}
            />
          )
        ) : null}
        {tab === "raw" ? (
          trajectory ? (
            <div className="context-content document-content" lang="en">
              <div className="document-toolbar raw-toolbar">
                <span>Normalized trajectory</span>
                <div>
                  <CopyButton text={JSON.stringify(trajectory, null, 2)} />
                  <button type="button" className="quiet-button" onClick={downloadRaw}>
                    Download
                  </button>
                </div>
              </div>
              <pre className="raw-pre">{JSON.stringify(trajectory, null, 2)}</pre>
            </div>
          ) : (
            <ContextLoadState
              status={detailStatus}
              error={detailError}
              label="normalized JSON"
              retry={retryDetail}
            />
          )
        ) : null}
      </div>
    </aside>
  );
}

export default function Explorer() {
  const [domainSlug, setDomainSlug] = useState("telecom");
  const [runFilter, setRunFilter] = useState("all");
  const [trialFilter, setTrialFilter] = useState("all");
  const [selectedTrajectoryId, setSelectedTrajectoryId] = useState("");
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [catalogView, setCatalogView] = useState<CatalogView>("tasks");
  const [taskLanguage, setTaskLanguage] = useState<TaskLanguage>("en");
  const [taskLanguageMounted, setTaskLanguageMounted] = useState(false);
  const [focusedTaskKey, setFocusedTaskKey] = useState("");
  const [contextTab, setContextTab] = useState<ContextTab>("policy");
  const [promptComponent, setPromptComponent] = useState<PromptComponent>("agent");
  const [policyMode, setPolicyMode] = useState<"domain" | "run">("domain");
  const [promptMode, setPromptMode] = useState<PromptMode>("resolved");
  const [evaluatorPromptMode, setEvaluatorPromptMode] = useState<EvaluatorPromptMode>("system");
  const [metadataVisible, setMetadataVisible] = useState(false);
  const [evaluationVisible, setEvaluationVisible] = useState(true);
  const [contextOpen, setContextOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [catalogPanelWidth, setCatalogPanelWidth] = useState(CATALOG_PANEL_DEFAULT);
  const [contextPanelWidth, setContextPanelWidth] = useState(CONTEXT_PANEL_DEFAULT);
  const [catalogPanelCollapsed, setCatalogPanelCollapsed] = useState(false);
  const [contextPanelCollapsed, setContextPanelCollapsed] = useState(false);
  const [panelLayoutMounted, setPanelLayoutMounted] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [page, setPage] = useState(0);
  const [indexRetry, setIndexRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const [taskTranslationRetry, setTaskTranslationRetry] = useState(0);
  const [transcriptTranslationRetry, setTranscriptTranslationRetry] = useState(0);
  const [contextTranslationRetry, setContextTranslationRetry] = useState(0);
  const [indexState, setIndexState] = useState<LoadState<IndexData>>({
    key: "",
    status: "idle",
    data: { trajectories: [], transcriptOverlays: {} },
    error: null,
  });
  const [detailState, setDetailState] = useState<LoadState<Trajectory | null>>({
    key: "",
    status: "idle",
    data: null,
    error: null,
  });
  const [transcriptTranslationState, setTranscriptTranslationState] = useState<LoadState<KoreanTranscriptTrajectory | null>>({
    key: "",
    status: "idle",
    data: null,
    error: null,
  });
  const [contextTranslationState, setContextTranslationState] = useState<LoadState<KoreanContextTranslationAsset | null>>({
    key: "",
    status: "idle",
    data: null,
    error: null,
  });
  const [taskAssetsState, setTaskAssetsState] = useState<LoadState<Map<string, TasksAsset>>>({
    key: "",
    status: "idle",
    data: new Map(),
    error: null,
  });
  const listRef = useRef<HTMLDivElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    let storedLayout: {
      catalogWidth?: number;
      contextWidth?: number;
      catalogCollapsed?: boolean;
      contextCollapsed?: boolean;
    } = {};
    try {
      storedLayout = JSON.parse(window.localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY) ?? "{}") as typeof storedLayout;
    } catch {
      // Keep the default panel layout when storage is unavailable or malformed.
    }
    void Promise.resolve().then(() => {
      if (!current) return;
      if (Number.isFinite(storedLayout.catalogWidth)) {
        setCatalogPanelWidth(clampPanelWidth(storedLayout.catalogWidth as number, CATALOG_PANEL_MIN, CATALOG_PANEL_MAX));
      }
      if (Number.isFinite(storedLayout.contextWidth)) {
        setContextPanelWidth(clampPanelWidth(storedLayout.contextWidth as number, CONTEXT_PANEL_MIN, CONTEXT_PANEL_MAX));
      }
      setCatalogPanelCollapsed(storedLayout.catalogCollapsed === true);
      setContextPanelCollapsed(storedLayout.contextCollapsed === true);
      setViewportWidth(window.innerWidth);
      setPanelLayoutMounted(true);
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!panelLayoutMounted) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify({
          catalogWidth: catalogPanelWidth,
          contextWidth: contextPanelWidth,
          catalogCollapsed: catalogPanelCollapsed,
          contextCollapsed: contextPanelCollapsed,
        }));
      } catch {
        // Panel controls continue to work for this session when storage is unavailable.
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    catalogPanelCollapsed,
    catalogPanelWidth,
    contextPanelCollapsed,
    contextPanelWidth,
    panelLayoutMounted,
  ]);

  useEffect(() => {
    function updateViewport() {
      setViewportWidth(window.innerWidth);
    }
    function closeTopDrawer(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (browserOpen) {
        setBrowserOpen(false);
      } else if (contextOpen) {
        setContextOpen(false);
        contextTriggerRef.current?.focus();
      }
    }
    window.addEventListener("resize", updateViewport);
    window.addEventListener("keydown", closeTopDrawer);
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("keydown", closeTopDrawer);
    };
  }, [browserOpen, contextOpen]);

  useEffect(() => {
    let current = true;
    let storedLanguage: TaskLanguage = "en";
    try {
      const stored = window.localStorage.getItem(DISPLAY_LANGUAGE_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_TASK_LANGUAGE_STORAGE_KEY);
      if (stored === "ko") {
        storedLanguage = "ko";
      }
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
    void Promise.resolve().then(() => {
      if (!current) return;
      setTaskLanguage(storedLanguage);
      setTaskLanguageMounted(true);
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!taskLanguageMounted) return;
    try {
      window.localStorage.setItem(DISPLAY_LANGUAGE_STORAGE_KEY, taskLanguage);
    } catch {
      // The selected language still applies for this session when storage is unavailable.
    }
  }, [taskLanguage, taskLanguageMounted]);

  const domains = scopedDomains;
  const domain = domains.find((candidate) => candidate.slug === domainSlug) ?? domains[0];
  const activeContextTranslationRef = contextTranslationRef(domain);

  useEffect(() => {
    let current = true;
    if (taskLanguage !== "ko") return () => { current = false; };
    if (!activeContextTranslationRef?.path) {
      void Promise.resolve().then(() => {
        if (!current) {
          return;
        }
        setContextTranslationState({
          key: domain.id,
          status: "ready",
          data: null,
          error: "A Korean domain context translation is not available.",
        });
      });
      return () => { current = false; };
    }
    void Promise.resolve().then(() => {
      if (!current) return;
      setContextTranslationState({
        key: domain.id,
        status: "loading",
        data: null,
        error: null,
      });
    });
    loadContextTranslation(activeContextTranslationRef.path, domain.id)
      .then((asset) => {
        if (!current) return;
        setContextTranslationState({
          key: domain.id,
          status: "ready",
          data: asset,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setContextTranslationState({
          key: domain.id,
          status: "error",
          data: null,
          error: error instanceof Error ? error.message : "Could not load Korean domain context.",
        });
      });
    return () => { current = false; };
  }, [activeContextTranslationRef?.path, contextTranslationRetry, domain.id, taskLanguage]);

  const scopedRuns = useMemo(
    () => domain.runs.filter((run) => run.model === TARGET_MODEL),
    [domain],
  );
  const preferredRunId = runFilter || "all";
  const activeRunFilter = preferredRunId === "all"
    ? "all"
    : scopedRuns.some((run) => run.id === preferredRunId)
      ? preferredRunId
      : scopedRuns[0]?.id ?? "all";
  const requestedRuns = useMemo(
    () => activeRunFilter === "all"
      ? scopedRuns
      : scopedRuns.filter((run) => run.id === activeRunFilter),
    [activeRunFilter, scopedRuns],
  );
  const requestedTaskPaths = useMemo(
    () => [...new Set(requestedRuns.map((run) => run.tasksPath))],
    [requestedRuns],
  );
  const requestedTaskPathsKey = requestedTaskPaths.join("|");
  const requestedKey = requestedRuns.map((run) => run.id).join("|");
  const expectedTrajectoryCount = requestedRuns.reduce(
    (count, run) => count + run.trajectoryCount,
    0,
  );
  const runsById = useMemo(
    () => new Map(domain.runs.map((run) => [run.id, run])),
    [domain],
  );
  const trialOptions = useMemo(
    () => [...new Set(requestedRuns.flatMap((run) => run.trials))].sort((a, b) => a - b),
    [requestedRuns],
  );

  useEffect(() => {
    if (taskLanguage !== "ko") return;
    let current = true;
    void Promise.resolve().then(() => {
      if (!current) return;
      setTaskAssetsState((state) => ({
        key: requestedTaskPathsKey,
        status: "loading",
        data: state.data,
        error: null,
      }));
    });
    Promise.allSettled(requestedTaskPaths.map(async (path) => [path, await loadTasks(path)] as const))
      .then((results) => {
        if (!current) return;
        setTaskAssetsState((state) => {
          const data = new Map(state.data);
          let failed = 0;
          for (const result of results) {
            if (result.status === "fulfilled") {
              data.set(result.value[0], result.value[1]);
            } else {
              failed += 1;
            }
          }
          return {
            key: requestedTaskPathsKey,
            status: "ready",
            data,
            error: failed
              ? `${failed} task translation asset${failed === 1 ? "" : "s"} could not be loaded.`
              : null,
          };
        });
      });
    return () => { current = false; };
  }, [requestedTaskPaths, requestedTaskPathsKey, taskLanguage, taskTranslationRetry]);

  useEffect(() => {
    let current = true;
    if (!requestedRuns.length) {
      void Promise.resolve().then(() => {
        if (current) {
          setIndexState({
            key: requestedKey,
            status: "ready",
            data: { trajectories: [], transcriptOverlays: {} },
            error: null,
          });
        }
      });
      return () => { current = false; };
    }

    void Promise.resolve().then(() => {
      if (current) {
        setIndexState({
          key: requestedKey,
          status: "loading",
          data: { trajectories: [], transcriptOverlays: {} },
          error: null,
        });
      }
    });
    Promise.all(requestedRuns.map(loadRunIndex))
      .then((indexes) => {
        if (!current) return;
        const transcriptOverlays = Object.assign(
          {},
          ...indexes.map((asset) => asset.transcriptOverlays?.ko ?? {}),
        );
        setIndexState({
          key: requestedKey,
          status: "ready",
          data: {
            trajectories: indexes.flatMap((asset) => asset.trajectories),
            transcriptOverlays,
          },
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setIndexState({
          key: requestedKey,
          status: "error",
          data: { trajectories: [], transcriptOverlays: {} },
          error: error instanceof Error ? error.message : "Could not load trajectory indexes.",
        });
      });
    return () => { current = false; };
  }, [indexRetry, requestedKey, requestedRuns]);

  const currentIndexState = indexState.key === requestedKey
    ? indexState
    : {
        key: requestedKey,
        status: "loading" as const,
        data: { trajectories: [], transcriptOverlays: {} },
        error: null,
      };
  const activeTaskTranslationStatus: LoadStatus = taskLanguage === "en"
    ? "idle"
    : taskAssetsState.key === requestedTaskPathsKey
      ? taskAssetsState.status
      : "loading";
  const activeTaskTranslationError = taskLanguage === "ko" &&
    taskAssetsState.key === requestedTaskPathsKey
    ? taskAssetsState.error
    : null;
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const filteredTrajectories = useMemo(() => currentIndexState.data.trajectories.filter((item) => {
    const run = runsById.get(item.runId);
    const koreanDisplay = taskDisplayForSummary(
      item,
      "ko",
      runsById,
      taskAssetsState.data,
    );
    const haystack = `${item.taskId} ${item.title} ${item.scenarioPreview} ${koreanDisplay.title} ${koreanDisplay.scenarioPreview} ${item.toolNames.join(" ")} ${run?.label ?? ""} ${run?.model ?? ""}`.toLocaleLowerCase();
    const matchesQuery = haystack.includes(deferredQuery);
    const matchesOutcome =
      outcome === "all" ||
      (outcome === "pass" && item.reward === 1) ||
      (outcome === "fail" && item.reward !== 1);
    const matchesTrial = trialFilter === "all" || item.trial === Number(trialFilter);
    return matchesQuery && matchesOutcome && matchesTrial;
  }), [currentIndexState.data, deferredQuery, outcome, runsById, taskAssetsState.data, trialFilter]);
  const allTaskGroups = useMemo(
    () => groupTaskSummaries(
      currentIndexState.data.trajectories,
      runsById,
      taskLanguage,
      taskAssetsState.data,
    ),
    [currentIndexState.data.trajectories, runsById, taskAssetsState.data, taskLanguage],
  );
  const matchingTrajectoryIds = useMemo(
    () => new Set(filteredTrajectories.map((item) => item.id)),
    [filteredTrajectories],
  );
  const taskGroups = useMemo(
    () => allTaskGroups.filter((group) =>
      group.trajectories.some((item) => matchingTrajectoryIds.has(item.id))),
    [allTaskGroups, matchingTrajectoryIds],
  );
  const taskCatalogTrajectories = useMemo(
    () => taskGroups.flatMap((group) => group.trajectories),
    [taskGroups],
  );
  const visibleTrajectories = catalogView === "tasks"
    ? taskCatalogTrajectories
    : filteredTrajectories;
  const selectedSummary =
    visibleTrajectories.find((candidate) => candidate.id === selectedTrajectoryId) ??
    visibleTrajectories[0];
  const selectedTaskGroup = selectedSummary
    ? taskGroups.find((group) => group.trajectories.some((item) => item.id === selectedSummary.id))
    : undefined;
  const activeTaskGroup =
    taskGroups.find((group) => group.key === focusedTaskKey) ??
    selectedTaskGroup ??
    taskGroups[0];
  const selectedRun = selectedSummary ? runsById.get(selectedSummary.runId) : undefined;
  const selectedTaskEntry = selectedSummary && selectedRun
    ? (taskAssetsState.data.get(selectedRun.tasksPath) ?? loadedTasksCache.get(selectedRun.tasksPath))
      ?.tasks[selectedSummary.taskId]
    : undefined;
  const selectedTaskDisplay = selectedSummary
    ? taskDisplayForSummary(
        selectedSummary,
        taskLanguage,
        runsById,
        taskAssetsState.data,
      )
    : undefined;
  const selectedTaskTranslation = taskLanguage === "ko"
    ? selectedTaskDisplay?.translation ?? selectedTaskEntry?.translations?.ko
    : undefined;
  const navigationTrajectories = catalogView === "tasks"
    ? selectedTaskGroup?.trajectories ?? []
    : filteredTrajectories;
  const currentIndex = selectedSummary
    ? navigationTrajectories.findIndex((candidate) => candidate.id === selectedSummary.id)
    : -1;
  const pageSize = catalogView === "tasks" ? TASK_PAGE_SIZE : PAGE_SIZE;
  const catalogItemCount = catalogView === "tasks"
    ? taskGroups.length
    : filteredTrajectories.length;
  const pageCount = Math.max(1, Math.ceil(catalogItemCount / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * pageSize;
  const pageTrajectories = filteredTrajectories.slice(pageStart, pageStart + PAGE_SIZE);
  const pageTaskGroups = taskGroups.slice(pageStart, pageStart + TASK_PAGE_SIZE);
  const transcriptOverlayRef = selectedSummary
    ? currentIndexState.data.transcriptOverlays[selectedSummary.detailPath]
    : undefined;
  const transcriptTranslationKey = selectedSummary ? `ko:${selectedSummary.id}` : "";

  useEffect(() => {
    let current = true;
    if (taskLanguage !== "ko" || !selectedSummary || selectedSummary.messageCount === 0) {
      return () => { current = false; };
    }
    if (!transcriptOverlayRef?.path) {
      void Promise.resolve().then(() => {
        if (!current) return;
        setTranscriptTranslationState({
          key: transcriptTranslationKey,
          status: "ready",
          data: null,
          error: "A Korean conversation translation is not available for this trajectory.",
        });
      });
      return () => { current = false; };
    }

    void Promise.resolve().then(() => {
      if (!current) return;
      setTranscriptTranslationState({
        key: transcriptTranslationKey,
        status: "loading",
        data: null,
        error: null,
      });
    });
    loadTranscriptOverlay(transcriptOverlayRef.path)
      .then((asset) => {
        if (!current) return;
        if (
          asset.runId !== selectedSummary.runId ||
          asset.sourceDetailPath !== selectedSummary.detailPath
        ) {
          throw new Error("The Korean conversation overlay does not match this trajectory chunk.");
        }
        const translated = asset.trajectories[selectedSummary.id];
        if (!translated) {
          throw new Error("This trajectory is missing from its Korean conversation overlay.");
        }
        setTranscriptTranslationState({
          key: transcriptTranslationKey,
          status: "ready",
          data: translated,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setTranscriptTranslationState({
          key: transcriptTranslationKey,
          status: "error",
          data: null,
          error: error instanceof Error ? error.message : "Could not load the Korean conversation.",
        });
      });
    return () => { current = false; };
  }, [
    selectedSummary,
    taskLanguage,
    transcriptOverlayRef?.path,
    transcriptTranslationKey,
    transcriptTranslationRetry,
  ]);

  useEffect(() => {
    let current = true;
    if (!selectedSummary || !selectedRun) {
      return () => { current = false; };
    }

    const cached = detailCache.get(selectedSummary.id);
    if (cached) {
      void Promise.resolve().then(() => {
        if (current) {
          setDetailState({
            key: selectedSummary.id,
            status: "ready",
            data: cached,
            error: null,
          });
        }
      });
      return () => { current = false; };
    }

    void Promise.resolve().then(() => {
      if (current) {
        setDetailState({
          key: selectedSummary.id,
          status: "loading",
          data: null,
          error: null,
        });
      }
    });
    loadTrajectoryDetail(domain, selectedRun, selectedSummary)
      .then((loaded) => {
        if (!current) return;
        setDetailState({
          key: selectedSummary.id,
          status: "ready",
          data: loaded,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setDetailState({
          key: selectedSummary.id,
          status: "error",
          data: null,
          error: error instanceof Error ? error.message : "Could not load trajectory detail.",
        });
      });
    return () => { current = false; };
  }, [detailRetry, domain, selectedRun, selectedSummary]);

  const trajectory = selectedSummary && detailState.key === selectedSummary.id &&
    detailState.status === "ready"
    ? detailState.data ?? undefined
    : undefined;
  const activeTranscriptTranslationStatus: LoadStatus = taskLanguage === "en" ||
    !selectedSummary || selectedSummary.messageCount === 0
    ? "idle"
    : transcriptTranslationState.key === transcriptTranslationKey
      ? transcriptTranslationState.status
      : "loading";
  const activeTranscriptTranslation = taskLanguage === "ko" &&
    transcriptTranslationState.key === transcriptTranslationKey
    ? transcriptTranslationState.data
    : null;
  const activeTranscriptTranslationError = taskLanguage === "ko" &&
    transcriptTranslationState.key === transcriptTranslationKey
    ? transcriptTranslationState.error
    : null;
  const displayMessages = useMemo(() => (trajectory?.messages ?? []).map((message, index) => {
    const canTranslate = taskLanguage === "ko" && Boolean(message.content) && !isControlToken(message.content);
    const translated = canTranslate && activeTranscriptTranslation
      ? translatedMessageContent(activeTranscriptTranslation, index)
      : undefined;
    return {
      message,
      displayContent: translated ?? message.content,
      displayToolCalls: displayToolInvocations(
        message,
        index,
        taskLanguage === "ko" ? activeTranscriptTranslation : null,
      ),
      contentLanguage: translated ? "ko" as const : "en" as const,
      translationFallback: Boolean(
        canTranslate &&
        activeTranscriptTranslation &&
        activeTranscriptTranslationStatus === "ready" &&
        !translated,
      ),
    };
  }), [activeTranscriptTranslation, activeTranscriptTranslationStatus, taskLanguage, trajectory]);
  const evaluationItems = useMemo(
    () => trajectory ? buildEvaluationItems(trajectory) : [],
    [trajectory],
  );
  const evaluationItemsByMessage = useMemo(() => {
    const byMessage = new Map<number, EvaluationDisplayItem[]>();
    for (const item of evaluationItems) {
      if (item.anchorMessageIndex === null) continue;
      const existing = byMessage.get(item.anchorMessageIndex) ?? [];
      existing.push(item);
      byMessage.set(item.anchorMessageIndex, existing);
    }
    return byMessage;
  }, [evaluationItems]);
  const transcriptFallbackCount = displayMessages.filter((item) => item.translationFallback).length;
  const activeDetailStatus: LoadStatus = !selectedSummary
    ? "idle"
    : detailState.key === selectedSummary.id
      ? detailState.status
      : "loading";
  const activeDetailError = detailState.key === selectedSummary?.id
    ? detailState.error
    : null;
  const activeContextTranslationStatus: LoadStatus = taskLanguage === "en"
    ? "idle"
    : contextTranslationState.key === domain.id
      ? contextTranslationState.status
      : "loading";
  const activeContextTranslation = taskLanguage === "ko" &&
    contextTranslationState.key === domain.id
    ? contextTranslationState.data
    : null;
  const activeContextTranslationError = taskLanguage === "ko" &&
    contextTranslationState.key === domain.id
    ? contextTranslationState.error
    : null;
  const duration = selectedSummary ? formatDuration(selectedSummary.duration) : null;
  const contextRun = selectedRun ?? (
    activeRunFilter !== "all" ? runsById.get(activeRunFilter) : requestedRuns[0]
  );
  const runPolicySnapshot = contextRun
    ? domain.policySnapshots.find((item) => item.id === contextRun.policySnapshotId)
    : undefined;

  function resetBrowser() {
    setRunFilter("all");
    setTrialFilter("all");
    setOutcome("all");
    setQuery("");
    setFocusedTaskKey("");
    setPage(0);
    setSelectedTrajectoryId("");
    setPromptComponent("agent");
    setPolicyMode("domain");
    setBrowserOpen(false);
  }

  function changeDomain(slug: string) {
    setDomainSlug(slug);
    resetBrowser();
  }

  function changeRun(nextRun: string) {
    setRunFilter(nextRun);
    setTrialFilter("all");
    setPage(0);
    setSelectedTrajectoryId("");
    setFocusedTaskKey("");
  }

  function changeCatalogView(nextView: CatalogView) {
    setCatalogView(nextView);
    if (!selectedSummary) {
      setPage(0);
      return;
    }
    if (nextView === "tasks") {
      const taskIndex = taskGroups.findIndex((group) =>
        group.trajectories.some((item) => item.id === selectedSummary.id));
      setPage(taskIndex >= 0 ? Math.floor(taskIndex / TASK_PAGE_SIZE) : 0);
      if (taskIndex >= 0) setFocusedTaskKey(taskGroups[taskIndex].key);
      return;
    }
    const trajectoryIndex = filteredTrajectories.findIndex(
      (item) => item.id === selectedSummary.id,
    );
    setPage(trajectoryIndex >= 0 ? Math.floor(trajectoryIndex / PAGE_SIZE) : 0);
  }

  function chooseTask(group: TaskSummaryGroup) {
    setFocusedTaskKey(group.key);
    if (!group.trajectories.some((item) => item.id === selectedSummary?.id)) {
      const firstMatching = group.trajectories.find((item) => matchingTrajectoryIds.has(item.id));
      setSelectedTrajectoryId(firstMatching?.id ?? group.trajectories[0]?.id ?? "");
    }
  }

  function chooseTrajectory(id: string) {
    const index = filteredTrajectories.findIndex((item) => item.id === id);
    setSelectedTrajectoryId(id);
    const taskIndex = taskGroups.findIndex((group) =>
      group.trajectories.some((item) => item.id === id));
    if (taskIndex >= 0) setFocusedTaskKey(taskGroups[taskIndex].key);
    if (catalogView === "tasks") {
      if (taskIndex >= 0) setPage(Math.floor(taskIndex / TASK_PAGE_SIZE));
    } else if (index >= 0) {
      setPage(Math.floor(index / PAGE_SIZE));
    }
    setBrowserOpen(false);
    listRef.current?.scrollTo({ top: 0 });
  }

  function moveTrajectory(offset: number) {
    if (!navigationTrajectories.length || currentIndex < 0) return;
    const next = (currentIndex + offset + navigationTrajectories.length) % navigationTrajectories.length;
    const nextTrajectory = navigationTrajectories[next];
    setSelectedTrajectoryId(nextTrajectory.id);
    if (catalogView === "tasks") {
      const taskIndex = taskGroups.findIndex((group) =>
        group.trajectories.some((item) => item.id === nextTrajectory.id));
      if (taskIndex >= 0) {
        setFocusedTaskKey(taskGroups[taskIndex].key);
        setPage(Math.floor(taskIndex / TASK_PAGE_SIZE));
      }
    } else {
      setPage(Math.floor(next / PAGE_SIZE));
    }
  }

  function movePage(offset: number) {
    const next = Math.min(pageCount - 1, Math.max(0, safePage + offset));
    setPage(next);
    if (catalogView === "tasks") {
      const firstTask = taskGroups[next * TASK_PAGE_SIZE];
      if (firstTask) {
        setFocusedTaskKey(firstTask.key);
        setSelectedTrajectoryId(firstTask.trajectories[0]?.id ?? "");
      }
    } else {
      const first = filteredTrajectories[next * PAGE_SIZE];
      if (first) setSelectedTrajectoryId(first.id);
    }
    listRef.current?.scrollTo({ top: 0 });
  }

  function retrySelectedDetail() {
    if (selectedSummary) {
      detailCache.delete(selectedSummary.id);
      detailChunkCache.delete(selectedSummary.detailPath);
      if (selectedRun) tasksCache.delete(selectedRun.tasksPath);
    }
    setDetailRetry((value) => value + 1);
  }

  function retryTranscriptTranslation() {
    if (transcriptOverlayRef?.path) transcriptOverlayCache.delete(transcriptOverlayRef.path);
    setTranscriptTranslationRetry((value) => value + 1);
  }

  function retryTaskTranslation() {
    for (const path of requestedTaskPaths) {
      tasksCache.delete(path);
      loadedTasksCache.delete(path);
    }
    setTaskTranslationRetry((value) => value + 1);
  }

  function retryContextTranslation() {
    if (activeContextTranslationRef?.path) {
      contextTranslationCache.delete(activeContextTranslationRef.path);
    }
    setContextTranslationRetry((value) => value + 1);
  }

  let renderedCatalogWidth = catalogPanelWidth;
  let renderedContextWidth = contextPanelWidth;
  if (viewportWidth <= 900) {
    renderedCatalogWidth = Math.max(360, renderedCatalogWidth);
  }
  if (viewportWidth > 1280) {
    const availableForPanels = Math.max(
      CATALOG_PANEL_MIN + CONTEXT_PANEL_MIN,
      viewportWidth - MIN_WORKSPACE_WIDTH,
    );
    const catalogColumn = catalogPanelCollapsed ? 52 : renderedCatalogWidth;
    const contextColumn = contextPanelCollapsed ? 0 : renderedContextWidth;
    const overflow = Math.max(0, catalogColumn + contextColumn - availableForPanels);
    if (overflow > 0 && !contextPanelCollapsed) {
      renderedContextWidth = Math.max(CONTEXT_PANEL_MIN, renderedContextWidth - overflow);
    }
    const remainingOverflow = Math.max(
      0,
      (catalogPanelCollapsed ? 52 : renderedCatalogWidth) +
        (contextPanelCollapsed ? 0 : renderedContextWidth) -
        availableForPanels,
    );
    if (remainingOverflow > 0 && !catalogPanelCollapsed) {
      renderedCatalogWidth = Math.max(CATALOG_PANEL_MIN, renderedCatalogWidth - remainingOverflow);
    }
  }
  const catalogResizeMaximum = viewportWidth > 1280 && !contextPanelCollapsed
    ? Math.max(
      CATALOG_PANEL_MIN,
      Math.min(CATALOG_PANEL_MAX, viewportWidth - renderedContextWidth - MIN_WORKSPACE_WIDTH),
    )
    : CATALOG_PANEL_MAX;
  const catalogResizeMinimum = viewportWidth <= 900 ? 360 : CATALOG_PANEL_MIN;
  const contextResizeMaximum = viewportWidth > 1280 && !catalogPanelCollapsed
    ? Math.max(
      CONTEXT_PANEL_MIN,
      Math.min(CONTEXT_PANEL_MAX, viewportWidth - renderedCatalogWidth - MIN_WORKSPACE_WIDTH),
    )
    : CONTEXT_PANEL_MAX;
  const explorerStyle = {
    "--catalog-width": `${renderedCatalogWidth}px`,
    "--context-width": `${renderedContextWidth}px`,
  } as CSSProperties;
  const explorerClassName = [
    "explorer-shell",
    catalogPanelCollapsed ? "catalog-panel-collapsed" : "",
    contextPanelCollapsed ? "context-panel-collapsed" : "",
    browserOpen ? "browser-drawer-open" : "",
    contextOpen ? "context-drawer-open" : "",
  ].filter(Boolean).join(" ");

  function openCatalogDrawer() {
    setContextOpen(false);
    setBrowserOpen(true);
  }

  function openContextSidebar() {
    setBrowserOpen(false);
    setContextPanelCollapsed(false);
    setContextOpen(true);
  }

  function collapseContextSidebar() {
    setContextPanelCollapsed(true);
    setContextOpen(false);
    window.requestAnimationFrame(() => contextTriggerRef.current?.focus());
  }

  return (
    <main className={explorerClassName} style={explorerStyle}>
      <aside className="sidebar" id="catalog-sidebar" aria-label="Catalog sidebar">
        <button
          type="button"
          className="catalog-restore"
          onClick={() => setCatalogPanelCollapsed(false)}
          aria-expanded={!catalogPanelCollapsed}
          aria-label={taskLanguage === "ko" ? "왼쪽 카탈로그 패널 펼치기" : "Expand catalog sidebar"}
          title={taskLanguage === "ko" ? "카탈로그 패널 펼치기" : "Expand catalog sidebar"}
        >
          →
        </button>
        <div className="brand-row">
          <span className="brand-mark">τ²</span>
          <div className="brand-copy">
            <strong className="brand-name">TAU Explorer</strong>
            <span className="brand-subtitle">τ² · GPT-5</span>
          </div>
          <TaskLanguageSwitch
            value={taskLanguage}
            onChange={setTaskLanguage}
            className="desktop-task-language"
          />
          <button
            type="button"
            className="catalog-collapse"
            onClick={() => setCatalogPanelCollapsed(true)}
            aria-expanded={!catalogPanelCollapsed}
            aria-label={taskLanguage === "ko" ? "왼쪽 카탈로그 패널 접기" : "Collapse catalog sidebar"}
            title={taskLanguage === "ko" ? "카탈로그 패널 접기" : "Collapse catalog sidebar"}
          >
            ←
          </button>
        </div>

        <div className="mobile-selectors">
          <label>
            <span>Domain</span>
            <select value={domain.slug} onChange={(event) => changeDomain(event.target.value)}>
              {domains.map((item) => <option value={item.slug} key={item.id}>{item.name}</option>)}
            </select>
          </label>
          <div className="mobile-browser-field">
            <span>Catalog</span>
            <button
              type="button"
              className="mobile-browser-trigger"
              onClick={openCatalogDrawer}
              aria-expanded={browserOpen}
            >
              <strong lang={selectedTaskDisplay?.translation ? "ko" : "en"}>
                {selectedTaskDisplay?.title ?? (selectedSummary ? compactTaskId(selectedSummary.taskId) : "Browse catalog")}
              </strong>
              <span>
                {catalogView === "tasks"
                  ? `${selectedTaskGroup?.trajectories.length ?? 0} ${taskLanguage === "ko" ? "개 대화" : "conversations"}`
                  : `${filteredTrajectories.length.toLocaleString()} trajectories`}
              </span>
            </button>
          </div>
          <TaskLanguageSwitch
            value={taskLanguage}
            onChange={setTaskLanguage}
            className="mobile-task-language"
          />
        </div>

        <nav className="domain-nav" aria-label="Domains">
          <div className="section-heading">
            <p className="eyebrow">Domains</p>
            <span>{domain.versionLabel}</span>
          </div>
          <div className="domain-list">
            {domains.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`domain-item${item.id === domain.id ? " active" : ""}`}
                onClick={() => changeDomain(item.slug)}
              >
                <span className="domain-name">
                  <span className="availability-mark">τ²</span>
                  {item.name}
                </span>
                <span className="domain-count">{item.taskCount}</span>
              </button>
            ))}
          </div>
        </nav>

        <section
          className={`trajectory-browser${browserOpen ? " mobile-open" : ""}`}
          aria-label="Task and trajectory browser"
        >
          <div className="mobile-browser-head">
            <div>
              <p className="eyebrow">{catalogView === "tasks" ? "Task catalog" : "Trajectory catalog"}</p>
              <strong>{domain.name}</strong>
            </div>
            <button type="button" onClick={() => setBrowserOpen(false)} aria-label="Close browser">×</button>
          </div>
          <div className="section-heading">
            <p className="eyebrow">{catalogView === "tasks" ? "Tasks" : "Trajectories"}</p>
            <span>
              {currentIndexState.status === "ready"
                ? catalogView === "tasks"
                  ? `${taskGroups.length.toLocaleString()} tasks · ${taskCatalogTrajectories.length.toLocaleString()} conversations`
                  : `${filteredTrajectories.length.toLocaleString()} / ${expectedTrajectoryCount.toLocaleString()}`
                : "Loading…"}
            </span>
          </div>
          <div className="catalog-view-switch" role="tablist" aria-label="Catalog view">
            {(["tasks", "trajectories"] as CatalogView[]).map((view) => (
              <button
                type="button"
                role="tab"
                aria-selected={catalogView === view}
                className={catalogView === view ? "active" : ""}
                onClick={() => changeCatalogView(view)}
                key={view}
              >
                {view === "tasks" ? "Tasks" : "Trajectories"}
              </button>
            ))}
          </div>
          {catalogView === "trajectories" || scopedRuns.length > 1 ? (
          <div className={`catalog-filters${scopedRuns.length > 1 && catalogView === "trajectories" ? "" : " single-filter"}`}>
            {scopedRuns.length > 1 ? (
              <label className="catalog-filter run-filter">
                <span>Run</span>
                <select value={activeRunFilter} onChange={(event) => changeRun(event.target.value)}>
                  <option value="all">All GPT-5 runs · {scopedRuns.length}</option>
                  {scopedRuns.map((run) => (
                    <option value={run.id} key={run.id}>{formatRunLabel(run)}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {catalogView === "trajectories" ? <label className="catalog-filter trial-filter">
              <span>Trial</span>
              <select
                value={trialFilter}
                onChange={(event) => {
                  setTrialFilter(event.target.value);
                  setPage(0);
                  setSelectedTrajectoryId("");
                  setFocusedTaskKey("");
                }}
              >
                <option value="all">All</option>
                {trialOptions.map((trial) => <option value={trial} key={trial}>#{trial}</option>)}
              </select>
            </label> : null}
          </div>
          ) : null}
          <div className="search-wrap">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
                setSelectedTrajectoryId("");
                setFocusedTaskKey("");
              }}
              placeholder="Search task, scenario, or tool"
              aria-label="Search tasks and trajectories"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setPage(0);
                  setSelectedTrajectoryId("");
                  setFocusedTaskKey("");
                }}
                aria-label="Clear search"
              >×</button>
            ) : null}
          </div>
          {catalogView === "trajectories" ? <div className="outcome-filter" aria-label="Outcome filter">
            {(["all", "pass", "fail"] as OutcomeFilter[]).map((filter) => (
              <button
                type="button"
                className={outcome === filter ? "active" : ""}
                onClick={() => {
                  setOutcome(filter);
                  setPage(0);
                  setSelectedTrajectoryId("");
                  setFocusedTaskKey("");
                }}
                key={filter}
              >
                {filter[0].toUpperCase() + filter.slice(1)}
              </button>
            ))}
          </div> : null}
          <div className="trajectory-list" ref={listRef}>
            {currentIndexState.status === "loading" ? (
              <div className="catalog-state" role="status">
                <span className="loading-mark" aria-hidden="true" />
                <strong>Loading run index</strong>
                <p>{expectedTrajectoryCount.toLocaleString()} trajectory summaries</p>
              </div>
            ) : null}
            {currentIndexState.status === "error" ? (
              <div className="catalog-state" role="alert">
                <strong>Index unavailable</strong>
                <p>{currentIndexState.error}</p>
                <button type="button" className="quiet-button" onClick={() => setIndexRetry((value) => value + 1)}>
                  Retry
                </button>
              </div>
            ) : null}
            {currentIndexState.status === "ready" && catalogView === "tasks"
              ? pageTaskGroups.map((group) => {
                const expanded = activeTaskGroup?.key === group.key;
                const selected = selectedTaskGroup?.key === group.key;
                return (
                  <article
                    className={`task-group-card${selected ? " active" : ""}`}
                    key={group.key}
                  >
                    <button
                      type="button"
                      className="task-group-toggle"
                      onClick={() => chooseTask(group)}
                      aria-expanded={expanded}
                    >
                      <span className="task-group-copy">
                        <span className="trajectory-id">Task {compactTaskId(group.taskId)}</span>
                        <strong lang={group.contentLanguage}>{group.title}</strong>
                        <span className="task-scenario" lang={group.contentLanguage}>{group.scenarioPreview}</span>
                        <span className="task-group-meta">
                          {group.trajectories.length} {taskLanguage === "ko" ? "개 대화" : "conversations"}
                        </span>
                      </span>
                      <span className="task-group-side" aria-label={`${group.passCount} passed, ${group.failCount} failed`}>
                        <span className="task-result-count">✓ {group.passCount}</span>
                        <span className="task-result-count fail">× {group.failCount}</span>
                        <span className="task-group-disclosure" aria-hidden="true">⌄</span>
                      </span>
                    </button>
                    {expanded ? (
                      <div className="task-run-list" role="group" aria-label={`Trajectories for task ${group.taskId}`}>
                        {group.runs.map((runGroup) => {
                          const groupRun = runsById.get(runGroup.runId);
                          const runLabel = groupRun ? formatRunLabel(groupRun) : "Unknown run";
                          return (
                            <div className="task-run-group" key={runGroup.runId}>
                              <div className="task-run-heading">
                                <strong>{runLabel}</strong>
                                <span>{runGroup.passCount} pass · {runGroup.failCount} fail</span>
                              </div>
                              <div className="task-trial-chips">
                                {runGroup.trajectories.map((item) => (
                                  <button
                                    type="button"
                                    className={`task-trial-chip${item.id === selectedSummary?.id ? " active" : ""}`}
                                    onClick={() => chooseTrajectory(item.id)}
                                    aria-label={`${taskLanguage === "ko" ? `대화 ${item.trial + 1}` : `Conversation ${item.trial + 1}`}, Trial ${item.trial}, ${runLabel}, ${item.reward === 1 ? "Pass" : "Fail"}`}
                                    key={item.id}
                                  >
                                    <span className={`trial-outcome ${item.reward === 1 ? "pass" : "fail"}`} aria-hidden="true">
                                      {item.reward === 1 ? "✓" : "×"}
                                    </span>
                                    <span className="task-conversation-label" lang={taskLanguage}>
                                      {taskLanguage === "ko" ? `대화 ${item.trial + 1}` : `Conversation ${item.trial + 1}`}
                                    </span>
                                    <small>Trial #{item.trial}</small>
                                  </button>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </article>
                );
              })
              : null}
            {currentIndexState.status === "ready" && catalogView === "trajectories" ? pageTrajectories.map((item) => {
              const itemRun = runsById.get(item.runId);
              const itemDisplay = taskDisplayForSummary(
                item,
                taskLanguage,
                runsById,
                taskAssetsState.data,
              );
              return (
              <button
                type="button"
                className={`trajectory-item${item.id === selectedSummary?.id ? " active" : ""}`}
                onClick={() => chooseTrajectory(item.id)}
                key={item.id}
              >
                <span className={`mini-outcome ${item.reward === 1 ? "pass" : "fail"}`}>
                  {item.reward === 1 ? "✓" : "×"}
                </span>
                <span className="trajectory-item-copy">
                  <span className="trajectory-id">Task {compactTaskId(item.taskId)} · T{item.trial}</span>
                  <strong lang={itemDisplay.translation ? "ko" : "en"}>{itemDisplay.title}</strong>
                  <span>{item.messageCount} turns · {item.toolCallCount} calls · {itemRun ? formatRunLabel(itemRun) : "Unknown run"}</span>
                </span>
              </button>
              );
            }) : null}
            {currentIndexState.status === "ready" && !filteredTrajectories.length ? (
              <div className="empty-list">No task or trajectory matches this filter.</div>
            ) : null}
          </div>
          {currentIndexState.status === "ready" && filteredTrajectories.length ? (
            <div className="catalog-pagination" aria-label={`${catalogView === "tasks" ? "Task" : "Trajectory"} pages`}>
              <button type="button" onClick={() => movePage(-1)} disabled={safePage === 0}>←</button>
              <span>
                {pageStart + 1}–{Math.min(pageStart + pageSize, catalogItemCount)} of {catalogItemCount.toLocaleString()} {catalogView}
              </span>
              <button type="button" onClick={() => movePage(1)} disabled={safePage >= pageCount - 1}>→</button>
            </div>
          ) : null}
        </section>

        <div className="sidebar-footer">
          <div>
            <span className="status-dot" />
            τ² · GPT-5 snapshot
          </div>
          <a
            href={`https://github.com/${domain.source.repository}`}
            target="_blank"
            rel="noreferrer"
          >
            GitHub ↗
          </a>
        </div>
      </aside>

      <PanelResizer
        side="catalog"
        value={renderedCatalogWidth}
        minimum={catalogResizeMinimum}
        maximum={catalogResizeMaximum}
        label={taskLanguage === "ko" ? "카탈로그 패널 너비 조절" : "Resize catalog sidebar"}
        onChange={setCatalogPanelWidth}
        onReset={() => setCatalogPanelWidth(CATALOG_PANEL_DEFAULT)}
      />

      <section className="workspace">
        {currentIndexState.status === "loading" ? (
          <div className="workspace-state" role="status" aria-label="Conversation transcript">
            <span className="loading-mark large" aria-hidden="true" />
            <h1>Loading trajectory catalog</h1>
            <p>Fetching the selected run’s lightweight index.</p>
          </div>
        ) : currentIndexState.status === "error" ? (
          <div className="workspace-state" role="alert" aria-label="Conversation transcript">
            <span className="state-symbol">!</span>
            <h1>Catalog unavailable</h1>
            <p>{currentIndexState.error}</p>
            <button type="button" className="state-button" onClick={() => setIndexRetry((value) => value + 1)}>
              Retry
            </button>
          </div>
        ) : selectedSummary ? (
          <>
            <header className="topbar">
              <div className="title-block">
                <p className="breadcrumb">
                  {domain.benchmarkLabel} / {domain.slug} / task {compactTaskId(selectedSummary.taskId)}
                </p>
                <h1 lang={selectedTaskDisplay?.translation ? "ko" : "en"}>
                  {selectedTaskDisplay?.title ?? selectedSummary.title}
                </h1>
              </div>
              <div className="topbar-actions">
                <button
                  type="button"
                  className="context-trigger"
                  ref={contextTriggerRef}
                  onClick={openContextSidebar}
                  aria-controls="context-sidebar"
                  aria-expanded={contextOpen}
                >
                  {taskLanguage === "ko" ? "컨텍스트" : "Context"}
                </button>
                <button
                  type="button"
                  className={`score-badge ${selectedSummary.reward === 1 ? "pass" : "fail"}${evaluationVisible ? " active" : ""}`}
                  aria-pressed={evaluationVisible}
                  aria-label={taskLanguage === "ko"
                    ? `${selectedSummary.reward === 1 ? "통과" : "실패"}, 점수 ${selectedSummary.reward.toFixed(1)}. 대화 안 평가 ${evaluationVisible ? "숨기기" : "표시하기"}`
                    : `${selectedSummary.reward === 1 ? "Passed" : "Failed"}, score ${selectedSummary.reward.toFixed(1)}. ${evaluationVisible ? "Hide" : "Show"} evaluation in the conversation`}
                  onClick={() => setEvaluationVisible((visible) => !visible)}
                  title={taskLanguage === "ko" ? "대화 안의 평가 표시 전환" : "Toggle evaluation inside the conversation"}
                >
                  <span>{selectedSummary.reward === 1 ? "✓" : "×"}</span>
                  {taskLanguage === "ko"
                    ? (selectedSummary.reward === 1 ? "통과" : "실패")
                    : (selectedSummary.reward === 1 ? "Passed" : "Failed")}
                  <strong>{selectedSummary.reward.toFixed(1)}</strong>
                </button>
              </div>
            </header>

            <div className="trajectory-toolbar">
              <button
                type="button"
                aria-label={taskLanguage === "ko" ? "이전 대화" : "Previous conversation"}
                onClick={() => moveTrajectory(-1)}
              >←</button>
              <span>{currentIndex + 1} / {navigationTrajectories.length}</span>
              <button
                type="button"
                aria-label={taskLanguage === "ko" ? "다음 대화" : "Next conversation"}
                onClick={() => moveTrajectory(1)}
              >→</button>
              <span className="toolbar-separator" />
              <span>{selectedSummary.messageCount} {taskLanguage === "ko" ? "턴" : "turns"}</span>
              <span>
                {selectedSummary.toolCallCount} {taskLanguage === "ko" ? "도구 호출" : "tool calls"}
              </span>
              {duration ? <span>{duration}</span> : null}
              <span className="toolbar-spacer" />
              {selectedRun ? (
                <a href={selectedRun.sourceUrl} target="_blank" rel="noreferrer">
                  {taskLanguage === "ko" ? "원문 ↗" : "Source ↗"}
                </a>
              ) : null}
              <button
                type="button"
                className={`metadata-toggle${metadataVisible ? " active" : ""}`}
                onClick={() => setMetadataVisible((visible) => !visible)}
              >
                {taskLanguage === "ko" ? "메타데이터" : "Metadata"}
              </button>
            </div>

            {catalogView === "tasks" && selectedTaskGroup ? (
              <div className="task-history-strip" role="tablist" aria-label={taskLanguage === "ko" ? "이 Task의 대화 이력" : "Conversation histories for this Task"}>
                <span className="task-history-heading" lang={taskLanguage}>
                  {taskLanguage === "ko" ? "이 Task의 대화" : "This Task"}
                </span>
                <div className="task-history-tabs">
                  {selectedTaskGroup.trajectories.map((item) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={item.id === selectedSummary.id}
                      className={item.id === selectedSummary.id ? "active" : ""}
                      onClick={() => chooseTrajectory(item.id)}
                      key={item.id}
                    >
                      <span className={`trial-outcome ${item.reward === 1 ? "pass" : "fail"}`} aria-hidden="true">
                        {item.reward === 1 ? "✓" : "×"}
                      </span>
                      <span className="task-history-copy">
                        <strong lang={taskLanguage}>{taskLanguage === "ko" ? `대화 ${item.trial + 1}` : `Conversation ${item.trial + 1}`}</strong>
                        <small>Trial #{item.trial} · {item.messageCount} {taskLanguage === "ko" ? "턴" : "turns"}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {metadataVisible ? (
              <div className="metadata-strip">
                <span><small>{taskLanguage === "ko" ? "상담원" : "Agent"}</small>{selectedRun?.model ?? "—"}</span>
                <span><small>{taskLanguage === "ko" ? "사용자 시뮬레이터" : "User simulator"}</small>{selectedRun?.userModel ?? "—"}</span>
                <span><small>{taskLanguage === "ko" ? "실행" : "Run"}</small>{selectedRun ? formatRunLabel(selectedRun) : "—"}</span>
                <span><small>{taskLanguage === "ko" ? "종료" : "Termination"}</small>{selectedSummary.terminationReason.replaceAll("_", " ")}</span>
                <span><small>{taskLanguage === "ko" ? "시행" : "Trial"}</small>#{selectedSummary.trial}</span>
                <span><small>{taskLanguage === "ko" ? "비용" : "Cost"}</small>{formatCost(selectedSummary.agentCost)}</span>
              </div>
            ) : null}

            {activeDetailStatus === "ready" && trajectory?.messages.length ? (
              <ol
                className="chat-stream"
                aria-label={taskLanguage === "ko" ? "대화 기록, 한국어 표시" : "Conversation transcript"}
                key={trajectory.id}
              >
                {taskLanguage === "ko" ? (
                  <TranscriptLanguageNotice
                    status={activeTranscriptTranslationStatus}
                    error={activeTranscriptTranslationError}
                    hasTranslation={Boolean(activeTranscriptTranslation)}
                    fallbackCount={transcriptFallbackCount}
                    retry={retryTranscriptTranslation}
                  />
                ) : null}
                {evaluationVisible ? (
                  <EvaluationOverview
                    trajectory={trajectory}
                    items={evaluationItems}
                    displayLanguage={taskLanguage}
                  />
                ) : null}
                {displayMessages.map((item, index) => {
                  const linkedEvaluation = evaluationItemsByMessage.get(index) ?? [];
                  return (
                    <Fragment key={`${item.message.turnIndex}-${index}`}>
                      <TranscriptItem
                        message={item.message}
                        metadataVisible={metadataVisible}
                        displayContent={item.displayContent}
                        displayToolCalls={item.displayToolCalls}
                        contentLanguage={item.contentLanguage}
                        displayLanguage={taskLanguage}
                        translationFallback={item.translationFallback}
                      />
                      {evaluationVisible && linkedEvaluation.length ? (
                        <EvaluationEvidence items={linkedEvaluation} displayLanguage={taskLanguage} />
                      ) : null}
                    </Fragment>
                  );
                })}
                {evaluationVisible ? (
                  <EvaluationSummary items={evaluationItems} displayLanguage={taskLanguage} />
                ) : null}
              </ol>
            ) : activeDetailStatus === "ready" && trajectory ? (
              <div className="workspace-state transcript-state" role="status" aria-label="Conversation transcript">
                <span className="state-symbol">—</span>
                <h1>No user conversation</h1>
                <p>This agent-only run contains task and evaluation data, but no user simulator transcript.</p>
              </div>
            ) : activeDetailStatus === "error" ? (
              <div className="workspace-state transcript-state" role="alert" aria-label="Conversation transcript">
                <span className="state-symbol">!</span>
                <h1>Trajectory unavailable</h1>
                <p>{activeDetailError}</p>
                <div className="state-actions">
                  <button type="button" className="state-button" onClick={retrySelectedDetail}>Retry</button>
                  {selectedRun ? <a href={selectedRun.sourceUrl} target="_blank" rel="noreferrer">Open source ↗</a> : null}
                </div>
              </div>
            ) : (
              <div className="workspace-state transcript-state" role="status" aria-label="Conversation transcript">
                <span className="loading-mark large" aria-hidden="true" />
                <h1>Loading trajectory</h1>
                <p>Fetching the conversation, tool results, task, and evaluation.</p>
              </div>
            )}
          </>
        ) : (
          <div className="workspace-empty">
            <span>⌕</span>
            <h1>No matching trajectory</h1>
            <p>Clear the search or outcome filter to keep exploring.</p>
          </div>
        )}
      </section>

      <PanelResizer
        side="context"
        value={renderedContextWidth}
        minimum={CONTEXT_PANEL_MIN}
        maximum={contextResizeMaximum}
        label={taskLanguage === "ko" ? "컨텍스트 패널 너비 조절" : "Resize context sidebar"}
        onChange={setContextPanelWidth}
        onReset={() => setContextPanelWidth(CONTEXT_PANEL_DEFAULT)}
      />

      <ContextPanel
        domain={domain}
        trajectory={trajectory}
        taskLanguage={taskLanguage}
        taskEntry={selectedTaskEntry}
        taskTranslation={selectedTaskTranslation}
        translationStatus={activeTaskTranslationStatus}
        translationError={activeTaskTranslationError}
        retryTaskTranslation={retryTaskTranslation}
        tab={contextTab}
        setTab={setContextTab}
        promptComponent={promptComponent}
        setPromptComponent={setPromptComponent}
        policyMode={policyMode}
        setPolicyMode={setPolicyMode}
        promptMode={promptMode}
        setPromptMode={setPromptMode}
        evaluatorPromptMode={evaluatorPromptMode}
        setEvaluatorPromptMode={setEvaluatorPromptMode}
        runtimePromptId={contextRun?.promptRef}
        runAgentModel={contextRun?.model}
        runUserModel={contextRun?.userModel}
        runPolicy={runPolicySnapshot?.content}
        runPolicyUrl={runPolicySnapshot?.sourceUrl}
        runPolicyId={runPolicySnapshot?.id}
        contextTranslation={activeContextTranslation}
        contextTranslationStatus={activeContextTranslationStatus}
        contextTranslationError={activeContextTranslationError}
        retryContextTranslation={retryContextTranslation}
        transcriptTranslation={activeTranscriptTranslation}
        transcriptTranslationStatus={activeTranscriptTranslationStatus}
        transcriptTranslationError={activeTranscriptTranslationError}
        retryTranscriptTranslation={retryTranscriptTranslation}
        detailStatus={activeDetailStatus}
        detailError={activeDetailError}
        retryDetail={retrySelectedDetail}
        open={contextOpen}
        close={() => setContextOpen(false)}
        collapsed={contextPanelCollapsed}
        collapse={collapseContextSidebar}
      />
      {contextOpen ? (
        <button
          type="button"
          className="context-backdrop"
          onClick={() => setContextOpen(false)}
          aria-label="Close context"
        />
      ) : null}
      {browserOpen ? (
        <button
          type="button"
          className="trajectory-browser-backdrop"
          onClick={() => setBrowserOpen(false)}
          aria-label="Close trajectory browser"
        />
      ) : null}
    </main>
  );
}
