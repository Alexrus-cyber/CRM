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
  FolderOpen,
  FolderOutput,
  Gamepad2,
  Gauge,
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
import { AI_DEFAULT_BASE_URL, AI_MAX_FILE_BYTES, AI_STORAGE_SETTINGS, formatBytes, type AiSettings } from "@/lib/ai";
import { Input, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useStoredJson, useStoredNumber } from "@/lib/useStoredValue";
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
    | "project_created"
    | "sandbox_export"
    | "operator_plan"
    | "operator_task"
    | "operator_screen";
  url?: string;
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
  source?: string;
  destination?: string;
  mode?: string;
  filesCount?: number;
  task?: string;
  maxSteps?: number;
  coachAfterEachStep?: boolean;
  operatorTrustLevel?: string;
};

type SandboxProject = { name: string; files?: number };

type SandboxState = {
  available: boolean;
  root?: string;
  projects: SandboxProject[];
  items: Array<{ path: string; isDir: boolean; size: number }>;
  processes: Array<{ pid: number; command: string; cwd: string; alive: boolean }>;
};

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
        return files !== undefined ? { name, files } : { name };
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
    .map((obj) => ({
      pid: Number(obj.pid ?? 0) || 0,
      command: String(obj.command ?? ""),
      cwd: String(obj.cwd ?? "."),
      alive: Boolean(obj.alive),
    }))
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
  "Помоги с действиями на экране: сформулируй задачу для Оператора и запусти его с моего согласия",
  "Сделай CSV-файл с планом на неделю по продажам",
];

const DEFAULT_SETTINGS: AiSettings = { baseUrl: AI_DEFAULT_BASE_URL, apiKey: "", model: "" };
const DEFAULT_RAG_PREFS: RagPrefs = { folderId: 0, ragFull: false, ragChunks: 12 };

function decodeSystemPrompt(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed.slice(0, 12_000) : "";
  } catch {
    return String(raw ?? "").slice(0, 12_000);
  }
}

function decodeAgentSteps(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function decodeSettings(raw: string): AiSettings {
  const parsed = JSON.parse(raw) as Partial<AiSettings>;
  return {
    baseUrl: String(parsed.baseUrl ?? DEFAULT_SETTINGS.baseUrl),
    apiKey: String(parsed.apiKey ?? ""),
    model: String(parsed.model ?? ""),
  };
}

function decodeRagPrefs(raw: string): RagPrefs {
  try {
    const parsed = JSON.parse(raw) as Partial<RagPrefs>;
    return {
      folderId: Math.max(0, Math.floor(Number(parsed.folderId) || 0)),
      ragFull: Boolean(parsed.ragFull),
      ragChunks: Math.min(500, Math.max(0, Math.floor(Number(parsed.ragChunks ?? 12)))),
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

export function AgentChat({ userName }: { userName: string }) {
  const [settings, setSettings] = useStoredJson<AiSettings>(
    AI_STORAGE_SETTINGS,
    DEFAULT_SETTINGS,
    decodeSettings,
  );
  const [params, setParams] = useStoredJson<GenParams>(
    "crm.ai.agent.params.v1",
    GEN_DEFAULT_PARAMS,
    decodeGenParams,
  );
  const [trustLevel, setTrustLevel] = useStoredJson<TrustLevel>(
    "crm.ai.agent.trust.v1",
    DEFAULT_TRUST_LEVEL,
    decodeTrustLevel,
  );
  const [ragPrefs, setRagPrefs] = useStoredJson<RagPrefs>(
    "crm.ai.agent.rag.v1",
    DEFAULT_RAG_PREFS,
    decodeRagPrefs,
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
    decodeSystemPrompt,
  );

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

  // Песочница Sandbox и экспорт на ПК.
  const [sandbox, setSandbox] = useState<SandboxState | null>(null);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [exportSource, setExportSource] = useState(".");
  const [exportDest, setExportDest] = useState("");
  const [exportMode, setExportMode] = useState<"copy" | "move">("copy");
  const [sandboxBusy, setSandboxBusy] = useState(false);

  // Summary и архив переписок (.md).
  const [transcripts, setTranscripts] = useState<TranscriptMeta[]>([]);
  const [transcriptsOpen, setTranscriptsOpen] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const autoScrollPausedRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ragDirRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const conversationIdRef = useRef<number | null>(null);
  const opTaskRef = useRef<OperatorTask | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
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

  const loadHealth = useCallback(async (): Promise<Health> => {
    try {
      const res = await fetch("/api/ai/agent", { cache: "no-store" });
      if (!res.ok) return { available: false, hint: "Агент доступен только главному администратору" };
      const data = (await res.json()) as Record<string, unknown>;
      return {
        available: Boolean(data.available),
        endpoint: data.endpoint ? String(data.endpoint) : undefined,
        hint: data.hint ? String(data.hint) : undefined,
        model: data.model ? String(data.model) : null,
        sandbox: data.sandbox ? String(data.sandbox) : undefined,
        tools: Array.isArray(data.tools) ? data.tools.map((t) => String(t ?? "")).filter(Boolean) : [],
      };
    } catch {
      return { available: false, hint: "Не удалось проверить агента" };
    }
  }, []);

  const refreshSandbox = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/agent/sandbox", { cache: "no-store" });
      if (!res.ok) return;
      const data: unknown = await res.json();
      setSandbox(normalizeSandboxState(data));
    } catch {
      /* фоновая проверка — тихо игнорируем */
    }
  }, []);

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
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Не удалось удалить чат агента");
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
      setAttachments((prev) => [
        ...prev.slice(0, 4),
        {
          name: item.fileName || `transcript-${item.id}.md`,
          mime: "text/markdown",
          size: content.length,
          data: "",
          text: content,
          note: "архивная переписка агента",
        },
      ]);
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
        if (file.size > AI_MAX_FILE_BYTES) {
          skipped += 1;
        } else {
          const extracted = await extractFile(file);
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
          const active = list.find((t) =>
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
      setScreenCapture(null);
      setPendingApproval(null);
      setApprovalDest("");
      setApprovalTaskDraft("");
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
    try {
      let convId = targetTaskId === opTask?.id ? opConversationId : null;
      if (!convId) {
        const refreshed = await refreshOpTask(taskId);
        convId = typeof refreshed?.conversationId === "number" ? refreshed.conversationId : null;
      }
      if (!convId) {
        setError(`Чат для задачи Оператора #${taskId} ещё не сформирован`);
        return;
      }
      await refreshConversations();
      await openConversation(convId);
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
      await refreshSandbox();
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
      await refreshSandbox();
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

  const addAgentFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0 || running || reading || historyLoading || conversationId === null) return;
      setError(null);
      setReading(true);
      void readOperatorFiles(attachments, incoming)
        .then(({ files, errors }) => {
          if (files.length > 0) setAttachments((prev) => [...prev, ...files]);
          if (errors.length > 0) setError(errors[0]);
        })
        .finally(() => setReading(false));
    },
    [attachments, conversationId, historyLoading, reading, running],
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
      const res = await fetch("/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((t) => ({ role: t.role, content: t.content })),
          settings,
          params,
          ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
          trustLevel,
          maxSteps: maxSteps <= 0 ? 0 : Math.floor(maxSteps),
          ragFolderId: ragPrefs.folderId,
          ragFull: ragPrefs.ragFull,
          ragChunks: ragPrefs.ragChunks,
          contextLimit,
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
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          const eventLine = raw.split("\n").find((line) => line.startsWith("event:"));
          const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          const event = eventLine ? eventLine.slice(6).trim() : "message";
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event === "status") {
            setStatus(String(data.text ?? ""));
          } else if (event === "approval_required") {
            const req: PendingApproval = {
              approvalId: String(data.approvalId ?? ""),
              kind: String(data.kind ?? "command"),
              title: String(data.title ?? "Требуется подтверждение"),
              description: String(data.description ?? ""),
              command: data.command ? String(data.command) : undefined,
              cwd: data.cwd ? String(data.cwd) : undefined,
              source: data.source ? String(data.source) : undefined,
              destination: data.destination ? String(data.destination) : undefined,
              mode: data.mode ? String(data.mode) : undefined,
              filesCount: typeof data.filesCount === "number" ? data.filesCount : undefined,
              task: data.task ? String(data.task) : undefined,
              maxSteps: typeof data.maxSteps === "number" ? data.maxSteps : undefined,
              coachAfterEachStep:
                typeof data.coachAfterEachStep === "boolean" ? data.coachAfterEachStep : true,
              operatorTrustLevel: data.operatorTrustLevel ? String(data.operatorTrustLevel) : undefined,
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
            }
            scrollDown();
          } else if (event === "rag") {
            setNotice(
              `RAG «${String(data.folderName ?? "папка")}»: подключено ${Number(data.hits ?? 0)} из ${Number(data.totalChunks ?? 0)} фрагментов${data.truncated ? " (обрезано по лимиту контекста)" : ""}.`,
            );
          } else if (event === "reasoning") {
            assistantDraft.reasoning = String(data.text ?? "");
            patch((t) => ({ ...t, reasoning: assistantDraft.reasoning }));
            scrollDown();
          } else if (event === "text") {
            assistantDraft.content = String(data.text ?? "");
            patch((t) => ({ ...t, content: assistantDraft.content }));
            scrollDown();
          } else if (event === "error") {
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
              const action: AgentAction = {
                type: "open_url",
                url: String(data.url ?? ""),
                label: String(data.label ?? data.url ?? ""),
                autoplay: Boolean(data.autoplay),
              };
              assistantDraft.actions.push(action);
              patch((t) => ({ ...t, actions: [...t.actions, action] }));
              if (action.url) openUrl(action.url);
            } else {
              const action: AgentAction = {
                type: String(data.type ?? "command_result") as AgentAction["type"],
                label: String(data.label ?? data.command ?? data.project ?? data.path ?? data.source ?? data.task ?? ""),
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
              };
              assistantDraft.actions.push(action);
              patch((t) => ({ ...t, actions: [...t.actions, action] }));
              if (action.type === "operator_task" && action.taskId) {
                void refreshOpTask(action.taskId);
              }
              if (action.type === "operator_plan" && action.task) {
                setOpDraftPrompt(action.task);
                setOpDraftMode(normalizeTaskMode(action.mode));
                setOpDraftSteps(action.maxSteps ?? 30);
                setOpDraftNotes(action.notes ?? "");
              }
              void refreshSandbox();
            }
            scrollDown();
          } else if (event === "done") {
            setStatus(null);
            setPendingApproval(null);
            setScreenCapture(null);
            void refreshSandbox();
          }
        }
      }
    } catch (caught) {
      assistantDraft.error = userSaved
        ? "Соединение с агентом прервалось"
        : caught instanceof Error
          ? caught.message
          : "Не удалось сохранить сообщение";
      patch((t) => ({ ...t, error: assistantDraft.error }));
    } finally {
      let updatedTurns = history;
      if (userSaved) {
        try {
          const storedAssistant = await saveConversationMessage(activeId, {
            role: "assistant",
            content: assistantDraft.content,
            reasoning: assistantDraft.reasoning,
            error: assistantDraft.error,
            actions: assistantDraft.actions,
            files: assistantDraft.files.map(({ name, mime, size }) => ({ name, mime, size })),
          });
          const mergedAssistant: Turn = {
            ...storedAssistant,
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
  const remoteApi = !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(normalized);

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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold text-amber-500">
          <Sparkles size={13} /> Агент
        </span>
        <span
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
        {health?.endpoint && <span className="text-muted">· {health.endpoint}</span>}
        <button
          type="button"
          onClick={() => {
            void loadHealth().then(setHealth);
            void refreshSandbox();
            void refreshOperatorOverview();
          }}
          className="ml-auto rounded-lg border border-border bg-card px-2 py-1 font-medium text-muted transition hover:text-text"
        >
          Проверить
        </button>
      </div>

      {/* Выбор уровня доверия ИИ */}
      <TrustSelector value={trustLevel} onChange={setTrustLevel} disabled={running} />

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

      {/* Индикатор контекста, панель RAG-папок, Sandbox и архива переписок */}
      <div className="grid gap-2 lg:grid-cols-3">
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
            <button
              type="button"
              onClick={() => setRagOpen((v) => !v)}
              className="text-[10px] font-medium text-accent2 hover:underline"
            >
              {ragOpen ? "Скрыть" : activeRagFolder ? `${activeRagFolder.chunksCount} фрагм.` : "Настроить"}
            </button>
          </div>
          <p className="mt-1 truncate text-[10px] text-muted">
            {activeRagFolder
              ? `${activeRagFolder.name} · ${activeRagFolder.filesCount} файлов${ragPrefs.ragFull ? " · вся база" : ` · до ${ragPrefs.ragChunks} фрагм.`}`
              : "Папка не выбрана — можно загрузить папку любого размера"}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-2.5 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-medium text-text">
              <Terminal size={13} className="text-accent2" /> Sandbox и архивы
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
            Проекты: {sandbox?.projects?.length ? sandbox.projects.map((p) => p.name).join(", ") : "пока пусто"} · процессов:{" "}
            {sandbox?.processes?.filter((p) => p.alive).length ?? 0}
          </p>
        </div>
      </div>

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
                max={500}
                disabled={ragPrefs.ragFull}
                value={ragPrefs.ragChunks}
                onChange={(e) =>
                  setRagPrefs({ ...ragPrefs, ragChunks: Math.min(500, Math.max(0, Number(e.target.value) || 0)) })
                }
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
                onClick={() => void refreshSandbox()}
                className="rounded-lg border border-border bg-card2 px-2 py-1 text-[10px] text-muted hover:text-text"
              >
                Обновить
              </button>
            </div>
          </div>

          {sandbox?.projects && sandbox.projects.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {sandbox.projects.map((proj) => (
                <div
                  key={proj.name}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-card2 px-2 py-1 text-[10px]"
                >
                  <span className="font-medium text-text">
                    {proj.name}
                    {typeof proj.files === "number" ? ` (${proj.files} ф.)` : ""}
                  </span>
                  <a
                    href={`/api/ai/agent/sandbox?download=${encodeURIComponent(proj.name)}`}
                    className="text-emerald-500 hover:underline"
                  >
                    ZIP
                  </a>
                  <button
                    type="button"
                    onClick={() => setExportSource(proj.name)}
                    className="text-accent2 hover:underline"
                  >
                    экспорт
                  </button>
                </div>
              ))}
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
                .map((proc) => (
                  <div
                    key={proc.pid}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card2 px-2 py-1 text-[10px]"
                  >
                    <span className="truncate font-mono">
                      PID {proc.pid}: {proc.command}
                    </span>
                    <button
                      type="button"
                      onClick={() => void stopSandboxProcess(proc.pid)}
                      disabled={sandboxBusy}
                      className="flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-red-500"
                    >
                      <Square size={10} /> Стоп
                    </button>
                  </div>
                ))}
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
                    onClick={() => void refreshOpTask(t.id)}
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

      {/* Живое сопровождение Оператора, запущенного из Агента */}
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
          <div className="space-y-2 rounded-2xl border border-cyan-500/40 bg-card p-3 text-[11px]">
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

      <GenSettings
        value={params}
        onChange={setParams}
        defaultOpen
        subtitle="Как модель думает и генерирует ответ. Пустое поле — параметр не передаём."
      >
        <div className="space-y-2.5">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
              <label htmlFor="agent-system-prompt" className="font-medium text-text">
                Системный промпт агента
              </label>
              <div className="flex items-center gap-2 text-[10px]">
                <span>{systemPrompt.length}/12000</span>
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
              onChange={(event) => setSystemPrompt(event.target.value.slice(0, 12_000))}
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
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 pt-3 text-[11px] text-muted">
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
        </div>

        <div className="grid gap-2 border-b border-border p-3 sm:grid-cols-3">
          <label className="text-[11px] text-muted">
            Base URL
            <input
              value={settings.baseUrl}
              onChange={(e) => saveSettings({ ...settings, baseUrl: e.target.value })}
              placeholder={AI_DEFAULT_BASE_URL}
              className="mt-1 h-8 w-full rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
            />
          </label>
          <label className="text-[11px] text-muted">
            Модель
            <input
              value={settings.model}
              onChange={(e) => saveSettings({ ...settings, model: e.target.value })}
              placeholder="например, qwen3:8b"
              className="mt-1 h-8 w-full rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
            />
          </label>
          <label className="text-[11px] text-muted">
            API-ключ (если нужен)
            <input
              value={settings.apiKey}
              onChange={(e) => saveSettings({ ...settings, apiKey: e.target.value })}
              type="password"
              placeholder="необязательно"
              className="mt-1 h-8 w-full rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
            />
          </label>
        </div>

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
                      return (
                        <a
                          key={`${action.url}-${index}`}
                          href={action.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-2.5 py-2 font-medium text-accent2 transition hover:bg-accent/20"
                        >
                          {action.autoplay ? <PlayCircle size={14} /> : <ExternalLink size={14} />}
                          <span className="min-w-0 flex-1 truncate">{action.label}</span>
                          <span className="text-[10px] text-muted">открыть</span>
                        </a>
                      );
                    }
                    if (action.type === "command_result") {
                      return (
                        <div
                          key={`cmd-${index}`}
                          className="rounded-xl border border-border bg-card px-2.5 py-2 text-[11px]"
                        >
                          <p className="flex items-center gap-1.5 font-mono font-medium text-text">
                            <Terminal size={12} className="text-accent2" />
                            {action.command}
                            {action.exitCode !== undefined && action.exitCode !== null && (
                              <span className="ml-auto text-[10px] text-muted">код {action.exitCode}</span>
                            )}
                          </p>
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
                    return (
                      <div
                        key={`act-${index}`}
                        className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-2 text-[11px] text-muted"
                      >
                        <FolderOutput size={13} className="shrink-0 text-emerald-500" />
                        <span className="min-w-0 flex-1 truncate">
                          {action.type === "project_created" && `Проект создан в Sandbox: ${action.project}`}
                          {action.type === "sandbox_file" && `Файл в Sandbox: ${action.path}`}
                          {action.type === "sandbox_export" &&
                            `Экспорт (${action.filesCount ?? 0} файлов): ${action.source} → ${action.destination}`}
                        </span>
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
              title="Приложить файлы для анализа (до 5 по 10 МБ)"
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
            <button
              type="button"
              onClick={() => void send()}
              disabled={running || historyLoading || conversationId === null || (!text.trim() && attachments.length === 0)}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-xs font-medium text-white transition disabled:opacity-40"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Запустить
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted">
            Скрепка — файлы для анализа (до 5 по 10 МБ) или сохранённые .md-переписки. В истории остаются имена файлов,
            а при 80% лимита контекста чат автоматически архивируется и продолжается через Summary.
          </p>
        </div>
      </div>

      {pendingApproval && (
        <ApprovalToast
          kind={pendingApproval.kind}
          tone={pendingApproval.kind === "capture_screen" ? "cyan" : "amber"}
          badgeLabel={
            pendingApproval.kind === "capture_screen"
              ? "Запрос снимка экрана"
              : pendingApproval.kind === "call_operator"
                ? "Запуск Оператора"
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
                  {pendingApproval.kind === "call_operator" ? "Разрешить и запустить Оператора" : "Разрешить"}
                </button>
                <button
                  type="button"
                  onClick={() => void sendApprovalDecision(false)}
                  disabled={approvalBusy}
                  className="flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-red-500 hover:bg-red-500/20 disabled:opacity-50"
                >
                  <X size={12} /> Отклонить
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
