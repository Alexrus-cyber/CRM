/**
 * Помощники для контроля контекста вкладки «Агент», автогенерации Summary
 * при приближении к лимиту и сохранения полной переписки в файл для будущей обработки.
 */

export const DEFAULT_AGENT_CONTEXT_LIMIT = 16_384;
export const ROLLOVER_THRESHOLD_RATIO = 0.8;
export const CHARS_PER_TOKEN_ESTIMATE = 2.5;

export type TranscriptTurn = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  error?: string;
  attached?: Array<{ name: string; size?: number }>;
  actions?: Array<{ type: string; label?: string; url?: string; summary?: string }>;
  files?: Array<{ name: string; mime?: string; size?: number }>;
};

export function estimateTurnTokens(turn: TranscriptTurn): number {
  let chars = (turn.content ?? "").length;
  if (turn.reasoning) chars += Math.min(turn.reasoning.length, 1500);
  if (turn.error) chars += turn.error.length;
  if (turn.attached?.length) {
    chars += turn.attached.reduce((sum, f) => sum + f.name.length + 12, 0);
  }
  if (turn.files?.length) {
    chars += turn.files.reduce((sum, f) => sum + f.name.length + 16, 0);
  }
  if (turn.actions?.length) {
    chars += turn.actions.reduce((sum, a) => sum + (a.label?.length ?? 0) + (a.url?.length ?? 0) + 12, 0);
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE));
}

export function estimateAgentConversationTokens(
  turns: TranscriptTurn[],
  extraChars = 600,
): number {
  const turnsTokens = turns.reduce((sum, turn) => sum + estimateTurnTokens(turn), 0);
  return turnsTokens + Math.ceil(Math.max(0, extraChars) / CHARS_PER_TOKEN_ESTIMATE);
}

export function shouldAutoRollover(
  usedTokens: number,
  contextLimit: number,
  turnsCount: number,
  thresholdRatio = ROLLOVER_THRESHOLD_RATIO,
): boolean {
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) return false;
  if (turnsCount < 2) return false;
  return usedTokens >= Math.floor(contextLimit * thresholdRatio);
}

export function buildTranscriptFileName(title: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = (title || "agent-chat")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `transcript-${slug || "agent-chat"}-${stamp}.md`;
}

export function buildFallbackSummary(turns: TranscriptTurn[], title = "Чат агента"): string {
  const userMsgs = turns.filter((t) => t.role === "user" && t.content.trim());
  const assistantMsgs = turns.filter((t) => t.role === "assistant" && t.content.trim());
  const createdFiles = Array.from(
    new Set(turns.flatMap((t) => (t.files ?? []).map((f) => f.name)).filter(Boolean)),
  );
  const usedActions = Array.from(
    new Set(turns.flatMap((t) => (t.actions ?? []).map((a) => a.label || a.url || a.type)).filter(Boolean)),
  );

  const lines: string[] = [
    `Summary чата «${title}» (${turns.length} сообщений):`,
    "",
    "### Основные запросы пользователя",
  ];
  for (const msg of userMsgs.slice(-6)) {
    lines.push(`- ${msg.content.replace(/\s+/g, " ").trim().slice(0, 220)}`);
  }
  if (assistantMsgs.length > 0) {
    lines.push("", "### Ключевые результаты и ответы агента");
    for (const msg of assistantMsgs.slice(-4)) {
      lines.push(`- ${msg.content.replace(/\s+/g, " ").trim().slice(0, 260)}`);
    }
  }
  if (createdFiles.length > 0) {
    lines.push("", `### Созданные файлы\n- ${createdFiles.join("\n- ")}`);
  }
  if (usedActions.length > 0) {
    lines.push("", `### Выполненные действия\n- ${usedActions.slice(0, 12).join("\n- ")}`);
  }
  lines.push("", "### Продолжение работы\nПолная переписка сохранена в приложенном файле и готова для дальнейшей обработки.");
  return lines.join("\n");
}

export function formatTranscriptMarkdown(input: {
  title: string;
  summary?: string;
  createdAt?: string;
  turns: TranscriptTurn[];
}): string {
  const created = input.createdAt || new Date().toISOString();
  const lines: string[] = [
    `# Переписка агента: ${input.title || "Новый чат"}`,
    `Дата архивации: ${created}`,
    `Сообщений: ${input.turns.length}`,
    "",
  ];
  if (input.summary?.trim()) {
    lines.push("## Summary", "", input.summary.trim(), "");
  }
  lines.push("## Полный текст переписки", "");

  input.turns.forEach((turn, idx) => {
    const who = turn.role === "user" ? "Пользователь" : "Агент";
    lines.push(`### ${idx + 1}. ${who}`);
    if (turn.attached?.length) {
      lines.push(`Вложения: ${turn.attached.map((f) => f.name).join(", ")}`);
    }
    if (turn.content.trim()) {
      lines.push("", turn.content.trim());
    }
    if (turn.reasoning?.trim()) {
      lines.push("", `<details><summary>Размышления</summary>\n\n${turn.reasoning.trim()}\n\n</details>`);
    }
    if (turn.actions?.length) {
      lines.push(
        "",
        "Действия:",
        ...turn.actions.map((a) => `- [${a.type}] ${a.label || a.url || a.summary || ""}`),
      );
    }
    if (turn.files?.length) {
      lines.push("", `Файлы: ${turn.files.map((f) => f.name).join(", ")}`);
    }
    if (turn.error?.trim()) {
      lines.push("", `Ошибка: ${turn.error.trim()}`);
    }
    lines.push("");
  });

  return lines.join("\n");
}
