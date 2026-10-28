import "server-only";

import { can, type CurrentUser } from "@/lib/auth";
import { getT } from "@/lib/i18n-server";
import type { Module } from "@/lib/perms";
import { getSettings } from "@/lib/settings";

/**
 * Who may change or delete a saved record. Roles with Full access on the module can (by default only the Administrator).
 * If Settings → General allows it, the person who entered a record can also fix it for a few minutes after saving.
 */
export async function editRights(user: CurrentUser, m: Module) {
  const [{ selfFixMinutes: minutes }, t] = await Promise.all([getSettings(), getT()]);
  const full = can(user, m, 3);
  const since = Date.now() - minutes * 60_000;
  return {
    full,
    may: (authorId: number | null, createdAt: Date) => full || (minutes > 0 && authorId === user.id && createdAt.getTime() > since),
    /** For the list's note, so people know why there is no Edit button. */
    note: full ? "" : minutes > 0 ? t("you can fix your own entries for {n} min after saving", { n: minutes }) : t("only an administrator can change saved entries"),
    /** Shown when someone tries anyway. */
    denied:
      minutes > 0
        ? t("Only an administrator can change this. You can fix your own entries within {n} minutes of saving them.", { n: minutes })
        : t("Only an administrator can change or delete saved data."),
  };
}
