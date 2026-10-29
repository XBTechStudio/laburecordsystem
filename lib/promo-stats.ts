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

export type TrackStat = { reminded: number; contacted: number; reachedAfter: number; eligible: number; claimed: number; claimedBonus: number; expired: number; pending: number };

export const emptyTrack = (): TrackStat => ({ reminded: 0, contacted: 0, reachedAfter: 0, eligible: 0, claimed: 0, claimedBonus: 0, expired: 0, pending: 0 });

/**
 * Tracked promotions in a period: players CS were reminded about, how many of them then qualified,
 * and the bonuses that became claimable (claimed, expired, still open).
 */
export async function trackStats(promoIds: number[], range: Range) {
  const out = new Map<number, TrackStat>();
  if (!promoIds.length) return out;
  const t0 = dayStart(range.from);
  const t1 = dayStart(addDays(range.to, 1));
  const list = Prisma.join(promoIds);
  const now = new Date();
  const [alerts, after, awards] = await Promise.all([
    prisma.$queryRaw<{ pid: number; reminded: bigint; contacted: bigint }[]>`
      SELECT promotionId AS pid, COUNT(DISTINCT playerId) AS reminded, COUNT(DISTINCT CASE WHEN outcome = 'contacted' THEN playerId END) AS contacted
      FROM \`Alert\` WHERE kind = 'NEAR' AND promotionId IN (${list}) AND createdAt >= ${t0} AND createdAt < ${t1}
      GROUP BY promotionId`,
    prisma.$queryRaw<{ pid: number; n: bigint }[]>`
      SELECT a.promotionId AS pid, COUNT(DISTINCT a.playerId, a.periodKey) AS n
      FROM \`PromoAward\` a
      WHERE a.promotionId IN (${list}) AND a.eligibleAt >= ${t0} AND a.eligibleAt < ${t1}
        AND EXISTS (SELECT 1 FROM \`Alert\` x WHERE x.kind = 'NEAR' AND x.promotionId = a.promotionId AND x.playerId = a.playerId AND x.periodKey = a.periodKey)
      GROUP BY a.promotionId`,
    prisma.$queryRaw<{ pid: number; eligible: bigint; claimed: bigint; claimedBonus: unknown; expired: bigint }[]>`
      SELECT promotionId AS pid, COUNT(*) AS eligible, SUM(claimedAt IS NOT NULL) AS claimed,
        SUM(CASE WHEN claimedAt IS NOT NULL THEN bonus ELSE 0 END) AS claimedBonus,
        SUM(claimedAt IS NULL AND expiresAt IS NOT NULL AND expiresAt <= ${now}) AS expired
      FROM \`PromoAward\` WHERE promotionId IN (${list}) AND eligibleAt >= ${t0} AND eligibleAt < ${t1}
      GROUP BY promotionId`,
  ]);
  const get = (pid: number) => {
    let s = out.get(pid);
    if (!s) out.set(pid, (s = emptyTrack()));
    return s;
  };
  for (const r of alerts) Object.assign(get(r.pid), { reminded: Number(r.reminded), contacted: Number(r.contacted) });
  for (const r of after) get(r.pid).reachedAfter = Number(r.n);
  for (const r of awards) {
    const s = get(r.pid);
    s.eligible = Number(r.eligible);
    s.claimed = Number(r.claimed);
    s.claimedBonus = n(r.claimedBonus as number);
    s.expired = Number(r.expired);
    s.pending = s.eligible - s.claimed - s.expired;
  }
  return out;
}
