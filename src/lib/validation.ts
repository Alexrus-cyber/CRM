import { z } from "zod";
import { ALL_ROLES } from "./permissions";
import { PRIORITY_ORDER, STATUS_ORDER } from "./utils";
import { isBlockedCloudOrSpecialIp } from "./ssrf";

/**
 * Централизованные Zod-схемы и помощники валидации входных данных.
 */

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

const WEAK_PASSWORDS = new Set([
  "1234567890",
  "12345678901",
  "0987654321",
  "password123",
  "password1234",
  "qwerty1234",
  "qwerty12345",
  "admin12345",
  "admin123456",
  "crm1234567",
  "letmein1234",
  "welcome123",
]);

export function validateStrongPassword(password: string): { ok: true } | { ok: false; error: string } {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Пароль не должен превышать ${MAX_PASSWORD_LENGTH} символов` };
  }
  const lower = password.trim().toLowerCase();
  if (WEAK_PASSWORDS.has(lower) || /^(.)\1+$/.test(lower)) {
    return { ok: false, error: "Пароль слишком простой — выберите более надёжную комбинацию" };
  }
  const hasLetter = /[A-Za-zА-Яа-яЁё]/.test(password);
  const hasDigitOrSymbol = /[\d\W_]/.test(password);
  if (!hasLetter || !hasDigitOrSymbol) {
    return { ok: false, error: "Пароль должен содержать буквы и хотя бы одну цифру или спецсимвол" };
  }
  return { ok: true };
}

export const strongPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Пароль минимум ${MIN_PASSWORD_LENGTH} символов`)
  .max(MAX_PASSWORD_LENGTH, `Пароль максимум ${MAX_PASSWORD_LENGTH} символов`)
  .superRefine((val, ctx) => {
    const check = validateStrongPassword(val);
    if (!check.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: check.error });
    }
  });

export function isSafeHttpUrlSyntax(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "metadata.google.internal" || host === "metadata.goog" || host === "169.254.169.254") {
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isBlockedCloudOrSpecialIp(host)) {
    return false;
  }
  return true;
}

export const safeBaseUrlSchema = z
  .string()
  .trim()
  .max(400)
  .refine(isSafeHttpUrlSyntax, "Некорректный или запрещённый URL модели");

export const AGENT_TASK_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_steps",
  "done",
  "failed",
  "cancelled",
] as const;

export const agentTaskStatusSchema = z.enum(AGENT_TASK_STATUSES);

export function parseJsonBody<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  fallbackMessage = "Некорректные данные запроса",
): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const first = result.error.issues[0];
  const msg = first?.message?.trim() || fallbackMessage;
  return { ok: false, error: msg };
}

export async function readValidatedJson<T>(
  req: Request,
  schema: z.ZodType<T>,
  fallbackMessage = "Некорректные данные запроса",
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const raw = await req.json().catch(() => null);
  const parsed = parseJsonBody(raw, schema, fallbackMessage);
  if (!parsed.ok) {
    return { ok: false, response: Response.json({ error: parsed.error }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Потоковое чтение JSON-тела со строгим лимитом байт ДО вызова `JSON.parse`.
 * Защищает Node.js от OOM при огромном теле запроса (P0-7).
 */
export async function readJsonWithByteLimit<T = unknown>(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const contentLen = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLen) && contentLen > maxBytes) {
    return {
      ok: false,
      response: Response.json({ error: "Размер запроса превышает допустимый лимит" }, { status: 413 }),
    };
  }
  if (!req.body) {
    return { ok: false, response: Response.json({ error: "Пустой запрос" }, { status: 400 }) };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          response: Response.json({ error: "Размер запроса превышает допустимый лимит" }, { status: 413 }),
        };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: Response.json({ error: "Ошибка чтения тела запроса" }, { status: 400 }) };
  }

  try {
    const text = Buffer.concat(chunks, total).toString("utf8");
    const parsed = JSON.parse(text) as T;
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, response: Response.json({ error: "Некорректный JSON" }, { status: 400 }) };
  }
}

export const loginInputSchema = z.object({
  email: z.string().trim().min(1, "Введите email и пароль").email("Некорректный email"),
  password: z.string().min(1, "Введите email и пароль").max(MAX_PASSWORD_LENGTH),
  totpCode: z.string().trim().max(12).optional(),
});

export const launcherLoginSchema = z.object({
  email: z.string({ error: "Введите email и пароль" }).trim().min(1, "Введите email и пароль"),
  password: z.string({ error: "Введите email и пароль" }).min(1, "Введите email и пароль").max(MAX_PASSWORD_LENGTH),
  totpCode: z.string().trim().max(12).optional(),
  serverUrl: z.string().optional(),
});

export const roleSchema = z.enum(ALL_ROLES as [typeof ALL_ROLES[number], ...typeof ALL_ROLES[number][]]);
export const taskStatusSchema = z.enum(STATUS_ORDER as [typeof STATUS_ORDER[number], ...typeof STATUS_ORDER[number][]]);
export const taskPrioritySchema = z.enum(PRIORITY_ORDER as [typeof PRIORITY_ORDER[number], ...typeof PRIORITY_ORDER[number][]]);

export const createUserSchema = z.object({
  name: z.string().trim().min(1, "Имя и email обязательны").max(120),
  email: z.string().trim().toLowerCase().email("Некорректный email").max(160),
  password: strongPasswordSchema,
  role: roleSchema.default("user"),
  position: z.string().optional(),
  phone: z.string().optional(),
});

export const taskInputSchema = z.object({
  id: z.number().int().positive().optional(),
  title: z.string().trim().min(1, "Название задачи обязательно").max(300),
  description: z.string().optional(),
  assigneeId: z.number().int().positive("Выберите исполнителя"),
  counterpartyId: z.number().int().positive().nullable().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Укажите срок"),
  deadlineTime: z.string().nullable().optional(),
  hours: z.number().finite().min(0).default(0),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
});

export const counterpartyInputSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, "Название / Имя обязательно").max(240),
  phone: z.string().max(80).optional(),
  email: z.string().max(160).optional(),
  address: z.string().max(400).optional(),
  inn: z.string().max(20).optional(),
  kpp: z.string().max(20).optional(),
  notes: z.string().max(4000).optional(),
});

export const aiSettingsUpdateSchema = z.object({
  baseUrl: safeBaseUrlSchema.optional(),
  apiKey: z.string().max(400).optional(),
  clearApiKey: z.boolean().optional(),
  model: z.string().trim().max(200).optional(),
});

export const chatBotCreateSchema = z.object({
  name: z.string({ error: "Укажите имя бота" }).trim().min(1, "Укажите имя бота").max(80),
  position: z.string().max(80).optional(),
  bio: z.string().max(500).optional(),
  avatarColor: z.string().optional(),
  provider: z.string().max(40).optional(),
  baseUrl: safeBaseUrlSchema.optional(),
  apiKey: z.string().max(400).optional(),
  model: z.string().max(160).optional(),
  systemPrompt: z.string().max(4000).optional(),
  params: z.unknown().optional(),
  replyMode: z.enum(["mention", "always"]).optional(),
  isActive: z.boolean().optional(),
});

export const chatBotPatchSchema = z.object({
  name: z.string().trim().min(1, "Укажите имя бота").max(80).optional(),
  position: z.string().max(80).nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
  avatarColor: z.string().optional(),
  provider: z.string().max(40).optional(),
  baseUrl: safeBaseUrlSchema.optional(),
  apiKey: z.string().max(400).optional(),
  clearApiKey: z.boolean().optional(),
  model: z.string().max(160).optional(),
  systemPrompt: z.string().max(4000).optional(),
  params: z.unknown().optional(),
  replyMode: z.enum(["mention", "always"]).optional(),
  isActive: z.boolean().optional(),
});

export const chatRoomCreateSchema = z.object({
  name: z.string({ error: "Укажите название чата" }).trim().min(1, "Укажите название чата").max(100),
  description: z.string().max(300).optional(),
  kind: z.enum(["group", "shared"]).optional(),
  memberIds: z.array(z.number().int().positive()).optional(),
  botIds: z.array(z.number().int().positive()).optional(),
});
