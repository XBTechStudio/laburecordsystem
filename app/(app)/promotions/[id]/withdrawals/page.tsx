import Link from "next/link";
import { notFound } from "next/navigation";
import { RangeBar } from "@/components/range";
import { Card, Empty, PageHeader, TableWrap } from "@/components/ui";
import { canSeeBrand, requirePage } from "@/lib/auth";
import { parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { count, dt, money } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { promoWithdrawalList } from "@/lib/promo-stats";

/** One promotion's actual promo withdrawals in the dates, each with the claim it was made under, for checking against the platform. */
export default async function PromoWithdrawalsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("promotions");
  const id = Number((await params).id);
  const sp = await searchParams;
  const promo = Number.isInteger(id) ? await prisma.promotion.findUnique({ where: { id }, include: { brand: true } }) : null;
  if (!promo || !canSeeBrand(user, promo.brandId)) notFound();
  const t = await getT();
  const range = parseRange(sp, "month");
  const rows = await promoWithdrawalList(promo, range);
  const cur = promo.brand.currency;
  const total = rows.reduce((a, r) => a + Number(r.w.amount), 0);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={t("Actual promo withdrawals: {name}", { name: promo.name })}
        desc={
          <>
            {promo.brand.name} · {t("Each withdrawal with the claim it was made under.")}{" "}
            <Link className="link" href={`/promotions?from=${range.from}&to=${range.to}`}>
              ← {t("Promotions")}
            </Link>
          </>
        }
      />
      <div className="mb-4">
        <RangeBar path={`/promotions/${promo.id}/withdrawals`} range={range} params={sp} brand={false} />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card p-3.5">
          <div className="text-xs text-ink-2">{t("Actual promo withdrawals")}</div>
          <div className="mt-1 text-lg font-semibold">{money(total, cur)}</div>
        </div>
        <div className="card p-3.5">
          <div className="text-xs text-ink-2">{t("Withdrawal")}</div>
          <div className="mt-1 text-lg font-semibold">{count(rows.length)}</div>
        </div>
      </div>
      <Card flush>
        {rows.length === 0 ? (
          <Empty title={t("No withdrawals under this promotion in these dates")} />
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Player")}</th>
                  <th>{t("Claimed at")}</th>
                  <th className="r">{t("Bonus")}</th>
                  <th>{t("Claim no.")}</th>
                  <th>{t("Withdrawn at")}</th>
                  <th className="r">{t("Withdrawal")}</th>
                  <th>{t("Withdrawal no.")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ w, claim }) => (
                  <tr key={w.id}>
                    <td>
                      <Link className="link font-medium" href={`/players/${w.player.id}`}>
                        {w.player.username}
                      </Link>
                      {w.player.name && <div className="text-xs text-muted">{w.player.name}</div>}
                    </td>
                    <td className="whitespace-nowrap text-ink-2">{dt(claim?.claimedAt)}</td>
                    <td className="r">{claim ? money(claim.amount, cur) : "–"}</td>
                    <td className="text-xs text-ink-2">{claim?.ref ?? "–"}</td>
                    <td className="whitespace-nowrap">{dt(w.txnAt)}</td>
                    <td className="r font-medium">{money(w.amount, cur)}</td>
                    <td className="text-xs text-ink-2">{w.ref ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
