import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const CIPHER_PREFIX = "enc1:";

const globalForCrypto = globalThis as typeof globalThis & {
  __crmDevCipherSecret?: string;
};

/**
 * Единый источник секрета шифрования (AES-256-GCM) для токенов и API-ключей в БД.
 *
 * В production требует явный `CRM_ENCRYPTION_KEY` (или `AUTH_SECRET` / `CRM_GITHUB_SECRET`).
 * В локальной разработке / тестах без заданного env генерирует стойкий случайный ключ
 * на диск (`data/.crm-secret.key`) или в память процесса, без захардкоженных ключей в коде.
 */
function resolveSecretMaterial(): string {
  const fromEnv =
    process.env.CRM_ENCRYPTION_KEY?.trim() ||
    process.env.CRM_SECRET?.trim() ||
    process.env.CRM_GITHUB_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim();
  if (fromEnv) return fromEnv;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Не задан секрет шифрования: укажите CRM_ENCRYPTION_KEY, CRM_SECRET или AUTH_SECRET в переменных окружения.",
    );
  }

  if (globalForCrypto.__crmDevCipherSecret) {
    return globalForCrypto.__crmDevCipherSecret;
  }

  // В тестах Vitest используем эфемерный случайный ключ в памяти процесса,
  // чтобы не создавать лишних файлов в рабочем каталоге; в dev сохраняем в data/.crm-secret.key.
  if (process.env.VITEST) {
    const generated = randomBytes(32).toString("hex");
    globalForCrypto.__crmDevCipherSecret = generated;
    return generated;
  }

  const keyFile = path.join(process.cwd(), "data", ".crm-secret.key");
  try {
    if (fs.existsSync(keyFile)) {
      const existing = fs.readFileSync(keyFile, "utf8").trim();
      if (existing.length >= 32) {
        globalForCrypto.__crmDevCipherSecret = existing;
        return existing;
      }
    }
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    const generated = randomBytes(32).toString("hex");
    fs.writeFileSync(keyFile, `${generated}\n`, { mode: 0o600 });
    globalForCrypto.__crmDevCipherSecret = generated;
    return generated;
  } catch {
    const generated = randomBytes(32).toString("hex");
    globalForCrypto.__crmDevCipherSecret = generated;
    return generated;
  }
}

export function getCipherKey(): Buffer {
  return createHash("sha256").update(resolveSecretMaterial(), "utf8").digest();
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(CIPHER_PREFIX);
}

export function encryptSecret(rawValue: string): string {
  const clean = rawValue.trim();
  if (!clean) return "";
  const key = getCipherKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(clean, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CIPHER_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const value = String(stored || "").trim();
  if (!value) return "";
  if (!value.startsWith(CIPHER_PREFIX)) {
    // Совместимость со старыми незашифрованными значениями до их пересохранения.
    return value;
  }
  const parts = value.split(":");
  if (parts.length !== 4) return "";
  try {
    const [, ivHex, tagHex, encHex] = parts;
    const key = getCipherKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const out = Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
    return out.toString("utf8");
  } catch {
    return "";
  }
}

export function maskSecret(secret: string): string {
  const clean = secret.trim();
  if (!clean) return "";
  if (clean.length <= 8) return `${clean.slice(0, 2)}••••`;
  if (clean.length <= 10) return `${clean.slice(0, 2)}••••${clean.slice(-2)}`;
  return `${clean.slice(0, 6)}••••${clean.slice(-4)}`;
}

export function hashOpaqueToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}
