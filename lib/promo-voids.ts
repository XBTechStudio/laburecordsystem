import "server-only";

import { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { linkClaims, unlinkClaims } from "@/lib/promo-engine";

// A player sometimes presses Clear Balance by mistake right after getting a bonus, and CS gives the same bonus again.
// Both bonuses are on the platform, but the first was taken back, so only the one given again counts.

/** The balance was cleared this soon after the bonus… */
const CLEAR_WITHIN_MIN = 30;
/** …and the same bonus was given again this soon after the clear. */
const REGIVE_WITHIN_MIN = 6 * 60;

/**
 * Finds platform bonuses that were cleared by mistake and given again, from `since` on, and stops counting them.
 * A claim is voided when, before anything else happened (no other bonus, deposit or withdrawal), the player's balance was
 * cleared within 30 minutes with at least 90% of the bonus in it, and the same promotion then paid them the same amount
 * again within 6 hours on the same day (Malaysia time; the next day's is their next daily bonus), with no withdrawal in between.
 */
export async function voidReissued(brandId: number, since: Date, playerIds?: number[]) {
  const who = playerIds ? (playerIds.length ? Prisma.sql`AND f.playerId IN (${Prisma.join(playerIds)})` : null) : Prisma.empty;
  if (!who) return 0;
  // Starts from the brand's cleared balances and looks up each player's claims around them by time (other join orders are
  // far slower on players with many claims). No ORDER BY: it also makes MariaDB scan far more; sorted below instead.
  const pairs = await prisma.$queryRaw<{ aId: number; bId: number; aAt: Date; bAt: Date }[]>`
    SELECT STRAIGHT_JOIN a.id AS aId, b.id AS bId, a.claimedAt AS aAt, b.claimedAt AS bAt
    FROM \`PlayerCredit\` f
    JOIN \`PromoClaim\` a FORCE INDEX (PromoClaim_playerId_claimedAt_idx) ON a.playerId = f.playerId
      AND a.claimedAt >= DATE_SUB(f.at, INTERVAL ${CLEAR_WITHIN_MIN} MINUTE) AND a.claimedAt <= f.at AND f.amount >= a.amount * 0.9
    JOIN \`PromoClaim\` b FORCE INDEX (PromoClaim_playerId_claimedAt_idx) ON b.playerId = f.playerId
      AND b.claimedAt > f.at AND b.claimedAt <= DATE_ADD(f.at, INTERVAL ${REGIVE_WITHIN_MIN} MINUTE)
      AND DATE(DATE_ADD(b.claimedAt, INTERVAL 8 HOUR)) = DATE(DATE_ADD(a.claimedAt, INTERVAL 8 HOUR))
      AND b.promotionId = a.promotionId AND b.amount = a.amount AND b.ref IS NOT NULL AND b.voidedAt IS NULL
    WHERE f.brandId = ${brandId} AND f.kind = 'FORFEITED' AND f.at >= ${since} ${who}
      AND a.ref IS NOT NULL AND a.voidedAt IS NULL
      AND NOT EXISTS (SELECT 1 FROM \`PromoClaim\` x WHERE x.playerId = a.playerId AND x.id <> a.id AND x.claimedAt >= a.claimedAt AND x.claimedAt < f.at)
      AND NOT EXISTS (SELECT 1 FROM \`Txn\` d WHERE d.playerId = a.playerId AND d.type = 'DEPOSIT' AND d.txnAt > a.claimedAt AND d.txnAt < f.at)
      AND NOT EXISTS (SELECT 1 FROM \`Txn\` w WHERE w.playerId = a.playerId AND w.type = 'WITHDRAW' AND w.txnAt > a.claimedAt AND w.txnAt < b.claimedAt)`;
  // Each bonus given again replaces one cleared bonus: the earliest one after it.
  const used = new Set<number>();
  const done = new Set<number>();
  const voids: { aId: number; bId: number }[] = [];
  const sorted = pairs.map((x) => ({ aId: Number(x.aId), bId: Number(x.bId), aAt: x.aAt.getTime(), bAt: x.bAt.getTime() })).sort((x, y) => x.aAt - y.aAt || x.bAt - y.bAt);
  for (const { aId, bId } of sorted) {
    if (done.has(aId) || used.has(bId) || aId === bId) continue;
    done.add(aId);
    used.add(bId);
    voids.push({ aId, bId });
  }
  if (!voids.length) return 0;
  const claims = await prisma.promoClaim.findMany({ where: { id: { in: voids.map((v) => v.aId) } }, include: { promotion: true, player: { select: { username: true } } } });
  const now = new Date();
  // Bonus alerts the cleared claim had closed are reopened and passed to the claim given again.
  await unlinkClaims({ id: { in: voids.map((v) => v.aId) } });
  for (const v of voids) {
    await prisma.promoClaim.update({ where: { id: v.aId }, data: { voidedAt: now, replacedById: v.bId } });
    const c = claims.find((x) => x.id === v.aId)!;
    await audit(null, "UPDATE", "PromoClaim", v.aId, brandId, `Stopped counting ${c.promotion.name} of ${c.amount} for ${c.player.username} (${c.ref}): balance cleared and the bonus given again`, { replacedBy: v.bId });
  }
  await linkClaims({ id: { in: voids.map((v) => v.bId) } });
  return voids.length;
}
