import "server-only";

import type { Prisma } from "@prisma/client";
import { can, type CurrentUser } from "@/lib/auth";
import type { Settings } from "@/lib/settings";

/** Does this person get alerts at all (pop-ups and "my alerts")? */
export function getsAlerts(user: CurrentUser, s: Settings) {
  return can(user, "alerts", 2) && (!s.alerts.roleIds.length || s.alerts.roleIds.includes(user.roleId));
}

/**
 * Alerts this person may see. mine = addressed to them, or to everyone on a brand they handle;
 * all = every alert on their brands (Full access only).
 */
export function alertScope(user: CurrentUser, s: Settings, brandIds: number[], mode: "mine" | "all"): Prisma.AlertWhereInput {
  const brands = { brandId: { in: brandIds } };
  if (mode === "all" && can(user, "alerts", 3)) return brands;
  if (!getsAlerts(user, s)) return { id: -1 };
  return { ...brands, OR: [{ staffId: user.id }, { staffId: null }] };
}
