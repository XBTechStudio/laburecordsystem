import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Keeps API tokens unreadable in the database. The key comes from AUTH_SECRET, so a copied database alone can't reveal them.
const key = () => createHash("sha256").update(`secret-box:${process.env.AUTH_SECRET ?? ""}`).digest();

export function seal(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function open(sealed: string) {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

/** "9459b7…f6029" — enough to recognise a token without showing it. */
export const masked = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-5)}` : "••••");
