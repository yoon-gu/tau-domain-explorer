"use client";

import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";
import snapshotJson from "./data/benchmark-snapshot.json";
import type {
  BenchmarkId,
  BenchmarkSnapshot,
  DomainData,
  PromptVariant,
  ToolInvocation,
  Trajectory,
  TranscriptMessage,
} from "./data/types";

const snapshot = snapshotJson as BenchmarkSnapshot;
type OutcomeFilter = "all" | "pass" | "fail";
type ContextTab = "policy" | "prompt" | "task" | "evaluation" | "raw";

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

function countTools(trajectory: Trajectory) {
  return trajectory.messages.reduce(
    (count, message) => count + message.toolCalls.length,
    0,
  );
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
  open: boolean;
  close: () => void;
}) {
  const prompt =
    domain.userPrompts.find((variant) => variant.id === promptVariantId) ??
    domain.userPrompts[0];
  const policy = policyMode === "run" && trajectory?.policyUsed
    ? trajectory.policyUsed
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
                  disabled={!trajectory?.policyUsed}
                >
                  Run snapshot
                </button>
              </div>
              <CopyButton text={policy} />
            </div>
            <div className="source-line">
              <span>{policyMode === "run" ? "Policy captured in trajectory" : domain.policySource}</span>
              <a href={domain.policyUrl} target="_blank" rel="noreferrer">Source ↗</a>
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
            <pre className="prompt-pre">{promptText}</pre>
          </div>
        ) : null}

        {tab === "task" ? <TaskPanel domain={domain} trajectory={trajectory} /> : null}
        {tab === "evaluation" ? <EvaluationPanel trajectory={trajectory} /> : null}
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
          ) : <EmptyContext label="Choose a trajectory to inspect its normalized JSON." />
        ) : null}
      </div>
    </aside>
  );
}

export default function Explorer() {
  const [benchmark, setBenchmark] = useState<BenchmarkId>("tau2");
  const [domainSlug, setDomainSlug] = useState("telecom");
  const [selectedTrajectoryId, setSelectedTrajectoryId] = useState("");
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [contextTab, setContextTab] = useState<ContextTab>("policy");
  const [promptVariantId, setPromptVariantId] = useState("");
  const [policyMode, setPolicyMode] = useState<"domain" | "run">("domain");
  const [promptMode, setPromptMode] = useState<"resolved" | "template">("resolved");
  const [metadataVisible, setMetadataVisible] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  const domains = useMemo(
    () => snapshot.domains.filter((domain) => domain.benchmark === benchmark),
    [benchmark],
  );
  const domain = domains.find((candidate) => candidate.slug === domainSlug) ?? domains[0];
  const filteredTrajectories = domain.trajectories.filter((trajectory) => {
    const haystack = `${trajectory.taskId} ${trajectory.title} ${trajectory.messages
      .map((message) => `${message.content ?? ""} ${message.toolCalls.map((call) => call.name).join(" ")}`)
      .join(" ")}`.toLowerCase();
    const matchesQuery = haystack.includes(query.trim().toLowerCase());
    const matchesOutcome =
      outcome === "all" ||
      (outcome === "pass" && trajectory.reward === 1) ||
      (outcome === "fail" && trajectory.reward !== 1);
    return matchesQuery && matchesOutcome;
  });
  const trajectory =
    filteredTrajectories.find((candidate) => candidate.id === selectedTrajectoryId) ??
    filteredTrajectories[0];
  const currentIndex = trajectory
    ? filteredTrajectories.findIndex((candidate) => candidate.id === trajectory.id)
    : -1;
  const duration = trajectory ? formatDuration(trajectory.duration) : null;

  function changeBenchmark(nextBenchmark: BenchmarkId) {
    const nextDomains = snapshot.domains.filter((item) => item.benchmark === nextBenchmark);
    setBenchmark(nextBenchmark);
    if (!nextDomains.some((item) => item.slug === domainSlug)) {
      setDomainSlug(nextDomains[0].slug);
    }
    setSelectedTrajectoryId("");
    setPromptVariantId("");
    setPolicyMode("domain");
  }

  function changeDomain(slug: string) {
    setDomainSlug(slug);
    setSelectedTrajectoryId("");
    setPromptVariantId("");
    setPolicyMode("domain");
  }

  function moveTrajectory(offset: number) {
    if (!filteredTrajectories.length || currentIndex < 0) return;
    const next = (currentIndex + offset + filteredTrajectories.length) % filteredTrajectories.length;
    setSelectedTrajectoryId(filteredTrajectories[next].id);
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
          <label>
            <span>Trajectory</span>
            <select
              value={trajectory?.id ?? ""}
              onChange={(event) => setSelectedTrajectoryId(event.target.value)}
            >
              {domain.trajectories.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.reward === 1 ? "Pass" : "Fail"} · {compactTaskId(item.taskId)}
                </option>
              ))}
            </select>
          </label>
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

        <section className="trajectory-browser" aria-label="Trajectory browser">
          <div className="section-heading">
            <p className="eyebrow">Trajectories</p>
            <span>{domain.trajectories.length} / {domain.trajectoryCount}</span>
          </div>
          <div className="search-wrap">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search task or tool"
              aria-label="Search trajectories"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button>
            ) : null}
          </div>
          <div className="outcome-filter" aria-label="Outcome filter">
            {(["all", "pass", "fail"] as OutcomeFilter[]).map((filter) => (
              <button
                type="button"
                className={outcome === filter ? "active" : ""}
                onClick={() => setOutcome(filter)}
                key={filter}
              >
                {filter[0].toUpperCase() + filter.slice(1)}
              </button>
            ))}
          </div>
          <div className="trajectory-list">
            {filteredTrajectories.map((item) => (
              <button
                type="button"
                className={`trajectory-item${item.id === trajectory?.id ? " active" : ""}`}
                onClick={() => setSelectedTrajectoryId(item.id)}
                key={item.id}
              >
                <span className={`mini-outcome ${item.reward === 1 ? "pass" : "fail"}`}>
                  {item.reward === 1 ? "✓" : "×"}
                </span>
                <span className="trajectory-item-copy">
                  <span className="trajectory-id">Task {compactTaskId(item.taskId)} · T{item.trial}</span>
                  <strong>{item.title}</strong>
                  <span>{item.messages.length} turns · {countTools(item)} calls</span>
                </span>
              </button>
            ))}
            {!filteredTrajectories.length ? (
              <div className="empty-list">No trajectory matches this filter.</div>
            ) : null}
          </div>
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
        {trajectory ? (
          <>
            <header className="topbar">
              <div className="title-block">
                <p className="breadcrumb">
                  {domain.benchmarkLabel} / {domain.slug} / task {compactTaskId(trajectory.taskId)}
                </p>
                <h1>{trajectory.title}</h1>
              </div>
              <div className="topbar-actions">
                <button
                  type="button"
                  className="context-trigger"
                  onClick={() => setContextOpen(true)}
                >
                  Context
                </button>
                <div className={`score-badge ${trajectory.reward === 1 ? "pass" : "fail"}`}>
                  <span>{trajectory.reward === 1 ? "✓" : "×"}</span>
                  {trajectory.reward === 1 ? "Passed" : "Failed"}
                  <strong>{trajectory.reward.toFixed(1)}</strong>
                </div>
              </div>
            </header>

            <div className="trajectory-toolbar">
              <button type="button" aria-label="Previous trajectory" onClick={() => moveTrajectory(-1)}>←</button>
              <span>{currentIndex + 1} / {filteredTrajectories.length}</span>
              <button type="button" aria-label="Next trajectory" onClick={() => moveTrajectory(1)}>→</button>
              <span className="toolbar-separator" />
              <span>{trajectory.messages.length} turns</span>
              <span>{countTools(trajectory)} tool calls</span>
              {duration ? <span>{duration}</span> : null}
              <span className="toolbar-spacer" />
              <a href={trajectory.sourceUrl} target="_blank" rel="noreferrer">Source ↗</a>
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
                <span><small>Agent</small>{trajectory.model}</span>
                <span><small>User simulator</small>{trajectory.userModel}</span>
                <span><small>Termination</small>{trajectory.terminationReason.replaceAll("_", " ")}</span>
                <span><small>Trial</small>#{trajectory.trial}</span>
                <span><small>Cost</small>{formatCost(trajectory.agentCost)}</span>
              </div>
            ) : null}

            <ol className="chat-stream" aria-label="Conversation transcript">
              {trajectory.messages.map((message, index) => (
                <TranscriptItem
                  message={message}
                  messageIndex={index}
                  metadataVisible={metadataVisible}
                  key={`${message.turnIndex}-${index}`}
                />
              ))}
            </ol>
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
    </main>
  );
}
