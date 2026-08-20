export type BenchmarkId = "tau" | "tau2";
export type MessageRole = "user" | "assistant";

export interface ToolInvocation {
  id: string;
  name: string;
  requestor: "assistant" | "user";
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

export interface Trajectory {
  id: string;
  taskId: string;
  trial: number;
  reward: number;
  title: string;
  model: string;
  userModel: string;
  terminationReason: string;
  duration: number | null;
  agentCost: number | null;
  userCost: number | null;
  policyUsed: string | null;
  scenario: Record<string, unknown>;
  task: Record<string, unknown>;
  evaluation: Record<string, unknown> | null;
  messages: TranscriptMessage[];
  sourceUrl: string;
}

export interface DomainSource {
  repository: string;
  commit: string;
  runCommit?: string | null;
  license: string;
  resultsFile: string;
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
  trajectories: Trajectory[];
}

export interface BenchmarkSnapshot {
  generatedAt: string;
  notice: string;
  sources: Array<{
    id: BenchmarkId;
    label: string;
    repository: string;
    revision: string;
    license: string;
  }>;
  domains: DomainData[];
}
