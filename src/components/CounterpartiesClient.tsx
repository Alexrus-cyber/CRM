"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown, Building2, CheckCircle2, Download, Eye, FileSpreadsheet, Loader2, Mail,
  MapPin, Pencil, Phone, Plus, Search, ShieldAlert, Trash2, Upload,
} from "lucide-react";
import type { CounterpartyRow } from "@/lib/data";
import {
  deleteCounterpartyAction,
  importCounterpartiesAction,
  saveCounterpartyAction,
} from "@/app/actions/counterparties";
import {
  IMPORT_COLUMNS,
  IMPORT_ROW_LIMIT,
  IMPORT_TEMPLATE_ROWS,
  parseCounterpartyMatrix,
  type ParsedCounterpartyRow,
} from "@/lib/counterpartyImport";
import { cn, formatDateTime } from "@/lib/utils";
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Textarea } from "./ui";
import { LoadMore, useProgressiveList } from "./lazy";

type SortKey = "name" | "inn" | "email" | "phone" | "tasksCount" | "createdAt";

const empty = { name: "", phone: "", email: "", address: "", inn: "", kpp: "", notes: "" };

export function CounterpartiesClient({ items, isAdmin }: { items: CounterpartyRow[]; isAdmin: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [withTasks, setWithTasks] = useState("all");
  const [modal, setModal] = useState<{ open: boolean; id?: number; readonly?: boolean }>({ open: false });
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items.filter((c) => {
      if (withTasks === "with" && c.tasksCount === 0) return false;
      if (withTasks === "without" && c.tasksCount > 0) return false;
      if (!q) return true;
      return [c.name, c.phone, c.email, c.address, c.inn, c.kpp, c.notes]
        .some((v) => (v ?? "").toLowerCase().includes(q));
    });
    const d = sort.dir;
    return [...list].sort((a, b) => {
      switch (sort.key) {
        case "name": return a.name.localeCompare(b.name, "ru") * d;
        case "inn": return (a.inn ?? "").localeCompare(b.inn ?? "") * d;
        case "email": return (a.email ?? "").localeCompare(b.email ?? "") * d;
        case "phone": return (a.phone ?? "").localeCompare(b.phone ?? "") * d;
        case "tasksCount": return (a.tasksCount - b.tasksCount) * d;
        case "createdAt": return a.createdAt.localeCompare(b.createdAt) * d;
      }
    });
  }, [items, search, sort, withTasks]);

  // Таблица и карточки рисуются порциями: база может быть большой,
  // а на слабых ПК лишние строки в первом кадре заметно тормозят страницу.
  const list = useProgressiveList(filtered, {
    initial: 30,
    step: 30,
    // Сбрасываем порцию только при смене фильтров, а не при обновлении данных.
    resetKey: `${search}|${withTasks}|${sort.key}|${sort.dir}`,
  });

  const openCreate = () => { setForm(empty); setError(null); setModal({ open: true }); };
  const openEdit = (c: CounterpartyRow, readonly = false) => {
    setForm({ name: c.name, phone: c.phone ?? "", email: c.email ?? "", address: c.address ?? "", inn: c.inn ?? "", kpp: c.kpp ?? "", notes: c.notes ?? "" });
    setError(null);
    setModal({ open: true, id: c.id, readonly });
  };
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const submit = () => {
    setError(null);
    start(async () => {
      const res = await saveCounterpartyAction({ id: modal.id, ...form });
      if (!res.ok) return setError(res.error);
      router.refresh();
      setModal({ open: false });
    });
  };
  const remove = (id: number) => {
    if (!confirm("Удалить контрагента? Связанные задачи останутся без контрагента.")) return;
    start(async () => {
      const res = await deleteCounterpartyAction(id);
      if (!res.ok) return alert(res.error);
      router.refresh();
      setModal({ open: false });
    });
  };

  const Th = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={cn("px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted", className)}>
      <button onClick={() => toggleSort(k)} className={cn("inline-flex items-center gap-1 hover:text-text", sort.key === k && "text-accent2")}>
        {children} <ArrowUpDown size={12} />
      </button>
    </th>
  );

  const readonly = !!modal.readonly || !isAdmin;
  const current = modal.id ? items.find((c) => c.id === modal.id) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск: название, ИНН, телефон, email, адрес, заметки..." className="pl-9" />
        </div>
        <Select value={withTasks} onChange={(e) => setWithTasks(e.target.value)} className="w-44">
          <option value="all">Все контрагенты</option>
          <option value="with">С задачами</option>
          <option value="without">Без задач</option>
        </Select>
        {isAdmin && (
          <>
            <ImportPanel onImported={() => router.refresh()} />
            <Button onClick={openCreate}><Plus size={16} /> Новый контрагент</Button>
          </>
        )}
      </div>

      <p className="text-xs text-muted">Найдено: <b className="text-text">{filtered.length}</b> из {items.length}{!isAdmin && " · Редактирование доступно только администраторам"}</p>

      {filtered.length === 0 ? (
        <EmptyState title="Контрагенты не найдены" hint={isAdmin ? "Добавьте первого контрагента" : "Попросите администратора добавить контрагента"} />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-2xl border border-border bg-card md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-card2/60">
                  <tr>
                    <Th k="name">Название / Имя</Th>
                    <Th k="phone">Телефон</Th>
                    <Th k="email">Email</Th>
                    <Th k="inn">ИНН / КПП</Th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Адрес</th>
                    <Th k="tasksCount" className="text-right">Задач</Th>
                    <Th k="createdAt">Создан</Th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((c) => (
                    <tr key={c.id} onClick={() => openEdit(c, !isAdmin)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-card2/70">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent2"><Building2 size={15} /></span>
                          <div>
                            <p className="font-medium leading-tight">{c.name}</p>
                            {c.notes && <p className="max-w-[260px] truncate text-[11px] text-muted">{c.notes}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted">{c.phone ?? "—"}</td>
                      <td className="px-3 py-2.5 text-muted">{c.email ?? "—"}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-muted">{c.inn ?? "—"}{c.kpp ? ` / ${c.kpp}` : ""}</td>
                      <td className="max-w-[220px] truncate px-3 py-2.5 text-muted">{c.address ?? "—"}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{c.tasksCount}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-xs text-muted">{formatDateTime(c.createdAt)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          {isAdmin ? (
                            <>
                              <button onClick={() => openEdit(c)} className="rounded-lg p-1.5 text-muted hover:bg-card2 hover:text-text" title="Редактировать"><Pencil size={14} /></button>
                              <button onClick={() => remove(c.id)} className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-500" title="Удалить"><Trash2 size={14} /></button>
                            </>
                          ) : (
                            <button onClick={() => openEdit(c, true)} className="rounded-lg p-1.5 text-muted hover:bg-card2 hover:text-text" title="Просмотр"><Eye size={14} /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-2 md:hidden">
            {list.items.map((c) => (
              <button key={c.id} onClick={() => openEdit(c, !isAdmin)} className="card-hover rounded-2xl border border-border bg-card p-3 text-left">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{c.name}</p>
                  <span className="text-xs text-muted">{c.tasksCount} задач</span>
                </div>
                <div className="mt-2 space-y-1 text-xs text-muted">
                  {c.phone && <p className="flex items-center gap-1.5"><Phone size={12} /> {c.phone}</p>}
                  {c.email && <p className="flex items-center gap-1.5"><Mail size={12} /> {c.email}</p>}
                  {c.address && <p className="flex items-center gap-1.5"><MapPin size={12} /> {c.address}</p>}
                  {(c.inn || c.kpp) && <p className="font-mono">ИНН {c.inn ?? "—"} {c.kpp && `· КПП ${c.kpp}`}</p>}
                </div>
              </button>
            ))}
          </div>

          <LoadMore
            shown={list.shown}
            total={list.total}
            hasMore={list.hasMore}
            loading={list.loading}
            onShowMore={list.showMore}
            sentinelRef={list.sentinelRef}
            initial={30}
            unit="контрагентов"
          />
        </>
      )}

      <Modal
        open={modal.open}
        onClose={() => setModal({ open: false })}
        title={modal.id ? (readonly ? "Контрагент" : "Редактировать контрагента") : "Новый контрагент"}
        footer={
          <>
            {isAdmin && modal.id && (
              <Button variant="danger" size="sm" className="mr-auto" onClick={() => remove(modal.id!)} disabled={pending}><Trash2 size={14} /> Удалить</Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setModal({ open: false })}>Закрыть</Button>
            {!readonly && <Button size="sm" onClick={submit} disabled={pending}>{pending ? "Сохраняем..." : "Сохранить"}</Button>}
          </>
        }
      >
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field label="Название / Имя *" className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={readonly} placeholder="ООО «Ромашка» или Иван Иванов" autoFocus />
          </Field>
          <Field label="Телефон">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} disabled={readonly} placeholder="+7 (999) 000-00-00" />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={readonly} placeholder="info@company.ru" />
          </Field>
          <Field label="Адрес" className="sm:col-span-2">
            <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} disabled={readonly} placeholder="г. Москва, ул. Примерная, д. 1" />
          </Field>
          <Field label="ИНН">
            <Input value={form.inn} onChange={(e) => setForm({ ...form, inn: e.target.value.replace(/\D/g, "") })} disabled={readonly} placeholder="10 или 12 цифр" maxLength={12} />
          </Field>
          <Field label="КПП">
            <Input value={form.kpp} onChange={(e) => setForm({ ...form, kpp: e.target.value.replace(/\D/g, "") })} disabled={readonly} placeholder="9 цифр" maxLength={9} />
          </Field>
          <Field label="Заметки" className="sm:col-span-2">
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} disabled={readonly} placeholder="Контактное лицо, условия работы, особенности..." />
          </Field>
        </div>
        {current && (
          <p className="mt-3 text-xs text-muted">Создан: {formatDateTime(current.createdAt)}{current.createdByName ? ` · ${current.createdByName}` : ""} · Задач: {current.tasksCount}</p>
        )}
        {error && <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Загрузка контрагентов из Excel — только для администраторов        */
/* ------------------------------------------------------------------ */

const PREVIEW_LIMIT = 100;
const FILE_LIMIT_MB = 10;
/** Порция строк за один вызов server action (ограничение размера запроса). */
const UPLOAD_CHUNK = 500;

function ImportPanel({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedCounterpartyRow[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ msg: string; warnings: string[] } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reset = () => {
    setFileName(null);
    setRows([]);
    setMissing([]);
    setError(null);
    setNotice(null);
  };

  const readFile = async (file: File) => {
    setError(null);
    setNotice(null);
    setRows([]);
    setMissing([]);
    setFileName(file.name);

    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      setError("Поддерживаются файлы Excel: .xlsx, .xls и .csv");
      return;
    }
    if (file.size > FILE_LIMIT_MB * 1024 * 1024) {
      setError(`Файл больше ${FILE_LIMIT_MB} МБ — разделите его на части`);
      return;
    }

    setReading(true);
    try {
      // Библиотека xlsx читает и .xlsx, и старый .xls, и .csv — грузим её только по требованию.
      const XLSX = await import("xlsx");
      const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
      const sheetName = wb.SheetNames[0];
      const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
      if (!sheet) {
        setError("В файле нет листов с данными");
        return;
      }

      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        blankrows: false,
        defval: "",
        raw: true,
      });
      const parsed = parseCounterpartyMatrix(matrix);
      setRows(parsed.rows);
      setMissing(parsed.missingColumns);

      if (!parsed.headerFound) {
        setError("Не найден заголовок таблицы. Нужна строка со столбцами «Наименование», «ИНН», «КПП» — скачайте шаблон.");
      } else if (parsed.rows.length === 0) {
        setError("В файле нет заполненных строк");
      } else if (parsed.rows.length > IMPORT_ROW_LIMIT) {
        setError(`В файле ${parsed.rows.length} строк — за один раз можно загрузить не более ${IMPORT_ROW_LIMIT}. Разделите файл на части.`);
      }
    } catch {
      setError("Не удалось прочитать файл. Проверьте, что это корректный файл Excel, и попробуйте снова.");
    } finally {
      setReading(false);
    }
  };

  const { valid, duplicates, invalid } = useMemo(() => {
    const seen = new Set<string>();
    const validRows: ParsedCounterpartyRow[] = [];
    const duplicateRows: ParsedCounterpartyRow[] = [];
    const invalidRows: ParsedCounterpartyRow[] = [];

    for (const row of rows) {
      if (row.error) {
        invalidRows.push(row);
        continue;
      }
      // Строку без ИНН сравнивать не с чем — она всегда идёт в загрузку.
      if (row.inn) {
        if (seen.has(row.inn)) {
          duplicateRows.push(row);
          continue;
        }
        seen.add(row.inn);
      }
      validRows.push(row);
    }
    return { valid: validRows, duplicates: duplicateRows, invalid: invalidRows };
  }, [rows]);

  const preview = useMemo(() => {
    const duplicateLines = new Set(duplicates.map((row) => row.line));
    return rows.slice(0, PREVIEW_LIMIT).map((row) => ({
      row,
      status: row.error ? "error" : duplicateLines.has(row.line) ? "duplicate" : "ok",
    }));
  }, [rows, duplicates]);

  const downloadTemplate = async () => {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.json_to_sheet(IMPORT_TEMPLATE_ROWS, { header: [...IMPORT_COLUMNS] });
    ws["!cols"] = [{ wch: 42 }, { wch: 16 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Контрагенты");
    XLSX.writeFile(wb, "counterparties-template.xlsx");
  };

  const submit = () => {
    if (valid.length === 0) return;
    setError(null);
    setNotice(null);
    start(async () => {
      // Отправляем порциями: server action принимает ограниченный по размеру запрос.
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      const warnings: string[] = [];
      let failure: string | null = null;

      for (let i = 0; i < valid.length; i += UPLOAD_CHUNK) {
        const chunk = valid.slice(i, i + UPLOAD_CHUNK);
        setProgress(`Загружаем ${Math.min(i + UPLOAD_CHUNK, valid.length)} из ${valid.length}...`);
        const res = await importCounterpartiesAction({
          rows: chunk.map((row) => ({ name: row.name, inn: row.inn, kpp: row.kpp, line: row.line })),
          updateExisting,
        });
        if (!res.ok) {
          failure = res.error;
          break;
        }
        inserted += res.inserted;
        updated += res.updated;
        skipped += res.skipped;
        warnings.push(...res.warnings);
      }

      setProgress(null);
      onImported();

      if (failure) {
        const saved = inserted + updated;
        setError(saved > 0 ? `${failure} До ошибки успешно загружено: ${saved}.` : failure);
        return;
      }

      const parts = [`добавлено ${inserted}`];
      if (updated > 0) parts.push(`обновлено ${updated}`);
      if (skipped > 0) parts.push(`пропущено ${skipped}`);
      setNotice({ msg: `Загрузка завершена: ${parts.join(", ")}.`, warnings: warnings.slice(0, 5) });
      setRows([]);
      setMissing([]);
      setFileName(null);
    });
  };

  const busy = reading || pending;

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        title="Загрузка контрагентов из Excel (только для администраторов)"
      >
        <FileSpreadsheet size={16} /> Загрузить из Excel
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Загрузка контрагентов из Excel"
        wide
        footer={
          <>
            <Button variant="outline" size="sm" className="mr-auto" onClick={downloadTemplate} disabled={busy}>
              <Download size={14} /> Шаблон
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>Закрыть</Button>
            <Button size="sm" onClick={submit} disabled={busy || valid.length === 0}>
              {pending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {pending ? progress ?? "Загружаем..." : `Загрузить (${valid.length})`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/5 p-3 text-xs">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-accent2" />
            <p className="text-muted">
              Столбцы файла: <b className="text-text">Наименование</b>, <b className="text-text">ИНН</b>, <b className="text-text">КПП</b>.
              Обязательно только наименование. Повторы ИНН внутри файла и уже существующие ИНН
              {updateExisting ? " обновляются" : " пропускаются"} — без дублей в базе.
            </p>
          </div>

          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void readFile(file);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center transition",
              dragging ? "border-accent bg-accent/10" : "border-border bg-card2/60 hover:border-accent/50",
            )}
          >
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void readFile(file);
              }}
            />
            {reading ? <Loader2 size={22} className="animate-spin text-accent2" /> : <Upload size={22} className="text-muted" />}
            <span className="text-sm font-medium">{fileName ?? "Перетащите файл или нажмите, чтобы выбрать"}</span>
            <span className="text-[11px] text-muted">
              Excel (.xlsx, .xls) или CSV · до {FILE_LIMIT_MB} МБ · до {IMPORT_ROW_LIMIT} строк
            </span>
          </label>

          {missing.length > 0 && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
              В заголовке нет столбцов: {missing.join(", ")} — эти поля останутся пустыми.
            </p>
          )}

          {rows.length > 0 && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5">
                <p className="text-lg font-semibold text-emerald-500">{valid.length}</p>
                <p className="text-[10px] text-muted">к загрузке</p>
              </div>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5">
                <p className="text-lg font-semibold text-amber-500">{duplicates.length}</p>
                <p className="text-[10px] text-muted">дублей ИНН</p>
              </div>
              <div className={cn("rounded-xl border p-2.5", invalid.length > 0 ? "border-red-500/30 bg-red-500/10" : "border-border bg-card2")}>
                <p className={cn("text-lg font-semibold", invalid.length > 0 && "text-red-500")}>{invalid.length}</p>
                <p className="text-[10px] text-muted">с ошибками</p>
              </div>
            </div>
          )}

          {rows.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 border-b border-border bg-card2/95 backdrop-blur">
                    <tr>
                      <th className="px-2 py-2 text-left font-semibold text-muted">#</th>
                      <th className="px-2 py-2 text-left font-semibold text-muted">Наименование</th>
                      <th className="px-2 py-2 text-left font-semibold text-muted">ИНН</th>
                      <th className="px-2 py-2 text-left font-semibold text-muted">КПП</th>
                      <th className="px-2 py-2 text-left font-semibold text-muted">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map(({ row, status }) => (
                      <tr key={row.line} className="border-b border-border/60 last:border-0">
                        <td className="px-2 py-1.5 font-mono text-muted">{row.line}</td>
                        <td className="max-w-[220px] truncate px-2 py-1.5">{row.name || "—"}</td>
                        <td className="px-2 py-1.5 font-mono text-muted">{row.inn || "—"}</td>
                        <td className="px-2 py-1.5 font-mono text-muted">{row.kpp || "—"}</td>
                        <td className="px-2 py-1.5">
                          {status === "ok" && (
                            <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/30">К загрузке</Badge>
                          )}
                          {status === "duplicate" && (
                            <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/30">Дубль ИНН</Badge>
                          )}
                          {status === "error" && (
                            <Badge className="bg-red-500/15 text-red-500 border-red-500/30">
                              <span title={row.error ?? undefined}>Ошибка</span>
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > PREVIEW_LIMIT && (
                <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
                  Показаны первые {PREVIEW_LIMIT} из {rows.length} строк — загрузятся все.
                </p>
              )}
            </div>
          )}

          {invalid.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-500">
              {invalid.slice(0, 5).map((row) => (
                <li key={row.line}>Строка {row.line}: {row.error}</li>
              ))}
              {invalid.length > 5 && <li>…и ещё {invalid.length - 5}</li>}
            </ul>
          )}

          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition",
              updateExisting ? "border-accent bg-accent/10" : "border-border bg-card2/60 hover:border-accent/40",
            )}
          >
            <input
              type="checkbox"
              checked={updateExisting}
              onChange={(e) => setUpdateExisting(e.target.checked)}
              disabled={pending}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#7c5cff]"
            />
            <span>
              <span className="block font-medium">Обновлять существующих по ИНН</span>
              <span className="block text-xs text-muted">
                Если ИНН уже есть в базе, обновим наименование и КПП, а не пропустим строку. Остальные
                реквизиты (телефон, email, адрес, заметки) останутся как были.
              </span>
            </span>
          </label>

          {error && (
            <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>
          )}

          {notice && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">
              <p className="flex items-center gap-1.5">
                <CheckCircle2 size={14} className="shrink-0" /> {notice.msg}
              </p>
              {notice.warnings.length > 0 && (
                <p className="mt-1 text-amber-500">{notice.warnings.join(" · ")}</p>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
