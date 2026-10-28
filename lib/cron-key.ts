import { createHash } from "node:crypto";

/** Shared secret for the app's own background calls (derived from AUTH_SECRET, never sent anywhere else). */
export function cronKey() {
  return createHash("sha256").update(`cron:${process.env.AUTH_SECRET ?? ""}`).digest("hex");
}
