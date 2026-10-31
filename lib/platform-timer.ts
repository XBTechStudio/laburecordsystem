import { cronKey } from "./cron-key";

const EVERY_MS = 2 * 60_000;

/** Every 2 minutes the app asks itself to read the connected platforms (see app/api/cron/platform). */
export function startPlatformTimer() {
  const g = globalThis as { platformTimer?: ReturnType<typeof setInterval> };
  if (g.platformTimer) return;
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    fetch(`http://127.0.0.1:${process.env.PORT || 3070}/api/cron/platform`, { method: "POST", headers: { "x-cron-key": cronKey() } })
      .then((r) => (r.ok ? null : console.error("platform sync answered", r.status)))
      .catch((e) => console.error("platform sync failed", e))
      .finally(() => (busy = false));
  };
  setTimeout(run, 90_000);
  g.platformTimer = setInterval(run, EVERY_MS);
}
