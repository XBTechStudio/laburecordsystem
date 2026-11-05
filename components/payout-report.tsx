import Link from "next/link";
import { RangeBar } from "@/components/range";
import { Card, Empty, Info, PageHeader, TableWrap } from "@/components/ui";
import { requirePage } from "@/lib/auth";
import { addDays, dayOf, dayStart, mondayOf, parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { count, dt, money, money0, n } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { getScope } from "@/lib/scope";
import { BrandTag } from "@/components/brand-tag";

const MAX_ROWS = 300;

/**
 * Commission and rebate pages: platform bonuses whose promotion name has the word in it
 * ("WEEKLY COMMISSION", "DAILY REBATE 10%"…), summed by week or day, by brand and by player.
 */
export async function PayoutReport({
  kind,
  searchParams,
}: {
  kind: "commission" | "rebate";
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requirePage(kind);
  const sp = await searchParams;
  const [scope, t] = await Promise.all([getScope(user), getT()]);
  const range = parseRange(sp, "month");
  const path = `/${kind}`;
  const byWeek = kind === "commission";
  const q = (sp.q ?? "").trim();
  const multi = !scope.current;

  const promos = scope.brandIds.length
    ? await prisma.promotion.findMany({ where: { brandId: { in: scope.brandIds }, name: { contains: kind } }, select: { id: true, name: true, brandId: true }, orderBy: { name: "asc" } })
    : [];
  const brandOf = new Map(promos.map((p) => [p.id, p.brandId]));
  const claims = promos.length
    ? await prisma.promoClaim.findMany({
        where: {
          promotionId: { in: promos.map((p) => p.id) },
          claimedAt: { gte: dayStart(range.from), lt: dayStart(addDays(range.to, 1)) },
          ...(q ? { player: { username: { contains: q } } } : {}),
        },
        select: { playerId: true, promotionId: true, amount: true, claimedAt: true },
      })
    : [];

  type Sum = { amount: number; payouts: number; players: Set<number> };
  const add = (m: Map<string, Sum>, k: string, amount: number, playerId: number) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = { amount: 0, payouts: 0, players: new Set() }));
    s.amount += amount;
    s.payouts++;
    s.players.add(playerId);
  };
  const periods = new Map<string, Sum>();
  const brands = new Map<string, Sum>();
  const players = new Map<number, { brandId: number; amount: number; payouts: number; last: Date }>();
  let total = 0;
  for (const c of claims) {
    const brandId = brandOf.get(c.promotionId)!;
    const raw = n(c.amount);
    const amount = raw * scope.rate(brandId);
    const day = dayOf(c.claimedAt);
    total += amount;
    add(periods, byWeek ? mondayOf(day) : day, amount, c.playerId);
    add(brands, String(brandId), raw, c.playerId);
    const p = players.get(c.playerId) ?? { brandId, amount: 0, payouts: 0, last: c.claimedAt };
    p.amount += raw;
    p.payouts++;
    if (c.claimedAt > p.last) p.last = c.claimedAt;
    players.set(c.playerId, p);
  }
  const top = [...players.entries()].sort((a, b) => b[1].amount * scope.rate(b[1].brandId) - a[1].amount * scope.rate(a[1].brandId)).slice(0, MAX_ROWS);
  const info = new Map(
    (
      await prisma.player.findMany({
        where: { id: { in: top.map(([id]) => id) } },
        select: { id: true, username: true, name: true, assignedTo: { select: { name: true } } },
      })
    ).map((p) => [p.id, p]),
  );
  const periodRows = [...periods.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const title = byWeek ? t("Commission") : t("Rebate");
  return (
    <div className="max-w-6xl">
      <PageHeader
        title={title}
        desc={
          <>
            {byWeek ? t("Weekly commission paid to players.") : t("Rebate paid to players.")}{" "}
            <Info>
              {t("Read from the platform's bonus records: every promotion with “{word}” in its name counts ({names}). Days and weeks are Malaysia time; a week starts on Monday.", {
                word: byWeek ? "Commission" : "Rebate",
                names: [...new Set(promos.map((p) => p.name))].join(", ") || "–",
              })}
            </Info>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RangeBar path={path} range={range} params={sp} />
        <form action={path}>
          {Object.entries(sp)
            .filter(([k, v]) => v && k !== "q")
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <input name="q" defaultValue={q} placeholder={t("Player username")} className="input h-8 w-40" />
        </form>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          [t("Total paid"), money0(total, scope.currency)],
          [t("Players paid"), count(players.size)],
          [t("Times paid"), count(claims.length)],
          [t("Average per player"), players.size ? money0(total / players.size, scope.currency) : "–"],
        ].map(([l, v]) => (
          <div key={l} className="card p-3.5">
            <div className="text-xs text-ink-2">{l}</div>
            <div className="mt-1 text-lg font-semibold">{v}</div>
          </div>
        ))}
      </div>

      {claims.length === 0 ? (
        <Card>
          <Empty title={byWeek ? t("No commission in these dates") : t("No rebate in these dates")}>
            {t("Payouts appear here once the platform sync brings in the bonus records.")}
          </Empty>
        </Card>
      ) : (
        <>
          <div className={`mb-5 grid gap-5 ${multi ? "lg:grid-cols-2" : ""}`}>
            <Card flush title={byWeek ? t("By week") : t("By day")}>
              <TableWrap>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{byWeek ? t("Week") : t("Day")}</th>
                      <th className="r">{t("Players")}</th>
                      <th className="r">{t("Times paid")}</th>
                      <th className="r">{t("Amount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periodRows.map(([k, s]) => (
                      <tr key={k}>
                        <td className="whitespace-nowrap">{byWeek ? `${k} – ${addDays(k, 6)}` : k}</td>
                        <td className="r">{count(s.players.size)}</td>
                        <td className="r">{count(s.payouts)}</td>
                        <td className="r">{money0(s.amount, scope.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
            {multi && (
              <Card flush title={t("By brand")}>
                <TableWrap>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t("Brand")}</th>
                        <th className="r">{t("Players")}</th>
                        <th className="r">{t("Times paid")}</th>
                        <th className="r">{t("Amount")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...brands.entries()]
                        .sort((a, b) => b[1].amount * scope.rate(Number(b[0])) - a[1].amount * scope.rate(Number(a[0])))
                        .map(([id, s]) => (
                          <tr key={id}>
                            <td><BrandTag id={Number(id)} /></td>
                            <td className="r">{count(s.players.size)}</td>
                            <td className="r">{count(s.payouts)}</td>
                            <td className="r">{money0(s.amount, scope.brandCurrency(Number(id)))}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Card>
            )}
          </div>

          <Card flush title={t("Players")} note={players.size > MAX_ROWS ? t("Top {n} by amount", { n: MAX_ROWS }) : undefined}>
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    {multi && <th>{t("Brand")}</th>}
                    <th>{t("Player")}</th>
                    <th>{t("CS")}</th>
                    <th className="r">{t("Times paid")}</th>
                    <th className="r">{t("Total")}</th>
                    <th className="r">{t("Average")}</th>
                    <th>{t("Last paid")}</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map(([id, p]) => {
                    const pl = info.get(id);
                    const cur = scope.brandCurrency(p.brandId);
                    return (
                      <tr key={id}>
                        {multi && <td><BrandTag id={p.brandId} /></td>}
                        <td>
                          <Link className="link font-medium" href={`/players/${id}`}>
                            {pl?.username ?? `#${id}`}
                          </Link>
                          {pl?.name && <div className="text-xs text-muted">{pl.name}</div>}
                        </td>
                        <td className="text-ink-2">{pl?.assignedTo?.name ?? "–"}</td>
                        <td className="r">{count(p.payouts)}</td>
                        <td className="r font-medium">{money(p.amount, cur)}</td>
                        <td className="r">{money(p.amount / p.payouts, cur)}</td>
                        <td className="whitespace-nowrap text-ink-2">{dt(p.last)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </>
      )}
    </div>
  );
}
