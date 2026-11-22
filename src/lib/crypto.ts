import fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const LEGACY_CIPHER_PREFIX = "enc1:";
const CIPHER_PREFIX = "enc2:";
const DEFAULT_KEY_VERSION = "k1";

const KNOWN_WEAK_SECRETS = new Set([
  "secret",
  "changeme",
  "change-me",
  "your-secret-here",
  "default",
  "password",
  "admin",
  "test",
  "dev-secret",
  "crm-secret",
  "ci-build-ephemeral-secret",
  "00000000000000000000000000000000",
]);

const globalForCrypto = globalThis as typeof globalThis & {
  __crmDevCipherSecret?: string;
};

export function isWeakSecretMaterial(secret: string): boolean {
  const clean = secret.trim();
  if (clean.length < 32) return true;
  if (KNOWN_WEAK_SECRETS.has(clean.toLowerCase())) return true;
  if (/^(.)\1+$/.test(clean)) return true;
  const uniqueChars = new Set(clean).size;
  if (uniqueChars < 8) return true;
  return false;
}

function isNextBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/**
 * Единый источник секрета шифрования (AES-256-GCM) для токенов и API-ключей в БД.
 *
 * В production требует явный криптостойкий ключ длиной >= 32 символа
 * (`CRM_ENCRYPTION_KEY`, `CRM_SECRET`, `CRM_GITHUB_SECRET` или `AUTH_SECRET`)
 * и отвергает известные заглушки.
 */
function resolveSecretMaterial(): string {
  const fromEnv =
    process.env.CRM_ENCRYPTION_KEY?.trim() ||
    process.env.CRM_SECRET?.trim() ||
    process.env.CRM_GITHUB_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim();

  if (fromEnv) {
    if (
      process.env.NODE_ENV === "production" &&
      !isNextBuildPhase() &&
      process.env.CRM_ALLOW_WEAK_SECRET !== "1" &&
      isWeakSecretMaterial(fromEnv)
    ) {
      throw new Error(
        "Слишком слабый секрет шифрования для production: задайте случайный CRM_ENCRYPTION_KEY длиной от 32 символов.",
      );
    }
    return fromEnv;
  }

  if (process.env.NODE_ENV === "production" && !isNextBuildPhase()) {
    throw new Error(
      "Не задан секрет шифрования: укажите CRM_ENCRYPTION_KEY, CRM_SECRET или AUTH_SECRET в переменных окружения.",
    );
  }

  if (globalForCrypto.__crmDevCipherSecret) {
    return globalForCrypto.__crmDevCipherSecret;
  }

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

function getPreviousSecrets(): string[] {
  const prev = process.env.CRM_SECRET_PREVIOUS?.trim();
  if (!prev) return [];
  return prev
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function deriveLegacyKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function deriveHkdfKey(secret: string, version: string): Buffer {
  const raw = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from("crm-encryption-v2", "utf8"),
    Buffer.from(`aes-256-gcm:${version}`, "utf8"),
    32,
  );
  return Buffer.from(raw);
}

export function getCipherKey(): Buffer {
  return deriveHkdfKey(resolveSecretMaterial(), DEFAULT_KEY_VERSION);
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith(CIPHER_PREFIX) || value.startsWith(LEGACY_CIPHER_PREFIX);
}

export function encryptSecret(rawValue: string): string {
  const clean = rawValue.trim();
  if (!clean) return "";
  const version = process.env.CRM_KEY_VERSION?.trim() || DEFAULT_KEY_VERSION;
  const key = deriveHkdfKey(resolveSecretMaterial(), version);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(clean, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CIPHER_PREFIX}${version}:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function tryAesGcmDecrypt(key: Buffer, ivHex: string, tagHex: string, encHex: string): string | null {
  try {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const enc = Buffer.from(encHex, "hex");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return out.toString("utf8");
  } catch {
    return null;
  }
}

export function decryptSecret(stored: string): string {
  const value = String(stored || "").trim();
  if (!value) return "";

  const candidates = [resolveSecretMaterial(), ...getPreviousSecrets()];

  if (value.startsWith(CIPHER_PREFIX)) {
    const parts = value.split(":");
    if (parts.length !== 5) return "";
    const [, version, ivHex, tagHex, encHex] = parts;
    for (const secret of candidates) {
      const dec = tryAesGcmDecrypt(deriveHkdfKey(secret, version), ivHex, tagHex, encHex);
      if (dec !== null) return dec;
    }
    return "";
  }

  if (value.startsWith(LEGACY_CIPHER_PREFIX)) {
    const parts = value.split(":");
    if (parts.length !== 4) return "";
    const [, ivHex, tagHex, encHex] = parts;
    for (const secret of candidates) {
      const dec = tryAesGcmDecrypt(deriveLegacyKey(secret), ivHex, tagHex, encHex);
      if (dec !== null) return dec;
    }
    return "";
  }

  // Совместимость со старыми незашифрованными значениями до их пересохранения.
  return value;
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

export function safeEqualText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
