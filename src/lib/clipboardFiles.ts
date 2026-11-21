/**
 * Помощники для вставки картинок/файлов из буфера обмена (Ctrl+V)
 * и перетаскивания (drag-and-drop) в поле ввода чатов ИИ и Агента.
 */

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

function renameClipboardImage(file: File, index: number): File {
  const rawName = (file.name || "").trim();
  const generic = !rawName || rawName === "image.png" || rawName === "image.jpg" || rawName === "blob";
  if (!generic) return file;
  const ext = MIME_EXT[(file.type || "").toLowerCase()] ?? "png";
  const nextName = `clipboard-${Date.now()}-${index + 1}.${ext}`;
  try {
    return new File([file], nextName, { type: file.type || `image/${ext}` });
  } catch {
    return file;
  }
}

export function extractClipboardFiles(
  clipboardData: DataTransfer | null | undefined,
): { files: File[]; hasPlainText: boolean } {
  if (!clipboardData) return { files: [], hasPlainText: false };

  const collected: File[] = [];
  const items = Array.from(clipboardData.items ?? []);
  for (const item of items) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) collected.push(f);
    }
  }

  if (collected.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
    collected.push(...Array.from(clipboardData.files));
  }

  const files = collected.map((file, idx) =>
    file.type.startsWith("image/") ? renameClipboardImage(file, idx) : file,
  );
  const plainText = clipboardData.getData?.("text/plain") ?? "";
  return { files, hasPlainText: plainText.length > 0 };
}

export function hasTransferFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) return true;
  const types = Array.from(dataTransfer.types ?? []);
  return types.includes("Files");
}
