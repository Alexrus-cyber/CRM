import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type StorageCategory = "chat" | "agent" | "screens";

/**
 * Корень файлового хранилища.
 *
 * Приоритет:
 *   1. `CRM_STORAGE_DIR` (для Docker-тома или продакшена);
 *   2. `<папка SQLITE_PATH>/storage` (удобно для локального запуска и изолированных тестов);
 *   3. `<cwd>/data/storage`.
 */
export function getStorageRoot(): string {
  const explicit = process.env.CRM_STORAGE_DIR?.trim();
  if (explicit) return path.resolve(explicit);

  const sqlitePath = process.env.SQLITE_PATH?.trim();
  if (sqlitePath) {
    return path.resolve(path.dirname(path.resolve(sqlitePath)), "storage");
  }

  return path.resolve(process.cwd(), "data", "storage");
}

function safeExtension(nameHint: string): string {
  const ext = path.extname(nameHint || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (ext.length >= 2 && ext.length <= 10) return ext;
  return ".bin";
}

function resolveStorageKey(storageKey: string): string | null {
  const clean = String(storageKey || "").trim().replace(/\\/g, "/");
  if (!clean || clean.includes("..") || clean.startsWith("/") || clean.includes("\0")) {
    return null;
  }
  const root = getStorageRoot();
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return resolved;
}

export async function saveStoredFile(
  category: StorageCategory,
  bytes: Buffer,
  nameHint = "file.bin",
): Promise<string> {
  const ym = new Date().toISOString().slice(0, 7);
  const ext = safeExtension(nameHint);
  const key = `${category}/${ym}/${randomUUID()}${ext}`;
  const fullPath = resolveStorageKey(key);
  if (!fullPath) {
    throw new Error("Некорректный путь хранения файла");
  }
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, bytes);
  return key;
}

export async function saveStoredBase64(
  category: StorageCategory,
  base64Data: string,
  nameHint = "file.bin",
): Promise<{ storageKey: string; byteSize: number }> {
  const bytes = Buffer.from(base64Data, "base64");
  const storageKey = await saveStoredFile(category, bytes, nameHint);
  return { storageKey, byteSize: bytes.length };
}

export async function readStoredFile(storageKey: string): Promise<Buffer | null> {
  const fullPath = resolveStorageKey(storageKey);
  if (!fullPath) return null;
  try {
    return await fs.promises.readFile(/*turbopackIgnore: true*/ fullPath);
  } catch {
    return null;
  }
}

export async function readStoredBase64(storageKey: string): Promise<string | null> {
  const buf = await readStoredFile(storageKey);
  return buf ? buf.toString("base64") : null;
}

export async function deleteStoredFile(storageKey: string): Promise<void> {
  const fullPath = resolveStorageKey(storageKey);
  if (!fullPath) return;
  await fs.promises.unlink(fullPath).catch(() => undefined);
}
