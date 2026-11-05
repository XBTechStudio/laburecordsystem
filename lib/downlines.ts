import "server-only";

import { prisma } from "@/lib/db";
import { n } from "@/lib/format";

// A player's downlines are the players of the same brand whose upline (Player.uplineExtId, the platform's referrerId)
// is that player's platform id. Only direct downlines: one level.

export type Upline = { id: number; brandId: number; extId: string | null };
export type DownSum = { direct: number; depositors: number; deposit: number; withdraw: number };

/** Each downline of these players: its id and whose downline it is. */
export async function downlinesOf(uplines: Upline[]) {
  const byBrand = new Map<number, Map<string, number>>();
  for (const u of uplines) if (u.extId) (byBrand.get(u.brandId) ?? byBrand.set(u.brandId, new Map()).get(u.brandId)!).set(u.extId, u.id);
  const rows = await Promise.all(
    [...byBrand].map(async ([brandId, ext]) =>
      (await prisma.player.findMany({ where: { brandId, uplineExtId: { in: [...ext.keys()] } }, select: { id: true, uplineExtId: true } })).map((p) => ({
        id: p.id,
        uplineId: ext.get(p.uplineExtId!)!,
      })),
    ),
  );
  return rows.flat();
}

/** Deposits and withdrawals of these players between from (inclusive) and to (exclusive). */
export async function moneyBetween(playerIds: number[], from: Date, to: Date) {
  const out = new Map<number, { deposit: number; withdraw: number }>();
  if (!playerIds.length) return out;
  const rows = await prisma.txn.groupBy({ by: ["playerId", "type"], where: { playerId: { in: playerIds }, txnAt: { gte: from, lt: to } }, _sum: { amount: true } });
  for (const r of rows) {
    const m = out.get(r.playerId) ?? { deposit: 0, withdraw: 0 };
    if (r.type === "DEPOSIT") m.deposit += n(r._sum.amount);
    else m.withdraw += n(r._sum.amount);
    out.set(r.playerId, m);
  }
  return out;
}

/** Per upline: how many direct downlines, how many of them deposited in the dates, and their deposits and withdrawals then. */
export async function downlineSums(uplines: Upline[], from: Date, to: Date) {
  const downs = await downlinesOf(uplines);
  const money = await moneyBetween(downs.map((d) => d.id), from, to);
  const out = new Map<number, DownSum>();
  for (const u of uplines) out.set(u.id, { direct: 0, depositors: 0, deposit: 0, withdraw: 0 });
  for (const d of downs) {
    const s = out.get(d.uplineId)!;
    const m = money.get(d.id);
    s.direct++;
    if (m && m.deposit > 0) s.depositors++;
    s.deposit += m?.deposit ?? 0;
    s.withdraw += m?.withdraw ?? 0;
  }
  return out;
}
