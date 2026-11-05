import "server-only";

import { Prisma } from "@prisma/client";
import { addDays, dayStart, type Range } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { n } from "@/lib/format";

export type PromoStat = {
  claims: number;
  claimers: number;
  given: number;
  dep: number;
  depCount: number;
  wd: number;
  wdCount: number;
  /** Withdrawn while playing under the promotion (see promoWithdrawals). */
  pwd: number;
  pwdCount: number;
};

export const emptyStat = (): PromoStat => ({ claims: 0, claimers: 0, given: 0, dep: 0, depCount: 0, wd: 0, wdCount: 0, pwd: 0, pwdCount: 0 });

/** A promotion run is looked for this far back before a withdrawal. */
const RUN_DAYS = 31;

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
  const [claims, txns, pwds] = await Promise.all([
    prisma.$queryRaw<{ pid: number; claims: bigint; claimers: bigint; given: unknown }[]>`
      SELECT c.promotionId AS pid, COUNT(*) AS claims, COUNT(DISTINCT c.playerId) AS claimers, SUM(c.amount) AS given
      FROM \`PromoClaim\` c JOIN \`Promotion\` p ON p.id = c.promotionId
      WHERE p.brandId IN (${list}) AND c.claimedAt >= ${t0} AND c.claimedAt < ${t1} AND c.voidedAt IS NULL
      GROUP BY c.promotionId`,
    prisma.$queryRaw<{ pid: number; type: string; amt: unknown; cnt: bigint }[]>`
      SELECT w.pid, t.type, SUM(t.amount) AS amt, COUNT(*) AS cnt
      FROM (
        SELECT c.promotionId AS pid, c.playerId, MIN(c.claimedAt) AS f, MAX(c.claimedAt) AS l
        FROM \`PromoClaim\` c JOIN \`Promotion\` p ON p.id = c.promotionId
        WHERE p.brandId IN (${list}) AND c.claimedAt >= ${t0} AND c.claimedAt < ${t1} AND c.voidedAt IS NULL
        GROUP BY c.promotionId, c.playerId
      ) w JOIN \`Txn\` t ON t.playerId = w.playerId AND t.txnAt >= w.f AND t.txnAt < DATE_ADD(w.l, INTERVAL ${windowDays} DAY)
      GROUP BY w.pid, t.type`,
    promoWithdrawals(list, t0, t1),
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
  for (const row of pwds) Object.assign(get(row.pid), { pwd: n(row.amt as number), pwdCount: Number(row.cnt) });
  return stats;
}

/**
 * Withdrawals made in [t0, t1), each with the bonus it was made under, the platform's way (its Promotion Report): a withdrawal
 * belongs to the player's latest bonus before it, unless a deposit or a rebate/commission came in between. Only completed
 * withdrawals are kept (rejected ones are removed by the sync), and each counts for one promotion at most.
 * Ends in a CTE `owned`: withdrawal rows have ord = 2, wid, amount, and owner/claimId (null when no bonus started their run).
 */
function runsSql(brandList: Prisma.Sql, t0: Date, t1: Date) {
  const m0 = new Date(t0.getTime() - RUN_DAYS * 86400_000);
  // Rows in time order per player; each bonus, deposit or credit starts a run (grp), and a run is a promotion's only when a bonus started it.
  // At the same second a deposit comes before a bonus (deposit, then claim the deposit bonus), and both before a withdrawal.
  return Prisma.sql`
    WITH wd AS (
      SELECT id, playerId, txnAt AS at, amount FROM \`Txn\`
      WHERE brandId IN (${brandList}) AND type = 'WITHDRAW' AND txnAt >= ${t0} AND txnAt < ${t1}
    ),
    who AS (SELECT DISTINCT playerId FROM wd),
    ev AS (
      SELECT playerId, at, 2 AS ord, id AS wid, NULL AS pid, NULL AS cid, amount, 0 AS starts FROM wd
      UNION ALL
      SELECT c.playerId, c.claimedAt, 1, NULL, c.promotionId, c.id, NULL, 1 FROM \`PromoClaim\` c JOIN who USING (playerId)
      WHERE c.claimedAt >= ${m0} AND c.claimedAt < ${t1} AND c.voidedAt IS NULL
      UNION ALL
      SELECT t.playerId, t.txnAt, 0, NULL, NULL, NULL, NULL, 1 FROM \`Txn\` t JOIN who USING (playerId)
      WHERE t.type = 'DEPOSIT' AND t.txnAt >= ${m0} AND t.txnAt < ${t1}
      UNION ALL
      SELECT x.playerId, x.at, 0, NULL, NULL, NULL, NULL, 1 FROM \`PlayerCredit\` x JOIN who USING (playerId)
      WHERE x.at >= ${m0} AND x.at < ${t1} AND x.kind IN ('REBATE', 'COMMISSION')
    ),
    runs AS (SELECT ev.*, SUM(starts) OVER (PARTITION BY playerId ORDER BY at, ord ROWS UNBOUNDED PRECEDING) AS grp FROM ev),
    owned AS (SELECT runs.*, MAX(pid) OVER (PARTITION BY playerId, grp) AS owner, MAX(cid) OVER (PARTITION BY playerId, grp) AS claimId FROM runs)`;
}

/** Promo withdrawals in [t0, t1) per promotion. */
function promoWithdrawals(brandList: Prisma.Sql, t0: Date, t1: Date) {
  return prisma.$queryRaw<{ pid: number; amt: unknown; cnt: bigint }[]>`
    ${runsSql(brandList, t0, t1)}
    SELECT owner AS pid, SUM(amount) AS amt, COUNT(*) AS cnt FROM owned
    WHERE ord = 2 AND owner IS NOT NULL
    GROUP BY owner`;
}

/** One promotion's withdrawals in the dates, each with the claim it came from, newest first. */
export async function promoWithdrawalList(promo: { id: number; brandId: number }, range: Range) {
  const t0 = dayStart(range.from);
  const t1 = dayStart(addDays(range.to, 1));
  const pairs = await prisma.$queryRaw<{ wid: number; claimId: number }[]>`
    ${runsSql(Prisma.join([promo.brandId]), t0, t1)}
    SELECT wid, claimId FROM owned WHERE ord = 2 AND owner = ${promo.id}`;
  const [txns, claims] = await Promise.all([
    prisma.txn.findMany({ where: { id: { in: pairs.map((x) => Number(x.wid)) } }, include: { player: { select: { id: true, username: true, name: true } } } }),
    prisma.promoClaim.findMany({ where: { id: { in: pairs.map((x) => Number(x.claimId)) } } }),
  ]);
  const claimOf = new Map(pairs.map((x) => [Number(x.wid), claims.find((c) => c.id === Number(x.claimId))!]));
  return txns.map((w) => ({ w, claim: claimOf.get(w.id)! })).sort((a, b) => b.w.txnAt.getTime() - a.w.txnAt.getTime());
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
