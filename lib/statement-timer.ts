import { cronKey } from "./cron-key";

const EVERY_MS = 15 * 60_000;

/**
 * Every 15 minutes the app asks itself to read the statement pages (see app/api/cron/statements).
 * Going through the app's own address keeps the work in the normal request code.
 */
export function startStatementTimer() {
  const g = globalThis as { statementTimer?: ReturnType<typeof setInterval> };
  if (g.statementTimer) return;
  const run = () =>
    fetch(`http://127.0.0.1:${process.env.PORT || 3070}/api/cron/statements`, { method: "POST", headers: { "x-cron-key": cronKey() } })
      .then((r) => (r.ok ? null : console.error("statement reading answered", r.status)))
      .catch((e) => console.error("statement reading failed", e));
  setTimeout(run, 60_000);
  g.statementTimer = setInterval(run, EVERY_MS);
}
