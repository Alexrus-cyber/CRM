export type SubagentRoutingMode = "linear" | "layered";
export type OverseerMode = "strict" | "rules_only";
export type SubagentToolProfile = "full" | "restricted";

export type OverseerConfig = {
  enabled: boolean;
  mode: OverseerMode;
  systemPrompt: string;
  unlockApi: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string;
};

export type OverseerVerdictMeta = {
  checkId?: string;
  verdict?: "allow" | "require_human" | "block" | "approved_by_human";
  riskLevel?: "low" | "medium" | "high" | "critical" | string;
  category?: string;
  title?: string;
  reason?: string;
  recommendation?: string;
  requestedBy?: string;
  requestedByKind?: string;
  tool?: string;
  targetPreview?: string;
  model?: string;
  reasoning?: string;
  trustBypassBlocked?: boolean;
};

export type AgentLiveActorKind =
  | "orchestrator"
  | "subagent"
  | "overseer"
  | "browser_inspector"
  | "approval";

export type Subagent = {
  id: number;
  userId: number;
  slug: string;
  name: string;
  roleTitle: string;
  description: string;
  systemPrompt: string;
  color: string;
  isActive: boolean;
  parentSubagentId: number | null;
  orchestratorCanCall: boolean;
  allowedCallees: string[];
  toolProfile?: SubagentToolProfile;
  posX?: number | null;
  posY?: number | null;
  unlockApi: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  reasoningMode: string;
  runsCount: number;
  conversationsCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SubagentRun = {
  id: number;
  subagentId: number;
  subagentSlug?: string;
  subagentName?: string;
  subagentColor?: string;
  agentConversationId: number | null;
  subagentConversationId: number;
  callerKind: "orchestrator" | "subagent" | "user";
  callerSubagentId: number | null;
  callerSubagentName?: string;
  sandboxProject: string;
  inputSummary: string;
  outputSummary: string;
  /**
   * `rotated` — автоперенос контекста в новый чат (НЕ передача задачи другому субагенту),
   * `cancelled` — запуск остановлен пользователем.
   */
  status: "running" | "completed" | "handoff" | "rotated" | "cancelled" | "blocked" | "error";
  requestedCalleeSlug: string;
  requestedCalleeTask: string;
  actionsCount: number;
  filesTouched: string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  usedCustomApi: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SubagentConversation = {
  id: number;
  kind: "subagent";
  subagentId?: number;
  title: string;
  messagesCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SubagentMessageAttachment = {
  name: string;
  size?: number;
  mime?: string;
  note?: string;
  sandboxPath?: string;
  image?: string;
};

export type SubagentMessageAction = {
  type?: string;
  [key: string]: unknown;
};

export type SubagentMessage = {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  attachments: Array<string | SubagentMessageAttachment>;
  actions: Array<string | SubagentMessageAction>;
  files: string[];
  error: string;
  createdAt: string;
};

export type SubagentLimits = {
  maxStored: number;
  maxActive: number;
  totalCount: number;
  activeCount: number;
};

export type TreeNodeDraft = {
  isActive: boolean;
  parentSubagentId: number | null;
  orchestratorCanCall: boolean;
  allowedCalleesText: string;
  posX?: number | null;
  posY?: number | null;
};

export function parseCalleesList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function formatTokensCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(".", ",")} млн`;
  if (n >= 10_000) return `${Math.round(n / 1000)} тыс.`;
  return n.toLocaleString("ru-RU");
}
