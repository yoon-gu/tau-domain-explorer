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

export interface PromptSourceLink {
  label: string;
  sourcePath: string;
  sourceUrl: string;
}

export interface PromptVariant {
  id: string;
  label: string;
  description: string;
  content: string;
  sourceHash: string;
  /** Primary provenance link: the runtime wrapper that assembles this prompt. */
  sourceUrl: string;
  /** Complete provenance for the wrapper plus injected guideline document. */
  sourceLinks: PromptSourceLink[];
}

export interface RuntimePromptDocument {
  sourceHash: string;
  content: string;
  sourceUrl: string;
}

export interface RuntimePromptCatalog {
  agent: {
    model: string;
    instruction: RuntimePromptDocument;
    systemTemplate: RuntimePromptDocument;
  };
  evaluator: {
    model: string;
    temperature: number;
    invocationCount: number;
    system: RuntimePromptDocument;
    userTemplate: RuntimePromptDocument;
  };
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
  release?: string;
  dataCommit?: string;
  license: string;
  /** Legacy fields retained for callers that also consume the old monolithic snapshot. */
  runCommit?: string | null;
  resultsFile?: string;
}

export type RunMode =
  | "historical"
  | "base"
  | "default"
  | "oracle-plan"
  | "no-user"
  | "no-user-oracle-plan";
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
  /** Total callable tools exposed across both participants. */
  toolCount: number;
  agentToolCount: number;
  userToolCount: number;
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
  contextTranslationPath: string;
}

export interface BenchmarkSource {
  id: BenchmarkId;
  label: string;
  repository: string;
  revision: string;
  runtimeCommit?: string;
  dataCommit?: string;
  license: string;
}

export interface AgentOnlyDataSummary {
  reason: string;
  runs: number;
  trajectories: number;
}

export interface DatasetTotals {
  runs: number;
  tasks: number;
  trajectories: number;
  detailChunks: number;
  detailBytes: number;
}

export interface DatasetSelection {
  benchmark: "tau2";
  model: "GPT-5";
  submission: string;
  release: string;
  runtimeCommit: string;
}

export interface TranslationSurfaceTotals {
  occurrences: number;
  unique: number;
}

export interface ToolLeafTranslationTotals {
  classifierVersion: "tau2-tool-ascii-prose-v1";
  calls: number;
  all: TranslationSurfaceTotals;
  translated: TranslationSurfaceTotals;
  translatedArguments: TranslationSurfaceTotals;
  translatedResults: TranslationSurfaceTotals;
  codeOnly: TranslationSurfaceTotals;
}

export interface TranslationTotals {
  locale: "ko";
  transcriptOverlays: number;
  messageContents: number;
  translatedMessageContents: number;
  controlOnlyContents: number;
  evaluatorPrompts: number;
  contexts: number;
  toolLeaves: ToolLeafTranslationTotals;
}

/** Small catalog imported with the application shell. */
export interface BenchmarkSnapshot {
  schemaVersion: 2;
  datasetId: string;
  generatedAt: string;
  notice: string;
  agentOnly: AgentOnlyDataSummary;
  selection: DatasetSelection;
  sources: BenchmarkSource[];
  totals: DatasetTotals;
  translationTotals: TranslationTotals;
  runtimePrompts: RuntimePromptCatalog;
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

export interface AssetRef {
  path: string;
  sha256: string;
  bytes: number;
  /** Present for a derived asset that is bound to exact canonical source bytes. */
  sourceSha256?: string;
}

export interface RunIndexAsset {
  schemaVersion: 2;
  datasetId: string;
  runId: string;
  trajectories: TrajectorySummary[];
  transcriptOverlays: {
    /** Keys are exact English `TrajectorySummary.detailPath` values. */
    ko: Record<string, AssetRef>;
  };
}

export type TaskLanguage = "en" | "ko";

export interface TaskTranslation {
  title: string;
  descriptionPurpose: string | null;
  scenario: Record<string, string | null>;
  /** Korean display reconstruction of Python `str(task.user_scenario)`. */
  runtimeScenario: string;
}

/** Shared task/scenario data, deduplicated across trials and compatible runs. */
export interface TaskAssetEntry {
  taskId: string;
  title: string;
  scenario: Record<string, unknown>;
  /** Exact Python `str(task.user_scenario)` used in the runtime user prompt. */
  runtimeScenario: string;
  task: Record<string, unknown>;
  translations?: {
    ko?: TaskTranslation;
  };
}

export interface TasksAsset {
  schemaVersion: 2;
  datasetId: string;
  tasks: Record<string, TaskAssetEntry>;
}

export interface EvaluationPromptSnapshot {
  model: string;
  /** Exact English dynamic user prompt sent to the NL-assertions judge. */
  userPrompt: string;
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
  /** Omitted when the runtime did not invoke the NL-assertions evaluator. */
  evaluationPrompt?: EvaluationPromptSnapshot;
  messages: TranscriptMessage[];
}

export interface TrajectoryChunkAsset {
  schemaVersion: 2;
  datasetId: string;
  trajectories: Record<string, TrajectoryDetail>;
}

export interface KoreanTranscriptTrajectory {
  /** Decimal normalized message indices; null/empty/control-only bodies are omitted. */
  messages: Record<string, string>;
  /** RFC 6901 pointers rooted at normalized `/messages/{i}/toolCalls/{j}`. */
  toolLeaves?: Record<string, string>;
  /** Korean display reconstruction of `TrajectoryDetail.evaluationPrompt.userPrompt`. */
  evaluatorUserPrompt?: string;
}

export interface KoreanToolTranslationEntry {
  sourceHash: string;
  content: string;
}

/** Checked-in source-of-truth repacked into per-chunk `toolLeaves` overlays. */
export interface KoreanToolTranslationSource {
  schemaVersion: 1;
  datasetId: string;
  locale: "ko";
  model: "GPT-5";
  classifierVersion: "tau2-tool-ascii-prose-v1";
  entries: Record<string, KoreanToolTranslationEntry>;
}

export interface KoreanTranscriptOverlayAsset {
  schemaVersion: 1;
  datasetId: string;
  locale: "ko";
  model: "GPT-5";
  runId: string;
  sourceDetailPath: string;
  trajectories: Record<string, KoreanTranscriptTrajectory>;
}

export interface ContextTranslationDocument {
  sourceHash: string;
  content: string;
}

export interface ContextTranslationPrompt extends ContextTranslationDocument {
  id: string;
  label: string;
  description: string;
}

export interface KoreanContextTranslationAsset {
  schemaVersion: 1;
  datasetId: string;
  locale: "ko";
  model: "GPT-5";
  domainId: string;
  source: {
    repository: string;
    release: string;
    runtimeCommit: string;
  };
  policy: ContextTranslationDocument;
  policySnapshots: Record<string, ContextTranslationDocument>;
  agent: {
    model: string;
    instruction: ContextTranslationDocument;
    systemTemplate: ContextTranslationDocument;
    resolvedSystemPrompt: ContextTranslationDocument;
  };
  user: {
    model: string;
    prompt: ContextTranslationPrompt;
  };
  evaluator: {
    model: string;
    temperature: number;
    invocationCount: number;
    system: ContextTranslationDocument;
    userTemplate: ContextTranslationDocument;
    assertions: Record<string, string>;
  };
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
  taskTranslation?: TaskTranslation;
  sourceUrl: string;
}
