"use client";

import dynamic from "next/dynamic";
import { LazyMount } from "./lazy";
import { AiChatSkeleton } from "./skeletons";

/**
 * Блок «Чат с ИИ» грузится отдельным чанком и монтируется при подходе к экрану:
 * на странице он один, но тянет за собой довольно много кода (настройки,
 * потоковый разбор ответа, вложения).
 */
const AiChatClient = dynamic(() => import("./AiChatClient").then((module) => module.AiChatClient), {
  ssr: false,
  loading: () => <AiChatSkeleton />,
});

export function LazyAiChat({ userName }: { userName: string }) {
  return (
    <LazyMount
      minHeight={520}
      rootMargin="200px 0px"
      label="Загружаем чат с ИИ..."
      fallback={<AiChatSkeleton />}
    >
      <AiChatClient userName={userName} />
    </LazyMount>
  );
}
