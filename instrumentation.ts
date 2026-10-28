// Runs once when the server starts. In production it starts reading the PG / agent statement pages in the background.
// Set STATEMENT_SYNC=off in .env to stop it.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production" || process.env.STATEMENT_SYNC === "off") return;
  const { startStatementTimer } = await import("./lib/statement-timer");
  startStatementTimer();
}
