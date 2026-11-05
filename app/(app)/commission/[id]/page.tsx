import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandTag } from "@/components/brand-tag";
import { RangeBar } from "@/components/range";
import { Card, Empty, Info, PageHeader, TableWrap } from "@/components/ui";
import { canSeeBrand, requirePage, seesWithdrawals } from "@/lib/auth";
import { addDays, dayStart, parseRange } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { downlinesOf, moneyBetween } from "@/lib/downlines";
import { count, d10, money, n } from "@/lib/format";
import { getT } from "@/lib/i18n-server";

/** One player's direct downlines, each with their deposits, withdrawals and win/loss in the dates (from the Commission page). */
export default async function DownlinesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("commission");
  const id = Number((await params).id);
  const sp = await searchParams;
  const player = Number.isInteger(id) ? await prisma.player.findUnique({ where: { id }, select: { id: true, brandId: true, extId: true, username: true, name: true, brand: { select: { currency: true } } } }) : null;
  if (!player || !canSeeBrand(user, player.brandId)) notFound();
  const t = await getT();
  const range = parseRange(sp, "month");
  const from = dayStart(range.from);
  const to = dayStart(addDays(range.to, 1));
  const cur = player.brand.currency;
  const seeWd = seesWithdrawals(user);

  const downs = await downlinesOf([player]);
  const [info, money0, paid] = await Promise.all([
    prisma.player.findMany({ where: { id: { in: downs.map((d) => d.id) } }, select: { id: true, username: true, name: true, registeredAt: true } }),
    moneyBetween(downs.map((d) => d.id), from, to),
    prisma.promoClaim.aggregate({ where: { playerId: id, claimedAt: { gte: from, lt: to }, promotion: { name: { contains: "commission" } } }, _sum: { amount: true } }),
  ]);
  const rows = info
    .map((p) => ({ ...p, ...(money0.get(p.id) ?? { deposit: 0, withdraw: 0 }) }))
    .sort((a, b) => b.deposit - a.deposit || b.withdraw - a.withdraw || a.username.localeCompare(b.username));
  const tot = rows.reduce((a, r) => ({ deposit: a.deposit + r.deposit, withdraw: a.withdraw + r.withdraw, depositors: a.depositors + (r.deposit > 0 ? 1 : 0) }), { deposit: 0, withdraw: 0, depositors: 0 });
  const back = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => !!e[1])).toString();
  const red = (v: number) => (v < 0 ? "text-critical-ink" : "");

  return (
    <div className="max-w-6xl">
      <Link href={`/commission${back ? `?${back}` : ""}`} className="text-sm text-ink-2 hover:underline">
        ← {t("Commission")}
      </Link>
      <PageHeader
        title={t("Downlines of {name}", { name: player.username })}
        desc={
          <>
            <BrandTag id={player.brandId} /> {player.name && <span className="text-ink-2">{player.name} · </span>}
            <Link className="link" href={`/players/${id}`}>
              {t("Player profile")}
            </Link>{" "}
            <Info>{t("Players this player referred on the platform (direct downlines only), with what they deposited and withdrew in these dates. Win/loss = deposits − withdrawals.")}</Info>
          </>
        }
      />
      <div className="mb-4">
        <RangeBar path={`/commission/${id}`} range={range} params={sp} brand={false} />
      </div>

      <div className={`mb-5 grid grid-cols-2 gap-3 ${seeWd ? "md:grid-cols-3 xl:grid-cols-6" : "md:grid-cols-4"}`}>
        {(
          [
            [t("Commission paid"), money(n(paid._sum.amount), cur), ""],
            [t("Direct downlines"), count(rows.length), ""],
            [t("Downlines who deposited"), count(tot.depositors), ""],
            [t("Downline deposits"), money(tot.deposit, cur), ""],
            ...(seeWd
              ? [
                  [t("Downline withdrawals"), money(tot.withdraw, cur), ""],
                  [t("Downline win/loss"), money(tot.deposit - tot.withdraw, cur), red(tot.deposit - tot.withdraw)],
                ]
              : []),
          ] as [string, string, string][]
        ).map(([l, v, c]) => (
          <div key={l} className="card p-3.5">
            <div className="text-xs text-ink-2">{l}</div>
            <div className={`mt-1 text-lg font-semibold whitespace-nowrap ${c}`}>{v}</div>
          </div>
        ))}
      </div>

      <Card flush title={t("Downlines")}>
        {rows.length === 0 ? (
          <Empty title={t("No downlines")}>{player.extId ? t("Nobody on the platform lists this player as their referrer.") : t("This player isn't linked to the platform yet.")}</Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("Player")}</th>
                  <th>{t("Registered")}</th>
                  <th className="r">{t("Deposits")}</th>
                  {seeWd && <th className="r">{t("Withdrawals")}</th>}
                  {seeWd && <th className="r">{t("Win/Loss")}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="link font-medium" href={`/players/${r.id}`}>
                        {r.username}
                      </Link>
                      {r.name && <div className="text-xs text-muted">{r.name}</div>}
                    </td>
                    <td className="whitespace-nowrap text-ink-2">{r.registeredAt ? d10(r.registeredAt) : "–"}</td>
                    <td className="r">{money(r.deposit, cur)}</td>
                    {seeWd && <td className="r">{money(r.withdraw, cur)}</td>}
                    {seeWd && <td className={`r font-medium ${red(r.deposit - r.withdraw)}`}>{money(r.deposit - r.withdraw, cur)}</td>}
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
