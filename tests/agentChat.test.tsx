import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentChat } from "@/components/AgentChat";

type Sent = { messages?: Array<{ role: string; content: string }>; params?: Record<string, unknown>; attachments?: Array<{ name: string; text: string }> };

const sent: Sent[] = [];

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== "POST") {
        return new Response(JSON.stringify({ available: true, tools: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      sent.push(JSON.parse(String(init.body)) as Sent);
      // SSE не нужен: проверяем тело запроса, ответ намеренно «пустой».
      return new Response(JSON.stringify({ error: "тест" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

describe("вкладка «Агент»", () => {
  beforeEach(() => {
    localStorage.clear();
    sent.length = 0;
    mockFetch();
  });

  it("настройки генерации сохраняются и уходят в запрос", async () => {
    render(<AgentChat userName="Тест" />);
    // Блок настроек открыт по умолчанию — поля сразу доступны.
    const temperature = screen.getByLabelText(/temperature/i);
    fireEvent.change(temperature, { target: { value: "0.3" } });

    const textarea = screen.getByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(textarea, { target: { value: "привет" } });
    fireEvent.click(screen.getByText("Запустить"));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].params?.temperature).toBe(0.3);
    // Настройка переживает перерисовку: сохранена в localStorage.
    expect(JSON.parse(localStorage.getItem("crm.ai.agent.params.v1") ?? "{}").temperature).toBe(0.3);
    expect((screen.getByLabelText(/temperature/i) as HTMLInputElement).value).toBe("0.3");
  });

  it("файл прикрепляется и уходит в запрос вместе с вопросом", async () => {
    render(<AgentChat userName="Тест" />);
    const input = screen.getByLabelText("Приложить файлы для анализа") as HTMLInputElement;
    const file = new File(["План на день: зарядка и отчёт"], "plan.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByText(/plan\.txt/)).toBeTruthy();

    const textarea = screen.getByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(textarea, { target: { value: "что в файле?" } });
    fireEvent.click(screen.getByText("Запустить"));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].attachments?.[0]?.name).toBe("plan.txt");
    expect(sent[0].attachments?.[0]?.text).toContain("зарядка");
  });
});
