import { createHmac, randomBytes } from "node:crypto";
import { safeEqualText } from "./crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function decodeBase32(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, "").replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(byteLength = 20): string {
  return encodeBase32(randomBytes(byteLength));
}

export function hotpCode(secretBase32: string, counter: number, digits = 6): string {
  const key = decodeBase32(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return String(otp).padStart(digits, "0");
}

export function verifyTotpCode(
  secretBase32: string,
  code: string,
  nowMs = Date.now(),
  windowSteps = 1,
): boolean {
  const clean = code.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean) || !secretBase32) return false;
  const step = Math.floor(nowMs / 1000 / 30);
  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const candidate = hotpCode(secretBase32, step + delta, 6);
    if (safeEqualText(candidate, clean)) {
      return true;
    }
  }
  return false;
}

export function buildOtpAuthUri(email: string, secretBase32: string, issuer = "Nova CRM"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const iss = encodeURIComponent(issuer);
  const sec = encodeURIComponent(secretBase32);
  return `otpauth://totp/${label}?secret=${sec}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}
