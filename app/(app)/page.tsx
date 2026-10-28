import Link from "next/link";
import { Prisma } from "@prisma/client";
import { RangeBar } from "@/components/range";
import { TrendChart } from "@/components/trend-chart";
import { Card, Delta, Info, PageHeader, TableWrap } from "@/components/ui";
import { can, requirePage } from "@/lib/auth";
import { addDays, allDaysOf, daysBetween, dayStart, parseRange, previousRange, todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { count, money0, n, pct } from "@/lib/format";
import { getT } from "@/lib/i18n-server";
import { converted, dailyRows, groupBy, playerCounts, sum } from "@/lib/metrics";
import { queryPlayers } from "@/lib/player-query";
import { judge, promoStats } from "@/lib/promo-stats";
import { getScope } from "@/lib/scope";
import { getSettings } from "@/lib/settings";

type Alert = { level: "critical" | "serious" | "warning" | "good"; title: string; detail: string; href: string; action: string };

const LEVEL = {
  critical: { color: "var(--critical)", ink: "#fff", icon: "!" },
  serious: { color: "var(--serious)", ink: "#fff", icon: "!" },
  warning: { color: "var(--warning)", ink: "#0b0b0b", icon: "i" },
  good: { color: "var(--good)", ink: "#fff", icon: "✓" },
};

function since(days: number) {
  return new Date(Date.now() - days * 86400_000);
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("dashboard");
  const sp = await searchParams;
  const [scope, settings, t] = await Promise.all([getScope(user), getSettings(), getT()]);
  const range = parseRange(sp, "month");
  const prev = previousRange(range);
  const ids = scope.brandIds;
  const cur = scope.currency;
  const today = todayStr();
  // Short periods still get a readable chart: show at least the last 14 days.
  const chartRange = daysBetween(range.from, range.to) < 6 ? { from: addDays(range.to, -13), to: range.to } : range;
  const last7 = { from: addDays(today, -6), to: today };

  const seeBalances = can(user, "reconcile");
  const [rows, prevRows, chartRows, players, lastChecks, busyAccounts, promos, promoList, churnTop, lastTxn, unpaid] = await Promise.all([
    dailyRows(ids, range).then((r) => converted(r, scope.rate)),
    dailyRows(ids, prev).then((r) => converted(r, scope.rate)),
    chartRange === range ? Promise.resolve(null) : dailyRows(ids, chartRange).then((r) => converted(r, scope.rate)),
    playerCounts(ids, range, "all"),
    seeBalances ? prisma.balanceCheck.findMany({ where: { channel: { active: true } }, orderBy: { at: "desc" }, distinct: ["channelId"], include: { channel: true } }) : Promise.resolve([]),
    seeBalances
      ? prisma.txn.groupBy({ by: ["channelId"], where: { channelId: { not: null }, txnAt: { gte: dayStart(last7.from) } } })
      : Promise.resolve([]),
    promoStats(ids, range, settings.promoWindowDays),
    ids.length ? prisma.promotion.findMany({ where: { brandId: { in: ids } }, select: { id: true, name: true, brandId: true } }) : Promise.resolve([]),
    queryPlayers(settings.tierScoring, { brandIds: ids, hasDeposit: true, tierRank: 0, contacted: false, idleBefore: since(settings.churnDays[0] ?? 7), limit: 0, offset: 0 }),
    ids.length
      ? prisma.$queryRaw<{ brandId: number; last: Date | null }[]>`SELECT brandId, MAX(createdAt) AS last FROM \`Txn\` WHERE brandId IN (${Prisma.join(ids)}) GROUP BY brandId`
      : Promise.resolve([]),
    can(user, "dividends")
      ? prisma.settlementLine.findMany({ where: { settlement: { brandId: { in: ids } } }, select: { amount: true, paid: true, settlement: { select: { brandId: true } } } })
      : Promise.resolve(null),
  ]);

  const tot = sum(rows, settings.profit);
  const before = sum(prevRows, settings.profit);
  const pc = [...players.values()].reduce((a, p) => ({ depositors: a.depositors + p.depositors, ftd: a.ftd + p.ftd }), { depositors: 0, ftd: 0 });
  const chart = allDaysOf(chartRange).map((day) => {
    const list = (chartRows ?? rows).filter((r) => r.day === day);
    return { day, dep: list.reduce((a, r) => a + r.deposit, 0), wd: list.reduce((a, r) => a + r.withdraw, 0) };
  });
  const byBrand = groupBy(rows, (r) => r.brandId);
  const brandTotals = scope.brands.filter((b) => ids.includes(b.id)).map((b) => ({ b, t: sum(byBrand.get(b.id) ?? [], settings.profit) }));

  // ---- things the system noticed ----
  const alerts: Alert[] = [];
  // Bank/PG balances: the latest real balance per account, and busy accounts nobody has checked for a day.
  const off = lastChecks.filter((c) => !c.resolved && Math.abs(n(c.actual) - n(c.expected)) > settings.reconTolerance);
  if (off.length)
    alerts.push({
      level: "critical",
      title: t("{n} accounts don't match the real balance", { n: off.length }),
      detail: off
        .slice(0, 3)
        .map((c) => `${c.channel.name} ${n(c.actual) - n(c.expected) > 0 ? "+" : ""}${money0(n(c.actual) - n(c.expected), c.channel.currency)}`)
        .join(" · "),
      href: "/reconcile",
      action: t("Reconcile"),
    });
  const checkedRecently = new Set(lastChecks.filter((c) => c.at > since(1)).map((c) => c.channelId));
  const unchecked = busyAccounts.filter((a) => a.channelId != null && !checkedRecently.has(a.channelId)).length;
  if (unchecked)
    alerts.push({
      level: "warning",
      title: t("{n} accounts not checked in the last 24 hours", { n: unchecked }),
      detail: t("Enter their real balance to confirm the money is all there"),
      href: "/reconcile",
      action: t("Reconcile"),
    });

  const losers = promoList
    .map((p) => ({ p, j: judge(promos.get(p.id) ?? { claims: 0, claimers: 0, given: 0, dep: 0, depCount: 0, wd: 0, wdCount: 0 }, settings.promoAdjustPercent) }))
    .filter((x) => x.j.verdict === "cancel")
    .sort((a, b) => a.j.net * scope.rate(a.p.brandId) - b.j.net * scope.rate(b.p.brandId));
  if (losers.length)
    alerts.push({
      level: "serious",
      title: losers.length === 1 ? t("“{name}” is losing money", { name: losers[0].p.name }) : t("{n} promotions are losing money", { n: losers.length }),
      detail: t("Worst: {name}, {amount} after bonuses", { name: losers[0].p.name, amount: money0(losers[0].j.net * scope.rate(losers[0].p.brandId), cur) }),
      href: "/promotions",
      action: t("View promotions"),
    });

  if (churnTop.total)
    alerts.push({
      level: "warning",
      title: t("{n} top players have stopped depositing", { n: churnTop.total }),
      detail: t("No deposit for {d}+ days and nobody has contacted them yet", { d: settings.churnDays[0] ?? 7 }),
      href: "/churn?tier=0&status=open",
      action: t("Follow up"),
    });

  const stale = lastTxn.filter((x) => !x.last || x.last < since(2));
  for (const s of stale.slice(0, 2))
    alerts.push({
      level: "warning",
      title: t("No new data for {brand}", { brand: scope.brandName(s.brandId) }),
      detail: t("Nothing has been entered or imported for 2 days"),
      href: "/entry",
      action: t("Enter data"),
    });

  for (const b of brandTotals.filter((x) => x.t.profit < 0 && x.t.deposit > 0).slice(0, 2))
    alerts.push({
      level: "critical",
      title: t("{brand} is making a loss", { brand: b.b.name }),
      detail: t("Net profit {amount} in this period", { amount: money0(b.t.profit, cur) }),
      href: "/expenses",
      action: t("Profit statement"),
    });

  const csBest = ids.length
    ? await prisma.$queryRaw<{ staffId: number; returned: bigint }[]>`
        SELECT c.staffId, COUNT(DISTINCT c.playerId) AS returned FROM \`ContactLog\` c JOIN \`Player\` p ON p.id = c.playerId
        WHERE p.brandId IN (${Prisma.join(ids)}) AND c.contactedAt >= ${dayStart(range.from)} AND c.contactedAt < ${dayStart(addDays(range.to, 1))}
          AND EXISTS (SELECT 1 FROM \`Txn\` t WHERE t.playerId = c.playerId AND t.type = 'DEPOSIT' AND t.txnAt > c.contactedAt AND t.txnAt <= DATE_ADD(c.contactedAt, INTERVAL ${settings.recallDays} DAY))
        GROUP BY c.staffId ORDER BY returned DESC LIMIT 1`
    : [];
  if (csBest[0]) {
    const name = (await prisma.user.findUnique({ where: { id: csBest[0].staffId }, select: { name: true } }))?.name ?? "";
    alerts.push({ level: "good", title: t("{name} brought back {n} players", { name, n: Number(csBest[0].returned) }), detail: t("Best CS result in this period"), href: "/cs", action: t("CS results") });
  }
  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  const unpaidTotal = unpaid ? unpaid.reduce((a, l) => a + (n(l.amount) - n(l.paid)) * scope.rate(l.settlement.brandId), 0) : 0;
  const margin = tot.deposit ? (tot.profit / tot.deposit) * 100 : 0;

  const tiles = [
    { label: t("Deposits"), value: money0(tot.deposit, cur), cur: tot.deposit, prev: before.deposit, sub: t("{n} deposits · avg {avg}", { n: count(tot.depositCount), avg: money0(tot.depositCount ? tot.deposit / tot.depositCount : 0, cur) }) },
    { label: t("Withdrawals"), value: money0(tot.withdraw, cur), cur: tot.withdraw, prev: before.withdraw, sub: t("{n} withdrawals", { n: count(tot.withdrawCount) }), up: false },
    { label: t("Win/Loss"), value: money0(tot.winlose, cur), cur: tot.winlose, prev: before.winlose, sub: t("{p} of deposits", { p: pct(tot.deposit ? (tot.winlose / tot.deposit) * 100 : 0) }) },
    { label: t("Costs"), value: money0(tot.cost, cur), cur: tot.cost, prev: before.cost, sub: t("Fees, promotions and expenses"), up: false },
    { label: t("Players"), value: count(pc.depositors), cur: pc.depositors, prev: 0, sub: t("depositing · {n} first-time", { n: count(pc.ftd) }) },
  ];

  return (
    <div className="max-w-[1400px] space-y-5">
      <PageHeader
        title={t("Dashboard")}
        desc={`${scope.current ? scope.current.name : t("All brands")} · ${range.from} ~ ${range.to}${scope.current ? "" : ` · ${cur}`}`}
        actions={<RangeBar path="/" range={range} params={sp} />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((x) => (
          <div key={x.label} className="card p-4">
            <div className="text-xs text-ink-2">{x.label}</div>
            <div className={`mt-1 text-xl font-semibold ${x.cur < 0 ? "text-critical-ink" : ""}`}>{x.value}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
              {x.prev ? <Delta cur={x.cur} prev={x.prev} goodWhenUp={x.up !== false} /> : null}
              <span>{x.sub}</span>
            </div>
          </div>
        ))}
        <div className="col-span-2 rounded-xl bg-[#1c5cab] p-4 text-white md:col-span-1">
          <div className="text-xs text-white/75">{t("Net profit")}</div>
          <div className="mt-1 text-xl font-semibold">{money0(tot.profit, cur)}</div>
          <div className="mt-1 text-xs text-white/75">
            {before.profit ? `${tot.profit >= before.profit ? "▲" : "▼"} ${Math.abs(((tot.profit - before.profit) / Math.abs(before.profit)) * 100).toFixed(1)}% · ` : ""}
            {t("Margin {p}", { p: pct(margin) })}
          </div>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted">{t("▲▼ compared with the previous {n} days", { n: daysBetween(range.from, range.to) + 1 })}</p>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card title={t("Daily deposits & withdrawals")} note={chartRange !== range ? t("Showing last 14 days") : undefined}>
          <TrendChart data={chart} currency={cur} />
        </Card>
        <Card title={t("Things to look at")} note={alerts.length ? String(alerts.length) : undefined}>
          {alerts.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-2">{t("Nothing needs attention right now.")}</p>
          ) : (
            <ul className="space-y-2.5">
              {alerts.map((a, i) => (
                <li key={i} className="flex gap-3 rounded-lg bg-surface-2 p-3">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold" style={{ background: LEVEL[a.level].color, color: LEVEL[a.level].ink }}>
                    {LEVEL[a.level].icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{a.title}</div>
                    <div className="mt-0.5 text-xs text-ink-2">{a.detail}</div>
                    <Link href={a.href} className="mt-1.5 inline-block text-xs font-medium text-brand-ink hover:underline">
                      {a.action} →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        {brandTotals.length > 1 ? (
          <Card flush title={t("Brand comparison")} action={<Link className="link" href="/reports?group=brand">{t("Full report")} →</Link>}>
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("Brand")}</th>
                    <th className="r">{t("Deposits")}</th>
                    <th className="r">{t("Withdrawals")}</th>
                    <th className="r">{t("Win/Loss")}</th>
                    <th className="r">{t("Costs")}</th>
                    <th className="r">{t("Net profit")}</th>
                    <th className="r">{t("Margin")}</th>
                  </tr>
                </thead>
                <tbody>
                  {brandTotals.map(({ b, t: x }) => {
                    const maxDep = Math.max(...brandTotals.map((y) => y.t.deposit), 1);
                    return (
                      <tr key={b.id}>
                        <td className="font-medium whitespace-nowrap">{b.name}</td>
                        <td className="r">
                          <span className="inline-flex items-center gap-2">
                            <span className="h-2 rounded-r-[4px] bg-[var(--series-1)]" style={{ width: `${(x.deposit / maxDep) * 64}px` }} />
                            {money0(x.deposit, cur)}
                          </span>
                        </td>
                        <td className="r">{money0(x.withdraw, cur)}</td>
                        <td className="r">{money0(x.winlose, cur)}</td>
                        <td className="r">{money0(x.cost, cur)}</td>
                        <td className={`r font-medium ${x.profit < 0 ? "text-critical-ink" : ""}`}>{money0(x.profit, cur)}</td>
                        <td className="r">{pct(x.deposit ? (x.profit / x.deposit) * 100 : 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{t("Total")}</td>
                    <td className="r">{money0(tot.deposit, cur)}</td>
                    <td className="r">{money0(tot.withdraw, cur)}</td>
                    <td className="r">{money0(tot.winlose, cur)}</td>
                    <td className="r">{money0(tot.cost, cur)}</td>
                    <td className="r">{money0(tot.profit, cur)}</td>
                    <td className="r">{pct(margin)}</td>
                  </tr>
                </tfoot>
              </table>
            </TableWrap>
          </Card>
        ) : (
          <Card title={t("Where the money went")} note={`${range.from} ~ ${range.to}`}>
            <ul className="space-y-2 text-sm">
              {[
                [t("Win/Loss"), tot.winlose],
                [t("Other income"), settings.profit.income ? tot.income : 0],
                [t("PG / bank fees"), settings.profit.fees ? -tot.fees : 0],
                [t("Promotions"), settings.profit.promos ? -tot.promo : 0],
                [t("Expenses"), settings.profit.expenses ? -tot.expense : 0],
              ].map(([l, v]) => (
                <li key={String(l)} className="flex justify-between border-b border-line pb-2">
                  <span className="text-ink-2">{l}</span>
                  <span className={`tabular-nums ${Number(v) < 0 ? "text-critical-ink" : ""}`}>{money0(Number(v), cur)}</span>
                </li>
              ))}
              <li className="flex justify-between font-semibold">
                <span>{t("Net profit")}</span>
                <span className="tabular-nums">{money0(tot.profit, cur)}</span>
              </li>
            </ul>
          </Card>
        )}
        <div className="space-y-5">
          <Card title={t("Follow-up")} action={<Info>{t("Players without a deposit for the days set in Settings → Churn & CS.")}</Info>}>
            <ChurnCounts ids={ids} />
          </Card>
          {unpaid && (
            <Card title={t("Dividends")}>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-2">{t("Still to pay shareholders")}</span>
                <span className={`text-lg font-semibold ${unpaidTotal > 0.005 ? "text-warning-ink" : ""}`}>{money0(unpaidTotal, cur)}</span>
              </div>
              <Link href="/dividends" className="mt-2 inline-block text-xs font-medium text-brand-ink hover:underline">
                {t("Open dividends")} →
              </Link>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

async function ChurnCounts({ ids }: { ids: number[] }) {
  const [settings, t] = await Promise.all([getSettings(), getT()]);
  const days = settings.churnDays.length ? settings.churnDays : [7, 15, 30];
  const counts = await Promise.all(
    days.map((d, i) =>
      queryPlayers(settings.tierScoring, { brandIds: ids, hasDeposit: true, idleBefore: since(d), idleAfter: i < days.length - 1 ? since(days[i + 1]) : undefined, limit: 0, offset: 0 }).then((r) => r.total),
    ),
  );
  return (
    <ul className="space-y-2">
      {days.map((d, i) => (
        <li key={d}>
          <Link href={`/churn?band=${i}`} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
            <span className="text-ink-2">{i < days.length - 1 ? t("{a}–{b} days", { a: d, b: days[i + 1] - 1 }) : t("{a}+ days", { a: d })}</span>
            <span className={`font-semibold tabular-nums ${i === days.length - 1 && counts[i] ? "text-critical-ink" : ""}`}>{count(counts[i])}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
