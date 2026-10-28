import type { NextRequest } from "next/server";
import { can, getUser } from "@/lib/auth";
import { queryPlayers, tierName } from "@/lib/player-query";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { getT } from "@/lib/i18n-server";
import { round2, xlsxResponse } from "@/lib/xlsx";

const SORTS = ["value", "deposit", "recent", "idle", "net", "newest"] as const;

export async function GET(req: NextRequest) {
  const user = await getUser();
  if (!user || !can(user, "players")) return new Response("Not allowed", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams);
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const { rows } = await queryPlayers(settings.tierScoring, {
    brandIds: scope.brandIds,
    q: sp.q?.trim() || undefined,
    tierRank: sp.tier ? Number(sp.tier) : undefined,
    assigned: sp.cs === "me" ? "me" : sp.cs === "none" ? "none" : sp.cs ? Number(sp.cs) : undefined,
    meId: user.id,
    sort: SORTS.find((s) => s === sp.sort) ?? "value",
    limit: 50000,
    offset: 0,
  });
  const iso = (d: Date | null) => (d ? new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : "");
  const data = [
    ["Brand", "Username", "Name", "Phone", "Tier", "Score", "Currency", "Deposits", "Deposit count", "Withdrawals", "Withdrawal count", "Net", "Avg deposit", "First deposit", "Last deposit", "CS"].map((h) => t(h)),
    ...rows.map((p) => [
      scope.brandName(p.brandId),
      p.username,
      p.name,
      p.phone,
      t(tierName(settings.tierScoring, p.score).name),
      p.score,
      scope.brandCurrency(p.brandId),
      round2(p.depositTotal),
      p.depositCount,
      round2(p.withdrawTotal),
      p.withdrawCount,
      round2(p.depositTotal - p.withdrawTotal),
      p.depositCount ? round2(p.depositTotal / p.depositCount) : 0,
      iso(p.firstDepositAt),
      iso(p.lastDepositAt),
      p.assignedName,
    ]),
  ];
  return xlsxResponse(`players_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: t("Players"), rows: data }]);
}
