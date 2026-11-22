import { getAiUserSettingsPublic, upsertAiUserSettings } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { aiSettingsUpdateSchema, readValidatedJson } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Персональные настройки ИИ (baseUrl, model, зашифрованный apiKey) в БД.
 * Открытый ключ никогда не возвращается в браузер — только маска `apiKeyHint`.
 */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const settings = await getAiUserSettingsPublic(me.id);
  return Response.json({ settings }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readValidatedJson(req, aiSettingsUpdateSchema);
  if (!parsed.ok) return parsed.response;

  const settings = await upsertAiUserSettings(me.id, parsed.data);
  return Response.json({ settings }, { headers: { "Cache-Control": "no-store" } });
}
