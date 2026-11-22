import path from "node:path";
import { getRequestUser } from "@/lib/auth";
import { readStoredFile } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function GET(
  req: Request,
  context: { params: Promise<{ key: string[] }> },
) {
  const me = await getRequestUser(req);
  if (!me) return new Response("Unauthorized", { status: 401 });

  const { key } = await context.params;
  if (!Array.isArray(key) || key.length === 0 || key.some((seg) => !seg || seg.includes("..") || seg.includes("/"))) {
    return new Response("Not found", { status: 404 });
  }

  const storageKey = key.join("/");
  if (!storageKey.startsWith("avatars/")) {
    return new Response("Not found", { status: 404 });
  }

  const ext = path.extname(storageKey).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return new Response("Not found", { status: 404 });
  }

  const buf = await readStoredFile(storageKey);
  if (!buf) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(buf.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
