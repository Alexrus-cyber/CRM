"use client";

import dynamic from "next/dynamic";
import type { UserLite } from "@/lib/data";
import { LazyMount } from "./lazy";
import { ChatSkeleton } from "./skeletons";

/**
 * Чат грузится отдельным чанком и монтируется при подходе к экрану:
 * его JS (поллинг, обработчики, список сообщений) не участвует в первом
 * рендере страницы «Команда и чат».
 */
const ChatClient = dynamic(() => import("./ChatClient").then((module) => module.ChatClient), {
  ssr: false,
  loading: () => <ChatSkeleton />,
});

export function LazyChat({
  users,
  meId,
  initialPeer,
  unlimited = false,
}: {
  users: UserLite[];
  meId: number;
  initialPeer?: number;
  unlimited?: boolean;
}) {
  return (
    <LazyMount
      minHeight={560}
      rootMargin="200px 0px"
      label="Загружаем чат..."
      fallback={<ChatSkeleton />}
    >
      <ChatClient users={users} meId={meId} initialPeer={initialPeer} unlimited={unlimited} />
    </LazyMount>
  );
}
