import { sql } from "drizzle-orm";
import { getDialect, nowIso, q, q1, toIso, toNum } from "../dialect";
import { tokenize } from "@/lib/rag";
import { aiMonthKey, type Raw } from "./shared";

export { aiMonthKey };

export type AiChatRow = {
  id: number;
  userId: number;
  title: string;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensTotal: number;
  messagesCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AiChatMessageRow = {
  id: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  attachments: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
};

export type AiUsageTotals = { prompt: number; completion: number; total: number; events: number };
export type AiQuotaOverrideRow = { userId: number; month: string; monthlyLimit: number };

export type RagFolderRow = {
  id: number;
  userId: number;
  name: string;
  filesCount: number;
  chunksCount: number;
  chars: number;
  createdAt: string;
  updatedAt: string;
};

export type RagSearchHit = { id: number; path: string; text: string; score: number };
export type RagChunkRow = { id: number; path: string; text: string };

function mapAiChat(row: Raw): AiChatRow {
  const tokensPrompt = toNum(row.tokens_prompt);
  const tokensCompletion = toNum(row.tokens_completion);
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    title: String(row.title ?? "Новый чат"),
    tokensPrompt,
    tokensCompletion,
    tokensTotal: tokensPrompt + tokensCompletion,
    messagesCount: toNum(row.messages_count),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

export async function listAiChats(userId: number, limit = 50): Promise<AiChatRow[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const rows = await q(sql`select c.id, c.user_id, c.title, c.tokens_prompt, c.tokens_completion,
      c.created_at, c.updated_at,
      (select count(*) from ai_chat_messages m where m.chat_id = c.id) as messages_count
    from ai_chats c where c.user_id = ${userId} order by c.updated_at desc limit ${safeLimit}`);
  return rows.map(mapAiChat);
}

export async function getAiChat(userId: number, id: number): Promise<AiChatRow | null> {
  const row = await q1(sql`select c.id, c.user_id, c.title, c.tokens_prompt, c.tokens_completion,
      c.created_at, c.updated_at,
      (select count(*) from ai_chat_messages m where m.chat_id = c.id) as messages_count
    from ai_chats c where c.id = ${id} and c.user_id = ${userId} limit 1`);
  return row ? mapAiChat(row) : null;
}

export async function createAiChat(userId: number, title = "Новый чат"): Promise<AiChatRow> {
  const now = nowIso();
  const row = await q1(sql`insert into ai_chats (user_id, title, tokens_prompt, tokens_completion, created_at, updated_at)
    values (${userId}, ${title}, 0, 0, ${now}, ${now}) returning id`);
  const id = toNum(row?.id);
  return {
    id,
    userId,
    title,
    tokensPrompt: 0,
    tokensCompletion: 0,
    tokensTotal: 0,
    messagesCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function renameAiChat(userId: number, id: number, title: string): Promise<boolean> {
  const row = await q(sql`update ai_chats set title = ${title.slice(0, 120)}, updated_at = ${nowIso()}
    where id = ${id} and user_id = ${userId} returning id`);
  return row.length > 0;
}

export async function deleteAiChat(userId: number, id: number): Promise<boolean> {
  const chat = await getAiChat(userId, id);
  if (!chat) return false;
  await q(sql`delete from ai_chat_messages where chat_id = ${id}`);
  await q(sql`delete from ai_chats where id = ${id} and user_id = ${userId}`);
  return true;
}

export async function listAiChatMessages(chatId: number): Promise<AiChatMessageRow[]> {
  const rows = await q(sql`select id, role, content, reasoning, attachments, tokens, prompt_tokens, completion_tokens, created_at
    from ai_chat_messages where chat_id = ${chatId} order by id asc limit 400`);
  return rows.map((row) => ({
    id: toNum(row.id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content ?? ""),
    reasoning: String(row.reasoning ?? ""),
    attachments: String(row.attachments ?? "[]"),
    tokens: toNum(row.tokens),
    promptTokens: toNum(row.prompt_tokens),
    completionTokens: toNum(row.completion_tokens),
    createdAt: toIso(row.created_at) ?? nowIso(),
  }));
}

export async function insertAiChatMessage(input: {
  chatId: number;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: string;
  tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}): Promise<number> {
  const row = await q1(sql`insert into ai_chat_messages (chat_id, role, content, reasoning, attachments, tokens, prompt_tokens, completion_tokens, created_at)
    values (${input.chatId}, ${input.role}, ${input.content}, ${input.reasoning ?? ""}, ${input.attachments ?? "[]"}, ${input.tokens ?? 0}, ${input.promptTokens ?? 0}, ${input.completionTokens ?? 0}, ${nowIso()})
    returning id`);
  return toNum(row?.id);
}

export async function getAiUsage(userId: number, month = aiMonthKey()): Promise<{ all: AiUsageTotals; month: AiUsageTotals }> {
  const all = await q1(sql`select coalesce(sum(prompt_tokens), 0) as prompt, coalesce(sum(completion_tokens), 0) as completion,
      coalesce(sum(total_tokens), 0) as total, count(*) as events
    from ai_usage_events where user_id = ${userId}`);
  const monthRow = await q1(sql`select coalesce(sum(prompt_tokens), 0) as prompt, coalesce(sum(completion_tokens), 0) as completion,
      coalesce(sum(total_tokens), 0) as total, count(*) as events
    from ai_usage_events where user_id = ${userId} and month = ${month}`);
  const map = (row: Raw | null): AiUsageTotals => ({
    prompt: toNum(row?.prompt),
    completion: toNum(row?.completion),
    total: toNum(row?.total),
    events: toNum(row?.events),
  });
  return { all: map(all), month: map(monthRow) };
}

export async function recordAiUsage(input: {
  userId: number;
  chatId: number;
  prompt: number;
  completion: number;
}): Promise<{ chat: AiChatRow | null; all: AiUsageTotals; month: AiUsageTotals }> {
  const prompt = Math.max(0, Math.round(input.prompt));
  const completion = Math.max(0, Math.round(input.completion));
  const total = prompt + completion;
  const month = aiMonthKey();
  await q(sql`insert into ai_usage_events (user_id, chat_id, prompt_tokens, completion_tokens, total_tokens, month, created_at)
    values (${input.userId}, ${input.chatId}, ${prompt}, ${completion}, ${total}, ${month}, ${nowIso()})`);
  if (input.chatId > 0) {
    await q(sql`update ai_chats set tokens_prompt = tokens_prompt + ${prompt}, tokens_completion = tokens_completion + ${completion},
      updated_at = ${nowIso()} where id = ${input.chatId} and user_id = ${input.userId}`);
  }
  const usage = await getAiUsage(input.userId, month);
  const chat = input.chatId > 0 ? await getAiChat(input.userId, input.chatId) : null;
  return { chat, all: usage.all, month: usage.month };
}

export async function getAiQuotaOverride(userId: number, month = aiMonthKey()): Promise<AiQuotaOverrideRow | null> {
  const row = await q1(sql`select user_id, month, monthly_limit from ai_quota_overrides
    where user_id = ${userId} and month = ${month} limit 1`);
  if (!row) return null;
  return { userId: toNum(row.user_id), month: String(row.month), monthlyLimit: toNum(row.monthly_limit) };
}

export async function setAiQuotaOverride(userId: number, monthlyLimit: number, createdBy: number, month = aiMonthKey()): Promise<void> {
  const now = nowIso();
  const existing = await getAiQuotaOverride(userId, month);
  if (existing) {
    await q(sql`update ai_quota_overrides set monthly_limit = ${Math.max(0, Math.round(monthlyLimit))}
      where user_id = ${userId} and month = ${month}`);
    return;
  }
  await q(sql`insert into ai_quota_overrides (user_id, month, monthly_limit, created_by, created_at)
    values (${userId}, ${month}, ${Math.max(0, Math.round(monthlyLimit))}, ${createdBy}, ${now})`);
}

export async function clearAiQuotaOverride(userId: number, month = aiMonthKey()): Promise<void> {
  await q(sql`delete from ai_quota_overrides where user_id = ${userId} and month = ${month}`);
}

export async function listAiUsageByUser(month = aiMonthKey()): Promise<Array<{ userId: number; total: number }>> {
  const rows = await q(sql`select user_id, coalesce(sum(total_tokens), 0) as total from ai_usage_events
    where month = ${month} group by user_id`);
  return rows.map((row) => ({ userId: toNum(row.user_id), total: toNum(row.total) }));
}

/* ------------------------------- RAG для ИИ ------------------------ */

function mapRagFolder(row: Raw): RagFolderRow {
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    name: String(row.name ?? ""),
    filesCount: toNum(row.files_count),
    chunksCount: toNum(row.chunks_count),
    chars: toNum(row.chars),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

export async function listRagFolders(userId: number): Promise<RagFolderRow[]> {
  const rows = await q(sql`select id, user_id, name, files_count, chunks_count, chars, created_at, updated_at
    from ai_rag_folders where user_id = ${userId} order by updated_at desc`);
  return rows.map(mapRagFolder);
}

export async function getRagFolder(userId: number, id: number): Promise<RagFolderRow | null> {
  const row = await q1(sql`select id, user_id, name, files_count, chunks_count, chars, created_at, updated_at
    from ai_rag_folders where id = ${id} and user_id = ${userId} limit 1`);
  return row ? mapRagFolder(row) : null;
}

export async function createRagFolder(userId: number, name: string): Promise<RagFolderRow> {
  const now = nowIso();
  const row = await q1(sql`insert into ai_rag_folders (user_id, name, files_count, chunks_count, chars, created_at, updated_at)
    values (${userId}, ${name}, 0, 0, 0, ${now}, ${now}) returning id, user_id, name, files_count, chunks_count, chars, created_at, updated_at`);
  return mapRagFolder(row ?? { id: 0, user_id: userId, name, files_count: 0, chunks_count: 0, chars: 0, created_at: now, updated_at: now });
}

export async function deleteRagFolder(userId: number, id: number): Promise<boolean> {
  const folder = await getRagFolder(userId, id);
  if (!folder) return false;
  await q(sql`delete from ai_rag_terms where folder_id = ${id}`);
  await q(sql`delete from ai_rag_chunks where folder_id = ${id}`);
  await q(sql`delete from ai_rag_folders where id = ${id} and user_id = ${userId}`);
  return true;
}

export function ragTermFrequencies(text: string): Record<string, number> {
  const terms: Record<string, number> = {};
  for (const token of tokenize(text)) terms[token] = Math.min((terms[token] ?? 0) + 1, 50);
  return terms;
}

export async function addRagChunks(
  folderId: number,
  items: Array<{ path: string; chunks: string[] }>,
): Promise<{ chunks: number; files: number; chars: number }> {
  let added = 0;
  for (const item of items) {
    for (let index = 0; index < item.chunks.length; index += 1) {
      const text = item.chunks[index];
      if (!text.trim()) continue;
      const row = await q1<{ id: number }>(sql`insert into ai_rag_chunks (folder_id, path, chunk_index, text, created_at)
        values (${folderId}, ${item.path}, ${index}, ${text}, ${nowIso()}) returning id`);
      const chunkId = toNum(row?.id);
      const terms = ragTermFrequencies(`${item.path}\n${text}`);
      const values = Object.entries(terms).map(([term, tf]) => sql`(${folderId}, ${term}, ${chunkId}, ${tf})`);
      if (values.length > 0) {
        await q(sql`insert into ai_rag_terms (folder_id, term, chunk_id, tf) values ${sql.join(values, sql`, `)}`);
      }
      added += 1;
    }
  }

  const stats = await q1(sql`select count(*) as chunks, count(distinct path) as files, coalesce(sum(length(text)), 0) as chars
    from ai_rag_chunks where folder_id = ${folderId}`);
  const chunks = toNum(stats?.chunks);
  const files = toNum(stats?.files);
  const chars = toNum(stats?.chars);
  await q(sql`update ai_rag_folders set chunks_count = ${chunks}, files_count = ${files}, chars = ${chars}, updated_at = ${nowIso()}
    where id = ${folderId}`);
  return { chunks: added, files, chars };
}

export async function listRagChunks(folderId: number, limit = 0): Promise<RagChunkRow[]> {
  const safeLimit = Math.floor(Number(limit));
  const rows =
    safeLimit > 0
      ? await q(sql`select id, path, text from ai_rag_chunks
          where folder_id = ${folderId} order by path, chunk_index, id limit ${safeLimit}`)
      : await q(sql`select id, path, text from ai_rag_chunks
          where folder_id = ${folderId} order by path, chunk_index, id`);
  return rows.map((row) => ({ id: toNum(row.id), path: String(row.path), text: String(row.text) }));
}

async function searchRagViaFts(folderId: number, queryText: string, limit: number): Promise<RagSearchHit[] | null> {
  const terms = Array.from(new Set(tokenize(queryText))).slice(0, 16);
  if (terms.length === 0) return [];
  const dialect = await getDialect();
  try {
    if (dialect === "sqlite") {
      const matchExpr = terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
      const rows = await q(sql`
        select c.id, c.path, c.text, (-bm25(ai_rag_chunks_fts)) as score
        from ai_rag_chunks_fts
        join ai_rag_chunks c on c.id = ai_rag_chunks_fts.rowid
        where c.folder_id = ${folderId} and ai_rag_chunks_fts match ${matchExpr}
        order by bm25(ai_rag_chunks_fts) asc
        limit ${limit}`);
      return rows.map((r) => ({
        id: toNum(r.id),
        path: String(r.path ?? ""),
        text: String(r.text ?? ""),
        score: Math.max(0.01, toNum(r.score)),
      }));
    }

    const cleanQuery = queryText.replace(/[^\p{L}\p{N}\s]+/gu, " ").trim();
    if (!cleanQuery) return [];
    const rows = await q(sql`
      select c.id, c.path, c.text,
             (ts_rank_cd(c.search_vector, websearch_to_tsquery('russian', ${cleanQuery}))
              + ts_rank_cd(c.search_vector, websearch_to_tsquery('english', ${cleanQuery}))) as score
      from ai_rag_chunks c
      where c.folder_id = ${folderId}
        and (
          c.search_vector @@ websearch_to_tsquery('russian', ${cleanQuery})
          or c.search_vector @@ websearch_to_tsquery('english', ${cleanQuery})
        )
      order by score desc
      limit ${limit}`);
    return rows.map((r) => ({
      id: toNum(r.id),
      path: String(r.path ?? ""),
      text: String(r.text ?? ""),
      score: Math.max(0.01, toNum(r.score)),
    }));
  } catch {
    return null;
  }
}

/**
 * Поиск по папке RAG: использует FTS5 (SQLite) / GIN tsvector (PostgreSQL)
 * и дополняется обратным индексом `ai_rag_terms` для коротких словоформ.
 */
export async function searchRagChunks(folderId: number, queryText: string, limit = 6): Promise<RagSearchHit[]> {
  const safeLimit = Math.max(1, limit);
  const ftsHits = await searchRagViaFts(folderId, queryText, safeLimit);
  if (ftsHits && ftsHits.length >= safeLimit) {
    return ftsHits;
  }

  const terms = Array.from(new Set(tokenize(queryText))).slice(0, 24);
  if (terms.length === 0) return ftsHits ?? [];
  const termList = sql.join(terms.map((term) => sql`${term}`), sql`, `);

  const totals = await q1(sql`select chunks_count as chunks from ai_rag_folders where id = ${folderId}`);
  const totalChunks = Math.max(toNum(totals?.chunks), 1);

  const dfRows = await q(sql`select term, count(*) as df from ai_rag_terms
    where folder_id = ${folderId} and term in (${termList}) group by term`);
  const df = new Map<string, number>();
  for (const row of dfRows) df.set(String(row.term), toNum(row.df));

  const scored = new Map<number, { id: number; path: string; text: string; score: number }>();
  for (const hit of ftsHits ?? []) {
    scored.set(hit.id, { ...hit });
  }

  if (df.size > 0) {
    const rows = await q(sql`select t.term, t.tf, c.id as chunk_id, c.path, c.text, length(c.text) as len
      from ai_rag_terms t join ai_rag_chunks c on c.id = t.chunk_id
      where t.folder_id = ${folderId} and t.term in (${termList})
      limit 4000`);

    for (const row of rows) {
      const chunkId = toNum(row.chunk_id);
      const term = String(row.term);
      const tf = toNum(row.tf);
      const len = Math.max(toNum(row.len), 1);
      const idf = Math.log(1 + totalChunks / Math.max(df.get(term) ?? 1, 1));
      const weight = (Math.min(tf, 4) * idf) / Math.sqrt(len / 400);
      const current = scored.get(chunkId);
      if (current) {
        current.score += weight;
      } else {
        scored.set(chunkId, {
          id: chunkId,
          path: String(row.path),
          text: String(row.text),
          score: weight,
        });
      }
    }
  }

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);
}
