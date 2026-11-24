import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-sub-overseer-"));
process.env.SQLITE_PATH = path.join(dir, "crm.sqlite");
process.env.DATABASE_URL = "";

let userId = 0;
let subagentsRepo: typeof import("@/db/repos/subagents");
let db: typeof import("@/db");

beforeAll(async () => {
  subagentsRepo = await import("@/db/repos/subagents");
  db = await import("@/db");
  await db.getDb();
  await db.q(sql`
    insert into users (email, password_hash, name, role, created_at, updated_at)
    values ('orch@example.com', 'x', 'Orch', 'super_admin', '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`);
  const me = await db.q1<{ id: number }>(sql`select id from users where email = 'orch@example.com'`);
  userId = Number(me?.id);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SQLite DB + миграция 0006 для routingMode и Надсмотрщика", () => {
  it("возвращает безопасные значения по умолчанию, шифрует ключ и учитывает unlockApi", async () => {
    const initial = await subagentsRepo.getAgentOrchestrationConfigPublic(userId);
    expect(initial.routingMode).toBe("linear");
    expect(initial.overseer.enabled).toBe(true);
    expect(initial.overseer.mode).toBe("strict");
    expect(initial.overseer.unlockApi).toBe(false);
    expect(initial.overseer.hasApiKey).toBe(false);

    const saved = await subagentsRepo.upsertAgentOrchestrationConfig(userId, {
      routingMode: "layered",
      overseer: {
        enabled: true,
        mode: "rules_only",
        systemPrompt: "Блокировать любые попытки доступа к .env",
        unlockApi: true,
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "qwen/qwen3-guard",
        apiKey: "sk-overseer-super-secret-7788",
      },
    });
    expect(saved.routingMode).toBe("layered");
    expect(saved.overseer.mode).toBe("rules_only");
    expect(saved.overseer.unlockApi).toBe(true);
    expect(saved.overseer.hasApiKey).toBe(true);
    expect(saved.overseer.apiKeyHint).not.toContain("sk-overseer-super-secret");

    const secretWhenUnlocked = await subagentsRepo.getAgentOrchestrationConfigSecret(userId);
    expect(secretWhenUnlocked.overseer.apiKey).toBe("sk-overseer-super-secret-7788");

    // При блокировке API расшифрованный ключ не утекает наружу, а при разблокировке возвращается снова
    await subagentsRepo.upsertAgentOrchestrationConfig(userId, {
      overseer: { unlockApi: false },
    });
    const secretWhenLocked = await subagentsRepo.getAgentOrchestrationConfigSecret(userId);
    expect(secretWhenLocked.overseer.apiKey).toBe("");
    expect(secretWhenLocked.overseer.hasApiKey).toBe(true);

    // clearApiKey полностью очищает сохранённый ключ
    const cleared = await subagentsRepo.upsertAgentOrchestrationConfig(userId, {
      overseer: { clearApiKey: true, unlockApi: true },
    });
    expect(cleared.overseer.hasApiKey).toBe(false);
    expect(cleared.overseer.apiKeyHint).toBe("");
  });

  it("миграция 0007: хранит toolProfile, posX/posY узлов и orchestratorPos", async () => {
    const sub = await subagentsRepo.createSubagent(userId, {
      name: "Дизайнер",
      toolProfile: "full",
      posX: 420,
      posY: 185,
    });
    expect(sub.toolProfile).toBe("full");
    expect(sub.posX).toBe(420);
    expect(sub.posY).toBe(185);

    const updated = await subagentsRepo.updateSubagent(userId, sub.id, {
      toolProfile: "restricted",
    });
    expect(updated?.toolProfile).toBe("restricted");

    await subagentsRepo.updateSubagentsDependencyTree(userId, [
      {
        id: sub.id,
        isActive: true,
        parentSubagentId: null,
        orchestratorCanCall: true,
        allowedCallees: ["*"],
        posX: 510,
        posY: 260,
      },
    ]);
    await subagentsRepo.upsertAgentOrchestrationConfig(userId, {
      orchestratorPosX: 180,
      orchestratorPosY: 95,
    });

    const list = await subagentsRepo.listSubagentsPublic(userId);
    const reloaded = list.find((s) => s.id === sub.id);
    expect(reloaded?.posX).toBe(510);
    expect(reloaded?.posY).toBe(260);

    const cfg = await subagentsRepo.getAgentOrchestrationConfigPublic(userId);
    expect(cfg.orchestratorPosX).toBe(180);
    expect(cfg.orchestratorPosY).toBe(95);
  });
});
