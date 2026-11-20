import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectionsCard, type ConnectionSelection } from "@/components/operator/ConnectionsCard";

/**
 * Карточка «Подключения и токены»: список подключений и токенов приходит из базы,
 * токен в списке маскирован, «Показать» раскрывает его, «Отозвать» удаляет.
 */

type Conn = {
  id: number;
  name: string;
  serverUrl: string;
  isDefault: boolean;
  tokensCount: number;
  activeTokens: number;
  createdAt: string;
  updatedAt: string;
};
type Tok = {
  id: number;
  connectionId: number;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
};

const now = "2026-02-01T10:00:00.000Z";
const fullToken = "crmop_ff95c81e4d497080c15ff802cb7c39d58e0b96ae2d7b3f12";

let connections: Conn[];
let tokens: Tok[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.startsWith("/api/agent/connections")) {
        if (method === "GET") return json({ connections });
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; serverUrl?: string };
          const created: Conn = {
            id: connections.length + 1,
            name: body.name ?? "",
            serverUrl: body.serverUrl ?? "",
            isDefault: connections.length === 0,
            tokensCount: 0,
            activeTokens: 0,
            createdAt: now,
            updatedAt: now,
          };
          connections = [...connections, created];
          return json({ connection: created });
        }
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; name?: string; isDefault?: boolean };
          if (body.isDefault) connections = connections.map((item) => ({ ...item, isDefault: item.id === body.id }));
          if (body.name) connections = connections.map((item) => (item.id === body.id ? { ...item, name: body.name! } : item));
          return json({ connection: connections.find((item) => item.id === body.id) });
        }
        if (method === "DELETE") {
          const id = Number(new URL(url, "http://local").searchParams.get("id"));
          connections = connections.filter((item) => item.id !== id);
          tokens = tokens.filter((item) => item.connectionId !== id);
          return json({ ok: true });
        }
      }

      if (url.startsWith("/api/agent/tokens/reveal") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number };
        const token = tokens.find((item) => item.id === body.id);
        if (!token) return json({ error: "Токен не найден" }, 404);
        return json({ token: fullToken });
      }

      if (url.startsWith("/api/agent/tokens")) {
        if (method === "GET") {
          const id = Number(new URL(url, "http://local").searchParams.get("connectionId"));
          return json({
            tokens: tokens.filter((item) => item.connectionId === id),
            connection: connections.find((item) => item.id === id),
          });
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { connectionId?: number; name?: string };
          const created: Tok = {
            id: tokens.length + 1,
            connectionId: Number(body.connectionId),
            name: body.name ?? "",
            hint: `…${fullToken.slice(-6)}`,
            createdAt: now,
            lastUsedAt: null,
          };
          tokens = [created, ...tokens];
          connections = connections.map((item) =>
            item.id === created.connectionId
              ? { ...item, tokensCount: item.tokensCount + 1, activeTokens: item.activeTokens + 1 }
              : item,
          );
          return json({ token: fullToken, item: created });
        }
        if (method === "DELETE") {
          const id = Number(new URL(url, "http://local").searchParams.get("id"));
          const token = tokens.find((item) => item.id === id);
          tokens = tokens.filter((item) => item.id !== id);
          if (token) {
            connections = connections.map((item) =>
              item.id === token.connectionId
                ? { ...item, tokensCount: Math.max(0, item.tokensCount - 1) }
                : item,
            );
          }
          return json({ ok: true });
        }
      }

      return json({ error: `нет маршрута ${method} ${url}` }, 500);
    }),
  );
}

function lastSelection(onChange: ReturnType<typeof vi.fn>): ConnectionSelection {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1][0] as ConnectionSelection;
}

describe("карточка «Подключения и токены»", () => {
  beforeEach(() => {
    localStorage.clear();
    connections = [];
    tokens = [];
    mockServer();
  });

  it("пустой список позволяет создать первое подключение и берёт адрес в команду", async () => {
    const onChange = vi.fn();
    render(<ConnectionsCard defaultServer="http://localhost:3000" onChange={onChange} />);

    expect(await screen.findByText(/Подключений пока нет/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Новое подключение/ }));

    fireEvent.change(screen.getByPlaceholderText(/Тестовый сервер/), { target: { value: "Этот CRM" } });
    fireEvent.change(screen.getByPlaceholderText("http://localhost:3000"), { target: { value: "http://localhost:3000" } });
    fireEvent.click(screen.getByRole("button", { name: /Создать подключение/ }));

    expect(await screen.findByText(/Токенов пока нет/)).toBeTruthy();
    await waitFor(() => expect(lastSelection(onChange).connectionName).toBe("Этот CRM"));
    expect(lastSelection(onChange).server).toBe("http://localhost:3000");
    // Выбор подключения запомнен между перезагрузками страницы.
    expect(localStorage.getItem("crm.ai.operator.connection.v1")).toBe("1");
  });

  it("токен показан маской, раскрывается по «Показать» и отзывается", async () => {
    connections = [
      {
        id: 1,
        name: "Этот CRM",
        serverUrl: "http://localhost:3000",
        isDefault: true,
        tokensCount: 1,
        activeTokens: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
    tokens = [
      {
        id: 7,
        connectionId: 1,
        name: "Ноутбук",
        hint: `…${fullToken.slice(-6)}`,
        createdAt: now,
        lastUsedAt: null,
      },
    ];

    const onChange = vi.fn();
    render(<ConnectionsCard defaultServer="http://localhost:3000" onChange={onChange} />);

    // В списке только хвост токена — целиком он не утекает.
    expect(await screen.findByText(`…${fullToken.slice(-6)}`)).toBeTruthy();
    expect(screen.queryByText(fullToken)).toBeNull();
    await waitFor(() => expect(lastSelection(onChange).tokensCount).toBe(1));
    // Пока токен не показан, в команду он не попадает.
    expect(lastSelection(onChange).token).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /Показать/ }));
    expect(await screen.findByText(fullToken)).toBeTruthy();
    await waitFor(() => expect(lastSelection(onChange).token).toBe(fullToken));
    expect(lastSelection(onChange).tokenName).toBe("Ноутбук");

    fireEvent.click(screen.getByRole("button", { name: /Скрыть/ }));
    await waitFor(() => expect(screen.queryByText(fullToken)).toBeNull());
    await waitFor(() => expect(lastSelection(onChange).token).toBe(""));

    fireEvent.click(screen.getByRole("button", { name: /Отозвать/ }));
    expect(await screen.findByText(/Токенов пока нет/)).toBeTruthy();
    expect(tokens).toHaveLength(0);
    await waitFor(() => expect(lastSelection(onChange).tokensCount).toBe(0));
  });
});
