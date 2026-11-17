import { getDbInfo, pingDb } from "@/db/dialect";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await pingDb();
    const info = await getDbInfo();
    return Response.json({ ok: true, dialect: info.dialect, engine: info.label, target: info.target });
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
