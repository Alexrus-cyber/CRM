"use client";

import { extractFile } from "@/lib/fileExtract";

/** Вложение задания оператора: текст для модели + байты для бота. */
export type OperatorAttachment = {
  name: string;
  mime: string;
  size: number;
  /** Распознанный текст — уходит в планировщик. */
  text: string;
  /** Пометка распознавания: «PDF → текст», «бинарный формат» и т. п. */
  note: string;
  /** base64 без префикса — для отправки вместе с заданием боту. */
  data: string;
};

/** Ограничения совпадают с сервером: 5 файлов по 10 МБ. */
export const OPERATOR_MAX_FILES = 5;
export const OPERATOR_MAX_FILE_BYTES = 10 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} КБ`;
  return `${Math.round(bytes / 104857.6) / 10} МБ`;
}

/** Читает файл один раз: текст для модели и base64 для задания. */
export async function readOperatorFile(file: File): Promise<OperatorAttachment> {
  if (file.size > OPERATOR_MAX_FILE_BYTES) {
    throw new Error(`«${file.name}» больше 10 МБ — такие файлы бот не принимает`);
  }
  const [extracted, data] = await Promise.all([extractFile(file), readBase64(file)]);
  return {
    name: file.name || "файл",
    mime: file.type || "application/octet-stream",
    size: file.size,
    text: extracted.text,
    note: extracted.note,
    data,
  };
}

/** Пакетная загрузка с проверкой лимита на количество. */
export async function readOperatorFiles(current: OperatorAttachment[], incoming: FileList | File[]) {
  const list = Array.from(incoming);
  const room = OPERATOR_MAX_FILES - current.length;
  const accepted = list.slice(0, Math.max(0, room));
  const skipped = list.slice(accepted.length);
  const read = await Promise.all(accepted.map((file) => readOperatorFile(file).catch((error: Error) => error)));
  const files: OperatorAttachment[] = [];
  const errors: string[] = [];
  for (const item of read) {
    if (item instanceof Error) errors.push(item.message);
    else files.push(item);
  }
  if (skipped.length > 0) {
    errors.push(`Можно приложить не больше ${OPERATOR_MAX_FILES} файлов — остальные пропущены`);
  }
  return { files, errors };
}
