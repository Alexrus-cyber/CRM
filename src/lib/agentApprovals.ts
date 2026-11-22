/**
 * Серверный реестр одноразовых подтверждений (nonce + владелец) для Python-агента.
 *
 * Когда `/api/ai/agent` получает SSE-событие `approval_required` от `agent/agent.py`,
 * он сохраняет `userId` и одноразовый `nonce` здесь (не отдавая `nonce` в браузер).
 * При запросе `POST /api/ai/agent/approve` сервер проверяет владельца (`userId`),
 * однократно потребляет запись и пересылает `nonce` в Python-агент.
 */

type PendingAgentApproval = {
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

function prune(now = Date.now()): void {
  const map = store();
  for (const [key, item] of map.entries()) {
    if (now - item.createdAt > APPROVAL_TTL_MS) {
      map.delete(key);
    }
  }
}

export function registerAgentApproval(approvalId: string, userId: number, nonce: string): void {
  if (!approvalId || !nonce || !Number.isInteger(userId) || userId <= 0) return;
  prune();
  store().set(approvalId, {
    approvalId,
    userId,
    nonce,
    createdAt: Date.now(),
  });
}

export function consumeAgentApproval(
  approvalId: string,
  userId: number,
): { ok: true; nonce: string } | { ok: false; status: number; error: string } {
  prune();
  const map = store();
  const entry = map.get(approvalId);
  if (!entry) {
    return { ok: false, status: 404, error: "Запрос подтверждения не найден или уже истёк" };
  }
  if (entry.userId !== userId) {
    return { ok: false, status: 403, error: "Чужой запрос подтверждения" };
  }
  map.delete(approvalId);
  return { ok: true, nonce: entry.nonce };
}

export function clearAgentApprovalsForTests(): void {
  store().clear();
}
