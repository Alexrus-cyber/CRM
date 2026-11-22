/**
 * Серверное форматирование подтверждений действий бота-оператора.
 *
 * Бот может передавать только структурированные данные (`kind`, `action`, `extraSteps`),
 * но заголовок и описание для диалога подтверждения формируются строго на сервере,
 * чтобы скомпрометированный бот не мог подменить текст запроса на безвредный.
 */

const ALLOWED_ACTION_TYPES = new Set([
  "click",
  "double_click",
  "right_click",
  "middle_click",
  "move",
  "move_mouse_rel",
  "drag",
  "scroll",
  "type",
  "key",
  "hotkey",
  "hold_key",
  "sequence",
  "launch_app",
  "pc_command",
  "bash_command",
  "run_command",
  "sandbox_export",
  "export_from_sandbox",
  "make_file",
  "wait",
  "finish",
  "extend_steps",
  "inspect_screen",
  "call_operator",
  "step_limit",
  "github_commit",
  "github_pr",
  "github_merge",
]);

function truncateSafe(value: unknown, maxLen = 220): string {
  const str = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

export type ServerFormattedApproval =
  | {
      ok: true;
      kind: "action" | "step_limit";
      title: string;
      description: string;
      action: Record<string, unknown>;
      extraSteps: number;
    }
  | { ok: false; error: string };

export function formatServerBotApproval(raw: {
  kind?: unknown;
  action?: unknown;
  extraSteps?: unknown;
}): ServerFormattedApproval {
  const kind = raw.kind === "step_limit" ? "step_limit" : "action";
  const extraSteps = Number.isFinite(Number(raw.extraSteps))
    ? Math.max(1, Math.min(200, Math.round(Number(raw.extraSteps))))
    : 20;

  if (kind === "step_limit") {
    return {
      ok: true,
      kind: "step_limit",
      title: "Запрос дополнительных шагов",
      description: `Оператор достиг лимита шагов и запрашивает ещё +${extraSteps} шагов.`,
      action: { type: "step_limit", extraSteps },
      extraSteps,
    };
  }

  const actionObj =
    raw.action && typeof raw.action === "object" && !Array.isArray(raw.action)
      ? (raw.action as Record<string, unknown>)
      : null;

  if (!actionObj) {
    return { ok: false, error: "Не указана структура action для подтверждения" };
  }

  const actionType = String(actionObj.type ?? "").trim();
  if (!actionType || !ALLOWED_ACTION_TYPES.has(actionType)) {
    return { ok: false, error: `Недопустимый тип действия: ${truncateSafe(actionType, 40)}` };
  }

  let title = `Подтвердить действие: ${actionType}`;
  let description = `Тип действия: ${actionType}`;

  switch (actionType) {
    case "pc_command":
    case "bash_command":
    case "run_command": {
      const cmd = truncateSafe(actionObj.command ?? actionObj.cmd ?? "");
      if (!cmd) return { ok: false, error: "Пустая команда для подтверждения" };
      title = actionType === "pc_command" ? "Команда на компьютере (ПК)" : "Выполнение команды";
      description = `Команда [${actionType}]: ${cmd}`;
      break;
    }
    case "launch_app": {
      const app = truncateSafe(actionObj.app ?? actionObj.target ?? actionObj.name ?? "");
      if (!app) return { ok: false, error: "Не указано приложение для запуска" };
      title = "Запуск приложения";
      description = `Запустить: ${app}`;
      break;
    }
    case "type": {
      const text = truncateSafe(actionObj.text ?? "");
      title = "Ввод текста с клавиатуры";
      description = `Ввести текст (${text.length} симв.): ${text}`;
      break;
    }
    case "key":
    case "hold_key": {
      const key = truncateSafe(actionObj.key ?? "");
      title = "Нажатие клавиши";
      description = `Клавиша [${actionType}]: ${key}`;
      break;
    }
    case "hotkey": {
      const keys = Array.isArray(actionObj.keys)
        ? actionObj.keys.map((k) => truncateSafe(k, 24)).join("+")
        : truncateSafe(actionObj.keys ?? "");
      title = "Комбинация клавиш";
      description = `Нажать: ${keys}`;
      break;
    }
    case "click":
    case "double_click":
    case "right_click":
    case "middle_click":
    case "move":
    case "move_mouse_rel": {
      const x = Number(actionObj.x ?? actionObj.dx ?? 0);
      const y = Number(actionObj.y ?? actionObj.dy ?? 0);
      title = `Действие мышью: ${actionType}`;
      description = `Координаты: (${Number.isFinite(x) ? x : "?"}, ${Number.isFinite(y) ? y : "?"})`;
      break;
    }
    case "drag": {
      title = "Перетаскивание мышью";
      description = `Перетащить: (${truncateSafe(actionObj.x1)}, ${truncateSafe(actionObj.y1)}) → (${truncateSafe(actionObj.x2)}, ${truncateSafe(actionObj.y2)})`;
      break;
    }
    case "scroll": {
      title = "Прокрутка экрана";
      description = `Направление: ${truncateSafe(actionObj.direction ?? "down")}, величина: ${truncateSafe(actionObj.amount ?? 3)}`;
      break;
    }
    case "sequence": {
      const count = Array.isArray(actionObj.steps) ? actionObj.steps.length : 0;
      title = "Последовательность действий";
      description = `Выполнить пакет из ${count} шаг(ов)`;
      break;
    }
    case "sandbox_export":
    case "export_from_sandbox": {
      title = "Экспорт файлов из Sandbox";
      description = `Цель: ${truncateSafe(actionObj.target ?? actionObj.destination ?? actionObj.path ?? "не указана")}`;
      break;
    }
    case "make_file": {
      title = "Создание файла";
      description = `Файл: ${truncateSafe(actionObj.name ?? actionObj.path ?? "не указан")}`;
      break;
    }
    case "github_commit":
    case "github_pr":
    case "github_merge": {
      title = `Операция GitHub: ${actionType}`;
      description = truncateSafe(actionObj.summary ?? actionObj.repo ?? actionObj.branch ?? actionType);
      break;
    }
    default: {
      title = `Подтвердить: ${actionType}`;
      description = `Действие [${actionType}]`;
      break;
    }
  }

  return {
    ok: true,
    kind: "action",
    title,
    description,
    action: actionObj,
    extraSteps,
  };
}
