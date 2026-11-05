import Link from "next/link";
import { Prisma } from "@prisma/client";
import { BrandTag } from "@/components/brand-tag";
import { RangeBar } from "@/components/range";
import { Card, Empty, PageHeader, TableWrap } from "@/components/ui";
import { requirePage } from "@/lib/auth";
import { parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { count, money0, pct } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { PERIODS, readRule, tierText } from "@/lib/promo-rule";
import { emptyTrack, trackStats } from "@/lib/promo-stats";
import { getScope } from "@/lib/scope";

/** Promotions with claim conditions: reminders sent and bonuses that became claimable in the dates. */
export default async function TrackedPromotionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("promotions");
  const sp = await searchParams;
  const [scope, t] = await Promise.all([getScope(user), getT()]);
  const range = parseRange(sp, "month");
  const promos = scope.brandIds.length
    ? await prisma.promotion.findMany({ where: { brandId: { in: scope.brandIds }, active: true, rule: { not: Prisma.DbNull } }, orderBy: { name: "asc" } })
    : [];
  const tracked = promos.map((p) => ({ p, rule: readRule(p.rule) })).filter((x) => x.rule && x.rule.tiers.length);
  const track = await trackStats(tracked.map((x) => x.p.id), range);
  const multi = !scope.current;

  return (
    <div className="max-w-[1400px]">
      <PageHeader title={t("Tracked promotions")} desc={t("Reminders and bonuses in the selected dates. Click a promotion to see each player's progress.")} />
      <div className="mb-4">
        <RangeBar path="/promotions/tracked" range={range} params={sp} />
      </div>
      <Card flush>
        {tracked.length === 0 ? (
          <Empty title={t("This promotion isn't tracked")}>{t("Set its claim conditions on the Promotions page (“Conditions”) and the system starts following players' progress.")}</Empty>
        ) : (
          <TableWrap stickyHead>
            <table className="tbl">
              <thead>
                <tr>
                  {multi && <th>{t("Brand")}</th>}
                  <th>{t("Promotion")}</th>
                  <th>{t("Conditions")}</th>
                  <th className="r">{t("Reminded")}</th>
                  <th className="r">{t("Contacted")}</th>
                  <th className="r">{t("Qualified after reminder")}</th>
                  <th className="r">{t("Eligible")}</th>
                  <th className="r">{t("Claimed")}</th>
                  <th className="r">{t("Expired")}</th>
                  <th className="r">{t("Not claimed yet")}</th>
                  <th className="r">{t("Claim rate")}</th>
                </tr>
              </thead>
              <tbody>
                {tracked.map(({ p, rule }) => {
                  const s = track.get(p.id) ?? emptyTrack();
                  const cur = scope.brandCurrency(p.brandId);
                  return (
                    <tr key={p.id}>
                      {multi && (
                        <td>
                          <BrandTag id={p.brandId} />
                        </td>
                      )}
                      <td>
                        <Link className="link font-medium" href={`/promotions/${p.id}`}>
                          {p.name}
                        </Link>
                      </td>
                      <td className="text-xs text-ink-2">
                        <div>
                          {t(PERIODS.find((x) => x.value === rule!.period)!.label)}
                          {rule!.payNext ? " · " + t("bonus next period") : ""}
                        </div>
                        {rule!.tiers.slice(0, 3).map((tr, i) => (
                          <div key={i}>{tierText(rule!, tr, t, cur)}</div>
                        ))}
                        {rule!.tiers.length > 3 && <div>+{rule!.tiers.length - 3}</div>}
                      </td>
                      <td className="r">{count(s.reminded)}</td>
                      <td className="r">{count(s.contacted)}</td>
                      <td className="r">
                        {count(s.reachedAfter)} {s.reminded ? <span className="text-xs text-muted">{pct((s.reachedAfter / s.reminded) * 100, 0)}</span> : null}
                      </td>
                      <td className="r">{count(s.eligible)}</td>
                      <td className="r">
                        {count(s.claimed)} <span className="text-xs text-muted">{money0(s.claimedBonus, cur)}</span>
                      </td>
                      <td className={`r ${s.expired ? "text-critical-ink" : ""}`}>{count(s.expired)}</td>
                      <td className="r">{count(s.pending)}</td>
                      <td className="r">{s.eligible ? pct((s.claimed / s.eligible) * 100, 0) : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
