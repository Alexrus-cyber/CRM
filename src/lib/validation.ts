import { z } from "zod";
import { ALL_ROLES } from "./permissions";
import { PRIORITY_ORDER, STATUS_ORDER } from "./utils";

/**
 * Централизованные Zod-схемы и помощники валидации входных данных.
 */

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

export const loginInputSchema = z.object({
  email: z.string().trim().min(1, "Введите email и пароль").email("Некорректный email"),
  password: z.string().min(1, "Введите email и пароль"),
});

export const launcherLoginSchema = z.object({
  email: z.string({ error: "Введите email и пароль" }).trim().min(1, "Введите email и пароль"),
  password: z.string({ error: "Введите email и пароль" }).min(1, "Введите email и пароль"),
  serverUrl: z.string().optional(),
});

export const roleSchema = z.enum(ALL_ROLES as [typeof ALL_ROLES[number], ...typeof ALL_ROLES[number][]]);
export const taskStatusSchema = z.enum(STATUS_ORDER as [typeof STATUS_ORDER[number], ...typeof STATUS_ORDER[number][]]);
export const taskPrioritySchema = z.enum(PRIORITY_ORDER as [typeof PRIORITY_ORDER[number], ...typeof PRIORITY_ORDER[number][]]);

export const createUserSchema = z.object({
  name: z.string().trim().min(1, "Имя и email обязательны").max(120),
  email: z.string().trim().toLowerCase().email("Некорректный email").max(160),
  password: z.string().min(6, "Пароль минимум 6 символов").max(200),
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
  baseUrl: z.string().trim().max(400).optional(),
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
  baseUrl: z.string().max(400).optional(),
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
  baseUrl: z.string().max(400).optional(),
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
