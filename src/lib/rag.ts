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

/* --------------------------- полное окружение ---------------------------- */

/**
 * Страховка для режима «вся база»: больше этого в один запрос не отправляем,
 * иначе локальный сервер можно случайно уронить гигантским промптом.
 * Реальный ограничитель — контекст модели (`contextLimit` в настройках).
 */
export const RAG_FULL_MAX_CHARS = 2_000_000;

/** Сколько символов текста в среднем приходится на токен (кириллица ≈ 2,5). */
export const RAG_CHARS_PER_TOKEN = 2.4;

/**
 * Сколько символов RAG влезает в контекст модели.
 *
 * `contextLimit ≤ 0` — пользователь не следит за контекстом, отдаём страховочный
 * потолок. Иначе считаем свободное место: контекст минус уже занятое историей и
 * минус резерв под ответ.
 */
export function ragBudgetChars(contextLimit: number, usedTokens: number, reserveTokens = 0): number {
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) return RAG_FULL_MAX_CHARS;
  const free = contextLimit - Math.max(0, usedTokens) - Math.max(0, reserveTokens);
  return Math.min(RAG_FULL_MAX_CHARS, Math.max(0, Math.floor(free * RAG_CHARS_PER_TOKEN)));
}

export type FullRagContext = {
  text: string;
  /** Сколько символов контекста получилось. */
  chars: number;
  /** Сколько фрагментов вошло. */
  used: number;
  /** Что-то не влезло в бюджет. */
  truncated: boolean;
};

/**
 * Собирает контекст из ВСЕХ фрагментов папки (в переданном порядке), группируя
 * соседние фрагменты одного файла под общим заголовком. Если бюджет кончился —
 * остаток отбрасывается и `truncated = true`, чтобы интерфейс честно сказал,
 * сколько фрагментов вошло.
 */
export function formatFullRagContext(chunks: RagHit[], maxChars = RAG_FULL_MAX_CHARS): FullRagContext {
  const limit = Math.max(0, Math.floor(maxChars));
  const runs: Array<{ path: string; texts: string[] }> = [];
  for (const chunk of chunks) {
    const last = runs[runs.length - 1];
    if (last && last.path === chunk.path) last.texts.push(chunk.text);
    else runs.push({ path: chunk.path, texts: [chunk.text] });
  }

  const parts: string[] = [];
  let chars = 0;
  let used = 0;
  let truncated = false;

  for (const run of runs) {
    if (truncated) break;
    const header = `Файл: ${run.path}\n`;
    const separator = parts.length > 0 ? 2 : 0;
    const body: string[] = [];
    let runChars = 0;
    for (const text of run.texts) {
      const cost = (body.length > 0 ? 1 : 0) + text.length;
      if (chars + separator + header.length + runChars + cost > limit) {
        truncated = true;
        break;
      }
      body.push(text);
      runChars += cost;
      used += 1;
    }
    if (body.length > 0) {
      parts.push(`${header}${body.join("\n")}`);
      chars += separator + header.length + runChars;
    }
  }

  if (used < chunks.length) truncated = true;
  return { text: parts.join("\n\n---\n\n"), chars, used, truncated };
}
