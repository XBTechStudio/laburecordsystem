// Runs once when the server starts. In production it starts the background readers:
// the PG / agent statement pages (STATEMENT_SYNC=off stops it) and the brands' platform APIs (PLATFORM_SYNC=off stops it).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  if (process.env.STATEMENT_SYNC !== "off") (await import("./lib/statement-timer")).startStatementTimer();
  if (process.env.PLATFORM_SYNC !== "off") (await import("./lib/platform-timer")).startPlatformTimer();
}
