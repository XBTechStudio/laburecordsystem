import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Chip, Empty, PageHeader, TableWrap } from "@/components/ui";
import { canSeeBrand, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { count, money0, n } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { periodAt, periodOf, type Period } from "@/lib/promo-period";
import { PERIODS, progressText, readRule, tierMet, tierShare, tierText } from "@/lib/promo-rule";
import { getSettings } from "@/lib/settings";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const label = (p: Period) => {
  const last = new Date(p.end.getTime() - 1 + 8 * 3600_000).toISOString().slice(0, 10);
  return p.key === last ? p.key : `${p.key} – ${last}`;
};

/** Each player's progress towards a tracked promotion in one period. */
export default async function PromotionProgressPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ period?: string; show?: string }> }) {
  const user = await requirePage("promotions");
  const id = Number((await params).id);
  const sp = await searchParams;
  const promo = Number.isInteger(id) ? await prisma.promotion.findUnique({ where: { id }, include: { brand: true } }) : null;
  if (!promo || !canSeeBrand(user, promo.brandId)) notFound();
  const [settings, t] = await Promise.all([getSettings(), getT()]);
  const rule = readRule(promo.rule);
  const cur = promo.brand.currency;
  const o = { dayStartHour: settings.alerts.dayStartHour, weekStartDay: settings.alerts.weekStartDay };
  const c = { startDay: promo.startDay, endDay: promo.endDay };

  if (!rule) {
    return (
      <div className="max-w-5xl">
        <PageHeader title={promo.name} desc={promo.brand.name} />
        <Card>
          <Empty title={t("This promotion isn't tracked")}>{t("Set its claim conditions on the Promotions page (“Conditions”) and the system starts following players' progress.")}</Empty>
        </Card>
      </div>
    );
  }

  const current = periodAt(new Date(), rule.period, o, c);
  const period = sp.period && DAY_RE.test(sp.period) ? periodOf(sp.period, rule.period, o, c) : current;
  const prev = periodAt(new Date(period.start.getTime() - 1000), rule.period, o, c);
  const next = periodAt(period.end, rule.period, o, c);
  const all = sp.show === "all";

  const [rows, awards, near] = await Promise.all([
    prisma.promoProgress.findMany({
      where: { promotionId: id, periodKey: period.key },
      include: { player: { select: { id: true, username: true, name: true, assignedTo: { select: { name: true } } } } },
      orderBy: { amount: "desc" },
      take: 1000,
    }),
    prisma.promoAward.findMany({ where: { promotionId: id, periodKey: period.key } }),
    prisma.alert.findMany({ where: { promotionId: id, periodKey: period.key, kind: "NEAR" }, select: { playerId: true, outcome: true, doneAt: true } }),
  ]);
  const now = new Date();
  const list = rows
    .map((r) => {
      const amount = n(r.amount);
      const nextTier = rule.tiers.findIndex((tr) => !tierMet(rule, tr, amount, r.count));
      const share = nextTier < 0 ? 1 : tierShare(rule, rule.tiers[nextTier], amount, r.count);
      return { r, amount, nextTier, share, mine: awards.filter((a) => a.playerId === r.playerId), alert: near.find((a) => a.playerId === r.playerId) };
    })
    .filter((x) => all || x.amount > 0)
    .sort((a, b) => b.r.reached - a.r.reached || b.share - a.share);
  const reached = list.filter((x) => x.r.reached > 0).length;
  const close = list.filter((x) => x.alert && x.nextTier >= 0).length;
  const bonus = awards.reduce((a, x) => a + n(x.bonus), 0);
  const claimed = awards.filter((a) => a.claimedAt);
  const periodLabel = t(PERIODS.find((p) => p.value === rule.period)!.label);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={promo.name}
        desc={
          <>
            {promo.brand.name} · {periodLabel}
            {rule.payNext ? " · " + t("bonus next period") : ""} ·{" "}
            <Link className="link" href="/promotions">
              {t("All promotions")}
            </Link>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {rule.period !== "campaign" && (
          <Link className="btn btn-sm" href={`/promotions/${id}?period=${prev.key}`}>
            ← {t("Previous")}
          </Link>
        )}
        <span className="font-medium">{label(period)}</span>
        {period.key === current.key && <Chip tone="brand">{t("Now")}</Chip>}
        {rule.period !== "campaign" && period.key !== current.key && (
          <Link className="btn btn-sm" href={`/promotions/${id}?period=${next.key}`}>
            {t("Next")} →
          </Link>
        )}
        {period.key !== current.key && (
          <Link className="btn btn-sm btn-ghost" href={`/promotions/${id}`}>
            {t("Back to now")}
          </Link>
        )}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          [t("Players who deposited"), count(list.length)],
          [t("Close to a tier (alerted)"), count(close)],
          [t("Reached a tier"), count(reached)],
          [t("Bonuses earned"), money0(bonus, cur)],
          [t("Claimed"), `${count(claimed.length)} / ${count(awards.length)}`],
        ].map(([l, v]) => (
          <div key={l} className="card p-3.5">
            <div className="text-xs text-ink-2">{l}</div>
            <div className="mt-1 text-lg font-semibold">{v}</div>
          </div>
        ))}
      </div>

      <Card className="mb-5" title={t("Conditions")}>
        <ul className="space-y-0.5 text-sm">
          {rule.tiers.map((tr, i) => (
            <li key={i}>
              <span className="text-muted">{i + 1}.</span> {tierText(rule, tr, t, cur)}
            </li>
          ))}
        </ul>
        <div className="mt-2 text-xs text-muted">
          {rule.stack ? t("Every tier reached pays (they add up)") : t("Only the highest tier reached pays")}
          {rule.remind.pct > 0 ? " · " + t("remind at {p}%", { p: rule.remind.pct }) : ""}
        </div>
      </Card>

      <Card flush title={t("Players")} action={<Link className="link" href={`/promotions/${id}?${new URLSearchParams({ ...(sp.period ? { period: sp.period } : {}), ...(all ? {} : { show: "all" }) })}`}>{all ? t("Hide players at 0") : t("Show everyone")}</Link>}>
        {list.length === 0 ? (
          <Empty title={t("No deposits in this period yet")}>{t("Players appear here as soon as their deposits are entered.")}</Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Player")}</th>
                  <th>{t("CS")}</th>
                  <th className="r">{t("Deposited")}</th>
                  {rule.basis !== "amount" && <th className="r">{t("Deposits counted")}</th>}
                  <th>{t("Next tier")}</th>
                  <th>{t("Bonus")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map(({ r, amount, nextTier, share, mine, alert }) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="link font-medium" href={`/players/${r.player.id}`}>
                        {r.player.username}
                      </Link>
                      {r.player.name && <div className="text-xs text-muted">{r.player.name}</div>}
                    </td>
                    <td className="text-ink-2">{r.player.assignedTo?.name ?? "–"}</td>
                    <td className="r">{money0(amount, cur)}</td>
                    {rule.basis !== "amount" && <td className="r">{count(r.count)}</td>}
                    <td>
                      {nextTier < 0 ? (
                        <Chip tone="good">{t("All tiers reached")}</Chip>
                      ) : (
                        <div className="min-w-48">
                          <div className="flex items-center gap-2 text-xs">
                            <span>
                              {t("Tier {n}", { n: nextTier + 1 })}: {progressText(rule, rule.tiers[nextTier], amount, r.count, t, cur)}
                            </span>
                            {alert && <Chip tone={alert.doneAt ? "neutral" : "brand"}>{alert.outcome === "contacted" ? t("Contacted") : t("Alerted")}</Chip>}
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                            <div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(share * 100)}%` }} />
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="space-x-1 whitespace-nowrap">
                      {mine.length === 0 && <span className="text-muted">–</span>}
                      {mine
                        .sort((a, b) => a.tier - b.tier)
                        .map((a) => (
                          <Chip
                            key={a.id}
                            tone={a.claimedAt ? "good" : a.expiresAt && a.expiresAt <= now ? "critical" : "warning"}
                            title={t("Tier {n}", { n: a.tier + 1 })}
                          >
                            {money0(a.bonus, cur)} · {a.claimedAt ? t("Claimed") : a.expiresAt && a.expiresAt <= now ? t("Expired") : a.eligibleAt > now ? t("From next period") : t("Not claimed yet")}
                          </Chip>
                        ))}
                    </td>
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
