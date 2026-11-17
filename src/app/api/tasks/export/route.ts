import * as XLSX from "xlsx";
import { getCurrentUser } from "@/lib/auth";
import { getVisibleTasks } from "@/lib/data";
import { listExportedTaskIds, markTasksExported } from "@/db/repo";
import { addBusinessDays, dateToStr, formatDate, formatDateTime, isAdminRole } from "@/lib/utils";

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

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Требуется авторизация" }, { status: 401 });
  }
  // File export is a privileged operation: administrators only.
  if (!isAdminRole(user.role)) {
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

  // Downloads are tracked per person: a task already exported by this admin
  // is skipped unless "выгрузить все" is checked.
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

  const rows = selected.map((t) => {
    const planDays = t.hours > 0 ? Math.max(1, Math.ceil(t.hours / 8)) : 0;
    const startDay = dateToStr(new Date(t.createdAt));
    const plannedDeadline = planDays > 0 ? addBusinessDays(startDay, planDays) : startDay;
    const finished = t.completedAt ?? t.closedAt;
    const finishedDay = finished ? dateToStr(new Date(finished)) : null;
    const onTime = finishedDay ? finishedDay <= t.deadline : false;
    return {
      "Название": t.title,
      "Исполнитель": t.assigneeName,
      "Создатель": t.authorName,
      "Контрагент": t.counterpartyName ?? "",
      "ИНН": t.counterpartyInn ?? "",
      "КПП": t.counterpartyKpp ?? "",
      "Срок": formatDate(t.deadline),
      "Срок, ч": t.hours,
      "План по дням": planDays,
      "Дата выполнения": t.completedAt ? formatDateTime(t.completedAt) : "",
      "Дата закрытия": t.closedAt ? formatDateTime(t.closedAt) : "",
      "Дедлайн (план)": formatDate(plannedDeadline),
      "Выполнена в срок": onTime ? "Да" : "Нет",
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows, { header: EXPORT_HEADERS });
  ws["!cols"] = [36, 22, 22, 26, 14, 12, 12, 9, 13, 18, 18, 15, 16].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Закрытые задачи");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  // Every downloaded task is journaled for this user — next time it is skipped.
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
