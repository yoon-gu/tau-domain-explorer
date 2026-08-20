export type BenchmarkId = "tau" | "tau2";
export type MessageRole = "user" | "assistant";
export type ToolRequestor = "assistant" | "user";

export interface ToolInvocation {
  id: string;
  name: string;
  requestor: ToolRequestor;
  arguments: unknown;
  result: unknown;
  error: boolean;
}

export interface TranscriptMessage {
  role: MessageRole;
  content: string | null;
  turnIndex: number;
  timestamp: string | null;
  toolCalls: ToolInvocation[];
}

export interface PromptVariant {
  id: string;
  label: string;
  description: string;
  content: string;
}

export interface PolicySnapshot {
  id: string;
  label: string;
  content: string;
  sourceUrl: string;
}

export interface DomainSource {
  repository: string;
  commit: string;
  license: string;
  /** Legacy fields retained for callers that also consume the old monolithic snapshot. */
  runCommit?: string | null;
  resultsFile?: string;
}

export type RunMode = "historical" | "base" | "default" | "oracle-plan";
export type PolicyVariant = "standard" | "workflow";

export interface RunData {
  id: string;
  label: string;
  model: string;
  userModel: string;
  mode: RunMode;
  environmentId: string;
  policyVariant: PolicyVariant;
  agentImplementation: string;
  userImplementation: string;
  taskCount: number;
  trajectoryCount: number;
  passCount: number;
  failCount: number;
  trials: number[];
  policySnapshotId: string;
  promptRef: string;
  indexPath: string;
  tasksPath: string;
  sourceFile: string;
  sourceUrl: string;
}

export interface DomainData {
  id: string;
  benchmark: BenchmarkId;
  benchmarkLabel: string;
  versionLabel: string;
  slug: string;
  name: string;
  summary: string;
  taskCount: number;
  trajectoryCount: number;
  toolCount: number;
  policy: string;
  policySource: string;
  policyUrl: string;
  userPrompts: PromptVariant[];
  promptSource: string;
  promptUrl: string;
  source: DomainSource;
  runs: RunData[];
  defaultRunId: string;
  policySnapshots: PolicySnapshot[];
}

export interface BenchmarkSource {
  id: BenchmarkId;
  label: string;
  repository: string;
  revision: string;
  license: string;
}

export interface ExcludedDataSummary {
  reason: string;
  runs: number;
  trajectories: number;
}

export interface DatasetTotals {
  runs: number;
  trajectories: number;
  detailBytes: number;
}

/** Small catalog imported with the application shell. */
export interface BenchmarkSnapshot {
  schemaVersion: 2;
  datasetId: string;
  generatedAt: string;
  notice: string;
  excluded: ExcludedDataSummary;
  sources: BenchmarkSource[];
  totals: DatasetTotals;
  domains: DomainData[];
}

export type BenchmarkCatalog = BenchmarkSnapshot;

/** Search/filter metadata loaded one run at a time. */
export interface TrajectorySummary {
  id: string;
  detailPath: string;
  domainId: string;
  runId: string;
  taskId: string;
  trial: number;
  reward: number;
  title: string;
  terminationReason: string;
  duration: number | null;
  agentCost: number | null;
  userCost: number | null;
  messageCount: number;
  toolCallCount: number;
  userToolCallCount: number;
  toolNames: string[];
  scenarioPreview: string;
}

export interface RunIndexAsset {
  schemaVersion: 2;
  datasetId: string;
  runId: string;
  trajectories: TrajectorySummary[];
}

/** Shared task/scenario data, deduplicated across trials and compatible runs. */
export interface TaskAssetEntry {
  taskId: string;
  title: string;
  scenario: Record<string, unknown>;
  task: Record<string, unknown>;
}

export interface TasksAsset {
  schemaVersion: 2;
  datasetId: string;
  tasks: Record<string, TaskAssetEntry>;
}

/** Exact trajectory payload stored in each lazy detail asset. */
export interface TrajectoryDetail {
  id: string;
  runId: string;
  taskId: string;
  trial: number;
  reward: number;
  title: string;
  terminationReason: string;
  duration: number | null;
  agentCost: number | null;
  userCost: number | null;
  evaluation: Record<string, unknown> | null;
  messages: TranscriptMessage[];
}

export interface TrajectoryDetailAsset {
  schemaVersion: 2;
  datasetId: string;
  trajectory: TrajectoryDetail;
}

/**
 * UI-ready trajectory assembled from a detail asset, its run, its shared task,
 * and the selected policy snapshot. This preserves the renderer's prior shape.
 */
export interface Trajectory extends TrajectoryDetail {
  model: string;
  userModel: string;
  policyUsed: string | null;
  scenario: Record<string, unknown>;
  task: Record<string, unknown>;
  sourceUrl: string;
}
