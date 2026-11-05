import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/client";
import { BrandTag } from "@/components/brand-tag";
import { RangeBar } from "@/components/range";
import { Card, Chip, Empty, PageHeader, TableWrap } from "@/components/ui";
import { can, canSeeBrand, requirePage } from "@/lib/auth";
import { addDays, dayStart, parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { count, dt, money } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { toggleClaimCounted } from "../../claim-actions";

const MAX = 2000;

/** One promotion's claims in the dates, where a claim that shouldn't count (a test) can be marked so. */
export default async function PromoClaimsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("promotions");
  const id = Number((await params).id);
  const sp = await searchParams;
  const promo = Number.isInteger(id) ? await prisma.promotion.findUnique({ where: { id }, include: { brand: true } }) : null;
  if (!promo || !canSeeBrand(user, promo.brandId)) notFound();
  const t = await getT();
  const manage = can(user, "promotions", 3);
  const range = parseRange(sp, "month");
  const claims = await prisma.promoClaim.findMany({
    where: { promotionId: id, claimedAt: { gte: dayStart(range.from), lt: dayStart(addDays(range.to, 1)) } },
    include: { player: { select: { id: true, username: true, name: true } }, createdBy: { select: { name: true } } },
    orderBy: { claimedAt: "desc" },
    take: MAX,
  });
  const cur = promo.brand.currency;
  const counted = claims.filter((c) => !c.voidedAt);
  const total = counted.reduce((a, c) => a + Number(c.amount), 0);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={t("Claims: {name}", { name: promo.name })}
        desc={
          <>
            <BrandTag id={promo.brandId} /> · {t("A claim marked “Not counted” (e.g. a test on the platform) stays here but leaves every total and report.")}{" "}
            <Link className="link" href={`/promotions?from=${range.from}&to=${range.to}`}>
              ← {t("Promotions")}
            </Link>
          </>
        }
      />
      <div className="mb-4">
        <RangeBar path={`/promotions/${promo.id}/claims`} range={range} params={sp} brand={false} />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card p-3.5">
          <div className="text-xs text-ink-2">{t("Bonus given")}</div>
          <div className="mt-1 text-lg font-semibold">{money(total, cur)}</div>
        </div>
        <div className="card p-3.5">
          <div className="text-xs text-ink-2">{t("Claims")}</div>
          <div className="mt-1 text-lg font-semibold">{count(counted.length)}</div>
          {claims.length > counted.length && <div className="text-xs text-muted">{t("{n} not counted", { n: count(claims.length - counted.length) })}</div>}
        </div>
      </div>
      <Card flush>
        {claims.length === 0 ? (
          <Empty title={t("No claims in these dates")} />
        ) : (
          <TableWrap stickyHead>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Claimed at")}</th>
                  <th>{t("Player")}</th>
                  <th className="r">{t("Bonus")}</th>
                  <th>{t("Claim no.")}</th>
                  <th>{t("Entered by")}</th>
                  <th>{t("Status")}</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id} className={c.voidedAt ? "text-muted" : ""}>
                    <td className="whitespace-nowrap">{dt(c.claimedAt)}</td>
                    <td>
                      <Link className="link font-medium" href={`/players/${c.player.id}`}>
                        {c.player.username}
                      </Link>
                      {c.player.name && <div className="text-xs text-muted">{c.player.name}</div>}
                    </td>
                    <td className={`r ${c.voidedAt ? "line-through" : "font-medium"}`}>{money(c.amount, cur)}</td>
                    <td className="text-xs text-ink-2">{c.ref ?? "–"}</td>
                    <td className="text-ink-2">{c.createdBy?.name ?? (c.ref ? t("Platform") : "–")}</td>
                    <td>
                      {!c.voidedAt ? (
                        <Chip tone="good">{t("Counted")}</Chip>
                      ) : c.replacedById ? (
                        <Chip>{t("Cleared, given again")}</Chip>
                      ) : (
                        <Chip tone="warning">{t("Not counted")}</Chip>
                      )}
                    </td>
                    {manage && (
                      <td className="r">
                        {!c.replacedById && (
                          <ActionButton
                            action={toggleClaimCounted}
                            fields={{ id: c.id }}
                            question={c.voidedAt ? undefined : t("Stop counting this claim? It leaves every total and report; you can count it again later.")}
                          >
                            {c.voidedAt ? t("Count again") : t("Don't count")}
                          </ActionButton>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {claims.length === MAX && <div className="px-4 py-2 text-xs text-muted">{t("Showing the latest {n}. Pick shorter dates to see the rest.", { n: count(MAX) })}</div>}
      </Card>
    </div>
  );
}
