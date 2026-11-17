"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, KeyRound, Save, Shield, Trash2, X } from "lucide-react";
import type { Role } from "@/db/schema";
import type { UserLite } from "@/lib/data";
import {
  adminResetPasswordAction,
  changePasswordAction,
  deleteUserAction,
  updateProfileAction,
  updateUserRoleAction,
} from "@/app/actions/users";
import { AVATAR_COLORS, cn, ROLE_LABELS } from "@/lib/utils";
import { Avatar, Button, Card, Field, Input, Select, Textarea } from "./ui";

function Notice({ msg, ok }: { msg: string; ok: boolean }) {
  return (
    <p className={cn("rounded-xl border px-3 py-2 text-xs", ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500" : "border-red-500/30 bg-red-500/10 text-red-500")}>{msg}</p>
  );
}

export function ProfileForm({ user }: { user: UserLite }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState({
    name: user.name,
    email: user.email,
    phone: user.phone ?? "",
    position: user.position ?? "",
    bio: user.bio ?? "",
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl as string | null,
  });
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const [pw, setPw] = useState({ current: "", next: "", repeat: "" });
  const [pwNotice, setPwNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setNotice({ msg: "Выберите изображение", ok: false });
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const size = 256;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      setForm((f) => ({ ...f, avatarUrl: canvas.toDataURL("image/jpeg", 0.85) }));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const save = () => {
    setNotice(null);
    start(async () => {
      const res = await updateProfileAction(form);
      setNotice(res.ok ? { msg: "Профиль сохранён", ok: true } : { msg: res.error, ok: false });
      if (res.ok) router.refresh();
    });
  };

  const changePw = () => {
    setPwNotice(null);
    if (pw.next !== pw.repeat) return setPwNotice({ msg: "Пароли не совпадают", ok: false });
    start(async () => {
      const res = await changePasswordAction(pw.current, pw.next);
      setPwNotice(res.ok ? { msg: "Пароль изменён", ok: true } : { msg: res.error, ok: false });
      if (res.ok) setPw({ current: "", next: "", repeat: "" });
    });
  };

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card title="Аватар" subtitle="Фото или цвет с инициалами">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <Avatar name={form.name || "?"} color={form.avatarColor} url={form.avatarUrl} size={112} className="text-3xl" />
            <button onClick={() => fileRef.current?.click()} className="absolute -bottom-1 -right-1 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white shadow-lg" title="Загрузить фото"><Camera size={16} /></button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
          {form.avatarUrl && (
            <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, avatarUrl: null })}><X size={14} /> Убрать фото</Button>
          )}
          <div className="w-full">
            <p className="mb-2 text-xs font-medium text-muted">Цвет аватара</p>
            <div className="grid grid-cols-6 gap-2">
              {AVATAR_COLORS.map((c) => (
                <button key={c} onClick={() => setForm({ ...form, avatarColor: c })} className={cn("flex h-9 w-full items-center justify-center rounded-xl transition hover:scale-105", form.avatarColor === c && "ring-2 ring-offset-2 ring-offset-card ring-[var(--text)]")} style={{ background: c }} title={c}>
                  {form.avatarColor === c && <Check size={14} className="text-white" />}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted">
              <span>Свой цвет:</span>
              <input type="color" value={form.avatarColor} onChange={(e) => setForm({ ...form, avatarColor: e.target.value })} className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent" />
              <span className="font-mono">{form.avatarColor}</span>
            </div>
          </div>
        </div>
      </Card>

      <div className="space-y-4">
        <Card title="Личная информация" subtitle="Эти данные видят коллеги в разделе «Команда»">
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field label="Имя и фамилия *"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Email *"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Телефон"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+7 (999) 000-00-00" /></Field>
            <Field label="Должность"><Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="Frontend-разработчик" /></Field>
            <Field label="Права доступа">
              <div className="flex h-10 items-center gap-2 rounded-xl border border-border bg-card2/50 px-3 text-sm text-muted"><Shield size={14} className="text-accent2" />{ROLE_LABELS[user.role]}<span className="ml-auto text-[10px]">меняет главный админ</span></div>
            </Field>
            <Field label="О себе" className="sm:col-span-2"><Textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="Чем занимаетесь, зона ответственности, навыки..." /></Field>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            {notice ? <Notice {...notice} /> : <span />}
            <Button onClick={save} disabled={pending}><Save size={16} /> {pending ? "Сохраняем..." : "Сохранить профиль"}</Button>
          </div>
        </Card>

        <Card title="Смена пароля">
          <div className="grid min-w-0 gap-4 sm:grid-cols-3">
            <Field label="Текущий пароль"><Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>
            <Field label="Новый пароль"><Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
            <Field label="Повторите"><Input type="password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} autoComplete="new-password" /></Field>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            {pwNotice ? <Notice {...pwNotice} /> : <span />}
            <Button variant="secondary" onClick={changePw} disabled={pending || !pw.current || !pw.next}><KeyRound size={16} /> Сменить пароль</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

export function UserAdminControls({ target, me }: { target: UserLite; me: { id: number; role: Role } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [role, setRole] = useState<Role>(target.role);
  const [pw, setPw] = useState("");
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const isSuper = me.role === "super_admin";
  const canReset = isSuper || (me.role === "admin" && target.role === "user");
  if (target.id === me.id || target.role === "super_admin" || (!isSuper && !canReset)) return null;

  return (
    <Card title="Управление пользователем" subtitle="Доступно администраторам">
      <div className="space-y-4">
        {isSuper && (
          <Field label="Права доступа">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="sm:flex-1"
                aria-label="Права доступа"
              >
                <option value="user">Сотрудник</option>
                <option value="admin">Администратор</option>
              </Select>
              <Button
                variant="secondary"
                className="w-full shrink-0 sm:w-auto"
                disabled={pending || role === target.role}
                onClick={() =>
                  start(async () => {
                    const r = await updateUserRoleAction(target.id, role);
                    setNotice(r.ok ? { msg: `Роль изменена на «${ROLE_LABELS[role]}»`, ok: true } : { msg: r.error, ok: false });
                    if (r.ok) router.refresh();
                  })
                }
              >
                Применить
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted">
              Текущая роль: <span className="font-medium text-text">{ROLE_LABELS[target.role]}</span>
            </p>
          </Field>
        )}

        {canReset && (
          <Field label="Сбросить пароль">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                type="text"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="Новый пароль (мин. 6 символов)"
                className="sm:flex-1"
                autoComplete="new-password"
              />
              <Button
                variant="secondary"
                className="w-full shrink-0 sm:w-auto"
                disabled={pending || pw.length < 6}
                onClick={() =>
                  start(async () => {
                    const r = await adminResetPasswordAction(target.id, pw);
                    setNotice(r.ok ? { msg: "Пароль сброшен — сообщите его сотруднику", ok: true } : { msg: r.error, ok: false });
                    if (r.ok) setPw("");
                  })
                }
              >
                <KeyRound size={14} /> Сбросить
              </Button>
            </div>
          </Field>
        )}

        {notice && <Notice {...notice} />}

        {isSuper && (
          <Button
            variant="danger"
            size="sm"
            className="w-full sm:w-auto"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Удалить пользователя ${target.name}? Все его задачи и сообщения будут удалены.`)) return;
              start(async () => {
                const r = await deleteUserAction(target.id);
                if (!r.ok) return setNotice({ msg: r.error, ok: false });
                router.push("/team");
                router.refresh();
              });
            }}
          >
            <Trash2 size={14} /> Удалить пользователя
          </Button>
        )}

        <p className="text-[11px] text-muted">
          {isSuper
            ? "Главный администратор может менять права, сбрасывать пароли и удалять сотрудников."
            : "Администратор может сбрасывать пароли только сотрудникам."}
        </p>
      </div>
    </Card>
  );
}
