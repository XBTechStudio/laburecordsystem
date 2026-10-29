import type { NextRequest } from "next/server";
import { getUser } from "@/lib/auth";
import { alertText, type AlertKindName } from "@/lib/alert-text";
import { alertScope, getsAlerts } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { getT } from "@/lib/i18n-server";
import { alertTick } from "@/lib/promo-engine";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";

/** Polled by the bell in the top bar: open alerts for this person, and the ones raised since `since` for pop-ups. */
export async function GET(req: NextRequest) {
  const user = await getUser();
  if (!user) return new Response("Not allowed", { status: 403 });
  const settings = await getSettings();
  if (!getsAlerts(user, settings)) return Response.json({ open: 0, items: [] });
  await alertTick();
  const [scope, t] = await Promise.all([getScope(user), getT()]);
  const since = Number(req.nextUrl.searchParams.get("since")) || 0;
  const where = { ...alertScope(user, settings, scope.brandIds, "mine"), doneAt: null };
  const [open, fresh] = await Promise.all([
    prisma.alert.count({ where }),
    since
      ? prisma.alert.findMany({ where: { ...where, raisedAt: { gt: new Date(since) } }, include: { player: { select: { username: true } } }, orderBy: { raisedAt: "desc" }, take: 5 })
      : Promise.resolve([]),
  ]);
  return Response.json({
    open,
    now: Date.now(),
    items: fresh.map((a) => {
      const text = alertText(a.kind as AlertKindName, a.data, t, scope.brandCurrency(a.brandId));
      return { id: a.id, kind: a.kind, player: a.player.username, playerId: a.playerId, brand: scope.brandName(a.brandId), ...text };
    }),
  });
}
