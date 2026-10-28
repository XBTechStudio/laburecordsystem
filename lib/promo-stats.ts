import "server-only";

import { Prisma } from "@prisma/client";
import { addDays, dayStart, type Range } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { n } from "@/lib/format";

export type PromoStat = { claims: number; claimers: number; given: number; dep: number; depCount: number; wd: number; wdCount: number };

export const emptyStat = (): PromoStat => ({ claims: 0, claimers: 0, given: 0, dep: 0, depCount: 0, wd: 0, wdCount: 0 });

/**
 * Per promotion: what was given in the period, and what its claimers deposited and withdrew
 * from their first claim until `windowDays` after their last claim. Amounts are in each brand's currency.
 */
export async function promoStats(brandIds: number[], range: Range, windowDays: number) {
  const stats = new Map<number, PromoStat>();
  if (!brandIds.length) return stats;
  const t0 = dayStart(range.from);
  const t1 = dayStart(addDays(range.to, 1));
  const list = Prisma.join(brandIds);
  const [claims, txns] = await Promise.all([
    prisma.$queryRaw<{ pid: number; claims: bigint; claimers: bigint; given: unknown }[]>`
      SELECT c.promotionId AS pid, COUNT(*) AS claims, COUNT(DISTINCT c.playerId) AS claimers, SUM(c.amount) AS given
      FROM \`PromoClaim\` c JOIN \`Promotion\` p ON p.id = c.promotionId
      WHERE p.brandId IN (${list}) AND c.claimedAt >= ${t0} AND c.claimedAt < ${t1}
      GROUP BY c.promotionId`,
    prisma.$queryRaw<{ pid: number; type: string; amt: unknown; cnt: bigint }[]>`
      SELECT w.pid, t.type, SUM(t.amount) AS amt, COUNT(*) AS cnt
      FROM (
        SELECT c.promotionId AS pid, c.playerId, MIN(c.claimedAt) AS f, MAX(c.claimedAt) AS l
        FROM \`PromoClaim\` c JOIN \`Promotion\` p ON p.id = c.promotionId
        WHERE p.brandId IN (${list}) AND c.claimedAt >= ${t0} AND c.claimedAt < ${t1}
        GROUP BY c.promotionId, c.playerId
      ) w JOIN \`Txn\` t ON t.playerId = w.playerId AND t.txnAt >= w.f AND t.txnAt < DATE_ADD(w.l, INTERVAL ${windowDays} DAY)
      GROUP BY w.pid, t.type`,
  ]);
  const get = (pid: number) => {
    let s = stats.get(pid);
    if (!s) stats.set(pid, (s = emptyStat()));
    return s;
  };
  for (const c of claims) Object.assign(get(c.pid), { claims: Number(c.claims), claimers: Number(c.claimers), given: n(c.given as number) });
  for (const row of txns) {
    const s = get(row.pid);
    if (row.type === "DEPOSIT") {
      s.dep = n(row.amt as number);
      s.depCount = Number(row.cnt);
    } else {
      s.wd = n(row.amt as number);
      s.wdCount = Number(row.cnt);
    }
  }
  return stats;
}

/** W/L after promo, cost ratio and the keep/adjust/cancel suggestion. */
export function judge(s: PromoStat, adjustPercent: number) {
  const net = s.dep - s.wd - s.given;
  const cost = s.dep ? (s.given / s.dep) * 100 : s.given ? Infinity : 0;
  const verdict = s.claims === 0 ? "none" : net < 0 ? "cancel" : cost > adjustPercent ? "adjust" : "keep";
  return { net, cost, verdict } as const;
}
