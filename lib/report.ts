import "server-only";

import { allDaysOf, type Range } from "@/lib/dates";
import { bucketOf, converted, dailyRows, groupBy, playerCounts, sum, type Totals } from "@/lib/metrics";
import type { Scope } from "@/lib/scope";
import { tk, type T } from "@/lib/i18n";
import type { Settings } from "@/lib/settings";

export type Group = "day" | "week" | "month" | "brand" | "brandMonth";

export const GROUPS: { key: Group; label: string; col: string }[] = [
  { key: "day", label: tk("By day"), col: tk("Day") },
  { key: "week", label: tk("By week"), col: tk("Week") },
  { key: "month", label: tk("By month"), col: tk("Month") },
  { key: "brand", label: tk("By brand"), col: tk("Brand") },
  { key: "brandMonth", label: tk("By brand and month"), col: tk("Brand · month") },
];

type Line = Totals & { depositors: number; ftd: number };

export const METRICS: { key: string; label: string; kind: "money" | "count" | "pct"; explain: string; get: (t: Line) => number; goodWhenNegative?: boolean }[] = [
  { key: "deposit", label: tk("Deposits"), kind: "money", explain: tk("Total amount deposited."), get: (t) => t.deposit },
  { key: "depositCount", label: tk("Deposit count"), kind: "count", explain: tk("Number of deposits."), get: (t) => t.depositCount },
  { key: "avgDeposit", label: tk("Avg deposit"), kind: "money", explain: tk("Deposits ÷ deposit count."), get: (t) => (t.depositCount ? t.deposit / t.depositCount : 0) },
  { key: "depositors", label: tk("Depositing players"), kind: "count", explain: tk("Players who deposited at least once in the period."), get: (t) => t.depositors },
  { key: "ftd", label: tk("First-time depositors"), kind: "count", explain: tk("Players whose very first deposit was in the period."), get: (t) => t.ftd },
  { key: "withdraw", label: tk("Withdrawals"), kind: "money", explain: tk("Total amount withdrawn."), get: (t) => t.withdraw },
  { key: "withdrawCount", label: tk("Withdrawal count"), kind: "count", explain: tk("Number of withdrawals."), get: (t) => t.withdrawCount },
  { key: "winlose", label: tk("Win/Loss"), kind: "money", explain: tk("Deposits − withdrawals."), get: (t) => t.winlose },
  { key: "wlPct", label: tk("W/L %"), kind: "pct", explain: tk("Win/Loss as a % of deposits."), get: (t) => (t.deposit ? (t.winlose / t.deposit) * 100 : 0) },
  { key: "bet", label: tk("Bets"), kind: "money", explain: tk("Total bets placed, read from the platform API (connected brands only)."), get: (t) => t.bet },
  { key: "gameWl", label: tk("Game W/L (platform)"), kind: "money", explain: tk("Win/loss on games as the platform reports it (connected brands only)."), get: (t) => t.gameWl },
  { key: "fees", label: tk("PG/bank fees"), kind: "money", explain: tk("Each PG/bank's fee rate applied to the deposits it received."), get: (t) => t.fees },
  { key: "promo", label: tk("Promotions"), kind: "money", explain: tk("Bonus amounts from promotion claims."), get: (t) => t.promo },
  { key: "expense", label: tk("Expenses"), kind: "money", explain: tk("Salary, advertising and other expense categories."), get: (t) => t.expense },
  { key: "income", label: tk("Other income"), kind: "money", explain: tk("Income categories, e.g. provider rebates."), get: (t) => t.income },
  { key: "cost", label: tk("Total costs"), kind: "money", explain: tk("The costs counted in net profit (see Settings → General)."), get: (t) => t.cost },
  { key: "profit", label: tk("Net profit"), kind: "money", explain: tk("Win/Loss + other income − costs, as set in Settings → General."), get: (t) => t.profit },
  { key: "margin", label: tk("Margin"), kind: "pct", explain: tk("Net profit as a % of deposits."), get: (t) => (t.deposit ? (t.profit / t.deposit) * 100 : 0) },
];

export const DEFAULT_COLS = ["deposit", "depositCount", "withdraw", "withdrawCount", "winlose", "fees", "promo", "expense", "profit", "margin"];

export function parseCols(v?: string) {
  const keys = (v ?? "").split(",").filter((k) => METRICS.some((m) => m.key === k));
  return keys.length ? METRICS.filter((m) => keys.includes(m.key)).map((m) => m.key) : DEFAULT_COLS;
}

export async function buildReport(scope: Scope, settings: Settings, range: Range, group: Group, t: T = (x) => x) {
  const { brandIds } = scope;
  const rows = converted(await dailyRows(brandIds, range), scope.rate);
  const bucket = group === "day" ? "day" : group === "week" ? "week" : "month";
  const [pc, pcAll] = await Promise.all([playerCounts(brandIds, range, group === "brand" ? "all" : bucket), playerCounts(brandIds, range, "all")]);

  const line = (rs: typeof rows, players: (brandId: number) => { depositors: number; ftd: number }, ids: number[]): Line => {
    const t = sum(rs, settings.profit);
    let depositors = 0;
    let ftd = 0;
    for (const id of ids) {
      const p = players(id);
      depositors += p.depositors;
      ftd += p.ftd;
    }
    return { ...t, depositors, ftd };
  };
  const pick = (map: typeof pc, key: string) => map.get(key) ?? { depositors: 0, ftd: 0 };

  let lines: { key: string; label: string; t: Line }[] = [];
  if (group === "brand") {
    const g = groupBy(rows, (r) => r.brandId);
    lines = brandIds.map((id) => ({ key: String(id), label: scope.brandName(id), t: line(g.get(id) ?? [], (b) => pick(pc, `${b}|all`), [id]) }));
  } else if (group === "brandMonth") {
    const g = groupBy(rows, (r) => `${r.brandId}|${r.day.slice(0, 7)}`);
    const months = [...new Set(allDaysOf(range).map((d) => d.slice(0, 7)))];
    for (const id of brandIds)
      for (const m of months) {
        const k = `${id}|${m}`;
        lines.push({ key: k, label: `${scope.brandName(id)} · ${m}`, t: line(g.get(k) ?? [], (b) => pick(pc, `${b}|${m}`), [id]) });
      }
  } else {
    const g = groupBy(rows, (r) => bucketOf(r.day, bucket));
    const buckets = [...new Set(allDaysOf(range).map((d) => bucketOf(d, bucket)))];
    lines = buckets.map((b) => ({
      key: b,
      label: bucket === "week" ? t("Week of {d}", { d: b }) : b,
      t: line(g.get(b) ?? [], (id) => pick(pc, `${id}|${b}`), brandIds),
    }));
  }
  const total = line(rows, (id) => pick(pcAll, `${id}|all`), brandIds);
  return { lines, total };
}
