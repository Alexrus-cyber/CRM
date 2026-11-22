import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Серверный реестр одноразовых подтверждений (nonce + владелец) для Python-агента.
 *
 * Когда `/api/ai/agent` получает SSE-событие `approval_required` от `agent/agent.py`,
 * он сохраняет `userId` и одноразовый `nonce` здесь (не отдавая `nonce` в браузер).
 * Хранится одновременно в памяти процесса и в защищённом временном каталоге (`0o700`/`0o600`),
 * чтобы подтверждения не терялись при HMR в `next dev` или при нескольких воркерах.
 * При запросе `POST /api/ai/agent/approve` сервер проверяет владельца (`userId`),
 * пересылает `nonce` в Python-агент и однократно удаляет запись после обработки.
 */

export type PendingAgentApproval = {
  approvalId: string;
  userId: number;
  nonce: string;
  createdAt: number;
};

const APPROVAL_TTL_MS = 15 * 60 * 1000;

const globalForApprovals = globalThis as typeof globalThis & {
  __crmPendingAgentApprovals?: Map<string, PendingAgentApproval>;
};

function store(): Map<string, PendingAgentApproval> {
  if (!globalForApprovals.__crmPendingAgentApprovals) {
    globalForApprovals.__crmPendingAgentApprovals = new Map();
  }
  return globalForApprovals.__crmPendingAgentApprovals;
}

function approvalsDir(): string {
  const workerSuffix = process.env.VITEST ? `-${process.env.VITEST_WORKER_ID ?? "vitest"}` : "";
  return path.join(os.tmpdir(), `crm-agent-approvals${workerSuffix}`);
}

function entryFilePath(approvalId: string): string {
  const hash = createHash("sha256").update(approvalId, "utf8").digest("hex");
  return path.join(approvalsDir(), `${hash}.json`);
}

function writeDiskEntry(entry: PendingAgentApproval): void {
  try {
    const dir = approvalsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = entryFilePath(entry.approvalId);
    fs.writeFileSync(filePath, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
  } catch {
    /* ignore filesystem errors; memory map remains active */
  }
}

function readDiskEntry(approvalId: string): PendingAgentApproval | null {
  try {
    const filePath = entryFilePath(approvalId);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PendingAgentApproval>;
    if (
      typeof parsed.approvalId === "string" &&
      parsed.approvalId === approvalId &&
      typeof parsed.userId === "number" &&
      Number.isInteger(parsed.userId) &&
      parsed.userId > 0 &&
      typeof parsed.nonce === "string" &&
      typeof parsed.createdAt === "number"
    ) {
      return {
        approvalId: parsed.approvalId,
        userId: parsed.userId,
        nonce: parsed.nonce,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    /* missing or unreadable */
  }
  return null;
}

function deleteDiskEntry(approvalId: string): void {
  try {
    fs.rmSync(entryFilePath(approvalId), { force: true });
  } catch {
    /* ignore */
  }
}

function prune(now = Date.now()): void {
  const map = store();
  for (const [key, item] of map.entries()) {
    if (now - item.createdAt > APPROVAL_TTL_MS) {
      map.delete(key);
      deleteDiskEntry(key);
    }
  }
  try {
    const dir = approvalsDir();
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > APPROVAL_TTL_MS) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function lookupEntry(approvalId: string, now = Date.now()): PendingAgentApproval | null {
  const mem = store().get(approvalId);
  if (mem) {
    if (now - mem.createdAt > APPROVAL_TTL_MS) {
      store().delete(approvalId);
      deleteDiskEntry(approvalId);
      return null;
    }
    return mem;
  }
  const disk = readDiskEntry(approvalId);
  if (!disk) return null;
  if (now - disk.createdAt > APPROVAL_TTL_MS) {
    deleteDiskEntry(approvalId);
    return null;
  }
  store().set(approvalId, disk);
  return disk;
}

export function registerAgentApproval(approvalId: string, userId: number, nonce = ""): void {
  const cleanId = String(approvalId || "").trim();
  const cleanNonce = String(nonce || "").trim();
  if (!cleanId || !Number.isInteger(userId) || userId <= 0) return;
  prune();
  const entry: PendingAgentApproval = {
    approvalId: cleanId,
    userId,
    nonce: cleanNonce,
    createdAt: Date.now(),
  };
  store().set(cleanId, entry);
  writeDiskEntry(entry);
}

export function peekAgentApproval(
  approvalId: string,
  userId: number,
): { ok: true; nonce: string } | { ok: false; status: number; error: string } {
  const now = Date.now();
  prune(now);
  const entry = lookupEntry(approvalId, now);
  if (!entry) {
    return { ok: false, status: 404, error: "Запрос подтверждения не найден или уже истёк" };
  }
  if (entry.userId !== userId) {
    return { ok: false, status: 403, error: "Чужой запрос подтверждения" };
  }
  return { ok: true, nonce: entry.nonce };
}

export function consumeAgentApproval(
  approvalId: string,
  userId: number,
): { ok: true; nonce: string } | { ok: false; status: number; error: string } {
  const found = peekAgentApproval(approvalId, userId);
  if (!found.ok) return found;
  store().delete(approvalId);
  deleteDiskEntry(approvalId);
  return found;
}

export function clearAgentApprovalsForTests(): void {
  store().clear();
  try {
    fs.rmSync(approvalsDir(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
