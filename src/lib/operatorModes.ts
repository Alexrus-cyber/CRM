/**
 * Режимы работы Оператора и пошаговой помощи после каждого действия.
 */

export type OperatorTaskMode = "autonomous" | "copilot" | "game";
export type OperatorCoachMode = "off" | "after_step" | "agent";
export type OperatorTaskSource = "operator" | "agent";

export type TaskGuidanceNote = {
  id: string;
  author: "agent" | "user" | "operator";
  text: string;
  userAdvice?: string;
  createdAt: string;
};

export type TaskModeOption = {
  id: OperatorTaskMode;
  label: string;
  shortLabel: string;
  description: string;
  defaultSteps: number;
  badgeClass: string;
};

export const DEFAULT_OPERATOR_TASK_MODE: OperatorTaskMode = "autonomous";
export const DEFAULT_OPERATOR_COACH_MODE: OperatorCoachMode = "after_step";

export const OPERATOR_TASK_MODES: readonly TaskModeOption[] = [
  {
    id: "autonomous",
    label: "Обычная задача (автопилот)",
    shortLabel: "Автопилот",
    description: "Выполняет задачу шаг за шагом и отчитывается по ходу работы.",
    defaultSteps: 15,
    badgeClass: "border-accent/40 bg-accent/10 text-accent2",
  },
  {
    id: "copilot",
    label: "Помощник на ПК (рядом со мной)",
    shortLabel: "Помощник ПК",
    description:
      "Помогает выполнять действия на экране, после каждого шага объясняет что происходит и что делать дальше.",
    defaultSteps: 30,
    badgeClass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
  },
  {
    id: "game",
    label: "Игра / управление персонажем",
    shortLabel: "Игра",
    description:
      "Управляет персонажем и камерой (WASD удержание, поворот мыши, серии клавиш), быстро реагирует на сцену и подсказывает следующий ход.",
    defaultSteps: 50,
    badgeClass: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  },
] as const;

export const OPERATOR_COACH_MODES: ReadonlyArray<{
  id: OperatorCoachMode;
  label: string;
  hint: string;
}> = [
  {
    id: "after_step",
    label: "После каждого действия подсказывать что делать",
    hint: "Оператор после каждого шага разбирает экран и выводит понятную подсказку следующего действия + ждёт ваши корректировки.",
  },
  {
    id: "agent",
    label: "Ведёт Агент (помогает Оператору после каждого шага)",
    hint: "После каждого действия Агент анализирует шаг Оператора, даёт точное указание Оператору и совет пользователю.",
  },
  {
    id: "off",
    label: "Без подсказок после шагов",
    hint: "Только выполнение действий и проверка результата.",
  },
] as const;

export function normalizeTaskMode(raw: unknown): OperatorTaskMode {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "copilot" || v === "game" || v === "autonomous") return v;
  return DEFAULT_OPERATOR_TASK_MODE;
}

export function normalizeCoachMode(raw: unknown): OperatorCoachMode {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "after_step" || v === "agent") return v;
  return DEFAULT_OPERATOR_COACH_MODE;
}

export function normalizeTaskSource(raw: unknown): OperatorTaskSource {
  return String(raw ?? "").trim().toLowerCase() === "agent" ? "agent" : "operator";
}

export function findTaskMode(mode: OperatorTaskMode): TaskModeOption {
  return OPERATOR_TASK_MODES.find((item) => item.id === mode) ?? OPERATOR_TASK_MODES[0];
}
