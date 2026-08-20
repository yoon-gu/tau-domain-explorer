"use client";

import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import snapshotJson from "./data/benchmark-snapshot.json";
import type {
  BenchmarkId,
  BenchmarkSnapshot,
  DomainData,
  RunData,
  RunIndexAsset,
  TaskAssetEntry,
  TasksAsset,
  PromptVariant,
  ToolInvocation,
  Trajectory,
  TrajectoryDetailAsset,
  TrajectorySummary,
  TranscriptMessage,
} from "./data/types";

const snapshot = snapshotJson as BenchmarkSnapshot;
type OutcomeFilter = "all" | "pass" | "fail";
type ContextTab = "policy" | "prompt" | "task" | "evaluation" | "raw";
type LoadStatus = "idle" | "loading" | "ready" | "error";

interface LoadState<T> {
  key: string;
  status: LoadStatus;
  data: T;
  error: string | null;
}

const PAGE_SIZE = 100;
const DETAIL_CACHE_LIMIT = 24;
const runIndexCache = new Map<string, Promise<TrajectorySummary[]>>();
const tasksCache = new Map<string, Promise<TasksAsset>>();
const detailRequestCache = new Map<string, Promise<Trajectory>>();
const detailCache = new Map<string, Trajectory>();

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
      return asset.trajectories;
    })
    .catch((error) => {
      runIndexCache.delete(run.id);
      throw error;
    });
  runIndexCache.set(run.id, request);
  return request;
}

function loadTasks(path: string) {
  const cached = tasksCache.get(path);
  if (cached) return cached;
  const request = readJson<TasksAsset>(path).catch((error) => {
    tasksCache.delete(path);
    throw error;
  });
  tasksCache.set(path, request);
  return request;
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
  detail: TrajectoryDetailAsset,
): Trajectory {
  if (detail.trajectory.id !== summary.id || detail.trajectory.runId !== run.id) {
    throw new Error("The selected trajectory detail does not match its index entry.");
  }
  if (!Array.isArray(detail.trajectory.messages)) {
    throw new Error("The selected trajectory has no valid message transcript.");
  }
  const policy = domain.policySnapshots.find(
    (snapshot) => snapshot.id === run.policySnapshotId,
  );
  return {
    ...detail.trajectory,
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
  const pending = detailRequestCache.get(summary.id);
  if (pending) return pending;

  const request = Promise.all([
    readJson<TrajectoryDetailAsset>(summary.detailPath),
    loadTasks(run.tasksPath),
  ])
    .then(([detail, tasks]) => {
      const task = tasks.tasks[summary.taskId];
      if (!task) throw new Error("Task metadata is missing for this trajectory.");
      const trajectory = hydrateTrajectory(domain, run, summary, task, detail);
      rememberDetail(summary.id, trajectory);
      detailRequestCache.delete(summary.id);
      return trajectory;
    })
    .catch((error) => {
      detailRequestCache.delete(summary.id);
      throw error;
    });
  detailRequestCache.set(summary.id, request);
  return request;
}

const contextTabs: Array<{ id: ContextTab; label: string }> = [
  { id: "policy", label: "Policy" },
  { id: "prompt", label: "User prompt" },
  { id: "task", label: "Task" },
  { id: "evaluation", label: "Evaluation" },
  { id: "raw", label: "Raw" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function scenarioText(domain: DomainData, trajectory: Trajectory) {
  if (domain.benchmark === "tau") {
    return String(trajectory.scenario.instruction ?? "");
  }

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

function resolvedPrompt(
  domain: DomainData,
  trajectory: Trajectory | undefined,
  prompt: PromptVariant,
) {
  if (!trajectory) return prompt.content;
  if (domain.benchmark === "tau") {
    return prompt.content.replace(
      /{{ task\.instruction }}/g,
      String(trajectory.scenario.instruction ?? ""),
    );
  }
  return prompt.content.replace(/{{ user_scenario }}/g, scenarioText(domain, trajectory));
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button type="button" className="quiet-button" onClick={copy}>
      {copied ? "Copied" : label}
    </button>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const text = stringify(value);
  return (
    <section className="json-block">
      <div className="json-heading">
        <span>{label}</span>
        <CopyButton text={text} />
      </div>
      <pre>{text}</pre>
    </section>
  );
}

function ToolInvocationCard({
  invocation,
  defaultOpen,
}: {
  invocation: ToolInvocation;
  defaultOpen?: boolean;
}) {
  const isUserTool = invocation.requestor === "user";
  return (
    <details
      className={`tool-call ${isUserTool ? "user-tool" : "agent-tool"}${
        invocation.error ? " tool-error" : ""
      }`}
      open={defaultOpen || undefined}
    >
      <summary>
        <span className="tool-owner" aria-hidden="true">
          {isUserTool ? "U" : "A"}
        </span>
        <span className="tool-summary-copy">
          <span className="tool-kind">{isUserTool ? "User tool" : "Agent tool"}</span>
          <strong>{invocation.name}</strong>
        </span>
        <span className={`tool-state${invocation.error ? " error" : ""}`}>
          {invocation.error ? "Error" : invocation.result === null ? "No result" : "Success"}
        </span>
        <span className="disclosure" aria-hidden="true">⌄</span>
      </summary>
      <div className="tool-detail-grid">
        <JsonBlock label="Arguments" value={invocation.arguments} />
        <JsonBlock label="Result" value={invocation.result} />
      </div>
    </details>
  );
}

function TranscriptItem({
  message,
  messageIndex,
  metadataVisible,
}: {
  message: TranscriptMessage;
  messageIndex: number;
  metadataVisible: boolean;
}) {
  const isUser = message.role === "user";
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
          {isUser ? "U" : "A"}
        </span>
        <strong>{isUser ? "User" : "Assistant"}</strong>
        <span className="turn-label">Turn {message.turnIndex}</span>
        {metadataVisible && timestamp ? <time>{timestamp}</time> : null}
      </div>
      {message.content ? (
        <p className={message.content.startsWith("###") ? "control-token" : undefined}>
          {message.content}
        </p>
      ) : null}
      {message.toolCalls.map((invocation, index) => (
        <ToolInvocationCard
          key={`${invocation.id}-${index}`}
          invocation={invocation}
          defaultOpen={messageIndex < 6 && index === 0}
        />
      ))}
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

function TaskPanel({ domain, trajectory }: { domain: DomainData; trajectory?: Trajectory }) {
  if (!trajectory) return <EmptyContext label="Choose a trajectory to inspect its task." />;
  const description = asRecord(trajectory.task.description);

  return (
    <div className="context-content structured-content">
      <div className="panel-intro">
        <span className="section-kicker">Task · {compactTaskId(trajectory.taskId)}</span>
        <h2>{trajectory.title}</h2>
        {description.purpose ? <p>{String(description.purpose)}</p> : null}
      </div>

      {domain.benchmark === "tau" ? (
        <>
          <ContextSection title="User instruction">
            <p className="preserve-lines">{String(trajectory.scenario.instruction ?? "—")}</p>
          </ContextSection>
          <dl className="definition-list">
            <Stat label="User ID" value={String(trajectory.scenario.userId ?? "—")} />
            <Stat
              label="Reference actions"
              value={Array.isArray(trajectory.task.actions) ? trajectory.task.actions.length : 0}
            />
            <Stat
              label="Expected outputs"
              value={Array.isArray(trajectory.task.outputs) ? trajectory.task.outputs.length : 0}
            />
          </dl>
        </>
      ) : (
        <>
          {[
            ["Persona", trajectory.scenario.persona],
            ["Reason for call", trajectory.scenario.reasonForCall],
            ["Known information", trajectory.scenario.knownInfo],
            ["Unknown information", trajectory.scenario.unknownInfo],
            ["Task instructions", trajectory.scenario.taskInstructions],
          ].map(([label, value]) =>
            value ? (
              <ContextSection title={String(label)} key={String(label)}>
                <p className="preserve-lines">{stringify(value)}</p>
              </ContextSection>
            ) : null,
          )}
        </>
      )}

      <details className="raw-disclosure">
        <summary>Complete task JSON <span aria-hidden="true">⌄</span></summary>
        <JsonBlock label="Task" value={trajectory.task} />
      </details>
    </div>
  );
}

function ContextSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="context-section">
      <h3>{title}</h3>
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
    <div className="context-content structured-content">
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

function ContextPanel({
  domain,
  trajectory,
  tab,
  setTab,
  promptVariantId,
  setPromptVariantId,
  policyMode,
  setPolicyMode,
  promptMode,
  setPromptMode,
  runtimePromptId,
  runPolicy,
  runPolicyUrl,
  detailStatus,
  detailError,
  retryDetail,
  open,
  close,
}: {
  domain: DomainData;
  trajectory?: Trajectory;
  tab: ContextTab;
  setTab: (tab: ContextTab) => void;
  promptVariantId: string;
  setPromptVariantId: (id: string) => void;
  policyMode: "domain" | "run";
  setPolicyMode: (mode: "domain" | "run") => void;
  promptMode: "resolved" | "template";
  setPromptMode: (mode: "resolved" | "template") => void;
  runtimePromptId?: string;
  runPolicy?: string;
  runPolicyUrl?: string;
  detailStatus: LoadStatus;
  detailError: string | null;
  retryDetail: () => void;
  open: boolean;
  close: () => void;
}) {
  const prompt =
    domain.userPrompts.find((variant) => variant.id === promptVariantId) ??
    domain.userPrompts.find((variant) => variant.id === runtimePromptId) ??
    domain.userPrompts[0];
  const policy = policyMode === "run" && runPolicy
    ? runPolicy
    : domain.policy;
  const promptText = promptMode === "resolved"
    ? resolvedPrompt(domain, trajectory, prompt)
    : prompt.content;

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
    <aside className={`context-panel${open ? " context-open" : ""}`} aria-label="Domain context">
      <div className="context-header">
        <div>
          <p className="eyebrow">Domain context</p>
          <strong>{domain.name}</strong>
        </div>
        <div className="context-header-actions">
          <span>{domain.versionLabel}</span>
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
                Source ↗
              </a>
            </div>
            <MarkdownDocument content={policy} />
          </div>
        ) : null}

        {tab === "prompt" ? (
          <div className="context-content document-content">
            <div className="stacked-toolbar">
              <div className="variant-row" aria-label="Prompt variant">
                {domain.userPrompts.map((variant) => (
                  <button
                    type="button"
                    className={`variant-chip${variant.id === prompt.id ? " active" : ""}`}
                    onClick={() => setPromptVariantId(variant.id)}
                    key={variant.id}
                  >
                    {variant.label}
                  </button>
                ))}
              </div>
              <div className="document-toolbar">
                <div className="mini-switch" aria-label="Prompt view">
                  <button
                    type="button"
                    className={promptMode === "resolved" ? "active" : ""}
                    onClick={() => setPromptMode("resolved")}
                  >
                    Resolved
                  </button>
                  <button
                    type="button"
                    className={promptMode === "template" ? "active" : ""}
                    onClick={() => setPromptMode("template")}
                  >
                    Template
                  </button>
                </div>
                <CopyButton text={promptText} />
              </div>
            </div>
            <div className="prompt-description">
              <strong>{prompt.label}</strong>
              <p>{prompt.description}</p>
            </div>
            {domain.benchmark === "tau2" && domain.slug === "telecom" ? (
              <div className="context-note">
                Telecom uses the tool-enabled guidelines at runtime because the simulated user
                can operate device tools.
              </div>
            ) : null}
            <div className="source-line">
              <span>{domain.promptSource}</span>
              <a href={domain.promptUrl} target="_blank" rel="noreferrer">Source ↗</a>
            </div>
            {promptMode === "resolved" && !trajectory ? (
              <ContextLoadState
                status={detailStatus}
                error={detailError}
                label="the resolved prompt"
                retry={retryDetail}
              />
            ) : (
              <pre className="prompt-pre">{promptText}</pre>
            )}
          </div>
        ) : null}

        {tab === "task" ? (
          trajectory ? <TaskPanel domain={domain} trajectory={trajectory} /> : (
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
            <div className="context-content document-content">
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
  const [benchmark, setBenchmark] = useState<BenchmarkId>("tau2");
  const [domainSlug, setDomainSlug] = useState("telecom");
  const [modelFilter, setModelFilter] = useState("all");
  const [runFilter, setRunFilter] = useState("");
  const [trialFilter, setTrialFilter] = useState("all");
  const [selectedTrajectoryId, setSelectedTrajectoryId] = useState("");
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [contextTab, setContextTab] = useState<ContextTab>("policy");
  const [promptVariantId, setPromptVariantId] = useState("");
  const [policyMode, setPolicyMode] = useState<"domain" | "run">("domain");
  const [promptMode, setPromptMode] = useState<"resolved" | "template">("resolved");
  const [metadataVisible, setMetadataVisible] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [indexRetry, setIndexRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const [indexState, setIndexState] = useState<LoadState<TrajectorySummary[]>>({
    key: "",
    status: "idle",
    data: [],
    error: null,
  });
  const [detailState, setDetailState] = useState<LoadState<Trajectory | null>>({
    key: "",
    status: "idle",
    data: null,
    error: null,
  });
  const listRef = useRef<HTMLDivElement>(null);

  const domains = useMemo(
    () => snapshot.domains.filter((domain) => domain.benchmark === benchmark),
    [benchmark],
  );
  const domain = domains.find((candidate) => candidate.slug === domainSlug) ?? domains[0];

  const models = useMemo(
    () => [...new Set(domain.runs.map((run) => run.model))],
    [domain],
  );
  const runsForModel = useMemo(
    () => domain.runs.filter((run) => modelFilter === "all" || run.model === modelFilter),
    [domain, modelFilter],
  );
  const preferredRunId = runFilter || domain.defaultRunId;
  const activeRunFilter = preferredRunId === "all"
    ? "all"
    : runsForModel.some((run) => run.id === preferredRunId)
      ? preferredRunId
      : runsForModel[0]?.id ?? "all";
  const requestedRuns = useMemo(
    () => activeRunFilter === "all"
      ? runsForModel
      : runsForModel.filter((run) => run.id === activeRunFilter),
    [activeRunFilter, runsForModel],
  );
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
    let current = true;
    if (!requestedRuns.length) {
      void Promise.resolve().then(() => {
        if (current) {
          setIndexState({ key: requestedKey, status: "ready", data: [], error: null });
        }
      });
      return () => { current = false; };
    }

    void Promise.resolve().then(() => {
      if (current) {
        setIndexState({ key: requestedKey, status: "loading", data: [], error: null });
      }
    });
    Promise.all(requestedRuns.map(loadRunIndex))
      .then((indexes) => {
        if (!current) return;
        setIndexState({
          key: requestedKey,
          status: "ready",
          data: indexes.flat(),
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setIndexState({
          key: requestedKey,
          status: "error",
          data: [],
          error: error instanceof Error ? error.message : "Could not load trajectory indexes.",
        });
      });
    return () => { current = false; };
  }, [indexRetry, requestedKey, requestedRuns]);

  const currentIndexState = indexState.key === requestedKey
    ? indexState
    : { key: requestedKey, status: "loading" as const, data: [], error: null };
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const filteredTrajectories = useMemo(() => currentIndexState.data.filter((item) => {
    const run = runsById.get(item.runId);
    const haystack = `${item.taskId} ${item.title} ${item.scenarioPreview} ${item.toolNames.join(" ")} ${run?.label ?? ""} ${run?.model ?? ""}`.toLocaleLowerCase();
    const matchesQuery = haystack.includes(deferredQuery);
    const matchesOutcome =
      outcome === "all" ||
      (outcome === "pass" && item.reward === 1) ||
      (outcome === "fail" && item.reward !== 1);
    const matchesTrial = trialFilter === "all" || item.trial === Number(trialFilter);
    return matchesQuery && matchesOutcome && matchesTrial;
  }), [currentIndexState.data, deferredQuery, outcome, runsById, trialFilter]);
  const selectedSummary =
    filteredTrajectories.find((candidate) => candidate.id === selectedTrajectoryId) ??
    filteredTrajectories[0];
  const selectedRun = selectedSummary ? runsById.get(selectedSummary.runId) : undefined;
  const currentIndex = selectedSummary
    ? filteredTrajectories.findIndex((candidate) => candidate.id === selectedSummary.id)
    : -1;
  const pageCount = Math.max(1, Math.ceil(filteredTrajectories.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageTrajectories = filteredTrajectories.slice(pageStart, pageStart + PAGE_SIZE);

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
  const activeDetailStatus: LoadStatus = !selectedSummary
    ? "idle"
    : detailState.key === selectedSummary.id
      ? detailState.status
      : "loading";
  const activeDetailError = detailState.key === selectedSummary?.id
    ? detailState.error
    : null;
  const duration = selectedSummary ? formatDuration(selectedSummary.duration) : null;
  const contextRun = selectedRun ?? (
    activeRunFilter !== "all" ? runsById.get(activeRunFilter) : requestedRuns[0]
  );
  const runPolicySnapshot = contextRun
    ? domain.policySnapshots.find((item) => item.id === contextRun.policySnapshotId)
    : undefined;

  function resetBrowser(nextDomain: DomainData) {
    setModelFilter("all");
    setRunFilter(nextDomain.defaultRunId);
    setTrialFilter("all");
    setOutcome("all");
    setQuery("");
    setPage(0);
    setSelectedTrajectoryId("");
    setPromptVariantId("");
    setPolicyMode("domain");
    setBrowserOpen(false);
  }

  function changeBenchmark(nextBenchmark: BenchmarkId) {
    const nextDomains = snapshot.domains.filter((item) => item.benchmark === nextBenchmark);
    const nextDomain = nextDomains.find((item) => item.slug === domainSlug) ?? nextDomains[0];
    setBenchmark(nextBenchmark);
    setDomainSlug(nextDomain.slug);
    resetBrowser(nextDomain);
  }

  function changeDomain(slug: string) {
    const nextDomain = domains.find((item) => item.slug === slug) ?? domains[0];
    setDomainSlug(slug);
    resetBrowser(nextDomain);
  }

  function changeModel(nextModel: string) {
    const nextRuns = domain.runs.filter(
      (run) => nextModel === "all" || run.model === nextModel,
    );
    const currentRun = activeRunFilter === "all"
      ? undefined
      : domain.runs.find((run) => run.id === activeRunFilter);
    setModelFilter(nextModel);
    if (currentRun && nextRuns.some((run) => run.id === currentRun.id)) {
      setRunFilter(currentRun.id);
    } else {
      setRunFilter(nextRuns[0]?.id ?? "all");
    }
    setTrialFilter("all");
    setPage(0);
    setSelectedTrajectoryId("");
  }

  function changeRun(nextRun: string) {
    setRunFilter(nextRun);
    setTrialFilter("all");
    setPage(0);
    setSelectedTrajectoryId("");
  }

  function chooseTrajectory(id: string) {
    const index = filteredTrajectories.findIndex((item) => item.id === id);
    setSelectedTrajectoryId(id);
    if (index >= 0) setPage(Math.floor(index / PAGE_SIZE));
    setBrowserOpen(false);
    listRef.current?.scrollTo({ top: 0 });
  }

  function moveTrajectory(offset: number) {
    if (!filteredTrajectories.length || currentIndex < 0) return;
    const next = (currentIndex + offset + filteredTrajectories.length) % filteredTrajectories.length;
    setSelectedTrajectoryId(filteredTrajectories[next].id);
    setPage(Math.floor(next / PAGE_SIZE));
  }

  function movePage(offset: number) {
    const next = Math.min(pageCount - 1, Math.max(0, safePage + offset));
    setPage(next);
    const first = filteredTrajectories[next * PAGE_SIZE];
    if (first) setSelectedTrajectoryId(first.id);
    listRef.current?.scrollTo({ top: 0 });
  }

  function retrySelectedDetail() {
    if (selectedSummary) {
      detailCache.delete(selectedSummary.id);
      detailRequestCache.delete(selectedSummary.id);
    }
    setDetailRetry((value) => value + 1);
  }

  return (
    <main className="explorer-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <span className="brand-mark">τ</span>
          <div>
            <strong className="brand-name">TAU Explorer</strong>
            <span className="brand-subtitle">Domain observatory</span>
          </div>
        </div>

        <div className="benchmark-switch" aria-label="Benchmark version">
          <button
            type="button"
            className={`benchmark-tab${benchmark === "tau" ? " active" : ""}`}
            onClick={() => changeBenchmark("tau")}
          >
            τ-bench
          </button>
          <button
            type="button"
            className={`benchmark-tab${benchmark === "tau2" ? " active" : ""}`}
            onClick={() => changeBenchmark("tau2")}
          >
            τ²-bench
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
            <span>Trajectory</span>
            <button
              type="button"
              className="mobile-browser-trigger"
              onClick={() => setBrowserOpen(true)}
              aria-expanded={browserOpen}
            >
              <strong>{selectedSummary ? compactTaskId(selectedSummary.taskId) : "Browse catalog"}</strong>
              <span>{filteredTrajectories.length.toLocaleString()} results</span>
            </button>
          </div>
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
                  <span className="availability-mark">{benchmark === "tau" ? "τ" : "τ²"}</span>
                  {item.name}
                </span>
                <span className="domain-count">{item.taskCount}</span>
              </button>
            ))}
          </div>
        </nav>

        <section
          className={`trajectory-browser${browserOpen ? " mobile-open" : ""}`}
          aria-label="Trajectory browser"
        >
          <div className="mobile-browser-head">
            <div>
              <p className="eyebrow">Trajectory catalog</p>
              <strong>{domain.name}</strong>
            </div>
            <button type="button" onClick={() => setBrowserOpen(false)} aria-label="Close browser">×</button>
          </div>
          <div className="section-heading">
            <p className="eyebrow">Trajectories</p>
            <span>
              {currentIndexState.status === "ready"
                ? `${filteredTrajectories.length.toLocaleString()} / ${expectedTrajectoryCount.toLocaleString()}`
                : "Loading…"}
            </span>
          </div>
          <div className="catalog-filters">
            <label className="catalog-filter model-filter">
              <span>Model</span>
              <select value={modelFilter} onChange={(event) => changeModel(event.target.value)}>
                <option value="all">All models</option>
                {models.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
            </label>
            <label className="catalog-filter run-filter">
              <span>Run</span>
              <select value={activeRunFilter} onChange={(event) => changeRun(event.target.value)}>
                <option value="all">All runs · {runsForModel.length}</option>
                {runsForModel.map((run) => (
                  <option value={run.id} key={run.id}>{run.label}</option>
                ))}
              </select>
            </label>
            <label className="catalog-filter trial-filter">
              <span>Trial</span>
              <select
                value={trialFilter}
                onChange={(event) => {
                  setTrialFilter(event.target.value);
                  setPage(0);
                  setSelectedTrajectoryId("");
                }}
              >
                <option value="all">All</option>
                {trialOptions.map((trial) => <option value={trial} key={trial}>#{trial}</option>)}
              </select>
            </label>
          </div>
          <div className="search-wrap">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              placeholder="Search task or tool"
              aria-label="Search trajectories"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setPage(0);
                }}
                aria-label="Clear search"
              >×</button>
            ) : null}
          </div>
          <div className="outcome-filter" aria-label="Outcome filter">
            {(["all", "pass", "fail"] as OutcomeFilter[]).map((filter) => (
              <button
                type="button"
                className={outcome === filter ? "active" : ""}
                onClick={() => {
                  setOutcome(filter);
                  setPage(0);
                  setSelectedTrajectoryId("");
                }}
                key={filter}
              >
                {filter[0].toUpperCase() + filter.slice(1)}
              </button>
            ))}
          </div>
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
            {currentIndexState.status === "ready" ? pageTrajectories.map((item) => {
              const itemRun = runsById.get(item.runId);
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
                  <strong>{item.title}</strong>
                  <span>{item.messageCount} turns · {item.toolCallCount} calls · {itemRun?.label ?? "Unknown run"}</span>
                </span>
              </button>
              );
            }) : null}
            {currentIndexState.status === "ready" && !filteredTrajectories.length ? (
              <div className="empty-list">No trajectory matches this filter.</div>
            ) : null}
          </div>
          {currentIndexState.status === "ready" && filteredTrajectories.length ? (
            <div className="catalog-pagination" aria-label="Trajectory pages">
              <button type="button" onClick={() => movePage(-1)} disabled={safePage === 0}>←</button>
              <span>
                {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredTrajectories.length)} of {filteredTrajectories.length.toLocaleString()}
              </span>
              <button type="button" onClick={() => movePage(1)} disabled={safePage >= pageCount - 1}>→</button>
            </div>
          ) : null}
        </section>

        <div className="sidebar-footer">
          <div>
            <span className="status-dot" />
            Pinned official snapshot
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
                <h1>{selectedSummary.title}</h1>
              </div>
              <div className="topbar-actions">
                <button
                  type="button"
                  className="context-trigger"
                  onClick={() => setContextOpen(true)}
                >
                  Context
                </button>
                <div className={`score-badge ${selectedSummary.reward === 1 ? "pass" : "fail"}`}>
                  <span>{selectedSummary.reward === 1 ? "✓" : "×"}</span>
                  {selectedSummary.reward === 1 ? "Passed" : "Failed"}
                  <strong>{selectedSummary.reward.toFixed(1)}</strong>
                </div>
              </div>
            </header>

            <div className="trajectory-toolbar">
              <button type="button" aria-label="Previous trajectory" onClick={() => moveTrajectory(-1)}>←</button>
              <span>{currentIndex + 1} / {filteredTrajectories.length}</span>
              <button type="button" aria-label="Next trajectory" onClick={() => moveTrajectory(1)}>→</button>
              <span className="toolbar-separator" />
              <span>{selectedSummary.messageCount} turns</span>
              <span>{selectedSummary.toolCallCount} tool calls</span>
              {duration ? <span>{duration}</span> : null}
              <span className="toolbar-spacer" />
              {selectedRun ? <a href={selectedRun.sourceUrl} target="_blank" rel="noreferrer">Source ↗</a> : null}
              <button
                type="button"
                className={`metadata-toggle${metadataVisible ? " active" : ""}`}
                onClick={() => setMetadataVisible((visible) => !visible)}
              >
                Metadata
              </button>
            </div>

            {metadataVisible ? (
              <div className="metadata-strip">
                <span><small>Agent</small>{selectedRun?.model ?? "—"}</span>
                <span><small>User simulator</small>{selectedRun?.userModel ?? "—"}</span>
                <span><small>Run</small>{selectedRun?.label ?? "—"}</span>
                <span><small>Termination</small>{selectedSummary.terminationReason.replaceAll("_", " ")}</span>
                <span><small>Trial</small>#{selectedSummary.trial}</span>
                <span><small>Cost</small>{formatCost(selectedSummary.agentCost)}</span>
              </div>
            ) : null}

            {activeDetailStatus === "ready" && trajectory ? (
              <ol className="chat-stream" aria-label="Conversation transcript" key={trajectory.id}>
                {trajectory.messages.map((message, index) => (
                  <TranscriptItem
                    message={message}
                    messageIndex={index}
                    metadataVisible={metadataVisible}
                    key={`${message.turnIndex}-${index}`}
                  />
                ))}
              </ol>
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

      <ContextPanel
        domain={domain}
        trajectory={trajectory}
        tab={contextTab}
        setTab={setContextTab}
        promptVariantId={promptVariantId}
        setPromptVariantId={setPromptVariantId}
        policyMode={policyMode}
        setPolicyMode={setPolicyMode}
        promptMode={promptMode}
        setPromptMode={setPromptMode}
        runtimePromptId={contextRun?.promptRef}
        runPolicy={runPolicySnapshot?.content}
        runPolicyUrl={runPolicySnapshot?.sourceUrl}
        detailStatus={activeDetailStatus}
        detailError={activeDetailError}
        retryDetail={retrySelectedDetail}
        open={contextOpen}
        close={() => setContextOpen(false)}
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
