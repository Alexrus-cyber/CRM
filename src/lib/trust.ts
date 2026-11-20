/**
 * Уровни доверия ИИ — общие для вкладок «Агент» и «Оператор».
 *
 *   - `full`     — «Дать полный доступ»: выполняет команды, bash и действия на ПК без вопросов.
 *   - `verified` — «Полный доступ, но с проверкой данных»: работает в Sandbox; перед bash,
 *                  командами на ПК, опасными действиями и переносом файлов из Sandbox спрашивает
 *                  подтверждение на сайте с отображением точных данных.
 *   - `none`     — «Нет доступа, к компьютеру для исполнения задач»: запрещает bash, команды на ПК
 *                  и управление экраном; только чат, RAG и виртуальные файлы на скачивание.
 */

export type TrustLevel = "full" | "verified" | "none";

export const DEFAULT_TRUST_LEVEL: TrustLevel = "verified";

export const TRUST_LEVELS: Array<{
  value: TrustLevel;
  label: string;
  shortLabel: string;
  badgeClass: string;
  hint: string;
}> = [
  {
    value: "full",
    label: "Дать полный доступ",
    shortLabel: "Полный доступ",
    badgeClass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
    hint: "Выполняет команды, bash-скрипты, действия на ПК и перенос файлов из Sandbox без подтверждений.",
  },
  {
    value: "verified",
    label: "Полный доступ, но с проверкой данных",
    shortLabel: "С проверкой данных",
    badgeClass: "border-amber-500/40 bg-amber-500/10 text-amber-500",
    hint: "Проекты создаются в Sandbox; любые bash-скрипты, команды на ПК, опасные действия и перенос файлов наружу ждут подтверждения на сайте.",
  },
  {
    value: "none",
    label: "Нет доступа, к компьютеру для исполнения задач",
    shortLabel: "Нет доступа к ПК",
    badgeClass: "border-red-500/40 bg-red-500/10 text-red-500",
    hint: "Доступ к ПК, bash и экрану отключён. Агент только отвечает, ищет в RAG и отдаёт файлы в чат.",
  },
];

export function normalizeTrustLevel(raw: unknown): TrustLevel {
  if (raw === "full" || raw === "verified" || raw === "none") return raw;
  return DEFAULT_TRUST_LEVEL;
}

export function findTrustLevel(level: TrustLevel) {
  return TRUST_LEVELS.find((item) => item.value === level) ?? TRUST_LEVELS[1];
}

export function decodeTrustLevel(raw: string): TrustLevel {
  try {
    return normalizeTrustLevel(JSON.parse(raw));
  } catch {
    return normalizeTrustLevel(raw);
  }
}
