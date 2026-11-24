import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TRUST_LEVEL, normalizeTrustLevel } from "@/lib/trust";
import {
  buildFallbackSummary,
  estimateAgentConversationTokens,
  formatTranscriptMarkdown,
  shouldAutoRollover,
} from "@/lib/transcripts";
import { AGENT_MAX_STEPS } from "@/lib/genParams";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-trust-tr-"));
process.env.SQLITE_PATH = path.join(dir, "crm.sqlite");
process.env.DATABASE_URL = "";

let userId = 0;
let otherUserId = 0;
let regularAdminId = 0;
let repo: typeof import("@/db/repo");
let db: typeof import("@/db");

beforeAll(async () => {
  repo = await import("@/db/repo");
  db = await import("@/db");
  await db.getDb();
  await db.q(sql`
    insert into users (email, password_hash, name, role, created_at, updated_at)
    values
      ('admin1@example.com', 'x', 'Admin', 'super_admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('admin2@example.com', 'x', 'Other', 'super_admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('plainadmin@example.com', 'x', 'Plain Admin', 'admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  const first = await db.q1<{ id: number }>(sql`select id from users where email = 'admin1@example.com'`);
  const second = await db.q1<{ id: number }>(sql`select id from users where email = 'admin2@example.com'`);
  const plainAdmin = await db.q1<{ id: number }>(sql`select id from users where email = 'plainadmin@example.com'`);
  userId = Number(first?.id);
  otherUserId = Number(second?.id);
  regularAdminId = Number(plainAdmin?.id);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("уровни доверия ИИ и оценка контекста/Summary", () => {
  it("нормализует уровни доверия, по умолчанию verified", () => {
    expect(DEFAULT_TRUST_LEVEL).toBe("verified");
    expect(normalizeTrustLevel("full")).toBe("full");
    expect(normalizeTrustLevel("none")).toBe("none");
    expect(normalizeTrustLevel("unknown")).toBe("verified");
  });

  it("считает токены, порог 80% и формирует markdown-стенограмму с Summary", () => {
    const turns = [
      { role: "user" as const, content: "Создай сайт landing в Sandbox" },
      {
        role: "assistant" as const,
        content: "Проект создан",
        files: [{ name: "index.html", mime: "text/html", size: 320 }],
        actions: [{ type: "project_created", label: "landing" }],
      },
    ];
    const used = estimateAgentConversationTokens(turns);
    expect(used).toBeGreaterThan(20);
    expect(shouldAutoRollover(800, 1000, 2)).toBe(true);
    expect(shouldAutoRollover(799, 1000, 2)).toBe(false);
    expect(shouldAutoRollover(900, 1000, 1)).toBe(false);

    const summary = buildFallbackSummary(turns, "Сайт");
    expect(summary).toContain("Создай сайт landing в Sandbox");
    expect(summary).toContain("index.html");

    const md = formatTranscriptMarkdown({ title: "Сайт", summary, turns });
    expect(md).toContain("# Переписка агента: Сайт");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Полный текст переписки");
  });
});

describe("БД: подтверждения оператора, расширение шагов на месте и архив переписок", () => {
  it("управляет очередью подтверждений, безлимитными шагами для всех ролей и активностью бота", async () => {
    const conn = await repo.createAgentConnection(userId, "Локальный", "http://localhost:3000");
    const createdToken = await repo.createAgentConnectionToken(userId, conn.id, "Тест");
    await repo.findAgentTokenOwner(createdToken!.token);

    const task = await repo.createAgentTask(userId, "Запусти калькулятор", 10, "verified");
    expect(task.trustLevel).toBe("verified");
    expect(task.maxSteps).toBe(10);

    const paused = await repo.requestAgentTaskApproval(task.id, userId, {
      id: "req-1",
      kind: "dangerous_action",
      title: "Запустить calc?",
      description: "Запуск приложения на ПК",
      action: { type: "launch_app", app: "calc" },
    });
    expect(paused?.kind).toBe("dangerous_action");
    expect((await repo.getAgentTask(userId, task.id))?.status).toBe("waiting_approval");

    const activeStatus = await repo.getAgentBotConnectionStatus(userId, conn.id);
    expect(activeStatus.runningTask?.id).toBe(task.id);

    const approved = await repo.respondAgentTaskApproval(task.id, userId, {
      approvalId: "req-1",
      decision: "approved",
    });
    expect(approved?.status).toBe("running");
    expect(approved?.approvalResponse?.decision).toBe("approved");

    await repo.requestAgentTaskApproval(task.id, userId, {
      id: "req-steps",
      kind: "step_limit",
      title: "Лимит шагов",
      description: "Нужны ещё шаги",
      extraSteps: 20,
    });
    expect((await repo.getAgentTask(userId, task.id))?.status).toBe("waiting_steps");
    const extended = await repo.extendAgentTaskSteps(task.id, userId, 20);
    expect(extended?.status).toBe("running");
    expect(extended?.maxSteps).toBe(30);

    // Главный админ (super_admin) не имеет потолка 500/2000 при продлении и поддерживает maxSteps = 0 (без лимита).
    const superExpanded = await repo.extendAgentTaskSteps(task.id, userId, 5000);
    expect(superExpanded?.maxSteps).toBe(5030);
    const superUnlimited = await repo.createAgentTask(userId, "Безлимитная задача", 0, "full");
    expect(superUnlimited.maxSteps).toBe(0);

    // Обычный администратор (admin) теперь тоже без лимита шагов: явное число принимается без потолка.
    const adminTask = await repo.createAgentTask(regularAdminId, "Задача обычного админа", 900, "verified");
    expect(adminTask.maxSteps).toBe(900);
    const adminExtended = await repo.extendAgentTaskSteps(adminTask.id, regularAdminId, 200);
    expect(adminExtended?.maxSteps).toBe(1100);
  });

  it("сохраняет полные стенограммы переписки с изоляцией по пользователям", async () => {
    const saved = await repo.createAgentTranscript({
      userId,
      conversationId: 1,
      title: "Чат про отчёт",
      summary: "Сделали отчёт",
      fileName: "report-chat.md",
      content: "# Переписка\n\nТекст",
    });
    expect(saved.chars).toBeGreaterThan(10);

    expect(await repo.listAgentTranscripts(userId)).toHaveLength(1);
    expect(await repo.listAgentTranscripts(otherUserId)).toHaveLength(0);
    expect(await repo.getAgentTranscript(otherUserId, saved.id)).toBeNull();
    expect((await repo.getAgentTranscript(userId, saved.id))?.content).toContain("# Переписка");
  });
});
