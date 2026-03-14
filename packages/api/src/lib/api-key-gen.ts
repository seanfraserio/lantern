import { randomBytes, createHash } from "node:crypto";

export function generateApiKey(): { key: string; prefix: string } {
  const raw = randomBytes(32);
  const encoded = raw.toString("base64url").slice(0, 40);
  const key = `lnt_${encoded}`;
  const prefix = key.slice(0, 12);
  return { key, prefix };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
