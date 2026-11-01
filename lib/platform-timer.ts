import { cronKey } from "./cron-key";

const EVERY_MS = 2 * 60_000;

/**
 * Every 2 minutes the app asks itself to read the connected platforms (see app/api/cron/platform).
 * While a brand is still catching up on its history, the next read starts as soon as this one ends.
 */
export function startPlatformTimer() {
  const g = globalThis as { platformTimer?: ReturnType<typeof setInterval> };
  if (g.platformTimer) return;
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    let again = false;
    fetch(`http://127.0.0.1:${process.env.PORT || 3070}/api/cron/platform`, { method: "POST", headers: { "x-cron-key": cronKey() } })
      .then(async (r) => {
        if (!r.ok) return console.error("platform sync answered", r.status);
        const res = (await r.json()) as Record<string, { more?: boolean; error?: string }>;
        again = Object.values(res).some((x) => x.more && !x.error);
      })
      .catch((e) => console.error("platform sync failed", e))
      .finally(() => {
        busy = false;
        if (again) setTimeout(run, 1000);
      });
  };
  setTimeout(run, 90_000);
  g.platformTimer = setInterval(run, EVERY_MS);
}
