import { destroyTokenSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : "";
  if (token) {
    await destroyTokenSession(token);
  }
  return Response.json({ ok: true });
}
