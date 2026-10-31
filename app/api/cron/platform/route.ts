import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { cronKey } from "@/lib/cron-key";
import { syncAll } from "@/lib/platform-sync";

/** Called by the app's own timer (instrumentation.ts): reads every connected brand's platform API. */
export async function POST(req: NextRequest) {
  const key = Buffer.from(req.headers.get("x-cron-key") ?? "");
  const want = Buffer.from(cronKey());
  if (key.length !== want.length || !timingSafeEqual(key, want)) return new Response("Not allowed", { status: 403 });
  return Response.json(await syncAll());
}
