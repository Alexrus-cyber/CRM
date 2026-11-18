/**
 * Мини-RAG для блока «Чат с ИИ»: индекс строится в браузере по выбранной папке,
 * ничего не уходит на сервер, кроме уже отобранных фрагментов в промпте.
 *
 * Зачем свой поиск: у локальных моделей нет векторной базы, а тащить embeddings
 * в тестовый блок дорого. Для папки с документацией/кодом хватает BM25-подобного
 * подсчёта по словам с усечёнными основами — он же терпим к русской морфологии
 * («смета»/«сметы»/«сметой» → одна основа).
 */

export type RagSourceFile = { path: string; size: number };

export type RagChunk = {
  id: number;
  path: string;
  text: string;
  /** Частоты основ в фрагменте. */
  terms: Record<string, number>;
};

export type RagIndex = {
  files: RagSourceFile[];
  skipped: RagSourceFile[];
  chunks: RagChunk[];
  /** Обратная частота: сколько фрагментов содержат основу. */
  df: Record<string, number>;
  chars: number;
  builtAt: number;
};

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;
export const RAG_MAX_FILES = 400;
export const RAG_MAX_FILE_BYTES = 512 * 1024;
export const RAG_MAX_TOTAL_CHARS = 8_000_000;

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

function termFrequencies(text: string): Record<string, number> {
  const terms: Record<string, number> = {};
  for (const token of tokenize(text)) terms[token] = (terms[token] ?? 0) + 1;
  return terms;
}

export function buildRagIndex(entries: Array<{ path: string; text: string }>): RagIndex {
  const files: RagSourceFile[] = [];
  const chunks: RagChunk[] = [];
  const df: Record<string, number> = {};
  let chars = 0;
  let id = 0;

  for (const entry of entries) {
    files.push({ path: entry.path, size: entry.text.length });
    chars += entry.text.length;
    for (const piece of splitIntoChunks(entry.text)) {
      const terms = termFrequencies(`${entry.path}\n${piece}`);
      for (const term of Object.keys(terms)) df[term] = (df[term] ?? 0) + 1;
      chunks.push({ id: id++, path: entry.path, text: piece, terms });
    }
  }

  return { files, skipped: [], chunks, df, chars, builtAt: Date.now() };
}

export type RagHit = { path: string; text: string; score: number };

/** BM25-подобный поиск: частоты основ × редкость, с нормировкой на длину фрагмента. */
export function searchRag(index: RagIndex, query: string, limit = 6): RagHit[] {
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0 || index.chunks.length === 0) return [];
  const total = index.chunks.length;
  const scored: RagHit[] = [];

  for (const chunk of index.chunks) {
    let score = 0;
    const length = Math.max(Object.values(chunk.terms).reduce((sum, value) => sum + value, 0), 1);
    for (const term of queryTerms) {
      const tf = chunk.terms[term];
      if (!tf) continue;
      const idf = Math.log(1 + total / (index.df[term] ?? 1));
      score += (Math.min(tf, 4) * idf) / Math.sqrt(length);
    }
    if (score > 0) scored.push({ path: chunk.path, text: chunk.text, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit));
}

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

/** Файлы, которые имеет смысл индексировать как текст. */
export function isIndexableFile(name: string, type: string, size: number): boolean {
  if (size > RAG_MAX_FILE_BYTES) return false;
  if (/^image\/|^video\/|^audio\//i.test(type)) return false;
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|zip|gz|tar|rar|7z|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|avi|mkv|db|sqlite|bin|class|jar)$/i.test(name)) {
    return false;
  }
  return /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|x-sh|x-ndjson|sql|x-toml|x-httpd-php|x-python))|^inode\/x-empty/i.test(type)
    || /\.(txt|md|markdown|rst|json|jsonl|csv|tsv|log|ya?ml|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|java|kt|c|h|cpp|hpp|cs|php|rs|swift|sh|bash|zsh|sql|ini|conf|cfg|toml|env|gitignore|dockerfile|makefile|gradle|properties|tf|hcl|lua|pl|r|scala|dart|proto|graphql|gql)$/i.test(name);
}

/** Собирает текст документа из папки: путь + содержимое, чтобы модель видела источник. */
export function formatRagContext(hits: RagHit[], maxChars = 6000): string {
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
