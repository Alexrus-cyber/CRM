import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentChat } from "@/components/AgentChat";
import { GithubIntegrationPanel, type GithubAccountPublic } from "@/components/agent/GithubIntegrationPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub integration UI in Agent", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("crm.ai.agent.layout.v1", JSON.stringify("tabs"));
    vi.restoreAllMocks();
  });

  it("links GitHub PAT, selects repository & branch, and syncs GitHub-RAG", async () => {
    const accountAfterConnect: GithubAccountPublic = {
      id: 1,
      userId: 10,
      githubUserId: 500,
      login: "alex_owner",
      name: "Alex",
      email: "alex@example.com",
      avatarUrl: "",
      tokenHint: "ghp_12••••90ab",
      scopes: "repo",
      selectedOwner: "",
      selectedRepo: "",
      selectedBranch: "",
      enabled: true,
    };

    const repos = [
      {
        id: 11,
        owner: "alex_owner",
        name: "CRM",
        fullName: "alex_owner/CRM",
        private: true,
        defaultBranch: "main",
        description: "CRM project",
        language: "TypeScript",
        htmlUrl: "https://github.com/alex_owner/CRM",
        updatedAt: "2026-11-10T00:00:00Z",
      },
    ];

    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        calls.push({ url, method, body });

        if (url === "/api/github/connection" && method === "POST") {
          return json({ connected: true, account: accountAfterConnect, repos });
        }
        if (url === "/api/github/repos" && method === "GET") {
          return json({ repos });
        }
        if (url === "/api/github/connection" && method === "PATCH") {
          return json({
            connected: true,
            account: {
              ...accountAfterConnect,
              selectedOwner: String(body?.selectedOwner ?? "alex_owner"),
              selectedRepo: String(body?.selectedRepo ?? "CRM"),
              selectedBranch: String(body?.selectedBranch ?? "main"),
            },
          });
        }
        if (url.includes("/branches")) {
          return json({
            branches: [
              { name: "main", protected: true, sha: "111" },
              { name: "feat/agent-rag", protected: false, sha: "222" },
            ],
          });
        }
        if (url === "/api/github/sync" && method === "POST") {
          return json({ ok: true, fileCount: 48, sandboxSynced: true, branch: "feat/agent-rag" });
        }
        return json({});
      }),
    );

    const onAccountChange = vi.fn();
    const { rerender } = render(
      <GithubIntegrationPanel
        account={null}
        oauthAvailable={false}
        onAccountChange={onAccountChange}
      />,
    );

    const tokenInput = screen.getByLabelText("GitHub Personal Access Token");
    fireEvent.change(tokenInput, { target: { value: "ghp_test1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: /Привязать GitHub/i }));

    await waitFor(() => expect(onAccountChange).toHaveBeenCalledWith(accountAfterConnect));

    rerender(
      <GithubIntegrationPanel
        account={accountAfterConnect}
        oauthAvailable={false}
        onAccountChange={onAccountChange}
      />,
    );

    const repoSelect = await screen.findByLabelText("Выбор GitHub-репозитория");
    await waitFor(() => expect(repoSelect.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(repoSelect, { target: { value: "alex_owner/CRM" } });

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/github/connection" && c.method === "PATCH")).toBe(true),
    );

    const selectedAccount: GithubAccountPublic = {
      ...accountAfterConnect,
      selectedOwner: "alex_owner",
      selectedRepo: "CRM",
      selectedBranch: "feat/agent-rag",
    };
    rerender(
      <GithubIntegrationPanel
        account={selectedAccount}
        oauthAvailable={false}
        onAccountChange={onAccountChange}
      />,
    );

    const syncBtn = await screen.findByRole("button", { name: /Синхронизировать с Агентом/i });
    fireEvent.click(syncBtn);

    await waitFor(() => expect(screen.getByText(/RAG-индекс: 48 файлов/i)).toBeTruthy());
  });

  it("renders GitHub Commit approval toast strictly for @login and submits edited commit message", async () => {
    const approvalsSent: Array<Record<string, unknown>> = [];
    const agentPayloads: Array<Record<string, unknown>> = [];
    let finishSse: (() => void) | null = null;

    const ghAccount: GithubAccountPublic = {
      id: 1,
      userId: 10,
      githubUserId: 500,
      login: "dev_alex",
      name: "Alex",
      email: "alex@example.com",
      avatarUrl: "",
      tokenHint: "ghp_12••••90ab",
      scopes: "repo",
      selectedOwner: "dev_alex",
      selectedRepo: "CRM",
      selectedBranch: "feat/fix",
      enabled: true,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;

        if (url === "/api/ai/agent" && method === "GET") {
          return json({ available: true, tools: ["github_commit"] });
        }
        if (url === "/api/github/connection" && method === "GET") {
          return json({ connected: true, account: ghAccount, oauthAvailable: false });
        }
        if (url === "/api/github/repos") return json({ repos: [] });
        if (url.includes("/branches")) return json({ branches: [{ name: "feat/fix", protected: false, sha: "abc" }] });
        if (url === "/api/ai/agent/sandbox") return json({ available: true, projects: [], items: [], processes: [] });
        if (url === "/api/ai/rag") return json({ folders: [] });
        if (url === "/api/agent/transcripts") return json({ transcripts: [] });
        if (url === "/api/agent/bot/status") return json({ state: "stale", connected: false });
        if (url === "/api/agent/tasks") return json({ tasks: [] });
        if (url.startsWith("/api/agent/conversations?kind=agent") && method === "GET") {
          return json({
            conversations: [
              { id: 1, kind: "agent", title: "Новый чат", messagesCount: 0, updatedAt: new Date().toISOString() },
            ],
          });
        }
        if (url === "/api/agent/conversations" && method === "POST") {
          return json({
            conversation: {
              id: 1,
              kind: "agent",
              title: "Новый чат",
              messagesCount: 0,
              updatedAt: new Date().toISOString(),
            },
          });
        }
        if (url === "/api/agent/conversations/1" && method === "GET") {
          return json({ conversation: { id: 1, title: "Новый чат" }, messages: [] });
        }
        if (url === "/api/agent/conversations/1/messages" && method === "POST") {
          return json({ message: { id: 10, role: body?.role ?? "user", content: body?.content ?? "" } });
        }
        if (url === "/api/ai/agent/approve" && method === "POST") {
          approvalsSent.push(body ?? {});
          finishSse?.();
          return json({ ok: true });
        }
        if (url === "/api/ai/agent" && method === "POST") {
          agentPayloads.push(body ?? {});
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(
                  `event: approval_required\ndata: ${JSON.stringify({
                    approvalId: "gh-apr-1",
                    kind: "github_commit",
                    title: "Разрешить Commit и Push от имени @dev_alex",
                    reason: "Изменение репозитория dev_alex/CRM от лица привязавшего аккаунт @dev_alex",
                    github: {
                      login: "dev_alex",
                      authorName: "Alex",
                      authorEmail: "alex@example.com",
                      owner: "dev_alex",
                      repo: "CRM",
                      branch: "feat/fix",
                      message: "fix: initial message",
                      push: true,
                      files: [" M src/app.ts"],
                      diffPreview: "+console.log('fixed');",
                    },
                  })}\n\n`,
                ),
              );
              finishSse = () => {
                controller.enqueue(
                  enc.encode(
                    `event: action\ndata: ${JSON.stringify({
                      type: "github_commit",
                      owner: "dev_alex",
                      repo: "CRM",
                      branch: "feat/fix",
                      sha: "abcdef1234567",
                      message: "fix: approved commit msg",
                      pushed: true,
                      authorLogin: "dev_alex",
                      url: "https://github.com/dev_alex/CRM/commit/abcdef1234567",
                    })}\n\n`,
                  ),
                );
                controller.enqueue(enc.encode(`event: text\ndata: {"text":"Коммит выполнен"}\n\n`));
                controller.enqueue(enc.encode(`event: done\ndata: {}\n\n`));
                controller.close();
              };
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return json({});
      }),
    );

    render(<AgentChat userName="Алексей" unlimited />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /@dev_alex · dev_alex\/CRM@feat\/fix/i })).toBeTruthy(),
    );

    const ragTab = screen.getByRole("tab", { name: /Доверие и RAG/i });
    fireEvent.click(ragTab);
    expect(screen.getByText(/Подключение GitHub \(GitHub-RAG и разработка\)/i)).toBeTruthy();

    const chatTab = screen.getByRole("tab", { name: /^Чат$/i });
    fireEvent.click(chatTab);

    const textarea = await screen.findByPlaceholderText(/Например:/i);
    fireEvent.change(textarea, { target: { value: "Поправь файл и сделай коммит" } });
    fireEvent.click(screen.getByRole("button", { name: /Запустить/i }));

    await waitFor(() =>
      expect(screen.getByText("Разрешить Commit и Push от имени @dev_alex")).toBeTruthy(),
    );

    expect(agentPayloads[0]).toMatchObject({
      githubEnabled: true,
      githubOwner: "dev_alex",
      githubRepo: "CRM",
      githubBranch: "feat/fix",
    });

    const msgInput = screen.getByDisplayValue("fix: initial message");
    fireEvent.change(msgInput, { target: { value: "fix: approved commit msg" } });

    const approveBtn = screen.getByRole("button", { name: /Подтвердить Commit и Push от @dev_alex/i });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(approvalsSent.length).toBe(1));
    expect(approvalsSent[0]).toMatchObject({
      approvalId: "gh-apr-1",
      approved: true,
      commitMessage: "fix: approved commit msg",
      branch: "feat/fix",
    });
    await waitFor(() =>
      expect(screen.getByText(/Commit abcdef1 \+ Push · dev_alex\/CRM@feat\/fix/i)).toBeTruthy(),
    );
  });
});
