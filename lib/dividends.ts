import "server-only";

import type { DividendPeriod } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { addDays, dateOnly, monthEnd, todayStr } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { n } from "@/lib/format";
import { dailyRows, sum } from "@/lib/metrics";

export const DEFAULT_RULE = { period: "MONTHLY" as DividendPeriod, carryLoss: true, reservePercent: 0, deductFees: true, deductPromos: true, excludedCategoryIds: [] as number[] };

export async function ruleFor(brandId: number) {
  const r = await prisma.dividendRule.findUnique({ where: { brandId } });
  if (!r) return { ...DEFAULT_RULE };
  return {
    period: r.period,
    carryLoss: r.carryLoss,
    reservePercent: n(r.reservePercent),
    deductFees: r.deductFees,
    deductPromos: r.deductPromos,
    excludedCategoryIds: ((r.excludedCategoryIds as number[] | null) ?? []).map(Number),
  };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** "2026-09" or "2026-Q3" → first and last day. */
export function periodRange(p: string): { from: string; to: string } | null {
  const m = p.match(/^(\d{4})-(\d{2})$/);
  if (m) return { from: `${p}-01`, to: monthEnd(`${p}-01`) };
  const q = p.match(/^(\d{4})-Q([1-4])$/);
  if (q) {
    const startMonth = (Number(q[2]) - 1) * 3 + 1;
    const from = `${q[1]}-${String(startMonth).padStart(2, "0")}-01`;
    const to = monthEnd(`${q[1]}-${String(startMonth + 2).padStart(2, "0")}-01`);
    return { from, to };
  }
  return null;
}

export function periodLabel(from: string, to: string, locale = "en-GB") {
  if (from.slice(0, 7) === to.slice(0, 7)) return new Date(from + "T00:00:00Z").toLocaleString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  const q = Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1;
  return `Q${q} ${from.slice(0, 4)}`;
}

/** Completed periods, newest first, for the "run settlement" picker. */
export function recentPeriods(kind: DividendPeriod, howMany = 12) {
  const today = todayStr();
  const out: string[] = [];
  let y = Number(today.slice(0, 4));
  let mo = Number(today.slice(5, 7));
  if (kind === "MONTHLY") {
    for (let i = 0; i < howMany; i++) {
      mo -= 1;
      if (mo === 0) {
        mo = 12;
        y -= 1;
      }
      out.push(`${y}-${String(mo).padStart(2, "0")}`);
    }
  } else {
    let q = Math.floor((mo - 1) / 3) + 1;
    for (let i = 0; i < Math.ceil(howMany / 3); i++) {
      q -= 1;
      if (q === 0) {
        q = 4;
        y -= 1;
      }
      out.push(`${y}-Q${q}`);
    }
  }
  return out;
}

export type Preview = Awaited<ReturnType<typeof previewSettlement>>;

/** Works out a settlement without saving it, so the person can check every number first. */
export async function previewSettlement(brandId: number, from: string, to: string) {
  const [brand, rule] = await Promise.all([prisma.brand.findUniqueOrThrow({ where: { id: brandId } }), ruleFor(brandId)]);
  const t = sum(await dailyRows([brandId], { from, to }), { fees: true, promos: true, expenses: true, income: true });
  const cats = await prisma.$queryRaw<{ id: number; name: string; kind: string; amt: unknown }[]>`
    SELECT c.id, c.name, c.kind, SUM(e.amount) AS amt FROM \`Expense\` e JOIN \`ExpenseCategory\` c ON c.id = e.categoryId
    WHERE e.brandId = ${brandId} AND e.date >= ${dateOnly(from)} AND e.date <= ${dateOnly(to)}
    GROUP BY c.id, c.name, c.kind ORDER BY c.kind, c.name`;
  const excluded = new Set(rule.excludedCategoryIds);
  const categories = cats.map((c) => ({ name: c.name, kind: c.kind, amount: n(c.amt as number), counted: !excluded.has(c.id) }));
  const income = categories.filter((c) => c.kind === "INCOME" && c.counted).reduce((a, c) => a + c.amount, 0);
  const expense = categories.filter((c) => c.kind === "EXPENSE" && c.counted).reduce((a, c) => a + c.amount, 0);
  const fees = rule.deductFees ? t.fees : 0;
  const promos = rule.deductPromos ? t.promo : 0;
  const profit = r2(t.winlose + income - fees - promos - expense);

  const prev = await prisma.settlement.findFirst({ where: { brandId, periodStart: { lt: dateOnly(from) } }, orderBy: { periodStart: "desc" } });
  const carriedIn = rule.carryLoss && prev ? Math.min(n(prev.carryOut), 0) : 0;
  const base = r2(profit + carriedIn);
  let reserve = 0;
  let distributable = 0;
  let carryOut = 0;
  if (base <= 0) carryOut = rule.carryLoss ? base : 0;
  else {
    reserve = r2((base * rule.reservePercent) / 100);
    distributable = r2(base - reserve);
  }

  const holdings = await prisma.holding.findMany({
    where: { brandId, effectiveFrom: { lte: dateOnly(to) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(to) } }] },
    include: { shareholder: true },
    orderBy: { percent: "desc" },
  });
  const lines = holdings.map((h) => ({ shareholderId: h.shareholderId, name: h.shareholder.name, percent: n(h.percent), amount: r2((distributable * n(h.percent)) / 100) }));
  const allocated = lines.reduce((a, l) => a + l.percent, 0);
  const overlap = await prisma.settlement.findFirst({ where: { brandId, periodStart: { lte: dateOnly(to) }, periodEnd: { gte: dateOnly(from) } } });

  return {
    brand,
    rule,
    from,
    to,
    t,
    categories,
    fees,
    promos,
    income,
    expense,
    profit,
    prev: prev ? { id: prev.id, from: prev.periodStart.toISOString().slice(0, 10), to: prev.periodEnd.toISOString().slice(0, 10), carryOut: n(prev.carryOut) } : null,
    carriedIn,
    base,
    reserve,
    distributable,
    carryOut,
    lines,
    allocated,
    overlap: overlap ? { id: overlap.id } : null,
    unfinished: to >= todayStr(),
  };
}

export function breakdownOf(p: Preview) {
  return {
    deposits: p.t.deposit,
    withdrawals: p.t.withdraw,
    winlose: p.t.winlose,
    fees: p.t.fees,
    feesDeducted: p.rule.deductFees,
    promotions: p.t.promo,
    promotionsDeducted: p.rule.deductPromos,
    categories: p.categories,
    reservePercent: p.rule.reservePercent,
    carryLoss: p.rule.carryLoss,
    previousSettlement: p.prev,
    unallocatedPercent: Math.max(0, 100 - p.allocated),
  } satisfies Prisma.InputJsonObject;
}

export const nextDay = (d: string) => addDays(d, 1);
