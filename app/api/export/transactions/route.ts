import type { NextRequest } from "next/server";
import { can, getUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { dt, n } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { getScope } from "@/lib/scope";
import { txnFilter } from "@/lib/txn-filter";
import { round2, xlsxResponse } from "@/lib/xlsx";

const MAX_ROWS = 100_000;

/** The Transactions page as an Excel file, with the same filters, oldest first. */
export async function GET(req: NextRequest) {
  const user = await getUser();
  if (!user || !can(user, "transactions")) return new Response("Not allowed", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams);
  const [scope, t] = await Promise.all([getScope(user), getT()]);
  const { range, where } = txnFilter(sp, scope.brandIds);
  const rows = await prisma.txn.findMany({
    where,
    include: { player: { select: { username: true } }, channel: { select: { name: true } }, createdBy: { select: { name: true } } },
    orderBy: [{ txnAt: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
  });
  const importIds = [...new Set(rows.flatMap((r) => (r.importId ? [r.importId] : [])))];
  const files = new Map((await prisma.importBatch.findMany({ where: { id: { in: importIds } }, select: { id: true, filename: true } })).map((b) => [b.id, b.filename]));
  const data = [
    [t("Time"), t("Brand"), t("Player"), t("Type"), t("Amount"), t("Currency"), t("PG / bank"), t("Reference no."), t("Note"), t("Entered by"), t("Entered at"), t("Source")],
    ...rows.map((r) => [
      dt(r.txnAt),
      scope.brandName(r.brandId),
      r.player.username,
      r.type === "DEPOSIT" ? t("Deposit") : t("Withdrawal"),
      round2(n(r.amount)),
      scope.brandCurrency(r.brandId),
      r.channel?.name ?? "",
      r.ref ?? "",
      r.note ?? "",
      r.createdBy?.name ?? "",
      dt(r.createdAt),
      r.importId ? `${t("Excel import")}: ${files.get(r.importId) ?? `#${r.importId}`}` : t("Typed in"),
    ]),
  ];
  return xlsxResponse(`transactions_${range.from}_${range.to}.xlsx`, [{ name: t("Transactions"), rows: data, widths: [17, 14, 18, 11, 12, 9, 16, 18, 24, 16, 17, 30] }]);
}
