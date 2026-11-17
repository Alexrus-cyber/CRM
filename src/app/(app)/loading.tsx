import { PageSkeleton } from "@/components/skeletons";

/**
 * Пока серверный компонент страницы собирает данные, пользователь сразу видит
 * каркас (шапка + плитки + строки). На медленных ПК и при медленной сети это
 * убирает «залипший» экран при переходах между разделами.
 */
export default function AppLoading() {
  return <PageSkeleton />;
}
