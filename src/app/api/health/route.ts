import { createHash } from "node:crypto";
import { pingDb } from "@/db/dialect";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await pingDb();
    const probe = new URL(req.url).searchParams.get("probe")?.trim() ?? "";
    const probeAck =
      probe && /^[a-zA-Z0-9_-]{8,64}$/.test(probe)
        ? createHash("sha256").update(`nova-crm-health:${probe}`, "utf8").digest("hex")
        : undefined;
    return Response.json(
      {
        ok: true,
        app: "nova-crm",
        version: "1.0.0",
        ...(probeAck ? { probeAck } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, app: "nova-crm" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
