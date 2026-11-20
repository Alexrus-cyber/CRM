"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Star,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { cn, formatDateTime } from "@/lib/utils";

/**
 * Подключения бота и их токены.
 *
 * Подключение — это адрес CRM, с которым работает бот. У пользователя их может
 * быть несколько (свой сервер, тестовый, у заказчика), а токенов на каждое —
 * сколько нужно: по одному на машину. Всё хранится в базе под пользователем,
 * поэтому список одинаков на любом компьютере и после перезагрузки.
 *
 * Токен в списке всегда маскирован; полное значение приходит только по кнопке
 * «Показать» и сразу попадает в команду запуска.
 */

export type AgentConnection = {
  id: number;
  name: string;
  serverUrl: string;
  isDefault: boolean;
  tokensCount: number;
  activeTokens: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentToken = {
  id: number;
  connectionId: number;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type ConnectionSelection = {
  connectionId: number | null;
  connectionName: string;
  server: string;
  token: string;
  tokenName: string;
  tokensCount: number;
};

const STORAGE_CONNECTION = "crm.ai.operator.connection.v1";

function readStoredConnection(): number {
  try {
    return Number(window.localStorage.getItem(STORAGE_CONNECTION) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function storeConnection(id: number): void {
  try {
    window.localStorage.setItem(STORAGE_CONNECTION, String(id));
  } catch {
    /* приватный режим — просто не запоминаем выбор */
  }
}

function when(value: string | null): string {
  if (!value) return "ещё не использовался";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
}

export function ConnectionsCard({
  defaultServer,
  onChange,
}: {
  defaultServer: string;
  onChange: (selection: ConnectionSelection) => void;
}) {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [connectionId, setConnectionId] = useState(0);
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newServer, setNewServer] = useState(defaultServer);
  const [tokenName, setTokenName] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [activeToken, setActiveToken] = useState<{ id: number; token: string; name: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const alive = useRef(true);

  const connection = useMemo(
    () => connections.find((item) => item.id === connectionId) ?? null,
    [connections, connectionId],
  );

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 4000);
  };

  const loadConnections = useCallback(async (): Promise<AgentConnection[]> => {
    try {
      const res = await fetch("/api/agent/connections", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { connections?: AgentConnection[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Не удалось загрузить подключения");
        return [];
      }
      const list = data.connections ?? [];
      if (alive.current) setConnections(list);
      return list;
    } catch {
      setError("Сеть недоступна — не удалось загрузить подключения");
      return [];
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  const loadTokens = useCallback(async (id: number) => {
    if (!id) {
      if (alive.current) setTokens([]);
      return;
    }
    try {
      const res = await fetch(`/api/agent/tokens?connectionId=${id}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { tokens?: AgentToken[]; error?: string };
      if (!alive.current) return;
      if (!res.ok) {
        setError(data.error ?? "Не удалось загрузить токены");
        setTokens([]);
        return;
      }
      setTokens(data.tokens ?? []);
    } catch {
      if (alive.current) setError("Сеть недоступна — не удалось загрузить токены");
    }
  }, []);

  /**
   * Выбор подключения: сбрасываем показанные токены и подтягиваем список.
   * Живёт в обработчиках, а не в эффекте, — так нет каскадных рендеров.
   */
  const selectConnection = useCallback(
    async (id: number) => {
      setConnectionId(id);
      setFreshToken(null);
      setRevealed({});
      setActiveToken(null);
      setConfirmDelete(false);
      setError(null);
      if (!id) {
        setTokens([]);
        return;
      }
      storeConnection(id);
      await loadTokens(id);
    },
    [loadTokens],
  );

  useEffect(() => {
    alive.current = true;
    // Загрузка на старте: сначала подключения, затем токены выбранного.
    void Promise.resolve()
      .then(() => loadConnections())
      .then((list) => {
        if (!alive.current || list.length === 0) return undefined;
        const stored = readStoredConnection();
        const next = list.some((item) => item.id === stored)
          ? stored
          : list.find((item) => item.isDefault)?.id ?? list[0].id;
        return next ? selectConnection(next) : undefined;
      })
      .catch(() => setError("Не удалось загрузить подключения"));
    return () => {
      alive.current = false;
    };
  }, [loadConnections, selectConnection]);

  // Выбранное подключение и токен уходят наверх: из них собирается команда.
  useEffect(() => {
    onChange({
      connectionId: connection?.id ?? null,
      connectionName: connection?.name ?? "",
      server: connection?.serverUrl ?? "",
      token: activeToken?.token ?? "",
      tokenName: activeToken?.name ?? "",
      tokensCount: tokens.length,
    });
  }, [onChange, connection, activeToken, tokens.length]);

  const createConnection = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, serverUrl: newServer.trim() || defaultServer }),
      });
      const data = (await res.json().catch(() => ({}))) as { connection?: AgentConnection; error?: string };
      if (!res.ok || !data.connection) {
        setError(data.error ?? "Не удалось создать подключение");
        return;
      }
      setConnections((prev) => [...prev, data.connection as AgentConnection]);
      await selectConnection(data.connection.id);
      setNewName("");
      setNewServer(defaultServer);
      setCreateOpen(false);
      flash(`Подключение «${data.connection.name}» создано`);
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async () => {
    if (!connection || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/connections", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: connection.id, isDefault: true }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Не удалось сделать подключение основным");
        return;
      }
      await loadConnections();
      flash(`«${connection.name}» — основное подключение`);
    } finally {
      setBusy(false);
    }
  };

  const removeConnection = async () => {
    if (!connection || busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/connections?id=${connection.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Не удалось удалить подключение");
        return;
      }
      setConfirmDelete(false);
      const list = await loadConnections();
      const next = list.find((item) => item.isDefault)?.id ?? list[0]?.id ?? 0;
      await selectConnection(next);
      flash("Подключение удалено вместе с его токенами");
    } finally {
      setBusy(false);
    }
  };

  const createToken = async () => {
    if (!connectionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, name: tokenName.trim() || "Основной" }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        item?: AgentToken;
        error?: string;
      };
      if (!res.ok || !data.token || !data.item) {
        setError(data.error ?? "Не удалось создать токен");
        return;
      }
      setFreshToken(data.token);
      setActiveToken({ id: data.item.id, token: data.token, name: data.item.name });
      setTokenName("");
      await loadTokens(connectionId);
      await loadConnections();
      flash("Токен создан и уже подставлен в команду запуска");
    } finally {
      setBusy(false);
    }
  };

  const revealToken = async (token: AgentToken): Promise<string | null> => {
    if (revealed[token.id]) {
      // Скрыли — значит токена не должно быть ни в списке, ни в команде запуска.
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[token.id];
        return next;
      });
      setActiveToken((current) => (current?.id === token.id ? null : current));
      return null;
    }
    try {
      const res = await fetch("/api/agent/tokens/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: token.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        setError(data.error ?? "Не удалось показать токен");
        return null;
      }
      setRevealed((prev) => ({ ...prev, [token.id]: data.token as string }));
      setActiveToken({ id: token.id, token: data.token, name: token.name });
      return data.token;
    } catch {
      setError("Сеть недоступна — не удалось показать токен");
      return null;
    }
  };

  const copyToken = async (token: AgentToken) => {
    const value = revealed[token.id] ?? (await revealToken(token));
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(`token-${token.id}`);
      setActiveToken({ id: token.id, token: value, name: token.name });
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Браузер не разрешил доступ к буферу обмена — скопируйте вручную");
    }
  };

  const revokeToken = async (token: AgentToken) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/tokens?id=${token.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Не удалось отозвать токен");
        return;
      }
      if (activeToken?.id === token.id) setActiveToken(null);
      if (freshToken && revealed[token.id] === freshToken) setFreshToken(null);
      await loadTokens(connectionId);
      await loadConnections();
      flash(`Токен «${token.name}» отозван`);
    } finally {
      setBusy(false);
    }
  };

  const createForm = createOpen ? (
    <div className="rounded-xl border border-border bg-card2/60 p-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className="block text-[10px] uppercase tracking-wide text-muted">Название</span>
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Например, «Тестовый сервер»"
            className="mt-1 h-9 text-xs"
            maxLength={60}
          />
        </label>
        <label>
          <span className="block text-[10px] uppercase tracking-wide text-muted">Адрес CRM</span>
          <Input
            value={newServer}
            onChange={(event) => setNewServer(event.target.value)}
            placeholder={defaultServer}
            className="mt-1 h-9 text-xs"
            spellCheck={false}
          />
        </label>
      </div>
      <Button size="sm" className="mt-2" onClick={() => void createConnection()} disabled={busy || !newName.trim()}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
        Создать подключение
      </Button>
    </div>
  ) : null;

  const activeConnection = connection;
  const totalTokens = connections.reduce((sum, item) => sum + item.tokensCount, 0);

  return (
    <Card
      title="1. Подключения и токены"
      subtitle="Подключение — это адрес CRM. У каждого свой список токенов: по одному на каждую машину."
      action={
        <Badge className="border-border text-muted">
          <Server size={11} />
          {loading ? "загружаю…" : `${connections.length} подкл. · ${totalTokens} токенов`}
        </Badge>
      }
    >
      {loading ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <Loader2 size={12} className="animate-spin" /> Читаю подключения из базы…
        </p>
      ) : connections.length === 0 ? (
        <div className="space-y-2.5">
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-600">
            Подключений пока нет. Создайте первое — «Этот CRM» с текущим адресом, — и получите токен для бота.
          </p>
          <Button size="sm" variant={createOpen ? "ghost" : "primary"} onClick={() => setCreateOpen((open) => !open)} disabled={busy}>
            {createOpen ? <X size={13} /> : <Plus size={13} />}
            {createOpen ? "Отмена" : "Новое подключение"}
          </Button>
          {createForm}
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="block text-[10px] uppercase tracking-wide text-muted">Подключение</span>
              <select
                value={connectionId || ""}
                onChange={(event) => void selectConnection(Number(event.target.value) || 0)}
                className="mt-1 h-9 w-full rounded-lg border border-border bg-card2 px-2 text-xs"
              >
                {connections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.isDefault ? " · основное" : ""} ({item.tokensCount})
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="secondary" onClick={() => setCreateOpen((open) => !open)} disabled={busy}>
              {createOpen ? <X size={13} /> : <Plus size={13} />}
              {createOpen ? "Отмена" : "Новое"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void makeDefault()}
              disabled={busy || !activeConnection || activeConnection.isDefault}
            >
              <Star size={13} />
              Сделать основным
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void removeConnection()}
              disabled={busy || !activeConnection}
              className={cn(confirmDelete && "text-red-500")}
            >
              <Trash2 size={13} />
              {confirmDelete ? "Точно удалить?" : "Удалить"}
            </Button>
          </div>

          {activeConnection && (
            <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
              <Server size={11} />
              <code className="rounded bg-card2 px-1.5 py-0.5 text-[11px]">{activeConnection.serverUrl}</code>
              {activeConnection.isDefault && <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-500">основное</Badge>}
            </p>
          )}

          {createForm}

          <div className="rounded-xl border border-border">
            <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
              <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted">
                <KeyRound size={11} /> Токены выбранного подключения
              </p>
              <Button size="sm" variant="ghost" onClick={() => void loadTokens(connectionId)} disabled={busy || !connectionId}>
                <RefreshCw size={12} />
              </Button>
            </div>
            <div className="divide-y divide-border">
              {tokens.length === 0 && (
                <p className="px-2.5 py-2 text-[11px] text-muted">
                  Токенов пока нет — создайте первый ниже. На каждую машину лучше свой: отзыв одного не трогает остальные.
                </p>
              )}
              {tokens.map((token) => {
                const full = revealed[token.id];
                const active = activeToken?.id === token.id;
                return (
                  <div key={token.id} className="flex flex-col gap-1.5 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                        <span className="truncate">{token.name || "Без названия"}</span>
                        {active && (
                          <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-500">в команде</Badge>
                        )}
                      </p>
                      <code className="mt-0.5 block truncate rounded bg-card2 px-1.5 py-0.5 font-mono text-[10px]">
                        {full ?? token.hint}
                      </code>
                      <p className="mt-0.5 text-[10px] text-muted">
                        создан {when(token.createdAt)} · {token.lastUsedAt ? `работал ${when(token.lastUsedAt)}` : when(null)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      <Button size="sm" variant="secondary" onClick={() => void revealToken(token)} disabled={busy}>
                        {full ? <EyeOff size={12} /> : <Eye size={12} />}
                        {full ? "Скрыть" : "Показать"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void copyToken(token)} disabled={busy}>
                        {copied === `token-${token.id}` ? <Check size={12} /> : <ClipboardCopy size={12} />}
                        {copied === `token-${token.id}` ? "скопирован" : "копировать"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void revokeToken(token)}
                        disabled={busy}
                        className="text-red-500 hover:text-red-600"
                      >
                        <Trash2 size={12} />
                        Отозвать
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1">
              <span className="block text-[10px] uppercase tracking-wide text-muted">Название нового токена</span>
              <Input
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createToken();
                }}
                placeholder="Например, «Ноутбук оператора»"
                className="mt-1 h-9 text-xs"
                maxLength={60}
              />
            </label>
            <Button size="sm" onClick={() => void createToken()} disabled={busy || !connectionId}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
              Создать токен
            </Button>
          </div>

          {freshToken && (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-2.5">
              <p className="text-[10px] text-muted">
                Токен создан. Он уже подставлен в команду; позже его можно снова показать кнопкой «Показать».
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-card2 px-2 py-1.5 font-mono text-[11px]">{freshToken}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(freshToken);
                      setCopied("fresh");
                      window.setTimeout(() => setCopied(null), 2000);
                    } catch {
                      setError("Браузер не разрешил доступ к буферу обмена — скопируйте вручную");
                    }
                  }}
                >
                  {copied === "fresh" ? <Check size={12} /> : <ClipboardCopy size={12} />}
                  {copied === "fresh" ? "скопирован" : "копировать"}
                </Button>
              </div>
            </div>
          )}

          {activeToken ? (
            <p className="text-[10px] text-emerald-600">
              В команду запуска попадёт токен «{activeToken.name}» подключения «{activeConnection?.name}».
            </p>
          ) : (
            tokens.length > 0 && (
              <p className="text-[10px] text-muted">
                Пока токен скрыт, в команде его нет: нажмите «Показать» у нужного токена — он подставится сам.
              </p>
            )
          )}
        </div>
      )}

      {notice && <p className="mt-2 text-[11px] text-emerald-600">{notice}</p>}
      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-500">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </Card>
  );
}
