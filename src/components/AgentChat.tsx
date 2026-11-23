"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import {
  Archive,
  Bot,
  Camera,
  Check,
  Compass,
  Download,
  ExternalLink,
  FileArchive,
  FileText,
  FlaskConical,
  FolderOpen,
  FolderOutput,
  Gamepad2,
  Gauge,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  History,
  Loader2,
  MessageSquarePlus,
  MonitorCog,
  Paperclip,
  PlayCircle,
  PlugZap,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { AI_DEFAULT_BASE_URL, AI_MAX_FILE_BYTES, formatBytes, type AiSettings } from "@/lib/ai";
import { Input, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useStoredJson, useStoredNumber } from "@/lib/useStoredValue";
import { useAiSettings } from "@/lib/useAiSettings";
import { extractFile } from "@/lib/fileExtract";
import { splitIntoChunks } from "@/lib/rag";
import { GenSettings } from "./GenSettings";
import { LiveReasoningBox } from "./LiveReasoningBox";
import { TrustSelector } from "./TrustSelector";
import { extractClipboardFiles, hasTransferFiles } from "@/lib/clipboardFiles";
import {
  GEN_DEFAULT_PARAMS,
  decodeGenParams,
  type GenParams,
} from "@/lib/genParams";
import { pickCapabilitiesForModel, type ModelCapabilities } from "@/lib/modelCapabilities";
import { DEFAULT_TRUST_LEVEL, decodeTrustLevel, findTrustLevel, type TrustLevel } from "@/lib/trust";
import {
  OPERATOR_TASK_MODES,
  findTaskMode,
  normalizeTaskMode,
  type OperatorTaskMode,
} from "@/lib/operatorModes";
import {
  DEFAULT_AGENT_CONTEXT_LIMIT,
  ROLLOVER_THRESHOLD_RATIO,
  buildTranscriptFileName,
  estimateAgentConversationTokens,
  formatTranscriptMarkdown,
  shouldAutoRollover,
  type TranscriptTurn,
} from "@/lib/transcripts";
import { formatFileSize, readOperatorFiles, type OperatorAttachment } from "./operator/files";
import {
  StatusChip,
  parsePendingApproval,
  type OperatorEvent,
  type OperatorTask,
} from "./operator/shared";
import { ApprovalToast } from "./ApprovalToast";
import { GithubIcon, GithubIntegrationPanel, type GithubAccountPublic } from "./agent/GithubIntegrationPanel";
import {
  TesterPanel,
  formatLiveTesterAction,
  type LiveTesterState,
  type TesterChatMessage,
  type TesterConversationItem,
  type TesterIssueItem,
  type TesterRunItem,
} from "./agent/TesterPanel";

/**
 * Вкладка «Агент» блока ИИ (только главный администратор).
 *
 * Поддерживает:
 *  - 3 уровня доверия ИИ (full / verified / none);
 *  - изолированную песочницу Sandbox + экспорт проектов наружу с подтверждением;
 *  - неограниченный клиентский RAG из папок и режим «Вся база»;
 *  - контроль контекста модели, автогенерацию Summary при приближении к лимиту
 *    и архивацию полной переписки в `.md` файл для повторной обработки.
 */

type AgentFile = { name: string; mime: string; size: number; data: string };
type AgentAction = {
  type:
    | "open_url"
    | "command_result"
    | "sandbox_file"
    | "sandbox_update"
    | "project_created"
    | "sandbox_export"
    | "operator_plan"
    | "operator_task"
    | "operator_screen"
    | "browser_inspect"
    | "github_edit"
    | "github_commit"
    | "github_pr"
    | "github_merge"
    | "tester_report"
    | "tester_minor_decision"
    | "qa_check";
  action?: string;
  kind?: string;
  url?: string;
  previewUrl?: string;
  port?: number | null;
  background?: boolean;
  title?: string;
  viewport?: string;
  label?: string;
  autoplay?: boolean;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  output?: string;
  path?: string;
  project?: string;
  source?: string;
  destination?: string;
  mode?: string;
  filesCount?: number;
  taskId?: number;
  task?: string;
  goal?: string;
  maxSteps?: number;
  coachMode?: string;
  notes?: string;
  operatorTrustLevel?: string;
  summary?: string;
  hasImage?: boolean;
  issuesCount?: number;
  animationsCount?: number;
  errorsCount?: number;
  error?: string;
  trace?: string[];
  preview?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  sha?: string;
  number?: number;
  method?: string;
  pushed?: boolean;
  authorLogin?: string;
  message?: string;
  head?: string;
  base?: string;
  bytes?: number;
  runKey?: string;
  runId?: number;
  testerConversationId?: number;
  sandboxProject?: string;
  status?: string;
  reportSummary?: string;
  criticalCount?: number;
  minorCount?: number;
  minorDecision?: string;
  totalTokens?: number;
  approved?: boolean;
};

type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions: AgentAction[];
  files: AgentFile[];
  attached?: Array<{ name: string; size: number }>;
  reasoning?: string;
  error?: string;
};

type AgentConversation = {
  id: number;
  kind: "agent";
  title: string;
  operatorTaskId?: number | null;
  messagesCount: number;
  updatedAt: string;
};

type StoredTurn = {
  id: number;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  error?: string;
  attachments?: Array<{ name?: string; size?: number }>;
  actions?: AgentAction[];
  files?: Array<{ name?: string; mime?: string; size?: number }>;
};

type Health = {
  available: boolean;
  endpoint?: string;
  hint?: string;
  model?: string | null;
  sandbox?: string;
  tools?: string[];
};

type RagFolder = {
  id: number;
  name: string;
  filesCount: number;
  chunksCount: number;
  chars: number;
  updatedAt: string;
};

type RagPrefs = {
  folderId: number;
  ragFull: boolean;
  ragChunks: number;
};

type PendingApproval = {
  approvalId: string;
  kind: string;
  title: string;
  description: string;
  command?: string;
  cwd?: string;
  url?: string;
  source?: string;
  destination?: string;
  mode?: string;
  filesCount?: number;
  task?: string;
  maxSteps?: number;
  coachAfterEachStep?: boolean;
  operatorTrustLevel?: string;
  sandboxProject?: string;
  testerRunKey?: string;
  testerRunId?: number;
  testerConversationId?: number;
  minorIssues?: TesterIssueItem[];
  github?: {
    login?: string;
    authorName?: string;
    authorEmail?: string;
    owner?: string;
    repo?: string;
    branch?: string;
    message?: string;
    push?: boolean;
    files?: string[];
    diffPreview?: string;
    head?: string;
    base?: string;
    prTitle?: string;
    prBody?: string;
    draft?: boolean;
    pullNumber?: number;
    mergeMethod?: string;
    mergeableState?: string;
    url?: string;
  };
};

type SandboxProject = { name: string; files?: number; hasIndex?: boolean };

type SandboxState = {
  available: boolean;
  root?: string;
  projects: SandboxProject[];
  items: Array<{ path: string; isDir: boolean; size: number }>;
  processes: Array<{
    pid: number;
    command: string;
    cwd: string;
    url?: string;
    port?: number | null;
    alive: boolean;
  }>;
};

function isLocalOrLanUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return false;
    if (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".lan") ||
      host === "host.docker.internal"
    ) {
      return true;
    }
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const m172 = host.match(/^172\.(\d+)\./);
    if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
    if (/^(fc|fd)[0-9a-f]{2}:/i.test(host)) return true;
    return !host.includes(".");
  } catch {
    return false;
  }
}

function extractPortFromLocalUrl(raw?: string): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d{1,5})(?:[/?#]|$)/i);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function toSandboxProxyUrl(rawUrl?: string, explicitPort?: number | null): string | null {
  if (rawUrl && rawUrl.startsWith("/api/ai/agent/sandbox/")) return rawUrl;
  const port = explicitPort ?? extractPortFromLocalUrl(rawUrl);
  if (!port) return null;
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      const tail = u.pathname === "/" ? "" : u.pathname;
      return `/api/ai/agent/sandbox/proxy/${port}${tail}${u.search}${u.hash}`;
    } catch {
      /* fallback below */
    }
  }
  return `/api/ai/agent/sandbox/proxy/${port}`;
}

function normalizeSandboxState(raw: unknown): SandboxState {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawProjects = Array.isArray(src.projects) ? src.projects : [];
  const projects: SandboxProject[] = rawProjects
    .map((entry): SandboxProject | null => {
      if (typeof entry === "string") {
        const name = entry.trim();
        return name ? { name } : null;
      }
      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const name = String(obj.name ?? obj.project ?? obj.path ?? "").trim();
        if (!name) return null;
        const files = typeof obj.files === "number" && Number.isFinite(obj.files) ? obj.files : undefined;
        const hasIndex = typeof obj.hasIndex === "boolean" ? obj.hasIndex : undefined;
        return {
          name,
          ...(files !== undefined ? { files } : {}),
          ...(hasIndex !== undefined ? { hasIndex } : {}),
        };
      }
      return null;
    })
    .filter((p): p is SandboxProject => p !== null);

  const rawItems = Array.isArray(src.items) ? src.items : [];
  const items = rawItems
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((obj) => ({
      path: String(obj.path ?? ""),
      isDir: typeof obj.isDir === "boolean" ? obj.isDir : String(obj.type ?? "") === "dir",
      size: Number(obj.size ?? 0) || 0,
    }))
    .filter((it) => it.path.length > 0);

  const rawProcs = Array.isArray(src.processes) ? src.processes : [];
  const processes = rawProcs
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((obj) => {
      const url = obj.url ? String(obj.url) : undefined;
      const port =
        typeof obj.port === "number" && Number.isFinite(obj.port)
          ? obj.port
          : extractPortFromLocalUrl(url);
      return {
        pid: Number(obj.pid ?? 0) || 0,
        command: String(obj.command ?? ""),
        cwd: String(obj.cwd ?? "."),
        url,
        port,
        alive: obj.alive === undefined ? true : Boolean(obj.alive),
      };
    })
    .filter((p) => p.pid > 0);

  return {
    available: Boolean(src.available),
    root: src.root ? String(src.root) : undefined,
    projects,
    items,
    processes,
  };
}

type TranscriptMeta = {
  id: number;
  conversationId: number;
  title: string;
  summary: string;
  fileName: string;
  chars: number;
  createdAt: string;
};

function decodeStoredTurn(message: StoredTurn): Turn {
  return {
    id: `m${message.id}`,
    role: message.role === "assistant" ? "assistant" : "user",
    content: String(message.content ?? ""),
    reasoning: String(message.reasoning ?? ""),
    error: String(message.error ?? "") || undefined,
    actions: Array.isArray(message.actions) ? message.actions : [],
    files: Array.isArray(message.files)
      ? message.files.map((file) => ({
          name: String(file.name ?? "файл"),
          mime: String(file.mime ?? "application/octet-stream"),
          size: Number(file.size ?? 0),
          data: "",
        }))
      : [],
    attached: Array.isArray(message.attachments)
      ? message.attachments.map((file) => ({ name: String(file.name ?? "файл"), size: Number(file.size ?? 0) }))
      : [],
  };
}

/** Пресеты OpenAI-совместимых API: локальная модель или облако по ключу. */
const PROVIDERS: Array<{ id: string; label: string; baseUrl: string; model: string }> = [
  { id: "local", label: "Локальная (vLLM / llama.cpp / LM Studio)", baseUrl: "http://127.0.0.1:8888/v1", model: "" },
  { id: "openai", label: "OpenAI API", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen2.5-vl-72b-instruct" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", model: "Qwen/Qwen2.5-72B-Instruct-Turbo" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest" },
  { id: "custom", label: "Свой адрес…", baseUrl: "", model: "" },
];

const EXAMPLES = [
  "Открой YouTube и включи видео про космос",
  "Создай в Sandbox проект landing-site на HTML+CSS",
  "Зайди на мой проект http://127.0.0.1:3000 интерактивно: проверь анимации, клики, мобильную вёрстку и ошибки",
  "Помоги с действиями на экране: сформулируй задачу для Оператора и запусти его с моего согласия",
  "Сделай CSV-файл с планом на неделю по продажам",
];

const DEFAULT_RAG_PREFS: RagPrefs = { folderId: 0, ragFull: false, ragChunks: 12 };

type AgentLayoutMode = "tabs" | "classic";
type AgentTabId = "model" | "knowledge" | "workspace" | "tester" | "chat";

const AGENT_TABS: Array<{ id: AgentTabId; label: string; hint: string }> = [
  { id: "model", label: "Модель и генерация", hint: "Подключение, выбор модели, возможности, раздумья и системный промпт" },
  { id: "knowledge", label: "Доверие и RAG", hint: "Уровень доверия ИИ, RAG-база знаний, контекст и архив переписок" },
  { id: "workspace", label: "Sandbox и Оператор", hint: "Изолированная папка Sandbox, экспорт на ПК и совместная работа с Оператором" },
  { id: "tester", label: "Тестировщик", hint: "Независимый QA-тестировщик в отдельном чате с теми же настройками модели" },
  { id: "chat", label: "Чат", hint: "История переписок, диалог с Агентом, вложения и запуск" },
];

function decodeLayoutMode(raw: string): AgentLayoutMode {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === "classic" ? "classic" : "tabs";
  } catch {
    return raw === "classic" ? "classic" : "tabs";
  }
}

function decodeSystemPrompt(raw: string, unlimited = false): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "string") return "";
    return unlimited ? parsed : parsed.slice(0, 12_000);
  } catch {
    const str = String(raw ?? "");
    return unlimited ? str : str.slice(0, 12_000);
  }
}

function decodeAgentSteps(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function decodeRagPrefs(raw: string, unlimited = false): RagPrefs {
  try {
    const parsed = JSON.parse(raw) as Partial<RagPrefs>;
    const chunks = Math.max(0, Math.floor(Number(parsed.ragChunks ?? 12)));
    return {
      folderId: Math.max(0, Math.floor(Number(parsed.folderId) || 0)),
      ragFull: Boolean(parsed.ragFull),
      ragChunks: unlimited ? chunks : Math.min(500, chunks),
    };
  } catch {
    return DEFAULT_RAG_PREFS;
  }
}

function turnsToTranscript(turns: Turn[]): TranscriptTurn[] {
  return turns.map((t) => ({
    role: t.role,
    content: t.content,
    reasoning: t.reasoning,
    error: t.error,
    attached: t.attached,
    files: t.files.map((f) => ({ name: f.name, mime: f.mime, size: f.size })),
    actions: t.actions.map((a) => ({
      type: a.type,
      label: a.label || a.command || a.path || a.project || a.source,
      url: a.url,
    })),
  }));
}

export function AgentChat({ userName, unlimited = true }: { userName: string; unlimited?: boolean }) {
  const [layoutMode, setLayoutMode] = useStoredJson<AgentLayoutMode>(
    "crm.ai.agent.layout.v1",
    "tabs",
    decodeLayoutMode,
  );
  const [activeTab, setActiveTab] = useState<AgentTabId>("chat");
  const {
    settings,
    serverMeta,
    setSettings,
    persistSettings,
    clearSavedKey,
  } = useAiSettings();
  const [params, setParams] = useStoredJson<GenParams>(
    "crm.ai.agent.params.v1",
    GEN_DEFAULT_PARAMS,
    (raw) => decodeGenParams(raw, { unlimited }),
  );
  const [trustLevel, setTrustLevel] = useStoredJson<TrustLevel>(
    "crm.ai.agent.trust.v1",
    DEFAULT_TRUST_LEVEL,
    decodeTrustLevel,
  );
  const [ragPrefs, setRagPrefs] = useStoredJson<RagPrefs>(
    "crm.ai.agent.rag.v1",
    DEFAULT_RAG_PREFS,
    (raw) => decodeRagPrefs(raw, unlimited),
  );
  const [maxSteps, setMaxSteps] = useStoredJson<number>(
    "crm.ai.agent.steps.v1",
    0,
    decodeAgentSteps,
  );
  const [contextLimit, setContextLimit] = useStoredNumber(
    "crm.ai.agent.context_limit.v1",
    DEFAULT_AGENT_CONTEXT_LIMIT,
  );
  const [systemPrompt, setSystemPrompt] = useStoredJson<string>(
    "crm.ai.agent.system.v1",
    "",
    (raw) => decodeSystemPrompt(raw, unlimited),
  );
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [capabilitiesByModel, setCapabilitiesByModel] = useState<Record<string, ModelCapabilities>>({});
  const [checkingModels, setCheckingModels] = useState(false);

  const [health, setHealth] = useState<Health | null>(null);
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<OperatorAttachment[]>([]);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Подтверждение команд/экспорта/вызова Оператора при уровне доверия verified или call_operator.
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalDest, setApprovalDest] = useState("");
  const [approvalTaskDraft, setApprovalTaskDraft] = useState("");
  const [approvalTaskMode, setApprovalTaskMode] = useState<OperatorTaskMode>("copilot");
  const [approvalCoachAfter, setApprovalCoachAfter] = useState(true);
  const [approvalOpTrust, setApprovalOpTrust] = useState<"verified" | "full">("verified");
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [screenCapture, setScreenCapture] = useState<{
    approvalId: string;
    taskId: number;
    status: string;
    error?: string;
  } | null>(null);
  const [browserCaptureBusy, setBrowserCaptureBusy] = useState(false);

  // Совместная работа Агента и Оператора (помощь на экране / игры / пошаговое сопровождение).
  const [opBridgeOpen, setOpBridgeOpen] = useState(false);
  const [opGoal, setOpGoal] = useState("");
  const [opDraftPrompt, setOpDraftPrompt] = useState("");
  const [opDraftMode, setOpDraftMode] = useState<OperatorTaskMode>("copilot");
  const [opDraftSteps, setOpDraftSteps] = useState(30);
  const [opDraftNotes, setOpDraftNotes] = useState("");
  const [opFormulating, setOpFormulating] = useState(false);
  const [opLaunching, setOpLaunching] = useState(false);
  const [opTask, setOpTask] = useState<OperatorTask | null>(null);
  const [opEvents, setOpEvents] = useState<OperatorEvent[]>([]);
  const [opGuidanceInput, setOpGuidanceInput] = useState("");
  const [opCoachBusy, setOpCoachBusy] = useState(false);
  const [opConversationId, setOpConversationId] = useState<number | null>(null);
  const [opBotStatus, setOpBotStatus] = useState<{ state: string; connected: boolean } | null>(null);
  const [recentOpTasks, setRecentOpTasks] = useState<OperatorTask[]>([]);

  // RAG папки и загрузка без ограничений размера папки.
  const [ragFolders, setRagFolders] = useState<RagFolder[]>([]);
  const [ragBusy, setRagBusy] = useState(false);
  const [ragProgress, setRagProgress] = useState<{ done: number; total: number; phase: "read" | "upload" } | null>(null);
  const [ragOpen, setRagOpen] = useState(false);

  // Персональное подключение GitHub (GitHub-RAG, правки кода, Commit / PR / Merge от своего лица).
  const [ghAccount, setGhAccount] = useState<GithubAccountPublic | null>(null);
  const [ghOauthAvailable, setGhOauthAvailable] = useState(false);
  const [approvalGhCommitMsg, setApprovalGhCommitMsg] = useState("");
  const [approvalGhBranch, setApprovalGhBranch] = useState("");
  const [approvalGhPrTitle, setApprovalGhPrTitle] = useState("");
  const [approvalGhPrBody, setApprovalGhPrBody] = useState("");
  const [approvalGhMergeMethod, setApprovalGhMergeMethod] = useState<"merge" | "squash" | "rebase">("merge");

  // Песочница Sandbox и экспорт на ПК.
  const [sandbox, setSandbox] = useState<SandboxState | null>(null);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [sandboxPreview, setSandboxPreview] = useState<{ title: string; url: string } | null>(null);
  const [exportSource, setExportSource] = useState(".");
  const [exportDest, setExportDest] = useState("");
  const [exportMode, setExportMode] = useState<"copy" | "move">("copy");
  const [sandboxBusy, setSandboxBusy] = useState(false);

  // Summary и архив переписок (.md).
  const [transcripts, setTranscripts] = useState<TranscriptMeta[]>([]);
  const [transcriptsOpen, setTranscriptsOpen] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  // Под-агент Тестировщик (QA): отдельные чаты, отчёты в БД, живой поток и мелкие правки по согласию человека.
  const [testerRuns, setTesterRuns] = useState<TesterRunItem[]>([]);
  const [testerConversations, setTesterConversations] = useState<TesterConversationItem[]>([]);
  const [selectedTesterConvId, setSelectedTesterConvId] = useState<number | null>(null);
  const [selectedTesterMessages, setSelectedTesterMessages] = useState<TesterChatMessage[]>([]);
  const [testerLoading, setTesterLoading] = useState(false);
  const [testerDirectRunning, setTesterDirectRunning] = useState(false);
  const [testerDirectPrompt, setTesterDirectPrompt] = useState("");
  const [testerDirectProject, setTesterDirectProject] = useState(".");
  const [liveTester, setLiveTester] = useState<LiveTesterState | null>(null);
  const [liveBrowserLog, setLiveBrowserLog] = useState<string[]>([]);
  const [testerError, setTesterError] = useState<string | null>(null);
  const [testerDecisionBusy, setTesterDecisionBusy] = useState<number | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const autoScrollPausedRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ragDirRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const browserRunStartRef = useRef<number>(0);
  const pushLiveBrowserLog = useCallback((textValue: string, reset = false): string => {
    const clean = textValue.trim();
    if (reset || browserRunStartRef.current === 0) {
      browserRunStartRef.current = Date.now();
    }
    const elapsedSec = ((Date.now() - browserRunStartRef.current) / 1000).toFixed(1);
    const entry = `[+${elapsedSec}s] ${clean}`;
    setLiveBrowserLog((prev) => {
      const base = reset ? [] : prev;
      if (clean && base[base.length - 1] === entry) return base;
      const next = clean ? [...base, entry] : base;
      return next.length > 60 ? next.slice(-60) : next;
    });
    return entry;
  }, []);
  const clearLiveBrowserLog = useCallback(() => {
    browserRunStartRef.current = 0;
    setLiveBrowserLog([]);
  }, []);
  const conversationIdRef = useRef<number | null>(null);
  const selectedTesterConvIdRef = useRef<number | null>(null);
  const opTaskRef = useRef<OperatorTask | null>(null);
  const dismissedOpTaskIdsRef = useRef<Set<number>>(new Set());
  const runningRef = useRef(false);
  const chatAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    selectedTesterConvIdRef.current = selectedTesterConvId;
  }, [selectedTesterConvId]);
  useEffect(() => {
    opTaskRef.current = opTask;
  }, [opTask]);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  const nextId = () => {
    counter.current += 1;
    return `t${counter.current}`;
  };

  const saveSettings = (next: AiSettings) => {
    setSettings(next);
  };

  const refreshModelsAndCapabilities = useCallback(async () => {
    if (checkingModels) return;
    setCheckingModels(true);
    try {
      await persistSettings();
      const targetModel = settings.model.trim();
      const res = await fetch("/api/ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: settings.baseUrl,
          ...(settings.apiKey.trim() ? { apiKey: settings.apiKey.trim() } : {}),
          ...(targetModel ? { model: targetModel } : {}),
        }),
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as {
        models?: string[];
        capabilitiesByModel?: Record<string, ModelCapabilities>;
        selectedCapabilities?: ModelCapabilities;
      };
      if (Array.isArray(data.models)) {
        setAvailableModels(data.models);
        if (!settings.model.trim() && data.models.length > 0) {
          setSettings({ ...settings, model: data.models[0] });
        }
      }
      if (data.capabilitiesByModel || data.selectedCapabilities) {
        setCapabilitiesByModel((prev) => ({
          ...prev,
          ...(data.capabilitiesByModel ?? {}),
          ...(data.selectedCapabilities && (targetModel || data.models?.[0])
            ? { [targetModel || data.models![0]]: data.selectedCapabilities }
            : {}),
        }));
      }
    } catch {
      /* сервер модели может быть недоступен локально */
    } finally {
      setCheckingModels(false);
    }
  }, [checkingModels, persistSettings, setSettings, settings]);

  const loadHealth = useCallback(async (): Promise<Health> => {
    try {
      const res = await fetch("/api/ai/agent", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const hint =
          res.status === 401
            ? "Сессия CRM недействительна или истекла — обновите страницу и войдите в CRM заново."
            : res.status === 403
              ? String(data.error || "Доступ к Агенту не выдан главным администратором.")
              : String(data.error || data.hint || `Ошибка проверки агента (HTTP ${res.status})`);
        return {
          available: false,
          endpoint: data.endpoint ? String(data.endpoint) : undefined,
          hint,
        };
      }
      return {
        available: Boolean(data.available),
        endpoint: data.endpoint ? String(data.endpoint) : undefined,
        hint: data.hint ? String(data.hint) : undefined,
        model: data.model ? String(data.model) : null,
        sandbox: data.sandbox ? String(data.sandbox) : undefined,
        tools: Array.isArray(data.tools) ? data.tools.map((t) => String(t ?? "")).filter(Boolean) : [],
      };
    } catch {
      return { available: false, hint: "Не удалось выполнить запрос к CRM (/api/ai/agent)" };
    }
  }, []);

  const sandboxInFlightRef = useRef<Promise<void> | null>(null);
  const sandboxQueuedRef = useRef(false);
  const lastSandboxAtRef = useRef(0);
  const sandboxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (sandboxTimerRef.current) {
        clearTimeout(sandboxTimerRef.current);
        sandboxTimerRef.current = null;
      }
    };
  }, []);

  const refreshSandbox = useCallback(async (force = false): Promise<void> => {
    const runFetch = async () => {
      if (sandboxInFlightRef.current) {
        sandboxQueuedRef.current = true;
        return sandboxInFlightRef.current;
      }
      const task = (async () => {
        do {
          sandboxQueuedRef.current = false;
          lastSandboxAtRef.current = Date.now();
          try {
            const res = await fetch("/api/ai/agent/sandbox", { cache: "no-store" });
            if (res.ok) {
              const data: unknown = await res.json();
              setSandbox(normalizeSandboxState(data));
            }
          } catch {
            /* фоновая проверка — тихо игнорируем */
          }
        } while (sandboxQueuedRef.current);
      })();
      sandboxInFlightRef.current = task;
      try {
        await task;
      } finally {
        sandboxInFlightRef.current = null;
      }
    };

    if (force) {
      if (sandboxTimerRef.current) {
        clearTimeout(sandboxTimerRef.current);
        sandboxTimerRef.current = null;
      }
      await runFetch();
      return;
    }

    const elapsed = Date.now() - lastSandboxAtRef.current;
    if (elapsed >= 2500 && !sandboxInFlightRef.current) {
      await runFetch();
      return;
    }

    if (!sandboxTimerRef.current) {
      const waitMs = Math.max(250, 2500 - elapsed);
      sandboxTimerRef.current = setTimeout(() => {
        sandboxTimerRef.current = null;
        void runFetch();
      }, waitMs);
    }
  }, []);

  const loadTesterConversationMessages = useCallback(async (convId: number) => {
    try {
      const res = await fetch(`/api/agent/conversations/${convId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as { messages?: StoredTurn[] } | null;
      if (data && Array.isArray(data.messages)) {
        setSelectedTesterMessages(data.messages.map(decodeStoredTurn));
      }
    } catch {
      /* фоновая загрузка */
    }
  }, []);

  const refreshTesterData = useCallback(
    async (preferConvId?: number | null) => {
      try {
        const res = await fetch("/api/agent/tester", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as {
          runs?: TesterRunItem[];
          conversations?: TesterConversationItem[];
        } | null;
        if (!data) return;
        const nextRuns = Array.isArray(data.runs) ? data.runs : [];
        const nextConvs = Array.isArray(data.conversations) ? data.conversations : [];
        setTesterRuns(nextRuns);
        setTesterConversations(nextConvs);
        const targetId =
          preferConvId && nextConvs.some((c) => c.id === preferConvId)
            ? preferConvId
            : selectedTesterConvIdRef.current && nextConvs.some((c) => c.id === selectedTesterConvIdRef.current)
              ? selectedTesterConvIdRef.current
              : nextConvs[0]?.id ?? null;
        setSelectedTesterConvId(targetId);
        if (targetId) {
          await loadTesterConversationMessages(targetId);
        } else {
          setSelectedTesterMessages([]);
        }
      } catch {
        /* фоновая синхронизация тестировщика */
      }
    },
    [loadTesterConversationMessages],
  );

  useEffect(() => {
    void refreshTesterData();
  }, [refreshTesterData]);

  const refreshGithubConnection = useCallback(async () => {
    try {
      const res = await fetch("/api/github/connection", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as {
        connected?: boolean;
        account?: GithubAccountPublic | null;
        oauthAvailable?: boolean;
      } | null;
      if (!data) return;
      setGhAccount(data.connected && data.account ? data.account : null);
      setGhOauthAvailable(Boolean(data.oauthAvailable));
    } catch {
      /* тихо */
    }
  }, []);

  useEffect(() => {
    void refreshGithubConnection();
    if (typeof window !== "undefined") {
      const paramsUrl = new URLSearchParams(window.location.search);
      if (paramsUrl.get("gh_connected") === "1") {
        setNotice("GitHub-аккаунт успешно привязан через OAuth.");
      } else if (paramsUrl.get("gh_error")) {
        setError(`Ошибка GitHub OAuth: ${paramsUrl.get("gh_error")}`);
      }
    }
  }, [refreshGithubConnection]);

  const refreshRagFolders = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/rag", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { folders?: RagFolder[] };
      if (Array.isArray(data.folders)) setRagFolders(data.folders);
    } catch {
      /* тихо игнорируем в фоне */
    }
  }, []);

  const refreshTranscripts = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/transcripts", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { transcripts?: TranscriptMeta[] };
      if (Array.isArray(data.transcripts)) setTranscripts(data.transcripts);
    } catch {
      /* тихо игнорируем в фоне */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const next = await loadHealth();
      if (alive) setHealth(next);

      try {
        const res = await fetch("/api/ai/rag", { cache: "no-store" });
        if (res.ok && alive) {
          const data = (await res.json()) as { folders?: RagFolder[] };
          if (Array.isArray(data.folders)) setRagFolders(data.folders);
        }
      } catch {
        /* тихо игнорируем в фоне */
      }

      try {
        const res = await fetch("/api/ai/agent/sandbox", { cache: "no-store" });
        if (res.ok && alive) {
          const data: unknown = await res.json();
          setSandbox(normalizeSandboxState(data));
        }
      } catch {
        /* тихо игнорируем в фоне */
      }

      try {
        const res = await fetch("/api/agent/transcripts", { cache: "no-store" });
        if (res.ok && alive) {
          const data = (await res.json()) as { transcripts?: TranscriptMeta[] };
          if (Array.isArray(data.transcripts)) setTranscripts(data.transcripts);
        }
      } catch {
        /* тихо игнорируем в фоне */
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadHealth]);

  const openConversation = useCallback(async (id: number) => {
    const res = await fetch(`/api/agent/conversations/${id}`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as {
      conversation?: AgentConversation;
      messages?: StoredTurn[];
      error?: string;
    };
    if (!res.ok || !data.conversation) throw new Error(data.error ?? "Не удалось открыть чат агента");

    setConversationId(id);
    setTurns((data.messages ?? []).map(decodeStoredTurn));
    setAttachments([]);
    setText("");
    counter.current = 0;
    setError(null);
    setStatus(null);
    setLiveBrowserLog([]);
    browserRunStartRef.current = 0;
  }, []);

  const createConversation = useCallback(async (title?: string) => {
    const res = await fetch("/api/agent/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "agent", ...(title ? { title } : {}) }),
    });
    const data = (await res.json().catch(() => ({}))) as { conversation?: AgentConversation; error?: string };
    if (!res.ok || !data.conversation) throw new Error(data.error ?? "Не удалось создать чат агента");

    const conversation = data.conversation;
    setConversations((prev) => [conversation, ...prev.filter((item) => item.id !== conversation.id)]);
    setConversationId(conversation.id);
    setTurns([]);
    setAttachments([]);
    setText("");
    setError(null);
    setStatus(null);
    setLiveBrowserLog([]);
    browserRunStartRef.current = 0;
    return conversation;
  }, []);

  const saveConversationMessage = useCallback(
    async (
      id: number,
      message: {
        role: "user" | "assistant";
        content: string;
        reasoning?: string;
        error?: string;
        attachments?: Array<{ name: string; size: number }>;
        actions?: AgentAction[];
        files?: Array<{ name: string; mime: string; size: number }>;
      },
    ) => {
      const res = await fetch(`/api/agent/conversations/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: StoredTurn; error?: string };
      if (!res.ok || !data.message) throw new Error(data.error ?? "Не удалось сохранить переписку");
      return decodeStoredTurn(data.message);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    const initialize = async () => {
      try {
        const res = await fetch("/api/agent/conversations?kind=agent", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          conversations?: AgentConversation[];
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "Не удалось загрузить историю агента");
        if (!alive) return;
        const list = data.conversations ?? [];
        setConversations(list);
        if (list.length > 0) await openConversation(list[0].id);
        else await createConversation();
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : "Не удалось загрузить чаты агента");
      } finally {
        if (alive) setHistoryLoading(false);
      }
    };
    void initialize();
    return () => {
      alive = false;
    };
  }, [createConversation, openConversation]);

  const selectConversation = async (id: number) => {
    if (id === conversationId || running || historyLoading) return;
    setHistoryLoading(true);
    setError(null);
    try {
      await openConversation(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось открыть чат агента");
    } finally {
      setHistoryLoading(false);
    }
  };

  const startNewConversation = async () => {
    if (running || historyLoading) return;
    setHistoryLoading(true);
    try {
      await createConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать чат агента");
    } finally {
      setHistoryLoading(false);
    }
  };

  const deleteCurrentConversation = async () => {
    if (conversationId === null || running || historyLoading) return;
    const id = conversationId;
    const targetConv = conversations.find((c) => c.id === id) ?? null;
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Не удалось удалить чат агента");
      if (targetConv?.operatorTaskId) {
        dismissedOpTaskIdsRef.current.add(targetConv.operatorTaskId);
        if (opTaskRef.current?.id === targetConv.operatorTaskId) {
          setOpTask(null);
          setOpEvents([]);
          setOpConversationId(null);
        }
      }
      const rest = conversations.filter((item) => item.id !== id);
      setConversations(rest);
      if (rest.length > 0) await openConversation(rest[0].id);
      else await createConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось удалить чат агента");
    } finally {
      setHistoryLoading(false);
    }
  };

  const exitOperatorTaskChat = async () => {
    if (running || historyLoading) return;
    const currentOpTaskId = currentConversation?.operatorTaskId;
    if (currentOpTaskId) {
      dismissedOpTaskIdsRef.current.add(currentOpTaskId);
      if (opTaskRef.current?.id === currentOpTaskId) {
        setOpTask(null);
        setOpEvents([]);
        setOpConversationId(null);
      }
    }
    const regular = conversations.find((c) => c.id !== conversationId && !c.operatorTaskId);
    if (regular) {
      await selectConversation(regular.id);
    } else {
      await startNewConversation();
    }
  };

  const closeOperatorTaskCard = () => {
    if (opTask) dismissedOpTaskIdsRef.current.add(opTask.id);
    setOpTask(null);
    setOpEvents([]);
    setOpConversationId(null);
  };

  /* --------------------------- Summary и архивация --------------------------- */

  const currentConversation = useMemo(
    () => conversations.find((c) => c.id === conversationId) ?? null,
    [conversations, conversationId],
  );

  const usedTokens = useMemo(
    () => estimateAgentConversationTokens(turnsToTranscript(turns)),
    [turns],
  );
  const contextPercent = contextLimit > 0 ? Math.min(100, Math.round((usedTokens / contextLimit) * 100)) : 0;

  const rolloverToSummaryChat = useCallback(
    async (sourceTurns: Turn[], reason: "auto" | "manual") => {
      if (sourceTurns.length === 0 || summarizing) return;
      setSummarizing(true);
      setError(null);
      const chatTitle = currentConversation?.title || "Чат агента";
      const transcriptTurns = turnsToTranscript(sourceTurns);
      try {
        setStatus("Составляю Summary переписки…");
        const sumRes = await fetch("/api/ai/agent/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: chatTitle, turns: transcriptTurns, settings }),
        });
        const sumData = (await sumRes.json().catch(() => ({}))) as { summary?: string };
        const summaryText =
          sumData.summary?.trim() ||
          `Summary чата «${chatTitle}» (${sourceTurns.length} сообщений).`;

        const fileName = buildTranscriptFileName(chatTitle);
        const markdown = formatTranscriptMarkdown({
          title: chatTitle,
          summary: summaryText,
          turns: transcriptTurns,
        });

        let savedTranscriptId: number | null = null;
        try {
          const tRes = await fetch("/api/agent/transcripts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId: conversationId ?? 0,
              title: chatTitle,
              summary: summaryText,
              fileName,
              content: markdown,
            }),
          });
          if (tRes.ok) {
            const tData = (await tRes.json().catch(() => ({}))) as { transcript?: TranscriptMeta };
            if (tData.transcript) {
              savedTranscriptId = tData.transcript.id;
              setTranscripts((prev) => [tData.transcript!, ...prev]);
            }
          }
        } catch {
          /* best-effort */
        }

        // Дублируем стенограмму в Sandbox/transcripts/, если агент онлайн.
        void fetch("/api/ai/agent/sandbox", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "write_transcript", fileName, content: markdown }),
        }).catch(() => null);

        const nextConv = await createConversation(`Продолжение: ${chatTitle}`.slice(0, 80));
        const reasonLine =
          reason === "auto"
            ? `Контекст достиг ${Math.round(ROLLOVER_THRESHOLD_RATIO * 100)}% лимита (${contextLimit} токенов) — создан новый чат со сжатым Summary.`
            : "Создан новый чат со сжатым Summary текущей переписки.";
        const archiveHint = savedTranscriptId
          ? `\n\nПолная переписка сохранена в файл «${fileName}» (доступен в разделе «Архив переписок» для скачивания и повторного анализа).`
          : `\n\nПолная переписка архивирована под именем «${fileName}».`;

        const handoffText = `${reasonLine}\n\n${summaryText}${archiveHint}`;
        const savedMsg = await saveConversationMessage(nextConv.id, {
          role: "assistant",
          content: handoffText,
        });
        setTurns([savedMsg]);
        setNotice(
          savedTranscriptId
            ? `Переписка сжата в Summary и сохранена в ${fileName}. Открыт новый чат.`
            : "Переписка сжата в Summary. Открыт новый чат.",
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Не удалось сжать переписку в Summary");
      } finally {
        setSummarizing(false);
        setStatus(null);
      }
    },
    [contextLimit, conversationId, createConversation, currentConversation?.title, saveConversationMessage, settings, summarizing],
  );

  const attachTranscript = async (item: TranscriptMeta) => {
    try {
      const res = await fetch(`/api/agent/transcripts/${item.id}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Не удалось загрузить переписку");
      const data = (await res.json()) as { transcript?: { content?: string; fileName?: string } };
      const content = String(data.transcript?.content ?? "");
      if (!content) throw new Error("Файл переписки пуст");
      setAttachments((prev) => {
        const next = [
          ...prev,
          {
            name: item.fileName || `transcript-${item.id}.md`,
            mime: "text/markdown",
            size: content.length,
            data: "",
            text: content,
            note: "архивная переписка агента",
          },
        ];
        return unlimited ? next : next.slice(-5);
      });
      setNotice(`Файл переписки «${item.fileName}» приложен к запросу — можно задать вопрос или продолжить работу.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось приложить переписку");
    }
  };

  /* --------------------------- RAG: загрузка папки --------------------------- */

  const uploadRagFolder = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0 || ragBusy || running) return;

    setError(null);
    setNotice(null);
    setRagBusy(true);
    setRagProgress({ done: 0, total: files.length, phase: "read" });
    const folderName = (files[0].webkitRelativePath?.split("/")[0] || "Папка").slice(0, 100);

    try {
      const items: Array<{ path: string; chunks: string[] }> = [];
      let skipped = 0;
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const path = (file.webkitRelativePath || file.name).slice(0, 300);
        if (!unlimited && file.size > AI_MAX_FILE_BYTES) {
          skipped += 1;
        } else {
          const extracted = await extractFile(file, unlimited ? { maxChars: null } : {});
          if (extracted.kind === "text" && extracted.text.trim()) {
            items.push({ path, chunks: splitIntoChunks(extracted.text) });
          } else {
            skipped += 1;
          }
        }
        if (i % 5 === 0) setRagProgress({ done: i + 1, total: files.length, phase: "read" });
      }
      if (items.length === 0) {
        setError("В папке не найдено читаемого текста для RAG.");
        return;
      }

      const createdRes = await fetch("/api/ai/rag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${folderName}${skipped > 0 ? ` (+${skipped} пропущено)` : ""}` }),
      });
      if (!createdRes.ok) throw new Error("Не удалось создать RAG-папку");
      const created = (await createdRes.json()) as { folder: RagFolder };
      const newId = created.folder.id;

      let batch: Array<{ path: string; chunks: string[] }> = [];
      let batchChars = 0;
      let uploaded = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        const res = await fetch("/api/ai/rag/chunks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId: newId, items: batch }),
        });
        if (!res.ok) throw new Error("Не удалось загрузить фрагменты RAG");
        batch = [];
        batchChars = 0;
      };

      for (const item of items) {
        const chars = item.chunks.reduce((sum, c) => sum + c.length, 0);
        if (batch.length >= 150 || batchChars + chars > 3_000_000) await flush();
        batch.push(item);
        batchChars += chars;
        uploaded += 1;
        setRagProgress({ done: uploaded, total: items.length, phase: "upload" });
      }
      await flush();

      await refreshRagFolders();
      setRagPrefs({ ...ragPrefs, folderId: newId });
      setNotice(`RAG-папка «${folderName}» проиндексирована полностью (${items.length} файлов).`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось загрузить папку RAG");
    } finally {
      setRagBusy(false);
      setRagProgress(null);
    }
  };

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/conversations?kind=agent", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversations?: AgentConversation[] };
      if (Array.isArray(data.conversations)) setConversations(data.conversations);
    } catch {
      /* фоновая проверка */
    }
  }, []);

  const refreshOpTask = useCallback(
    async (taskId: number) => {
      try {
        const res = await fetch(`/api/agent/tasks/${taskId}`, { cache: "no-store" });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          task?: OperatorTask;
          events?: OperatorEvent[];
          conversationId?: number | null;
        };
        if (data.task) setOpTask(data.task);
        if (Array.isArray(data.events)) setOpEvents(data.events);
        const convId = typeof data.conversationId === "number" ? data.conversationId : null;
        setOpConversationId(convId);

        if (convId && conversationIdRef.current === convId && !runningRef.current) {
          try {
            const cRes = await fetch(`/api/agent/conversations/${convId}`, { cache: "no-store" });
            if (cRes.ok) {
              const cData = (await cRes.json()) as { messages?: StoredTurn[] };
              if (Array.isArray(cData.messages)) {
                setTurns(cData.messages.map(decodeStoredTurn));
              }
            }
          } catch {
            /* тихо */
          }
        }
        if (convId) void refreshConversations();
        return data;
      } catch {
        /* фоновый поллинг */
        return null;
      }
    },
    [refreshConversations],
  );

  const refreshOperatorOverview = useCallback(async () => {
    try {
      const [botRes, tasksRes] = await Promise.all([
        fetch("/api/agent/bot/status", { cache: "no-store" }).catch(() => null),
        fetch("/api/agent/tasks", { cache: "no-store" }).catch(() => null),
      ]);
      if (botRes && botRes.ok) {
        const botData = (await botRes.json().catch(() => null)) as {
          state?: string;
          connected?: boolean;
        } | null;
        if (botData && typeof botData.connected === "boolean") {
          setOpBotStatus({
            state: String(botData.state ?? (botData.connected ? "online" : "stale")),
            connected: botData.connected,
          });
        }
      }
      if (tasksRes && tasksRes.ok) {
        const tasksData = (await tasksRes.json().catch(() => null)) as {
          tasks?: OperatorTask[];
        } | null;
        const list = Array.isArray(tasksData?.tasks)
          ? tasksData!.tasks.filter((t) => t.taskMode !== "inspect")
          : [];
        setRecentOpTasks(list.slice(0, 8));
        if (!opTaskRef.current) {
          const active = list.find(
            (t) =>
              !dismissedOpTaskIdsRef.current.has(t.id) &&
              ["running", "waiting_approval", "waiting_steps", "queued"].includes(t.status),
          );
          if (active) {
            void refreshOpTask(active.id);
          }
        }
      }
    } catch {
      /* фоновый поллинг — тихо игнорируем */
    }
  }, [refreshOpTask]);

  useEffect(() => {
    void refreshOperatorOverview();
    const timer = window.setInterval(() => {
      void refreshOperatorOverview();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshOperatorOverview]);

  useEffect(() => {
    if (!opTask || ["done", "failed", "cancelled"].includes(opTask.status)) return;
    const id = opTask.id;
    const timer = window.setInterval(() => {
      void refreshOpTask(id);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [opTask, refreshOpTask]);

  /* --------------------------- Подтверждение & Sandbox --------------------------- */

  const submitScreenApproval = useCallback(
    async (
      approvalId: string,
      opts: {
        taskId?: number;
        taskPrompt?: string;
        screenshot?: string;
        screenSummary?: string;
      },
    ) => {
      const res = await fetch("/api/ai/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId,
          approved: true,
          ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
          ...(opts.taskPrompt ? { taskPrompt: opts.taskPrompt } : {}),
          mode: "inspect",
          coachMode: "off",
          operatorTrustLevel: approvalOpTrust,
          ...(opts.screenshot ? { screenshot: opts.screenshot } : {}),
          ...(opts.screenSummary ? { screenSummary: opts.screenSummary } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Не удалось передать снимок экрана Агенту");
      }
      setScreenCapture(null);
      setPendingApproval(null);
      setApprovalDest("");
      setApprovalTaskDraft("");
      setNotice("Снимок экрана получен и передан Агенту.");
    },
    [approvalOpTrust],
  );

  useEffect(() => {
    if (!screenCapture || screenCapture.error) return;
    let active = true;

    const pollOnce = async () => {
      try {
        const res = await fetch(`/api/agent/tasks/${screenCapture.taskId}`, { cache: "no-store" });
        if (!res.ok || !active) return;
        const data = (await res.json().catch(() => ({}))) as {
          task?: OperatorTask;
          latestScreen?: { dataUrl?: string; summary?: string } | null;
        };
        if (!active) return;
        if (data.task) setOpTask(data.task);

        const screenDataUrl = data.latestScreen?.dataUrl ?? "";
        const screenSummary = (data.latestScreen?.summary ?? data.task?.summary ?? "").trim();
        const taskDone = data.task?.status === "done";

        if (screenDataUrl || (taskDone && screenSummary)) {
          await submitScreenApproval(screenCapture.approvalId, {
            taskId: screenCapture.taskId,
            taskPrompt: data.task?.prompt,
            screenshot: screenDataUrl,
            screenSummary,
          });
          return;
        }

        if (data.task && (data.task.status === "failed" || data.task.status === "cancelled")) {
          setScreenCapture((prev) =>
            prev
              ? {
                  ...prev,
                  status: data.task!.status,
                  error: data.task!.summary || "Оператор не смог сделать снимок экрана",
                }
              : null,
          );
          return;
        }

        if (data.task && data.task.status !== screenCapture.status) {
          setScreenCapture((prev) => (prev ? { ...prev, status: data.task!.status } : null));
        }
      } catch (caught) {
        if (!active) return;
        setScreenCapture((prev) =>
          prev
            ? {
                ...prev,
                error: caught instanceof Error ? caught.message : "Ошибка ожидания снимка экрана",
              }
            : null,
        );
      }
    };

    void pollOnce();
    const timer = window.setInterval(() => {
      void pollOnce();
    }, 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [screenCapture, submitScreenApproval]);

  const captureScreenInBrowser = async () => {
    if (!pendingApproval || browserCaptureBusy) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== "function"
    ) {
      setError("Ваш браузер не поддерживает захват экрана (getDisplayMedia)");
      return;
    }
    setBrowserCaptureBusy(true);
    setError(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise<void>((resolve) => {
        if (video.readyState >= 2) resolve();
        else video.onloadeddata = () => resolve();
      });

      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      const scale = vw > 1440 ? 1440 / vw : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vw * scale));
      canvas.height = Math.max(1, Math.round(vh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Не удалось обработать кадр экрана");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);

      if (screenCapture?.taskId) {
        void fetch(`/api/agent/tasks/${screenCapture.taskId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel" }),
        });
      }

      await submitScreenApproval(pendingApproval.approvalId, {
        taskId: screenCapture?.taskId,
        screenshot: dataUrl,
        screenSummary: `Снимок экрана (${canvas.width}×${canvas.height}), переданный через браузер`,
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Захват экрана через браузер отменён",
      );
    } finally {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      setBrowserCaptureBusy(false);
    }
  };

  const sendApprovalDecision = async (approved: boolean) => {
    if (!pendingApproval || approvalBusy) return;
    setApprovalBusy(true);
    setError(null);
    try {
      let launchedTaskId: number | undefined;
      const finalPrompt = (approvalTaskDraft || pendingApproval.task || pendingApproval.description || "").trim();
      const finalCoachMode = approvalCoachAfter ? "agent" : "after_step";

      if (approved && pendingApproval.kind === "capture_screen") {
        const inspectPrompt = finalPrompt || "Сделай снимок экрана ПК и отправь его Агенту";
        const launchRes = await fetch("/api/ai/agent/operator", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "launch",
            prompt: inspectPrompt,
            taskMode: "inspect",
            coachMode: "off",
            maxSteps: 2,
            trustLevel: approvalOpTrust,
          }),
        });
        const launchData = (await launchRes.json().catch(() => ({}))) as {
          task?: OperatorTask;
          error?: string;
        };
        if (!launchRes.ok || !launchData.task) {
          setError(launchData.error ?? "Не удалось запросить снимок экрана у Оператора");
          return;
        }
        setOpTask(launchData.task);
        setOpEvents([]);
        setScreenCapture({
          approvalId: pendingApproval.approvalId,
          taskId: launchData.task.id,
          status: launchData.task.status,
        });
        setNotice(`Запрос снимка экрана отправлен Оператору (задача #${launchData.task.id}).`);
        return;
      }

      if (!approved && screenCapture?.taskId) {
        void fetch(`/api/agent/tasks/${screenCapture.taskId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel" }),
        });
      }

      if (approved && pendingApproval.kind === "call_operator") {
        if (!finalPrompt) {
          setError("Укажите задачу для Оператора перед запуском");
          return;
        }
        const launchRes = await fetch("/api/ai/agent/operator", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "launch",
            prompt: finalPrompt,
            taskMode: approvalTaskMode,
            coachMode: finalCoachMode,
            maxSteps: pendingApproval.maxSteps ?? 30,
            trustLevel: approvalOpTrust,
          }),
        });
        const launchData = (await launchRes.json().catch(() => ({}))) as {
          task?: OperatorTask;
          error?: string;
        };
        if (!launchRes.ok || !launchData.task) {
          setError(launchData.error ?? "Не удалось поставить задачу Оператору");
          return;
        }
        launchedTaskId = launchData.task.id;
        dismissedOpTaskIdsRef.current.delete(launchData.task.id);
        setOpTask(launchData.task);
        setOpEvents([]);
        setNotice(
          `Оператор запущен по вашему разрешению (задача #${launchData.task.id}, режим: ${findTaskMode(approvalTaskMode).shortLabel}).`,
        );
      }

      const res = await fetch("/api/ai/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: pendingApproval.approvalId,
          approved,
          destination: approvalDest.trim(),
          ...(pendingApproval.kind === "github_commit"
            ? {
                commitMessage: approvalGhCommitMsg.trim() || pendingApproval.github?.message || "",
                branch: approvalGhBranch.trim() || pendingApproval.github?.branch || "",
              }
            : {}),
          ...(pendingApproval.kind === "github_pr"
            ? {
                prTitle: approvalGhPrTitle.trim() || pendingApproval.github?.prTitle || "",
                prBody: approvalGhPrBody,
              }
            : {}),
          ...(pendingApproval.kind === "github_merge"
            ? {
                mergeMethod: approvalGhMergeMethod,
              }
            : {}),
          ...(launchedTaskId !== undefined
            ? {
                taskId: launchedTaskId,
                taskPrompt: finalPrompt,
                mode: approvalTaskMode,
                coachMode: finalCoachMode,
                operatorTrustLevel: approvalOpTrust,
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Не удалось отправить подтверждение");
        return;
      }
      if (pendingApproval.kind === "tester_minor_fixes" && pendingApproval.testerRunId) {
        const runId = pendingApproval.testerRunId;
        const decVal = approved ? "approved" : "rejected";
        setTesterRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, minorDecision: decVal } : r)));
        void fetch(`/api/agent/tester/${runId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: decVal }),
        }).catch(() => undefined);
      }
      setScreenCapture(null);
      setPendingApproval(null);
      setApprovalDest("");
      setApprovalTaskDraft("");
      setLiveTester((prev) =>
        prev ? { ...prev, statusText: "Тестировщик: продолжаю проверку…" } : prev,
      );
      if (launchedTaskId !== undefined) {
        void refreshOpTask(launchedTaskId);
      }
    } catch {
      setError("Сеть недоступна при отправке подтверждения");
    } finally {
      setApprovalBusy(false);
    }
  };

  const formulateOperatorTask = async (goalOverride?: string) => {
    const goal = ((goalOverride ?? opGoal) || text).trim();
    if (!goal || opFormulating) return;
    setOpFormulating(true);
    setError(null);
    try {
      const contextSummary = turns
        .slice(-4)
        .map((t) => `${t.role === "user" ? "Пользователь" : "Агент"}: ${t.content.slice(0, 300)}`)
        .join("\n");
      const res = await fetch("/api/ai/agent/operator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "formulate",
          goal,
          contextSummary,
          settings,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        prompt?: string;
        taskMode?: string;
        maxSteps?: number;
        notes?: string;
        error?: string;
      };
      if (!res.ok || !data.prompt) {
        setError(data.error ?? "Не удалось сформулировать задачу для Оператора");
        return;
      }
      if (!opGoal) setOpGoal(goal);
      setOpDraftPrompt(data.prompt);
      setOpDraftMode(normalizeTaskMode(data.taskMode));
      setOpDraftSteps(Math.max(0, Math.floor(Number(data.maxSteps ?? 0) || 0)));
      setOpDraftNotes(String(data.notes ?? ""));
      setOpBridgeOpen(true);
      if (layoutMode === "tabs") setActiveTab("workspace");
    } catch {
      setError("Сеть недоступна при формулировке задачи Оператора");
    } finally {
      setOpFormulating(false);
    }
  };

  const launchOperatorFromDraft = async (
    promptText: string,
    mode: OperatorTaskMode,
    stepsLimit = 0,
  ) => {
    const clean = promptText.trim();
    if (!clean || opLaunching) return;
    setOpLaunching(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/agent/operator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "launch",
          prompt: clean,
          taskMode: mode,
          coachMode: "agent",
          maxSteps: stepsLimit <= 0 ? 0 : Math.floor(stepsLimit),
          trustLevel: trustLevel === "full" ? "full" : "verified",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { task?: OperatorTask; error?: string };
      if (!res.ok || !data.task) {
        setError(data.error ?? "Не удалось запустить Оператора");
        return;
      }
      dismissedOpTaskIdsRef.current.delete(data.task.id);
      setOpTask(data.task);
      setOpEvents([]);
      setNotice(`Задача #${data.task.id} отправлена Оператору по вашему согласию (режим: ${findTaskMode(mode).shortLabel}).`);
      void refreshOpTask(data.task.id);
    } catch {
      setError("Сеть недоступна при запуске Оператора");
    } finally {
      setOpLaunching(false);
    }
  };

  const sendOperatorGuidance = async () => {
    if (!opTask || !opGuidanceInput.trim() || opCoachBusy) return;
    setOpCoachBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/tasks/${opTask.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "guidance", text: opGuidanceInput.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { task?: OperatorTask; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Не удалось передать подсказку Оператору");
        return;
      }
      setOpGuidanceInput("");
      if (data.task) setOpTask(data.task);
      await refreshOpTask(opTask.id);
    } finally {
      setOpCoachBusy(false);
    }
  };

  const askOperatorCoach = async () => {
    if (!opTask || opCoachBusy) return;
    setOpCoachBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/agent/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: opTask.id,
          userHint: opGuidanceInput.trim(),
          settings,
          params,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { task?: OperatorTask; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Не удалось получить подсказку Агента");
        return;
      }
      if (data.task) setOpTask(data.task);
      await refreshOpTask(opTask.id);
    } finally {
      setOpCoachBusy(false);
    }
  };

  const openOperatorTaskChat = async (targetTaskId?: number) => {
    const taskId = targetTaskId ?? opTask?.id;
    if (!taskId || running || historyLoading) return;
    setError(null);
    dismissedOpTaskIdsRef.current.delete(taskId);
    try {
      let convId = targetTaskId === opTask?.id ? opConversationId : null;
      if (!convId) {
        const refreshed = await refreshOpTask(taskId);
        convId = typeof refreshed?.conversationId === "number" ? refreshed.conversationId : null;
      }
      if (!convId) {
        const ensureRes = await fetch(`/api/agent/tasks/${taskId}?ensureChat=1`, { cache: "no-store" });
        if (ensureRes.ok) {
          const ensureData = (await ensureRes.json().catch(() => ({}))) as {
            conversationId?: number | null;
          };
          convId = typeof ensureData.conversationId === "number" ? ensureData.conversationId : null;
        }
      }
      if (!convId) {
        setError(`Чат для задачи Оператора #${taskId} ещё не сформирован`);
        return;
      }
      await refreshConversations();
      await openConversation(convId);
      if (layoutMode === "tabs") setActiveTab("chat");
      setNotice(`Открыт чат задачи Оператора #${taskId} (история сохраняется автоматически).`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось открыть чат задачи Оператора");
    }
  };

  const actOnOperatorTask = async (
    action: "approve" | "reject" | "extend_steps" | "cancel",
    extra?: { approvalId?: string; addSteps?: number },
  ) => {
    if (!opTask) return;
    const res = await fetch(`/api/agent/tasks/${opTask.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = (await res.json().catch(() => ({}))) as { task?: OperatorTask; error?: string };
    if (!res.ok) {
      setError(data.error ?? "Не удалось обновить задачу Оператора");
      return;
    }
    if (data.task) setOpTask(data.task);
    await refreshOpTask(opTask.id);
  };

  const runSandboxExport = async () => {
    if (!exportSource.trim() || !exportDest.trim() || sandboxBusy) return;
    setSandboxBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/agent/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "export",
          source: exportSource.trim(),
          destination: exportDest.trim(),
          mode: exportMode,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        filesCount?: number;
        destination?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Не удалось перенести файлы из Sandbox");
      setNotice(
        `${exportMode === "move" ? "Перенесено" : "Скопировано"} ${data.filesCount ?? 0} файлов в ${data.destination ?? exportDest}`,
      );
      await refreshSandbox(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ошибка экспорта из Sandbox");
    } finally {
      setSandboxBusy(false);
    }
  };

  const stopSandboxProcess = async (pid: number) => {
    setSandboxBusy(true);
    try {
      await fetch("/api/ai/agent/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop_process", pid }),
      });
      await refreshSandbox(true);
    } finally {
      setSandboxBusy(false);
    }
  };

  /* --------------------------- Отправка запроса --------------------------- */

  const scrollDown = useCallback((force = false) => {
    const el = listRef.current;
    if (!el) return;
    if (!force && autoScrollPausedRef.current) return;
    const apply = () => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    };
    apply();
    requestAnimationFrame(apply);
  }, []);

  const handleChatScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollPausedRef.current = distanceFromBottom > 220;
  };

  useEffect(() => {
    if (turns.length === 0) return;
    scrollDown(false);
  }, [turns, scrollDown]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      scrollDown(false);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, scrollDown]);

  const selectTesterConversation = async (id: number) => {
    setSelectedTesterConvId(id);
    setTesterLoading(true);
    try {
      await loadTesterConversationMessages(id);
    } finally {
      setTesterLoading(false);
    }
  };

  const createNewTesterChat = async () => {
    if (testerDirectRunning || running) return;
    setTesterLoading(true);
    setTesterError(null);
    try {
      const res = await fetch("/api/agent/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "tester", title: "Новый чат тестировщика" }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        conversation?: TesterConversationItem;
        error?: string;
      };
      if (!res.ok || !data.conversation) {
        throw new Error(data.error ?? "Не удалось создать чат тестировщика");
      }
      const created = data.conversation;
      setTesterConversations((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
      setSelectedTesterConvId(created.id);
      setSelectedTesterMessages([]);
    } catch (caught) {
      setTesterError(caught instanceof Error ? caught.message : "Ошибка создания чата тестировщика");
    } finally {
      setTesterLoading(false);
    }
  };

  const deleteTesterChat = async (id: number) => {
    if (testerDirectRunning || running) return;
    setTesterLoading(true);
    setTesterError(null);
    try {
      const res = await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Не удалось удалить чат тестировщика");
      const nextConvs = testerConversations.filter((c) => c.id !== id);
      setTesterConversations(nextConvs);
      setTesterRuns((prev) => prev.filter((r) => r.testerConversationId !== id));
      const fallback = nextConvs[0]?.id ?? null;
      setSelectedTesterConvId(fallback);
      if (fallback) {
        await loadTesterConversationMessages(fallback);
      } else {
        setSelectedTesterMessages([]);
      }
    } catch (caught) {
      setTesterError(caught instanceof Error ? caught.message : "Ошибка удаления чата тестировщика");
    } finally {
      setTesterLoading(false);
    }
  };

  const decideTesterMinor = async (runId: number, decision: "approved" | "rejected") => {
    setTesterDecisionBusy(runId);
    setTesterError(null);
    try {
      const res = await fetch(`/api/agent/tester/${runId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = (await res.json().catch(() => ({}))) as { run?: TesterRunItem; error?: string };
      if (!res.ok || !data.run) throw new Error(data.error ?? "Не удалось сохранить решение");
      setTesterRuns((prev) => prev.map((r) => (r.id === runId ? data.run! : r)));
      await refreshTesterData(data.run.testerConversationId);
    } catch (caught) {
      setTesterError(caught instanceof Error ? caught.message : "Ошибка сохранения решения");
    } finally {
      setTesterDecisionBusy(null);
    }
  };

  const openAgentChatFromTester = async (agentConvId: number) => {
    if (!agentConvId || running || historyLoading) return;
    try {
      await openConversation(agentConvId);
      if (layoutMode === "tabs") setActiveTab("chat");
    } catch (caught) {
      setTesterError(caught instanceof Error ? caught.message : "Исходный чат Агента не найден");
    }
  };

  const sendTesterDirect = async () => {
    const promptText = testerDirectPrompt.trim();
    if (!promptText || testerDirectRunning || running) return;
    setTesterError(null);
    setTesterDirectPrompt("");
    setTesterDirectRunning(true);

    let targetConvId = selectedTesterConvId;
    let persistedByServer = false;
    const draftId = `td_${Date.now()}`;

    try {
      if (!targetConvId) {
        const res = await fetch("/api/agent/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "tester",
            title:
              testerDirectProject && testerDirectProject !== "."
                ? `Тест: ${testerDirectProject}`
                : promptText.slice(0, 60),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          conversation?: TesterConversationItem;
          error?: string;
        };
        if (!res.ok || !data.conversation) {
          throw new Error(data.error ?? "Не удалось создать новый чат тестировщика");
        }
        targetConvId = data.conversation.id;
        setTesterConversations((prev) => [data.conversation!, ...prev]);
        setSelectedTesterConvId(targetConvId);
      }

      const userSavedRes = await fetch(`/api/agent/conversations/${targetConvId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: promptText }),
      });
      if (!userSavedRes.ok) throw new Error("Не удалось сохранить запрос в чат тестировщика");

      const nextHistory: TesterChatMessage[] = [
        ...selectedTesterMessages,
        { id: `tu_${Date.now()}`, role: "user", content: promptText },
      ];
      setSelectedTesterMessages([
        ...nextHistory,
        { id: draftId, role: "assistant", content: "", reasoning: "" },
      ]);

      await persistSettings();
      const res = await fetch("/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentRole: "tester",
          testerConversationId: targetConvId,
          sandboxProject: testerDirectProject || ".",
          messages: nextHistory.map((m) => ({ role: m.role, content: m.content })),
          settings: { baseUrl: settings.baseUrl, model: settings.model },
          params,
          trustLevel,
          maxSteps: maxSteps <= 0 ? 0 : Math.floor(maxSteps),
          contextLimit,
          ...(modelCapabilities?.contextLength ? { modelContextLength: modelCapabilities.contextLength } : {}),
          ...(ghAccount && ghAccount.enabled && ghAccount.selectedOwner && ghAccount.selectedRepo
            ? {
                githubEnabled: true,
                githubOwner: ghAccount.selectedOwner,
                githubRepo: ghAccount.selectedRepo,
                githubBranch: ghAccount.selectedBranch || "main",
              }
            : { githubEnabled: false }),
        }),
      });

      if (!res.ok || !res.body) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error ?? "Тестировщик недоступен");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      let assistantReason = "";

      const processFrame = (raw: string) => {
        const lines = raw.split("\n");
        const eventLine = lines.find((l) => l.startsWith("event:"));
        const dataLines = lines.filter((l) => l.startsWith("data:"));
        if (dataLines.length === 0) return;
        const ev = eventLine ? eventLine.slice(6).trim() : "message";
        const dataText = dataLines.map((l) => l.slice(5).trimStart()).join("\n");
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataText) as Record<string, unknown>;
        } catch {
          return;
        }

        if (ev === "tester_run") {
          const createdConv =
            data.conversation && typeof data.conversation === "object"
              ? (data.conversation as TesterConversationItem)
              : null;
          const createdRun =
            data.run && typeof data.run === "object" ? (data.run as TesterRunItem) : null;
          if (createdConv) {
            setTesterConversations((prev) => [
              createdConv,
              ...prev.filter((c) => c.id !== createdConv.id),
            ]);
          }
          if (createdRun) {
            setTesterRuns((prev) => [createdRun, ...prev.filter((r) => r.id !== createdRun.id)]);
          }
          clearLiveBrowserLog();
          setLiveTester({
            runKey: String(data.runKey ?? "direct"),
            runId: typeof data.runId === "number" ? data.runId : createdRun?.id,
            testerConversationId:
              typeof data.testerConversationId === "number"
                ? data.testerConversationId
                : createdConv?.id ?? targetConvId ?? undefined,
            sandboxProject: String(createdRun?.sandboxProject ?? testerDirectProject ?? "."),
            summary: promptText,
            model: String(createdRun?.model ?? settings.model ?? ""),
            statusText: "Тестировщик начал проверку…",
            reasoning: "",
            content: "",
            browserLog: [],
            actions: [],
          });
        } else if (ev === "status") {
          const st = String(data.text ?? "");
          const isBrowserStep =
            data.source === "browser_inspector" ||
            data.tool === "browse_project" ||
            data.tool === "qa_browser_audit";
          if (isBrowserStep && data.done === true) {
            clearLiveBrowserLog();
            setLiveTester((prev) => (prev ? { ...prev, statusText: st, browserLog: [] } : prev));
          } else if (isBrowserStep && st) {
            const isBrowserStart =
              st.startsWith("Вызываю инструмент: browse_project") ||
              st.startsWith("Вызываю инструмент: qa_browser_audit") ||
              st.startsWith("Тестировщик: browse_project") ||
              st.startsWith("Тестировщик: qa_browser_audit");
            const logLine = pushLiveBrowserLog(st, isBrowserStart);
            setLiveTester((prev) =>
              prev
                ? {
                    ...prev,
                    statusText: st,
                    browserLog: (isBrowserStart ? [] : prev.browserLog ?? []).concat(logLine).slice(-60),
                  }
                : prev,
            );
          } else {
            if (st) clearLiveBrowserLog();
            setLiveTester((prev) =>
              prev
                ? {
                    ...prev,
                    statusText: st,
                    ...(st ? { browserLog: [] } : {}),
                  }
                : prev,
            );
          }
        } else if (ev === "reasoning") {
          assistantReason = String(data.text ?? "");
          setSelectedTesterMessages((prev) =>
            prev.map((m) => (m.id === draftId ? { ...m, reasoning: assistantReason } : m)),
          );
        } else if (ev === "text") {
          clearLiveBrowserLog();
          assistantText = String(data.text ?? "");
          setSelectedTesterMessages((prev) =>
            prev.map((m) => (m.id === draftId ? { ...m, content: assistantText } : m)),
          );
        } else if (ev === "action") {
          const actType = String(data.type ?? "qa_check");
          if (actType === "browser_inspect") {
            clearLiveBrowserLog();
          }
          setLiveTester((prev) =>
            prev
              ? {
                  ...prev,
                  ...(actType === "browser_inspect" ? { browserLog: [] } : {}),
                  actions: [
                    ...prev.actions,
                    {
                      type: actType,
                      label: data.label ? String(data.label) : undefined,
                      command: data.command ? String(data.command) : undefined,
                      url: data.url ? String(data.url) : undefined,
                      action: data.action ? String(data.action) : undefined,
                      viewport: data.viewport ? String(data.viewport) : undefined,
                      summary: data.summary ? String(data.summary) : undefined,
                      error: data.error ? String(data.error) : undefined,
                      errorsCount: typeof data.errorsCount === "number" ? data.errorsCount : undefined,
                      issuesCount: typeof data.issuesCount === "number" ? data.issuesCount : undefined,
                      animationsCount: typeof data.animationsCount === "number" ? data.animationsCount : undefined,
                    },
                  ],
                }
              : prev,
          );
        } else if (ev === "approval_required") {
          setPendingApproval({
            approvalId: String(data.approvalId ?? ""),
            kind: String(data.kind ?? "command"),
            title: String(data.title ?? "Требуется подтверждение"),
            description: String(data.description ?? data.reason ?? ""),
            command: data.command ? String(data.command) : undefined,
            cwd: data.cwd ? String(data.cwd) : undefined,
            sandboxProject: data.sandboxProject ? String(data.sandboxProject) : undefined,
            testerRunKey: data.testerRunKey ? String(data.testerRunKey) : undefined,
            testerRunId: typeof data.testerRunId === "number" ? data.testerRunId : undefined,
            testerConversationId:
              typeof data.testerConversationId === "number" ? data.testerConversationId : undefined,
            minorIssues: Array.isArray(data.minorIssues)
              ? (data.minorIssues as TesterIssueItem[])
              : undefined,
          });
          setLiveTester((prev) =>
            prev ? { ...prev, statusText: "Тестировщик ждёт вашего подтверждения на сайте…" } : prev,
          );
        } else if (ev === "tester_done") {
          clearLiveBrowserLog();
          const savedRun =
            data.run && typeof data.run === "object" ? (data.run as TesterRunItem) : null;
          if (savedRun) {
            persistedByServer = true;
            setTesterRuns((prev) => [savedRun, ...prev.filter((r) => r.id !== savedRun.id)]);
          }
        } else if (ev === "done") {
          clearLiveBrowserLog();
          setPendingApproval(null);
        } else if (ev === "error") {
          clearLiveBrowserLog();
          const errTxt = String(data.error ?? "Ошибка тестировщика");
          setTesterError(errTxt);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode().replace(/\r\n/g, "\n");
          break;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          if (raw.trim()) processFrame(raw);
        }
      }
      if (buffer.trim()) {
        for (const leftover of buffer.split("\n\n")) {
          if (leftover.trim()) processFrame(leftover);
        }
      }

      if (!persistedByServer && targetConvId && assistantText) {
        await fetch(`/api/agent/conversations/${targetConvId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: "assistant",
            content: assistantText,
            reasoning: assistantReason,
          }),
        }).catch(() => undefined);
      }
      await refreshTesterData(targetConvId);
    } catch (caught) {
      setTesterError(caught instanceof Error ? caught.message : "Не удалось запустить Тестировщика");
    } finally {
      clearLiveBrowserLog();
      setLiveTester(null);
      setTesterDirectRunning(false);
    }
  };

  const addAgentFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0 || running || reading || historyLoading || conversationId === null) return;
      setError(null);
      setReading(true);
      void readOperatorFiles(attachments, incoming, { unlimited })
        .then(({ files, errors }) => {
          if (files.length > 0) setAttachments((prev) => [...prev, ...files]);
          if (errors.length > 0) setError(errors[0]);
        })
        .finally(() => setReading(false));
    },
    [attachments, conversationId, historyLoading, reading, running, unlimited],
  );

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const { files, hasPlainText } = extractClipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    if (!hasPlainText) event.preventDefault();
    addAgentFiles(files);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!dragging) setDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    dragDepthRef.current = 0;
    setDragging(false);
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    const dropped = Array.from(event.dataTransfer.files ?? []);
    if (dropped.length > 0) addAgentFiles(dropped);
  };

  const openUrl = (url: string) => {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    return Boolean(win);
  };

  const send = async (preset?: string) => {
    const typed = (preset ?? text).trim();
    const activeId = conversationId;
    const content =
      typed || (attachments.length > 0 ? "Проанализируй приложенные файлы и коротко перескажи главное." : "");
    if (!content || running || historyLoading || activeId === null) return;
    setError(null);
    setNotice(null);
    if (!preset) setText("");
    const attachedTurn = attachments.map((file) => ({ name: file.name, size: file.size }));
    const userTurn: Turn = {
      id: nextId(),
      role: "user",
      content,
      actions: [],
      files: [],
      attached: attachedTurn,
    };
    const assistantId = nextId();
    const history = [...turns, userTurn];
    setTurns([
      ...history,
      { id: assistantId, role: "assistant", content: "", actions: [], files: [], reasoning: "" },
    ]);
    setRunning(true);
    setStatus("Отправляю агенту…");
    setLiveBrowserLog([]);
    browserRunStartRef.current = 0;
    autoScrollPausedRef.current = false;
    scrollDown(true);

    const patch = (update: (turn: Turn) => Turn) => {
      setTurns((prev) => prev.map((t) => (t.id === assistantId ? update(t) : t)));
    };
    const assistantDraft: {
      content: string;
      reasoning: string;
      actions: AgentAction[];
      files: AgentFile[];
      error: string;
    } = { content: "", reasoning: "", actions: [], files: [], error: "" };
    let userSaved = false;
    let storedUserForRollover: Turn | null = null;
    let sawDone = false;
    const abortCtrl = new AbortController();
    chatAbortRef.current = abortCtrl;

    try {
      setStatus("Сохраняю переписку…");
      const storedUser = await saveConversationMessage(activeId, {
        role: "user",
        content: userTurn.content,
        attachments: attachedTurn,
      });
      userSaved = true;
      storedUserForRollover = storedUser;
      setTurns((prev) => prev.map((turn) => (turn.id === userTurn.id ? storedUser : turn)));
      setConversations((prev) => {
        const current = prev.find((item) => item.id === activeId);
        if (!current) return prev;
        const title = current.title === "Новый чат" ? content.replace(/\s+/g, " ").slice(0, 80) : current.title;
        const updated = { ...current, title, messagesCount: current.messagesCount + 1, updatedAt: new Date().toISOString() };
        return [updated, ...prev.filter((item) => item.id !== activeId)];
      });
      await persistSettings();
      const res = await fetch("/api/ai/agent", {
        method: "POST",
        signal: abortCtrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentConversationId: activeId,
          messages: history.map((t) => ({ role: t.role, content: t.content })),
          settings: { baseUrl: settings.baseUrl, model: settings.model },
          params,
          ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
          trustLevel,
          maxSteps: maxSteps <= 0 ? 0 : Math.floor(maxSteps),
          ragFolderId: ragPrefs.folderId,
          ragFull: ragPrefs.ragFull,
          ragChunks: ragPrefs.ragChunks,
          contextLimit,
          ...(modelCapabilities?.contextLength ? { modelContextLength: modelCapabilities.contextLength } : {}),
          ...(ghAccount && ghAccount.enabled && ghAccount.selectedOwner && ghAccount.selectedRepo
            ? {
                githubEnabled: true,
                githubOwner: ghAccount.selectedOwner,
                githubRepo: ghAccount.selectedRepo,
                githubBranch: ghAccount.selectedBranch || "main",
              }
            : { githubEnabled: false }),
          attachments: attachments.map((file) => ({
            name: file.name,
            note: file.note,
            text: file.text,
            ...(file.image ? { image: file.image } : {}),
          })),
        }),
      });
      setAttachments([]);

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        assistantDraft.error = data.error ?? "Агент недоступен";
        patch((t) => ({ ...t, error: assistantDraft.error }));
        setStatus(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          const lines = raw.split("\n");
          const eventLine = lines.find((line) => line.startsWith("event:"));
          const dataLines = lines.filter((line) => line.startsWith("data:"));
          if (dataLines.length === 0) continue;
          const event = eventLine ? eventLine.slice(6).trim() : "message";
          const dataText = dataLines.map((l) => l.slice(5).trimStart()).join("\n");
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataText) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event === "status") {
            const st = String(data.text ?? "");
            setStatus(st);
            const isBrowserStep =
              data.source === "browser_inspector" ||
              data.tool === "browse_project" ||
              data.tool === "qa_browser_audit";
            if (isBrowserStep && data.done === true) {
              clearLiveBrowserLog();
            } else if (isBrowserStep && st) {
              const isBrowserStart =
                st.startsWith("Вызываю инструмент: browse_project") ||
                st.startsWith("Вызываю инструмент: qa_browser_audit");
              pushLiveBrowserLog(st, isBrowserStart);
            } else if (st) {
              clearLiveBrowserLog();
            }
          } else if (event === "approval_required") {
            const ghPayload =
              data.github && typeof data.github === "object"
                ? (data.github as Record<string, unknown>)
                : undefined;
            const req: PendingApproval = {
              approvalId: String(data.approvalId ?? ""),
              kind: String(data.kind ?? "command"),
              title: String(data.title ?? "Требуется подтверждение"),
              description: String(data.description ?? data.reason ?? ""),
              command: data.command ? String(data.command) : undefined,
              cwd: data.cwd ? String(data.cwd) : undefined,
              url: data.url ? String(data.url) : undefined,
              source: data.source ? String(data.source) : undefined,
              destination: data.destination ? String(data.destination) : undefined,
              mode: data.mode ? String(data.mode) : undefined,
              filesCount: typeof data.filesCount === "number" ? data.filesCount : undefined,
              task: data.task ? String(data.task) : undefined,
              maxSteps: typeof data.maxSteps === "number" ? data.maxSteps : undefined,
              coachAfterEachStep:
                typeof data.coachAfterEachStep === "boolean" ? data.coachAfterEachStep : true,
              operatorTrustLevel: data.operatorTrustLevel ? String(data.operatorTrustLevel) : undefined,
              sandboxProject: data.sandboxProject ? String(data.sandboxProject) : undefined,
              testerRunKey: data.testerRunKey ? String(data.testerRunKey) : undefined,
              testerRunId: typeof data.testerRunId === "number" ? data.testerRunId : undefined,
              testerConversationId:
                typeof data.testerConversationId === "number" ? data.testerConversationId : undefined,
              minorIssues: Array.isArray(data.minorIssues)
                ? (data.minorIssues as TesterIssueItem[])
                : undefined,
              github: ghPayload
                ? {
                    login: ghPayload.login ? String(ghPayload.login) : undefined,
                    authorName: ghPayload.authorName ? String(ghPayload.authorName) : undefined,
                    authorEmail: ghPayload.authorEmail ? String(ghPayload.authorEmail) : undefined,
                    owner: ghPayload.owner ? String(ghPayload.owner) : undefined,
                    repo: ghPayload.repo ? String(ghPayload.repo) : undefined,
                    branch: ghPayload.branch ? String(ghPayload.branch) : undefined,
                    message: ghPayload.message ? String(ghPayload.message) : undefined,
                    push: typeof ghPayload.push === "boolean" ? ghPayload.push : undefined,
                    files: Array.isArray(ghPayload.files) ? ghPayload.files.map(String) : undefined,
                    diffPreview: ghPayload.diffPreview ? String(ghPayload.diffPreview) : undefined,
                    head: ghPayload.head ? String(ghPayload.head) : undefined,
                    base: ghPayload.base ? String(ghPayload.base) : undefined,
                    prTitle: ghPayload.prTitle ? String(ghPayload.prTitle) : undefined,
                    prBody: ghPayload.prBody ? String(ghPayload.prBody) : undefined,
                    draft: typeof ghPayload.draft === "boolean" ? ghPayload.draft : undefined,
                    pullNumber: typeof ghPayload.pullNumber === "number" ? ghPayload.pullNumber : undefined,
                    mergeMethod: ghPayload.mergeMethod ? String(ghPayload.mergeMethod) : undefined,
                    mergeableState: ghPayload.mergeableState ? String(ghPayload.mergeableState) : undefined,
                    url: ghPayload.url ? String(ghPayload.url) : undefined,
                  }
                : undefined,
            };
            setPendingApproval(req);
            setScreenCapture(null);
            setApprovalDest(req.destination ?? "");
            if (req.kind === "call_operator") {
              setApprovalTaskDraft(req.task ?? "");
              setApprovalTaskMode(normalizeTaskMode(req.mode ?? "copilot"));
              setApprovalCoachAfter(req.coachAfterEachStep ?? true);
              setApprovalOpTrust(req.operatorTrustLevel === "full" ? "full" : "verified");
            } else if (req.kind === "capture_screen") {
              setApprovalTaskDraft(req.task ?? req.description ?? "");
              setApprovalOpTrust(req.operatorTrustLevel === "full" ? "full" : "verified");
            } else if (req.kind === "github_commit") {
              setApprovalGhCommitMsg(req.github?.message ?? "");
              setApprovalGhBranch(req.github?.branch ?? "");
            } else if (req.kind === "github_pr") {
              setApprovalGhPrTitle(req.github?.prTitle ?? "");
              setApprovalGhPrBody(req.github?.prBody ?? "");
            } else if (req.kind === "github_merge") {
              const mm = req.github?.mergeMethod;
              setApprovalGhMergeMethod(mm === "squash" || mm === "rebase" ? mm : "merge");
            }
            setLiveTester((prev) =>
              prev ? { ...prev, statusText: "Тестировщик ждёт вашего подтверждения на сайте…" } : prev,
            );
            scrollDown();
          } else if (event === "github") {
            const ghRepoName = `${String(data.owner ?? "")}/${String(data.repo ?? "")}`;
            const ghBr = String(data.branch ?? "main");
            setNotice(
              `GitHub-RAG: ${ghRepoName}@${ghBr} · аккаунт @${String(data.login ?? "")} (${Number(data.fileCount ?? 0)} файлов индекса).`,
            );
          } else if (event === "rag") {
            setNotice(
              `RAG «${String(data.folderName ?? "папка")}»: подключено ${Number(data.hits ?? 0)} из ${Number(data.totalChunks ?? 0)} фрагментов${data.truncated ? " (обрезано по лимиту контекста)" : ""}.`,
            );
          } else if (event === "tester_run") {
            const createdConv =
              data.conversation && typeof data.conversation === "object"
                ? (data.conversation as TesterConversationItem)
                : null;
            const createdRun =
              data.run && typeof data.run === "object" ? (data.run as TesterRunItem) : null;
            if (createdConv) {
              setTesterConversations((prev) => [
                createdConv,
                ...prev.filter((c) => c.id !== createdConv.id),
              ]);
              setSelectedTesterConvId(createdConv.id);
            }
            if (createdRun) {
              setTesterRuns((prev) => [createdRun, ...prev.filter((r) => r.id !== createdRun.id)]);
            }
            setLiveTester({
              runKey: String(data.runKey ?? "default"),
              runId: typeof data.runId === "number" ? data.runId : createdRun?.id,
              testerConversationId:
                typeof data.testerConversationId === "number"
                  ? data.testerConversationId
                  : createdConv?.id,
              sandboxProject: String(createdRun?.sandboxProject ?? data.sandboxProject ?? "."),
              summary: String(createdRun?.summary ?? data.summary ?? ""),
              model: String(createdRun?.model ?? data.model ?? settings.model ?? ""),
              statusText: "Тестировщик запущен в новом чате…",
              reasoning: "",
              content: "",
              browserLog: [],
              actions: [],
            });
          } else if (event === "tester_status") {
            const st = String(data.text ?? "");
            setStatus(st);
            const isBrowserStep =
              data.source === "browser_inspector" ||
              data.tool === "browse_project" ||
              data.tool === "qa_browser_audit";
            if (isBrowserStep && data.done === true) {
              clearLiveBrowserLog();
              setLiveTester((prev) => (prev ? { ...prev, statusText: st, browserLog: [] } : prev));
            } else if (isBrowserStep && st) {
              const isBrowserStart =
                st.startsWith("Тестировщик: browse_project") ||
                st.startsWith("Тестировщик: qa_browser_audit");
              const logLine = pushLiveBrowserLog(st, isBrowserStart);
              setLiveTester((prev) =>
                prev
                  ? {
                      ...prev,
                      statusText: st,
                      browserLog: (isBrowserStart ? [] : prev.browserLog ?? []).concat(logLine).slice(-60),
                    }
                  : prev,
              );
            } else {
              if (st) clearLiveBrowserLog();
              setLiveTester((prev) =>
                prev
                  ? {
                      ...prev,
                      statusText: st,
                      ...(st ? { browserLog: [] } : {}),
                    }
                  : prev,
              );
            }
          } else if (event === "tester_reasoning") {
            const r = String(data.text ?? "");
            setLiveTester((prev) => (prev ? { ...prev, reasoning: r } : prev));
          } else if (event === "tester_text") {
            const c = String(data.text ?? "");
            setLiveTester((prev) => (prev ? { ...prev, content: c } : prev));
          } else if (event === "tester_action") {
            const act =
              data.action && typeof data.action === "object"
                ? (data.action as Record<string, unknown>)
                : null;
            if (act) {
              const actType = String(act.type ?? "qa_check");
              if (actType === "browser_inspect") {
                clearLiveBrowserLog();
              }
              setLiveTester((prev) =>
                prev
                  ? {
                      ...prev,
                      ...(actType === "browser_inspect" ? { browserLog: [] } : {}),
                      actions: [
                        ...prev.actions,
                        {
                          type: actType,
                          label: act.label ? String(act.label) : undefined,
                          command: act.command ? String(act.command) : undefined,
                          url: act.url ? String(act.url) : undefined,
                          action: act.action ? String(act.action) : undefined,
                          viewport: act.viewport ? String(act.viewport) : undefined,
                          summary: act.summary ? String(act.summary) : undefined,
                          error: act.error ? String(act.error) : undefined,
                          errorsCount: typeof act.errorsCount === "number" ? act.errorsCount : undefined,
                          issuesCount: typeof act.issuesCount === "number" ? act.issuesCount : undefined,
                          animationsCount: typeof act.animationsCount === "number" ? act.animationsCount : undefined,
                        },
                      ],
                    }
                  : prev,
              );
            }
          } else if (event === "tester_done") {
            clearLiveBrowserLog();
            const savedRun =
              data.run && typeof data.run === "object" ? (data.run as TesterRunItem) : null;
            if (savedRun) {
              setTesterRuns((prev) => [savedRun, ...prev.filter((r) => r.id !== savedRun.id)]);
            }
            const tConvId =
              typeof data.testerConversationId === "number"
                ? data.testerConversationId
                : savedRun?.testerConversationId;
            setLiveTester(null);
            if (tConvId) {
              void refreshTesterData(tConvId);
            } else {
              void refreshTesterData();
            }
          } else if (event === "tester_decision") {
            const updRun =
              data.run && typeof data.run === "object" ? (data.run as TesterRunItem) : null;
            if (updRun) {
              setTesterRuns((prev) => prev.map((r) => (r.id === updRun.id ? updRun : r)));
            }
          } else if (event === "reasoning") {
            assistantDraft.reasoning = String(data.text ?? "");
            patch((t) => ({ ...t, reasoning: assistantDraft.reasoning }));
            scrollDown();
          } else if (event === "text") {
            clearLiveBrowserLog();
            assistantDraft.content = String(data.text ?? "");
            patch((t) => ({ ...t, content: assistantDraft.content }));
            scrollDown();
          } else if (event === "error") {
            clearLiveBrowserLog();
            assistantDraft.error = String(data.error ?? "Ошибка агента");
            patch((t) => ({ ...t, error: assistantDraft.error }));
            setStatus(null);
          } else if (event === "action") {
            if (data.type === "file") {
              const file: AgentFile = {
                name: String(data.name ?? "файл"),
                mime: String(data.mime ?? "application/octet-stream"),
                size: Number(data.size ?? 0),
                data: String(data.data ?? ""),
              };
              assistantDraft.files.push(file);
              patch((t) => ({ ...t, files: [...t.files, file] }));
            } else if (data.type === "open_url") {
              const proxied = toSandboxProxyUrl(
                String(data.url ?? ""),
                typeof data.port === "number" ? data.port : null,
              );
              const openTarget = proxied ?? String(data.url ?? "");
              const action: AgentAction = {
                type: "open_url",
                url: openTarget,
                port: typeof data.port === "number" ? data.port : undefined,
                label: String(data.label ?? data.url ?? ""),
                autoplay: Boolean(data.autoplay),
              };
              assistantDraft.actions.push(action);
              patch((t) => ({ ...t, actions: [...t.actions, action] }));
              if (action.url) openUrl(action.url);
            } else {
              const action: AgentAction = {
                type: String(data.type ?? "command_result") as AgentAction["type"],
                action: data.action ? String(data.action) : undefined,
                kind: data.kind ? String(data.kind) : undefined,
                label: String(
                  data.label ??
                    data.title ??
                    data.url ??
                    data.command ??
                    data.project ??
                    data.path ??
                    data.source ??
                    data.task ??
                    "",
                ),
                url: data.url ? String(data.url) : undefined,
                previewUrl: data.previewUrl ? String(data.previewUrl) : undefined,
                port: typeof data.port === "number" ? data.port : undefined,
                background: typeof data.background === "boolean" ? data.background : undefined,
                title: data.title ? String(data.title) : undefined,
                viewport: data.viewport ? String(data.viewport) : undefined,
                command: data.command ? String(data.command) : undefined,
                cwd: data.cwd ? String(data.cwd) : undefined,
                exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined,
                output: data.output ? String(data.output) : undefined,
                path: data.path ? String(data.path) : undefined,
                project: data.project ? String(data.project) : undefined,
                source: data.source ? String(data.source) : undefined,
                destination: data.destination ? String(data.destination) : undefined,
                mode: data.mode ? String(data.mode) : undefined,
                filesCount: typeof data.filesCount === "number" ? data.filesCount : undefined,
                taskId: typeof data.taskId === "number" ? data.taskId : undefined,
                task: data.task ? String(data.task) : undefined,
                goal: data.goal ? String(data.goal) : undefined,
                maxSteps: typeof data.maxSteps === "number" ? data.maxSteps : undefined,
                coachMode: data.coachMode ? String(data.coachMode) : undefined,
                notes: data.notes ? String(data.notes) : undefined,
                operatorTrustLevel: data.operatorTrustLevel ? String(data.operatorTrustLevel) : undefined,
                summary: data.summary ? String(data.summary) : undefined,
                hasImage: typeof data.hasImage === "boolean" ? data.hasImage : undefined,
                issuesCount: typeof data.issuesCount === "number" ? data.issuesCount : undefined,
                animationsCount: typeof data.animationsCount === "number" ? data.animationsCount : undefined,
                errorsCount: typeof data.errorsCount === "number" ? data.errorsCount : undefined,
                error: data.error ? String(data.error) : undefined,
                trace: Array.isArray(data.trace) ? data.trace.map(String).slice(-80) : undefined,
                preview: typeof data.preview === "string" && data.preview.startsWith("data:image/") ? data.preview : undefined,
                owner: data.owner ? String(data.owner) : undefined,
                repo: data.repo ? String(data.repo) : undefined,
                branch: data.branch ? String(data.branch) : undefined,
                sha: data.sha ? String(data.sha) : undefined,
                number: typeof data.number === "number" ? data.number : undefined,
                method: data.method ? String(data.method) : undefined,
                pushed: typeof data.pushed === "boolean" ? data.pushed : undefined,
                authorLogin: data.authorLogin ? String(data.authorLogin) : undefined,
                message: data.message ? String(data.message) : undefined,
                head: data.head ? String(data.head) : undefined,
                base: data.base ? String(data.base) : undefined,
                bytes: typeof data.bytes === "number" ? data.bytes : undefined,
                runKey: data.runKey ? String(data.runKey) : undefined,
                runId: typeof data.runId === "number" ? data.runId : undefined,
                testerConversationId:
                  typeof data.testerConversationId === "number" ? data.testerConversationId : undefined,
                sandboxProject: data.sandboxProject ? String(data.sandboxProject) : undefined,
                status: data.status ? String(data.status) : undefined,
                reportSummary: data.reportSummary ? String(data.reportSummary) : undefined,
                criticalCount: typeof data.criticalCount === "number" ? data.criticalCount : undefined,
                minorCount: typeof data.minorCount === "number" ? data.minorCount : undefined,
                minorDecision: data.minorDecision ? String(data.minorDecision) : undefined,
                totalTokens: typeof data.totalTokens === "number" ? data.totalTokens : undefined,
                approved: typeof data.approved === "boolean" ? data.approved : undefined,
              };
              assistantDraft.actions.push(action);
              patch((t) => ({ ...t, actions: [...t.actions, action] }));
              if (action.type === "browser_inspect") {
                clearLiveBrowserLog();
              }
              if (action.type === "operator_task" && action.taskId) {
                void refreshOpTask(action.taskId);
              }
              if (action.type === "operator_plan" && action.task) {
                setOpDraftPrompt(action.task);
                setOpDraftMode(normalizeTaskMode(action.mode));
                setOpDraftSteps(action.maxSteps ?? 30);
                setOpDraftNotes(action.notes ?? "");
              }
              void refreshSandbox(false);
            }
            scrollDown();
          } else if (event === "done") {
            sawDone = true;
            setStatus(null);
            setPendingApproval(null);
            setScreenCapture(null);
            setLiveTester(null);
            setLiveBrowserLog([]);
            browserRunStartRef.current = 0;
            void refreshSandbox(true);
          }
        }
      }
      if (
        !sawDone &&
        !assistantDraft.error &&
        !assistantDraft.content.trim() &&
        assistantDraft.actions.length === 0 &&
        assistantDraft.files.length === 0
      ) {
        assistantDraft.error = "Поток ответа от агента оборвался без завершения";
        patch((t) => ({ ...t, error: assistantDraft.error }));
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        if (!assistantDraft.content.trim()) {
          assistantDraft.content = "Выполнение остановлено пользователем.";
          patch((t) => ({ ...t, content: assistantDraft.content }));
        }
      } else {
        assistantDraft.error = userSaved
          ? "Соединение с агентом прервалось"
          : caught instanceof Error
            ? caught.message
            : "Не удалось сохранить сообщение";
        patch((t) => ({ ...t, error: assistantDraft.error }));
      }
    } finally {
      chatAbortRef.current = null;
      let updatedTurns = history;
      if (userSaved) {
        try {
          const persistedActions = assistantDraft.actions.map((act) => {
            if (!act.preview) return act;
            const copy = { ...act };
            delete copy.preview;
            return copy;
          });
          const storedAssistant = await saveConversationMessage(activeId, {
            role: "assistant",
            content: assistantDraft.content,
            reasoning: assistantDraft.reasoning,
            error: assistantDraft.error,
            actions: persistedActions,
            files: assistantDraft.files.map(({ name, mime, size }) => ({ name, mime, size })),
          });
          const mergedAssistant: Turn = {
            ...storedAssistant,
            actions: assistantDraft.actions.length > 0 ? assistantDraft.actions : storedAssistant.actions,
            files: assistantDraft.files.length > 0 ? assistantDraft.files : storedAssistant.files,
          };
          updatedTurns = [
            ...turns,
            storedUserForRollover ?? history[history.length - 1],
            mergedAssistant,
          ];
          setTurns((prev) => prev.map((turn) => (turn.id === assistantId ? mergedAssistant : turn)));
          setConversations((prev) => {
            const current = prev.find((item) => item.id === activeId);
            if (!current) return prev;
            const updated = { ...current, messagesCount: current.messagesCount + 1, updatedAt: new Date().toISOString() };
            return [updated, ...prev.filter((item) => item.id !== activeId)];
          });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Не удалось сохранить ответ агента");
        }
      }
      setRunning(false);
      setPendingApproval(null);
      setScreenCapture(null);
      setLiveTester(null);
      setLiveBrowserLog([]);
      browserRunStartRef.current = 0;
      setStatus(null);
      scrollDown();

      // Автоматически переводим переписку в Summary + новый чат при достижении 80% лимита.
      if (userSaved && !assistantDraft.error && contextLimit > 0) {
        const nextTokens = estimateAgentConversationTokens(turnsToTranscript(updatedTurns));
        if (shouldAutoRollover(nextTokens, contextLimit, updatedTurns.length)) {
          await rolloverToSummaryChat(updatedTurns, "auto");
        }
      }
    }
  };

  const normalized = settings.baseUrl.replace(/\/+$/, "");
  const activeProvider =
    PROVIDERS.find((provider) => provider.baseUrl && provider.baseUrl === normalized)?.id ?? "custom";
  const remoteApi = Boolean(normalized) && !isLocalOrLanUrl(normalized);

  const applyProvider = (id: string) => {
    const provider = PROVIDERS.find((item) => item.id === id);
    if (!provider || id === "custom") return;
    saveSettings({
      ...settings,
      baseUrl: provider.baseUrl,
      model: provider.model || settings.model,
    });
  };

  const available = health?.available ?? false;
  const tools = useMemo(() => health?.tools ?? [], [health]);
  const activeRagFolder = useMemo(
    () => ragFolders.find((folder) => folder.id === ragPrefs.folderId) ?? null,
    [ragFolders, ragPrefs.folderId],
  );
  const trustMeta = findTrustLevel(trustLevel);
  const modelCapabilities = useMemo(
    () => pickCapabilitiesForModel(capabilitiesByModel, settings.model),
    [capabilitiesByModel, settings.model],
  );
  const isTabs = layoutMode === "tabs";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold text-amber-500">
          <Sparkles size={13} /> Агент
        </span>
        <span
          title={health?.hint || (available ? "Локальный Python-агент отвечает" : undefined)}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium",
            health === null
              ? "bg-card2 text-muted"
              : available
                ? "bg-emerald-500/15 text-emerald-500"
                : "bg-red-500/15 text-red-500",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              health === null ? "bg-muted" : available ? "bg-emerald-500" : "bg-red-500",
            )}
          />
          {health === null ? "проверяю…" : available ? "агент онлайн" : "агент не запущен"}
        </span>
        {opBotStatus && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
              opBotStatus.connected
                ? "bg-cyan-500/15 text-cyan-400"
                : "bg-card2 text-muted",
            )}
            title="Статус настольного Оператора ПК"
          >
            <MonitorCog size={11} />
            {opBotStatus.connected ? "Оператор ПК: онлайн" : "Оператор ПК: не в сети"}
          </span>
        )}
        <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-medium", trustMeta.badgeClass)}>
          {trustMeta.shortLabel}
        </span>
        <button
          type="button"
          onClick={() => {
            if (isTabs) setActiveTab("knowledge");
          }}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition",
            ghAccount && ghAccount.enabled && ghAccount.selectedRepo
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
              : ghAccount
                ? "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                : "border-border bg-card2 text-muted hover:text-text",
          )}
          title="Открыть настройки GitHub-RAG и привязанного аккаунта"
        >
          <GithubIcon size={11} />
          {ghAccount
            ? ghAccount.selectedRepo
              ? `@${ghAccount.login} · ${ghAccount.selectedOwner}/${ghAccount.selectedRepo}@${ghAccount.selectedBranch || "main"}`
              : `GitHub @${ghAccount.login} · выберите репо`
            : "Подключить GitHub"}
        </button>
        {health?.endpoint && <span className="text-muted">· {health.endpoint}</span>}
        <div
          role="group"
          aria-label="Режим отображения агента"
          className="ml-auto flex items-center rounded-lg border border-border bg-card p-0.5 text-[10px]"
        >
          <button
            type="button"
            aria-pressed={isTabs}
            onClick={() => setLayoutMode("tabs")}
            className={cn(
              "rounded-md px-2 py-0.5 font-medium transition",
              isTabs ? "bg-accent/20 text-text" : "text-muted hover:text-text",
            )}
            title="Упорядоченный вид по вкладкам с чатом на последней вкладке"
          >
            По вкладкам
          </button>
          <button
            type="button"
            aria-pressed={!isTabs}
            onClick={() => setLayoutMode("classic")}
            className={cn(
              "rounded-md px-2 py-0.5 font-medium transition",
              !isTabs ? "bg-accent/20 text-text" : "text-muted hover:text-text",
            )}
            title="Классический вид: все настройки и чат на одном экране"
          >
            Классический вид
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setHealth(null);
            void loadHealth().then(setHealth);
            void refreshSandbox(true);
            void refreshOperatorOverview();
          }}
          className="rounded-lg border border-border bg-card px-2 py-1 font-medium text-muted transition hover:text-text"
        >
          Проверить
        </button>
      </div>

      {isTabs && (
        <div
          role="tablist"
          aria-label="Разделы агента"
          className="flex gap-1 overflow-x-auto rounded-2xl border border-border bg-card p-1"
        >
          {AGENT_TABS.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveTab(tab.id)}
                title={tab.hint}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition",
                  selected
                    ? "bg-gradient-to-r from-accent/25 to-transparent text-text ring-1 ring-accent/30"
                    : "text-muted hover:bg-card2 hover:text-text",
                )}
              >
                <span>{tab.label}</span>
                {tab.id === "workspace" && (opTask || (sandbox?.items?.length ?? 0) > 0) && (
                  <span className="rounded bg-card2 px-1 py-0.5 text-[10px] text-muted">
                    {opTask ? `#${opTask.id}` : sandbox?.items?.length ?? 0}
                  </span>
                )}
                {tab.id === "tester" && (liveTester || testerRuns.length > 0) && (
                  <span
                    className={cn(
                      "rounded px-1 py-0.5 text-[10px]",
                      liveTester
                        ? "bg-violet-500/20 text-violet-300"
                        : "bg-card2 text-muted",
                    )}
                  >
                    {liveTester ? "…" : testerRuns.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Вкладка 1: Модель, подключение и параметры генерации */}
      <div
        role={isTabs ? "tabpanel" : undefined}
        aria-label="Модель и генерация"
        hidden={isTabs && activeTab !== "model"}
        className="space-y-3"
      >
        {health !== null && !available && (
          <div className="rounded-2xl border border-border bg-card p-3 text-[11px] text-muted">
            <p className="flex items-center gap-1.5 font-semibold text-text">
              <PlugZap size={13} className="text-amber-500" /> Как включить агента
            </p>
            <p className="mt-1">{health?.hint ?? "Агент — отдельный процесс на Python."}</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-card2 px-2 py-1.5 text-[11px] text-text">python3 agent/agent.py</pre>
            <p className="mt-1">
              Он использует тот же OpenAI-совместимый сервер, что и чат: адрес, ключ и модель берутся из настроек ниже.
            </p>
          </div>
        )}

        <div className="rounded-2xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5 text-[11px] text-muted">
            <label className="flex items-center gap-1.5">
              Провайдер
              <select
                value={activeProvider}
                onChange={(e) => applyProvider(e.target.value)}
                className="h-8 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[10px]">
              {remoteApi
                ? "облачный API: ключ нужен и уходит в запросе, в базу не пишется"
                : "локальная модель: ключ обычно не нужен"}
            </span>
            <button
              type="button"
              onClick={() => void refreshModelsAndCapabilities()}
              disabled={checkingModels || running}
              className="ml-auto flex h-7 items-center gap-1 rounded-lg border border-border bg-card2 px-2 text-[10px] font-medium text-text transition hover:border-accent/50 disabled:opacity-40"
              title="Получить список моделей с сервера и определить их возможности (reasoning / vision / tools / контекст)"
            >
              {checkingModels ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              Подтянуть модели
            </button>
          </div>

          <div className="grid gap-2 p-3 sm:grid-cols-3">
            <label className="text-[11px] text-muted">
              Base URL
              <input
                value={settings.baseUrl}
                onChange={(e) => saveSettings({ ...settings, baseUrl: e.target.value })}
                onBlur={() => void persistSettings()}
                placeholder={AI_DEFAULT_BASE_URL}
                className="mt-1 h-8 w-full rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
              />
            </label>
            <div className="text-[11px] text-muted">
              <div className="flex items-center justify-between gap-2">
                <span>Модель</span>
                {availableModels.length > 0 && (
                  <span className="text-[10px] text-emerald-500">{availableModels.length} доступно</span>
                )}
              </div>
              <div className="mt-1 flex gap-1">
                {availableModels.length > 0 && (
                  <select
                    aria-label="Выбрать модель из списка сервера"
                    value={availableModels.includes(settings.model) ? settings.model : ""}
                    onChange={(e) => {
                      if (e.target.value) saveSettings({ ...settings, model: e.target.value });
                    }}
                    className="h-8 max-w-[50%] rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
                  >
                    <option value="">список…</option>
                    {availableModels.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {modelId}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  aria-label="Модель"
                  value={settings.model}
                  onChange={(e) => saveSettings({ ...settings, model: e.target.value })}
                  onBlur={() => void persistSettings()}
                  placeholder="например, qwen3:8b"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
                />
              </div>
            </div>
            <div className="text-[11px] text-muted">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="agent-api-key">API-ключ (если нужен)</label>
                {serverMeta.hasApiKey && (
                  <button
                    type="button"
                    onClick={() => void clearSavedKey()}
                    className="text-[10px] text-red-400 hover:underline"
                  >
                    Удалить ({serverMeta.apiKeyHint ?? "активен"})
                  </button>
                )}
              </div>
              <input
                id="agent-api-key"
                value={settings.apiKey}
                onChange={(e) => saveSettings({ ...settings, apiKey: e.target.value })}
                onBlur={() => void persistSettings()}
                type="password"
                placeholder={
                  serverMeta.hasApiKey
                    ? `Сохранён на сервере (${serverMeta.apiKeyHint ?? "sk-•••"})`
                    : "необязательно"
                }
                className="mt-1 h-8 w-full rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
              />
            </div>
          </div>
        </div>

        <GenSettings
          value={params}
          onChange={setParams}
          defaultOpen
          capabilities={modelCapabilities}
          unlimited={unlimited}
          modelName={settings.model}
          onRefreshCapabilities={() => void refreshModelsAndCapabilities()}
          refreshingCapabilities={checkingModels}
          subtitle="Режимы раздумий подтягиваются под возможности выбранной модели. Пустое поле — параметр не передаём."
        >
          <div className="space-y-2.5">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
                <label htmlFor="agent-system-prompt" className="font-medium text-text">
                  Системный промпт агента
                </label>
                <div className="flex items-center gap-2 text-[10px]">
                  <span>{unlimited ? `${systemPrompt.length} симв. · без лимита` : `${systemPrompt.length}/12000`}</span>
                  {systemPrompt.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSystemPrompt("")}
                      className="text-red-500 hover:underline"
                    >
                      Очистить
                    </button>
                  )}
                </div>
              </div>
              <Textarea
                id="agent-system-prompt"
                value={systemPrompt}
                onChange={(event) =>
                  setSystemPrompt(unlimited ? event.target.value : event.target.value.slice(0, 12_000))
                }
                rows={3}
                placeholder="Дополнительные правила для Агента: роль, стиль отчётов, формат кода, ограничения…"
                className="text-[11px]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <label className="flex items-center gap-1.5 text-text">
                <input
                  type="checkbox"
                  checked={maxSteps <= 0}
                  onChange={(event) => setMaxSteps(event.target.checked ? 0 : 20)}
                  className="h-3.5 w-3.5 accent-[#7c5cff]"
                />
                Без лимита шагов
              </label>
              {maxSteps > 0 ? (
                <>
                  <Input
                    type="number"
                    min={1}
                    aria-label="Лимит шагов агента"
                    value={maxSteps}
                    onChange={(event) => setMaxSteps(Math.max(1, Math.floor(Number(event.target.value) || 1)))}
                    className="h-8 w-24 px-2 text-[11px]"
                  />
                  <span className="text-[10px]">
                    ограничение вызовов инструментов (для главного админа потолка нет)
                  </span>
                </>
              ) : (
                <span className="text-[10px] text-emerald-500">
                  Главный администратор: ограничений на шаги нет
                </span>
              )}
            </div>
          </div>
        </GenSettings>
      </div>

      {/* Вкладка 2: Доверие, контекст, RAG и архив переписок */}
      <div
        role={isTabs ? "tabpanel" : undefined}
        aria-label="Доверие и RAG"
        hidden={isTabs && activeTab !== "knowledge"}
        className="space-y-3"
      >
        {/* Выбор уровня доверия ИИ */}
        <TrustSelector value={trustLevel} onChange={setTrustLevel} disabled={running} />

        {/* Индикатор контекста и панель RAG-папок */}
        <div className="grid gap-2 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-2.5 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-medium text-text">
                <Gauge size={13} className="text-accent2" /> Контекст чата
              </span>
              <label className="flex items-center gap-1 text-[10px] text-muted">
                лимит
                <Input
                  type="number"
                  min={0}
                  step={512}
                  value={contextLimit}
                  onChange={(e) => setContextLimit(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  className="h-6 w-20 px-1.5 text-[10px]"
                />
              </label>
            </div>
            {contextLimit > 0 ? (
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between text-[10px] text-muted">
                  <span>≈{usedTokens} / {contextLimit} токенов</span>
                  <span>{contextPercent}% (авто-Summary на 80%)</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-card2">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      contextPercent >= 80 ? "bg-amber-500" : "bg-emerald-500",
                    )}
                    style={{ width: `${Math.max(contextPercent, 2)}%` }}
                  />
                </div>
              </div>
            ) : (
              <p className="mt-1.5 text-[10px] text-muted">Автопереход по лимиту отключён (лимит = 0).</p>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-2.5 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-medium text-text">
                <FolderOpen size={13} className="text-accent2" /> RAG-база знаний
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRagOpen((v) => !v)}
                  className="text-[10px] font-medium text-accent2 hover:underline"
                >
                  {ragOpen ? "Скрыть" : activeRagFolder ? `${activeRagFolder.chunksCount} фрагм.` : "Настроить"}
                </button>
                <button
                  type="button"
                  onClick={() => setTranscriptsOpen((v) => !v)}
                  className="text-[10px] font-medium text-accent2 hover:underline"
                >
                  Архив ({transcripts.length})
                </button>
              </div>
            </div>
            <p className="mt-1 truncate text-[10px] text-muted">
              {activeRagFolder
                ? `${activeRagFolder.name} · ${activeRagFolder.filesCount} файлов${ragPrefs.ragFull ? " · вся база" : ` · до ${ragPrefs.ragChunks} фрагм.`}`
                : "Папка не выбрана — можно загрузить папку любого размера"}
            </p>
          </div>
        </div>

        {/* Подключение персонального GitHub-аккаунта (GitHub-RAG, правки кода, Commit / PR / Merge) */}
        <GithubIntegrationPanel
          account={ghAccount}
          oauthAvailable={ghOauthAvailable}
          disabled={running}
          onAccountChange={setGhAccount}
          onNotify={(msg) => setNotice(msg)}
        />

      {/* Панель настройки RAG-папки */}
      {ragOpen && (
        <div className="space-y-2 rounded-2xl border border-border bg-card p-3 text-[11px]">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={ragDirRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => void uploadRagFolder(event)}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            />
            <button
              type="button"
              onClick={() => ragDirRef.current?.click()}
              disabled={ragBusy || running}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card2 px-2.5 py-1.5 font-medium text-text hover:border-accent/50 disabled:opacity-50"
            >
              {ragBusy ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
              Загрузить папку в RAG
            </button>
            <button
              type="button"
              onClick={() => void refreshRagFolders()}
              disabled={ragBusy}
              className="flex items-center gap-1 rounded-lg border border-border bg-card2 px-2 py-1.5 text-muted hover:text-text"
              title="Обновить список RAG-папок"
            >
              <RefreshCw size={12} />
            </button>
            <select
              aria-label="Выбор RAG-папки"
              value={ragPrefs.folderId || ""}
              onChange={(e) => setRagPrefs({ ...ragPrefs, folderId: Number(e.target.value) || 0 })}
              className="h-8 min-w-[180px] flex-1 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text"
            >
              <option value="">Без RAG-папки</option>
              {ragFolders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name} ({folder.filesCount} файлов · {folder.chunksCount} фрагм. · {formatBytes(folder.chars)})
                </option>
              ))}
            </select>
          </div>
          {ragProgress && (
            <p className="text-[10px] text-muted">
              {ragProgress.phase === "read" ? "Читаем файлы" : "Загружаем в базу"}: {ragProgress.done}/{ragProgress.total}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <label className="flex items-center gap-1.5 text-muted">
              Фрагментов на запрос
              <Input
                type="number"
                min={0}
                max={unlimited ? undefined : 500}
                disabled={ragPrefs.ragFull}
                value={ragPrefs.ragChunks}
                onChange={(e) => {
                  const next = Math.max(0, Number(e.target.value) || 0);
                  setRagPrefs({ ...ragPrefs, ragChunks: unlimited ? next : Math.min(500, next) });
                }}
                className="h-7 w-16 px-1.5 text-[11px]"
              />
            </label>
            <label className="flex items-center gap-1.5 text-muted">
              <input
                type="checkbox"
                checked={ragPrefs.ragFull}
                onChange={(e) => setRagPrefs({ ...ragPrefs, ragFull: e.target.checked })}
                className="h-3.5 w-3.5 accent-[#7c5cff]"
              />
              <span>Вся база: отдавать весь индекс папки в контекст без обрезки</span>
            </label>
          </div>
        </div>
      )}

      {/* Архив переписок (.md) */}
      {transcriptsOpen && (
        <div className="space-y-2 rounded-2xl border border-border bg-card p-3 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-text">Сохранённые переписки агента (.md)</span>
            <button
              type="button"
              onClick={() => void refreshTranscripts()}
              className="text-[10px] text-accent2 hover:underline"
            >
              Обновить
            </button>
          </div>
          {transcripts.length === 0 ? (
            <p className="text-[10px] text-muted">
              Сохранённых переписок пока нет. Они появляются автоматически при достижении 80% лимита
              контекста или по кнопке «Сжать в Summary и новый чат».
            </p>
          ) : (
            <div className="max-h-48 space-y-1.5 overflow-y-auto">
              {transcripts.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card2 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-text">{item.fileName}</p>
                    <p className="truncate text-[10px] text-muted">
                      {item.title} · {formatBytes(item.chars)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <a
                      href={`/api/agent/transcripts/${item.id}?download=1`}
                      download={item.fileName}
                      className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[10px] text-text hover:border-accent/50"
                    >
                      <Download size={11} /> Скачать
                    </a>
                    <button
                      type="button"
                      onClick={() => void attachTranscript(item)}
                      className="flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[10px] font-medium text-accent2 hover:bg-accent/20"
                    >
                      <Paperclip size={11} /> Приложить в чат
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      {/* Вкладка 3: Sandbox и Оператор */}
      <div
        role={isTabs ? "tabpanel" : undefined}
        aria-label="Sandbox и Оператор"
        hidden={isTabs && activeTab !== "workspace"}
        className="space-y-3"
      >
        <div className="rounded-xl border border-border bg-card p-2.5 text-[11px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-medium text-text">
              <Terminal size={13} className="text-accent2" /> Sandbox и Оператор ПК
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOpBridgeOpen((v) => !v)}
                className="flex items-center gap-1 text-[10px] font-medium text-cyan-400 hover:underline"
              >
                <MonitorCog size={11} /> Оператор{opTask ? ` #${opTask.id}` : ""}
              </button>
              <button
                type="button"
                onClick={() => setSandboxOpen((v) => !v)}
                className="text-[10px] font-medium text-accent2 hover:underline"
              >
                Sandbox ({sandbox?.items?.length ?? 0})
              </button>
            </div>
          </div>
          <p className="mt-1 truncate text-[10px] text-muted">
            Проекты: {sandbox?.projects?.length ? sandbox.projects.map((p) => p.name).join(", ") : "пока пусто"} · процессов:{" "}
            {sandbox?.processes?.filter((p) => p.alive).length ?? 0}
          </p>
          {((sandbox?.projects?.length ?? 0) > 0 || sandbox?.processes?.some((p) => p.alive)) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
              {sandbox?.projects?.map((proj) => (
                <a
                  key={`quick-proj-${proj.name}`}
                  href={`/api/ai/agent/sandbox/preview/${encodeURIComponent(proj.name)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Открыть проект Sandbox в браузере (работает и в LAN)"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-accent2 hover:border-accent/50 hover:underline"
                >
                  Открыть {proj.name}
                  <ExternalLink size={10} />
                </a>
              ))}
              {sandbox?.processes
                ?.filter((p) => p.alive)
                .map((proc) => {
                  const proxyUrl = toSandboxProxyUrl(proc.url, proc.port);
                  if (!proxyUrl) return null;
                  return (
                    <a
                      key={`quick-proc-${proc.pid}`}
                      href={proxyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-400 hover:bg-emerald-500/20"
                    >
                      Сервер :{proc.port ?? extractPortFromLocalUrl(proc.url)}
                      <ExternalLink size={10} />
                    </a>
                  );
                })}
            </div>
          )}
        </div>

      {/* Встроенное превью проекта Sandbox прямо в CRM */}
      {sandboxPreview && (
        <div className="space-y-2 rounded-2xl border border-accent/40 bg-card p-3 text-[11px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-semibold text-text">
              <Compass size={13} className="text-accent2" />
              Превью Sandbox: {sandboxPreview.title}
            </span>
            <div className="flex items-center gap-2">
              <a
                href={sandboxPreview.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 rounded-lg border border-accent/40 bg-accent/10 px-2 py-1 text-[10px] font-medium text-accent2 hover:bg-accent/20"
              >
                <ExternalLink size={11} /> Открыть в новой вкладке
              </a>
              <button
                type="button"
                onClick={() => setSandboxPreview(null)}
                className="rounded-lg border border-border bg-card2 px-2 py-1 text-[10px] text-muted hover:text-text"
              >
                Закрыть
              </button>
            </div>
          </div>
          <iframe
            title={`Превью ${sandboxPreview.title}`}
            src={sandboxPreview.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            className="h-[420px] w-full rounded-xl border border-border bg-white"
          />
        </div>
      )}

      {/* Панель Sandbox и переноса файлов наружу */}
      {sandboxOpen && (
        <div className="space-y-2.5 rounded-2xl border border-border bg-card p-3 text-[11px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-text">
              Изолированная папка Sandbox {sandbox?.root ? `(${sandbox.root})` : ""}
            </span>
            <div className="flex items-center gap-2">
              <a
                href="/api/ai/agent/sandbox?download=."
                className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-500 hover:bg-emerald-500/20"
              >
                <FileArchive size={12} /> Скачать всё (.zip)
              </a>
              <button
                type="button"
                onClick={() => void refreshSandbox(true)}
                className="rounded-lg border border-border bg-card2 px-2 py-1 text-[10px] text-muted hover:text-text"
              >
                Обновить
              </button>
            </div>
          </div>

          {sandbox?.projects && sandbox.projects.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {sandbox.projects.map((proj) => {
                const previewUrl = `/api/ai/agent/sandbox/preview/${encodeURIComponent(proj.name)}`;
                return (
                  <div
                    key={proj.name}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-card2 px-2 py-1 text-[10px]"
                  >
                    <span className="font-medium text-text">
                      {proj.name}
                      {typeof proj.files === "number" ? ` (${proj.files} ф.)` : ""}
                    </span>
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 font-medium text-accent2 hover:underline"
                    >
                      <ExternalLink size={10} /> Открыть
                    </a>
                    <button
                      type="button"
                      onClick={() => setSandboxPreview({ title: proj.name, url: previewUrl })}
                      className="text-sky-400 hover:underline"
                    >
                      превью
                    </button>
                    <a
                      href={`/api/ai/agent/sandbox?download=${encodeURIComponent(proj.name)}`}
                      className="text-emerald-500 hover:underline"
                    >
                      ZIP
                    </a>
                    <button
                      type="button"
                      onClick={() => setExportSource(proj.name)}
                      className="text-muted hover:text-text hover:underline"
                    >
                      экспорт
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {sandbox?.items && sandbox.items.length > 0 ? (
            <div className="max-h-36 overflow-y-auto rounded-lg border border-border bg-card2/50 p-2 font-mono text-[10px] text-muted">
              {sandbox.items.slice(0, 60).map((it) => (
                <div key={it.path} className="flex items-center justify-between gap-2 py-0.5">
                  <span className="truncate">{it.path}{it.isDir ? "/" : ""}</span>
                  {!it.isDir && <span className="shrink-0">{formatBytes(it.size)}</span>}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-muted">В Sandbox пока нет файлов.</p>
          )}

          {sandbox?.processes && sandbox.processes.some((p) => p.alive) && (
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-text">Фоновые процессы в Sandbox:</p>
              {sandbox.processes
                .filter((p) => p.alive)
                .map((proc) => {
                  const proxyUrl = toSandboxProxyUrl(proc.url, proc.port);
                  return (
                    <div
                      key={proc.pid}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card2 px-2 py-1 text-[10px]"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">
                        PID {proc.pid}: {proc.command}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {proxyUrl && (
                          <>
                            <a
                              href={proxyUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-400 hover:bg-emerald-500/20"
                            >
                              <ExternalLink size={10} /> Открыть
                            </a>
                            <button
                              type="button"
                              onClick={() => setSandboxPreview({ title: `Процесс :${proc.port ?? proc.pid}`, url: proxyUrl })}
                              className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-sky-400 hover:bg-sky-500/20"
                            >
                              Превью
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => void stopSandboxProcess(proc.pid)}
                          disabled={sandboxBusy}
                          className="flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-red-500"
                        >
                          <Square size={10} /> Стоп
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

          <div className="grid gap-2 border-t border-border pt-2 sm:grid-cols-[1fr_1.4fr_auto_auto]">
            <Input
              value={exportSource}
              onChange={(e) => setExportSource(e.target.value)}
              placeholder="Источник в Sandbox (например, site)"
              className="h-8 text-[11px]"
            />
            <Input
              value={exportDest}
              onChange={(e) => setExportDest(e.target.value)}
              placeholder="Папка на ПК (например, C:\Projects\site)"
              className="h-8 text-[11px]"
            />
            <select
              value={exportMode}
              onChange={(e) => setExportMode(e.target.value === "move" ? "move" : "copy")}
              className="h-8 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text"
            >
              <option value="copy">Скопировать</option>
              <option value="move">Перенести</option>
            </select>
            <button
              type="button"
              onClick={() => void runSandboxExport()}
              disabled={sandboxBusy || !exportSource.trim() || !exportDest.trim()}
              className="flex h-8 items-center gap-1 rounded-lg bg-accent px-2.5 text-[11px] font-medium text-white disabled:opacity-40"
            >
              <FolderOutput size={12} /> Выгрузить на ПК
            </button>
          </div>
        </div>
      )}

      {/* Панель совместной формулировки и запуска Оператора прямо из Агента */}
      {opBridgeOpen && (
        <div className="space-y-2.5 rounded-2xl border border-cyan-500/40 bg-card p-3 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-semibold text-text">
              <MonitorCog size={14} className="text-cyan-400" />
              Помощь на экране через Оператора (с вашего разрешения)
            </span>
            <button
              type="button"
              onClick={() => setOpBridgeOpen(false)}
              className="text-muted hover:text-text"
              aria-label="Закрыть панель Оператора"
            >
              <X size={13} />
            </button>
          </div>
          <p className="text-[10px] text-muted">
            Опишите, чем помочь на экране, в программе или в игре. Агент превратит просьбу в чёткое задание для Оператора,
            а после запуска поможет ему и вам после каждого действия.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={opGoal}
              onChange={(e) => setOpGoal(e.target.value)}
              placeholder="Например: помоги пройти квест в игре (WASD + E) или настрой окно программы"
              className="h-8 min-w-0 flex-1 text-[11px]"
            />
            <button
              type="button"
              onClick={() => void formulateOperatorTask(opGoal)}
              disabled={opFormulating || (!opGoal.trim() && !text.trim())}
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2.5 text-[11px] font-medium text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              {opFormulating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              Сформулировать задачу
            </button>
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-card2/50 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-muted">Режим Оператора:</span>
              {OPERATOR_TASK_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setOpDraftMode(m.id)}
                  className={cn(
                    "flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[10px] font-medium transition",
                    opDraftMode === m.id ? m.badgeClass : "border-border bg-card text-muted hover:text-text",
                  )}
                >
                  {m.id === "game" && <Gamepad2 size={10} />}
                  {m.shortLabel}
                </button>
              ))}
              <label className="ml-auto flex items-center gap-1 text-[10px] text-muted">
                шагов (0 — без лимита)
                <Input
                  type="number"
                  min={0}
                  value={opDraftSteps}
                  onChange={(e) => setOpDraftSteps(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  className="h-7 w-16 px-1.5 text-[10px]"
                />
              </label>
            </div>
            <Textarea
              value={opDraftPrompt}
              onChange={(e) => setOpDraftPrompt(e.target.value)}
              rows={3}
              placeholder="Сформулированная пошаговая инструкция для Оператора (можно отредактировать перед запуском)"
              className="text-[11px]"
            />
            {opDraftNotes && <p className="text-[10px] text-muted">{opDraftNotes}</p>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-muted">
                Режим сопровождения: <strong className="text-cyan-400">Агент подсказывает после каждого шага</strong>
              </span>
              <button
                type="button"
                onClick={() => void launchOperatorFromDraft(opDraftPrompt, opDraftMode, opDraftSteps)}
                disabled={opLaunching || !opDraftPrompt.trim()}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {opLaunching ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Разрешить и запустить Оператора
              </button>
            </div>
          </div>

          {recentOpTasks.length > 0 && (
            <div className="space-y-1.5 border-t border-border pt-2">
              <p className="text-[10px] font-medium text-muted">Недавние и активные задачи Оператора:</p>
              <div className="flex flex-wrap gap-1.5">
                {recentOpTasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      if (opTask?.id === t.id) {
                        closeOperatorTaskCard();
                      } else {
                        dismissedOpTaskIdsRef.current.delete(t.id);
                        void refreshOpTask(t.id);
                      }
                    }}
                    title={opTask?.id === t.id ? "Нажмите, чтобы свернуть карточку задачи" : "Открыть статус и ленту этой задачи"}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] transition",
                      opTask?.id === t.id
                        ? "border-cyan-500/50 bg-cyan-500/15 text-text"
                        : "border-border bg-card2 text-muted hover:text-text",
                    )}
                  >
                    <StatusChip status={t.status} />
                    <span>#{t.id}</span>
                    <span className="max-w-[180px] truncate">{t.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      </div>

      {/* Живое сопровождение Оператора (видно на вкладках «Sandbox и Оператор» и «Чат», а также в классическом виде) */}
      {opTask && (() => {
        const opApproval = parsePendingApproval(opTask.pendingApproval);
        const opFinished = ["done", "failed", "cancelled"].includes(opTask.status);
        const latestGuidanceEv = [...opEvents].reverse().find((e) => e.kind === "guidance");
        const latestActionEv = [...opEvents].reverse().find((e) => e.kind === "action");
        const guidanceText =
          opTask.guidanceNote?.userAdvice || opTask.guidanceNote?.text || latestGuidanceEv?.text || "";
        const liveFeed = opEvents
          .filter((e) => ["thought", "action", "result", "guidance", "approval", "error"].includes(e.kind))
          .slice(-8);
        return (
          <div
            hidden={isTabs && activeTab !== "workspace" && activeTab !== "chat"}
            className="space-y-2 rounded-2xl border border-cyan-500/40 bg-card p-3 text-[11px]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 font-semibold text-text">
                <Compass size={13} className="text-cyan-400" /> Оператор #{opTask.id}
              </span>
              <StatusChip status={opTask.status} />
              {opTask.taskMode && (
                <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px]", findTaskMode(opTask.taskMode).badgeClass)}>
                  {findTaskMode(opTask.taskMode).shortLabel}
                </span>
              )}
              <span className="text-[10px] text-muted">
                {opTask.maxSteps <= 0 ? `шагов ${opTask.steps} · без лимита` : `шагов ${opTask.steps}/${opTask.maxSteps}`}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void openOperatorTaskChat(opTask.id)}
                  className="flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent2 hover:bg-accent/20"
                  title="Открыть полную историю мыслей и шагов Оператора как отдельный чат"
                >
                  <History size={10} /> Открыть как чат
                </button>
                {!opFinished && (
                  <>
                    <button
                      type="button"
                      onClick={() => void askOperatorCoach()}
                      disabled={opCoachBusy}
                      className="flex items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-50"
                    >
                      {opCoachBusy ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                      Совет Агента
                    </button>
                    <button
                      type="button"
                      onClick={() => void actOnOperatorTask("extend_steps", { addSteps: 20 })}
                      className="rounded-md border border-border bg-card2 px-2 py-0.5 text-[10px] text-muted hover:text-text"
                    >
                      +20 шагов
                    </button>
                    <button
                      type="button"
                      onClick={() => void actOnOperatorTask("cancel")}
                      className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-500"
                    >
                      Остановить
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={closeOperatorTaskCard}
                  className="rounded-md border border-border bg-card2 p-1 text-muted transition hover:text-text"
                  title="Скрыть карточку задачи Оператора"
                  aria-label="Скрыть карточку задачи Оператора"
                >
                  <X size={11} />
                </button>
              </div>
            </div>
            <p className="truncate text-[10px] text-muted">{opTask.prompt}</p>
            {liveFeed.length > 0 && (
              <div className="space-y-1 rounded-lg border border-border bg-card2/50 p-2">
                <p className="text-[10px] font-medium text-muted">
                  Мысли и шаги Оператора ({opEvents.length}):
                </p>
                <div className="max-h-36 space-y-1 overflow-y-auto text-[10px]">
                  {liveFeed.map((ev) => (
                    <p
                      key={ev.id}
                      className={cn(
                        "leading-snug",
                        ev.kind === "thought" && "text-cyan-300",
                        ev.kind === "guidance" && "text-accent2",
                        ev.kind === "action" && "text-emerald-400",
                        ev.kind === "error" && "text-red-400",
                        (ev.kind === "result" || ev.kind === "approval") && "text-muted",
                      )}
                    >
                      {ev.kind === "thought"
                        ? `💭 ${ev.text}`
                        : ev.kind === "guidance"
                          ? `🤝 ${ev.text}`
                          : ev.kind === "action"
                            ? `▸ ${ev.text || ev.action}`
                            : ev.kind === "error"
                              ? `⚠️ ${ev.text}`
                              : ev.kind === "approval"
                                ? `🔐 ${ev.text}`
                                : ev.text}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {latestActionEv && liveFeed.length === 0 && (
              <p className="rounded-lg bg-card2 px-2 py-1 text-[10px] text-emerald-500">
                Последнее действие: {latestActionEv.text || latestActionEv.action}
              </p>
            )}
            {guidanceText && (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-2.5 py-1.5 text-[11px] text-text">
                <span className="font-medium text-cyan-400">Что делать дальше: </span>
                {guidanceText}
              </div>
            )}
            {opFinished && opTask.summary && (
              <p className="rounded-lg border border-border bg-card2 px-2.5 py-1.5 text-[10px] text-text">
                <span className="font-medium text-emerald-400">Итог: </span>
                {opTask.summary}
              </p>
            )}
            {(opApproval || opTask.status === "waiting_approval" || opTask.status === "waiting_steps") && (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[10px] font-medium text-amber-400">
                Ожидает вашего решения во всплывающем окне справа внизу…
              </p>
            )}
            {!opFinished && (
              <div className="flex gap-1.5">
                <Input
                  value={opGuidanceInput}
                  onChange={(e) => setOpGuidanceInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void sendOperatorGuidance();
                    }
                  }}
                  placeholder="Подсказать Оператору следующий шаг…"
                  className="h-7 text-[11px]"
                />
                <button
                  type="button"
                  onClick={() => void sendOperatorGuidance()}
                  disabled={opCoachBusy || !opGuidanceInput.trim()}
                  className="rounded-lg border border-border bg-card2 px-2.5 text-[10px] font-medium text-text hover:border-accent/50 disabled:opacity-40"
                >
                  Подсказать
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {/* Вкладка 4: Под-агент Тестировщик (QA) с теми же настройками модели */}
      <div
        role={isTabs ? "tabpanel" : undefined}
        aria-label="Тестировщик"
        hidden={isTabs && activeTab !== "tester"}
        className="space-y-3"
      >
        <TesterPanel
          settings={settings}
          params={params}
          sandboxProjects={sandbox?.projects ?? []}
          runs={testerRuns}
          conversations={testerConversations}
          selectedConvId={selectedTesterConvId}
          messages={selectedTesterMessages}
          loading={testerLoading}
          directRunning={testerDirectRunning}
          directPrompt={testerDirectPrompt}
          directProject={testerDirectProject}
          liveTester={liveTester}
          decisionBusyRunId={testerDecisionBusy}
          agentRunning={running}
          error={testerError}
          onSelectConv={(id) => void selectTesterConversation(id)}
          onNewChat={() => void createNewTesterChat()}
          onDeleteChat={(id) => void deleteTesterChat(id)}
          onRefresh={() => void refreshTesterData()}
          onChangePrompt={setTesterDirectPrompt}
          onChangeProject={setTesterDirectProject}
          onRunDirect={() => void sendTesterDirect()}
          onDecideMinor={(runId, decision) => void decideTesterMinor(runId, decision)}
          onOpenModelTab={() => {
            if (isTabs) setActiveTab("model");
          }}
          onOpenAgentChat={(convId) => void openAgentChatFromTester(convId)}
        />
      </div>

      {/* Вкладка 5 (последняя): Чат с Агентом и история */}
      <div
        role={isTabs ? "tabpanel" : undefined}
        aria-label="Чат"
        hidden={isTabs && activeTab !== "chat"}
        className="space-y-3"
      >
        {isTabs && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card px-2.5 py-1.5 text-[10px] text-muted">
            <button
              type="button"
              onClick={() => setActiveTab("model")}
              className="rounded-md border border-border bg-card2 px-2 py-0.5 text-text hover:border-accent/50"
            >
              Модель: {settings.model.trim() || "по умолчанию"}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("model")}
              className="rounded-md border border-border bg-card2 px-2 py-0.5 hover:text-text"
            >
              Раздумья: {params.reasoning}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("knowledge")}
              className="rounded-md border border-border bg-card2 px-2 py-0.5 hover:text-text"
            >
              RAG: {activeRagFolder ? activeRagFolder.name : "выкл"}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("workspace")}
              className="rounded-md border border-border bg-card2 px-2 py-0.5 hover:text-text"
            >
              Sandbox: {sandbox?.items?.length ?? 0}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("tester")}
              className="rounded-md border border-border bg-card2 px-2 py-0.5 hover:text-text"
            >
              Тестировщик: {testerRuns.length}
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card p-2">
          <History size={13} className="ml-1 text-muted" />
          <select
            aria-label="История чатов агента"
            value={conversationId ?? ""}
            onChange={(event) => {
              const id = Number(event.target.value);
              if (id > 0) void selectConversation(id);
            }}
            disabled={historyLoading || conversations.length === 0}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent disabled:opacity-60"
          >
            {conversations.length === 0 ? (
              <option value="">{historyLoading ? "Загружаю историю…" : "Чатов пока нет"}</option>
            ) : (
              conversations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || "Новый чат"} · {item.messagesCount} сообщ.
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            onClick={() => void rolloverToSummaryChat(turns, "manual")}
            disabled={historyLoading || running || summarizing || turns.length === 0}
            className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card2 px-2 text-[10px] font-medium text-muted transition hover:text-text disabled:opacity-40"
            title="Сжать переписку в Summary, сохранить полный текст в .md и открыть новый чат"
          >
            {summarizing ? <Loader2 size={12} className="animate-spin" /> : <Archive size={12} />}
            Сжать в Summary и новый чат
          </button>
          {currentConversation?.operatorTaskId && (
            <button
              type="button"
              onClick={() => void exitOperatorTaskChat()}
              disabled={historyLoading || running}
              className="flex h-8 items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2 text-[10px] font-medium text-cyan-400 transition hover:bg-cyan-500/20 disabled:opacity-40"
              title="Выйти из чата задачи Оператора в обычный чат"
            >
              <X size={12} /> Закрыть чат задачи
            </button>
          )}
          <button
            type="button"
            onClick={() => void startNewConversation()}
            disabled={historyLoading || running}
            className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card2 px-2 text-[10px] font-medium text-muted transition hover:text-text disabled:opacity-40"
          >
            <MessageSquarePlus size={12} /> Новый чат
          </button>
          <button
            type="button"
            onClick={() => void deleteCurrentConversation()}
            disabled={conversationId === null || historyLoading || running}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card2 text-muted transition hover:text-red-500 disabled:opacity-40"
            title="Удалить этот чат"
            aria-label="Удалить чат агента"
          >
            <Trash2 size={13} />
          </button>
        </div>

      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative rounded-2xl border bg-card transition",
          dragging ? "border-accent ring-2 ring-[var(--ring)]" : "border-border",
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/10 backdrop-blur-[1px]">
            <p className="rounded-xl border border-accent/40 bg-card px-4 py-2 text-xs font-medium text-text shadow">
              Отпустите файл или картинку, чтобы приложить к запросу Агенту
            </p>
          </div>
        )}

        <div ref={listRef} onScroll={handleChatScroll} className="h-[420px] space-y-3 overflow-y-auto p-3">
          {historyLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted">
              <Loader2 size={13} className="animate-spin" /> Загружаю переписку…
            </div>
          ) : turns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card2/50 p-4 text-xs">
              <p className="flex items-center gap-1.5 font-semibold">
                <Bot size={14} className="text-accent2" /> {userName}, агент умеет создавать проекты и работать в Sandbox
              </p>
              <ul className="mt-2 space-y-1 text-muted">
                <li>• создаёт проекты и файлы строго в изолированной папке Sandbox (и выгружает наружу после вашего согласия);</li>
                <li>• сам заходит на веб-проект в браузере, кликает, наводит курсор и проверяет анимации, вёрстку и консоль;</li>
                <li>• запускает команды, проверяет сборку и открывает сайты в браузере;</li>
                <li>• ищет по целым RAG-папкам любого размера и сохраняет длинные чаты через Summary в .md.</li>
              </ul>
              {tools.length > 0 && (
                <p className="mt-2 text-[10px] text-muted">Инструменты: {tools.join(", ")}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => void send(example)}
                    className="rounded-lg border border-border bg-card px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-text"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn, turnIndex) => {
              const isStreamingTurn = running && turn.role === "assistant" && turnIndex === turns.length - 1;
              return (
              <div key={turn.id} className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[92%] space-y-2 rounded-2xl px-3 py-2 text-xs",
                    turn.role === "user" ? "bg-accent/20" : "border border-border bg-card2",
                  )}
                >
                  {turn.content ? (
                    <p className="whitespace-pre-wrap break-words leading-relaxed">{turn.content}</p>
                  ) : turn.role === "assistant" && running ? (
                    <p className="flex items-center gap-1.5 text-muted">
                      <Loader2 size={12} className="animate-spin" /> агент думает…
                    </p>
                  ) : null}

                  {turn.reasoning && turn.reasoning.trim() && (
                    <LiveReasoningBox text={turn.reasoning} streaming={isStreamingTurn} />
                  )}

                  {isStreamingTurn && liveTester && (
                    <div className="space-y-1.5 rounded-xl border border-violet-500/40 bg-violet-500/10 p-2.5 text-[11px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 font-semibold text-violet-300">
                          <Loader2 size={12} className="animate-spin" />
                          Тестировщик · {liveTester.sandboxProject || "."}
                        </span>
                        {isTabs && (
                          <button
                            type="button"
                            onClick={() => setActiveTab("tester")}
                            className="rounded-md border border-violet-500/40 bg-card px-2 py-0.5 text-[10px] font-medium text-violet-300 hover:bg-violet-500/20"
                          >
                            Открыть Тестировщик
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-muted">{liveTester.statusText}</p>
                      {liveTester.browserLog && liveTester.browserLog.length > 0 && (
                        <div className="space-y-0.5 rounded-lg border border-cyan-500/30 bg-card/70 px-2 py-1.5">
                          <p className="text-[10px] font-semibold text-cyan-400">
                            Ход BrowserInspector ({liveTester.browserLog.length})
                          </p>
                          <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted">
                            {liveTester.browserLog.slice(-14).join("\n")}
                          </pre>
                        </div>
                      )}
                      {liveTester.actions.length > 0 && (
                        <ul className="space-y-0.5 text-[10px] text-text/90">
                          {liveTester.actions.slice(-5).map((act, aIdx) => (
                            <li key={`lt-act-${aIdx}`} className="truncate">
                              • {formatLiveTesterAction(act)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {liveTester.reasoning && (
                        <p className="line-clamp-3 whitespace-pre-wrap rounded-lg border border-border/60 bg-card/60 px-2 py-1 text-[10px] text-muted">
                          {liveTester.reasoning}
                        </p>
                      )}
                    </div>
                  )}

                  {turn.attached && turn.attached.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {turn.attached.map((file, index) => (
                        <span
                          key={`${file.name}-${index}`}
                          className="flex items-center gap-1 rounded-lg border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted"
                        >
                          <FileText size={10} /> {file.name} · {formatBytes(file.size)}
                        </span>
                      ))}
                    </div>
                  )}

                  {turn.actions.map((action, index) => {
                    if (action.type === "open_url" && action.url) {
                      const openTarget = toSandboxProxyUrl(action.url, action.port) ?? action.url;
                      return (
                        <a
                          key={`${openTarget}-${index}`}
                          href={openTarget}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-2.5 py-2 font-medium text-accent2 transition hover:bg-accent/20"
                        >
                          {action.autoplay ? <PlayCircle size={14} /> : <ExternalLink size={14} />}
                          <span className="min-w-0 flex-1 truncate">{action.label || openTarget}</span>
                          <span className="text-[10px] text-muted">открыть</span>
                        </a>
                      );
                    }
                    if (action.type === "command_result") {
                      const cmdProxyUrl = action.previewUrl || toSandboxProxyUrl(action.url, action.port);
                      return (
                        <div
                          key={`cmd-${index}`}
                          className="rounded-xl border border-border bg-card px-2.5 py-2 text-[11px]"
                        >
                          <div className="flex flex-wrap items-center gap-1.5 font-mono font-medium text-text">
                            <Terminal size={12} className="shrink-0 text-accent2" />
                            <span className="min-w-0 flex-1 truncate">{action.command}</span>
                            {cmdProxyUrl && (
                              <a
                                href={cmdProxyUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-sans text-[10px] text-emerald-400 hover:bg-emerald-500/20"
                              >
                                <ExternalLink size={10} /> Открыть
                              </a>
                            )}
                            {action.exitCode !== undefined && action.exitCode !== null && (
                              <span className="text-[10px] text-muted">код {action.exitCode}</span>
                            )}
                          </div>
                          {action.output && (
                            <pre className="mt-1 max-h-32 overflow-auto rounded bg-card2 px-2 py-1 text-[10px] text-muted">
                              {action.output}
                            </pre>
                          )}
                        </div>
                      );
                    }
                    if (action.type === "operator_plan") {
                      const planMode = normalizeTaskMode(action.mode);
                      return (
                        <div
                          key={`op-plan-${index}`}
                          className="space-y-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/5 px-2.5 py-2 text-[11px]"
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <MonitorCog size={13} className="text-cyan-400" />
                            <span className="font-semibold text-text">План для Оператора</span>
                            <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px]", findTaskMode(planMode).badgeClass)}>
                              {findTaskMode(planMode).shortLabel}
                            </span>
                          </div>
                          {action.task && <p className="whitespace-pre-wrap text-text">{action.task}</p>}
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                void launchOperatorFromDraft(
                                  action.task || "",
                                  planMode,
                                  action.maxSteps ?? 30,
                                )
                              }
                              disabled={opLaunching || !action.task}
                              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                            >
                              <Check size={11} /> Разрешить и запустить Оператора
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpDraftPrompt(action.task || "");
                                setOpDraftMode(planMode);
                                setOpDraftSteps(action.maxSteps ?? 30);
                                setOpDraftNotes(action.notes ?? "");
                                setOpBridgeOpen(true);
                                if (isTabs) setActiveTab("workspace");
                              }}
                              className="rounded-lg border border-border bg-card px-2 py-1 text-[10px] text-muted hover:text-text"
                            >
                              Изменить план
                            </button>
                          </div>
                        </div>
                      );
                    }
                    if (action.type === "operator_task") {
                      return (
                        <div
                          key={`op-task-${index}`}
                          className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-2 text-[11px]"
                        >
                          <MonitorCog size={13} className="shrink-0 text-emerald-500" />
                          <span className="min-w-0 flex-1 truncate text-text">
                            Оператор запущен #{action.taskId ?? "—"} · {action.task || action.label}
                          </span>
                          {action.taskId ? (
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void openOperatorTaskChat(action.taskId!)}
                                className="text-[10px] font-medium text-accent2 hover:underline"
                              >
                                Открыть как чат
                              </button>
                              <button
                                type="button"
                                onClick={() => void refreshOpTask(action.taskId!)}
                                className="text-[10px] font-medium text-emerald-500 hover:underline"
                              >
                                Ход работы
                              </button>
                            </div>
                          ) : null}
                        </div>
                      );
                    }
                    if (action.type === "browser_inspect") {
                      const hasError = Boolean(action.error);
                      const hasProblems = hasError || (action.errorsCount ?? 0) > 0 || (action.issuesCount ?? 0) > 0;
                      const traceLines = Array.isArray(action.trace) ? action.trace : [];
                      return (
                        <div
                          key={`browser-inspect-${index}`}
                          className={cn(
                            "space-y-1.5 rounded-xl border px-2.5 py-2 text-[11px]",
                            hasError
                              ? "border-red-500/40 bg-red-500/10"
                              : hasProblems
                                ? "border-amber-500/40 bg-amber-500/5"
                                : "border-emerald-500/35 bg-emerald-500/5",
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            {hasError ? (
                              <TriangleAlert size={13} className="shrink-0 text-red-500" />
                            ) : (
                              <Compass size={13} className={hasProblems ? "text-amber-500" : "text-emerald-500"} />
                            )}
                            <span className="font-medium text-text">
                              {hasError ? "Сбой BrowserInspector" : "Осмотр проекта"}
                              {action.action ? ` (${action.action})` : ""}
                            </span>
                            {action.viewport && (
                              <span className="rounded bg-card px-1.5 py-0.5 text-[10px] text-muted">
                                {action.viewport}
                              </span>
                            )}
                            {action.url && (
                              <span className="min-w-0 truncate text-[10px] text-accent2" title={action.url}>
                                {action.url}
                              </span>
                            )}
                          </div>
                          {action.error && (
                            <p className="whitespace-pre-wrap break-words rounded-lg border border-red-500/30 bg-card/80 px-2 py-1 text-[10px] text-red-400">
                              {action.error}
                            </p>
                          )}
                          {action.summary && !action.error && (
                            <p className="text-[10px] text-muted">{action.summary}</p>
                          )}
                          {action.preview && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={action.preview}
                              alt={`Скриншот осмотра ${action.url || "проекта"}`}
                              className="max-h-48 w-full rounded-lg border border-border object-cover object-top"
                            />
                          )}
                          {traceLines.length > 0 && (
                            <details open={hasError} className="rounded-lg border border-border/70 bg-card/70 px-2 py-1">
                              <summary className="cursor-pointer select-none text-[10px] font-medium text-muted hover:text-text">
                                Журнал шагов BrowserInspector ({traceLines.length})
                              </summary>
                              <pre className="mt-1 max-h-44 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted">
                                {traceLines.join("\n")}
                              </pre>
                            </details>
                          )}
                        </div>
                      );
                    }
                    if (action.type === "operator_screen") {
                      return (
                        <div
                          key={`op-screen-${index}`}
                          className="flex items-start gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-2 text-[11px]"
                        >
                          <Camera size={13} className="mt-0.5 shrink-0 text-cyan-400" />
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <p className="font-medium text-text">
                              Снимок экрана ПК передан Агенту{action.taskId ? ` (#${action.taskId})` : ""}
                            </p>
                            {action.summary && <p className="text-[10px] text-muted">{action.summary}</p>}
                          </div>
                        </div>
                      );
                    }
                    if (action.type === "github_edit") {
                      return (
                        <div
                          key={`gh-edit-${index}`}
                          className="flex items-center gap-2 rounded-xl border border-sky-500/35 bg-sky-500/10 px-2.5 py-2 text-[11px]"
                        >
                          <GithubIcon size={13} className="shrink-0 text-sky-400" />
                          <span className="min-w-0 flex-1 truncate text-text">
                            GitHub ({action.mode === "delete" ? "удалён" : action.mode === "create" ? "создан" : "обновлён"}):{" "}
                            <span className="font-mono">{action.path}</span>
                            {action.branch ? ` · ${action.branch}` : ""}
                          </span>
                        </div>
                      );
                    }
                    if (action.type === "github_commit") {
                      return (
                        <div
                          key={`gh-commit-${index}`}
                          className="flex items-start gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-2 text-[11px]"
                        >
                          <GitCommitHorizontal size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-text">
                                Commit {action.sha ? action.sha.slice(0, 7) : ""}
                                {action.pushed ? " + Push" : ""} · {action.owner}/{action.repo}@{action.branch}
                              </span>
                              {action.authorLogin && (
                                <span className="rounded bg-card px-1.5 py-0.5 text-[10px] text-emerald-400">
                                  @{action.authorLogin}
                                </span>
                              )}
                            </div>
                            {action.message && <p className="text-[10px] text-muted">{action.message}</p>}
                          </div>
                          {action.url && (
                            <a
                              href={action.url}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 text-[10px] font-medium text-accent2 hover:underline"
                            >
                              Открыть
                            </a>
                          )}
                        </div>
                      );
                    }
                    if (action.type === "github_pr") {
                      return (
                        <div
                          key={`gh-pr-${index}`}
                          className="flex items-start gap-2 rounded-xl border border-violet-500/40 bg-violet-500/10 px-2.5 py-2 text-[11px]"
                        >
                          <GitPullRequest size={13} className="mt-0.5 shrink-0 text-violet-400" />
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-text">
                                PR #{action.number}: {action.title}
                              </span>
                              {action.authorLogin && (
                                <span className="rounded bg-card px-1.5 py-0.5 text-[10px] text-violet-300">
                                  @{action.authorLogin}
                                </span>
                              )}
                            </div>
                            {(action.head || action.base) && (
                              <p className="text-[10px] text-muted">
                                {action.head} → {action.base}
                              </p>
                            )}
                          </div>
                          {action.url && (
                            <a
                              href={action.url}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 text-[10px] font-medium text-accent2 hover:underline"
                            >
                              Открыть PR
                            </a>
                          )}
                        </div>
                      );
                    }
                    if (action.type === "github_merge") {
                      return (
                        <div
                          key={`gh-merge-${index}`}
                          className="flex items-start gap-2 rounded-xl border border-emerald-500/45 bg-emerald-500/15 px-2.5 py-2 text-[11px]"
                        >
                          <GitMerge size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-text">
                                Merge PR #{action.number} ({action.method || "merge"})
                              </span>
                              {action.authorLogin && (
                                <span className="rounded bg-card px-1.5 py-0.5 text-[10px] text-emerald-300">
                                  @{action.authorLogin}
                                </span>
                              )}
                            </div>
                            {action.title && <p className="text-[10px] text-muted">{action.title}</p>}
                          </div>
                          {action.url && (
                            <a
                              href={action.url}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 text-[10px] font-medium text-accent2 hover:underline"
                            >
                              Открыть PR
                            </a>
                          )}
                        </div>
                      );
                    }
                    if (action.type === "tester_report") {
                      const hasCrit = (action.criticalCount ?? 0) > 0 || action.status === "critical_issues";
                      const hasMinor = (action.minorCount ?? 0) > 0 || action.status === "minor_issues";
                      return (
                        <div
                          key={`tester-rep-${index}`}
                          className={cn(
                            "space-y-1.5 rounded-xl border px-2.5 py-2 text-[11px]",
                            hasCrit
                              ? "border-red-500/40 bg-red-500/10"
                              : hasMinor
                                ? "border-amber-500/40 bg-amber-500/10"
                                : "border-emerald-500/40 bg-emerald-500/10",
                          )}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 font-semibold text-text">
                              <FlaskConical size={13} className="text-violet-400" />
                              Отчёт Тестировщика · {action.sandboxProject || "."}
                            </span>
                            <span className="text-[10px] text-muted">
                              крит.: {action.criticalCount ?? 0} · мелк.: {action.minorCount ?? 0}
                              {typeof action.totalTokens === "number" && action.totalTokens > 0
                                ? ` · чат QA: ${action.totalTokens} ток.`
                                : ""}
                            </span>
                          </div>
                          {action.reportSummary && (
                            <p className="text-[10px] text-muted">{action.reportSummary}</p>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (action.testerConversationId) {
                                void selectTesterConversation(action.testerConversationId);
                              }
                              if (isTabs) setActiveTab("tester");
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-accent2 hover:underline"
                          >
                            Открыть отчёт в Тестировщике
                          </button>
                        </div>
                      );
                    }
                    if (action.type === "tester_minor_decision" || action.type === "qa_check") {
                      return (
                        <div
                          key={`qa-act-${index}`}
                          className="flex items-center gap-2 rounded-xl border border-violet-500/35 bg-violet-500/10 px-2.5 py-2 text-[11px] text-text"
                        >
                          <FlaskConical size={13} className="shrink-0 text-violet-400" />
                          <span className="min-w-0 flex-1 truncate">{action.label || action.type}</span>
                        </div>
                      );
                    }
                    const fallbackPreview =
                      action.previewUrl ||
                      (action.type === "sandbox_update" || action.type === "project_created"
                        ? action.project || action.path
                          ? `/api/ai/agent/sandbox/preview/${encodeURIComponent((action.project || action.path || "").split("/")[0] || "")}`
                          : undefined
                        : undefined);
                    return (
                      <div
                        key={`act-${index}`}
                        className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-2 text-[11px] text-muted"
                      >
                        <FolderOutput size={13} className="shrink-0 text-emerald-500" />
                        <span className="min-w-0 flex-1 truncate">
                          {(action.type === "project_created" || (action.type === "sandbox_update" && action.kind === "project")) &&
                            `Проект в Sandbox: ${action.project || action.path}`}
                          {action.type === "sandbox_update" &&
                            action.kind !== "project" &&
                            `Sandbox (${action.kind === "dir" ? "папка" : "файл"}): ${action.path}`}
                          {action.type === "sandbox_file" && `Файл в Sandbox: ${action.path}`}
                          {action.type === "sandbox_export" &&
                            `Экспорт (${action.filesCount ?? 0} файлов): ${action.source} → ${action.destination}`}
                        </span>
                        {fallbackPreview && (
                          <a
                            href={fallbackPreview}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent2 hover:bg-accent/20"
                          >
                            <ExternalLink size={10} /> Открыть
                          </a>
                        )}
                      </div>
                    );
                  })}

                  {turn.files.map((file, index) =>
                    file.data ? (
                      <a
                        key={`${file.name}-${index}`}
                        href={`data:${file.mime};base64,${file.data}`}
                        download={file.name}
                        className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-2 font-medium text-emerald-500 transition hover:bg-emerald-500/20"
                      >
                        <FileText size={14} />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="text-[10px] text-muted">{formatBytes(file.size)}</span>
                        <Download size={13} />
                      </a>
                    ) : (
                      <div
                        key={`${file.name}-${index}`}
                        className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-2 text-muted"
                        title="В историю сохраняется имя, а не содержимое файла"
                      >
                        <FileText size={14} />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="text-[10px]">{formatBytes(file.size)} · файл не сохранён</span>
                      </div>
                    ),
                  )}

                  {turn.error && (
                    <p className="flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-500">
                      <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                      {turn.error}
                    </p>
                  )}
                </div>
              </div>
              );
            })
          )}
        </div>

        <div className="border-t border-border p-3">
          {running && liveBrowserLog.length > 0 && (
            <div className="mb-2 space-y-1 rounded-xl border border-cyan-500/35 bg-cyan-500/5 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2 text-[10px]">
                <span className="flex items-center gap-1.5 font-semibold text-cyan-400">
                  <Compass size={11} className="animate-pulse" />
                  Ход BrowserInspector ({liveBrowserLog.length})
                </span>
                <span className="text-muted">шаги в реальном времени</span>
              </div>
              <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted">
                {liveBrowserLog.slice(-16).join("\n")}
              </pre>
            </div>
          )}
          {status && (
            <p className="mb-2 flex items-center gap-1.5 text-[11px] text-muted">
              <Loader2 size={11} className="animate-spin" /> {status}
            </p>
          )}
          {notice && <p className="mb-2 text-[11px] text-emerald-500">{notice}</p>}
          {error && <p className="mb-2 text-[11px] text-red-500">{error}</p>}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {attachments.map((file, idx) => (
                <span
                  key={`${file.name}-${file.size}-${idx}`}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-card2 px-1.5 py-0.5 text-[10px] text-muted"
                >
                  {file.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={file.image} alt={file.name} className="h-5 w-5 shrink-0 rounded object-cover" />
                  ) : (
                    <FileText size={10} />
                  )}
                  <span className="max-w-[140px] truncate">{file.name}</span> · {formatFileSize(file.size)}
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((item) => item !== file))}
                    className="text-muted transition hover:text-red-500"
                    aria-label={`Убрать ${file.name}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex min-w-0 items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="sr-only"
              aria-label="Приложить файлы для анализа"
              onChange={(event) => {
                const list = Array.from(event.target.files ?? []);
                event.target.value = "";
                addAgentFiles(list);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={running || reading || historyLoading || conversationId === null}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card2 text-muted transition hover:text-text disabled:opacity-40"
              title={
                unlimited
                  ? "Приложить файлы для анализа (без лимита по размеру и количеству)"
                  : "Приложить файлы для анализа (до 5 по 10 МБ)"
              }
              aria-label="Приложить файлы"
            >
              {reading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
            </button>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder="Например: открой ютуб и включи видео про космос… (можно вставить фото Ctrl+V или перетащить файл)"
              disabled={historyLoading || conversationId === null}
              className="max-h-32 min-h-10 min-w-0 flex-1 resize-y rounded-xl border border-border bg-card2 px-3 py-2 text-xs outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void formulateOperatorTask(text)}
              disabled={running || opFormulating || historyLoading || conversationId === null || !text.trim()}
              className="flex h-10 shrink-0 items-center gap-1 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-2.5 text-[11px] font-medium text-cyan-400 transition hover:bg-cyan-500/20 disabled:opacity-40"
              title="Попросить Агента сформулировать задачу из текста и подготовить запуск Оператора"
            >
              {opFormulating ? <Loader2 size={13} className="animate-spin" /> : <MonitorCog size={13} />}
              Оператор
            </button>
            {running ? (
              <button
                type="button"
                onClick={() => chatAbortRef.current?.abort()}
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-red-500/40 bg-red-500/15 px-3 text-xs font-medium text-red-400 transition hover:bg-red-500/25"
                title="Остановить текущий запуск агента"
              >
                <Square size={13} />
                Остановить
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={historyLoading || conversationId === null || (!text.trim() && attachments.length === 0)}
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-xs font-medium text-white transition disabled:opacity-40"
              >
                <Send size={14} />
                Запустить
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-muted">
            Скрепка — файлы для анализа ({unlimited ? "без лимита" : "до 5 по 10 МБ"}) или сохранённые .md-переписки. В истории остаются имена файлов,
            а при 80% лимита контекста чат автоматически архивируется и продолжается через Summary.
          </p>
        </div>
      </div>
      </div>

      {pendingApproval && (
        <ApprovalToast
          kind={pendingApproval.kind}
          tone={pendingApproval.kind === "capture_screen" ? "cyan" : "amber"}
          badgeLabel={
            pendingApproval.kind === "capture_screen"
              ? "Запрос снимка экрана"
              : pendingApproval.kind === "browser_inspect"
                ? "Осмотр внешнего сайта"
                : pendingApproval.kind === "call_operator"
                  ? "Запуск Оператора"
                  : pendingApproval.kind === "tester_minor_fixes"
                    ? "Тестировщик · мелкие замечания"
                    : pendingApproval.kind.startsWith("github_")
                      ? `GitHub · @${pendingApproval.github?.login || ghAccount?.login || "аккаунт"}`
                      : "Запрос разрешения"
          }
          title={pendingApproval.title}
          description={pendingApproval.description}
          onDismiss={() => void sendApprovalDecision(false)}
          dismissDisabled={approvalBusy || browserCaptureBusy}
          actions={
            pendingApproval.kind === "capture_screen" ? (
              screenCapture ? (
                <>
                  <button
                    type="button"
                    onClick={() => void captureScreenInBrowser()}
                    disabled={browserCaptureBusy || approvalBusy}
                    className="flex items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] font-medium text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
                  >
                    {browserCaptureBusy ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
                    Снять в браузере
                  </button>
                  <button
                    type="button"
                    onClick={() => void sendApprovalDecision(false)}
                    disabled={approvalBusy || browserCaptureBusy}
                    className="flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium text-red-500 hover:bg-red-500/20 disabled:opacity-50"
                  >
                    <X size={12} /> Отменить ожидание
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void sendApprovalDecision(true)}
                    disabled={approvalBusy || browserCaptureBusy}
                    className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {approvalBusy ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
                    Разрешить Оператору снять экран
                  </button>
                  <button
                    type="button"
                    onClick={() => void captureScreenInBrowser()}
                    disabled={browserCaptureBusy || approvalBusy}
                    className="flex items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] font-medium text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
                  >
                    {browserCaptureBusy ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
                    Снять в браузере
                  </button>
                  <button
                    type="button"
                    onClick={() => void sendApprovalDecision(false)}
                    disabled={approvalBusy || browserCaptureBusy}
                    className="flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-red-500 hover:bg-red-500/20 disabled:opacity-50"
                  >
                    <X size={12} /> Отклонить
                  </button>
                </>
              )
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void sendApprovalDecision(true)}
                  disabled={approvalBusy}
                  className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  <Check size={12} />{" "}
                  {pendingApproval.kind === "call_operator"
                    ? "Разрешить и запустить Оператора"
                    : pendingApproval.kind === "tester_minor_fixes"
                      ? "Внести мелкие изменения"
                      : pendingApproval.kind === "github_commit"
                        ? `Подтвердить Commit${pendingApproval.github?.push ? " и Push" : ""} от @${pendingApproval.github?.login || ghAccount?.login || "себя"}`
                        : pendingApproval.kind === "github_pr"
                          ? `Создать PR от @${pendingApproval.github?.login || ghAccount?.login || "себя"}`
                          : pendingApproval.kind === "github_merge"
                            ? `Подтвердить Merge от @${pendingApproval.github?.login || ghAccount?.login || "себя"}`
                            : "Разрешить"}
                </button>
                <button
                  type="button"
                  onClick={() => void sendApprovalDecision(false)}
                  disabled={approvalBusy}
                  className="flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-red-500 hover:bg-red-500/20 disabled:opacity-50"
                >
                  <X size={12} />{" "}
                  {pendingApproval.kind === "tester_minor_fixes"
                    ? "Не вносить (оставить как есть)"
                    : "Отклонить"}
                </button>
              </>
            )
          }
        >
          {pendingApproval.command && (
            <pre className="max-h-28 overflow-auto rounded-lg bg-card2 px-2 py-1.5 font-mono text-[11px] text-text">
              {pendingApproval.command}
              {pendingApproval.cwd ? `\n# cwd: ${pendingApproval.cwd}` : ""}
            </pre>
          )}
          {pendingApproval.url && (
            <p className="truncate rounded-lg bg-card2 px-2 py-1 font-mono text-[11px] text-accent2">
              {pendingApproval.url}
            </p>
          )}
          {pendingApproval.kind === "tester_minor_fixes" &&
            pendingApproval.minorIssues &&
            pendingApproval.minorIssues.length > 0 && (
              <div className="max-h-36 space-y-1 overflow-auto rounded-lg border border-amber-500/30 bg-card2 p-2 text-[10px]">
                {pendingApproval.minorIssues.map((iss, idx) => (
                  <p key={`minor-apr-${idx}`} className="text-text">
                    • <b>{iss.title}</b>
                    {iss.file ? ` (${iss.file})` : ""}
                    {iss.description && iss.description !== iss.title ? `: ${iss.description}` : ""}
                  </p>
                ))}
              </div>
            )}
          {pendingApproval.kind === "sandbox_export" && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-muted">
                Источник в Sandbox: <b>{pendingApproval.source}</b> ({pendingApproval.filesCount ?? 0} файлов ·{" "}
                {pendingApproval.mode === "move" ? "перенос" : "копирование"})
              </p>
              <Input
                value={approvalDest}
                onChange={(e) => setApprovalDest(e.target.value)}
                placeholder="Папка назначения на ПК (можно изменить перед согласием)"
                className="h-8 text-[11px]"
              />
            </div>
          )}
          {pendingApproval.kind === "call_operator" && (
            <div className="space-y-2">
              <Textarea
                value={approvalTaskDraft}
                onChange={(e) => setApprovalTaskDraft(e.target.value)}
                rows={3}
                placeholder="Задача для Настольного Оператора"
                className="text-[11px]"
              />
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="text-muted">Режим:</span>
                {OPERATOR_TASK_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setApprovalTaskMode(m.id)}
                    className={cn(
                      "rounded-md border px-2 py-0.5 font-medium transition",
                      approvalTaskMode === m.id ? m.badgeClass : "border-border bg-card2 text-muted",
                    )}
                  >
                    {m.shortLabel}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={approvalCoachAfter}
                    onChange={(e) => setApprovalCoachAfter(e.target.checked)}
                    className="h-3 w-3 accent-[#7c5cff]"
                  />
                  Агент подсказывает после шага
                </label>
                <select
                  value={approvalOpTrust}
                  onChange={(e) => setApprovalOpTrust(e.target.value === "full" ? "full" : "verified")}
                  className="h-7 rounded-md border border-border bg-card2 px-1.5 text-[10px] text-text"
                >
                  <option value="verified">С подтверждением (verified)</option>
                  <option value="full">Полный доступ (full)</option>
                </select>
              </div>
            </div>
          )}
          {pendingApproval.kind === "capture_screen" && (
            <div className="space-y-2">
              {pendingApproval.task && (
                <p className="rounded-lg border border-border bg-card2 px-2 py-1.5 text-[11px] text-text">
                  Что посмотреть на экране: {pendingApproval.task}
                </p>
              )}
              {!screenCapture ? (
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted">
                  <span>Доверие Оператора:</span>
                  <select
                    value={approvalOpTrust}
                    onChange={(e) => setApprovalOpTrust(e.target.value === "full" ? "full" : "verified")}
                    className="h-7 rounded-md border border-border bg-card2 px-1.5 text-[10px] text-text"
                  >
                    <option value="verified">С подтверждением (verified)</option>
                    <option value="full">Полный доступ (full)</option>
                  </select>
                </div>
              ) : (
                <div className="space-y-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 p-2 text-[11px]">
                  <div className="flex items-center gap-1.5 font-medium text-cyan-300">
                    {!screenCapture.error && <Loader2 size={12} className="animate-spin" />}
                    <span>
                      {screenCapture.error
                        ? screenCapture.error
                        : `Ждём снимок экрана от Оператора (#${screenCapture.taskId} · ${screenCapture.status})`}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted">
                    Оператор должен быть запущен с --watch. Можно также сразу нажать «Снять в браузере».
                  </p>
                </div>
              )}
            </div>
          )}
          {pendingApproval.kind === "github_commit" && pendingApproval.github && (
            <div className="space-y-2 text-[11px]">
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted">
                <span>
                  Репозиторий: <b className="text-text">{pendingApproval.github.owner}/{pendingApproval.github.repo}</b>
                </span>
                <span>·</span>
                <span>
                  Автор: <b className="text-emerald-400">@{pendingApproval.github.login}</b>{" "}
                  ({pendingApproval.github.authorName} &lt;{pendingApproval.github.authorEmail}&gt;)
                </span>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-3">
                <label className="text-[10px] text-muted">
                  Целевая ветка
                  <Input
                    value={approvalGhBranch}
                    onChange={(e) => setApprovalGhBranch(e.target.value)}
                    placeholder="main"
                    className="mt-0.5 h-7 text-[11px]"
                  />
                </label>
                <label className="text-[10px] text-muted sm:col-span-2">
                  Сообщение коммита
                  <Input
                    value={approvalGhCommitMsg}
                    onChange={(e) => setApprovalGhCommitMsg(e.target.value)}
                    placeholder="feat: ..."
                    className="mt-0.5 h-7 text-[11px]"
                  />
                </label>
              </div>
              {pendingApproval.github.files && pendingApproval.github.files.length > 0 && (
                <div className="rounded-lg border border-border bg-card2 px-2 py-1.5 font-mono text-[10px] text-text">
                  <p className="mb-1 font-sans text-[10px] font-medium text-muted">
                    Изменённые файлы ({pendingApproval.github.files.length}):
                  </p>
                  <div className="max-h-24 overflow-auto">
                    {pendingApproval.github.files.join("\n")}
                  </div>
                </div>
              )}
              {pendingApproval.github.diffPreview && (
                <pre className="max-h-36 overflow-auto rounded-lg border border-border bg-card2 px-2 py-1.5 font-mono text-[10px] text-muted">
                  {pendingApproval.github.diffPreview}
                </pre>
              )}
            </div>
          )}
          {pendingApproval.kind === "github_pr" && pendingApproval.github && (
            <div className="space-y-2 text-[11px]">
              <p className="text-[10px] text-muted">
                {pendingApproval.github.owner}/{pendingApproval.github.repo} ·{" "}
                <span className="font-mono text-text">
                  {pendingApproval.github.head} → {pendingApproval.github.base}
                </span>{" "}
                · от имени <b className="text-emerald-400">@{pendingApproval.github.login}</b>
              </p>
              <label className="block text-[10px] text-muted">
                Заголовок Pull Request
                <Input
                  value={approvalGhPrTitle}
                  onChange={(e) => setApprovalGhPrTitle(e.target.value)}
                  className="mt-0.5 h-7 text-[11px]"
                />
              </label>
              <label className="block text-[10px] text-muted">
                Описание (Markdown)
                <Textarea
                  value={approvalGhPrBody}
                  onChange={(e) => setApprovalGhPrBody(e.target.value)}
                  rows={3}
                  className="mt-0.5 text-[11px]"
                />
              </label>
            </div>
          )}
          {pendingApproval.kind === "github_merge" && pendingApproval.github && (
            <div className="space-y-2 text-[11px]">
              <div className="rounded-lg border border-border bg-card2 px-2.5 py-2">
                <p className="font-medium text-text">
                  PR #{pendingApproval.github.pullNumber}: {pendingApproval.github.prTitle}
                </p>
                <p className="mt-0.5 text-[10px] text-muted">
                  {pendingApproval.github.head} → {pendingApproval.github.base} · статус:{" "}
                  <span className="font-mono">{pendingApproval.github.mergeableState || "ready"}</span>
                </p>
                {pendingApproval.github.url && (
                  <a
                    href={pendingApproval.github.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-[10px] text-accent2 hover:underline"
                  >
                    Открыть PR на GitHub <ExternalLink size={10} />
                  </a>
                )}
              </div>
              <label className="flex items-center gap-2 text-[10px] text-muted">
                <span>Способ Merge от имени @{pendingApproval.github.login}:</span>
                <select
                  value={approvalGhMergeMethod}
                  onChange={(e) => {
                    const v = e.target.value;
                    setApprovalGhMergeMethod(v === "squash" || v === "rebase" ? v : "merge");
                  }}
                  className="h-7 rounded-md border border-border bg-card2 px-2 text-[11px] text-text"
                >
                  <option value="merge">Create a merge commit (merge)</option>
                  <option value="squash">Squash and merge (squash)</option>
                  <option value="rebase">Rebase and merge (rebase)</option>
                </select>
              </label>
            </div>
          )}
        </ApprovalToast>
      )}

      {opTask &&
        (opTask.status === "waiting_approval" || opTask.status === "waiting_steps") &&
        (() => {
          const opApproval = parsePendingApproval(opTask.pendingApproval);
          const isStepLimit = opApproval?.kind === "step_limit" || opTask.status === "waiting_steps";
          return (
            <ApprovalToast
              dedupeKey={`op-task-${opTask.id}-${opApproval?.id ?? opTask.status}`}
              kind={opApproval?.kind ?? opTask.status}
              badgeLabel={`Оператор #${opTask.id}`}
              title={
                opApproval?.title ??
                (isStepLimit ? `Достигнут лимит ${opTask.maxSteps} шагов` : "Оператор ждёт подтверждения")
              }
              description={opApproval?.description}
              actions={
                isStepLimit ? (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        void actOnOperatorTask("extend_steps", { addSteps: opApproval?.extraSteps ?? 20 })
                      }
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white"
                    >
                      +{opApproval?.extraSteps ?? 20} шагов и продолжить
                    </button>
                    <button
                      type="button"
                      onClick={() => void actOnOperatorTask("cancel")}
                      className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500"
                    >
                      Остановить
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void actOnOperatorTask("approve", { approvalId: opApproval?.id })}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white"
                    >
                      Разрешить
                    </button>
                    <button
                      type="button"
                      onClick={() => void actOnOperatorTask("reject", { approvalId: opApproval?.id })}
                      className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500"
                    >
                      Отклонить
                    </button>
                  </>
                )
              }
            />
          );
        })()}
    </div>
  );
}
