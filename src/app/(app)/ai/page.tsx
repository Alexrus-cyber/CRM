import { Bot } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { Badge, PageHeader } from "@/components/ui";
import { LazyAiChat } from "@/components/LazyAiChat";

export const dynamic = "force-dynamic";

export default async function AiPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader
        title="Чат с ИИ"
        subtitle="Тестовый блок: вопросы к локальной модели, картинки и файлы"
        action={
          <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-500">
            <Bot size={12} />
            Тестовый режим
          </Badge>
        }
      />
      <LazyAiChat userName={user.name} />
    </>
  );
}
