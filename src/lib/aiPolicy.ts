/**
 * Ограничения ИИ по ролям.
 *
 * Один источник правды и для интерфейса (какие режимы раздумий показывать,
 * есть ли RAG, сколько токенов и шагов доступно), и для сервера (`/api/ai/chat`,
 * `/api/ai/agent`, `/api/agent/tasks`).
 *
 * Правила:
 *
 * | Роль            | Чат, токенов | В месяц     | Шагов агента | RAG | Раздумья            |
 * | --------------- | ------------ | ----------- | ------------ | --- | ------------------- |
 * | Главный админ   | без лимита   | без лимита  | без лимита   | да  | любые               |
 * | Администратор   | 1 000 000    | без лимита  | до 500       | да  | любые               |
 * | Разработчик     | 1 000 000    | 5 000 000   | до 500       | да  | любые               |
 * | Менеджер        | 1 000 000    | 1 500 000   | до 500       | нет | без / коротко       |
 * | Консультант     | 1 000 000    | 500 000     | до 500       | нет | без / коротко       |
 * | Сотрудник       | 1 000 000    | 500 000     | до 500       | нет | без / коротко       |
 *
 * Месячный лимит администратор может расширить конкретному сотруднику на
 * текущий месяц (таблица `ai_quota_overrides`) — это не меняет роль.
 */
import type { Role } from "@/db/schema";
import type { ReasoningMode } from "./ai";
import { AGENT_MAX_STEPS } from "./genParams";

export type AiRolePolicy = {
  role: Role;
  /** Потолок токенов на один чат; null — без ограничения. */
  perChatTokens: number | null;
  /** Месячный лимит; null — без ограничения. */
  monthlyTokens: number | null;
  /** Предел шагов агента/оператора; null — без ограничения. */
  maxSteps: number | null;
  /** Доступна ли RAG-папка. */
  rag: boolean;
  /** Разрешённые режимы раздумий. */
  reasoning: ReasoningMode[];
  /** Короткое описание для интерфейса. */
  summary: string;
  /** Сколько чатов можно вести (всегда неограниченно, поле — для UI). */
  chatsUnlimited: boolean;
};

const FULL_REASONING: ReasoningMode[] = ["default", "off", "low", "medium", "high", "max", "budget"];
const LIGHT_REASONING: ReasoningMode[] = ["off", "low"];

export function isUnlimitedAiRole(role: string | null | undefined): boolean {
  return role === "super_admin";
}

export const AI_ROLE_POLICY: Record<Role, AiRolePolicy> = {
  super_admin: {
    role: "super_admin",
    perChatTokens: null,
    monthlyTokens: null,
    maxSteps: null,
    rag: true,
    reasoning: FULL_REASONING,
    summary: "Без лимитов на всё: любые режимы раздумий (включая Max), RAG, файлы, контекст, токены и шаги",
    chatsUnlimited: true,
  },
  admin: {
    role: "admin",
    perChatTokens: 1_000_000,
    monthlyTokens: null,
    maxSteps: AGENT_MAX_STEPS,
    rag: true,
    reasoning: FULL_REASONING,
    summary: "Полный доступ: любые режимы раздумий и RAG, до 1 млн на чат и до 500 шагов, без месячного лимита",
    chatsUnlimited: true,
  },
  developer: {
    role: "developer",
    perChatTokens: 1_000_000,
    monthlyTokens: 5_000_000,
    maxSteps: AGENT_MAX_STEPS,
    rag: true,
    reasoning: FULL_REASONING,
    summary: "Полный доступ: любые режимы и RAG, до 1 млн на чат, 5 млн в месяц и до 500 шагов",
    chatsUnlimited: true,
  },
  manager: {
    role: "manager",
    perChatTokens: 1_000_000,
    monthlyTokens: 1_500_000,
    maxSteps: AGENT_MAX_STEPS,
    rag: false,
    reasoning: LIGHT_REASONING,
    summary: "Раздумья только «без» или «коротко», RAG выключен, 1,5 млн токенов в месяц и до 500 шагов",
    chatsUnlimited: true,
  },
  consultant: {
    role: "consultant",
    perChatTokens: 1_000_000,
    monthlyTokens: 500_000,
    maxSteps: AGENT_MAX_STEPS,
    rag: false,
    reasoning: LIGHT_REASONING,
    summary: "Раздумья только «без» или «коротко», RAG выключен, 500 тыс. токенов в месяц и до 500 шагов",
    chatsUnlimited: true,
  },
  user: {
    role: "user",
    perChatTokens: 1_000_000,
    monthlyTokens: 500_000,
    maxSteps: AGENT_MAX_STEPS,
    rag: false,
    reasoning: LIGHT_REASONING,
    summary: "Раздумья только «без» или «коротко», RAG выключен, 500 тыс. токенов в месяц и до 500 шагов",
    chatsUnlimited: true,
  },
};

/** Политика роли с учётом расширения месяца, которое выдал администратор. */
export function aiPolicyFor(role: Role, monthlyOverride: number | null = null): AiRolePolicy {
  const base = AI_ROLE_POLICY[role] ?? AI_ROLE_POLICY.user;
  if (monthlyOverride === null) return base;
  return {
    ...base,
    monthlyTokens: Math.max(base.monthlyTokens ?? 0, monthlyOverride),
    summary: `${base.summary} · на этот месяц лимит расширен администратором до ${formatTokenCount(monthlyOverride)}`,
  };
}

/** Лимит на чат для конкретной роли (null или <= 0 — не ограничивать). */
export function chatTokensLeft(chat: { tokensTotal: number }, policy: AiRolePolicy): number {
  if (policy.perChatTokens === null || policy.perChatTokens <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(policy.perChatTokens - chat.tokensTotal, 0);
}

/** Предел шагов агента/оператора для роли (`null` у главного администратора, `500` у остальных). */
export function roleStepLimit(role: Role): number | null {
  return (AI_ROLE_POLICY[role] ?? AI_ROLE_POLICY.user).maxSteps;
}

export function formatStepLimit(value: number | null | undefined): string {
  if (value === null || value === undefined || value <= 0) return "без лимита";
  return `до ${new Intl.NumberFormat("ru-RU").format(value)}`;
}

/** 1250000 → «1,25 млн», 500000 → «500 тыс.», 8192 → «8 192». */
export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "без лимита";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions.toFixed(millions % 1 === 0 ? 0 : 2).replace(".", ",")} млн`;
  }
  if (abs >= 10_000) return `${Math.round(value / 1000)} тыс.`;
  return new Intl.NumberFormat("ru-RU").format(value);
}

export function reasoningAllowed(policy: AiRolePolicy, mode: ReasoningMode): boolean {
  return policy.reasoning.includes(mode);
}
