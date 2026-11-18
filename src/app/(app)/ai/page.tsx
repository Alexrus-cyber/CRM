import { FlaskConical } from "lucide-react";
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
        subtitle="Тестовый harness: модель, тип раздумий, RAG-папка, файлы и картинки"
        action={
          <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-500">
            <FlaskConical size={12} />
            Тестовый harness
          </Badge>
        }
      />
      <LazyAiChat userName={user.name} />
    </>
  );
}
