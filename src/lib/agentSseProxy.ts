/**
 * Надёжный SSE-прокси поток для `/api/ai/agent`.
 *
 * Почему нельзя использовать наивный `ReadableStream({ pull })`, который делает ровно
 * один `upstreamReader.read()` и выходит: по спецификации WHATWG Streams, если `pull()`
 * завершился без `controller.enqueue(...)` и без `controller.close()` (например, когда
 * крупный кадр вроде `browser_inspect` со скриншотом или длинный `reasoning` больше
 * одного TCP-чанка ~64 КБ, либо разделитель `\n\n` попал на границу чанков), браузерный/Node
 * `ReadableStream` БОЛЬШЕ НИКОГДА не вызовет `pull()`. В результате чтение сокета
 * останавливается, Python-агент через 30с падает с `клиентский SSE-канал не отвечает`,
 * а клиент на сайте остаётся висеть бесконечно.
 *
 * Реализация ниже читает `upstreamReader.read()` в цикле внутри `pull()` до тех пор,
 * пока не будет поставлен в очередь хотя бы один обработанный SSE-фрейм (или пока
 * поток не завершится / не сработает backpressure), корректно склеивает `\r\n` через
 * границы чанков и гарантированно закрывает клиентский поток с `event: error` при
 * неожиданном обрыве связи с агентом.
 */

export interface AgentSseProxyOptions {
  upstreamReader: ReadableStreamDefaultReader<Uint8Array>;
  processFrame: (frame: string) => Promise<string> | string;
  onDone?: () => Promise<void> | void;
  onError?: (err: unknown) => Promise<void> | void;
  reqSignal?: AbortSignal;
}

export function createAgentSseProxyStream({
  upstreamReader,
  processFrame,
  onDone,
  onError,
  reqSignal,
}: AgentSseProxyOptions): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = "";
  let trailingCr = false;
  let cancelled = false;
  let sawTerminalEvent = false;
  let finished = false;

  const isAborted = () => cancelled || Boolean(reqSignal?.aborted);

  const finishOnce = async () => {
    if (finished) return;
    finished = true;
    if (onDone) {
      await Promise.resolve(onDone()).catch(() => undefined);
    }
  };

  const emitFrame = async (
    rawFrame: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<number> => {
    if (!rawFrame.trim() || isAborted()) return 0;
    const processed = await processFrame(rawFrame);
    if (isAborted() || !processed) return 0;
    if (/^event:\s*(?:done|error)\b/m.test(processed)) {
      sawTerminalEvent = true;
    }
    try {
      controller.enqueue(encoder.encode(processed));
      return 1;
    } catch {
      cancelled = true;
      return 0;
    }
  };

  const pushChunkText = async (
    chunkText: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<number> => {
    if (!chunkText || isAborted()) return 0;
    let normalizedInput = (trailingCr ? "\r" : "") + chunkText;
    trailingCr = normalizedInput.endsWith("\r");
    if (trailingCr) {
      normalizedInput = normalizedInput.slice(0, -1);
    }
    sseBuffer += normalizedInput.replace(/\r\n/g, "\n");

    let enqueued = 0;
    let sep = sseBuffer.indexOf("\n\n");
    while (sep !== -1) {
      const frame = sseBuffer.slice(0, sep);
      sseBuffer = sseBuffer.slice(sep + 2);
      enqueued += await emitFrame(frame, controller);
      if (isAborted()) return enqueued;
      sep = sseBuffer.indexOf("\n\n");
    }
    return enqueued;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!isAborted()) {
          const { value, done } = await upstreamReader.read();
          if (isAborted()) return;

          if (done) {
            const tail = decoder.decode();
            if (tail) {
              await pushChunkText(tail, controller);
            }
            if (trailingCr) {
              trailingCr = false;
              sseBuffer += "\r";
            }
            if (sseBuffer.trim() && !isAborted()) {
              await emitFrame(sseBuffer, controller);
              sseBuffer = "";
            }
            if (!sawTerminalEvent && !isAborted()) {
              try {
                controller.enqueue(
                  encoder.encode(
                    `event: error\ndata: ${JSON.stringify({
                      error: "Поток ответа от агента оборвался без завершения",
                    })}\n\n`,
                  ),
                );
              } catch {
                cancelled = true;
              }
            }
            await finishOnce();
            if (!isAborted()) {
              try {
                controller.close();
              } catch {
                /* stream already closed */
              }
            }
            return;
          }

          const enqueued = await pushChunkText(decoder.decode(value, { stream: true }), controller);
          if (
            enqueued > 0 ||
            isAborted() ||
            (controller.desiredSize !== null && controller.desiredSize <= 0)
          ) {
            return;
          }
        }
      } catch (err) {
        await finishOnce();
        if (onError) {
          await Promise.resolve(onError(err)).catch(() => undefined);
        }
        if (!isAborted()) {
          const detail = err instanceof Error && err.message ? err.message : "обрыв соединения";
          try {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({
                  error: `Соединение с агентом прервалось: ${detail}`,
                })}\n\n`,
              ),
            );
            controller.close();
          } catch {
            try {
              controller.error(err);
            } catch {
              /* stream already closed */
            }
          }
        }
      }
    },
    async cancel() {
      cancelled = true;
      await upstreamReader.cancel().catch(() => undefined);
      await finishOnce();
    },
  });
}
