"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpDown, Building2, Mail, MapPin, Phone, Plus, Search, Trash2, Pencil, Eye } from "lucide-react";
import type { CounterpartyRow } from "@/lib/data";
import { deleteCounterpartyAction, saveCounterpartyAction } from "@/app/actions/counterparties";
import { cn, formatDateTime } from "@/lib/utils";
import { Button, EmptyState, Field, Input, Modal, Select, Textarea } from "./ui";

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
          <Button onClick={openCreate}><Plus size={16} /> Новый контрагент</Button>
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
                  {filtered.map((c) => (
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
            {filtered.map((c) => (
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
