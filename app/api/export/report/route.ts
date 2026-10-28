import type { NextRequest } from "next/server";
import { can, getUser } from "@/lib/auth";
import { parseRange } from "@/lib/dates";
import { buildReport, GROUPS, METRICS, parseCols, type Group } from "@/lib/report";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";
import { getT } from "@/lib/i18n-server";
import { round2, xlsxResponse } from "@/lib/xlsx";

export async function GET(req: NextRequest) {
  const user = await getUser();
  if (!user || !can(user, "reports")) return new Response("Not allowed", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams);
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const range = parseRange(sp, "month");
  const group = (GROUPS.find((g) => g.key === sp.group)?.key ?? "day") as Group;
  const metrics = METRICS.filter((m) => parseCols(sp.cols).includes(m.key));
  const { lines, total } = await buildReport(scope, settings, range, group, t);
  const val = (kind: string, v: number) => (kind === "count" ? v : round2(v));
  const head = [t(GROUPS.find((g) => g.key === group)!.col), ...metrics.map((m) => (m.kind === "pct" ? `${t(m.label)} (%)` : m.kind === "money" ? `${t(m.label)} (${scope.currency})` : t(m.label)))];
  const rows = [
    [`${settings.systemName} — ${scope.current?.name ?? t("All brands")} — ${range.from} ~ ${range.to}`],
    [],
    head,
    ...lines.map((l) => [l.label, ...metrics.map((m) => val(m.kind, m.get(l.t)))]),
    [t("Total"), ...metrics.map((m) => val(m.kind, m.get(total)))],
  ];
  return xlsxResponse(`report_${range.from}_${range.to}.xlsx`, [{ name: t("Report"), rows, widths: [24, ...metrics.map(() => 16)] }]);
}
