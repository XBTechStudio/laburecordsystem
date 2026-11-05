import type { NextRequest } from "next/server";
import { can, getUser, seesWithdrawals } from "@/lib/auth";
import { playerSort, queryPlayers, statusParam, tierName } from "@/lib/player-query";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { getT } from "@/lib/i18n-server";
import { round2, xlsxResponse } from "@/lib/xlsx";

export async function GET(req: NextRequest) {
  const user = await getUser();
  if (!user || !can(user, "players")) return new Response("Not allowed", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams);
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const { rows } = await queryPlayers(settings.tierScoring, {
    brandIds: scope.brandIds,
    q: sp.q?.trim() || undefined,
    tierRank: sp.tier ? Number(sp.tier) : undefined,
    status: statusParam(sp.status),
    sort: playerSort(sp.sort) ?? "value",
    asc: sp.dir === "asc",
    limit: 50000,
    offset: 0,
  });
  const iso = (d: Date | null) => (d ? new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : "");
  const status: Record<string, string> = { ACTIVE: t("Active"), SUSPENDED: t("Suspended"), BANNED: t("Banned") };
  // Deposit-only staff get the file without the withdrawal and net columns.
  const wd = seesWithdrawals(user);
  const data = [
    [
      "Brand", "Username", "Name", "Phone", "Status", "Remark", "Tier", "Score", "Currency", "Deposits", "Deposit count",
      ...(wd ? ["Withdrawals", "Withdrawal count", "Net"] : []),
      "Avg deposit", "First deposit", "Last deposit", "CS",
    ].map((h) => t(h)),
    ...rows.map((p) => [
      scope.brandName(p.brandId),
      p.username,
      p.name,
      p.phone,
      status[p.status] ?? p.status,
      p.note,
      t(tierName(settings.tierScoring, p.score).name),
      p.score,
      scope.brandCurrency(p.brandId),
      round2(p.depositTotal),
      p.depositCount,
      ...(wd ? [round2(p.withdrawTotal), p.withdrawCount, round2(p.depositTotal - p.withdrawTotal)] : []),
      p.depositCount ? round2(p.depositTotal / p.depositCount) : 0,
      iso(p.firstDepositAt),
      iso(p.lastDepositAt),
      p.assignedName,
    ]),
  ];
  return xlsxResponse(`players_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: t("Players"), rows: data }]);
}
