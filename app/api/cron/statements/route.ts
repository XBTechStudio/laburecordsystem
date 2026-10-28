import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { cronKey } from "@/lib/cron-key";
import { addDays, todayStr } from "@/lib/dates";
import { syncStatements } from "@/lib/statements";

/** Called by the app's own timer (instrumentation.ts): reads today's statements, and yesterday's until 6 am. */
export async function POST(req: NextRequest) {
  const key = Buffer.from(req.headers.get("x-cron-key") ?? "");
  const want = Buffer.from(cronKey());
  if (key.length !== want.length || !timingSafeEqual(key, want)) return new Response("Not allowed", { status: 403 });
  const today = todayStr();
  const result = { [today]: await syncStatements(today) };
  // Late lines for yesterday still show up after midnight.
  if (Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 13)) < 6) result[addDays(today, -1)] = await syncStatements(addDays(today, -1));
  return Response.json(result);
}
