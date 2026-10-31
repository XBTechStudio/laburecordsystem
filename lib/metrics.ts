import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addDays, dayStart, dateOnly, mondayOf, type Range } from "@/lib/dates";
import { n } from "@/lib/format";
import type { Settings } from "@/lib/settings";

/** One brand, one Malaysia day, in that brand's own currency. */
export type DayRow = {
  brandId: number;
  day: string;
  deposit: number;
  depositCount: number;
  withdraw: number;
  withdrawCount: number;
  fees: number;
  promo: number;
  expense: number;
  income: number;
  /** From the platform API (connected brands only): total bets and the platform's game win/loss. */
  bet: number;
  gameWl: number;
};

const MONEY: (keyof DayRow)[] = ["deposit", "withdraw", "fees", "promo", "expense", "income", "bet", "gameWl"];
const NUMS = ["deposit", "depositCount", "withdraw", "withdrawCount", "fees", "promo", "expense", "income", "bet", "gameWl"] as const;

export type Totals = Record<(typeof NUMS)[number], number> & { winlose: number; cost: number; profit: number };

const iso = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export async function dailyRows(brandIds: number[], r: Range): Promise<DayRow[]> {
  if (!brandIds.length) return [];
  const ids = Prisma.join(brandIds);
  const t0 = dayStart(r.from);
  const t1 = dayStart(addDays(r.to, 1));
  const d0 = dateOnly(r.from);
  const d1 = dateOnly(r.to);

  const [txns, fees, claims, exps, bets] = await Promise.all([
    prisma.$queryRaw<{ brandId: number; d: Date; type: string; amt: unknown; cnt: bigint }[]>`
      SELECT brandId, DATE(DATE_ADD(txnAt, INTERVAL 8 HOUR)) AS d, type, SUM(amount) AS amt, COUNT(*) AS cnt
      FROM \`Txn\` WHERE brandId IN (${ids}) AND txnAt >= ${t0} AND txnAt < ${t1}
      GROUP BY brandId, d, type`,
    // PG/bank fees: each account's fee rate applied to the deposits it received.
    prisma.$queryRaw<{ brandId: number; d: Date; fee: unknown }[]>`
      SELECT t.brandId, DATE(DATE_ADD(t.txnAt, INTERVAL 8 HOUR)) AS d, SUM(t.amount * c.feePercent / 100 + c.feeFixed) AS fee
      FROM \`Txn\` t JOIN \`PayChannel\` c ON c.id = t.channelId
      WHERE t.type = 'DEPOSIT' AND t.brandId IN (${ids}) AND t.txnAt >= ${t0} AND t.txnAt < ${t1}
      GROUP BY t.brandId, d`,
    prisma.$queryRaw<{ brandId: number; d: Date; amt: unknown }[]>`
      SELECT p.brandId, DATE(DATE_ADD(c.claimedAt, INTERVAL 8 HOUR)) AS d, SUM(c.amount) AS amt
      FROM \`PromoClaim\` c JOIN \`Promotion\` p ON p.id = c.promotionId
      WHERE p.brandId IN (${ids}) AND c.claimedAt >= ${t0} AND c.claimedAt < ${t1}
      GROUP BY p.brandId, d`,
    prisma.$queryRaw<{ brandId: number; d: Date; kind: string; amt: unknown }[]>`
      SELECT e.brandId, e.date AS d, c.kind, SUM(e.amount) AS amt
      FROM \`Expense\` e JOIN \`ExpenseCategory\` c ON c.id = e.categoryId
      WHERE e.brandId IN (${ids}) AND e.date >= ${d0} AND e.date <= ${d1}
      GROUP BY e.brandId, d, c.kind`,
    // Daily bets come per platform day and are used as they are.
    prisma.$queryRaw<{ brandId: number; d: Date; bet: unknown; wl: unknown }[]>`
      SELECT brandId, day AS d, SUM(bet) AS bet, SUM(winlose) AS wl
      FROM \`PlayerDay\` WHERE brandId IN (${ids}) AND day >= ${d0} AND day <= ${d1}
      GROUP BY brandId, day`,
  ]);

  const map = new Map<string, DayRow>();
  const get = (brandId: number, d: Date) => {
    const k = `${brandId}|${iso(d)}`;
    let row = map.get(k);
    if (!row) {
      row = { brandId, day: iso(d), ...(Object.fromEntries(NUMS.map((x) => [x, 0])) as Record<(typeof NUMS)[number], number>) };
      map.set(k, row);
    }
    return row;
  };

  for (const t of txns) {
    const row = get(t.brandId, t.d);
    if (t.type === "DEPOSIT") {
      row.deposit += n(t.amt as number);
      row.depositCount += Number(t.cnt);
    } else {
      row.withdraw += n(t.amt as number);
      row.withdrawCount += Number(t.cnt);
    }
  }
  for (const f of fees) get(f.brandId, f.d).fees += n(f.fee as number);
  for (const c of claims) get(c.brandId, c.d).promo += n(c.amt as number);
  for (const b of bets) {
    const row = get(b.brandId, b.d);
    row.bet += n(b.bet as number);
    row.gameWl += n(b.wl as number);
  }
  for (const e of exps) {
    const row = get(e.brandId, e.d);
    if (e.kind === "INCOME") row.income += n(e.amt as number);
    else row.expense += n(e.amt as number);
  }
  return [...map.values()].sort((a, b) => (a.day === b.day ? a.brandId - b.brandId : a.day < b.day ? -1 : 1));
}

/** Converts every money field with the page's rate (1 when one brand is selected). */
export function converted(rows: DayRow[], rate: (brandId: number) => number): DayRow[] {
  return rows.map((r) => {
    const k = rate(r.brandId);
    if (k === 1) return r;
    const c = { ...r };
    for (const f of MONEY) (c[f] as number) = (r[f] as number) * k;
    return c;
  });
}

export function sum(rows: DayRow[], profit: Settings["profit"]): Totals {
  const t = Object.fromEntries(NUMS.map((x) => [x, 0])) as Record<(typeof NUMS)[number], number>;
  for (const r of rows) for (const k of NUMS) t[k] += r[k];
  const winlose = t.deposit - t.withdraw;
  const cost = (profit.fees ? t.fees : 0) + (profit.promos ? t.promo : 0) + (profit.expenses ? t.expense : 0);
  return { ...t, winlose, cost, profit: winlose + (profit.income ? t.income : 0) - cost };
}

export function groupBy<K>(rows: DayRow[], key: (r: DayRow) => K) {
  const m = new Map<K, DayRow[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export type Bucket = "day" | "week" | "month";

export function bucketOf(day: string, b: Bucket) {
  if (b === "week") return mondayOf(day);
  if (b === "month") return day.slice(0, 7);
  return day;
}

export function allDays(r: Range) {
  const out: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
  return out;
}

const BUCKET_SQL: Record<Bucket | "all", Prisma.Sql> = {
  day: Prisma.sql`DATE_FORMAT(DATE_ADD(txnAt, INTERVAL 8 HOUR), '%Y-%m-%d')`,
  week: Prisma.sql`DATE_FORMAT(DATE_SUB(DATE(DATE_ADD(txnAt, INTERVAL 8 HOUR)), INTERVAL WEEKDAY(DATE_ADD(txnAt, INTERVAL 8 HOUR)) DAY), '%Y-%m-%d')`,
  month: Prisma.sql`DATE_FORMAT(DATE_ADD(txnAt, INTERVAL 8 HOUR), '%Y-%m')`,
  all: Prisma.sql`'all'`,
};

/** Distinct depositing players and first-time depositors per brand and bucket. Key: `${brandId}|${bucket}`. */
export async function playerCounts(brandIds: number[], r: Range, bucket: Bucket | "all") {
  const out = new Map<string, { depositors: number; ftd: number }>();
  if (!brandIds.length) return out;
  const ids = Prisma.join(brandIds);
  const t0 = dayStart(r.from);
  const t1 = dayStart(addDays(r.to, 1));
  const b = BUCKET_SQL[bucket];
  const ftdB = Prisma.raw(b.sql.replaceAll("txnAt", "firstDepositAt"));
  const [dep, ftd] = await Promise.all([
    prisma.$queryRaw<{ brandId: number; b: string; c: bigint }[]>`
      SELECT brandId, ${b} AS b, COUNT(DISTINCT playerId) AS c FROM \`Txn\`
      WHERE type = 'DEPOSIT' AND brandId IN (${ids}) AND txnAt >= ${t0} AND txnAt < ${t1}
      GROUP BY brandId, b`,
    prisma.$queryRaw<{ brandId: number; b: string; c: bigint }[]>`
      SELECT brandId, ${ftdB} AS b, COUNT(*) AS c FROM \`Player\`
      WHERE brandId IN (${ids}) AND firstDepositAt >= ${t0} AND firstDepositAt < ${t1}
      GROUP BY brandId, b`,
  ]);
  const get = (k: string) => out.get(k) ?? (out.set(k, { depositors: 0, ftd: 0 }), out.get(k)!);
  for (const x of dep) get(`${x.brandId}|${x.b}`).depositors = Number(x.c);
  for (const x of ftd) get(`${x.brandId}|${x.b}`).ftd = Number(x.c);
  return out;
}
