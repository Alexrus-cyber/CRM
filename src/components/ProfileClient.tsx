"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, ClipboardCopy, KeyRound, Laptop, LogOut, RotateCcw, Save, Shield, ShieldCheck, Trash2, X } from "lucide-react";
import type { Role } from "@/db/schema";
import type { UserLite } from "@/lib/data";
import {
  adminResetPasswordAction,
  changePasswordAction,
  deleteUserAction,
  setAiQuotaAction,
  setUserAgentAccessAction,
  updateProfileAction,
  updateUserRoleAction,
} from "@/app/actions/users";
import { AVATAR_COLORS, cn, formatDateTime, ROLE_LABELS } from "@/lib/utils";
import { Avatar, Button, Card, Field, Input, Textarea } from "./ui";
import { Combobox } from "./Combobox";

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
  const [emailConfirmPassword, setEmailConfirmPassword] = useState("");
  const [confirmLink, setConfirmLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const [pw, setPw] = useState({ current: "", next: "", repeat: "" });
  const [pwNotice, setPwNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const emailChanged = form.email.trim().toLowerCase() !== user.email.toLowerCase();

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
    setConfirmLink(null);
    start(async () => {
      const res = await updateProfileAction({
        ...form,
        ...(emailChanged ? { currentPassword: emailConfirmPassword } : {}),
      });
      if (!res.ok) {
        setNotice({ msg: res.error, ok: false });
        return;
      }
      const extra = res as { pendingEmail?: string; confirmPath?: string };
      if (extra.pendingEmail) {
        setEmailConfirmPassword("");
        setConfirmLink(extra.confirmPath ?? null);
        setNotice({
          msg: `Профиль сохранён. Для завершения смены email на ${extra.pendingEmail} перейдите по ссылке подтверждения.`,
          ok: true,
        });
      } else {
        setNotice({ msg: "Профиль сохранён", ok: true });
      }
      router.refresh();
    });
  };

  const changePw = () => {
    setPwNotice(null);
    if (pw.next !== pw.repeat) return setPwNotice({ msg: "Пароли не совпадают", ok: false });
    start(async () => {
      const res = await changePasswordAction(pw.current, pw.next);
      setPwNotice(
        res.ok
          ? { msg: "Пароль изменён, другие активные сессии завершены", ok: true }
          : { msg: res.error, ok: false },
      );
      if (res.ok) {
        setPw({ current: "", next: "", repeat: "" });
        router.refresh();
      }
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
            <Field label="Email *">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              {user.pendingEmail && (
                <p className="mt-1 text-[11px] text-amber-500">
                  Ожидает подтверждения новый email: <span className="font-mono">{user.pendingEmail}</span>
                </p>
              )}
            </Field>
            {emailChanged && (
              <Field label="Текущий пароль (для подтверждения смены email) *" className="sm:col-span-2">
                <Input
                  type="password"
                  value={emailConfirmPassword}
                  onChange={(e) => setEmailConfirmPassword(e.target.value)}
                  placeholder="Введите текущий пароль"
                  autoComplete="current-password"
                />
              </Field>
            )}
            <Field label="Телефон"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+7 (999) 000-00-00" /></Field>
            <Field label="Должность"><Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="Frontend-разработчик" /></Field>
            <Field label="Права доступа">
              <div className="flex h-10 items-center gap-2 rounded-xl border border-border bg-card2/50 px-3 text-sm text-muted"><Shield size={14} className="text-accent2" />{ROLE_LABELS[user.role]}<span className="ml-auto text-[10px]">меняет главный админ</span></div>
            </Field>
            <Field label="О себе" className="sm:col-span-2"><Textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="Чем занимаетесь, зона ответственности, навыки..." /></Field>
          </div>
          {confirmLink && (
            <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500">
              Локальное подтверждение email:{" "}
              <a href={confirmLink} className="font-semibold underline">
                подтвердить новый адрес
              </a>
            </div>
          )}
          <div className="mt-4 flex items-center justify-between gap-3">
            {notice ? <Notice {...notice} /> : <span />}
            <Button onClick={save} disabled={pending || (emailChanged && !emailConfirmPassword)}><Save size={16} /> {pending ? "Сохраняем..." : "Сохранить профиль"}</Button>
          </div>
        </Card>

        <Card title="Смена пароля" subtitle="Минимум 10 символов, обязательно буквы и цифры или спецсимволы">
          {user.mustChangePassword && (
            <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
              Установлен временный или первичный пароль — смените его сейчас для защиты аккаунта.
            </div>
          )}
          <div className="grid min-w-0 gap-4 sm:grid-cols-3">
            <Field label="Текущий пароль"><Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>
            <Field label="Новый пароль"><Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" placeholder="мин. 10 символов" /></Field>
            <Field label="Повторите"><Input type="password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} autoComplete="new-password" /></Field>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            {pwNotice ? <Notice {...pwNotice} /> : <span />}
            <Button variant="secondary" onClick={changePw} disabled={pending || !pw.current || pw.next.length < 10}><KeyRound size={16} /> Сменить пароль</Button>
          </div>
        </Card>

        <TwoFactorCard initialEnabled={user.totpEnabled} />

        <SessionsCard />
      </div>
    </div>
  );
}

function TwoFactorCard({ initialEnabled }: { initialEnabled: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);

  const startSetup = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/auth/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setup" }),
      });
      const data = (await res.json().catch(() => ({}))) as { secret?: string; otpauthUri?: string; error?: string };
      if (!res.ok || !data.secret || !data.otpauthUri) {
        setNotice({ msg: data.error || "Не удалось подготовить 2FA", ok: false });
        return;
      }
      setSetupData({ secret: data.secret, otpauthUri: data.otpauthUri });
    } finally {
      setBusy(false);
    }
  };

  const toggle2fa = async (action: "enable" | "disable") => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/auth/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, currentPassword: password, code: code.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; enabled?: boolean; error?: string };
      if (!res.ok) {
        setNotice({ msg: data.error || "Ошибка настройки 2FA", ok: false });
        return;
      }
      setEnabled(Boolean(data.enabled));
      setSetupData(null);
      setPassword("");
      setCode("");
      setNotice({
        msg: data.enabled ? "Двухфакторная аутентификация включена" : "Двухфакторная аутентификация отключена",
        ok: true,
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Двухфакторная аутентификация (2FA)"
      subtitle="Одноразовые 6-значные TOTP-коды в приложении-аутентификаторе"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-2">
            <ShieldCheck size={15} className={enabled ? "text-emerald-500" : "text-muted"} />
            Статус:{" "}
            <b className={enabled ? "text-emerald-500" : "text-muted"}>
              {enabled ? "включена" : "выключена"}
            </b>
          </span>
          {!enabled && !setupData && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void startSetup()}>
              Настроить 2FA
            </Button>
          )}
        </div>

        {!enabled && setupData && (
          <div className="space-y-3 rounded-xl border border-border bg-card2/50 p-3 text-xs">
            <p className="text-muted">
              Добавьте секретный ключ в приложение-аутентификатор (Google Authenticator, 2FAS, KeePassXC и т.п.):
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-card px-2 py-1.5 font-mono text-[11px]">
                {setupData.secret}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(setupData.secret);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                {copied ? <Check size={13} /> : <ClipboardCopy size={13} />}
              </Button>
            </div>
            <p className="truncate font-mono text-[10px] text-muted" title={setupData.otpauthUri}>
              {setupData.otpauthUri}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Текущий пароль">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
              <Field label="Код из приложения (6 цифр)">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  inputMode="numeric"
                />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy || !password || code.length !== 6} onClick={() => void toggle2fa("enable")}>
                Включить 2FA
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSetupData(null)}>
                Отмена
              </Button>
            </div>
          </div>
        )}

        {enabled && (
          <div className="space-y-3 rounded-xl border border-border bg-card2/40 p-3 text-xs">
            <p className="text-muted">Для отключения 2FA подтвердите текущий пароль и актуальный код из приложения:</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Текущий пароль">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
              <Field label="Код 2FA (6 цифр)">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  inputMode="numeric"
                />
              </Field>
            </div>
            <Button variant="danger" size="sm" disabled={busy || !password || code.length !== 6} onClick={() => void toggle2fa("disable")}>
              Отключить 2FA
            </Button>
          </div>
        )}

        {notice && <Notice {...notice} />}
      </div>
    </Card>
  );
}

type ActiveSessionItem = {
  id: number;
  label: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  current: boolean;
};

function SessionsCard() {
  const [sessions, setSessions] = useState<ActiveSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/sessions", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions?: ActiveSessionItem[] };
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/sessions", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { sessions?: ActiveSessionItem[] };
        if (!cancelled) setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const revokeOne = async (id: number) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/auth/sessions?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice({ msg: d.error || "Не удалось завершить сессию", ok: false });
        return;
      }
      setNotice({ msg: "Сессия завершена", ok: true });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const revokeOthers = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/auth/sessions?others=1", { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice({ msg: d.error || "Не удалось завершить другие сессии", ok: false });
        return;
      }
      setNotice({ msg: "Все остальные сессии завершены", ok: true });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const otherCount = sessions.filter((s) => !s.current).length;

  return (
    <Card title="Активные сессии" subtitle="Устройства и лаунчеры, в которых открыт ваш аккаунт">
      <div className="space-y-2">
        {loading && sessions.length === 0 ? (
          <p className="text-xs text-muted">Загрузка списка сессий...</p>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-muted">Активных сессий не найдено.</p>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card2/40 px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-medium text-text">
                  <Laptop size={13} className="shrink-0 text-accent2" />
                  <span className="truncate">{s.label || s.userAgent || "Браузер / приложение"}</span>
                  {s.current && (
                    <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-500">
                      текущая
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  Вход: {formatDateTime(s.createdAt)}
                  {s.lastSeenAt ? ` · активность: ${formatDateTime(s.lastSeenAt)}` : ""}
                  {s.ip ? ` · IP: ${s.ip}` : ""}
                </p>
              </div>
              {!s.current && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void revokeOne(s.id)}>
                  <LogOut size={13} /> Выйти
                </Button>
              )}
            </div>
          ))
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {notice ? <Notice {...notice} /> : <span />}
        {otherCount > 0 && (
          <Button variant="secondary" disabled={busy} onClick={() => void revokeOthers()}>
            <LogOut size={15} /> Выйти на остальных устройствах ({otherCount})
          </Button>
        )}
      </div>
    </Card>
  );
}

/** Роли, которые можно назначать из карточки сотрудника (главный админ один). */
const ASSIGNABLE_ROLES: Role[] = ["admin", "developer", "manager", "consultant", "user"];

export function UserAdminControls({
  target,
  me,
  aiQuota,
}: {
  target: UserLite;
  me: { id: number; role: Role };
  /** Расход и лимит ИИ, чтобы администратор мог расширить месяц. */
  aiQuota?: { used: number; limit: number | null; override: number | null };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [role, setRole] = useState<Role>(target.role);
  const [canUseAgent, setCanUseAgent] = useState<boolean>(Boolean(target.canUseAgent));
  const [canUseOperator, setCanUseOperator] = useState<boolean>(Boolean(target.canUseOperator));
  const [pw, setPw] = useState("");
  const [quota, setQuota] = useState<string>(
    aiQuota?.override ? String(aiQuota.override) : aiQuota?.limit ? String(aiQuota.limit + 1_000_000) : "1000000",
  );
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const isSuper = me.role === "super_admin";
  const isAdmin = isSuper || me.role === "admin";
  const canManageTarget =
    isSuper || ((me.role === "admin" || me.role === "manager") && (target.role === "user" || target.role === "consultant"));
  const canReset = isAdmin && canManageTarget;
  const canChangeRole = isSuper;
  const canExtendQuota = isAdmin;
  if (target.id === me.id || target.role === "super_admin" || (!canReset && !canChangeRole && !canExtendQuota)) return null;

  return (
    <Card title="Управление пользователем" subtitle="Доступно администраторам">
      <div className="space-y-4">
        {isSuper && (
          <Field label="Права доступа">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Combobox
                className="sm:flex-1"
                value={role}
                onChange={(next) => setRole(next as Role)}
                aria-label="Права доступа"
                placeholder="Выберите роль"
                options={ASSIGNABLE_ROLES.map((value) => ({ value, label: ROLE_LABELS[value] }))}
              />
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

        {isSuper && (
          <Field label="Доступ к Агенту и Оператору (сайт и лаунчер)">
            <div className="space-y-2 rounded-xl border border-border bg-card2/40 p-3">
              <label className="flex cursor-pointer items-center justify-between gap-2 text-xs">
                <span>Раздел «Агент»</span>
                <input
                  type="checkbox"
                  checked={canUseAgent}
                  disabled={pending}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setCanUseAgent(next);
                    start(async () => {
                      const r = await setUserAgentAccessAction(target.id, { canUseAgent: next });
                      setNotice(
                        r.ok
                          ? { msg: next ? "Доступ к Агенту выдан" : "Доступ к Агенту отключён", ok: true }
                          : { msg: r.error, ok: false },
                      );
                      if (r.ok) router.refresh();
                    });
                  }}
                  className="h-4 w-4 accent-[#7c5cff]"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2 text-xs">
                <span>Раздел «Оператор» (включая ПК-лаунчер)</span>
                <input
                  type="checkbox"
                  checked={canUseOperator}
                  disabled={pending}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setCanUseOperator(next);
                    start(async () => {
                      const r = await setUserAgentAccessAction(target.id, { canUseOperator: next });
                      setNotice(
                        r.ok
                          ? { msg: next ? "Доступ к Оператору выдан" : "Доступ к Оператору отключён", ok: true }
                          : { msg: r.error, ok: false },
                      );
                      if (r.ok) router.refresh();
                    });
                  }}
                  className="h-4 w-4 accent-[#7c5cff]"
                />
              </label>
              <p className="text-[10px] text-muted">
                При выданном доступе токены Агента и Оператора не ограничены и учитываются отдельно (видны только вам).
              </p>
            </div>
          </Field>
        )}

        {canExtendQuota && aiQuota && (
          <Field label="Лимит ИИ на этот месяц, токенов">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                type="number"
                min={0}
                step={100000}
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
                className="sm:flex-1"
                placeholder="Например, 5000000"
              />
              <Button
                variant="secondary"
                className="w-full shrink-0 sm:w-auto"
                disabled={pending || !quota || Number(quota) < 0}
                onClick={() =>
                  start(async () => {
                    const r = await setAiQuotaAction(target.id, Number(quota));
                    setNotice(r.ok ? { msg: `Лимит ИИ на месяц расширен до ${Number(quota).toLocaleString("ru-RU")}`, ok: true } : { msg: r.error, ok: false });
                    if (r.ok) router.refresh();
                  })
                }
              >
                Продлить
              </Button>
              {aiQuota.override !== null && (
                <Button
                  variant="ghost"
                  className="w-full shrink-0 sm:w-auto"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await setAiQuotaAction(target.id, null);
                      setNotice(r.ok ? { msg: "Расширение снято — действует лимит роли", ok: true } : { msg: r.error, ok: false });
                      if (r.ok) router.refresh();
                    })
                  }
                >
                  <RotateCcw size={13} /> Сбросить
                </Button>
              )}
            </div>
            <p className="mt-1.5 text-[11px] text-muted">
              Потрачено в этом месяце: <b className="text-text">{aiQuota.used.toLocaleString("ru-RU")}</b> из{" "}
              {aiQuota.limit === null ? "без лимита" : aiQuota.limit.toLocaleString("ru-RU")}
              {aiQuota.override !== null && ` · расширено до ${aiQuota.override.toLocaleString("ru-RU")}`}.
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
                placeholder="Новый пароль (мин. 10 симв., буквы и цифры)"
                className="sm:flex-1"
                autoComplete="new-password"
              />
              <Button
                variant="secondary"
                className="w-full shrink-0 sm:w-auto"
                disabled={pending || pw.length < 10}
                onClick={() =>
                  start(async () => {
                    const r = await adminResetPasswordAction(target.id, pw);
                    setNotice(r.ok ? { msg: "Пароль сброшен — сообщите его сотруднику (действует до смены)", ok: true } : { msg: r.error, ok: false });
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
              if (!confirm(`Удалить пользователя ${target.name}? Пользователь будет деактивирован и потеряет доступ.`)) return;
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
