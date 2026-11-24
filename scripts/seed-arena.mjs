#!/usr/bin/env node
/**
 * Демо-данные CRM-arena для подсистемы «Агент ↔ Субагенты».
 * Заполняет: настройки оркестрации (layered + Надсмотрщик), дерево субагентов
 * (4 уровня + 1 неактивный), изолированные чаты субагентов и историю запусков
 * (completed / handoff / error / «зависший» running).
 *
 *   node scripts/seed-arena.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.resolve(root, process.env.SQLITE_PATH || "./data/crm.sqlite");
const db = new Database(dbPath);

const now = () => new Date().toISOString();
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

const admin = db.prepare("select id, email from users where role = 'super_admin' order by id limit 1").get();
if (!admin) {
  console.error("Нет super_admin. Сначала выполните: node scripts/seed.mjs --demo");
  process.exit(1);
}
const uid = admin.id;

/* ---------------------------- 1. Настройки оркестрации --------------------------- */
db.prepare("delete from ai_user_settings where user_id = ?").run(uid);
db.prepare(
  `insert into ai_user_settings (
     user_id, base_url, api_key_encrypted, api_key_hint, model,
     subagent_routing_mode, overseer_enabled, overseer_mode, overseer_system_prompt,
     overseer_unlock_api, overseer_provider, overseer_base_url, overseer_model,
     overseer_api_key_encrypted, overseer_api_key_hint,
     orchestrator_pos_x, orchestrator_pos_y, created_at, updated_at
   ) values (?, '', '', '', 'demo-model',
     'layered', 1, 'strict', ?, 0, 'custom', '', '', '', '', 120, 320, ?, ?)`,
).run(
  uid,
  "Ты — Надсмотрщик CRM. Блокируй любые действия вне Sandbox, доступ к секретам и вывод данных наружу.",
  now(),
  now(),
);

/* ------------------------------- 2. Дерево субагентов ---------------------------- */
db.prepare("delete from agent_subagent_runs where user_id = ?").run(uid);
db.prepare("delete from agent_conversation_messages where conversation_id in (select id from agent_conversations where user_id = ? and kind = 'subagent')").run(uid);
db.prepare("delete from agent_conversations where user_id = ? and kind = 'subagent'").run(uid);
db.prepare("delete from agent_subagents where user_id = ?").run(uid);

const insertSub = db.prepare(
  `insert into agent_subagents (
     user_id, slug, name, role_title, description, system_prompt, color, is_active,
     parent_subagent_id, orchestrator_can_call, allowed_callees, tool_profile,
     pos_x, pos_y, unlock_api, provider, base_url, model, api_key_encrypted, api_key_hint,
     reasoning_mode, created_at, updated_at
   ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'custom', '', '', '', '', 'default', ?, ?)`,
);

function addSub(s) {
  const info = insertSub.run(
    uid,
    s.slug,
    s.name,
    s.roleTitle,
    s.description,
    s.systemPrompt ?? "",
    s.color,
    s.isActive === false ? 0 : 1,
    s.parentId ?? null,
    s.orchCanCall === false ? 0 : 1,
    JSON.stringify(s.allowedCallees ?? ["*"]),
    s.toolProfile ?? "restricted",
    s.posX ?? null,
    s.posY ?? null,
    now(),
    now(),
  );
  return Number(info.lastInsertRowid);
}

const arch = addSub({
  slug: "arhitektor",
  name: "Архитектор",
  roleTitle: "Уровень 1 · архитектура и контракты",
  description: "Проектирует сквозную архитектуру, утверждает контракты БД/API, ревьюит решения нижних уровней.",
  systemPrompt: "Ты утверждаешь контракты данных и API. Любое изменение схемы — только через тебя.",
  color: "#8b5cf6",
  allowedCallees: ["razrabotchik-frontend", "razrabotchik-backend"],
  toolProfile: "full",
  posX: 320,
  posY: 120,
});

const fe = addSub({
  slug: "razrabotchik-frontend",
  name: "Разработчик Frontend",
  roleTitle: "Уровень 2 · Next.js / UI",
  description: "Компоненты React, вёрстка, PostCSS, доступность, клиентская логика.",
  color: "#22c55e",
  parentId: arch,
  allowedCallees: ["verstalshchik"],
  toolProfile: "full",
  posX: 120,
  posY: 300,
});

const be = addSub({
  slug: "razrabotchik-backend",
  name: "Разработчик Backend",
  roleTitle: "Уровень 2 · Node.js / API",
  description: "Express/Next route handlers, Zod-валидация, доступ к БД, интеграции.",
  color: "#3b82f6",
  parentId: arch,
  allowedCallees: ["backend-python"],
  posX: 520,
  posY: 300,
});

const py = addSub({
  slug: "backend-python",
  name: "Backend-python",
  roleTitle: "Уровень 3 · FastAPI / воркеры",
  description: "Асинхронные сервисы, обработка данных, ML/AI-интеграции, строгая типизация.",
  color: "#eab308",
  parentId: be,
  allowedCallees: ["testirovshchik"],
  posX: 620,
  posY: 470,
});

const layout = addSub({
  slug: "verstalshchik",
  name: "Верстальщик",
  roleTitle: "Уровень 3 · CSS / адаптив",
  description: "Пиксель-перфект вёрстка, адаптивность, кроссбраузерность.",
  color: "#14b8a6",
  parentId: fe,
  posX: 120,
  posY: 470,
});

addSub({
  slug: "testirovshchik",
  name: "Тестировщик",
  roleTitle: "Уровень 4 · QA / регресс",
  description: "Прогон сценариев, браузерная проверка, отчёт о дефектах.",
  color: "#f97316",
  parentId: py,
  orchCanCall: false,
  allowedCallees: [],
  toolProfile: "full",
  posX: 720,
  posY: 620,
});

addSub({
  slug: "devops",
  name: "DevOps",
  roleTitle: "Неактивен · CI/CD",
  description: "Сборка, деплой, секреты окружения. Выключен, чтобы не тратить активный слот.",
  color: "#64748b",
  isActive: false,
  posX: 900,
  posY: 300,
});

/* ------------------------- 3. Изолированные чаты + сообщения --------------------- */
const insertConv = db.prepare(
  `insert into agent_conversations (user_id, kind, subagent_id, title, system_prompt, created_at, updated_at)
   values (?, 'subagent', ?, ?, '', ?, ?)`,
);
const insertMsg = db.prepare(
  `insert into agent_conversation_messages (conversation_id, role, content, reasoning, attachments, actions, files, error, created_at)
   values (?, ?, ?, ?, '[]', ?, '[]', ?, ?)`,
);

function makeConv(subId, title, minutesAgo) {
  const info = insertConv.run(uid, subId, title, ago(minutesAgo), ago(minutesAgo));
  return Number(info.lastInsertRowid);
}

const convFe = makeConv(fe, "Разработчик Frontend: починить переполнение слайдера кейсов", 180);
insertMsg.run(
  convFe,
  "user",
  "Задание от Главного Агента — Оркестратора (проект Sandbox: `landing-site`).\n\nSummary контекста: каркас страницы готов, есть переполнение слайдера на мобильных.\n\nЧто нужно сделать: исправить overflow и проверить на 360px.",
  "",
  "[]",
  "",
  ago(180),
);
insertMsg.run(
  convFe,
  "assistant",
  "Готово. Введён единый токен отступа, слайдер больше не переполняется на 360px, прогнал проверку на 360/768/1280.",
  "Сначала посмотрел текущие стили, затем заменил фиксированную ширину на clamp().",
  JSON.stringify([{ type: "subagent_tool", tool: "sandbox_write_file", label: "landing-site/public/assets/css/styles.css", status: "ok" }]),
  "",
  ago(170),
);

const convPy = makeConv(py, "Backend-python: эндпоинт /api/leads с валидацией", 120);
insertMsg.run(
  convPy,
  "user",
  "Запрос через Оркестратора от другого субагента (проект Sandbox: `landing-site`).\n\nSummary: контракт заявки согласован с Архитектором.\n\nЗадача: реализовать приём заявок с валидацией телефона и записью в JSONL.",
  "",
  "[]",
  "",
  ago(120),
);
insertMsg.run(
  convPy,
  "assistant",
  "Эндпоинт готов: Pydantic-схема, валидация телефона по 140-ФЗ, запись в data/leads.jsonl. Прошу у Оркестратора вызов Тестировщика.",
  "",
  JSON.stringify([
    { type: "subagent_tool", tool: "sandbox_write_file", label: "landing-site/server.js", status: "ok" },
    { type: "subagent_report", status: "handoff", label: "Summary передано Оркестратору → запрос вызова «testirovshchik»" },
  ]),
  "",
  ago(110),
);

/* --------------------------------- 4. Запуски ---------------------------------- */
const insertRun = db.prepare(
  `insert into agent_subagent_runs (
     user_id, subagent_id, agent_conversation_id, subagent_conversation_id,
     caller_kind, caller_subagent_id, sandbox_project, input_summary, output_summary,
     status, requested_callee_slug, requested_callee_task, actions_count, files_touched,
     prompt_tokens, completion_tokens, total_tokens, model, used_custom_api, created_at, updated_at
   ) values (?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo-model', 0, ?, ?)`,
);

function addRun(r) {
  insertRun.run(
    uid,
    r.subagentId,
    r.convId,
    r.callerKind ?? "orchestrator",
    r.callerSubagentId ?? null,
    r.project ?? "landing-site",
    r.input ?? "",
    r.output ?? "",
    r.status,
    r.reqSlug ?? "",
    r.reqTask ?? "",
    r.actions ?? 0,
    JSON.stringify(r.files ?? []),
    r.prompt ?? 0,
    r.completion ?? 0,
    (r.prompt ?? 0) + (r.completion ?? 0),
    ago(r.minutesAgo ?? 60),
    // heartbeat: отдельное время, чтобы можно было показать «живой» и «зависший» запуски
    ago(r.updatedAgo ?? (r.minutesAgo ?? 60) - 2),
  );
}

addRun({
  subagentId: fe,
  convId: convFe,
  status: "completed",
  output: "Исправлено переполнение слайдера кейсов, проверено на 360/768/1280.",
  files: ["landing-site/public/assets/css/styles.css"],
  actions: 7,
  prompt: 12400,
  completion: 3100,
  minutesAgo: 170,
});
addRun({
  subagentId: py,
  convId: convPy,
  callerKind: "subagent",
  callerSubagentId: be,
  status: "handoff",
  output: "Эндпоинт /api/leads готов, требуется прогон Тестировщика.",
  reqSlug: "testirovshchik",
  reqTask: "Прогнать сценарии отправки заявки и проверить валидацию телефона.",
  files: ["landing-site/server.js"],
  actions: 12,
  prompt: 24800,
  completion: 6100,
  minutesAgo: 110,
});
addRun({
  subagentId: be,
  convId: makeConv(be, "Разработчик Backend: каркас API заявок", 300),
  status: "error",
  output: "Ошибка: модель вернула пустой ответ после 4 одинаковых вызовов инструментов.",
  actions: 4,
  prompt: 9800,
  completion: 0,
  minutesAgo: 300,
});
addRun({
  subagentId: arch,
  convId: makeConv(arch, "Архитектор: контракт заявки и схема БД", 400),
  status: "completed",
  output: "Утверждён контракт POST /api/leads: name, phone, comment; поля snake_case в БД.",
  files: ["landing-site/BRIEF.md"],
  actions: 3,
  prompt: 5400,
  completion: 1800,
  minutesAgo: 400,
});
// Автоперенос контекста в новый чат: статус `rotated` (раньше ошибочно писался как `handoff`,
// из-за чего счётчики «передач» врали — на одну задачу до 6 записей)
addRun({
  subagentId: py,
  convId: makeConv(py, "Backend-python: продолжение после 300 шагов", 95),
  callerKind: "subagent",
  callerSubagentId: be,
  status: "rotated",
  output:
    "Контекст перенесён в новый чат: сформировано summary по 300 шагам, работа продолжена в чистой сессии.",
  files: ["landing-site/server.js"],
  actions: 9,
  prompt: 18600,
  completion: 4200,
  minutesAgo: 95,
});
// Отменённый пользователем запуск (кнопка «Стоп» в чате субагента -> POST /runs/[id]/cancel)
addRun({
  subagentId: be,
  convId: makeConv(be, "Разработчик Backend: отмена долгого прогона", 60),
  status: "cancelled",
  output: "Запуск остановлен пользователем: прогон интеграционных тестов прерван.",
  actions: 6,
  prompt: 8800,
  completion: 1200,
  minutesAgo: 60,
});
// «Живой» запуск с актуальным heartbeat — статус running, но не старше порога реапера
addRun({
  subagentId: fe,
  convId: makeConv(fe, "Разработчик Frontend: правки лендинга (в работе)", 8),
  status: "running",
  output: "",
  actions: 3,
  prompt: 4200,
  completion: 700,
  minutesAgo: 8,
  updatedAgo: 1,
});
// «Зависший» запуск: соединение оборвалось, heartbeat не поступал 25 минут.
// При первом GET /api/agent/subagents реапер переведёт его в `error` (раньше висел вечно).
addRun({
  subagentId: addSub({
    slug: "analitik",
    name: "Аналитик",
    roleTitle: "Уровень 2 · аналитика",
    description: "Собирает метрики и готовит отчёты.",
    color: "#a855f7",
    parentId: arch,
    posX: 760,
    posY: 180,
  }),
  convId: (() => {
    const id = db.prepare("select max(id) as m from agent_subagents").get().m;
    return makeConv(Number(id), "Аналитик: отчёт по заявкам за неделю", 25);
  })(),
  status: "running",
  output: "",
  actions: 5,
  prompt: 7200,
  completion: 900,
  minutesAgo: 25,
  updatedAgo: 25,
});

/* ---------------------------------- Итог -------------------------------------- */
const stats = db
  .prepare(
    `select (select count(*) from agent_subagents where user_id = ?) as subs,
            (select count(*) from agent_subagents where user_id = ? and is_active = 1) as active,
            (select count(*) from agent_subagent_runs where user_id = ?) as runs,
            (select count(*) from agent_conversations where user_id = ? and kind = 'subagent') as convs`,
  )
  .get(uid, uid, uid, uid);

console.log(
  `[arena seed] admin=${admin.email} · субагентов: ${stats.subs} (активных ${stats.active}) · запусков: ${stats.runs} · изолированных чатов: ${stats.convs}`,
);
console.log("[arena seed] логин: admin@crm.local / Arena2026!demo");
db.close();
