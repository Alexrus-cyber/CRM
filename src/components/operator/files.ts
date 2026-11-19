"use client";

import { extractFile, imageToDataUrl } from "@/lib/fileExtract";
import { isImageMime } from "@/lib/ai";

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
  /** Картинка как data-URL: vision-модель увидит её, а не только имя. */
  image?: string;
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

/**
 * Читает файл один раз: текст для модели и base64 для задания.
 *
 * Ошибка распознавания не должна мешать прикрепить файл: если разбор не
 * удался, вложение всё равно добавляется — с пометкой «содержимое не
 * читается». Так «прикрепить» работает для любого типа и размера в пределах
 * лимита, а не только для тех, что умеет `extractFile`.
 */
export async function readOperatorFile(file: File): Promise<OperatorAttachment> {
  if (file.size > OPERATOR_MAX_FILE_BYTES) {
    throw new Error(`«${file.name}» больше 10 МБ — такие файлы бот не принимает`);
  }
  const data = await readBase64(file);
  let text = "";
  let note = "содержимое не читается";
  let image: string | undefined;
  try {
    if (isImageMime(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
      const compressed = await imageToDataUrl(file);
      image = compressed.dataUrl;
      note = `изображение · ${compressed.note} · vision-модель увидит картинку`;
    } else {
      const extracted = await extractFile(file);
      text = extracted.text;
      note = extracted.note;
    }
  } catch (error) {
    note = `не удалось распознать: ${error instanceof Error ? error.message : "неизвестная ошибка"}`.slice(0, 160);
  }
  return {
    name: file.name || "файл",
    mime: file.type || "application/octet-stream",
    size: file.size,
    text,
    note,
    data,
    ...(image ? { image } : {}),
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
