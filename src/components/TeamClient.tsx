"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail, Phone, Plus, Search, Shield, UserPlus } from "lucide-react";
import type { Role } from "@/db/schema";
import type { UserLite } from "@/lib/data";
import { createUserAction } from "@/app/actions/users";
import { cn, ROLE_LABELS, roleBadgeClass } from "@/lib/utils";
import { Avatar, Badge, Button, Field, Input, Modal, Select } from "./ui";

export function TeamList({ users, me, stats }: { users: UserLite[]; me: { id: number; role: Role }; stats: Record<number, { open: number; done: number; points: number }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" as Role, position: "", phone: "" });

  const canCreate = me.role === "admin" || me.role === "super_admin";

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (!s) return true;
      return [u.name, u.email, u.position, u.phone].some((v) => (v ?? "").toLowerCase().includes(s));
    });
  }, [users, q, roleFilter]);

  const submit = () => {
    setError(null);
    start(async () => {
      const res = await createUserAction(form);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      setForm({ name: "", email: "", password: "", role: "user", position: "", phone: "" });
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск сотрудника..." className="h-9 pl-9 text-xs" />
        </div>
        <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="h-9 w-full min-w-0 text-xs sm:w-36">
          <option value="all">Все роли</option>
          <option value="super_admin">Главный админ</option>
          <option value="admin">Администраторы</option>
          <option value="user">Сотрудники</option>
        </Select>
        {canCreate && (
          <Button size="sm" className="w-full sm:w-auto" onClick={() => { setError(null); setOpen(true); }}><UserPlus size={14} /> Добавить</Button>
        )}
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-2">
        {filtered.map((u) => {
          const s = stats[u.id] ?? { open: 0, done: 0, points: 0 };
          return (
            <Link key={u.id} href={`/team/${u.id}`} className="card-hover flex min-w-0 max-w-full items-center gap-2.5 overflow-hidden rounded-2xl border border-border bg-card p-3 sm:gap-3">
              <Avatar name={u.name} color={u.avatarColor} url={u.avatarUrl} size={42} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-semibold">{u.name}{u.id === me.id && <span className="ml-1 text-xs font-normal text-muted">(вы)</span>}</p>
                  <Badge className={roleBadgeClass(u.role)}>{u.role !== "user" && <Shield size={10} />}{ROLE_LABELS[u.role]}</Badge>
                </div>
                <p className="truncate text-xs text-muted">{u.position || "Должность не указана"}</p>
                <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
                  <span className="flex min-w-0 items-center gap-1"><Mail size={11} className="shrink-0" /><span className="truncate">{u.email}</span></span>
                  {u.phone && <span className="flex min-w-0 items-center gap-1"><Phone size={11} className="shrink-0" /><span className="truncate">{u.phone}</span></span>}
                </div>
              </div>
              <div className="hidden shrink-0 text-right text-[11px] text-muted sm:block">
                <p><b className="text-text">{s.open}</b> открыто</p>
                <p><b className="text-emerald-500">{s.done}</b> выполнено</p>
                <p className={cn(s.points > 0 && "text-accent2")}>{s.points} очков</p>
              </div>
            </Link>
          );
        })}
        {filtered.length === 0 && <p className="rounded-xl border border-dashed border-border py-8 text-center text-xs text-muted">Никого не найдено</p>}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Новый пользователь"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Отмена</Button>
            <Button size="sm" onClick={submit} disabled={pending}><Plus size={14} /> {pending ? "Создаём..." : "Создать"}</Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Имя и фамилия *" className="sm:col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Иван Петров" autoFocus /></Field>
          <Field label="Email *"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="ivan@company.ru" /></Field>
          <Field label="Временный пароль *"><Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="минимум 6 символов" /></Field>
          <Field label="Роль">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="user">Сотрудник</option>
              {me.role === "super_admin" && <option value="admin">Администратор</option>}
            </Select>
          </Field>
          <Field label="Должность"><Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="Разработчик, менеджер..." /></Field>
          <Field label="Телефон" className="sm:col-span-2"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+7 (999) 000-00-00" /></Field>
        </div>
        <p className="mt-3 text-xs text-muted">Пользователь сможет сам заполнить профиль и сменить пароль после входа.</p>
        {error && <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>}
      </Modal>
    </div>
  );
}
