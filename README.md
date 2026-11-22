# Nova CRM

Корпоративная CRM на Next.js 16 (App Router, React 19, TypeScript), Drizzle ORM (SQLite + PostgreSQL), с командным чатом, ИИ-ассистентом, RAG-индексом и локальным десктоп-агентом/оператором.

## Быстрый старт

```bash
cp .env.example .env
# Задайте надёжный CRM_SECRET и при необходимости CRM_ADMIN_PASSWORD
npm ci
node scripts/seed.mjs          # создаст администратора (и сгенерирует пароль, если не задан)
# node scripts/seed.mjs --demo # дополнительно создаст демонстрационную команду и задачи
npm run dev
```

Приложение доступно по адресу `http://localhost:3000`.

## Скрипты

| Команда | Назначение |
| --- | --- |
| `npm run dev` | Запуск dev-сервера Next.js |
| `npm run build` | Production-сборка |
| `npm run start` | Запуск собранного приложения |
| `npm run typecheck` | Проверка типов TypeScript (`tsc --noEmit`) |
| `npm run lint` | Проверка ESLint |
| `npm test` | Запуск Vitest (Node + UI jsdom) |
| `node scripts/seed.mjs` | Инициализация администратора (и `--demo` с тестовыми данными) |
| `node scripts/db-sync.mjs` | Синхронизация между SQLite и PostgreSQL (`status`, `pg2sqlite`, `sqlite2pg`) |

## Архитектура

- `src/db/schema.ts`, `drizzle/` — каноническая схема (32 таблицы) и версионированные SQL-миграции (`0001_baseline.sql`, `0002_audit_security_and_perf.sql`).
- `src/db/migrate.mjs` — единый идемпотентный раннер миграций для PostgreSQL и SQLite (с трансляцией DDL, индексами, FTS5/tsvector и переносом устаревших данных).
- `src/db/repos/*` — доменные репозитории (`users`, `tasks`, `chat`, `ai`, `agent`), экспортируемые через `src/db/repo.ts`.
- `src/lib/crypto.ts` — SHA-256 хэширование токенов сессий и AES-256-GCM шифрование API-ключей, GitHub-токенов и секретов ботов.
- `src/lib/storage.ts` — файловое хранилище вложений чата и скриншотов Оператора (`CRM_STORAGE_DIR`) с защитой от path traversal.
- `src/lib/permissions.ts` — централизованная матрица ролей и возможностей.
- `src/lib/rateLimit.ts` — защита логина и API лаунчера (`429 Retry-After`).
- `src/lib/validation.ts` — централизованные `zod`-схемы входных данных.
- `src/proxy.ts` — пограничная проверка cookie/Bearer-сессий перед страницами и API.
- `agent/` — локальный HTTP-агент (`agent.py`), изолированная песочница (`sandbox.py`), инспектор браузера (`browser_inspector.py`), генератор документов (`fileforge.py`) и десктопный Оператор (`desktop_operator.py`).
- `launcher/` — кроссплатформенный CLI/GUI лаунчер для входа в CRM и запуска локальных агентов.

## Запуск в Docker

```bash
cp .env.example .env
# Заполните CRM_SECRET и CRM_ADMIN_PASSWORD в .env
docker compose up --build -d
# Или вместе с PostgreSQL:
DB_DIALECT=postgres DATABASE_URL=postgres://crm:crm_dev_password@postgres:5432/crm docker compose --profile postgres up --build -d
```

## Проверки Python-агента и лаунчера

```bash
python3 -m unittest discover -s agent/tests -v
python3 agent/agent.py --self-test
python3 agent/desktop_operator.py --self-test
python3 -m launcher --self-test
```

Дополнительная документация: [DATABASES.md](./DATABASES.md), [ROLES.md](./ROLES.md), [AI_CHAT.md](./AI_CHAT.md), [CHAT.md](./CHAT.md), [PERFORMANCE.md](./PERFORMANCE.md).
