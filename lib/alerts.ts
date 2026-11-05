import "server-only";

import type { Prisma } from "@prisma/client";
import { can, type CurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { levelOf, type Perms } from "@/lib/perms";
import type { Settings } from "@/lib/settings";

const receives = (perms: Perms, roleId: number, s: Settings) => levelOf(perms, "alerts") >= 2 && (!s.alerts.roleIds.length || s.alerts.roleIds.includes(roleId));

/** Does this person get alerts at all (pop-ups and "my alerts")? */
export function getsAlerts(user: CurrentUser, s: Settings) {
  return receives(user.perms, user.roleId, s);
}

/**
 * Staff who can't act on alerts addressed to them (left, or their role doesn't receive alerts).
 * Those alerts count as addressed to everyone on the brand, so they aren't lost.
 */
export async function mutedStaff(s: Settings): Promise<number[]> {
  const users = await prisma.user.findMany({ select: { id: true, active: true, roleId: true, role: { select: { perms: true } } } });
  return users.filter((u) => !u.active || !receives((u.role.perms ?? {}) as Perms, u.roleId, s)).map((u) => u.id);
}

/**
 * Alerts this person may see. mine = addressed to them, or to everyone on a brand they handle;
 * all = every alert on their brands (anyone who receives alerts, or has Full access; only Full access acts on other CS's).
 */
export function alertScope(user: CurrentUser, s: Settings, brandIds: number[], mode: "mine" | "all", muted: number[]): Prisma.AlertWhereInput {
  const brands = { brandId: { in: brandIds } };
  if (!getsAlerts(user, s) && !can(user, "alerts", 3)) return { id: -1 };
  if (mode === "all") return brands;
  return { ...brands, OR: [{ staffId: user.id }, { staffId: null }, ...(muted.length ? [{ staffId: { in: muted } }] : [])] };
}
