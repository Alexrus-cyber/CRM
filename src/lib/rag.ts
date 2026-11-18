/**
 * Мини-RAG для блока «Чат с ИИ».
 *
 * Индекс живёт в базе (таблицы `ai_rag_folders` / `ai_rag_chunks` / `ai_rag_terms`),
 * поэтому папка может быть любого размера и переживает перезагрузку страницы.
 * Здесь — только изоморфные помощники: нарезка текста на фрагменты, разбор слов
 * на усечённые основы и сборка контекста для промпта.
 *
 * Зачем свой поиск: у локальных моделей нет векторной базы, а тащить embeddings
 * в тестовый блок дорого. Для папки с документацией/кодом хватает BM25-подобного
 * подсчёта по словам с усечёнными основами — он же терпим к русской морфологии
 * («смета»/«сметы»/«сметой» → одна основа).
 */

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;

const STOP_WORDS = new Set([
  "для", "или", "если", "что", "чтобы", "как", "так", "это", "при", "над", "под", "без", "про",
  "все", "всё", "его", "она", "они", "оно", "также", "только", "есть", "быть", "был", "была",
  "были", "было", "the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
  "you", "your", "not", "but", "have", "has", "had", "какие", "какой", "какая", "чем", "где",
]);

/** Разбиение на перекрывающиеся фрагменты по границам строк, если получается. */
export function splitIntoChunks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\t/g, "  ");
  if (normalized.length <= CHUNK_SIZE) return normalized.trim() ? [normalized.trim()] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + CHUNK_SIZE, normalized.length);
    if (end < normalized.length) {
      const lineBreak = normalized.lastIndexOf("\n", end);
      const space = normalized.lastIndexOf(" ", end);
      if (lineBreak > start + CHUNK_SIZE * 0.6) end = lineBreak;
      else if (space > start + CHUNK_SIZE * 0.6) end = space;
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= normalized.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

/** Основа слова: нижний регистр, ё→е, первые 6 символов — грубо, но для поиска хватает. */
function stem(word: string): string {
  const clean = word.replace(/ё/g, "е");
  return clean.length > 6 ? clean.slice(0, 6) : clean;
}

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const result: string[] = [];
  for (const word of words) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    result.push(stem(word));
  }
  return result;
}

export type RagHit = { path: string; text: string; score: number };

/** Короткий предпросмотр фрагмента: вокруг первого совпадения, если оно есть. */
export function snippet(text: string, query: string, length = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const needle = query.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const at = needle ? flat.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return flat.slice(0, length) + (flat.length > length ? "…" : "");
  const from = Math.max(at - Math.floor(length / 3), 0);
  const piece = flat.slice(from, from + length);
  return (from > 0 ? "…" : "") + piece + (from + length < flat.length ? "…" : "");
}

/** Собирает текст документа из папки: путь + содержимое, чтобы модель видела источник. */
export function formatRagContext(hits: RagHit[], maxChars = 12_000): string {
  if (hits.length === 0) return "";
  const parts: string[] = [];
  let budget = maxChars;
  for (const hit of hits) {
    const header = `Файл: ${hit.path}\n`;
    const body = hit.text.slice(0, Math.max(budget - header.length, 0));
    if (!body.trim()) break;
    parts.push(`${header}${body}`);
    budget -= header.length + body.length + 2;
    if (budget <= 0) break;
  }
  return parts.join("\n\n---\n\n");
}
