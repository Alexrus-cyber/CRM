#!/usr/bin/env node
/**
 * Инициализация и заполнение базы CRM (PostgreSQL и SQLite).
 *
 *   node scripts/seed.mjs                 # движок из .env / автовыбор (создаёт только супер-админа)
 *   node scripts/seed.mjs --demo          # или SEED_DEMO=1 — дополнительно заполняет демо-команду и задачи
 *   node scripts/seed.mjs --sqlite        # принудительно SQLite (./data/crm.sqlite)
 *   node scripts/seed.mjs --postgres      # принудительно PostgreSQL (DATABASE_URL)
 *
 * Пароли берутся из переменных окружения (`CRM_SEED_ADMIN_PASSWORD`, `CRM_SEED_DEMO_PASSWORD`)
 * либо генерируются случайно при первом запуске и один раз выводятся в консоль.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync } from "node:crypto";
import pg from "pg";
import Database from "better-sqlite3";
import { runMigrations, wrapPgPool, wrapSqliteDb } from "../src/db/migrate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (fs.existsSync(path.join(root, ".env"))) {
  for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const args = new Set(process.argv.slice(2));
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(root, "data", "crm.sqlite");
const requested = args.has("--sqlite")
  ? "sqlite"
  : args.has("--postgres")
    ? "postgres"
    : process.env.DB_DIALECT || "auto";
const seedDemo = args.has("--demo") || process.env.SEED_DEMO === "1" || process.env.SEED_DEMO === "true";

const hash = (password) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
};

const generatePassword = () => randomBytes(12).toString("base64url") + "A1!";

const isoOffset = (days, hour = 15) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  if (hour !== null) d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const day = (offset) => isoOffset(offset).slice(0, 10);

function makeAdapter(dialect, pool, sqlite) {
  if (dialect === "postgres") {
    return async (text, params = []) => {
      let i = 0;
      const pgText = text.replace(/\?/g, () => `$${++i}`);
      const res = await pool.query(pgText, params);
      return res.rows;
    };
  }
  return async (text, params = []) => {
    const stmt = sqlite.prepare(text);
    const values = params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === "boolean") return p ? 1 : 0;
      return p;
    });
    if (!stmt.reader) {
      stmt.run(...values);
      return [];
    }
    return stmt.all(...values);
  };
}

async function openEngineFallbackSqlite() {
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  const sqlite = new Database(SQLITE_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  await runMigrations(wrapSqliteDb(sqlite));
  return {
    dialect: "sqlite",
    label: `SQLite (${SQLITE_PATH})`,
    query: makeAdapter("sqlite", null, sqlite),
    close: async () => sqlite.close(),
  };
}

async function openEngine() {
  if (requested === "sqlite") {
    return openEngineFallbackSqlite();
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4000 });
  try {
    await pool.query("select 1");
    await runMigrations(wrapPgPool(pool));
    return {
      dialect: "postgres",
      label: "PostgreSQL",
      query: makeAdapter("postgres", pool, null),
      close: async () => pool.end(),
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    if (requested === "postgres") throw error;
    console.warn(`PostgreSQL unavailable (${error.message}) — seeding SQLite instead`);
    return openEngineFallbackSqlite();
  }
}

const engine = await openEngine();
const { query, label } = engine;

try {
  const countRows = await query("select count(*) as c from users where is_bot = false");
  if (Number(countRows[0].c) > (seedDemo ? 1 : 0)) {
    console.log(`[${label}] database already has users, skipping seed.`);
    await engine.close();
    process.exit(0);
  }

  const adminEmail = (
    process.env.CRM_ADMIN_EMAIL ||
    process.env.CRM_SEED_ADMIN_EMAIL ||
    "admin@crm.local"
  ).trim().toLowerCase();
  const envAdminPass = (process.env.CRM_ADMIN_PASSWORD || process.env.CRM_SEED_ADMIN_PASSWORD || "").trim();
  const adminPassword = envAdminPass || generatePassword();
  const mustChangePassword = !envAdminPass;

  await query(
    `insert into users (email, password_hash, name, position, role, avatar_color, phone, bio, is_bot, can_use_agent, can_use_operator, must_change_password, created_at, updated_at)
     values (?, ?, ?, ?, 'super_admin', '#7c5cff', '+7 (900) 100-00-01', ?, false, true, true, ?, ?, ?)
     on conflict (email) do update set role = 'super_admin', can_use_agent = true, can_use_operator = true`,
    [
      adminEmail,
      hash(adminPassword),
      process.env.CRM_ADMIN_NAME || process.env.CRM_SEED_ADMIN_NAME || "Главный администратор",
      "Руководитель",
      "Отвечаю за развитие продукта и команду.",
      mustChangePassword,
      isoOffset(-30),
      isoOffset(-30),
    ],
  );

  if (!envAdminPass) {
    if (process.stdout.isTTY) {
      console.log(`[${label}] создан super_admin: ${adminEmail} / временный пароль: ${adminPassword} (потребуется смена при первом входе)`);
    } else {
      const credFile = path.join(root, "data", ".seed-credentials.txt");
      fs.mkdirSync(path.dirname(credFile), { recursive: true });
      fs.writeFileSync(
        credFile,
        `email=${adminEmail}\ntemporary_password=${adminPassword}\n`,
        { mode: 0o600 },
      );
      console.log(`[${label}] создан super_admin: ${adminEmail}. Временный пароль сохранён в ${credFile} (mode 0600); потребуется смена при первом входе.`);
    }
  } else {
    console.log(`[${label}] создан super_admin: ${adminEmail} (пароль из переменной окружения)`);
  }

  if (!seedDemo) {
    console.log(`[${label}] базовый seed завершён (для демо-данных передайте --demo или SEED_DEMO=1).`);
    await engine.close();
    process.exit(0);
  }

  const envDemoPass = (process.env.CRM_SEED_DEMO_PASSWORD || "").trim();
  const demoPassword = envDemoPass || generatePassword();

  const people = [
    ["maria@crm.local", "Мария Соколова", "Руководитель проектов", "manager", "#ec4899", "+7 (900) 100-00-02"],
    ["ivan@crm.local", "Иван Петров", "Frontend-разработчик", "developer", "#3b82f6", "+7 (900) 100-00-03"],
    ["anna@crm.local", "Анна Кузнецова", "Backend-разработчик", "developer", "#10b981", "+7 (900) 100-00-04"],
    ["dmitry@crm.local", "Дмитрий Волков", "QA-инженер", "consultant", "#f59e0b", "+7 (900) 100-00-05"],
    ["olga@crm.local", "Ольга Смирнова", "Менеджер по продажам", "manager", "#06b6d4", "+7 (900) 100-00-06"],
  ];
  for (const [email, name, position, role, color, phone] of people) {
    await query(
      `insert into users (email, password_hash, name, position, role, avatar_color, phone, is_bot, can_use_agent, can_use_operator, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, false, false, false, ?, ?) on conflict (email) do nothing`,
      [email, hash(demoPassword), name, position, role, color, phone, isoOffset(-25), isoOffset(-25)],
    );
  }
  const users = await query("select id, email from users where is_bot = false");
  const U = Object.fromEntries(users.map((u) => [u.email.split("@")[0], Number(u.id)]));
  const adminKey = adminEmail.split("@")[0];
  U.admin = U[adminKey] ?? Number(users[0]?.id);

  const cps = [
    ["ООО «Ромашка»", "+7 (495) 111-22-33", "info@romashka.ru", "г. Москва, ул. Тверская, д. 10", "7701234567", "770101001", "Ключевой клиент. Контакт — Сергей, коммерческий директор."],
    ["АО «ТехноСтрой»", "+7 (812) 555-44-33", "office@technostroy.ru", "г. Санкт-Петербург, Невский пр., д. 25", "7812345678", "781201001", "Работаем по постоплате 30 дней."],
    ["ИП Иванов А.А.", "+7 (903) 777-88-99", "ivanov@mail.ru", "г. Казань, ул. Баумана, д. 5", "165812345678", null, "Небольшие заказы, быстрые согласования."],
    ["ООО «Альфа Логистик»", "+7 (343) 222-33-44", "sales@alfa-log.ru", "г. Екатеринбург, ул. Малышева, д. 51", "6671234567", "667101001", "Интеграция с их 1С."],
    ["ООО «Медиа Групп»", "+7 (495) 999-00-11", "hello@mediagroup.ru", "г. Москва, Пресненская наб., д. 12", "7709876543", "770901001", null],
    ["ООО «Зелёный сад»", "+7 (861) 333-22-11", "contact@greengarden.ru", "г. Краснодар, ул. Красная, д. 100", "2309876543", "230901001", "Сезонный спрос — весна/лето."],
  ];
  const cpIds = [];
  for (const [name, phone, email, address, inn, kpp, notes] of cps) {
    const rows = await query(
      `insert into counterparties (name, phone, email, address, inn, kpp, notes, created_by_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [name, phone, email, address, inn, kpp, notes, U.admin, isoOffset(-20), isoOffset(-20)],
    );
    cpIds.push(Number(rows[0].id));
  }

  const TIME_SLOTS = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
  const T = [
    ["Подготовить коммерческое предложение", "olga", "admin", 0, -6, 4, "closed", "high", -14, -8, -7],
    ["Настроить CI/CD для проекта", "anna", "maria", 1, -10, 8, "closed", "medium", -20, -11, -10],
    ["Сверстать лендинг акции", "ivan", "maria", 4, -4, 12, "done", "high", -12, -5, null],
    ["Регрессионное тестирование релиза 2.3", "dmitry", "maria", 1, -2, 16, "in_progress", "critical", -9, null, null],
    ["Интеграция с 1С: выгрузка заказов", "anna", "admin", 3, -1, 24, "in_progress", "high", -15, null, null],
    ["Починить баг с оплатой в мобильной версии", "ivan", "dmitry", 0, -3, 3, "new", "critical", -4, null, null],
    ["Обновить документацию API", "anna", "admin", null, 2, 6, "review", "low", -6, null, null],
    ["Провести демо для клиента", "olga", "admin", 1, 1, 2, "new", "high", -2, null, null],
    ["Миграция базы данных на новую версию", "anna", "maria", null, 5, 10, "new", "medium", -1, null, null],
    ["Дизайн-ревью личного кабинета", "ivan", "maria", 4, 3, 4, "in_progress", "medium", -3, null, null],
    ["Написать автотесты для корзины", "dmitry", "admin", 0, 7, 12, "new", "medium", 0, null, null],
    ["Созвон по требованиям к отчётам", "olga", "maria", 3, 0, 1, "new", "medium", -1, null, null],
    ["Подготовить акт выполненных работ", "olga", "admin", 2, -12, 2, "closed", "low", -18, -13, -12],
    ["Оптимизация скорости загрузки каталога", "ivan", "admin", 5, -8, 10, "closed", "high", -16, -7, -6],
    ["Нагрузочное тестирование API", "dmitry", "anna", 1, -9, 8, "closed", "medium", -14, -9, -9],
    ["Настроить мониторинг и алерты", "anna", "admin", null, -5, 6, "done", "medium", -10, -6, null],
    ["Перенести тикеты в новую систему", "dmitry", "maria", null, 10, 5, "new", "low", 0, null, null],
    ["Презентация квартальных результатов", "admin", "maria", null, 4, 3, "new", "high", -1, null, null],
    ["Согласовать договор с юристами", "olga", "admin", 3, 6, 2, "in_progress", "medium", -2, null, null],
    ["Рефакторинг модуля уведомлений", "ivan", "anna", null, 12, 16, "new", "low", 0, null, null],
    ["Исправить ошибки в отчётах по продажам", "anna", "olga", 0, -1, 4, "review", "high", -5, null, null],
    ["Онбординг нового сотрудника", "maria", "admin", null, 2, 3, "in_progress", "medium", -3, null, null],
    ["Аудит безопасности", "dmitry", "admin", null, 14, 20, "new", "critical", 0, null, null],
    ["Подготовить SEO-план на квартал", "ivan", "olga", 4, -15, 6, "cancelled", "low", -20, null, null],
    ["Внедрить систему достижений в CRM", "ivan", "admin", null, -7, 14, "closed", "medium", -21, -8, -7],
    ["Настроить резервное копирование", "anna", "maria", null, -20, 4, "closed", "high", -25, -19, -18],
    ["Тестирование интеграции с 1С", "dmitry", "anna", 3, 3, 8, "new", "high", -1, null, null],
    ["Обзвон тёплых лидов", "olga", "maria", 5, 1, 4, "in_progress", "medium", -2, null, null],
  ];
  for (const [index, [title, a, au, cp, dl, hours, status, prio, created, completed, closed]] of T.entries()) {
    const time = TIME_SLOTS[index % TIME_SLOTS.length];
    const accepted = status === "new" ? null : isoOffset(created, 12);
    await query(
      `insert into tasks (title, description, assignee_id, author_id, counterparty_id, deadline, deadline_time, hours, status, priority,
                          created_at, updated_at, completed_at, closed_at, accepted_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        "Демо-задача для проверки работы CRM.",
        U[a],
        U[au],
        cp === null ? null : cpIds[cp],
        day(dl),
        time,
        hours,
        status,
        prio,
        isoOffset(created),
        isoOffset(created),
        completed === null ? null : isoOffset(completed, 17),
        closed === null ? null : isoOffset(closed, 18),
        accepted,
      ],
    );
  }

  const msgs = [
    ["admin", "Всем привет! Добро пожаловать в Nova CRM 🎉"],
    ["maria", "Коллеги, напоминаю про релиз 2.3 в пятницу. Дмитрий, как регресс?"],
    ["dmitry", "Прошёл на 70%, пара критичных багов в оплате, Иван уже в курсе."],
    ["ivan", "Да, беру в работу сегодня. К вечеру будет фикс."],
    ["anna", "Интеграция с 1С почти готова, осталась выгрузка заказов."],
    ["olga", "Ромашка подтвердила встречу на завтра, готовлю демо 🙌"],
  ];
  const minutesAgoIso = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  let minutesAgo = 120;
  for (const [who, content] of msgs) {
    await query("insert into messages (sender_id, content, content_lower, created_at) values (?, ?, ?, ?)", [
      U[who],
      content,
      content.toLowerCase(),
      minutesAgoIso(minutesAgo),
    ]);
    minutesAgo -= 15;
  }
  const mariaText = "Привет! Посмотри, пожалуйста, нагрузку по команде на дашборде — Анна перегружена.";
  await query("insert into messages (sender_id, recipient_id, content, content_lower, created_at) values (?, ?, ?, ?, ?)", [
    U.maria,
    U.admin,
    mariaText,
    mariaText.toLowerCase(),
    minutesAgoIso(5),
  ]);

  if (!envDemoPass) {
    if (process.stdout.isTTY) {
      console.log(`[${label}] временный пароль демо-сотрудников: ${demoPassword}`);
    } else {
      const demoCredFile = path.join(root, "data", ".seed-demo-credentials.txt");
      fs.mkdirSync(path.dirname(demoCredFile), { recursive: true });
      fs.writeFileSync(demoCredFile, `demo_password=${demoPassword}\n`, { mode: 0o600 });
      console.log(`[${label}] временный пароль демо-сотрудников сохранён в ${demoCredFile} (mode 0600).`);
    }
  }
  console.log(`[${label}] demo seed complete: ${users.length} users, ${cpIds.length} counterparties, ${T.length} tasks`);
} finally {
  await engine.close();
}
