import writeXlsxFile from "write-excel-file/node";
import type { SheetData } from "write-excel-file/node";
import { getCurrentUser } from "@/lib/auth";
import { getVisibleTasks } from "@/lib/data";
import { listExportedTaskIds, markTasksExported } from "@/db/repo";
import { addBusinessDays, dateToStr, formatDate, formatDateTime, canManageData } from "@/lib/utils";

export const dynamic = "force-dynamic";

const EXPORT_HEADERS = [
  "Название",
  "Исполнитель",
  "Создатель",
  "Контрагент",
  "ИНН",
  "КПП",
  "Срок",
  "Срок, ч",
  "План по дням",
  "Дата выполнения",
  "Дата закрытия",
  "Дедлайн (план)",
  "Выполнена в срок",
];

const COL_WIDTHS = [36, 22, 22, 26, 14, 12, 12, 9, 13, 18, 18, 15, 16];

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Требуется авторизация" }, { status: 401 });
  }
  if (!canManageData(user.role)) {
    return Response.json(
      { error: "Выгрузка доступна только администраторам" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const includeAll = url.searchParams.get("all") === "1";

  const all = await getVisibleTasks(user);
  const closed = all.filter((t) => {
    if (t.status !== "closed") return false;
    if (from && t.deadline < from) return false;
    if (to && t.deadline > to) return false;
    return true;
  });

  const exportedIds = new Set(await listExportedTaskIds(user.id));
  const fresh = closed.filter((t) => !exportedIds.has(t.id));
  const selected = includeAll ? closed : fresh;

  if (selected.length === 0) {
    return Response.json(
      {
        error: closed.length === 0
          ? "Нет закрытых задач за выбранный период"
          : "Все закрытые задачи уже были выгружены вами. Отметьте «Выгрузить все», чтобы скачать их повторно.",
        exported: closed.length,
        fresh: 0,
      },
      { status: 409 },
    );
  }

  const headerRow = EXPORT_HEADERS.map((title) => ({
    value: title,
    fontWeight: "bold" as const,
  }));

  const bodyRows = selected.map((t) => {
    const planDays = t.hours > 0 ? Math.max(1, Math.ceil(t.hours / 8)) : 0;
    const startDay = dateToStr(new Date(t.createdAt));
    const plannedDeadline = planDays > 0 ? addBusinessDays(startDay, planDays) : startDay;
    const finished = t.completedAt ?? t.closedAt;
    const finishedDay = finished ? dateToStr(new Date(finished)) : null;
    const onTime = finishedDay ? finishedDay <= t.deadline : false;
    return [
      { value: t.title, type: String },
      { value: t.assigneeName, type: String },
      { value: t.authorName, type: String },
      { value: t.counterpartyName ?? "", type: String },
      { value: t.counterpartyInn ?? "", type: String },
      { value: t.counterpartyKpp ?? "", type: String },
      { value: formatDate(t.deadline), type: String },
      { value: Number(t.hours), type: Number },
      { value: planDays, type: Number },
      { value: t.completedAt ? formatDateTime(t.completedAt) : "", type: String },
      { value: t.closedAt ? formatDateTime(t.closedAt) : "", type: String },
      { value: formatDate(plannedDeadline), type: String },
      { value: onTime ? "Да" : "Нет", type: String },
    ];
  });

  const sheetData: SheetData = [headerRow, ...bodyRows];
  const generated = await writeXlsxFile(sheetData, {
    columns: COL_WIDTHS.map((width) => ({ width })),
    sheet: "Закрытые задачи",
  });
  const buf = await generated.toBuffer();

  await markTasksExported(user.id, selected.map((t) => t.id));

  const suffix = [from, to].filter(Boolean).join("_");
  const stamp = dateToStr(new Date());
  const filename = `closed-tasks_${suffix ? suffix + "_" : ""}${stamp}.xlsx`;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Exported-Count": String(selected.length),
      "X-Skipped-Count": String(closed.length - fresh.length),
      "X-Export-Mode": includeAll ? "all" : "new",
      "Cache-Control": "no-store",
    },
  });
}
