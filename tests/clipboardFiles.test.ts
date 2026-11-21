import { describe, expect, it } from "vitest";
import { extractClipboardFiles, hasTransferFiles } from "@/lib/clipboardFiles";

describe("clipboardFiles", () => {
  it("извлекает картинки из items и переименовывает стандартный image.png", () => {
    const img = new File(["pngbytes"], "image.png", { type: "image/png" });
    const dt = {
      items: [{ kind: "file", getAsFile: () => img }],
      files: [],
      getData: () => "",
    } as unknown as DataTransfer;

    const { files, hasPlainText } = extractClipboardFiles(dt);
    expect(hasPlainText).toBe(false);
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/^clipboard-\d+-1\.png$/);
  });

  it("берет файлы из clipboardData.files если items пуст и учитывает plain text", () => {
    const doc = new File(["hello"], "report.txt", { type: "text/plain" });
    const dt = {
      items: [],
      files: [doc],
      getData: (type: string) => (type === "text/plain" ? "скопированный текст" : ""),
    } as unknown as DataTransfer;

    const { files, hasPlainText } = extractClipboardFiles(dt);
    expect(hasPlainText).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("report.txt");
  });

  it("определяет переносимые файлы по types и files", () => {
    expect(hasTransferFiles(null)).toBe(false);
    expect(hasTransferFiles({ types: ["text/plain"], files: [] } as unknown as DataTransfer)).toBe(false);
    expect(hasTransferFiles({ types: ["Files"], files: [] } as unknown as DataTransfer)).toBe(true);
  });
});
