import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createAgentSseProxyStream } from "@/lib/agentSseProxy";
import { subscribeAppEvents } from "@/lib/clientEvents";

function parseSseFrames(raw: string): Array<{ event: string; data: string }> {
  const normalized = raw.replace(/\r\n/g, "\n");
  const out: Array<{ event: string; data: string }> = [];
  for (const frame of normalized.split("\n\n")) {
    if (!frame.trim()) continue;
    const lines = frame.split("\n");
    const ev = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
    const data = lines
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    out.push({ event: ev, data });
  }
  return out;
}

describe("createAgentSseProxyStream", () => {
  it("прокачивает крупный (>256 КБ) кадр, разбитый на чанки без \\n\\n, без deadlock", async () => {
    const encoder = new TextEncoder();
    const bigPreview = `data:image/png;base64,${"A".repeat(320 * 1024)}`;
    const payload =
      `event: action\ndata: ${JSON.stringify({ type: "browser_inspect", preview: bigPreview })}\n\n` +
      `event: text\ndata: ${JSON.stringify({ text: "Готово" })}\n\n` +
      `event: done\ndata: {}\n\n`;

    const bytes = encoder.encode(payload);
    let offset = 0;
    const chunkSize = 16 * 1024;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, Math.min(bytes.length, offset + chunkSize)));
        offset += chunkSize;
      },
    });

    const onDone = vi.fn();
    const proxy = createAgentSseProxyStream({
      upstreamReader: upstream.getReader(),
      processFrame: async (frame) => `${frame}\n\n`,
      onDone,
    });

    const text = await new Response(proxy).text();
    const frames = parseSseFrames(text);
    expect(frames.map((f) => f.event)).toEqual(["action", "text", "done"]);
    expect((JSON.parse(frames[0].data) as { preview: string }).preview.length).toBe(bigPreview.length);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("склеивает разорванные на границе чанков \\r\\n\\r\\n, пропускает keepalive и читает хвост на EOF", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ": keepalive\r\n\r",
      "\nevent: status\r\ndata: {\"text\":\"Работаю\"}\r\n\r",
      "\nevent: text\r\ndata: {\"text\":\"Финал\"}\r\n\r\n",
      "event: done\r\ndata: {\"steps\":1}",
    ];
    let idx = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[idx++]));
      },
    });

    const proxy = createAgentSseProxyStream({
      upstreamReader: upstream.getReader(),
      processFrame: (frame) => `${frame}\n\n`,
    });

    const text = await new Response(proxy).text();
    const frames = parseSseFrames(text);
    expect(frames.map((f) => f.event)).toEqual(["message", "status", "text", "done"]);
    expect(JSON.parse(frames[3].data)).toEqual({ steps: 1 });
  });

  it("добавляет event: error при обрыве потока без done/error и при ошибке чтения сокета", async () => {
    const encoder = new TextEncoder();
    const eofWithoutDone = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\n\nevent: text\ndata: {\"text\":\"Частично\"}\n\n"));
        controller.close();
      },
    });
    const proxy1 = createAgentSseProxyStream({
      upstreamReader: eofWithoutDone.getReader(),
      processFrame: (frame) => `${frame}\n\n`,
    });
    const frames1 = parseSseFrames(await new Response(proxy1).text());
    expect(frames1.at(-1)?.event).toBe("error");
    expect(JSON.parse(frames1.at(-1)!.data)).toEqual({
      error: "Поток ответа от агента оборвался без завершения",
    });

    const socketError = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const proxy2 = createAgentSseProxyStream({
      upstreamReader: socketError.getReader(),
      processFrame: (frame) => `${frame}\n\n`,
      onError,
      onDone,
    });
    const frames2 = parseSseFrames(await new Response(proxy2).text());
    expect(frames2.at(-1)?.event).toBe("error");
    expect((JSON.parse(frames2.at(-1)!.data) as { error: string }).error).toContain("socket hang up");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("прокачивает реальный HTTP SSE-поток (>500 КБ) без зависания", async () => {
    const bigPayload = "X".repeat(520 * 1024);
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write(": keepalive\n\n");
      const frame = `event: action\ndata: ${JSON.stringify({ type: "browser_inspect", preview: bigPayload })}\n\n`;
      for (let i = 0; i < frame.length; i += 16384) {
        res.write(frame.slice(i, i + 16384));
      }
      res.end("event: done\ndata: {}\n\n");
    });

    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address();
    if (!addr || typeof addr === "string") throw new Error("Expected numeric port");

    try {
      const upstreamRes = await fetch(`http://127.0.0.1:${addr.port}/run`);
      expect(upstreamRes.body).toBeTruthy();
      const proxied = createAgentSseProxyStream({
        upstreamReader: upstreamRes.body!.getReader(),
        processFrame: async (frame) => `${frame}\n\n`,
      });
      const frames = parseSseFrames(await new Response(proxied).text());
      expect(frames.map((f) => f.event)).toEqual(["message", "action", "done"]);
      expect((JSON.parse(frames[1].data) as { preview: string }).preview.length).toBe(bigPayload.length);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe("subscribeAppEvents", () => {
  it("открывает только один общий EventSource на вкладку и закрывает его при отписке всех", () => {
    const instances: Array<{
      url: string;
      readyState: number;
      onopen: (() => void) | null;
      onerror: (() => void) | null;
      listeners: Record<string, Array<(e: MessageEvent<string>) => void>>;
      close: ReturnType<typeof vi.fn>;
      addEventListener: (type: string, cb: (e: MessageEvent<string>) => void) => void;
    }> = [];

    class FakeEventSource {
      url: string;
      readyState = 0;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      listeners: Record<string, Array<(e: MessageEvent<string>) => void>> = {};
      close = vi.fn();

      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }

      addEventListener(type: string, cb: (e: MessageEvent<string>) => void) {
        this.listeners[type] = this.listeners[type] ?? [];
        this.listeners[type].push(cb);
      }
    }

    const origEventSource = globalThis.EventSource;
    const origWindow = globalThis.window;
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      const updates1: string[] = [];
      const updates2: string[] = [];
      const onOpen2 = vi.fn();
      const unsub1 = subscribeAppEvents({ onUpdate: (d) => updates1.push(d) });
      expect(instances).toHaveLength(1);
      instances[0].readyState = 1;
      instances[0].onopen?.();

      const unsub2 = subscribeAppEvents({ onOpen: onOpen2, onUpdate: (d) => updates2.push(d) });
      expect(instances).toHaveLength(1);
      expect(onOpen2).toHaveBeenCalledTimes(1);

      for (const cb of instances[0].listeners.update ?? []) {
        cb({ data: '{"scope":"chat"}' } as MessageEvent<string>);
      }
      expect(updates1).toEqual(['{"scope":"chat"}']);
      expect(updates2).toEqual(['{"scope":"chat"}']);

      unsub1();
      expect(instances[0].close).not.toHaveBeenCalled();
      unsub2();
      expect(instances[0].close).toHaveBeenCalledTimes(1);
    } finally {
      if (origEventSource === undefined && origWindow === undefined) {
        vi.unstubAllGlobals();
      } else {
        vi.stubGlobal("EventSource", origEventSource);
        vi.stubGlobal("window", origWindow);
      }
    }
  });
});
